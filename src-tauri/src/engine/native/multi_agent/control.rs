use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use tauri::AppHandle;
use tokio::sync::watch;
use uuid::Uuid;

use super::{
    AgentIdentity, AgentInvocationContext, AgentMessageState, AgentStatus, AgentThreadDraft,
    DEFAULT_WAIT_TIMEOUT_MS, ForkTurns, InterAgentMessage, InterAgentMessageType,
    InterruptAgentArgs, ListAgentsArgs, ListedAgent, MAX_AGENT_MESSAGE_BYTES,
    MAX_CONCURRENT_AGENTS, MAX_WAIT_TIMEOUT_MS, MIN_WAIT_TIMEOUT_MS, MailboxActivity,
    MessageAgentArgs, SpawnAgentArgs, WaitAgentArgs, WaitOutcome,
};
use crate::engine::native::provider::ResponseItem;
use crate::engine::native::{NativeEngine, NativeEngineInner, StartTurn, StartTurnContent};
use crate::error::AppError;

pub(in crate::engine::native) async fn spawn_agent(
    inner: &Arc<NativeEngineInner>,
    app: &AppHandle,
    invocation: &AgentInvocationContext,
    provider_call_id: &str,
    args: SpawnAgentArgs,
    cancellation: &watch::Receiver<bool>,
) -> Result<Value, AppError> {
    ensure_not_cancelled(cancellation)?;
    let message = validate_message(args.message)?;
    let fork_turns = ForkTurns::parse(args.fork_turns.as_deref())?;
    if fork_turns.inherits_full_history()
        && (args.model.is_some() || args.reasoning_effort.is_some())
    {
        return Err(AppError::Tool(
            "full-history agent forks inherit the parent model and reasoning effort; use fork_turns=`none` or a positive turn count for overrides"
                .into(),
        ));
    }
    let parent = inner
        .multi_agents
        .identity(&inner.storage, &invocation.thread_id)
        .await?;
    let path = parent
        .path
        .join(args.task_name.trim())
        .map_err(AppError::Tool)?;

    let requested_model = args.model.as_deref().unwrap_or(&invocation.model);
    let model = inner
        .provider
        .select_model(app, &inner.auth, Some(requested_model))
        .await?;
    if !model.multi_agent_version().is_supported() {
        return Err(AppError::Tool(format!(
            "model `{}` does not support the current multi-agent runtime",
            model.id()
        )));
    }
    let reasoning_effort = args.reasoning_effort.or(invocation.reasoning_effort);
    if let Some(reasoning_effort) = reasoning_effort
        && !model.supports_reasoning_effort(reasoning_effort)
    {
        return Err(AppError::Tool(format!(
            "reasoning effort `{}` is not supported by model `{}`",
            reasoning_effort.as_str(),
            model.id()
        )));
    }
    let service_tier = model.select_service_tier(invocation.service_tier.as_deref())?;

    let spawn_gate = inner.multi_agents.spawn_gate(&parent.root_thread_id).await;
    let _spawn_guard = spawn_gate.lock().await;
    ensure_agent_execution_capacity(inner, &parent.root_thread_id).await?;
    ensure_not_cancelled(cancellation)?;
    let initial_task = InterAgentMessage {
        message_type: InterAgentMessageType::NewTask,
        task_name: path.clone(),
        sender: parent.path.clone(),
        payload: message.clone(),
    };
    let identity = inner
        .storage
        .create_agent_thread(AgentThreadDraft {
            parent,
            path: path.clone(),
            task_name: args.task_name,
            initial_message: message_item(&initial_task),
            model: model.id().to_string(),
            reasoning_effort,
            service_tier: service_tier.clone(),
            fork_turns,
            parent_spawn_call_id: provider_call_id.to_string(),
            preview: message.clone(),
        })
        .await?;
    let start = start_agent_turn(
        Arc::clone(inner),
        app.clone(),
        identity.clone(),
        StartTurnContent::AgentMailbox,
        invocation.timezone.clone(),
        invocation.timezone_offset_min,
    )
    .await;
    if let Err(error) = start {
        let cleanup = inner.storage.delete_agent_thread(identity.thread_id).await;
        return match cleanup {
            Ok(()) => Err(error),
            Err(cleanup_error) => Err(AppError::State(format!(
                "agent turn failed to start ({error}); cleanup also failed ({cleanup_error})"
            ))),
        };
    }
    inner.multi_agents.register(identity.clone()).await;

    Ok(json!({ "task_name": path.as_str() }))
}

pub(in crate::engine::native) async fn send_message(
    inner: &Arc<NativeEngineInner>,
    invocation: &AgentInvocationContext,
    args: MessageAgentArgs,
) -> Result<Value, AppError> {
    let message = validate_message(args.message)?;
    let sender = inner
        .multi_agents
        .identity(&inner.storage, &invocation.thread_id)
        .await?;
    let recipient = inner
        .multi_agents
        .resolve_target(&inner.storage, &invocation.thread_id, &args.target)
        .await?;
    if recipient.thread_id == sender.thread_id {
        return Err(AppError::Tool(
            "an agent cannot send a message to itself".into(),
        ));
    }
    let message = InterAgentMessage {
        message_type: InterAgentMessageType::Message,
        task_name: recipient.path.clone(),
        sender: sender.path.clone(),
        payload: message,
    };
    let item = message_item(&message);
    if deliver_to_active_turn(inner, &recipient, &item).await? != ActiveDelivery::Delivered {
        inner
            .storage
            .queue_agent_message(
                sender.root_thread_id,
                sender.thread_id,
                recipient.thread_id.clone(),
                &item,
            )
            .await?;
    }
    inner
        .multi_agents
        .notify_message(&recipient.thread_id, sender.path)
        .await;
    Ok(json!({}))
}

pub(in crate::engine::native) async fn followup_task(
    inner: &Arc<NativeEngineInner>,
    app: &AppHandle,
    invocation: &AgentInvocationContext,
    args: MessageAgentArgs,
    cancellation: &watch::Receiver<bool>,
) -> Result<Value, AppError> {
    ensure_not_cancelled(cancellation)?;
    let message = validate_message(args.message)?;
    let sender = inner
        .multi_agents
        .identity(&inner.storage, &invocation.thread_id)
        .await?;
    let recipient = inner
        .multi_agents
        .resolve_target(&inner.storage, &invocation.thread_id, &args.target)
        .await?;
    if recipient.path.is_root() {
        return Err(AppError::Tool(
            "follow-up tasks cannot target the root agent".into(),
        ));
    }
    if recipient.thread_id == sender.thread_id {
        return Err(AppError::Tool(
            "an agent cannot assign a follow-up task to itself".into(),
        ));
    }
    let message = InterAgentMessage {
        message_type: InterAgentMessageType::NewTask,
        task_name: recipient.path.clone(),
        sender: sender.path.clone(),
        payload: message,
    };
    let item = message_item(&message);
    if deliver_to_active_turn(inner, &recipient, &item).await? == ActiveDelivery::Delivered {
        inner
            .multi_agents
            .notify_message(&recipient.thread_id, sender.path)
            .await;
        return Ok(json!({}));
    }
    let message_id = item
        .id()
        .ok_or_else(|| AppError::State("agent message is missing its provider id".into()))?
        .to_string();
    inner
        .storage
        .queue_agent_message(
            sender.root_thread_id,
            sender.thread_id,
            recipient.thread_id.clone(),
            &item,
        )
        .await?;
    inner
        .multi_agents
        .notify_message(&recipient.thread_id, sender.path)
        .await;
    ensure_agent_mailbox_turn(
        inner,
        app,
        &recipient,
        &message_id,
        &invocation.timezone,
        invocation.timezone_offset_min,
        cancellation,
    )
    .await?;
    Ok(json!({}))
}

pub(in crate::engine::native) async fn interrupt_agent(
    inner: &Arc<NativeEngineInner>,
    invocation: &AgentInvocationContext,
    args: InterruptAgentArgs,
) -> Result<Value, AppError> {
    let target = inner
        .multi_agents
        .resolve_target(&inner.storage, &invocation.thread_id, &args.target)
        .await?;
    if target.path.is_root() {
        return Err(AppError::Tool("root is not a spawned agent".into()));
    }
    if target.thread_id == invocation.thread_id {
        return Err(AppError::Tool(
            "an agent cannot interrupt itself; return the result and let its parent interrupt it"
                .into(),
        ));
    }
    let previous_status = inner.storage.agent_status(target.thread_id.clone()).await?;
    let active = {
        let active_turns = inner.active_turns.lock().await;
        active_turns
            .get(&target.thread_id)
            .map(|active| (active.turn_id.clone(), active.cancellation.clone()))
    };
    if let Some((turn_id, cancellation)) = active {
        cancellation.send_replace(true);
        inner
            .command_sessions
            .request_turn_cancellation(&target.thread_id, &turn_id)
            .await;
    }
    Ok(json!({ "previous_status": previous_status }))
}

pub(in crate::engine::native) async fn list_agents(
    inner: &Arc<NativeEngineInner>,
    invocation: &AgentInvocationContext,
    args: ListAgentsArgs,
) -> Result<Value, AppError> {
    let identities = inner
        .multi_agents
        .list_tree(
            &inner.storage,
            &invocation.thread_id,
            args.path_prefix.as_deref(),
        )
        .await?;
    let mut agents = Vec::with_capacity(identities.len());
    for identity in identities {
        agents.push(ListedAgent {
            agent_name: identity.path.to_string(),
            agent_status: inner.storage.agent_status(identity.thread_id).await?,
        });
    }
    Ok(json!({ "agents": agents }))
}

pub(in crate::engine::native) async fn wait_agent(
    inner: &Arc<NativeEngineInner>,
    invocation: &AgentInvocationContext,
    args: WaitAgentArgs,
    cancellation: &mut watch::Receiver<bool>,
) -> Result<Value, AppError> {
    let requested_timeout = args.timeout_ms;
    if requested_timeout.is_some_and(|timeout| timeout > MAX_WAIT_TIMEOUT_MS) {
        return Err(AppError::Tool(format!(
            "timeout_ms must not exceed {MAX_WAIT_TIMEOUT_MS}"
        )));
    }
    let timeout = requested_timeout
        .unwrap_or(DEFAULT_WAIT_TIMEOUT_MS)
        .max(MIN_WAIT_TIMEOUT_MS);
    let outcome = inner
        .multi_agents
        .wait(
            &invocation.thread_id,
            Duration::from_millis(timeout),
            cancellation,
        )
        .await;
    let (mut message, timed_out) = match outcome {
        WaitOutcome::Activity(activities) => (activity_summary(&activities), false),
        WaitOutcome::TimedOut => ("Wait timed out.".to_string(), true),
        WaitOutcome::Cancelled => {
            return Err(AppError::Cancelled("wait_agent was interrupted".into()));
        }
    };
    if requested_timeout.is_some_and(|requested| requested < timeout) {
        message.push_str(&format!(
            "\n\nRequested timeout was clamped to the {timeout}ms minimum."
        ));
    }
    Ok(json!({ "message": message, "timed_out": timed_out }))
}

pub(in crate::engine::native) async fn deliver_completion(
    inner: &NativeEngineInner,
    child_thread_id: &str,
    status: AgentStatus,
) -> Result<(), AppError> {
    let Some(payload) = completion_payload(status) else {
        return Ok(());
    };
    let child = inner
        .multi_agents
        .identity(&inner.storage, child_thread_id)
        .await?;
    let Some(parent_thread_id) = child.parent_thread_id.as_deref() else {
        return Ok(());
    };
    let parent = inner
        .multi_agents
        .identity(&inner.storage, parent_thread_id)
        .await?;
    let message = InterAgentMessage {
        message_type: InterAgentMessageType::FinalAnswer,
        task_name: parent.path.clone(),
        sender: child.path.clone(),
        payload,
    };
    let item = message_item(&message);
    if deliver_to_active_turn(inner, &parent, &item).await? != ActiveDelivery::Delivered {
        inner
            .storage
            .queue_agent_message(
                child.root_thread_id,
                child.thread_id,
                parent.thread_id.clone(),
                &item,
            )
            .await?;
    }
    inner
        .multi_agents
        .notify_message(&parent.thread_id, child.path)
        .await;
    Ok(())
}

fn start_agent_turn(
    inner: Arc<NativeEngineInner>,
    app: AppHandle,
    identity: AgentIdentity,
    content: StartTurnContent,
    timezone: String,
    timezone_offset_min: i32,
) -> futures_util::future::BoxFuture<'static, Result<(), AppError>> {
    Box::pin(async move {
        let model = identity
            .model
            .clone()
            .ok_or_else(|| AppError::State("spawned agent is missing its model".into()))?;
        let engine = NativeEngine { inner };
        engine
            .turn_start(
                &app,
                StartTurn {
                    thread_id: identity.thread_id.clone(),
                    content,
                    model: Some(model),
                    effort: identity.reasoning_effort,
                    service_tier: identity.service_tier.clone(),
                    timezone,
                    timezone_offset_min,
                },
            )
            .await?;
        Ok(())
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ActiveDelivery {
    Delivered,
    Idle,
    Completing,
}

async fn deliver_to_active_turn(
    inner: &NativeEngineInner,
    recipient: &AgentIdentity,
    item: &ResponseItem,
) -> Result<ActiveDelivery, AppError> {
    let mut active_turns = inner.active_turns.lock().await;
    let Some(active) = active_turns.get_mut(&recipient.thread_id) else {
        return Ok(ActiveDelivery::Idle);
    };
    if !active.can_accept_steer() {
        return Ok(ActiveDelivery::Completing);
    }
    let pending_sequence = inner
        .storage
        .append_agent_turn_input(recipient.thread_id.clone(), active.turn_id.clone(), item)
        .await?;
    active.record_steer(pending_sequence);
    Ok(ActiveDelivery::Delivered)
}

async fn ensure_agent_mailbox_turn(
    inner: &Arc<NativeEngineInner>,
    app: &AppHandle,
    recipient: &AgentIdentity,
    message_id: &str,
    timezone: &str,
    timezone_offset_min: i32,
    cancellation: &watch::Receiver<bool>,
) -> Result<(), AppError> {
    let mut cancellation = cancellation.clone();
    loop {
        ensure_not_cancelled(&cancellation)?;
        match inner
            .storage
            .agent_message_state(recipient.thread_id.clone(), message_id.to_string())
            .await?
        {
            AgentMessageState::Delivered => return Ok(()),
            AgentMessageState::Missing => {
                return Err(AppError::State(format!(
                    "queued follow-up `{message_id}` disappeared before agent `{}` received it",
                    recipient.path
                )));
            }
            AgentMessageState::Pending => {}
        }

        let mut settlement = inner
            .multi_agents
            .subscribe_turn_settlement(&recipient.thread_id)
            .await;
        if inner
            .active_turns
            .lock()
            .await
            .contains_key(&recipient.thread_id)
        {
            wait_for_turn_settlement(&mut settlement, &mut cancellation).await?;
            continue;
        }

        let spawn_gate = inner
            .multi_agents
            .spawn_gate(&recipient.root_thread_id)
            .await;
        let spawn_guard = spawn_gate.lock().await;
        if inner
            .active_turns
            .lock()
            .await
            .contains_key(&recipient.thread_id)
        {
            drop(spawn_guard);
            wait_for_turn_settlement(&mut settlement, &mut cancellation).await?;
            continue;
        }
        match inner
            .storage
            .agent_message_state(recipient.thread_id.clone(), message_id.to_string())
            .await?
        {
            AgentMessageState::Delivered => return Ok(()),
            AgentMessageState::Missing => {
                return Err(AppError::State(format!(
                    "queued follow-up `{message_id}` disappeared before agent `{}` received it",
                    recipient.path
                )));
            }
            AgentMessageState::Pending => {}
        }
        ensure_agent_execution_capacity(inner, &recipient.root_thread_id).await?;
        ensure_not_cancelled(&cancellation)?;
        let start = start_agent_turn(
            Arc::clone(inner),
            app.clone(),
            recipient.clone(),
            StartTurnContent::AgentMailbox,
            timezone.to_string(),
            timezone_offset_min,
        )
        .await;
        drop(spawn_guard);
        match start {
            Ok(()) => return Ok(()),
            Err(error) => {
                let active = inner
                    .active_turns
                    .lock()
                    .await
                    .contains_key(&recipient.thread_id);
                if !active {
                    return Err(error);
                }
                wait_for_turn_settlement(&mut settlement, &mut cancellation).await?;
            }
        }
    }
}

async fn wait_for_turn_settlement(
    settlement: &mut watch::Receiver<u64>,
    cancellation: &mut watch::Receiver<bool>,
) -> Result<(), AppError> {
    ensure_not_cancelled(cancellation)?;
    tokio::select! {
        result = settlement.changed() => {
            let _sender_still_exists = result.is_ok();
            Ok(())
        }
        result = cancellation.changed() => {
            if result.is_err() || *cancellation.borrow() {
                Err(AppError::Cancelled("follow-up task was interrupted".into()))
            } else {
                Ok(())
            }
        }
    }
}

async fn ensure_agent_execution_capacity(
    inner: &NativeEngineInner,
    root_thread_id: &str,
) -> Result<(), AppError> {
    let active_thread_ids = inner
        .active_turns
        .lock()
        .await
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    let mut active_agents = 0usize;
    for thread_id in active_thread_ids {
        let identity = inner
            .multi_agents
            .identity(&inner.storage, &thread_id)
            .await?;
        if identity.root_thread_id == root_thread_id {
            active_agents = active_agents.saturating_add(1);
        }
    }
    if active_agents >= MAX_CONCURRENT_AGENTS {
        return Err(AppError::Tool(format!(
            "agent concurrency limit reached ({MAX_CONCURRENT_AGENTS} active agents including root)"
        )));
    }
    Ok(())
}

fn message_item(message: &InterAgentMessage) -> ResponseItem {
    let seed = Uuid::now_v7().to_string();
    let content_kind = match message.message_type {
        InterAgentMessageType::FinalAnswer => "multi_agent.inter_agent_completion_message",
        InterAgentMessageType::Message | InterAgentMessageType::NewTask => {
            "multi_agent.inter_agent_message"
        }
    };
    ResponseItem::context_text_with_seed("assistant", message.render(), content_kind, &seed)
}

fn validate_message(message: String) -> Result<String, AppError> {
    let message = message.trim();
    if message.is_empty() {
        return Err(AppError::Tool(
            "empty messages cannot be sent to an agent".into(),
        ));
    }
    if message.len() > MAX_AGENT_MESSAGE_BYTES {
        return Err(AppError::Tool(format!(
            "agent message exceeds {MAX_AGENT_MESSAGE_BYTES} bytes"
        )));
    }
    Ok(message.to_string())
}

fn ensure_not_cancelled(cancellation: &watch::Receiver<bool>) -> Result<(), AppError> {
    if *cancellation.borrow() {
        Err(AppError::Cancelled(
            "multi-agent operation was cancelled".into(),
        ))
    } else {
        Ok(())
    }
}

fn activity_summary(activities: &[MailboxActivity]) -> String {
    if activities
        .iter()
        .any(|activity| matches!(activity, MailboxActivity::Steer))
    {
        return "Wait interrupted by new input.".into();
    }
    let senders = activities
        .iter()
        .filter_map(|activity| match activity {
            MailboxActivity::Message { sender } => Some(sender.as_str()),
            MailboxActivity::Steer => None,
        })
        .collect::<BTreeSet<_>>();
    if senders.is_empty() {
        "Wait completed.".into()
    } else {
        format!(
            "Mailbox updates are available from {}.",
            senders.into_iter().collect::<Vec<_>>().join(", ")
        )
    }
}

fn completion_payload(status: AgentStatus) -> Option<String> {
    match status {
        AgentStatus::Completed(message) => Some(message.unwrap_or_default()),
        AgentStatus::Errored(error) => Some(format!(
            "Agent errored: {error}\n\nIf this task is still needed, send the agent a follow-up task."
        )),
        AgentStatus::Shutdown => Some("Agent shut down.".into()),
        AgentStatus::NotFound => Some("Agent was not found.".into()),
        AgentStatus::PendingInit | AgentStatus::Running | AgentStatus::Interrupted => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::native::multi_agent::AgentPath;

    #[test]
    fn activity_summary_deduplicates_senders() {
        let sender = AgentPath::try_from("/root/worker").expect("path should be valid");
        let summary = activity_summary(&[
            MailboxActivity::Message {
                sender: sender.clone(),
            },
            MailboxActivity::Message { sender },
        ]);
        assert_eq!(summary, "Mailbox updates are available from /root/worker.");
    }

    #[test]
    fn steered_input_takes_precedence_in_wait_summary() {
        assert_eq!(
            activity_summary(&[MailboxActivity::Steer]),
            "Wait interrupted by new input."
        );
    }

    #[test]
    fn full_history_fork_contract_rejects_overrides() {
        assert!(ForkTurns::All.inherits_full_history());
        assert!(!ForkTurns::Last(1).inherits_full_history());
        assert_eq!(crate::engine::ReasoningEffort::Ultra.as_str(), "ultra");
    }

    #[test]
    fn completion_messages_use_the_dedicated_official_content_kind() {
        let item = message_item(&InterAgentMessage {
            message_type: InterAgentMessageType::FinalAnswer,
            task_name: AgentPath::root(),
            sender: AgentPath::try_from("/root/worker").expect("agent path should be valid"),
            payload: "done".into(),
        });
        let encoded = serde_json::to_value(item).expect("completion message should encode");

        assert_eq!(encoded["role"], "assistant");
        assert_eq!(
            encoded["internal_chat_message_metadata_passthrough"]["content_item_kinds"][0],
            "multi_agent.inter_agent_completion_message"
        );
    }
}
