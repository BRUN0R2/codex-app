use crate::engine::FileChangeLineStats;

const MAX_DIFF_BYTES: usize = 128 * 1_024;

pub(super) fn line_stats(old: &str, new: &str) -> FileChangeLineStats {
    FileChangeLineStats {
        additions: text_line_count(new),
        deletions: text_line_count(old),
    }
}

pub(super) fn render_replacement_diff(
    old_path: &str,
    new_path: &str,
    old: &str,
    new: &str,
) -> String {
    let stats = line_stats(old, new);
    let mut output = format!("--- {old_path}\n+++ {new_path}\n");
    if stats.additions == 0 && stats.deletions == 0 {
        return output;
    }
    output.push_str(&format!(
        "@@ -{},{} +{},{} @@\n",
        hunk_start(stats.deletions),
        stats.deletions,
        hunk_start(stats.additions),
        stats.additions
    ));
    append_lines(&mut output, '-', old);
    append_lines(&mut output, '+', new);
    truncate_diff(&output)
}

pub(super) fn text_line_count(value: &str) -> usize {
    if value.is_empty() {
        return 0;
    }
    let bytes = value.as_bytes();
    let mut separators = 0usize;
    let mut index = 0usize;
    while index < bytes.len() {
        match bytes[index] {
            b'\n' => separators += 1,
            b'\r' => {
                separators += 1;
                if bytes.get(index + 1) == Some(&b'\n') {
                    index += 1;
                }
            }
            _ => {}
        }
        index += 1;
    }
    separators + usize::from(!matches!(bytes.last(), Some(b'\n' | b'\r')))
}

pub(super) fn truncate_diff(value: &str) -> String {
    if value.len() <= MAX_DIFF_BYTES {
        return value.to_string();
    }
    let mut end = MAX_DIFF_BYTES;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n[diff truncated]", &value[..end])
}

fn append_lines(output: &mut String, marker: char, value: &str) {
    if value.is_empty() {
        return;
    }
    let normalized = value.replace("\r\n", "\n").replace('\r', "\n");
    let trailing_newline = normalized.ends_with('\n');
    for line in normalized
        .strip_suffix('\n')
        .unwrap_or(&normalized)
        .split('\n')
    {
        output.push(marker);
        output.push_str(line);
        output.push('\n');
    }
    if !trailing_newline {
        output.push_str("\\ No newline at end of file\n");
    }
}

fn hunk_start(line_count: usize) -> usize {
    usize::from(line_count > 0)
}

#[cfg(test)]
mod tests {
    use super::{line_stats, render_replacement_diff, text_line_count};

    #[test]
    fn counts_empty_trailing_and_unterminated_lines_predictably() {
        assert_eq!(text_line_count(""), 0);
        assert_eq!(text_line_count("one\n"), 1);
        assert_eq!(text_line_count("one\ntwo"), 2);
        assert_eq!(text_line_count("one\n\n"), 2);
        assert_eq!(text_line_count("one\rtwo"), 2);
        assert_eq!(text_line_count("one\r\n"), 1);
    }

    #[test]
    fn renders_a_canonical_unicode_replacement() {
        let diff =
            render_replacement_diff("a/source.rs", "b/source.rs", "ação\nold", "ação\nnew\n");

        assert_eq!(line_stats("ação\nold", "ação\nnew\n").additions, 2);
        assert_eq!(line_stats("ação\nold", "ação\nnew\n").deletions, 2);
        assert!(diff.contains("@@ -1,2 +1,2 @@"));
        assert!(diff.contains("-ação\n-old\n"));
        assert!(diff.contains("+ação\n+new\n"));
        assert_eq!(diff.matches("\\ No newline at end of file").count(), 1);
    }

    #[test]
    fn replacement_preview_never_invents_a_duplicate_line() {
        let old = "reason: String,\n#[serde(default)]\ntimeout_seconds: Option<u64>,";
        let new = "reason: String,\nparallel_safe: bool,\n#[serde(default)]\ntimeout_seconds: Option<u64>,";
        let diff = render_replacement_diff("before", "after", old, new);

        assert_eq!(diff.matches("+timeout_seconds: Option<u64>,").count(), 1);
        assert_eq!(diff.matches("+parallel_safe: bool,").count(), 1);
    }
}
