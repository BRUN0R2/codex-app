use std::ffi::c_void;
use std::io;
use std::mem::size_of;
use std::os::windows::io::AsRawHandle as _;
use std::os::windows::io::FromRawHandle as _;
use std::os::windows::io::OwnedHandle;

use tokio::process::Child;
use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::JobObjects::AssignProcessToJobObject;
use windows::Win32::System::JobObjects::CreateJobObjectW;
use windows::Win32::System::JobObjects::JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
use windows::Win32::System::JobObjects::JOBOBJECT_EXTENDED_LIMIT_INFORMATION;
use windows::Win32::System::JobObjects::JobObjectExtendedLimitInformation;
use windows::Win32::System::JobObjects::SetInformationJobObject;
use windows::Win32::System::JobObjects::TerminateJobObject;
use windows::core::PCWSTR;

/// Owns one command process tree through a Windows Job Object.
///
/// Closing the handle is a final safety net: Windows terminates every process that
/// remains attached to the job even if the async command owner is dropped.
pub(crate) struct WindowsProcessJob {
    handle: OwnedHandle,
}

impl WindowsProcessJob {
    pub(crate) fn new() -> io::Result<Self> {
        // SAFETY: null security attributes and an unnamed job are valid inputs. A successful call
        // returns a new handle owned by this process.
        let raw_job = unsafe { CreateJobObjectW(None, PCWSTR::null()) }
            .map_err(|error| windows_error("could not create command job object", error))?;
        // SAFETY: CreateJobObjectW returned a fresh owned handle. OwnedHandle closes it exactly once.
        let handle = unsafe { OwnedHandle::from_raw_handle(raw_job.0) };
        let job = Self { handle };

        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let information_size = u32::try_from(size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>())
            .map_err(|_| io::Error::other("command job information size exceeds u32"))?;
        // SAFETY: the job handle is live and owned by `job`; `limits` points to an initialized
        // structure of exactly `information_size` bytes for the requested information class.
        unsafe {
            SetInformationJobObject(
                job.raw_handle(),
                JobObjectExtendedLimitInformation,
                (&raw const limits).cast::<c_void>(),
                information_size,
            )
        }
        .map_err(|error| windows_error("could not configure command job object", error))?;

        Ok(job)
    }

    pub(crate) fn assign(&self, child: &Child) -> io::Result<()> {
        let process_handle = child.raw_handle().ok_or_else(|| {
            io::Error::other("command exited before process ownership was established")
        })?;

        // SAFETY: both handles are live for the duration of the call. The process handle is borrowed
        // from Tokio's child and the job handle remains owned by the returned value.
        unsafe { AssignProcessToJobObject(self.raw_handle(), HANDLE(process_handle)) }
            .map_err(|error| windows_error("could not assign command to its job object", error))
    }

    pub(crate) fn terminate(&self) -> io::Result<()> {
        // SAFETY: this object exclusively owns a live job handle. TerminateJobObject does not close
        // the handle and is safe to call even when the job no longer contains an active process.
        unsafe { TerminateJobObject(self.raw_handle(), 1) }
            .map_err(|error| windows_error("could not terminate command job object", error))
    }

    fn raw_handle(&self) -> HANDLE {
        HANDLE(self.handle.as_raw_handle())
    }
}

fn windows_error(context: &str, error: windows::core::Error) -> io::Error {
    io::Error::other(format!("{context}: {error}"))
}

#[cfg(test)]
mod tests {
    use std::process::Stdio;
    use std::time::Duration;

    use tempfile::TempDir;
    use tokio::io::AsyncBufReadExt as _;
    use tokio::io::BufReader;

    use super::WindowsProcessJob;
    use crate::process::headless_shell_command;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn terminating_a_job_prevents_descendant_process_work() {
        let directory = TempDir::new().expect("temporary directory should exist");
        let descendant_script = directory.path().join("descendant.ps1");
        let marker = directory.path().join("descendant-survived.txt");
        let marker_literal = powershell_literal(&marker);
        tokio::fs::write(
            &descendant_script,
            format!(
                "Start-Sleep -Seconds 2\n[System.IO.File]::WriteAllText('{marker_literal}', 'survived')"
            ),
        )
        .await
        .expect("descendant script should be written");
        let script_literal = powershell_literal(&descendant_script);
        let mut command = headless_shell_command(&format!(
            "Start-Process -FilePath pwsh.exe -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-File', '{script_literal}') -Wait:$false; [Console]::Out.WriteLine('descendant-started'); Start-Sleep -Seconds 30"
        ));
        let job = WindowsProcessJob::new().expect("process job should be created");
        let mut child = command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .expect("parent command should start");
        job.assign(&child)
            .expect("process tree should enter the configured job");
        let stdout = child.stdout.take().expect("parent stdout should be piped");
        let mut stdout = BufReader::new(stdout);
        let mut first_line = String::new();
        tokio::time::timeout(Duration::from_secs(10), stdout.read_line(&mut first_line))
            .await
            .expect("parent should publish the descendant sentinel in time")
            .expect("parent stdout should remain readable");
        assert_eq!(first_line.trim(), "descendant-started");

        job.terminate().expect("job termination should succeed");
        tokio::time::timeout(Duration::from_secs(5), child.wait())
            .await
            .expect("the assigned parent should terminate in time")
            .expect("the assigned parent should remain waitable");
        tokio::time::sleep(Duration::from_secs(3)).await;

        assert!(
            !marker.exists(),
            "a descendant assigned to the terminated job must not survive to perform delayed work"
        );
    }

    fn powershell_literal(path: &std::path::Path) -> String {
        path.to_str()
            .expect("temporary test path should be valid Unicode")
            .replace('\'', "''")
    }
}
