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
#[cfg(windows)]
use crate::process::WindowsProcessJob;
use crate::process::headless_shell_command;

const TERMINATED_CHILD_REAP_TIME_LIMIT: Duration = Duration::from_secs(5);

pub(super) struct CommandOutput {
    pub(super) termination: CommandTermination,
    pub(super) stdout: File,
    pub(super) stderr: File,
}

pub(super) struct SpawnedCommand {
    child: tokio::process::Child,
    stdout_task: tokio::task::JoinHandle<Result<File, AppError>>,
    stderr_task: tokio::task::JoinHandle<Result<File, AppError>>,
    deadline: Instant,
    command_timeout: Duration,
    #[cfg(windows)]
    process_job: WindowsProcessJob,
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

#[cfg(test)]
pub(super) async fn execute_command(
    workspace: &Path,
    args: &ExecCommandArgs,
    ripgrep: &Ripgrep,
    output_emitter: CommandOutputEmitter,
    cancellation: &mut watch::Receiver<bool>,
) -> Result<CommandOutput, AppError> {
    let command = spawn_command(workspace, args, ripgrep, output_emitter).await?;
    execute_spawned_command(command, cancellation).await
}

pub(super) async fn spawn_command(
    workspace: &Path,
    args: &ExecCommandArgs,
    ripgrep: &Ripgrep,
    output_emitter: CommandOutputEmitter,
) -> Result<SpawnedCommand, AppError> {
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
    #[cfg(windows)]
    let process_job = WindowsProcessJob::new().map_err(|error| {
        AppError::Tool(format!(
            "could not create command process ownership: {error}"
        ))
    })?;
    let mut child = command
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| AppError::Tool(format!("could not start command: {error}")))?;
    #[cfg(windows)]
    if let Err(error) = process_job.assign(&child) {
        let cleanup = child.kill().await;
        return Err(AppError::Tool(match cleanup {
            Ok(()) => format!("could not establish command process ownership: {error}"),
            Err(cleanup_error) => format!(
                "could not establish command process ownership: {error}; direct child cleanup also failed: {cleanup_error}"
            ),
        }));
    }
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Tool("command stdout pipe was not created".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::Tool("command stderr pipe was not created".into()))?;
    let stdout_task = tokio::spawn(read_stream_spooled(
        stdout,
        CommandOutputStream::Stdout,
        output_emitter.clone(),
    ));
    let stderr_task = tokio::spawn(read_stream_spooled(
        stderr,
        CommandOutputStream::Stderr,
        output_emitter,
    ));
    let deadline = Instant::now()
        .checked_add(command_timeout)
        .ok_or_else(|| AppError::Tool("command timeout could not be represented".into()))?;
    Ok(SpawnedCommand {
        child,
        stdout_task,
        stderr_task,
        deadline,
        command_timeout,
        #[cfg(windows)]
        process_job,
    })
}

pub(super) async fn execute_spawned_command(
    command: SpawnedCommand,
    cancellation: &mut watch::Receiver<bool>,
) -> Result<CommandOutput, AppError> {
    let SpawnedCommand {
        mut child,
        mut stdout_task,
        mut stderr_task,
        deadline,
        command_timeout,
        #[cfg(windows)]
        process_job,
    } = command;
    let mut stdout_output = None;
    let mut stderr_output = None;

    let termination = loop {
        if *cancellation.borrow() {
            terminate_child(
                &mut child,
                #[cfg(windows)]
                &process_job,
            )
            .await?;
            break CommandTermination::Cancelled;
        }
        if let Some(status) = child
            .try_wait()
            .map_err(|error| AppError::Tool(format!("could not poll command: {error}")))?
        {
            let exit_code = status
                .code()
                .ok_or_else(|| AppError::Tool("command ended without an exit code".into()))?;
            #[cfg(windows)]
            process_job.terminate().map_err(|error| {
                AppError::Tool(format!(
                    "command exited but its remaining process tree could not be terminated: {error}"
                ))
            })?;
            break CommandTermination::Exited(exit_code);
        }
        if stdout_output.is_none() && stdout_task.is_finished() {
            match finish_capture_ref(&mut stdout_task, "stdout").await {
                Ok(output) => stdout_output = Some(output),
                Err(error) => {
                    stdout_task.abort();
                    stderr_task.abort();
                    if let Err(termination_error) = terminate_child(
                        &mut child,
                        #[cfg(windows)]
                        &process_job,
                    )
                    .await
                    {
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
                    if let Err(termination_error) = terminate_child(
                        &mut child,
                        #[cfg(windows)]
                        &process_job,
                    )
                    .await
                    {
                        return Err(AppError::Tool(format!(
                            "{error}; command termination also failed: {termination_error}"
                        )));
                    }
                    return Err(error);
                }
            }
        }
        if Instant::now() >= deadline {
            terminate_child(
                &mut child,
                #[cfg(windows)]
                &process_job,
            )
            .await
            .map_err(|error| {
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
                    terminate_child(
                        &mut child,
                        #[cfg(windows)]
                        &process_job,
                    )
                    .await?;
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
    mut task: tokio::task::JoinHandle<Result<File, AppError>>,
    label: &str,
) -> Result<File, AppError> {
    finish_capture_ref(&mut task, label).await
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
async fn terminate_child(
    child: &mut tokio::process::Child,
    process_job: &WindowsProcessJob,
) -> Result<(), AppError> {
    if child.id().is_none() {
        return child.try_wait().map(|_| ()).map_err(|error| {
            AppError::Tool(format!("could not inspect command process: {error}"))
        });
    }
    process_job.terminate().map_err(|error| {
        AppError::Tool(format!("could not terminate command process tree: {error}"))
    })?;
    tokio::time::timeout(TERMINATED_CHILD_REAP_TIME_LIMIT, child.wait())
        .await
        .map_err(|_| {
            AppError::Tool(format!(
                "terminated command did not exit within {} seconds",
                TERMINATED_CHILD_REAP_TIME_LIMIT.as_secs()
            ))
        })?
        .map_err(|error| AppError::Tool(format!("could not reap command process: {error}")))?;
    Ok(())
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
    use crate::engine::native::tools::EXCLUSIVE_COMMAND_TEST_LOCK;
    use crate::engine::native::tools::ExecCommandArgs;
    use crate::engine::native::tools::Ripgrep;
    use crate::engine::native::tools::command_output_stream::CommandOutputEmitter;
    use crate::engine::native::tools::command_output_stream::CommandTranscript;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn timeout_terminates_the_tree_and_preserves_captured_output() {
        let _exclusive_command = EXCLUSIVE_COMMAND_TEST_LOCK.lock().await;
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
        let _exclusive_command = EXCLUSIVE_COMMAND_TEST_LOCK.lock().await;
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
            let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
            let mut revision = 0;
            loop {
                let snapshot = cancellation_transcript
                    .snapshot_after(
                        revision,
                        deadline.saturating_duration_since(tokio::time::Instant::now()),
                    )
                    .await;
                if snapshot.live_output.stdout.contains("before-cancel") {
                    break;
                }
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "command should publish its sentinel before cancellation"
                );
                revision = snapshot.revision;
            }
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
