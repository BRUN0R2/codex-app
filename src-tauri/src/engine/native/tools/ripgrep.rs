use std::env;
use std::ffi::OsString;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::Duration;

use sha2::{Digest as _, Sha256};
use tokio::process::Command;

use crate::error::AppError;
use crate::process::headless_command;

const RIPGREP_EXECUTABLE_NAME: &str = "rg.exe";
const RIPGREP_VERSION_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, Default)]
pub(in crate::engine::native) struct Ripgrep {
    executable: OnceLock<PathBuf>,
}

impl Ripgrep {
    pub(in crate::engine::native) async fn initialize(&self) -> Result<(), AppError> {
        if self.executable.get().is_some() {
            return Ok(());
        }
        let executable = locate_bundled_executable()?;
        let validation_path = executable.clone();
        tokio::task::spawn_blocking(move || validate_executable(&validation_path))
            .await
            .map_err(|error| {
                AppError::Tool(format!("ripgrep validation task failed: {error}"))
            })??;
        validate_version(&executable).await?;
        if let Err(existing) = self.executable.set(executable)
            && self.executable.get() != Some(&existing)
        {
            return Err(AppError::State(
                "ripgrep was initialized with conflicting executable paths".into(),
            ));
        }
        Ok(())
    }

    pub(super) fn executable(&self) -> Result<&Path, AppError> {
        self.executable
            .get()
            .map(PathBuf::as_path)
            .ok_or_else(|| AppError::State("ripgrep is not initialized".into()))
    }

    pub(super) fn configure_child_command(&self, command: &mut Command) -> Result<(), AppError> {
        let executable_directory = self
            .executable()?
            .parent()
            .ok_or_else(|| AppError::State("ripgrep executable has no parent directory".into()))?;
        command.env(
            "PATH",
            prepend_path_entry(executable_directory, env::var_os("PATH"))?,
        );
        Ok(())
    }

    #[cfg(test)]
    pub(super) fn for_project_tests() -> Self {
        let architecture = if cfg!(target_arch = "aarch64") {
            "arm64"
        } else {
            "x64"
        };
        let executable = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("project root should exist")
            .join(".tools")
            .join("ripgrep")
            .join(env!("CODEX_BUNDLED_RG_VERSION"))
            .join(architecture)
            .join(RIPGREP_EXECUTABLE_NAME);
        let path = OnceLock::new();
        path.set(executable)
            .expect("test ripgrep executable should be initialized once");
        Self { executable: path }
    }
}

fn locate_bundled_executable() -> Result<PathBuf, AppError> {
    let current_executable = env::current_exe()
        .map_err(|error| AppError::State(format!("current executable is unavailable: {error}")))?;
    let application_directory = current_executable
        .parent()
        .ok_or_else(|| AppError::State("current executable has no application directory".into()))?;
    Ok(application_directory.join(RIPGREP_EXECUTABLE_NAME))
}

fn validate_executable(path: &Path) -> Result<(), AppError> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| {
        AppError::State(format!(
            "bundled ripgrep is unavailable at {}: {error}",
            path.display()
        ))
    })?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err(AppError::State(format!(
            "bundled ripgrep is not a regular file: {}",
            path.display()
        )));
    }
    let bytes = std::fs::read(path).map_err(|error| {
        AppError::State(format!(
            "bundled ripgrep could not be read at {}: {error}",
            path.display()
        ))
    })?;
    let digest = Sha256::digest(bytes);
    let mut actual = String::with_capacity(digest.len() * 2);
    for byte in digest {
        write!(&mut actual, "{byte:02x}").expect("writing to a String cannot fail");
    }
    let expected = env!("CODEX_BUNDLED_RG_SHA256");
    if actual != expected {
        return Err(AppError::State(format!(
            "bundled ripgrep failed integrity validation: expected {expected}, received {actual}"
        )));
    }
    Ok(())
}

async fn validate_version(path: &Path) -> Result<(), AppError> {
    let mut command = headless_command(path);
    command
        .arg("--version")
        .stdin(Stdio::null())
        .stderr(Stdio::piped())
        .stdout(Stdio::piped())
        .kill_on_drop(true);
    let output = tokio::time::timeout(RIPGREP_VERSION_TIMEOUT, command.output())
        .await
        .map_err(|_| AppError::Timeout {
            operation: "ripgrep version validation",
        })?
        .map_err(|error| AppError::State(format!("bundled ripgrep could not start: {error}")))?;
    if !output.status.success() {
        return Err(AppError::State(format!(
            "bundled ripgrep version check failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    let first_line = String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .unwrap_or_default()
        .to_string();
    let expected = format!(
        "ripgrep {} (rev {})",
        env!("CODEX_BUNDLED_RG_VERSION"),
        env!("CODEX_BUNDLED_RG_REVISION")
    );
    if first_line != expected {
        return Err(AppError::State(format!(
            "bundled ripgrep version mismatch: expected `{expected}`, received `{first_line}`"
        )));
    }
    Ok(())
}

fn prepend_path_entry(entry: &Path, current: Option<OsString>) -> Result<OsString, AppError> {
    let mut paths = vec![entry.to_path_buf()];
    if let Some(current) = current {
        paths.extend(env::split_paths(&current).filter(|candidate| !same_path(candidate, entry)));
    }
    env::join_paths(paths)
        .map_err(|error| AppError::State(format!("child PATH could not be constructed: {error}")))
}

#[cfg(windows)]
fn same_path(left: &Path, right: &Path) -> bool {
    left.as_os_str()
        .to_string_lossy()
        .eq_ignore_ascii_case(&right.as_os_str().to_string_lossy())
}

#[cfg(not(windows))]
fn same_path(left: &Path, right: &Path) -> bool {
    left.as_os_str() == right.as_os_str()
}

#[cfg(test)]
mod tests {
    use std::env;
    use std::ffi::OsString;
    use std::path::Path;

    #[cfg(windows)]
    use super::Ripgrep;
    use super::prepend_path_entry;
    #[cfg(windows)]
    use crate::process::headless_shell_command;

    #[test]
    fn bundled_directory_is_first_and_not_duplicated() {
        let separator = if cfg!(windows) { ";" } else { ":" };
        let existing = OsString::from(format!(
            "C:\\Windows{separator}C:\\Codex\\bin{separator}C:\\Tools"
        ));
        let joined = prepend_path_entry(Path::new("C:\\Codex\\bin"), Some(existing))
            .expect("PATH should be constructed");
        let paths = env::split_paths(&joined).collect::<Vec<_>>();

        assert_eq!(
            paths.first(),
            Some(&Path::new("C:\\Codex\\bin").to_path_buf())
        );
        assert_eq!(
            paths
                .iter()
                .filter(|path| path.to_string_lossy().contains("Codex"))
                .count(),
            1
        );
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn child_powershell_resolves_the_bundled_ripgrep() {
        let ripgrep = Ripgrep::for_project_tests();
        let mut command = headless_shell_command("rg --version | Select-Object -First 1");
        ripgrep
            .configure_child_command(&mut command)
            .expect("child PATH should be configured");
        let output = command
            .output()
            .await
            .expect("child command should execute");

        assert!(output.status.success());
        assert_eq!(
            String::from_utf8_lossy(&output.stdout).trim(),
            format!(
                "ripgrep {} (rev {})",
                env!("CODEX_BUNDLED_RG_VERSION"),
                env!("CODEX_BUNDLED_RG_REVISION")
            )
        );
    }
}
