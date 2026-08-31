use std::ffi::OsStr;
#[cfg(windows)]
use std::future::Future;
#[cfg(windows)]
use std::process::Stdio;
#[cfg(windows)]
use std::time::Duration;

use tokio::process::Command;
#[cfg(windows)]
use tokio::sync::OnceCell;

#[cfg(windows)]
mod windows_job;
#[cfg(windows)]
pub(crate) use windows_job::WindowsProcessJob;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
const WINDOWS_POWERSHELL_EXECUTABLE: &str = "pwsh.exe";
#[cfg(windows)]
const POWERSHELL_VERSION_MAX_BYTES: usize = 64;
#[cfg(windows)]
const POWERSHELL_VERSION_TIMEOUT: Duration = Duration::from_secs(10);
#[cfg(windows)]
const WINDOWS_POWERSHELL_SESSION_SETUP: &str = concat!(
    "$__codexUtf8NoBom = [System.Text.UTF8Encoding]::new($false); ",
    "[Console]::InputEncoding = $__codexUtf8NoBom; ",
    "[Console]::OutputEncoding = $__codexUtf8NoBom; ",
    "$OutputEncoding = $__codexUtf8NoBom; ",
    "$PSDefaultParameterValues['*:Encoding'] = 'utf8NoBOM'; ",
    "$PSDefaultParameterValues['Start-Process:WindowStyle'] = 'Hidden'; ",
    "$PSDefaultParameterValues['Start-Process:Wait'] = $true;"
);

#[cfg(windows)]
static POWERSHELL_VERSION: OnceCell<String> = OnceCell::const_new();

pub(crate) fn headless_command(program: impl AsRef<OsStr>) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

pub(crate) const fn shell_name() -> &'static str {
    if cfg!(windows) { "powershell" } else { "sh" }
}

#[cfg(windows)]
pub(crate) async fn shell_version() -> Option<String> {
    cached_powershell_version(&POWERSHELL_VERSION, detect_powershell_version).await
}

#[cfg(not(windows))]
pub(crate) async fn shell_version() -> Option<String> {
    None
}

#[cfg(windows)]
async fn detect_powershell_version() -> Option<String> {
    let mut command = headless_command(WINDOWS_POWERSHELL_EXECUTABLE);
    command
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$PSVersionTable.PSVersion.ToString()",
        ])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    tokio::time::timeout(POWERSHELL_VERSION_TIMEOUT, command.output())
        .await
        .ok()
        .and_then(Result::ok)
        .filter(|output| output.status.success())
        .and_then(|output| parse_powershell_version(&output.stdout))
}

#[cfg(windows)]
async fn cached_powershell_version<F, Fut>(cache: &OnceCell<String>, detect: F) -> Option<String>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Option<String>>,
{
    cache
        .get_or_try_init(|| async { detect().await.ok_or(()) })
        .await
        .ok()
        .cloned()
}

#[cfg(windows)]
fn parse_powershell_version(output: &[u8]) -> Option<String> {
    if output.len() > POWERSHELL_VERSION_MAX_BYTES {
        return None;
    }
    let mut components = std::str::from_utf8(output).ok()?.trim().split('.');
    let major = components.next()?.parse::<u16>().ok()?;
    let minor = components.next()?.parse::<u16>().ok()?;
    Some(format!("{major}.{minor}"))
}

#[cfg(windows)]
pub(crate) fn headless_shell_command(command: &str) -> Command {
    let mut process = headless_command(WINDOWS_POWERSHELL_EXECUTABLE);
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
    use std::path::Path;
    #[cfg(windows)]
    #[cfg(windows)]
    use std::sync::atomic::{AtomicUsize, Ordering};
    #[cfg(windows)]
    use std::time::{Duration, Instant};
    #[cfg(windows)]
    use tokio::sync::OnceCell;

    #[cfg(windows)]
    use super::{
        cached_powershell_version, headless_shell_command, parse_powershell_version, shell_version,
    };

    #[cfg(windows)]
    #[test]
    fn powershell_version_parser_is_bounded_and_semantic() {
        assert_eq!(
            parse_powershell_version(b"7.6.0\r\n").as_deref(),
            Some("7.6")
        );
        assert_eq!(parse_powershell_version(b"not-a-version"), None);
        assert_eq!(parse_powershell_version(&[b'7'; 65]), None);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn powershell_version_cache_retries_transient_detection_failure() {
        let cache = OnceCell::new();
        let attempts = AtomicUsize::new(0);

        assert_eq!(
            cached_powershell_version(&cache, || async {
                attempts.fetch_add(1, Ordering::Relaxed);
                None
            })
            .await,
            None
        );
        assert_eq!(
            cached_powershell_version(&cache, || async {
                attempts.fetch_add(1, Ordering::Relaxed);
                Some("7.6".into())
            })
            .await
            .as_deref(),
            Some("7.6")
        );
        assert_eq!(
            cached_powershell_version(&cache, || async {
                attempts.fetch_add(1, Ordering::Relaxed);
                Some("unexpected".into())
            })
            .await
            .as_deref(),
            Some("7.6")
        );
        assert_eq!(attempts.load(Ordering::Relaxed), 2);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn reports_the_actual_powershell_major_and_minor_version() {
        let version = shell_version()
            .await
            .expect("the configured PowerShell host should report a version");
        let (major, minor) = version
            .split_once('.')
            .expect("the version should contain major and minor components");

        assert!(major.parse::<u16>().is_ok_and(|major| major >= 7));
        assert!(minor.parse::<u16>().is_ok());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn powershell_session_is_modern_utf8_headless_and_joined() {
        let output = headless_shell_command(
            "Write-Output \"$($PSVersionTable.PSEdition)|$($PSVersionTable.PSVersion.Major)|$([Console]::InputEncoding.WebName)|$([Console]::OutputEncoding.WebName)|$($OutputEncoding.WebName)|$($PSDefaultParameterValues['*:Encoding'])|$($PSDefaultParameterValues['Start-Process:WindowStyle'])|$($PSDefaultParameterValues['Start-Process:Wait'])|$([char]0x00E1)\"",
        )
        .output()
        .await
        .expect("PowerShell should execute");

        assert!(output.status.success());
        let text = std::str::from_utf8(&output.stdout)
            .expect("PowerShell output should be valid UTF-8")
            .trim();
        let fields = text.split('|').collect::<Vec<_>>();
        assert_eq!(fields.len(), 9);
        assert_eq!(fields[0], "Core");
        assert!(fields[1].parse::<u32>().is_ok_and(|major| major >= 7));
        assert_eq!(&fields[2..6], &["utf-8", "utf-8", "utf-8", "utf8NoBOM"]);
        assert_eq!(&fields[6..], &["Hidden", "True", "á"]);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn powershell_file_commands_write_utf8_without_bom() {
        const CONTENT: &str = "ação, edição, coração, maçã e ÁÉÍÓÚ";

        let directory = tempfile::tempdir().expect("temporary directory should exist");
        let redirect = directory.path().join("redirect.txt");
        let set_content = directory.path().join("set-content.txt");
        let out_file = directory.path().join("out-file.txt");
        let script = format!(
            "$value = '{CONTENT}'; $value > '{}'; Set-Content -LiteralPath '{}' -Value $value; Out-File -LiteralPath '{}' -InputObject $value",
            powershell_literal(&redirect),
            powershell_literal(&set_content),
            powershell_literal(&out_file),
        );
        let output = headless_shell_command(&script)
            .output()
            .await
            .expect("PowerShell should execute");

        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        for path in [&redirect, &set_content, &out_file] {
            let bytes = std::fs::read(path).expect("PowerShell output file should exist");
            assert!(!bytes.starts_with(&[0xef, 0xbb, 0xbf]));
            assert_eq!(
                std::str::from_utf8(&bytes)
                    .expect("PowerShell output file should be valid UTF-8")
                    .trim_end(),
                CONTENT
            );
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn cmd_output_inherits_the_utf8_console_contract() {
        let output = headless_shell_command(r#"cmd.exe /d /s /c "echo ação çãõ ÁÉÍÓÚ""#)
            .output()
            .await
            .expect("cmd should execute through PowerShell");

        assert!(output.status.success());
        assert_eq!(
            std::str::from_utf8(&output.stdout)
                .expect("cmd output should be valid UTF-8")
                .trim(),
            "ação çãõ ÁÉÍÓÚ"
        );
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn start_process_waits_for_its_hidden_child() {
        let started_at = Instant::now();
        let output = headless_shell_command(
            "Start-Process -FilePath pwsh.exe -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Milliseconds 250'); Write-Output 'completed'",
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

    #[cfg(windows)]
    fn powershell_literal(path: &Path) -> String {
        path.to_str()
            .expect("temporary test path should be valid Unicode")
            .replace('\'', "''")
    }
}
