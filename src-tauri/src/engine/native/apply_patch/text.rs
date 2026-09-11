use std::collections::BTreeSet;

use crate::error::AppError;

use super::parser::{UpdateChunk, UpdateLine};

#[derive(Clone, Copy)]
struct SourceLine<'a> {
    text: &'a str,
    ending: &'a str,
}

pub(super) fn apply_chunks(
    relative: &str,
    bytes: &[u8],
    chunks: &[UpdateChunk],
) -> Result<Vec<u8>, AppError> {
    let text = std::str::from_utf8(bytes).map_err(|_| {
        AppError::Tool(format!(
            "cannot update non-UTF-8 file `{relative}` with text chunks"
        ))
    })?;
    let lines = text
        .split_inclusive('\n')
        .map(|line| {
            if let Some(text) = line.strip_suffix("\r\n") {
                SourceLine {
                    text,
                    ending: "\r\n",
                }
            } else if let Some(text) = line.strip_suffix('\n') {
                SourceLine { text, ending: "\n" }
            } else {
                SourceLine {
                    text: line,
                    ending: "",
                }
            }
        })
        .collect::<Vec<_>>();
    let preferred_ending = lines
        .iter()
        .find(|line| !line.ending.is_empty())
        .map_or("\n", |line| line.ending);
    let mut output = Vec::with_capacity(lines.len());
    let mut cursor = 0;
    for chunk in chunks {
        let old_lines = chunk.old_lines().collect::<Vec<_>>();
        let position = locate_chunk(&lines, chunk, &old_lines, cursor).ok_or_else(|| {
            AppError::Tool(format!("context not found while updating `{relative}`"))
        })??;
        output.extend_from_slice(&lines[cursor..position]);
        let mut source = position;
        for line in &chunk.lines {
            match line {
                UpdateLine::Addition(value) => output.push(SourceLine {
                    text: value,
                    ending: preferred_ending,
                }),
                UpdateLine::Context(_) => {
                    output.push(lines[source]);
                    source += 1;
                }
                UpdateLine::Deletion(_) => source += 1,
            }
        }
        cursor = source;
    }
    output.extend_from_slice(&lines[cursor..]);
    let trailing_newline = text.is_empty() || text.ends_with('\n');
    let mut result = String::with_capacity(bytes.len());
    for (index, line) in output.iter().enumerate() {
        result.push_str(line.text);
        if index + 1 < output.len() || trailing_newline {
            result.push_str(if line.ending.is_empty() {
                preferred_ending
            } else {
                line.ending
            });
        }
    }
    Ok(result.into_bytes())
}

fn locate_chunk(
    lines: &[SourceLine<'_>],
    chunk: &UpdateChunk,
    old_lines: &[&str],
    start: usize,
) -> Option<Result<usize, AppError>> {
    let candidates = if let Some(context) = &chunk.context {
        let anchors = best_matches(lines, &[context.as_str()], start, false);
        let mut positions = BTreeSet::new();
        for anchor in anchors {
            if old_lines.is_empty() {
                positions.insert(lines.len());
            } else if let Some(position) =
                best_matches(lines, old_lines, anchor + 1, chunk.end_of_file)
                    .into_iter()
                    .next()
            {
                positions.insert(position);
            }
        }
        positions
    } else if old_lines.is_empty() {
        BTreeSet::from([lines.len()])
    } else {
        best_matches(lines, old_lines, start, chunk.end_of_file)
            .into_iter()
            .collect()
    };
    match candidates.len() {
        0 => None,
        1 => candidates.into_iter().next().map(Ok),
        _ => Some(Err(AppError::Tool("ambiguous context in patch".into()))),
    }
}

#[derive(Clone, Copy)]
enum MatchMode {
    Exact,
    TrailingWhitespace,
    Whitespace,
    Punctuation,
}

fn best_matches(lines: &[SourceLine<'_>], pattern: &[&str], start: usize, eof: bool) -> Vec<usize> {
    if pattern.is_empty() || pattern.len() > lines.len() {
        return Vec::new();
    }
    let last = lines.len() - pattern.len();
    if start > last {
        return Vec::new();
    }
    let range_start = if eof { last } else { start };
    for mode in [
        MatchMode::Exact,
        MatchMode::TrailingWhitespace,
        MatchMode::Whitespace,
        MatchMode::Punctuation,
    ] {
        let matches = (range_start..=last)
            .filter(|position| {
                lines[*position..*position + pattern.len()]
                    .iter()
                    .zip(pattern)
                    .all(|(line, pattern)| match mode {
                        MatchMode::Exact => line.text == *pattern,
                        MatchMode::TrailingWhitespace => line.text.trim_end() == pattern.trim_end(),
                        MatchMode::Whitespace => line.text.trim() == pattern.trim(),
                        MatchMode::Punctuation => {
                            normalize_punctuation(line.text) == normalize_punctuation(pattern)
                        }
                    })
            })
            .collect::<Vec<_>>();
        if !matches.is_empty() {
            return matches;
        }
    }
    Vec::new()
}

fn normalize_punctuation(value: &str) -> String {
    value
        .trim()
        .chars()
        .map(|character| match character {
            '\u{2010}' | '\u{2011}' | '\u{2012}' | '\u{2013}' | '\u{2014}' | '\u{2015}'
            | '\u{2212}' => '-',
            '\u{2018}' | '\u{2019}' | '\u{201a}' | '\u{201b}' => '\'',
            '\u{201c}' | '\u{201d}' | '\u{201e}' | '\u{201f}' => '"',
            '\u{00a0}' | '\u{2002}' | '\u{2003}' | '\u{2004}' | '\u{2005}' | '\u{2006}'
            | '\u{2007}' | '\u{2008}' | '\u{2009}' | '\u{200a}' | '\u{202f}' | '\u{205f}'
            | '\u{3000}' => ' ',
            other => other,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::apply_chunks;
    use crate::engine::native::apply_patch::parser::{PatchHunk, parse_patch};

    fn apply(source: &str, changes: &str) -> Result<Vec<u8>, crate::error::AppError> {
        let parsed = parse_patch(&format!(
            "*** Begin Patch\n*** Update File: source.txt\n{changes}\n*** End Patch"
        ))?;
        let PatchHunk::Update { chunks, .. } = &parsed.hunks[0] else {
            panic!("expected update");
        };
        apply_chunks("source.txt", source.as_bytes(), chunks)
    }

    #[test]
    fn preserves_mixed_endings_and_exact_context() {
        assert_eq!(
            apply(
                "header\r\n  context  \nold\r\nlast",
                "@@\n context\n-old\n+new"
            )
            .expect("update should match"),
            b"header\r\n  context  \nnew\r\nlast"
        );
    }

    #[test]
    fn appends_after_a_line_without_a_terminator_and_updates_empty_files() {
        for (source, expected) in [("first\nlast", "first\nlast\nnew"), ("", "new\n")] {
            assert_eq!(
                apply(source, "@@\n+new").expect("append should apply"),
                expected.as_bytes()
            );
        }
        assert_eq!(
            apply("only\r\n", "@@\n-only").expect("delete should apply"),
            b""
        );
    }

    #[test]
    fn rejects_multiple_anchors_that_select_different_changes() {
        assert!(
            apply("heading\nold\nheading\nold\n", "@@ heading\n-old\n+new")
                .expect_err("ambiguous change must fail")
                .to_string()
                .contains("ambiguous context")
        );
    }

    #[test]
    fn chunks_cannot_search_backwards_or_match_newly_inserted_content() {
        for (source, changes) in [
            (
                "first\nlast\n",
                "@@\n first\n-last\n+new\n@@\n-first\n+other\n*** End of File",
            ),
            ("old\n", "@@\n-old\n+new\n@@\n-new\n+other\n*** End of File"),
        ] {
            assert!(apply(source, changes).is_err());
        }
    }

    #[test]
    fn ordered_chunks_use_original_positions_when_line_counts_change() {
        assert_eq!(
            apply(
                "one\ntwo\nthree\nfour\n",
                "@@\n-one\n+first\n+inserted\n@@\n-three\n+third"
            )
            .expect("ordered chunks should apply"),
            b"first\ninserted\ntwo\nthird\nfour\n"
        );
    }
}
