use std::path::PathBuf;

use crate::error::AppError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::engine::native) struct ParsedPatch {
    pub hunks: Vec<PatchHunk>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::engine::native) enum PatchHunk {
    Add {
        path: PathBuf,
        contents: String,
    },
    Delete {
        path: PathBuf,
    },
    Update {
        path: PathBuf,
        move_path: Option<PathBuf>,
        chunks: Vec<UpdateChunk>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::engine::native) struct UpdateChunk {
    pub context: Option<String>,
    pub lines: Vec<UpdateLine>,
    pub end_of_file: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::engine::native) enum UpdateLine {
    Addition(String),
    Context(String),
    Deletion(String),
}

impl UpdateChunk {
    pub(in crate::engine::native) fn old_lines(&self) -> impl Iterator<Item = &str> {
        self.lines.iter().filter_map(|line| match line {
            UpdateLine::Addition(_) => None,
            UpdateLine::Context(value) | UpdateLine::Deletion(value) => Some(value.as_str()),
        })
    }

    pub(in crate::engine::native) fn new_lines(&self) -> impl Iterator<Item = &str> {
        self.lines.iter().filter_map(|line| match line {
            UpdateLine::Deletion(_) => None,
            UpdateLine::Addition(value) | UpdateLine::Context(value) => Some(value.as_str()),
        })
    }
}

const BEGIN_PATCH: &str = "*** Begin Patch";
const END_PATCH: &str = "*** End Patch";
const ADD_FILE: &str = "*** Add File: ";
const DELETE_FILE: &str = "*** Delete File: ";
const UPDATE_FILE: &str = "*** Update File: ";
const MOVE_TO: &str = "*** Move to: ";
const END_OF_FILE: &str = "*** End of File";

pub(in crate::engine::native) fn parse_patch(input: &str) -> Result<ParsedPatch, AppError> {
    let normalized = input.replace("\r\n", "\n");
    let mut lines = normalized.split('\n').collect::<Vec<_>>();
    if normalized.ends_with('\n') {
        lines.pop();
    }
    if lines.first().copied() != Some(BEGIN_PATCH) {
        return Err(invalid(1, "expected `*** Begin Patch`"));
    }
    if lines.last().copied() != Some(END_PATCH) {
        return Err(invalid(
            lines.len().max(1),
            "expected `*** End Patch` as the final line",
        ));
    }

    let end_index = lines.len() - 1;
    let mut cursor = Cursor {
        lines: &lines,
        index: 1,
        end_index,
    };
    let mut hunks = Vec::new();
    while cursor.index < cursor.end_index {
        hunks.push(parse_hunk(&mut cursor)?);
    }
    if hunks.is_empty() {
        return Err(invalid(
            cursor.line_number(),
            "patch must contain at least one file hunk",
        ));
    }
    Ok(ParsedPatch { hunks })
}

struct Cursor<'a> {
    lines: &'a [&'a str],
    index: usize,
    end_index: usize,
}

impl Cursor<'_> {
    fn line(&self) -> &str {
        self.lines[self.index]
    }

    fn line_number(&self) -> usize {
        self.index + 1
    }

    fn advance(&mut self) {
        self.index += 1;
    }
}

fn parse_hunk(cursor: &mut Cursor<'_>) -> Result<PatchHunk, AppError> {
    if let Some(path) = cursor.line().strip_prefix(ADD_FILE) {
        let path = path.to_string();
        return parse_add(cursor, &path);
    }
    if let Some(path) = cursor.line().strip_prefix(DELETE_FILE) {
        let path = parse_path(path, cursor.line_number())?;
        cursor.advance();
        return Ok(PatchHunk::Delete { path });
    }
    if let Some(path) = cursor.line().strip_prefix(UPDATE_FILE) {
        let path = path.to_string();
        return parse_update(cursor, &path);
    }
    Err(invalid(cursor.line_number(), "unknown patch marker"))
}

fn parse_add(cursor: &mut Cursor<'_>, path: &str) -> Result<PatchHunk, AppError> {
    let header_line = cursor.line_number();
    let path = parse_path(path, header_line)?;
    cursor.advance();
    let mut contents = String::new();
    let mut line_count = 0usize;
    while cursor.index < cursor.end_index && !is_file_hunk_header(cursor.line()) {
        let line_number = cursor.line_number();
        let line = cursor
            .line()
            .strip_prefix('+')
            .ok_or_else(|| invalid(line_number, "add lines must start with `+`"))?;
        contents.push_str(line);
        contents.push('\n');
        line_count += 1;
        cursor.advance();
    }
    if line_count == 0 {
        return Err(invalid(
            header_line,
            "add hunk must contain at least one `+` line",
        ));
    }
    Ok(PatchHunk::Add { path, contents })
}

fn parse_update(cursor: &mut Cursor<'_>, path: &str) -> Result<PatchHunk, AppError> {
    let header_line = cursor.line_number();
    let path = parse_path(path, header_line)?;
    cursor.advance();

    let mut move_path = None;
    if cursor.index < cursor.end_index
        && let Some(path) = cursor.line().strip_prefix(MOVE_TO)
    {
        move_path = Some(parse_path(path, cursor.line_number())?);
        cursor.advance();
        if cursor.index < cursor.end_index && cursor.line().starts_with(MOVE_TO) {
            return Err(invalid(cursor.line_number(), "duplicate move marker"));
        }
    }

    let mut chunks = Vec::new();
    let mut current: Option<ChunkBuilder> = None;
    let mut saw_end_of_file = false;
    while cursor.index < cursor.end_index && !is_file_hunk_header(cursor.line()) {
        let line = cursor.line();
        let line_number = cursor.line_number();
        if line.starts_with(MOVE_TO) {
            return Err(invalid(line_number, "move marker must precede changes"));
        }
        if saw_end_of_file {
            return Err(invalid(
                line_number,
                "end-of-file marker must be the final line in an update hunk",
            ));
        }
        if line == "@@" || line.starts_with("@@ ") {
            if let Some(chunk) = current.take() {
                chunks.push(chunk.finish()?);
            }
            let context = if line == "@@" {
                None
            } else {
                let context = &line[3..];
                if context.is_empty() {
                    return Err(invalid(line_number, "change context is empty"));
                }
                Some(context.to_string())
            };
            current = Some(ChunkBuilder::new(context, line_number));
            cursor.advance();
            continue;
        }
        if line == END_OF_FILE {
            let mut chunk = current
                .take()
                .ok_or_else(|| invalid(line_number, "end-of-file marker has no change"))?;
            chunk.end_of_file = true;
            chunks.push(chunk.finish()?);
            saw_end_of_file = true;
            cursor.advance();
            continue;
        }

        let (marker, value) = line
            .split_at_checked(1)
            .ok_or_else(|| invalid(line_number, "change line is empty"))?;
        let chunk = current.get_or_insert_with(|| ChunkBuilder::new(None, line_number));
        match marker {
            "+" => chunk.lines.push(UpdateLine::Addition(value.to_string())),
            "-" => chunk.lines.push(UpdateLine::Deletion(value.to_string())),
            " " => chunk.lines.push(UpdateLine::Context(value.to_string())),
            _ => {
                return Err(invalid(
                    line_number,
                    "change lines must start with `+`, `-`, or a space",
                ));
            }
        }
        cursor.advance();
    }
    if let Some(chunk) = current {
        chunks.push(chunk.finish()?);
    }
    if move_path.is_none() && chunks.is_empty() {
        return Err(invalid(header_line, "update hunk is empty"));
    }
    Ok(PatchHunk::Update {
        path,
        move_path,
        chunks,
    })
}

struct ChunkBuilder {
    context: Option<String>,
    lines: Vec<UpdateLine>,
    end_of_file: bool,
    header_line: usize,
}

impl ChunkBuilder {
    fn new(context: Option<String>, header_line: usize) -> Self {
        Self {
            context,
            lines: Vec::new(),
            end_of_file: false,
            header_line,
        }
    }

    fn finish(self) -> Result<UpdateChunk, AppError> {
        if self.lines.is_empty() {
            return Err(invalid(
                self.header_line,
                "empty change block: `@@` opens a block and never closes one; remove the trailing `@@` or add at least one `+` or `-` line",
            ));
        }
        if !self
            .lines
            .iter()
            .any(|line| !matches!(line, UpdateLine::Context(_)))
        {
            return Err(invalid(
                self.header_line,
                "change block contains only context; add at least one `+` or `-` line before the next marker, or remove the block",
            ));
        }
        Ok(UpdateChunk {
            context: self.context,
            lines: self.lines,
            end_of_file: self.end_of_file,
        })
    }
}

fn parse_path(path: &str, line: usize) -> Result<PathBuf, AppError> {
    if path.trim().is_empty() {
        return Err(invalid(line, "file path is empty"));
    }
    Ok(PathBuf::from(path))
}

fn is_file_hunk_header(line: &str) -> bool {
    line.starts_with(ADD_FILE) || line.starts_with(DELETE_FILE) || line.starts_with(UPDATE_FILE)
}

fn invalid(line: usize, message: impl Into<String>) -> AppError {
    AppError::Tool(format!("invalid patch at line {line}: {}", message.into()))
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{PatchHunk, parse_patch};

    #[test]
    fn rejects_missing_envelope_empty_patch_and_unknown_markers() {
        for (patch, line, message) in [
            ("", 1, "expected `*** Begin Patch`"),
            ("*** Add File: a.txt\n+x", 1, "expected `*** Begin Patch`"),
            (
                "*** Begin Patch\n*** End Patch",
                2,
                "patch must contain at least one file hunk",
            ),
            (
                "*** Begin Patch\n*** Rename File: a.txt\n*** End Patch",
                2,
                "unknown patch marker",
            ),
        ] {
            let error = parse_patch(patch).expect_err("patch should be rejected");
            let rendered = error.to_string();
            assert!(rendered.contains(&format!("line {line}")), "{rendered}");
            assert!(rendered.contains(message), "{rendered}");
        }
    }

    #[test]
    fn parses_add_delete_update_move_and_multiple_files() {
        let patch = "*** Begin Patch\n\
*** Add File: src/new.rs\n\
+pub fn new() {}\n\
*** Delete File: src/old.rs\n\
*** Update File: src/a.rs\n\
*** Move to: src/b.rs\n\
@@ fn old()\n\
-old\n\
+new\n\
*** End Patch";
        let parsed = parse_patch(patch).expect("patch should parse");

        assert_eq!(parsed.hunks.len(), 3);
        assert!(matches!(
            &parsed.hunks[0],
            PatchHunk::Add { path, contents }
                if path == Path::new("src/new.rs") && contents == "pub fn new() {}\n"
        ));
        assert!(matches!(
            &parsed.hunks[1],
            PatchHunk::Delete { path } if path == Path::new("src/old.rs")
        ));
        assert!(matches!(
            &parsed.hunks[2],
            PatchHunk::Update { path, move_path: Some(move_path), chunks }
                if path == Path::new("src/a.rs")
                    && move_path == Path::new("src/b.rs")
                    && chunks.len() == 1
                    && chunks[0].context.as_deref() == Some("fn old()")
                    && chunks[0].old_lines().collect::<Vec<_>>() == ["old"]
                    && chunks[0].new_lines().collect::<Vec<_>>() == ["new"]
        ));
    }

    #[test]
    fn parses_multiple_chunks_context_eof_crlf_and_unicode() {
        let patch = [
            "*** Begin Patch",
            "*** Update File: olá.txt",
            "@@ seção um",
            " linha comum",
            "-antigo",
            "+novo",
            "@@",
            "+fim",
            "*** End of File",
            "*** End Patch",
            "",
        ]
        .join("\r\n");
        let parsed = parse_patch(&patch).expect("CRLF patch should parse");
        let PatchHunk::Update { chunks, .. } = &parsed.hunks[0] else {
            panic!("expected update hunk");
        };

        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].context.as_deref(), Some("seção um"));
        assert_eq!(
            chunks[0].old_lines().collect::<Vec<_>>(),
            ["linha comum", "antigo"]
        );
        assert_eq!(
            chunks[0].new_lines().collect::<Vec<_>>(),
            ["linha comum", "novo"]
        );
        assert!(!chunks[0].end_of_file);
        assert_eq!(chunks[1].context, None);
        assert_eq!(
            chunks[1].old_lines().collect::<Vec<_>>(),
            Vec::<&str>::new()
        );
        assert_eq!(chunks[1].new_lines().collect::<Vec<_>>(), ["fim"]);
        assert!(chunks[1].end_of_file);
    }

    #[test]
    fn parses_an_append_without_a_closing_context_marker() {
        let patch = [
            "*** Begin Patch",
            "*** Update File: notes.txt",
            " existing final line",
            "+appended line",
            "*** End Patch",
        ]
        .join("\n");
        let parsed = parse_patch(&patch).expect("append patch should parse");
        let PatchHunk::Update { chunks, .. } = &parsed.hunks[0] else {
            panic!("expected update hunk");
        };

        assert_eq!(chunks.len(), 1);
        assert_eq!(
            chunks[0].old_lines().collect::<Vec<_>>(),
            ["existing final line"]
        );
        assert_eq!(
            chunks[0].new_lines().collect::<Vec<_>>(),
            ["existing final line", "appended line"]
        );
    }

    #[test]
    fn reports_exact_invalid_line_and_rejects_malformed_hunks() {
        for (patch, line, message) in [
            (
                "*** Begin Patch\n*** Add File: a.txt\nplain\n*** End Patch",
                3,
                "add lines must start with `+`",
            ),
            (
                "*** Begin Patch\n*** Delete File: \n*** End Patch",
                2,
                "file path is empty",
            ),
            (
                "*** Begin Patch\n*** Update File: a.txt\n*** End Patch",
                2,
                "update hunk is empty",
            ),
            (
                "*** Begin Patch\n*** Update File: a.txt\n@@ first\n context\n@@ second\n-old\n+new\n*** End Patch",
                3,
                "contains only context",
            ),
            (
                "*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n@@\n*** End Patch",
                6,
                "`@@` opens a block and never closes one",
            ),
            (
                "*** Begin Patch\n*** Update File: a.txt\n@@\n?bad\n*** End Patch",
                4,
                "change lines must start",
            ),
            (
                "*** Begin Patch\n*** Update File: a.txt\n@@\n+ok\n*** Move to: b.txt\n*** End Patch",
                5,
                "move marker must precede changes",
            ),
        ] {
            let error = parse_patch(patch).expect_err("patch should be rejected");
            let rendered = error.to_string();
            assert!(rendered.contains(&format!("line {line}")), "{rendered}");
            assert!(rendered.contains(message), "{rendered}");
        }
    }
}
