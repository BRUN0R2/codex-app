use std::fs::File;
use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};

use tokio::io::{AsyncRead, AsyncReadExt as _};
use tokio::sync::watch;

use super::super::terminal_output::{
    TerminalSpoolWriter, TerminalStreamNormalizer, configure_plain_terminal,
};
use super::command_output_stream::CommandOutputEmitter;
use super::ripgrep::Ripgrep;
use super::workspace::resolve_existing_directory;
use super::{
    DEFAULT_COMMAND_TIMEOUT_SECONDS, DEFAULT_COMMAND_YIELD_MILLISECONDS, ExecCommandArgs,
    MAX_COMMAND_BYTES, MAX_COMMAND_REASON_BYTES, MAX_COMMAND_STREAM_CHUNK_BYTES,
    MAX_COMMAND_TIMEOUT_SECONDS, MAX_COMMAND_YIELD_MILLISECONDS, MIN_COMMAND_YIELD_MILLISECONDS,
    PROCESS_POLL_INTERVAL,
};
use crate::engine::CommandOutputStream;
use crate::error::AppError;
use crate::process::{headless_command, headless_shell_command};

pub(super) struct CommandOutput {
    pub(super) termination: CommandTermination,
    pub(super) stdout: File,
    pub(super) stderr: File,
}

#[derive(Clone, Copy, Debug)]
pub(super) enum CommandTermination {
    Exited(i32),
    Cancelled,
    TimedOut { timeout_seconds: u64 },
}

impl CommandOutput {
    pub(super) fn exit_code(&self) -> Option<i32> {
        match self.termination {
            CommandTermination::Exited(exit_code) => Some(exit_code),
            CommandTermination::Cancelled | CommandTermination::TimedOut { .. } => None,
        }
    }

    pub(super) fn failed(&self) -> bool {
        !matches!(self.termination, CommandTermination::Exited(0))
    }

    pub(super) fn resource_header(&self) -> String {
        match self.termination {
            CommandTermination::Exited(exit_code) => format!("exit_code: {exit_code}"),
            CommandTermination::Cancelled => "status: cancelled".into(),
            CommandTermination::TimedOut { timeout_seconds } => {
                format!("status: timed_out\ntimeout_seconds: {timeout_seconds}")
            }
        }
    }

    pub(super) fn failure_message(&self) -> Option<String> {
        match self.termination {
            CommandTermination::Exited(0) => None,
            CommandTermination::Exited(exit_code) => {
                Some(format!("command exited with code {exit_code}"))
            }
            CommandTermination::Cancelled => Some("command was cancelled".into()),
            CommandTermination::TimedOut { timeout_seconds } => Some(format!(
                "command exceeded its {timeout_seconds}-second time limit"
            )),
        }
    }
}

pub(super) async fn execute_command(
    workspace: &Path,
    args: &ExecCommandArgs,
    ripgrep: &Ripgrep,
    output_emitter: CommandOutputEmitter,
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
    let mut stdout_task = tokio::spawn(read_stream_spooled(
        stdout,
        CommandOutputStream::Stdout,
        output_emitter.clone(),
    ));
    let mut stderr_task = tokio::spawn(read_stream_spooled(
        stderr,
        CommandOutputStream::Stderr,
        output_emitter.clone(),
    ));
    let mut stdout_output = None;
    let mut stderr_output = None;
    let deadline = Instant::now()
        .checked_add(command_timeout)
        .ok_or_else(|| AppError::Tool("command timeout could not be represented".into()))?;

    let termination = loop {
        if *cancellation.borrow() {
            terminate_child(&mut child).await?;
            break CommandTermination::Cancelled;
        }
        if let Some(status) = child
            .try_wait()
            .map_err(|error| AppError::Tool(format!("could not poll command: {error}")))?
        {
            let exit_code = status
                .code()
                .ok_or_else(|| AppError::Tool("command ended without an exit code".into()))?;
            break CommandTermination::Exited(exit_code);
        }
        if stdout_output.is_none() && stdout_task.is_finished() {
            match finish_capture_ref(&mut stdout_task, "stdout").await {
                Ok(output) => stdout_output = Some(output),
                Err(error) => {
                    stdout_task.abort();
                    stderr_task.abort();
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
                    stdout_task.abort();
                    stderr_task.abort();
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
            break CommandTermination::TimedOut {
                timeout_seconds: command_timeout.as_secs(),
            };
        }
        tokio::select! {
            changed = cancellation.changed() => {
                if changed.is_err() || *cancellation.borrow() {
                    terminate_child(&mut child).await?;
                    break CommandTermination::Cancelled;
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
    Ok(CommandOutput {
        termination,
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

pub(super) fn command_yield_time(args: &ExecCommandArgs) -> Result<Duration, AppError> {
    let yield_time_ms = args
        .yield_time_ms
        .unwrap_or(DEFAULT_COMMAND_YIELD_MILLISECONDS);
    if !(MIN_COMMAND_YIELD_MILLISECONDS..=MAX_COMMAND_YIELD_MILLISECONDS).contains(&yield_time_ms) {
        return Err(AppError::Tool(format!(
            "command yield must contain between {MIN_COMMAND_YIELD_MILLISECONDS} and {MAX_COMMAND_YIELD_MILLISECONDS} milliseconds"
        )));
    }
    Ok(Duration::from_millis(yield_time_ms))
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

async fn read_stream_spooled<R: AsyncRead + Unpin>(
    mut stream: R,
    stream_kind: CommandOutputStream,
    output_emitter: CommandOutputEmitter,
) -> Result<File, AppError> {
    let output = tempfile::tempfile()
        .map_err(|error| AppError::Tool(format!("could not create output spool: {error}")))?;
    let mut spool = TerminalSpoolWriter::new(tokio::fs::File::from_std(output));
    let mut normalizer = TerminalStreamNormalizer::default();
    let mut buffer = [0u8; MAX_COMMAND_STREAM_CHUNK_BYTES];
    loop {
        let count = stream
            .read(&mut buffer)
            .await
            .map_err(|error| AppError::Tool(format!("could not read process output: {error}")))?;
        if count == 0 {
            break;
        }
        let operations = normalizer.push(&buffer[..count]).map_err(|error| {
            AppError::Tool(format!("could not normalize process output: {error}"))
        })?;
        spool
            .apply(&operations)
            .await
            .map_err(|error| AppError::Tool(format!("could not spool process output: {error}")))?;
        output_emitter.emit(stream_kind, operations).await?;
    }
    let operations = normalizer
        .finish()
        .map_err(|error| AppError::Tool(format!("could not normalize process output: {error}")))?;
    spool
        .apply(&operations)
        .await
        .map_err(|error| AppError::Tool(format!("could not spool process output: {error}")))?;
    output_emitter.emit(stream_kind, operations).await?;
    spool
        .finish()
        .await
        .map_err(|error| AppError::Tool(format!("could not finalize output spool: {error}")))
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

#[cfg(test)]
mod tests {
    use std::io::Read as _;
    use std::io::Seek as _;
    use std::io::SeekFrom;
    use std::time::Duration;

    use tempfile::TempDir;
    use tokio::sync::watch;

    use super::CommandTermination;
    use super::execute_command;
    use crate::engine::native::tools::ExecCommandArgs;
    use crate::engine::native::tools::Ripgrep;
    use crate::engine::native::tools::command_output_stream::CommandOutputEmitter;
    use crate::engine::native::tools::command_output_stream::CommandTranscript;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn timeout_terminates_the_tree_and_preserves_captured_output() {
        let workspace = TempDir::new().expect("workspace should exist");
        let canonical_workspace = tokio::fs::canonicalize(workspace.path())
            .await
            .expect("workspace should canonicalize");
        let args = command_args(
            "[Console]::Out.WriteLine('before-timeout'); Start-Sleep -Seconds 5",
            1,
        );
        let transcript = CommandTranscript::default();
        let emitter = CommandOutputEmitter::without_notifications(transcript.clone());
        let (_cancellation, mut receiver) = watch::channel(false);

        let output = execute_command(
            &canonical_workspace,
            &args,
            &Ripgrep::for_project_tests(),
            emitter,
            &mut receiver,
        )
        .await
        .expect("timed out command should return its captured output");

        assert!(matches!(
            output.termination,
            CommandTermination::TimedOut { timeout_seconds: 1 }
        ));
        assert!(read_file(output.stdout).contains("before-timeout"));
        assert!(
            transcript
                .snapshot()
                .await
                .live_output
                .stdout
                .contains("before-timeout")
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancellation_terminates_the_tree_and_preserves_captured_output() {
        let workspace = TempDir::new().expect("workspace should exist");
        let canonical_workspace = tokio::fs::canonicalize(workspace.path())
            .await
            .expect("workspace should canonicalize");
        let args = command_args(
            "[Console]::Out.WriteLine('before-cancel'); Start-Sleep -Seconds 5",
            30,
        );
        let transcript = CommandTranscript::default();
        let emitter = CommandOutputEmitter::without_notifications(transcript.clone());
        let (cancellation, mut receiver) = watch::channel(false);
        let cancellation_transcript = transcript.clone();
        tokio::spawn(async move {
            cancellation_transcript
                .snapshot_after(0, Duration::from_secs(3))
                .await;
            cancellation.send_replace(true);
        });

        let output = execute_command(
            &canonical_workspace,
            &args,
            &Ripgrep::for_project_tests(),
            emitter,
            &mut receiver,
        )
        .await
        .expect("cancelled command should return its captured output");

        assert!(matches!(output.termination, CommandTermination::Cancelled));
        assert!(read_file(output.stdout).contains("before-cancel"));
        assert!(
            transcript
                .snapshot()
                .await
                .live_output
                .stdout
                .contains("before-cancel")
        );
    }

    fn command_args(command: &str, timeout_seconds: u64) -> ExecCommandArgs {
        ExecCommandArgs {
            command: command.into(),
            cwd: ".".into(),
            reason: "test command lifecycle".into(),
            parallel_safe: false,
            yield_time_ms: Some(250),
            timeout_seconds: Some(timeout_seconds),
        }
    }

    fn read_file(mut file: std::fs::File) -> String {
        file.seek(SeekFrom::Start(0)).expect("spool should rewind");
        let mut output = String::new();
        file.read_to_string(&mut output)
            .expect("spool should be valid UTF-8");
        output
    }
}
