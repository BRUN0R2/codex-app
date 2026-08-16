use std::ffi::OsStr;

use tokio::process::Command;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
const WINDOWS_POWERSHELL_SESSION_SETUP: &str = concat!(
    "[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false); ",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ",
    "$OutputEncoding = [System.Text.UTF8Encoding]::new($false); ",
    "$PSDefaultParameterValues['Start-Process:WindowStyle'] = 'Hidden'; ",
    "$PSDefaultParameterValues['Start-Process:Wait'] = $true;"
);

pub(crate) fn headless_command(program: impl AsRef<OsStr>) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

#[cfg(windows)]
pub(crate) fn headless_shell_command(command: &str) -> Command {
    let mut process = headless_command("powershell.exe");
    let script = format!("{WINDOWS_POWERSHELL_SESSION_SETUP}\n{command}");
    process.args([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        &script,
    ]);
    process
}

#[cfg(not(windows))]
pub(crate) fn headless_shell_command(command: &str) -> Command {
    let mut process = headless_command("sh");
    process.args(["-lc", command]);
    process
}

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    use std::time::{Duration, Instant};

    #[cfg(windows)]
    use super::headless_shell_command;

    #[cfg(windows)]
    #[tokio::test]
    async fn powershell_session_is_utf8_headless_and_joined() {
        let output = headless_shell_command(
            "Write-Output \"$($PSDefaultParameterValues['Start-Process:WindowStyle'])|$($PSDefaultParameterValues['Start-Process:Wait'])|$([char]0x00E1)\"",
        )
        .output()
        .await
        .expect("PowerShell should execute");

        assert!(output.status.success());
        assert_eq!(
            std::str::from_utf8(&output.stdout)
                .expect("PowerShell output should be valid UTF-8")
                .trim(),
            "Hidden|True|á"
        );
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn start_process_waits_for_its_hidden_child() {
        let started_at = Instant::now();
        let output = headless_shell_command(
            "Start-Process -FilePath powershell.exe -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Milliseconds 250'); Write-Output 'completed'",
        )
        .output()
        .await
        .expect("PowerShell should execute");

        assert!(output.status.success());
        assert_eq!(
            std::str::from_utf8(&output.stdout)
                .expect("PowerShell output should be valid UTF-8")
                .trim(),
            "completed"
        );
        assert!(started_at.elapsed() >= Duration::from_millis(150));
    }
}
