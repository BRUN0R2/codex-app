use tauri::AppHandle;
use uuid::Uuid;

use super::NativeEngineInner;
use super::agent::{
    TurnProviderState, TurnRun, emit_item_notification, handle_provider_control_event,
    validate_response_item,
};
use super::context_window::{build_compacted_history, prepare_compaction_history};
use super::provider::{ResponseEvent, ResponseItem, ResponseRequest, ResponseRequestSettings};
use super::storage::ProviderHistorySnapshot;
use super::turn_recovery;
use crate::engine::ThreadItem;
use crate::error::AppError;

pub(super) async fn compact_context(
    inner: &NativeEngineInner,
    app: &AppHandle,
    run: &mut TurnRun,
    instructions: &str,
    provider_state: &mut TurnProviderState,
    history: &ProviderHistorySnapshot,
    tools: &[serde_json::Value],
) -> Result<bool, AppError> {
    if *run.cancellation.borrow() {
        return Ok(false);
    }
    let context_window = run.model.context_window();
    let compaction_limit = [
        run.model.auto_compact_token_limit(),
        context_window.as_ref().map(|window| window.usable_tokens),
    ]
    .into_iter()
    .flatten()
    .min();
    let mut compaction_input =
        prepare_compaction_history(instructions, &history.items, tools, compaction_limit);
    compaction_input.push(ResponseItem::compaction_trigger());

    let compaction_id = Uuid::now_v7().to_string();
    let compaction_item = ThreadItem::ContextCompaction {
        id: compaction_id.clone(),
    };
    emit_item_notification(
        inner,
        app,
        &run.thread_id,
        &run.turn_id,
        compaction_item.clone(),
        true,
    )?;

    let mut transient_failure_count = 0u32;
    let checkpoint = 'request: loop {
        let request = ResponseRequest::new(
            run.model.id(),
            instructions,
            &compaction_input,
            tools,
            ResponseRequestSettings {
                parallel_tool_calls: run.model.supports_parallel_tool_calls(),
                reasoning_effort: run.reasoning_effort,
                service_tier: run.service_tier.as_deref(),
                prompt_cache_key: Some(&run.thread_id),
                verbosity: run.config.model_verbosity,
            },
        );
        let mut stream = match inner
            .provider
            .start_response(
                app,
                &inner.auth,
                request,
                &run.thread_id,
                provider_state.turn_state(),
                &mut run.cancellation,
            )
            .await
        {
            Ok(stream) => stream,
            Err(AppError::Cancelled(_)) => return Ok(false),
            Err(error) => {
                if let Some(decision) =
                    turn_recovery::classify(&error, &mut transient_failure_count)
                {
                    if turn_recovery::wait_for_retry(inner, app, run, &error, decision).await {
                        continue 'request;
                    }
                    return Ok(false);
                }
                return Err(error);
            }
        };
        let mut output_item_count = 0usize;
        let mut checkpoint = None;
        let mut saw_completed = false;
        loop {
            let event = match stream.next_event(&mut run.cancellation).await {
                Ok(Some(event)) => event,
                Ok(None) => break,
                Err(AppError::Cancelled(_)) => return Ok(false),
                Err(error) => {
                    if let Some(decision) =
                        turn_recovery::classify(&error, &mut transient_failure_count)
                    {
                        if turn_recovery::wait_for_retry(inner, app, run, &error, decision).await {
                            continue 'request;
                        }
                        return Ok(false);
                    }
                    return Err(error);
                }
            };
            transient_failure_count = 0;
            let Some(event) =
                handle_provider_control_event(inner, app, run, provider_state, event)?
            else {
                continue;
            };
            match event {
                ResponseEvent::OutputItemAdded(_) => {}
                ResponseEvent::OutputItemDone(item) => {
                    output_item_count = output_item_count.checked_add(1).ok_or_else(|| {
                        AppError::State("compaction output counter overflow".into())
                    })?;
                    validate_response_item(&item)?;
                    if item.is_compaction_checkpoint() && checkpoint.replace(item).is_some() {
                        return Err(AppError::Provider(
                            "context compaction returned more than one checkpoint".into(),
                        ));
                    }
                }
                ResponseEvent::Completed(_) => {
                    saw_completed = true;
                    break;
                }
                ResponseEvent::Interrupted => return Ok(false),
                ResponseEvent::OutputTextDelta { .. }
                | ResponseEvent::ReasoningSummaryDelta { .. }
                | ResponseEvent::ReasoningContentDelta { .. } => {}
                ResponseEvent::ServerModel(_)
                | ResponseEvent::TurnState(_)
                | ResponseEvent::ModelVerifications(_)
                | ResponseEvent::SafetyBuffering(_) => {
                    return Err(AppError::State(
                        "provider control event escaped its handler".into(),
                    ));
                }
            }
        }
        if !saw_completed {
            return Err(AppError::Provider(
                "context compaction stream ended before response.completed".into(),
            ));
        }
        let Some(checkpoint) = checkpoint else {
            return Err(AppError::Provider(format!(
                "context compaction returned no checkpoint in {output_item_count} output items"
            )));
        };
        break 'request checkpoint;
    };
    let compacted = build_compacted_history(&history.items, checkpoint);
    inner
        .storage
        .install_compacted_history(
            run.thread_id.clone(),
            run.turn_id.clone(),
            history.last_sequence(),
            compacted,
            compaction_id,
        )
        .await?;
    emit_item_notification(
        inner,
        app,
        &run.thread_id,
        &run.turn_id,
        compaction_item,
        false,
    )?;
    Ok(true)
}
