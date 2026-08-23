use std::collections::VecDeque;
use std::fs::File;
use std::io::{self, Read as _, Seek as _, SeekFrom};

use super::text::truncate_utf8;

mod semantic;

pub(super) const MAX_PROVIDER_PREVIEW_BYTES: usize = 10 * 1_024;
const TEXT_HEAD_BYTES: usize = 3 * 1_024;
const TEXT_TAIL_BYTES: usize = 3 * 1_024;
const TEXT_PRIORITY_BYTES: usize = 2 * 1_024;
const MAX_PRIORITY_LINES_PER_EDGE: usize = 8;
const MAX_PRIORITY_LINE_BYTES: usize = 480;
const COMMAND_SUCCESS_STDOUT_BYTES: usize = 6 * 1_024;
const COMMAND_SUCCESS_STDERR_BYTES: usize = 3 * 1_024;
const COMMAND_FAILURE_STDOUT_BYTES: usize = 4 * 1_024;
const COMMAND_FAILURE_STDERR_BYTES: usize = 5 * 1_024;
const MIN_SEMANTIC_COMMAND_BYTES: usize = 2 * 1_024;
const MIN_SEMANTIC_SAVINGS_BYTES: usize = 512;
const MAX_SEMANTIC_SIZE_PERCENT: usize = 80;

#[derive(Clone, Copy, Debug)]
pub(super) enum TextOutputKind {
    ListFiles,
    ReadFile,
    SearchOutput,
    SearchText,
}

impl TextOutputKind {
    fn label(self) -> &'static str {
        match self {
            Self::ListFiles => "file listing",
            Self::ReadFile => "file read",
            Self::SearchOutput => "stored output search",
            Self::SearchText => "text search",
        }
    }
}

#[derive(Debug)]
pub(super) struct CompactedOutput {
    pub text: String,
    pub complete: bool,
}

pub(super) fn compact_text(value: &str, kind: TextOutputKind) -> CompactedOutput {
    let original_bytes = value.len();
    let original_lines = line_count(value);
    if original_bytes <= MAX_PROVIDER_PREVIEW_BYTES {
        return CompactedOutput {
            text: value.to_string(),
            complete: true,
        };
    }

    let head_end = prefix_boundary(value, TEXT_HEAD_BYTES);
    let tail_start = suffix_boundary(value, TEXT_TAIL_BYTES).max(head_end);
    let head = &value[..head_end];
    let tail = &value[tail_start..];
    let head_lines = line_count(head);
    let tail_lines = line_count(tail);
    let priority = priority_lines(value, head_lines, original_lines.saturating_sub(tail_lines));
    let priority = render_priority_lines(&priority, TEXT_PRIORITY_BYTES);

    let mut text = String::with_capacity(MAX_PROVIDER_PREVIEW_BYTES);
    push_section(&mut text, head);
    push_section(
        &mut text,
        &format!(
            "[... {} compacted locally: {original_lines} lines, {original_bytes} UTF-8 bytes ...]",
            kind.label()
        ),
    );
    if !priority.is_empty() {
        push_section(&mut text, "[Priority lines from the omitted region]");
        push_section(&mut text, &priority);
    }
    push_section(&mut text, "[Tail of output]");
    push_section(&mut text, tail);
    if text.len() > MAX_PROVIDER_PREVIEW_BYTES {
        text = truncate_utf8(&text, MAX_PROVIDER_PREVIEW_BYTES - 32);
        text.push_str("\n[provider preview truncated]");
    }

    CompactedOutput {
        text,
        complete: false,
    }
}

pub(super) fn compact_command_output(
    exit_code: i32,
    stdout: &mut File,
    stderr: &mut File,
) -> io::Result<CompactedOutput> {
    let stdout_bytes = usize::try_from(stdout.metadata()?.len()).map_err(io::Error::other)?;
    let stderr_bytes = usize::try_from(stderr.metadata()?.len()).map_err(io::Error::other)?;
    let header_bytes = format!("exit_code: {exit_code}\nstdout:\n\nstderr:\n").len();
    let original_bytes = header_bytes
        .checked_add(stdout_bytes)
        .and_then(|bytes| bytes.checked_add(stderr_bytes))
        .ok_or_else(|| io::Error::other("command output length overflow"))?;

    if exit_code == 0
        && original_bytes >= MIN_SEMANTIC_COMMAND_BYTES
        && let Some(compacted) =
            compact_successful_command_semantically(stdout, stderr, original_bytes)?
    {
        return Ok(compacted);
    }
    compact_command_output_generically(exit_code, stdout, stderr, original_bytes)
}

fn compact_successful_command_semantically(
    stdout: &mut File,
    stderr: &mut File,
    original_bytes: usize,
) -> io::Result<Option<CompactedOutput>> {
    let stdout_semantic =
        semantic::compact_success_stream(stdout, COMMAND_SUCCESS_STDOUT_BYTES, "stdout")?;
    let stderr_semantic =
        semantic::compact_success_stream(stderr, COMMAND_SUCCESS_STDERR_BYTES, "stderr")?;
    if stdout_semantic.is_none() && stderr_semantic.is_none() {
        return Ok(None);
    }

    let stdout_preview = match stdout_semantic {
        Some(preview) => preview,
        None => read_or_compact_stream(stdout, COMMAND_SUCCESS_STDOUT_BYTES, "stdout")?,
    };
    let stderr_preview = match stderr_semantic {
        Some(preview) => preview,
        None => read_or_compact_stream(stderr, COMMAND_SUCCESS_STDERR_BYTES, "stderr")?,
    };
    let mut text = format!("exit_code: 0\nstdout:\n{stdout_preview}\nstderr:\n{stderr_preview}");
    text.push_str(&format!(
        "\n[... command output semantically compacted locally: {original_bytes} UTF-8 bytes total ...]"
    ));
    if text.len() > MAX_PROVIDER_PREVIEW_BYTES {
        text = truncate_utf8(&text, MAX_PROVIDER_PREVIEW_BYTES - 32);
        text.push_str("\n[provider preview truncated]");
    }

    let saved_bytes = original_bytes.saturating_sub(text.len());
    let materially_smaller = saved_bytes >= MIN_SEMANTIC_SAVINGS_BYTES
        && text.len().saturating_mul(100)
            <= original_bytes.saturating_mul(MAX_SEMANTIC_SIZE_PERCENT);
    Ok(materially_smaller.then_some(CompactedOutput {
        text,
        complete: false,
    }))
}

fn compact_command_output_generically(
    exit_code: i32,
    stdout: &mut File,
    stderr: &mut File,
    original_bytes: usize,
) -> io::Result<CompactedOutput> {
    if original_bytes <= MAX_PROVIDER_PREVIEW_BYTES {
        let stdout = read_complete_utf8(stdout)?;
        let stderr = read_complete_utf8(stderr)?;
        let text = format!("exit_code: {exit_code}\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return Ok(CompactedOutput {
            text,
            complete: true,
        });
    }

    let (stdout_budget, stderr_budget) = if exit_code == 0 {
        (COMMAND_SUCCESS_STDOUT_BYTES, COMMAND_SUCCESS_STDERR_BYTES)
    } else {
        (COMMAND_FAILURE_STDOUT_BYTES, COMMAND_FAILURE_STDERR_BYTES)
    };
    let stdout_preview = compact_file_edges(stdout, stdout_budget, "stdout")?;
    let stderr_preview = compact_file_edges(stderr, stderr_budget, "stderr")?;
    let mut text =
        format!("exit_code: {exit_code}\nstdout:\n{stdout_preview}\nstderr:\n{stderr_preview}");
    text.push_str(&format!(
        "\n[... command output compacted locally: {original_bytes} UTF-8 bytes total ...]"
    ));
    if text.len() > MAX_PROVIDER_PREVIEW_BYTES {
        text = truncate_utf8(&text, MAX_PROVIDER_PREVIEW_BYTES - 32);
        text.push_str("\n[provider preview truncated]");
    }
    Ok(CompactedOutput {
        text,
        complete: false,
    })
}

fn read_or_compact_stream(file: &mut File, budget: usize, label: &str) -> io::Result<String> {
    let byte_length = usize::try_from(file.metadata()?.len()).map_err(io::Error::other)?;
    if byte_length <= budget {
        read_complete_utf8(file)
    } else {
        compact_file_edges(file, budget, label)
    }
}

fn compact_file_edges(file: &mut File, budget: usize, label: &str) -> io::Result<String> {
    let byte_length = usize::try_from(file.metadata()?.len()).map_err(io::Error::other)?;
    if byte_length <= budget {
        return read_complete_utf8(file);
    }
    let marker_reserve = 112usize.min(budget / 3);
    let content_budget = budget.saturating_sub(marker_reserve);
    let head_budget = content_budget * 2 / 3;
    let tail_budget = content_budget.saturating_sub(head_budget);
    let head = align_head_to_line(read_utf8_prefix(file, head_budget)?);
    let tail = align_tail_to_line(read_utf8_suffix(file, tail_budget)?);
    let omitted_bytes = byte_length.saturating_sub(head.len() + tail.len());
    let mut output = String::with_capacity(budget);
    push_section(&mut output, &head);
    push_section(
        &mut output,
        &format!("[... {label}: {omitted_bytes} UTF-8 bytes omitted ...]"),
    );
    push_section(&mut output, &tail);
    if output.len() > budget {
        output = truncate_utf8(&output, budget.saturating_sub(24));
        output.push_str("\n[preview truncated]");
    }
    Ok(output)
}

fn priority_lines(value: &str, first_line: usize, end_line: usize) -> Vec<(usize, String)> {
    let mut first = Vec::with_capacity(MAX_PRIORITY_LINES_PER_EDGE);
    let mut last = VecDeque::with_capacity(MAX_PRIORITY_LINES_PER_EDGE);
    for (index, line) in value.lines().enumerate() {
        if index < first_line || index >= end_line || !is_priority_line(line) {
            continue;
        }
        let entry = (index + 1, truncate_utf8(line, MAX_PRIORITY_LINE_BYTES));
        if first.len() < MAX_PRIORITY_LINES_PER_EDGE {
            first.push(entry);
        } else {
            if last.len() == MAX_PRIORITY_LINES_PER_EDGE {
                last.pop_front();
            }
            last.push_back(entry);
        }
    }
    first.extend(last);
    first
}

fn is_priority_line(line: &str) -> bool {
    const PRIORITY_MARKERS: &[&str] = &[
        "error",
        "exception",
        "fail",
        "panic",
        "timeout",
        "traceback",
        "warning",
        "denied",
        "not found",
        "test result",
        "elifecycle",
    ];
    let normalized = line.to_ascii_lowercase();
    PRIORITY_MARKERS
        .iter()
        .any(|marker| normalized.contains(marker))
}

fn render_priority_lines(lines: &[(usize, String)], budget: usize) -> String {
    let mut output = String::new();
    for (line_number, line) in lines {
        let entry = format!("[line {line_number}] {line}\n");
        if output.len() + entry.len() > budget {
            break;
        }
        output.push_str(&entry);
    }
    output.trim_end().to_string()
}

fn prefix_boundary(value: &str, maximum_bytes: usize) -> usize {
    if value.len() <= maximum_bytes {
        return value.len();
    }
    let mut end = maximum_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    if let Some(newline) = value[..end].rfind('\n')
        && newline + 1 >= end / 2
    {
        return newline + 1;
    }
    end
}

fn suffix_boundary(value: &str, maximum_bytes: usize) -> usize {
    if value.len() <= maximum_bytes {
        return 0;
    }
    let mut start = value.len() - maximum_bytes;
    while !value.is_char_boundary(start) {
        start += 1;
    }
    if let Some(newline) = value[start..].find('\n')
        && newline < maximum_bytes / 2
    {
        return start + newline + 1;
    }
    start
}

fn line_count(value: &str) -> usize {
    if value.is_empty() {
        return 0;
    }
    value.bytes().filter(|byte| *byte == b'\n').count() + usize::from(!value.ends_with('\n'))
}

fn push_section(output: &mut String, section: &str) {
    if section.is_empty() {
        return;
    }
    if !output.is_empty() && !output.ends_with('\n') {
        output.push('\n');
    }
    output.push_str(section);
    if !output.ends_with('\n') {
        output.push('\n');
    }
}

fn read_complete_utf8(file: &mut File) -> io::Result<String> {
    file.seek(SeekFrom::Start(0))?;
    let mut output = String::new();
    file.read_to_string(&mut output)?;
    Ok(output)
}

fn read_utf8_prefix(file: &mut File, maximum_bytes: usize) -> io::Result<String> {
    file.seek(SeekFrom::Start(0))?;
    let mut bytes = Vec::with_capacity(maximum_bytes.saturating_add(4));
    file.take(maximum_bytes.saturating_add(4) as u64)
        .read_to_end(&mut bytes)?;
    let text = match std::str::from_utf8(&bytes) {
        Ok(text) => text,
        Err(error) if error.error_len().is_none() => {
            std::str::from_utf8(&bytes[..error.valid_up_to()]).map_err(io::Error::other)?
        }
        Err(error) => return Err(io::Error::new(io::ErrorKind::InvalidData, error)),
    };
    Ok(truncate_utf8(text, maximum_bytes))
}

fn read_utf8_suffix(file: &mut File, maximum_bytes: usize) -> io::Result<String> {
    let byte_length = file.metadata()?.len();
    let read_bytes = maximum_bytes.saturating_add(4) as u64;
    let start = byte_length.saturating_sub(read_bytes);
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::with_capacity(usize::try_from(byte_length - start).unwrap_or(0));
    file.read_to_end(&mut bytes)?;
    let text = (0..=bytes.len().min(3))
        .find_map(|offset| std::str::from_utf8(&bytes[offset..]).ok())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid UTF-8 output suffix"))?;
    Ok(utf8_suffix(text, maximum_bytes).to_string())
}

fn utf8_suffix(value: &str, maximum_bytes: usize) -> &str {
    if value.len() <= maximum_bytes {
        return value;
    }
    let mut start = value.len() - maximum_bytes;
    while !value.is_char_boundary(start) {
        start += 1;
    }
    &value[start..]
}

fn align_head_to_line(mut value: String) -> String {
    if let Some(newline) = value.rfind('\n')
        && newline + 1 >= value.len() / 2
    {
        value.truncate(newline + 1);
    }
    value
}

fn align_tail_to_line(value: String) -> String {
    if let Some(newline) = value.find('\n')
        && newline < value.len() / 2
    {
        return value[newline + 1..].to_string();
    }
    value
}

#[cfg(test)]
mod tests {
    use std::fs::File;
    use std::io::{Seek as _, SeekFrom, Write as _};
    use std::time::Instant;

    use super::super::output::OutputSource;
    use super::{
        MAX_PROVIDER_PREVIEW_BYTES, TextOutputKind, compact_command_output,
        compact_command_output_generically, compact_text,
    };

    #[test]
    fn short_text_is_preserved_exactly() {
        let output = "a.txt\nb.txt\n";
        let compacted = compact_text(output, TextOutputKind::ListFiles);

        assert!(compacted.complete);
        assert_eq!(compacted.text, output);
    }

    #[test]
    fn long_text_keeps_head_priority_and_tail() {
        let mut output = String::from("BEGIN\n");
        for index in 0..900 {
            output.push_str(&format!("ordinary line {index}\n"));
        }
        output.push_str("ERROR: the important middle failure\n");
        for index in 900..1_800 {
            output.push_str(&format!("ordinary line {index}\n"));
        }
        output.push_str("END\n");

        let compacted = compact_text(&output, TextOutputKind::ReadFile);

        assert!(!compacted.complete);
        assert!(compacted.text.len() <= MAX_PROVIDER_PREVIEW_BYTES);
        assert!(compacted.text.contains("BEGIN"));
        assert!(compacted.text.contains("important middle failure"));
        assert!(compacted.text.contains("END"));
        assert!(compacted.text.contains("compacted locally"));
    }

    #[test]
    fn failed_command_prioritizes_stderr_and_both_stream_tails() {
        let mut stdout = tempfile::tempfile().expect("stdout should open");
        let mut stderr = tempfile::tempfile().expect("stderr should open");
        stdout
            .write_all(format!("stdout-start\n{}stdout-end\n", "x".repeat(20_000)).as_bytes())
            .expect("stdout should write");
        stderr
            .write_all(format!("stderr-start\n{}stderr-end\n", "y".repeat(20_000)).as_bytes())
            .expect("stderr should write");
        stdout
            .seek(SeekFrom::Start(0))
            .expect("stdout should rewind");
        stderr
            .seek(SeekFrom::Start(0))
            .expect("stderr should rewind");

        let compacted =
            compact_command_output(1, &mut stdout, &mut stderr).expect("command should compact");

        assert!(!compacted.complete);
        assert!(compacted.text.len() <= MAX_PROVIDER_PREVIEW_BYTES);
        assert!(compacted.text.contains("exit_code: 1"));
        assert!(compacted.text.contains("stdout-start"));
        assert!(compacted.text.contains("stdout-end"));
        assert!(compacted.text.contains("stderr-start"));
        assert!(compacted.text.contains("stderr-end"));
    }

    #[test]
    fn successful_test_output_is_compacted_even_below_the_generic_threshold() {
        let output = rust_test_output(96);
        assert!(output.len() < MAX_PROVIDER_PREVIEW_BYTES);
        let (mut stdout, mut stderr) = command_streams(&output, "");

        let compacted =
            compact_command_output(0, &mut stdout, &mut stderr).expect("command should compact");

        assert!(!compacted.complete);
        assert!(compacted.text.contains("96 Rust test success lines"));
        assert!(compacted.text.contains("test result: ok"));
        assert!(!compacted.text.contains("case_048"));
        assert!(compacted.text.len() * 2 < output.len());
    }

    #[test]
    fn successful_unrecognized_output_remains_lossless_below_the_threshold() {
        let output = (0..80)
            .map(|index| format!("meaningful domain record {index:03}: value-{index:03}\n"))
            .collect::<String>();
        let (mut stdout, mut stderr) = command_streams(&output, "");

        let compacted =
            compact_command_output(0, &mut stdout, &mut stderr).expect("command should assemble");

        assert!(compacted.complete);
        assert_eq!(
            compacted.text,
            format!("exit_code: 0\nstdout:\n{output}\nstderr:\n")
        );
    }

    #[test]
    fn failed_commands_never_apply_success_noise_filters() {
        let output = rust_test_output(96);
        let (mut stdout, mut stderr) = command_streams(&output, "fatal test harness failure\n");

        let compacted =
            compact_command_output(1, &mut stdout, &mut stderr).expect("command should assemble");

        assert!(compacted.complete);
        assert!(compacted.text.contains("case_048"));
        assert!(compacted.text.contains("fatal test harness failure"));
        assert!(!compacted.text.contains("semantic stdout summary"));
    }

    #[test]
    fn semantic_compaction_is_deterministic_and_retains_warnings() {
        let output = format!(
            "starting deterministic suite\n{}warning: deprecated fixture remains enabled\n",
            rust_test_output(120)
        );
        let (mut first_stdout, mut first_stderr) = command_streams(&output, "");
        let (mut second_stdout, mut second_stderr) = command_streams(&output, "");

        let first = compact_command_output(0, &mut first_stdout, &mut first_stderr)
            .expect("first command should compact");
        let second = compact_command_output(0, &mut second_stdout, &mut second_stderr)
            .expect("second command should compact");

        assert_eq!(first.text, second.text);
        assert!(first.text.contains("deprecated fixture remains enabled"));
    }

    #[ignore = "performance benchmark; run through `pnpm measure:tool-output`"]
    #[test]
    fn benchmark_provider_output_reduction() {
        let mut output = String::new();
        for index in 0..40_000 {
            if index == 20_000 {
                output.push_str("ERROR: representative failure retained by the compactor\n");
            } else {
                output.push_str(&format!(
                    "module-{index:05}: completed deterministic operation successfully\n"
                ));
            }
        }
        let original_bytes = output.len();
        let original_lines = super::line_count(&output);
        let started_at = Instant::now();
        let compacted = compact_text(&output, TextOutputKind::ReadFile);
        let source = OutputSource::text(output);
        let provider_output =
            source.provider_output_with_preview(&compacted.text, compacted.complete);
        let elapsed = started_at.elapsed();
        let reduction = 1.0 - provider_output.len() as f64 / original_bytes as f64;

        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "originalBytes": original_bytes,
                "providerOutputBytes": provider_output.len(),
                "byteReductionPercent": reduction * 100.0,
                "originalLines": original_lines,
                "elapsedMs": elapsed.as_secs_f64() * 1_000.0,
            }))
            .expect("benchmark result should serialize")
        );
        assert!(reduction >= 0.8);
        assert!(provider_output.contains("representative failure"));
        assert!(provider_output.contains(&source.reference().id));
    }

    #[ignore = "performance benchmark; run through `pnpm measure:command-output`"]
    #[test]
    fn benchmark_semantic_command_output_reduction() {
        let moderate = javascript_test_output(70);
        let large = format!(
            "{}{}{}",
            rust_build_output(320),
            javascript_test_output(242),
            rust_test_output(223)
        );
        let mut results = Vec::new();
        for (name, output) in [("moderate", moderate), ("large", large)] {
            let generic = measure_command_compaction(&output, false);
            let semantic = measure_command_compaction(&output, true);
            let additional_reduction =
                1.0 - semantic.preview_bytes as f64 / generic.preview_bytes as f64;
            results.push(serde_json::json!({
                "case": name,
                "originalBytes": output.len(),
                "genericPreviewBytes": generic.preview_bytes,
                "semanticPreviewBytes": semantic.preview_bytes,
                "genericEstimatedTokens": generic.preview_bytes.div_ceil(4),
                "semanticEstimatedTokens": semantic.preview_bytes.div_ceil(4),
                "additionalReductionPercent": additional_reduction * 100.0,
                "semanticMedianMs": semantic.median_milliseconds,
            }));
            assert!(semantic.preview.contains("semantic stdout summary"));
            assert!(
                semantic.preview.contains("test result: ok")
                    || semantic.preview.contains("Test Files")
            );
            assert!(additional_reduction >= 0.5);
        }

        println!(
            "{}",
            serde_json::to_string_pretty(&results).expect("benchmark result should serialize")
        );
    }

    struct CommandCompactionMeasurement {
        preview: String,
        preview_bytes: usize,
        median_milliseconds: f64,
    }

    fn measure_command_compaction(output: &str, semantic: bool) -> CommandCompactionMeasurement {
        const SAMPLES: usize = 9;
        let mut durations = Vec::with_capacity(SAMPLES);
        let mut preview = String::new();
        for _ in 0..SAMPLES {
            let (mut stdout, mut stderr) = command_streams(output, "");
            let original_bytes = "exit_code: 0\nstdout:\n\nstderr:\n".len() + output.len();
            let started_at = Instant::now();
            let compacted = if semantic {
                compact_command_output(0, &mut stdout, &mut stderr)
                    .expect("semantic command should compact")
            } else {
                compact_command_output_generically(0, &mut stdout, &mut stderr, original_bytes)
                    .expect("generic command should compact")
            };
            durations.push(started_at.elapsed().as_secs_f64() * 1_000.0);
            preview = compacted.text;
        }
        durations.sort_by(f64::total_cmp);
        CommandCompactionMeasurement {
            preview_bytes: preview.len(),
            preview,
            median_milliseconds: durations[SAMPLES / 2],
        }
    }

    fn command_streams(stdout: &str, stderr: &str) -> (File, File) {
        (spooled(stdout), spooled(stderr))
    }

    fn spooled(output: &str) -> File {
        let mut file = tempfile::tempfile().expect("command spool should open");
        file.write_all(output.as_bytes())
            .expect("command output should write");
        file.seek(SeekFrom::Start(0))
            .expect("command spool should rewind");
        file
    }

    fn rust_test_output(test_count: usize) -> String {
        let mut output = String::new();
        for index in 0..test_count {
            output.push_str(&format!("test engine::case_{index:03} ... ok\n"));
        }
        output.push_str(&format!(
            "test result: ok. {test_count} passed; 0 failed; 0 ignored; finished in 0.03s\n"
        ));
        output
    }

    fn javascript_test_output(file_count: usize) -> String {
        let mut output = String::from(" RUN  v4.1.11 D:/workspace\n\n");
        for index in 0..file_count {
            output.push_str(&format!(
                " ✓ src/module-{index:03}.test.ts (12 tests) 18ms\n"
            ));
        }
        output.push_str(&format!(
            "\n Test Files  {file_count} passed ({file_count})\n      Tests  {} passed ({})\n   Duration  3.26s\n",
            file_count * 12,
            file_count * 12
        ));
        output
    }

    fn rust_build_output(crate_count: usize) -> String {
        let mut output = String::new();
        for index in 0..crate_count {
            output.push_str(&format!(
                "   Compiling dependency-{index:03} v1.0.{index}\n"
            ));
        }
        output.push_str("    Finished `release` profile [optimized] target(s) in 12.34s\n");
        output
    }
}
