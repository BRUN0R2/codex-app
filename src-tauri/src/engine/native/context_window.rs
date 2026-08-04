use serde::Serialize;
use serde_json::Value;

use super::provider::{ResponseContent, ResponseItem};
use crate::engine::{ModelContextWindow, TokenUsage};

#[derive(Debug, Clone)]
pub(super) struct ContextUsageSnapshot {
    pub model: String,
    pub usage: TokenUsage,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct ContextWindowStatus {
    pub active_tokens: u64,
    pub should_compact: bool,
}

const BYTES_PER_TOKEN: u64 = 4;
const ENCRYPTED_PAYLOAD_OVERHEAD_BYTES: u64 = 650;
const RESIZED_IMAGE_TOKEN_ESTIMATE: u64 = 1_024;

pub(super) fn evaluate_context_window(
    model_id: &str,
    instructions: &str,
    history: &[ResponseItem],
    tools: &[Value],
    snapshot: Option<&ContextUsageSnapshot>,
    auto_compact_limit: Option<u64>,
    context_window: Option<&ModelContextWindow>,
) -> ContextWindowStatus {
    let estimated_request = estimate_request_tokens(instructions, history, tools);
    let measured_with_local_delta = snapshot
        .filter(|snapshot| snapshot.model == model_id)
        .and_then(|snapshot| {
            let last_model_item = history.iter().rposition(is_model_generated_item)?;
            let local_tokens = history[last_model_item.saturating_add(1)..]
                .iter()
                .map(estimate_item_tokens)
                .fold(0, u64::saturating_add);
            Some(snapshot.usage.total_tokens.saturating_add(local_tokens))
        });
    let active_tokens = measured_with_local_delta.map_or(estimated_request, |measured| {
        measured.max(estimated_request)
    });
    let should_compact = auto_compact_limit.is_some_and(|limit| active_tokens >= limit)
        || context_window.is_some_and(|window| active_tokens >= window.usable_tokens);

    ContextWindowStatus {
        active_tokens,
        should_compact,
    }
}

fn estimate_request_tokens(instructions: &str, history: &[ResponseItem], tools: &[Value]) -> u64 {
    estimate_text_tokens(instructions)
        .saturating_add(
            history
                .iter()
                .map(estimate_item_tokens)
                .fold(0, u64::saturating_add),
        )
        .saturating_add(estimate_json_tokens(tools))
}

fn estimate_item_tokens(item: &ResponseItem) -> u64 {
    match item {
        ResponseItem::Reasoning {
            encrypted_content: Some(content),
            ..
        }
        | ResponseItem::Compaction {
            encrypted_content: content,
            ..
        } => bytes_to_tokens(estimate_encrypted_payload_bytes(content.len())),
        _ => {
            let serialized_bytes = serde_json::to_vec(item)
                .map(|serialized| usize_to_u64(serialized.len()))
                .unwrap_or(u64::MAX);
            let (image_payload_bytes, image_estimate_bytes) = image_estimate_adjustment(item);
            bytes_to_tokens(
                serialized_bytes
                    .saturating_sub(image_payload_bytes)
                    .saturating_add(image_estimate_bytes),
            )
        }
    }
}

fn estimate_json_tokens<T>(value: &T) -> u64
where
    T: Serialize + ?Sized,
{
    serde_json::to_vec(value)
        .map(|serialized| bytes_to_tokens(usize_to_u64(serialized.len())))
        .unwrap_or(u64::MAX)
}

fn estimate_text_tokens(value: &str) -> u64 {
    bytes_to_tokens(usize_to_u64(value.len()))
}

fn bytes_to_tokens(bytes: u64) -> u64 {
    bytes.div_ceil(BYTES_PER_TOKEN)
}

fn estimate_encrypted_payload_bytes(encoded_len: usize) -> u64 {
    usize_to_u64(encoded_len)
        .saturating_mul(3)
        .checked_div(4)
        .unwrap_or_default()
        .saturating_sub(ENCRYPTED_PAYLOAD_OVERHEAD_BYTES)
}

fn image_estimate_adjustment(item: &ResponseItem) -> (u64, u64) {
    let ResponseItem::Message { content, .. } = item else {
        return (0, 0);
    };
    content
        .iter()
        .filter_map(|part| match part {
            ResponseContent::InputImage { image_url, .. } => inline_image_payload_len(image_url),
            ResponseContent::InputText { .. }
            | ResponseContent::OutputText { .. }
            | ResponseContent::Refusal { .. } => None,
        })
        .fold((0_u64, 0_u64), |(payloads, estimates), payload| {
            (
                payloads.saturating_add(payload),
                estimates
                    .saturating_add(RESIZED_IMAGE_TOKEN_ESTIMATE.saturating_mul(BYTES_PER_TOKEN)),
            )
        })
}

fn inline_image_payload_len(image_url: &str) -> Option<u64> {
    let (prefix, payload) = image_url.split_once(',')?;
    let prefix = prefix.to_ascii_lowercase();
    if !prefix.starts_with("data:image/") || !prefix.ends_with(";base64") {
        return None;
    }
    Some(usize_to_u64(payload.len()))
}

fn is_model_generated_item(item: &ResponseItem) -> bool {
    match item {
        ResponseItem::Message { role, .. } => role == "assistant",
        ResponseItem::Reasoning { .. }
        | ResponseItem::FunctionCall { .. }
        | ResponseItem::CustomToolCall { .. }
        | ResponseItem::WebSearchCall { .. }
        | ResponseItem::Compaction { .. } => true,
        ResponseItem::FunctionCallOutput { .. }
        | ResponseItem::CustomToolCallOutput { .. }
        | ResponseItem::CompactionTrigger { .. } => false,
    }
}

fn usize_to_u64(value: usize) -> u64 {
    u64::try_from(value).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(role: &str, value: &str) -> ResponseItem {
        ResponseItem::Message {
            id: None,
            role: role.into(),
            content: vec![ResponseContent::InputText { text: value.into() }],
            phase: None,
        }
    }

    fn usage(total_tokens: u64) -> TokenUsage {
        TokenUsage {
            input_tokens: total_tokens,
            cached_input_tokens: 0,
            output_tokens: 0,
            reasoning_output_tokens: 0,
            total_tokens,
        }
    }

    #[test]
    fn adds_local_items_after_the_last_model_item() {
        let history = vec![text("assistant", "done"), text("user", &"x".repeat(400))];
        let snapshot = ContextUsageSnapshot {
            model: "gpt-test".into(),
            usage: usage(900),
        };
        let status = evaluate_context_window(
            "gpt-test",
            "",
            &history,
            &[],
            Some(&snapshot),
            Some(1_000),
            None,
        );

        assert!(status.active_tokens >= 1_000);
        assert!(status.should_compact);
    }

    #[test]
    fn current_request_estimate_covers_larger_instructions() {
        let history = vec![text("assistant", "done")];
        let snapshot = ContextUsageSnapshot {
            model: "gpt-test".into(),
            usage: usage(10),
        };
        let status = evaluate_context_window(
            "gpt-test",
            &"i".repeat(4_000),
            &history,
            &[],
            Some(&snapshot),
            Some(900),
            None,
        );

        assert!(status.should_compact);
    }

    #[test]
    fn incompatible_model_uses_the_current_request_only() {
        let snapshot = ContextUsageSnapshot {
            model: "gpt-large".into(),
            usage: usage(900_000),
        };
        let status = evaluate_context_window(
            "gpt-small",
            "short",
            &[text("user", "hello")],
            &[],
            Some(&snapshot),
            Some(1_000),
            None,
        );

        assert!(!status.should_compact);
    }

    #[test]
    fn either_available_limit_can_trigger_compaction() {
        let window = ModelContextWindow {
            tokens: 2_000,
            usable_tokens: 100,
            usable_percent: 95,
            maximum_tokens: None,
        };
        let status = evaluate_context_window(
            "gpt-test",
            &"x".repeat(400),
            &[],
            &[],
            None,
            Some(10_000),
            Some(&window),
        );

        assert!(status.should_compact);
    }

    #[test]
    fn function_output_after_the_last_model_item_is_counted() {
        let history = vec![
            ResponseItem::FunctionCall {
                id: Some("call-item-1".into()),
                name: "read".into(),
                arguments: "{}".into(),
                call_id: "call-1".into(),
            },
            ResponseItem::FunctionCallOutput {
                call_id: "call-1".into(),
                output: "x".repeat(400),
            },
        ];
        let snapshot = ContextUsageSnapshot {
            model: "gpt-test".into(),
            usage: usage(900),
        };
        let status = evaluate_context_window(
            "gpt-test",
            "",
            &history,
            &[],
            Some(&snapshot),
            Some(1_000),
            None,
        );

        assert!(status.should_compact);
    }

    #[test]
    fn inline_image_uses_a_fixed_estimate_instead_of_base64_size() {
        let item = ResponseItem::user_content(vec![ResponseContent::InputImage {
            image_url: format!("data:image/png;base64,{}", "a".repeat(400_000)),
            detail: None,
        }]);
        let estimate = estimate_item_tokens(&item);

        assert!(estimate >= RESIZED_IMAGE_TOKEN_ESTIMATE);
        assert!(estimate < 1_200);
    }

    #[test]
    fn encrypted_checkpoint_has_a_bounded_visible_estimate() {
        let item = ResponseItem::Compaction {
            id: Some("compact-1".into()),
            encrypted_content: "x".repeat(4_000),
            internal_chat_message_metadata_passthrough: None,
        };

        assert_eq!(estimate_item_tokens(&item), (3_000_u64 - 650).div_ceil(4));
    }
}
