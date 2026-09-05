use crate::engine::ActivityStatus;
use crate::engine::native::code_mode::RuntimeResponse;
use crate::engine::native::provider::FunctionCallOutputContent;

const ESTIMATED_BYTES_PER_TOKEN: usize = 4;
const ESTIMATED_IMAGE_TOKENS: usize = 1_024;
const MAX_TRUNCATION_MARKER_BYTES: usize = 160;
pub(super) fn adapt_response(
    response: RuntimeResponse,
    max_tokens: usize,
    wall_time: std::time::Duration,
) -> (ActivityStatus, Vec<FunctionCallOutputContent>) {
    let response_cell_id = response.cell_id().to_string();
    let (status_text, status, mut content, error) = match response {
        RuntimeResponse::Yielded { cell_id, content } => (
            format!("Script running with cell ID {cell_id}"),
            ActivityStatus::InProgress,
            content,
            None,
        ),
        RuntimeResponse::Terminated { content, .. } => (
            format!("Script {response_cell_id} terminated"),
            ActivityStatus::Completed,
            content,
            None,
        ),
        RuntimeResponse::Completed { content, error, .. } => (
            if error.is_some() {
                format!("Script {response_cell_id} failed")
            } else {
                format!("Script {response_cell_id} completed")
            },
            if error.is_some() {
                ActivityStatus::Failed
            } else {
                ActivityStatus::Completed
            },
            content,
            error,
        ),
    };
    if let Some(error) = error {
        content.push(FunctionCallOutputContent::InputText {
            text: format!("Script error:\n{error}"),
        });
    }
    let mut content = truncate_content(content, max_tokens);
    let seconds = ((wall_time.as_secs_f32() * 10.0).round()) / 10.0;
    content.insert(
        0,
        FunctionCallOutputContent::InputText {
            text: format!("{status_text}\nWall time {seconds:.1} seconds\nOutput:\n"),
        },
    );
    (status, content)
}

fn truncate_content(
    content: Vec<FunctionCallOutputContent>,
    max_tokens: usize,
) -> Vec<FunctionCallOutputContent> {
    let maximum_bytes = max_tokens.saturating_mul(ESTIMATED_BYTES_PER_TOKEN);
    if content.iter().map(content_cost).sum::<usize>() <= maximum_bytes {
        return content;
    }
    let budgets = content_budgets(&content, maximum_bytes);
    let mut output = Vec::with_capacity(content.len());
    for (item, budget) in content.into_iter().zip(budgets) {
        if budget == 0 {
            continue;
        }
        match item {
            FunctionCallOutputContent::InputText { text } => {
                if text.len() <= budget {
                    output.push(FunctionCallOutputContent::InputText { text });
                } else {
                    output.push(FunctionCallOutputContent::InputText {
                        text: truncate_text(&text, budget),
                    });
                }
            }
            image @ FunctionCallOutputContent::InputImage { .. } => {
                let cost = ESTIMATED_IMAGE_TOKENS.saturating_mul(ESTIMATED_BYTES_PER_TOKEN);
                if cost <= budget {
                    output.push(image);
                } else {
                    output.push(FunctionCallOutputContent::InputText {
                        text: "[omitted image output: token budget exhausted]"
                            .chars()
                            .take(budget)
                            .collect(),
                    });
                }
            }
            FunctionCallOutputContent::InputAudio { audio_url } => {
                let cost = audio_url.len().max(ESTIMATED_BYTES_PER_TOKEN);
                if cost <= budget {
                    output.push(FunctionCallOutputContent::InputAudio { audio_url });
                } else {
                    output.push(FunctionCallOutputContent::InputText {
                        text: "[omitted audio output: token budget exhausted]"
                            .chars()
                            .take(budget)
                            .collect(),
                    });
                }
            }
        }
    }
    output
}

fn content_budgets(content: &[FunctionCallOutputContent], mut remaining: usize) -> Vec<usize> {
    let mut costs: Vec<_> = content
        .iter()
        .enumerate()
        .map(|(index, item)| (index, content_cost(item)))
        .collect();
    costs.sort_unstable_by_key(|&(index, cost)| (cost, index));
    let mut budgets = vec![0; content.len()];
    for (position, &(index, cost)) in costs.iter().enumerate() {
        let allocation = cost.min(remaining / (costs.len() - position));
        budgets[index] = allocation;
        remaining -= allocation;
    }
    budgets
}

fn content_cost(item: &FunctionCallOutputContent) -> usize {
    match item {
        FunctionCallOutputContent::InputText { text } => text.len(),
        FunctionCallOutputContent::InputImage { .. } => {
            ESTIMATED_IMAGE_TOKENS * ESTIMATED_BYTES_PER_TOKEN
        }
        FunctionCallOutputContent::InputAudio { audio_url } => {
            audio_url.len().max(ESTIMATED_BYTES_PER_TOKEN)
        }
    }
}

fn truncate_text(text: &str, maximum_bytes: usize) -> String {
    let original_tokens = text.len().div_ceil(ESTIMATED_BYTES_PER_TOKEN);
    let marker =
        format!("\n[truncated Code Mode output; approximately {original_tokens} tokens total]\n");
    if maximum_bytes <= marker.len().min(MAX_TRUNCATION_MARKER_BYTES) {
        return marker.chars().take(maximum_bytes).collect();
    }
    let available = maximum_bytes - marker.len();
    let head_bytes = available / 2;
    let tail_bytes = available - head_bytes;
    let head_end = floor_char_boundary(text, head_bytes);
    let tail_start = ceil_char_boundary(text, text.len().saturating_sub(tail_bytes));
    format!("{}{}{}", &text[..head_end], marker, &text[tail_start..])
}

fn floor_char_boundary(text: &str, mut index: usize) -> usize {
    index = index.min(text.len());
    while index > 0 && !text.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn ceil_char_boundary(text: &str, mut index: usize) -> usize {
    index = index.min(text.len());
    while index < text.len() && !text.is_char_boundary(index) {
        index += 1;
    }
    index
}

pub(super) fn content_text(content: &[FunctionCallOutputContent]) -> String {
    content
        .iter()
        .map(|item| match item {
            FunctionCallOutputContent::InputText { text } => text.as_str(),
            FunctionCallOutputContent::InputImage { .. } => "[image output]",
            FunctionCallOutputContent::InputAudio { .. } => "[audio output]",
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::ImageDetail;

    fn text(value: impl Into<String>) -> FunctionCallOutputContent {
        FunctionCallOutputContent::InputText { text: value.into() }
    }

    #[test]
    fn truncation_preserves_utf8_boundaries_and_both_ends() {
        let source = format!("começo-{}-fim", "á".repeat(100));
        let truncated = truncate_text(&source, 80);
        assert!(truncated.starts_with("começo"));
        assert!(truncated.ends_with("fim"));
        assert!(truncated.contains("truncated Code Mode output"));
        assert!(truncated.len() <= 80);
    }

    #[test]
    fn a_large_first_result_cannot_hide_later_results_or_script_errors() {
        let source = vec![
            text("a".repeat(40_000)),
            text("file-two.rs:42 needle"),
            text("Script error: invalid argument"),
        ];
        let projected = truncate_content(source, 100);
        assert_eq!(projected.len(), 3);
        assert_eq!(projected[1], text("file-two.rs:42 needle"));
        assert_eq!(projected[2], text("Script error: invalid argument"));
        assert!(
            projected
                .iter()
                .map(|item| match item {
                    FunctionCallOutputContent::InputText { text } => text.len(),
                    _ => 0,
                })
                .sum::<usize>()
                <= 400
        );
    }

    #[test]
    fn every_large_result_retains_its_own_head_and_tail_in_original_order() {
        let source: Vec<_> = (0..4)
            .map(|index| {
                text(format!(
                    "result-{index}-start:{}:result-{index}-end",
                    "x".repeat(8_000)
                ))
            })
            .collect();
        let projected = truncate_content(source, 1_000);
        assert_eq!(projected.len(), 4);
        for (index, item) in projected.iter().enumerate() {
            let FunctionCallOutputContent::InputText { text } = item else {
                panic!("text output")
            };
            assert!(text.starts_with(&format!("result-{index}-start:")));
            assert!(text.ends_with(&format!(":result-{index}-end")));
            assert!(text.len() <= 1_000);
        }
    }

    #[test]
    fn complete_outputs_and_media_are_unchanged_when_they_fit() {
        let source = vec![
            text("result"),
            FunctionCallOutputContent::InputImage {
                image_url: "data:image/png;base64,aA==".into(),
                detail: Some(ImageDetail::Original),
            },
            FunctionCallOutputContent::InputAudio {
                audio_url: "data:audio/wav;base64,aA==".into(),
            },
        ];
        assert_eq!(truncate_content(source.clone(), 2_000), source);
        assert!(truncate_content(source.clone(), 0).is_empty());
        for tokens in 1..40 {
            let projected = truncate_content(source.clone(), tokens);
            let text_bytes: usize = projected
                .iter()
                .map(|item| match item {
                    FunctionCallOutputContent::InputText { text } => text.len(),
                    FunctionCallOutputContent::InputAudio { audio_url } => {
                        audio_url.len().max(ESTIMATED_BYTES_PER_TOKEN)
                    }
                    FunctionCallOutputContent::InputImage { .. } => {
                        ESTIMATED_IMAGE_TOKENS * ESTIMATED_BYTES_PER_TOKEN
                    }
                })
                .sum();
            assert!(text_bytes <= tokens * ESTIMATED_BYTES_PER_TOKEN);
        }
    }
}
