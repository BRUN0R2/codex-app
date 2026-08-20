use std::fs::File;
use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};

use tokio::io::{AsyncRead, AsyncReadExt as _, AsyncWriteExt as _};
use tokio::sync::watch;

use super::super::terminal_output::{configure_plain_terminal, normalize_terminal_file};
use super::ripgrep::Ripgrep;
use super::workspace::resolve_existing_directory;
use super::{
    DEFAULT_COMMAND_TIMEOUT_SECONDS, ExecCommandArgs, MAX_COMMAND_BYTES, MAX_COMMAND_REASON_BYTES,
    MAX_COMMAND_STREAM_CHUNK_BYTES, MAX_COMMAND_TIMEOUT_SECONDS, PROCESS_POLL_INTERVAL,
};
use crate::error::AppError;
use crate::process::{headless_command, headless_shell_command};

pub(super) struct CommandOutput {
    pub(super) exit_code: i32,
    pub(super) stdout: File,
    pub(super) stderr: File,
}

pub(super) async fn execute_command(
    workspace: &Path,
    args: &ExecCommandArgs,
    ripgrep: &Ripgrep,
    cancellation: &mut watch::Receiver<bool>,
) -> Result<CommandOutput, AppError> {
    if args.command.trim().is_empty() || args.command.len() > MAX_COMMAND_BYTES {
        return Err(AppError::Tool(format!(
            "command must contain between 1 and {MAX_COMMAND_BYTES} bytes"
        )));
    }
    if args.reason.trim().is_empty() || args.reason.len() > MAX_COMMAND_REASON_BYTES {
        return Err(AppError::Tool(format!(
            "command reason must contain between 1 and {MAX_COMMAND_REASON_BYTES} bytes"
        )));
    }
    let command_timeout = command_timeout(args)?;
    let cwd = resolve_existing_directory(workspace, &args.cwd).await?;
    let mut command = headless_shell_command(&args.command);
    configure_plain_terminal(&mut command);
    ripgrep.configure_child_command(&mut command)?;
    let mut child = command
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| AppError::Tool(format!("could not start command: {error}")))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Tool("command stdout pipe was not created".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::Tool("command stderr pipe was not created".into()))?;
    let mut stdout_task = tokio::spawn(read_stream_spooled(stdout));
    let mut stderr_task = tokio::spawn(read_stream_spooled(stderr));
    let mut stdout_output = None;
    let mut stderr_output = None;
    let deadline = Instant::now()
        .checked_add(command_timeout)
        .ok_or_else(|| AppError::Tool("command timeout could not be represented".into()))?;

    let status = loop {
        if *cancellation.borrow() {
            terminate_child(&mut child).await?;
            return Err(AppError::Cancelled(
                "turn was interrupted during command execution".into(),
            ));
        }
        if let Some(status) = child
            .try_wait()
            .map_err(|error| AppError::Tool(format!("could not poll command: {error}")))?
        {
            break status;
        }
        if stdout_output.is_none() && stdout_task.is_finished() {
            match finish_capture_ref(&mut stdout_task, "stdout").await {
                Ok(output) => stdout_output = Some(output),
                Err(error) => {
                    if let Err(termination_error) = terminate_child(&mut child).await {
                        return Err(AppError::Tool(format!(
                            "{error}; command termination also failed: {termination_error}"
                        )));
                    }
                    return Err(error);
                }
            }
        }
        if stderr_output.is_none() && stderr_task.is_finished() {
            match finish_capture_ref(&mut stderr_task, "stderr").await {
                Ok(output) => stderr_output = Some(output),
                Err(error) => {
                    if let Err(termination_error) = terminate_child(&mut child).await {
                        return Err(AppError::Tool(format!(
                            "{error}; command termination also failed: {termination_error}"
                        )));
                    }
                    return Err(error);
                }
            }
        }
        if Instant::now() >= deadline {
            terminate_child(&mut child).await.map_err(|error| {
                AppError::Tool(format!(
                    "command timed out and could not be terminated safely: {error}"
                ))
            })?;
            return Err(AppError::Tool(format!(
                "command execution exceeded its {}-second time limit; retry with a larger timeout_seconds value or null when more time is needed",
                command_timeout.as_secs()
            )));
        }
        tokio::select! {
            changed = cancellation.changed() => {
                if changed.is_err() || *cancellation.borrow() {
                    terminate_child(&mut child).await?;
                    return Err(AppError::Cancelled("turn was interrupted during command execution".into()));
                }
            }
            () = tokio::time::sleep(PROCESS_POLL_INTERVAL) => {}
        }
    };

    let stdout = match stdout_output {
        Some(output) => output,
        None => finish_capture(stdout_task, "stdout").await?,
    };
    let stderr = match stderr_output {
        Some(output) => output,
        None => finish_capture(stderr_task, "stderr").await?,
    };
    let exit_code = status
        .code()
        .ok_or_else(|| AppError::Tool("command ended without an exit code".into()))?;
    Ok(CommandOutput {
        exit_code,
        stdout,
        stderr,
    })
}

pub(super) fn command_timeout(args: &ExecCommandArgs) -> Result<Duration, AppError> {
    let timeout_seconds = args
        .timeout_seconds
        .unwrap_or(DEFAULT_COMMAND_TIMEOUT_SECONDS);
    if timeout_seconds == 0 || timeout_seconds > MAX_COMMAND_TIMEOUT_SECONDS {
        return Err(AppError::Tool(format!(
            "command timeout must contain between 1 and {MAX_COMMAND_TIMEOUT_SECONDS} seconds"
        )));
    }
    Ok(Duration::from_secs(timeout_seconds))
}

async fn finish_capture_ref(
    task: &mut tokio::task::JoinHandle<Result<File, AppError>>,
    label: &str,
) -> Result<File, AppError> {
    task.await
        .map_err(|error| AppError::Tool(format!("{label} reader failed: {error}")))?
}

async fn finish_capture(
    task: tokio::task::JoinHandle<Result<File, AppError>>,
    label: &str,
) -> Result<File, AppError> {
    task.await
        .map_err(|error| AppError::Tool(format!("{label} reader failed: {error}")))?
}

async fn read_stream_spooled<R: AsyncRead + Unpin>(mut stream: R) -> Result<File, AppError> {
    let output = tempfile::tempfile()
        .map_err(|error| AppError::Tool(format!("could not create output spool: {error}")))?;
    let mut output = tokio::fs::File::from_std(output);
    let mut buffer = [0u8; MAX_COMMAND_STREAM_CHUNK_BYTES];
    loop {
        let count = stream
            .read(&mut buffer)
            .await
            .map_err(|error| AppError::Tool(format!("could not read process output: {error}")))?;
        if count == 0 {
            break;
        }
        output
            .write_all(&buffer[..count])
            .await
            .map_err(|error| AppError::Tool(format!("could not spool process output: {error}")))?;
    }
    output
        .flush()
        .await
        .map_err(|error| AppError::Tool(format!("could not flush process output: {error}")))?;
    let raw = output.into_std().await;
    tokio::task::spawn_blocking(move || normalize_terminal_file(raw))
        .await
        .map_err(|error| AppError::Tool(format!("terminal normalization task failed: {error}")))?
        .map_err(|error| AppError::Tool(format!("could not normalize process output: {error}")))
}

#[cfg(windows)]
async fn terminate_child(child: &mut tokio::process::Child) -> Result<(), AppError> {
    let Some(process_id) = child.id() else {
        return child.try_wait().map(|_| ()).map_err(|error| {
            AppError::Tool(format!("could not inspect command process: {error}"))
        });
    };
    let mut taskkill = headless_command("taskkill.exe");
    taskkill
        .args(["/PID", &process_id.to_string(), "/T", "/F"])
        .kill_on_drop(true);
    let output = match tokio::time::timeout(Duration::from_secs(5), taskkill.output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => {
            return terminate_direct_child_after_tree_failure(
                child,
                format!("could not start taskkill: {error}"),
            )
            .await;
        }
        Err(_) => {
            return terminate_direct_child_after_tree_failure(
                child,
                "taskkill exceeded its 5 second time limit".into(),
            )
            .await;
        }
    };
    if !output.status.success() {
        if child
            .try_wait()
            .map_err(|error| AppError::Tool(format!("could not inspect command process: {error}")))?
            .is_some()
        {
            return Ok(());
        }
        let message = String::from_utf8_lossy(&output.stderr);
        return terminate_direct_child_after_tree_failure(
            child,
            format!(
                "taskkill could not terminate process tree {process_id}: {}",
                message.trim()
            ),
        )
        .await;
    }
    tokio::time::timeout(Duration::from_secs(5), child.wait())
        .await
        .map_err(|_| AppError::Tool("terminated command did not exit within 5 seconds".into()))?
        .map_err(|error| AppError::Tool(format!("could not reap command process: {error}")))?;
    Ok(())
}

#[cfg(windows)]
async fn terminate_direct_child_after_tree_failure(
    child: &mut tokio::process::Child,
    tree_error: String,
) -> Result<(), AppError> {
    if child
        .try_wait()
        .map_err(|error| AppError::Tool(format!("could not inspect command process: {error}")))?
        .is_some()
    {
        return Ok(());
    }
    match child.kill().await {
        Ok(()) => Err(AppError::Tool(format!(
            "{tree_error}; the direct child was terminated, but descendant termination could not be confirmed"
        ))),
        Err(error) => Err(AppError::Tool(format!(
            "{tree_error}; direct child termination also failed: {error}"
        ))),
    }
}

#[cfg(not(windows))]
async fn terminate_child(child: &mut tokio::process::Child) -> Result<(), AppError> {
    child
        .kill()
        .await
        .map_err(|error| AppError::Tool(format!("could not terminate command process: {error}")))
}
