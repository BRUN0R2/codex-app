use std::collections::{BTreeMap, VecDeque};
use std::fs::File;
use std::io::{self, Read as _, Seek as _, SeekFrom};

use super::{is_priority_line, truncate_utf8};

const SCAN_BUFFER_BYTES: usize = 64 * 1_024;
const MAX_ANALYZED_LINE_BYTES: usize = 8 * 1_024;
const MAX_RETAINED_EDGE_LINES: usize = 10;
const MAX_RETAINED_PRIORITY_LINES: usize = 16;
const MAX_RETAINED_SUMMARY_LINES: usize = 16;
const MAX_RENDERED_LINE_BYTES: usize = 480;
const MIN_ROUTINE_LINES: usize = 8;

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
enum RoutineLineKind {
    BuildProgress,
    JavaScriptTestSuccess,
    PackageProgress,
    RustTestSuccess,
}

impl RoutineLineKind {
    fn label(self) -> &'static str {
        match self {
            Self::BuildProgress => "build progress lines",
            Self::JavaScriptTestSuccess => "JavaScript test success lines",
            Self::PackageProgress => "package-manager progress lines",
            Self::RustTestSuccess => "Rust test success lines",
        }
    }
}

#[derive(Clone, Debug)]
struct RetainedLine {
    number: usize,
    text: String,
}

#[derive(Debug)]
struct RetainedEdges {
    first: Vec<RetainedLine>,
    last: VecDeque<RetainedLine>,
    maximum_per_edge: usize,
}

impl RetainedEdges {
    fn new(maximum_per_edge: usize) -> Self {
        Self {
            first: Vec::with_capacity(maximum_per_edge),
            last: VecDeque::with_capacity(maximum_per_edge),
            maximum_per_edge,
        }
    }

    fn push(&mut self, line: RetainedLine) {
        if self.first.len() < self.maximum_per_edge {
            self.first.push(line);
            return;
        }
        if self.last.len() == self.maximum_per_edge {
            self.last.pop_front();
        }
        self.last.push_back(line);
    }

    fn insert_into(self, target: &mut BTreeMap<usize, String>) {
        for line in self.first.into_iter().chain(self.last) {
            target.entry(line.number).or_insert(line.text);
        }
    }
}

#[derive(Debug)]
struct StreamAnalyzer {
    byte_length: usize,
    line: Vec<u8>,
    line_truncated: bool,
    line_count: usize,
    routine_counts: BTreeMap<RoutineLineKind, usize>,
    representative: RetainedEdges,
    priority: RetainedEdges,
    summary: RetainedEdges,
}

impl StreamAnalyzer {
    fn new(byte_length: usize) -> Self {
        Self {
            byte_length,
            line: Vec::with_capacity(256),
            line_truncated: false,
            line_count: 0,
            routine_counts: BTreeMap::new(),
            representative: RetainedEdges::new(MAX_RETAINED_EDGE_LINES),
            priority: RetainedEdges::new(MAX_RETAINED_PRIORITY_LINES / 2),
            summary: RetainedEdges::new(MAX_RETAINED_SUMMARY_LINES / 2),
        }
    }

    fn push(&mut self, bytes: &[u8]) -> io::Result<()> {
        let mut fragment_start = 0usize;
        for (index, byte) in bytes.iter().enumerate() {
            if *byte != b'\n' {
                continue;
            }
            self.push_line_fragment(&bytes[fragment_start..index]);
            self.finish_line()?;
            fragment_start = index + 1;
        }
        self.push_line_fragment(&bytes[fragment_start..]);
        Ok(())
    }

    fn finish(mut self, budget: usize, label: &str) -> io::Result<Option<String>> {
        if !self.line.is_empty() || self.line_truncated {
            self.finish_line()?;
        }
        let routine_line_count = self.routine_counts.values().sum::<usize>();
        if routine_line_count < MIN_ROUTINE_LINES {
            return Ok(None);
        }

        let mut retained = BTreeMap::new();
        self.representative.insert_into(&mut retained);
        self.priority.insert_into(&mut retained);
        self.summary.insert_into(&mut retained);

        let mut output = String::with_capacity(budget);
        output.push_str(&format!(
            "[semantic {label} summary: {} lines, {} UTF-8 bytes]\n",
            self.line_count, self.byte_length
        ));
        output.push_str("[routine lines omitted]\n");
        for (kind, count) in self.routine_counts {
            output.push_str(&format!("- {count} {}\n", kind.label()));
        }
        if !retained.is_empty() {
            output.push_str("[retained diagnostics, summaries, and representative lines]\n");
        }
        for (line_number, line) in retained {
            let entry = format!("[line {line_number}] {line}\n");
            if output.len().saturating_add(entry.len()) > budget {
                output.push_str("[additional retained lines omitted]\n");
                break;
            }
            output.push_str(&entry);
        }
        if output.len() > budget {
            output = truncate_utf8(&output, budget.saturating_sub(32));
            output.push_str("\n[semantic preview truncated]");
        }
        Ok(Some(output.trim_end().to_string()))
    }

    fn push_line_fragment(&mut self, fragment: &[u8]) {
        let remaining = MAX_ANALYZED_LINE_BYTES.saturating_sub(self.line.len());
        let retained = fragment.len().min(remaining);
        self.line.extend_from_slice(&fragment[..retained]);
        self.line_truncated |= retained < fragment.len();
    }

    fn finish_line(&mut self) -> io::Result<()> {
        self.line_count = self.line_count.saturating_add(1);
        if self.line.last() == Some(&b'\r') {
            self.line.pop();
        }
        let text = match std::str::from_utf8(&self.line) {
            Ok(text) => text,
            Err(error) if self.line_truncated && error.error_len().is_none() => {
                std::str::from_utf8(&self.line[..error.valid_up_to()])
                    .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?
            }
            Err(error) => return Err(io::Error::new(io::ErrorKind::InvalidData, error)),
        };
        let mut rendered = truncate_utf8(text, MAX_RENDERED_LINE_BYTES);
        if self.line_truncated {
            rendered.push_str(" [line truncated]");
        }
        let rendered = rendered.trim().to_string();
        self.line.clear();
        self.line_truncated = false;
        if rendered.is_empty() {
            return Ok(());
        }

        let retained = RetainedLine {
            number: self.line_count,
            text: rendered,
        };
        if is_priority_line(&retained.text) {
            self.priority.push(retained);
        } else if is_summary_line(&retained.text) {
            self.summary.push(retained);
        } else if let Some(kind) = routine_line_kind(&retained.text) {
            *self.routine_counts.entry(kind).or_default() += 1;
        } else {
            self.representative.push(retained);
        }
        Ok(())
    }
}

pub(super) fn compact_success_stream(
    file: &mut File,
    budget: usize,
    label: &str,
) -> io::Result<Option<String>> {
    let byte_length = usize::try_from(file.metadata()?.len()).map_err(io::Error::other)?;
    if byte_length == 0 {
        return Ok(None);
    }
    file.seek(SeekFrom::Start(0))?;
    let mut analyzer = StreamAnalyzer::new(byte_length);
    let mut buffer = [0u8; SCAN_BUFFER_BYTES];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        analyzer.push(&buffer[..count])?;
    }
    analyzer.finish(budget, label)
}

fn routine_line_kind(line: &str) -> Option<RoutineLineKind> {
    let trimmed = line.trim_start();
    if [
        "Blocking waiting for file lock",
        "Compiling ",
        "Checking ",
        "Downloading ",
        "Downloaded ",
        "Fresh ",
        "Generating ",
        "Linking ",
        "Rendering ",
        "Transforming ",
    ]
    .iter()
    .any(|prefix| trimmed.starts_with(prefix))
    {
        return Some(RoutineLineKind::BuildProgress);
    }
    if trimmed.starts_with("test ")
        && (trimmed.ends_with(" ... ok") || trimmed.ends_with(" ... ignored"))
    {
        return Some(RoutineLineKind::RustTestSuccess);
    }
    if trimmed.starts_with('✓')
        || trimmed.starts_with('✔')
        || trimmed.starts_with("PASS ")
        || trimmed.starts_with("ok ")
    {
        return Some(RoutineLineKind::JavaScriptTestSuccess);
    }
    if trimmed.starts_with("Progress:")
        || trimmed.starts_with("Packages:")
        || trimmed.starts_with("Resolved:")
    {
        return Some(RoutineLineKind::PackageProgress);
    }
    None
}

fn is_summary_line(line: &str) -> bool {
    let normalized = line.trim().to_ascii_lowercase();
    [
        "build completed",
        "done in ",
        "duration ",
        "finished ",
        "start at ",
        "test files ",
        "test result:",
        "tests ",
    ]
    .iter()
    .any(|prefix| normalized.starts_with(prefix))
}

#[cfg(test)]
mod tests {
    use std::io::{Seek as _, SeekFrom, Write as _};

    use super::compact_success_stream;

    #[test]
    fn recognizes_success_noise_and_preserves_summaries() {
        let mut output = tempfile::tempfile().expect("output spool should open");
        for index in 0..40 {
            writeln!(output, "test engine::case_{index:03} ... ok")
                .expect("test line should write");
        }
        writeln!(
            output,
            "test result: ok. 40 passed; 0 failed; 0 ignored; finished in 0.03s"
        )
        .expect("summary should write");
        output
            .seek(SeekFrom::Start(0))
            .expect("output should rewind");

        let compacted = compact_success_stream(&mut output, 4 * 1_024, "stdout")
            .expect("output should compact")
            .expect("routine output should be recognized");

        assert!(compacted.contains("40 Rust test success lines"));
        assert!(compacted.contains("test result: ok"));
        assert!(!compacted.contains("case_020"));
    }

    #[test]
    fn leaves_unrecognized_output_for_the_lossless_path() {
        let mut output = tempfile::tempfile().expect("output spool should open");
        writeln!(output, "one semantically meaningful line").expect("line should write");
        writeln!(output, "another semantically meaningful line").expect("line should write");
        output
            .seek(SeekFrom::Start(0))
            .expect("output should rewind");

        assert!(
            compact_success_stream(&mut output, 4 * 1_024, "stdout")
                .expect("output should scan")
                .is_none()
        );
    }

    #[test]
    fn bounds_pathological_single_lines_without_invalid_utf8() {
        let mut output = tempfile::tempfile().expect("output spool should open");
        output
            .write_all("ação".repeat(20_000).as_bytes())
            .expect("large line should write");
        for index in 0..16 {
            writeln!(output, "\ntest large::case_{index:03} ... ok")
                .expect("test line should write");
        }
        output
            .seek(SeekFrom::Start(0))
            .expect("output should rewind");

        let compacted = compact_success_stream(&mut output, 2 * 1_024, "stdout")
            .expect("output should compact")
            .expect("routine output should be recognized");

        assert!(compacted.len() <= 2 * 1_024);
        assert!(!compacted.contains('\u{fffd}'));
        assert!(compacted.contains("[line truncated]"));
    }
}
