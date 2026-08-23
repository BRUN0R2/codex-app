use std::io::Read as _;

use super::TerminalSpoolWriter;
use crate::engine::native::terminal_output::{TerminalOperation, TerminalStreamNormalizer};

#[tokio::test]
async fn applies_terminal_operations_to_a_utf8_spool() {
    let output = tempfile::tempfile().expect("output spool should open");
    let mut writer = TerminalSpoolWriter::new(tokio::fs::File::from_std(output));

    writer
        .apply(&[
            TerminalOperation::Append("progresso 10%".into()),
            TerminalOperation::ClearCurrentLine,
            TerminalOperation::Append("ação!".into()),
            TerminalOperation::Backspace,
            TerminalOperation::Append(" concluída\n".into()),
        ])
        .await
        .expect("operations should be applied");
    let mut output = writer.finish().await.expect("spool should finish");
    let mut text = String::new();
    output
        .read_to_string(&mut text)
        .expect("spool should contain valid UTF-8");

    assert_eq!(text, "ação concluída\n");
}

#[tokio::test]
async fn never_backspaces_across_the_current_line_boundary() {
    let output = tempfile::tempfile().expect("output spool should open");
    let mut writer = TerminalSpoolWriter::new(tokio::fs::File::from_std(output));

    writer
        .apply(&[
            TerminalOperation::Append("first\n".into()),
            TerminalOperation::Backspace,
            TerminalOperation::Append("second".into()),
        ])
        .await
        .expect("operations should be applied");
    let mut output = writer.finish().await.expect("spool should finish");
    let mut text = String::new();
    output
        .read_to_string(&mut text)
        .expect("spool should contain valid UTF-8");

    assert_eq!(text, "first\nsecond");
}

#[tokio::test]
async fn normalizes_large_chunked_terminal_output_directly_into_the_spool() {
    let output = tempfile::tempfile().expect("output spool should open");
    let mut writer = TerminalSpoolWriter::new(tokio::fs::File::from_std(output));
    let prefix = "x".repeat(64 * 1_024 - 1);
    let input = format!("{prefix}ação\x1b[31m!\x1b[0m\rfinal\r\n");
    let mut normalizer = TerminalStreamNormalizer::default();

    for chunk in input.as_bytes().chunks(8_192) {
        let operations = normalizer.push(chunk).expect("chunk should normalize");
        writer
            .apply(&operations)
            .await
            .expect("chunk should be spooled");
    }
    let operations = normalizer.finish().expect("stream should finish");
    writer
        .apply(&operations)
        .await
        .expect("final operations should be spooled");
    let mut output = writer.finish().await.expect("spool should finish");
    let mut text = String::new();
    output
        .read_to_string(&mut text)
        .expect("spool should contain valid UTF-8");

    assert!(text.ends_with("final\n"));
    assert!(!text.contains("\x1b["));
    assert!(!text.contains('\u{fffd}'));
}
