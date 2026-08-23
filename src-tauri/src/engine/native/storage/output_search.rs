use super::super::text::truncate_utf8;

pub(in crate::engine::native) const MAX_OUTPUT_SEARCH_QUERY_BYTES: usize = 256;
const MAX_OUTPUT_SEARCH_RESULTS: usize = 12;
const MAX_OUTPUT_SEARCH_EXCERPT_BYTES: usize = 640;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct OutputSearchMatch {
    pub line_number: usize,
    pub excerpt: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(in crate::engine::native) struct OutputSearchResponse {
    output_id: String,
    matches: Vec<OutputSearchMatch>,
    truncated: bool,
}

impl OutputSearchResponse {
    pub(in crate::engine::native) fn render(&self) -> String {
        let mut output = format!(
            "output_id: {}\nmatches: {}\ntruncated: {}\nresults:",
            self.output_id,
            self.matches.len(),
            self.truncated
        );
        if self.matches.is_empty() {
            output.push_str("\nNo matching lines.");
            return output;
        }
        for matched in &self.matches {
            output.push_str(&format!("\n{}: {}", matched.line_number, matched.excerpt));
        }
        if self.truncated {
            output.push_str("\n[Additional matching lines omitted; use a narrower query.]");
        }
        output
    }
}

#[derive(Debug)]
pub(super) struct OutputSearcher {
    query: String,
    carry: String,
    processed_bytes: u64,
    processed_newlines: usize,
    last_matched_line: Option<usize>,
    matches: Vec<OutputSearchMatch>,
    truncated: bool,
}

impl OutputSearcher {
    pub(super) fn new(query: String) -> Self {
        Self {
            query,
            carry: String::new(),
            processed_bytes: 0,
            processed_newlines: 0,
            last_matched_line: None,
            matches: Vec::new(),
            truncated: false,
        }
    }

    pub(super) fn push(&mut self, chunk: &str) -> bool {
        let combined_start_offset = self.processed_bytes.saturating_sub(self.carry.len() as u64);
        let combined_start_line = self
            .processed_newlines
            .saturating_sub(count_newlines(&self.carry))
            .saturating_add(1);
        let mut combined = String::with_capacity(self.carry.len().saturating_add(chunk.len()));
        combined.push_str(&self.carry);
        combined.push_str(chunk);

        for (match_start, _) in combined.match_indices(&self.query) {
            let match_end = match_start.saturating_add(self.query.len());
            let global_match_end = combined_start_offset.saturating_add(match_end as u64);
            if global_match_end <= self.processed_bytes {
                continue;
            }
            let line_number =
                combined_start_line.saturating_add(count_newlines(&combined[..match_start]));
            if self.last_matched_line == Some(line_number) {
                continue;
            }
            if self.matches.len() == MAX_OUTPUT_SEARCH_RESULTS {
                self.truncated = true;
                return false;
            }
            self.matches.push(OutputSearchMatch {
                line_number,
                excerpt: excerpt_for_match(
                    &combined,
                    match_start,
                    match_end,
                    combined_start_offset > 0,
                ),
            });
            self.last_matched_line = Some(line_number);
        }

        self.processed_bytes = self.processed_bytes.saturating_add(chunk.len() as u64);
        self.processed_newlines = self
            .processed_newlines
            .saturating_add(count_newlines(chunk));
        let carry_bytes = self
            .query
            .len()
            .saturating_sub(1)
            .saturating_add(MAX_OUTPUT_SEARCH_EXCERPT_BYTES);
        self.carry = utf8_suffix(&combined, carry_bytes).to_string();
        true
    }

    pub(super) fn finish(self, output_id: String) -> OutputSearchResponse {
        OutputSearchResponse {
            output_id,
            matches: self.matches,
            truncated: self.truncated,
        }
    }
}

fn excerpt_for_match(
    combined: &str,
    match_start: usize,
    match_end: usize,
    combined_has_omitted_prefix: bool,
) -> String {
    let line_start = combined[..match_start]
        .rfind('\n')
        .map_or(0, |index| index + 1);
    let line_end = combined[match_end..]
        .find('\n')
        .map_or(combined.len(), |index| match_end + index);
    let line = combined[line_start..line_end].trim_end_matches('\r');
    let relative_match_start = match_start.saturating_sub(line_start);
    let relative_match_end = match_end.saturating_sub(line_start).min(line.len());
    let (window_start, window_end) = excerpt_window(
        line,
        relative_match_start,
        relative_match_end,
        MAX_OUTPUT_SEARCH_EXCERPT_BYTES,
    );
    let omitted_prefix = window_start > 0 || (line_start == 0 && combined_has_omitted_prefix);
    let omitted_suffix = window_end < line.len() || line_end == combined.len();
    let mut excerpt =
        String::with_capacity(window_end.saturating_sub(window_start).saturating_add(2));
    if omitted_prefix {
        excerpt.push('…');
    }
    excerpt.push_str(&line[window_start..window_end]);
    if omitted_suffix {
        excerpt.push('…');
    }
    truncate_utf8(excerpt.trim(), MAX_OUTPUT_SEARCH_EXCERPT_BYTES + 6)
}

fn excerpt_window(
    value: &str,
    match_start: usize,
    match_end: usize,
    maximum_bytes: usize,
) -> (usize, usize) {
    if value.len() <= maximum_bytes {
        return (0, value.len());
    }
    let match_bytes = match_end.saturating_sub(match_start).min(maximum_bytes);
    let context_bytes = maximum_bytes.saturating_sub(match_bytes);
    let mut start = match_start.saturating_sub(context_bytes / 2);
    while !value.is_char_boundary(start) {
        start += 1;
    }
    let minimum_end = match_end.min(value.len());
    let mut end = start.saturating_add(maximum_bytes).min(value.len());
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    if end < minimum_end {
        end = minimum_end;
        while !value.is_char_boundary(end) {
            end += 1;
        }
        start = end.saturating_sub(maximum_bytes);
        while !value.is_char_boundary(start) {
            start += 1;
        }
    }
    (start, end)
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

fn count_newlines(value: &str) -> usize {
    value.bytes().filter(|byte| *byte == b'\n').count()
}

#[cfg(test)]
mod tests {
    use std::hint::black_box;
    use std::time::Instant;

    use super::{MAX_OUTPUT_SEARCH_RESULTS, OutputSearcher};

    #[test]
    fn finds_a_query_split_across_storage_chunks() {
        let mut searcher = OutputSearcher::new("needle".into());
        assert!(searcher.push("first line\nsecond nee"));
        assert!(searcher.push("dle value\nthird line\n"));

        let response = searcher.finish("output-1".into());

        assert_eq!(response.matches.len(), 1);
        assert_eq!(response.matches[0].line_number, 2);
        assert!(response.matches[0].excerpt.contains("second needle value"));
        assert!(!response.truncated);
    }

    #[test]
    fn returns_one_result_per_line_and_reports_truncation() {
        let mut searcher = OutputSearcher::new("hit".into());
        let mut content = String::new();
        for index in 0..(MAX_OUTPUT_SEARCH_RESULTS + 2) {
            content.push_str(&format!("line {index}: hit hit\n"));
        }
        assert!(!searcher.push(&content));

        let response = searcher.finish("output-2".into());

        assert_eq!(response.matches.len(), MAX_OUTPUT_SEARCH_RESULTS);
        assert!(response.truncated);
        assert_eq!(response.matches[0].line_number, 1);
        assert_eq!(
            response.matches[MAX_OUTPUT_SEARCH_RESULTS - 1].line_number,
            MAX_OUTPUT_SEARCH_RESULTS
        );
    }

    #[test]
    fn excerpts_large_utf8_lines_without_corruption() {
        let mut searcher = OutputSearcher::new("ALVO".into());
        let content = format!("{}ALVO{}\n", "ação".repeat(1_000), "coração".repeat(1_000));
        assert!(searcher.push(&content));

        let response = searcher.finish("output-3".into());

        assert_eq!(response.matches.len(), 1);
        assert!(response.matches[0].excerpt.contains("ALVO"));
        assert!(!response.matches[0].excerpt.contains('\u{fffd}'));
        assert!(response.matches[0].excerpt.starts_with('…'));
        assert!(response.matches[0].excerpt.ends_with('…'));
    }

    #[test]
    fn renders_an_explicit_empty_result() {
        let mut searcher = OutputSearcher::new("missing".into());
        assert!(searcher.push("visible output\n"));

        let rendered = searcher.finish("output-4".into()).render();

        assert!(rendered.contains("matches: 0"));
        assert!(rendered.contains("No matching lines."));
    }

    #[ignore = "performance benchmark; run through `pnpm measure:output-search`"]
    #[test]
    fn benchmark_targeted_output_search() {
        const TARGET_BYTES: usize = 64 * 1_024 * 1_024;
        const CHUNK_BYTES: usize = 64 * 1_024;
        const QUERY: &str = "TARGET-OUTPUT-LINE";
        const SAMPLES: usize = 7;

        let ordinary_line = "routine build output without a relevant match\n";
        let mut chunks = Vec::new();
        let mut generated_bytes = 0usize;
        while generated_bytes < TARGET_BYTES {
            let remaining = TARGET_BYTES.saturating_sub(generated_bytes);
            let mut chunk = ordinary_line.repeat(
                CHUNK_BYTES
                    .saturating_div(ordinary_line.len())
                    .saturating_add(1),
            );
            chunk = truncate_to_boundary(&chunk, remaining.min(CHUNK_BYTES));
            generated_bytes = generated_bytes.saturating_add(chunk.len());
            chunks.push(chunk);
        }
        if let Some(last) = chunks.last_mut() {
            let target_line = format!("\nfinal diagnostic: {QUERY}\n");
            last.push_str(&target_line);
            generated_bytes = generated_bytes.saturating_add(target_line.len());
        }

        let mut durations = Vec::with_capacity(SAMPLES);
        let mut rendered = String::new();
        let mut match_count = 0usize;
        for sample in 0..(SAMPLES + 2) {
            let started_at = Instant::now();
            let mut searcher = OutputSearcher::new(QUERY.into());
            for chunk in &chunks {
                assert!(searcher.push(chunk));
            }
            let response = black_box(searcher.finish("benchmark-output".into()));
            let elapsed = started_at.elapsed();
            assert_eq!(response.matches.len(), 1);
            match_count = response.matches.len();
            rendered = response.render();
            if sample >= 2 {
                durations.push(elapsed);
            }
        }
        durations.sort_unstable();
        let median = durations[SAMPLES / 2];
        let byte_reduction = 1.0 - rendered.len() as f64 / CHUNK_BYTES as f64;

        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "corpusBytes": generated_bytes,
                "storedPageBytes": CHUNK_BYTES,
                "searchResponseBytes": rendered.len(),
                "estimatedStoredPageTokens": CHUNK_BYTES.div_ceil(4),
                "estimatedSearchResponseTokens": rendered.len().div_ceil(4),
                "pageTokenReductionPercent": byte_reduction * 100.0,
                "samples": SAMPLES,
                "medianMs": median.as_secs_f64() * 1_000.0,
                "matches": match_count,
            }))
            .expect("benchmark result should serialize")
        );
        assert_eq!(match_count, 1);
        assert!(rendered.contains(QUERY));
        assert!(byte_reduction >= 0.95);
    }

    fn truncate_to_boundary(value: &str, maximum_bytes: usize) -> String {
        let mut end = maximum_bytes.min(value.len());
        while !value.is_char_boundary(end) {
            end -= 1;
        }
        value[..end].to_string()
    }
}
