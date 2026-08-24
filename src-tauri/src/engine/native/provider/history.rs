use std::collections::HashMap;

use super::{FunctionCallOutputPayload, ResponseItem};
use crate::error::AppError;

const ABORTED_TOOL_OUTPUT: &str = "aborted";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CallKind {
    Custom,
    Function,
}

pub(crate) struct ProviderHistoryNormalization {
    pub(crate) items: Vec<ResponseItem>,
    pub(crate) inserted_aborted_outputs: usize,
    pub(crate) removed_orphan_outputs: usize,
}

impl ProviderHistoryNormalization {
    pub(crate) fn changed(&self) -> bool {
        self.inserted_aborted_outputs > 0 || self.removed_orphan_outputs > 0
    }
}

pub(crate) fn normalize_provider_history(
    items: Vec<ResponseItem>,
) -> Result<ProviderHistoryNormalization, AppError> {
    let mut calls = HashMap::new();
    let mut outputs = HashMap::new();

    for item in &items {
        match item {
            ResponseItem::FunctionCall { call_id, .. } => {
                register_unique(&mut calls, call_id, CallKind::Function, "tool call")?;
            }
            ResponseItem::CustomToolCall { call_id, .. } => {
                register_unique(&mut calls, call_id, CallKind::Custom, "custom tool call")?;
            }
            ResponseItem::FunctionCallOutput { call_id, .. } => {
                register_unique(
                    &mut outputs,
                    call_id,
                    CallKind::Function,
                    "tool call output",
                )?;
            }
            ResponseItem::CustomToolCallOutput { call_id, .. } => {
                register_unique(
                    &mut outputs,
                    call_id,
                    CallKind::Custom,
                    "custom tool call output",
                )?;
            }
            ResponseItem::Message { .. }
            | ResponseItem::Reasoning { .. }
            | ResponseItem::WebSearchCall { .. }
            | ResponseItem::Compaction { .. }
            | ResponseItem::CompactionTrigger { .. } => {}
        }
    }

    let mut normalized = Vec::with_capacity(items.len());
    let mut inserted_aborted_outputs = 0usize;
    let mut removed_orphan_outputs = 0usize;

    for item in items {
        match &item {
            ResponseItem::FunctionCall { call_id, .. } => {
                let call_id = call_id.clone();
                let output_is_missing = outputs.get(&call_id) != Some(&CallKind::Function);
                normalized.push(item);
                if output_is_missing {
                    normalized.push(ResponseItem::FunctionCallOutput {
                        call_id,
                        output: FunctionCallOutputPayload::text(ABORTED_TOOL_OUTPUT),
                    });
                    inserted_aborted_outputs += 1;
                }
            }
            ResponseItem::CustomToolCall { call_id, .. } => {
                let call_id = call_id.clone();
                let output_is_missing = outputs.get(&call_id) != Some(&CallKind::Custom);
                normalized.push(item);
                if output_is_missing {
                    normalized.push(ResponseItem::CustomToolCallOutput {
                        call_id,
                        output: ABORTED_TOOL_OUTPUT.into(),
                    });
                    inserted_aborted_outputs += 1;
                }
            }
            ResponseItem::FunctionCallOutput { call_id, .. } => {
                if calls.get(call_id) == Some(&CallKind::Function) {
                    normalized.push(item);
                } else {
                    removed_orphan_outputs += 1;
                }
            }
            ResponseItem::CustomToolCallOutput { call_id, .. } => {
                if calls.get(call_id) == Some(&CallKind::Custom) {
                    normalized.push(item);
                } else {
                    removed_orphan_outputs += 1;
                }
            }
            ResponseItem::Message { .. }
            | ResponseItem::Reasoning { .. }
            | ResponseItem::WebSearchCall { .. }
            | ResponseItem::Compaction { .. }
            | ResponseItem::CompactionTrigger { .. } => normalized.push(item),
        }
    }

    Ok(ProviderHistoryNormalization {
        items: normalized,
        inserted_aborted_outputs,
        removed_orphan_outputs,
    })
}

fn register_unique(
    entries: &mut HashMap<String, CallKind>,
    call_id: &str,
    kind: CallKind,
    label: &str,
) -> Result<(), AppError> {
    if call_id.is_empty() {
        return Err(AppError::Provider(format!("{label} has an empty call id")));
    }
    if entries.insert(call_id.into(), kind).is_some() {
        return Err(AppError::Provider(format!(
            "provider history contains duplicate {label} id `{call_id}`"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::normalize_provider_history;
    use crate::engine::native::provider::{FunctionCallOutputPayload, ResponseItem};

    #[test]
    fn inserts_aborted_outputs_after_incomplete_calls_and_removes_orphans() {
        let normalized = normalize_provider_history(vec![
            ResponseItem::FunctionCall {
                id: Some("function-item".into()),
                name: "read_file".into(),
                arguments: "{}".into(),
                call_id: "function-call".into(),
            },
            ResponseItem::CustomToolCallOutput {
                call_id: "orphan".into(),
                output: "ignored".into(),
            },
            ResponseItem::CustomToolCall {
                id: Some("custom-item".into()),
                call_id: "custom-call".into(),
                name: "custom".into(),
                input: "{}".into(),
            },
        ])
        .expect("history should normalize");

        assert_eq!(normalized.inserted_aborted_outputs, 2);
        assert_eq!(normalized.removed_orphan_outputs, 1);
        assert!(matches!(
            &normalized.items[1],
            ResponseItem::FunctionCallOutput { call_id, output }
                if call_id == "function-call"
                    && matches!(output, FunctionCallOutputPayload::Text(text) if text == "aborted")
        ));
        assert!(matches!(
            &normalized.items[3],
            ResponseItem::CustomToolCallOutput { call_id, output }
                if call_id == "custom-call" && output == "aborted"
        ));
    }

    #[test]
    fn preserves_complete_calls_without_reporting_a_repair() {
        let normalized = normalize_provider_history(vec![
            ResponseItem::FunctionCall {
                id: None,
                name: "read_file".into(),
                arguments: "{}".into(),
                call_id: "complete".into(),
            },
            ResponseItem::FunctionCallOutput {
                call_id: "complete".into(),
                output: FunctionCallOutputPayload::text("ok"),
            },
        ])
        .expect("history should normalize");

        assert!(!normalized.changed());
        assert_eq!(normalized.items.len(), 2);
    }

    #[test]
    fn rejects_duplicate_call_and_output_ids() {
        let duplicate_calls = normalize_provider_history(vec![
            ResponseItem::FunctionCall {
                id: None,
                name: "first".into(),
                arguments: "{}".into(),
                call_id: "duplicate".into(),
            },
            ResponseItem::FunctionCall {
                id: None,
                name: "second".into(),
                arguments: "{}".into(),
                call_id: "duplicate".into(),
            },
        ]);
        assert!(duplicate_calls.is_err());

        let duplicate_outputs = normalize_provider_history(vec![
            ResponseItem::FunctionCallOutput {
                call_id: "duplicate".into(),
                output: FunctionCallOutputPayload::text("first"),
            },
            ResponseItem::FunctionCallOutput {
                call_id: "duplicate".into(),
                output: FunctionCallOutputPayload::text("second"),
            },
        ]);
        assert!(duplicate_outputs.is_err());
    }
}
