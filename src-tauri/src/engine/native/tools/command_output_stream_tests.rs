use std::time::Duration;

use super::CommandTranscript;
use super::CommandTranscriptOutputMode;
use super::EmitterState;
use super::MAX_LIVE_COMMAND_OUTPUT_BYTES;
use crate::engine::CommandOutputStream;
use crate::engine::native::terminal_output::TerminalOperation;

#[test]
fn limits_live_output_without_splitting_utf8() {
    let mut state = EmitterState::default();
    let prefix = "x".repeat(MAX_LIVE_COMMAND_OUTPUT_BYTES - 1);
    let first = state.plan_append(&prefix);
    let second = state.plan_append("árestante");
    let ignored = state.plan_append("ignored");

    assert_eq!(
        (first.visible_bytes, first.became_truncated),
        (MAX_LIVE_COMMAND_OUTPUT_BYTES - 1, false)
    );
    assert_eq!(second.visible_bytes, 0);
    assert!(second.became_truncated);
    assert_eq!(
        (ignored.visible_bytes, ignored.became_truncated),
        (0, false)
    );
}

#[test]
fn keeps_an_exactly_full_preview_complete_until_more_output_arrives() {
    let mut state = EmitterState::default();
    let plan = state.plan_append(&"x".repeat(MAX_LIVE_COMMAND_OUTPUT_BYTES));
    let later = state.plan_append("later");

    assert_eq!(plan.visible_bytes, MAX_LIVE_COMMAND_OUTPUT_BYTES);
    assert!(!plan.became_truncated);
    assert_eq!(later.visible_bytes, 0);
    assert!(later.became_truncated);
}

#[test]
fn bounds_control_only_output() {
    let mut state = EmitterState::default();
    for _ in 0..MAX_LIVE_COMMAND_OUTPUT_BYTES {
        let plan = state.plan_control();
        assert!(plan.emit);
        assert!(!plan.became_truncated);
    }

    let truncated = state.plan_control();
    let ignored = state.plan_control();

    assert!(!truncated.emit);
    assert!(truncated.became_truncated);
    assert!(!ignored.emit);
    assert!(!ignored.became_truncated);
}

#[tokio::test]
async fn transcript_projects_terminal_controls_and_revisions() {
    let transcript = CommandTranscript::default();
    transcript
        .apply(
            CommandOutputStream::Stdout,
            &[
                TerminalOperation::Append("loading 10%".into()),
                TerminalOperation::ClearCurrentLine,
                TerminalOperation::Append("done\nvalue".into()),
                TerminalOperation::Backspace,
                TerminalOperation::Append("e".into()),
            ],
        )
        .await;
    transcript
        .apply(
            CommandOutputStream::Stderr,
            &[TerminalOperation::Append("warning\n".into())],
        )
        .await;

    let snapshot = transcript.snapshot().await;
    assert_eq!(snapshot.revision, 2);
    assert_eq!(snapshot.live_output.stdout, "done\nvalue");
    assert_eq!(snapshot.live_output.stderr, "warning\n");
    assert!(!snapshot.live_output.truncated);
}

#[tokio::test]
async fn transcript_waits_for_change_without_missing_notifications() {
    let transcript = CommandTranscript::default();
    let waiting = {
        let transcript = transcript.clone();
        tokio::spawn(async move {
            transcript
                .poll_snapshot_after(0, Duration::from_secs(1), true)
                .await
        })
    };
    tokio::task::yield_now().await;
    transcript
        .apply(
            CommandOutputStream::Stdout,
            &[TerminalOperation::Append("ready".into())],
        )
        .await;

    let snapshot = waiting.await.expect("poll task should finish");
    assert_eq!(snapshot.revision, 1);
    assert_eq!(snapshot.mode, CommandTranscriptOutputMode::Delta);
    assert_eq!(snapshot.output.stdout, "ready");
}

#[tokio::test]
async fn transcript_returns_only_append_only_output_after_a_cursor() {
    let transcript = CommandTranscript::default();
    transcript
        .apply(
            CommandOutputStream::Stdout,
            &[TerminalOperation::Append("first\n".into())],
        )
        .await;
    transcript
        .apply(
            CommandOutputStream::Stdout,
            &[TerminalOperation::Append("second\n".into())],
        )
        .await;

    let snapshot = transcript.poll_snapshot_since(1, true).await;
    assert_eq!(snapshot.mode, CommandTranscriptOutputMode::Delta);
    assert_eq!(snapshot.output.stdout, "second\n");
    assert!(snapshot.output.stderr.is_empty());
    assert!(!snapshot.output.truncated);
}

#[tokio::test]
async fn transcript_falls_back_to_a_snapshot_after_terminal_rewrites() {
    let transcript = CommandTranscript::default();
    transcript
        .apply(
            CommandOutputStream::Stdout,
            &[TerminalOperation::Append("loading 10%".into())],
        )
        .await;
    transcript
        .apply(
            CommandOutputStream::Stdout,
            &[
                TerminalOperation::ClearCurrentLine,
                TerminalOperation::Append("done\n".into()),
            ],
        )
        .await;

    let snapshot = transcript.poll_snapshot_since(1, true).await;
    assert_eq!(snapshot.mode, CommandTranscriptOutputMode::Snapshot);
    assert_eq!(snapshot.output.stdout, "done\n");
}
