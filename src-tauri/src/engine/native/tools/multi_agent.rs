use serde_json::{Value, json};
use tokio::sync::watch;

use super::{
    PreparedTool, ToolExecutionContext, ToolExecutionResult, decode_arguments, function_tool,
};
use crate::engine::ActivityStatus;
use crate::engine::CodexModel;
use crate::engine::native::multi_agent::{
    InterruptAgentArgs, ListAgentsArgs, MessageAgentArgs, SpawnAgentArgs, WaitAgentArgs,
    followup_task, interrupt_agent, list_agents, send_message, spawn_agent, wait_agent,
};
use crate::error::AppError;

#[derive(Debug)]
pub(super) enum Operation {
    Spawn(SpawnAgentArgs),
    SendMessage(MessageAgentArgs),
    FollowupTask(MessageAgentArgs),
    Interrupt(InterruptAgentArgs),
    List(ListAgentsArgs),
    Wait(WaitAgentArgs),
}

const MAX_MODEL_OVERRIDES_IN_DESCRIPTION: usize = 5;

pub(super) fn definitions(available_models: &[CodexModel]) -> Vec<Value> {
    vec![
        function_tool(
            "spawn_agent",
            spawn_agent_description(available_models),
            json!({
                "type": "object",
                "properties": {
                    "message": {
                        "type": "string",
                        "description": "Initial plain-text task for the new agent."
                    },
                    "task_name": {
                        "type": "string",
                        "description": "Task name using lowercase letters, digits, and underscores."
                    },
                    "fork_turns": {
                        "type": ["string", "null"],
                        "description": "History to inherit: `none`, `all`, or a positive integer string. Use null for the `all` default."
                    },
                    "model": {
                        "type": ["string", "null"],
                        "description": "Model override, or null to inherit the parent model."
                    },
                    "reasoning_effort": {
                        "type": ["string", "null"],
                        "enum": ["minimal", "low", "medium", "high", "xhigh", "max", "ultra", null],
                        "description": "Reasoning-effort override, or null to inherit the parent effort."
                    }
                },
                "required": ["message", "task_name", "fork_turns", "model", "reasoning_effort"],
                "additionalProperties": false
            }),
        ),
        function_tool(
            "send_message",
            "Send a message to an existing agent. It is delivered promptly but does not trigger a new turn.",
            message_parameters("Message text to queue on the target agent."),
        ),
        function_tool(
            "followup_task",
            "Send a follow-up task to an existing non-root agent. It starts an idle agent or reaches a running agent at a safe message boundary.",
            message_parameters("Follow-up task text for the target agent."),
        ),
        function_tool(
            "interrupt_agent",
            "Interrupt an agent's current turn and return its previous status. The agent remains available for messages and follow-up tasks.",
            json!({
                "type": "object",
                "properties": {
                    "target": {
                        "type": "string",
                        "description": "Relative or canonical task name to interrupt."
                    }
                },
                "required": ["target"],
                "additionalProperties": false
            }),
        ),
        function_tool(
            "list_agents",
            "List live agents in the current root thread tree, optionally filtered by task-path prefix.",
            json!({
                "type": "object",
                "properties": {
                    "path_prefix": {
                        "type": ["string", "null"],
                        "description": "Task-path prefix without a trailing slash, or null to list all agents."
                    }
                },
                "required": ["path_prefix"],
                "additionalProperties": false
            }),
        ),
        function_tool(
            "wait_agent",
            "Wait for mailbox activity, a final-status notification, steered user input, or timeout. The call is cancellation-aware and does not return message content.",
            json!({
                "type": "object",
                "properties": {
                    "timeout_ms": {
                        "type": ["integer", "null"],
                        "minimum": 10000,
                        "maximum": 3600000,
                        "description": "Timeout in milliseconds, or null for the 30000 ms default."
                    }
                },
                "required": ["timeout_ms"],
                "additionalProperties": false
            }),
        ),
    ]
}

pub(super) fn prepare(
    name: &str,
    arguments: &str,
) -> Option<Result<(&'static str, String, Operation), AppError>> {
    let prepared = match name {
        "spawn_agent" => decode_arguments::<SpawnAgentArgs>(name, arguments).map(|args| {
            let description = format!("Spawn agent {}", args.task_name);
            ("spawn_agent", description, Operation::Spawn(args))
        }),
        "send_message" => decode_arguments::<MessageAgentArgs>(name, arguments).map(|args| {
            let description = format!("Message agent {}", args.target);
            ("send_message", description, Operation::SendMessage(args))
        }),
        "followup_task" => decode_arguments::<MessageAgentArgs>(name, arguments).map(|args| {
            let description = format!("Continue agent {}", args.target);
            ("followup_task", description, Operation::FollowupTask(args))
        }),
        "interrupt_agent" => decode_arguments::<InterruptAgentArgs>(name, arguments).map(|args| {
            let description = format!("Interrupt agent {}", args.target);
            ("interrupt_agent", description, Operation::Interrupt(args))
        }),
        "list_agents" => decode_arguments::<ListAgentsArgs>(name, arguments)
            .map(|args| ("list_agents", "List agents".into(), Operation::List(args))),
        "wait_agent" => decode_arguments::<WaitAgentArgs>(name, arguments).map(|args| {
            (
                "wait_agent",
                "Wait for agents".into(),
                Operation::Wait(args),
            )
        }),
        _ => return None,
    };
    Some(prepared)
}

pub(super) async fn execute(
    prepared: &PreparedTool,
    operation: &Operation,
    context: &ToolExecutionContext<'_>,
    cancellation: &mut watch::Receiver<bool>,
) -> Result<ToolExecutionResult, AppError> {
    let inner = context.engine.upgrade().ok_or_else(|| {
        AppError::State("native engine stopped during multi-agent execution".into())
    })?;
    let value = match operation {
        Operation::Spawn(args) => {
            spawn_agent(
                &inner,
                context.app,
                context.agent,
                context.provider_call_id,
                args.clone(),
                cancellation,
            )
            .await?
        }
        Operation::SendMessage(args) => send_message(&inner, context.agent, args.clone()).await?,
        Operation::FollowupTask(args) => {
            followup_task(
                &inner,
                context.app,
                context.agent,
                args.clone(),
                cancellation,
            )
            .await?
        }
        Operation::Interrupt(args) => {
            interrupt_agent(
                &inner,
                context.agent,
                InterruptAgentArgs {
                    target: args.target.clone(),
                },
            )
            .await?
        }
        Operation::List(args) => {
            list_agents(
                &inner,
                context.agent,
                ListAgentsArgs {
                    path_prefix: args.path_prefix.clone(),
                },
            )
            .await?
        }
        Operation::Wait(args) => {
            wait_agent(
                &inner,
                context.agent,
                WaitAgentArgs {
                    timeout_ms: args.timeout_ms,
                },
                cancellation,
            )
            .await?
        }
    };
    let output = serde_json::to_string(&value).map_err(|error| {
        AppError::State(format!("multi-agent output could not be encoded: {error}"))
    })?;
    Ok(prepared.result_with_output(
        context.workspace,
        ActivityStatus::Completed,
        output,
        None,
        None,
    ))
}

fn message_parameters(description: &'static str) -> Value {
    json!({
        "type": "object",
        "properties": {
            "target": {
                "type": "string",
                "description": "Relative or canonical target task name."
            },
            "message": {
                "type": "string",
                "description": description
            }
        },
        "required": ["target", "message"],
        "additionalProperties": false
    })
}

fn spawn_agent_description(available_models: &[CodexModel]) -> String {
    let models = available_models_description(available_models);
    format!(
        "{models}\n\nSpawns an agent to work on the specified task. If the current task is `/root/task1` and it spawns `task_3`, the canonical task name is `/root/task1/task_3`; `task_3` and the canonical name can both address it from the parent. Agents in another branch must use the canonical name.\n\nSpawned agents inherit the current model and reasoning effort by default. Set `model` and `reasoning_effort` to null unless an explicit override is needed.\n\nOnly call this tool for a concrete, bounded subtask that can run independently alongside useful local work. The spawned agent shares the workspace, has the same tools, can spawn subagents, and returns its final answer to the parent.\n\n`fork_turns=\"none\"` passes no surrounding context. `fork_turns=null` or `fork_turns=\"all\"` passes the full completed history."
    )
}

fn available_models_description(available_models: &[CodexModel]) -> String {
    let models = available_models
        .iter()
        .filter(|model| !model.hidden)
        .take(MAX_MODEL_OVERRIDES_IN_DESCRIPTION)
        .map(|model| {
            let efforts = model
                .supported_reasoning_efforts
                .iter()
                .map(|option| {
                    let effort = option.reasoning_effort.as_str();
                    if Some(option.reasoning_effort) == model.default_reasoning_effort {
                        format!("{effort} (default)")
                    } else {
                        effort.to_string()
                    }
                })
                .collect::<Vec<_>>()
                .join(", ");
            let efforts = if efforts.is_empty() {
                String::new()
            } else {
                format!(" Reasoning efforts: {efforts}.")
            };
            let service_tiers = model
                .service_tiers
                .iter()
                .map(|tier| tier.id.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            let service_tiers = if service_tiers.is_empty() {
                String::new()
            } else {
                format!(" Service tiers: {service_tiers}.")
            };
            let description = model.description.as_deref().unwrap_or(&model.display_name);
            format!("- `{}`: {description}{efforts}{service_tiers}", model.id)
        })
        .collect::<Vec<_>>();
    if models.is_empty() {
        "No picker-visible model overrides are currently loaded.".into()
    } else {
        format!(
            "Available model overrides (optional; inherited parent model is preferred):\n{}",
            models.join("\n")
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::{
        ModelRuntimeCapability, ModelServiceTier, ReasoningEffort, ReasoningEffortOption,
    };

    #[test]
    fn catalog_exposes_the_complete_v2_surface() {
        let names = definitions(&[])
            .into_iter()
            .map(|definition| definition["name"].as_str().unwrap().to_string())
            .collect::<Vec<_>>();
        assert_eq!(
            names,
            [
                "spawn_agent",
                "send_message",
                "followup_task",
                "interrupt_agent",
                "list_agents",
                "wait_agent"
            ]
        );
    }

    #[test]
    fn unknown_tools_are_not_claimed() {
        assert!(prepare("read_file", "{}").is_none());
    }

    #[test]
    fn spawn_description_lists_valid_model_and_effort_overrides() {
        let model = CodexModel {
            id: "gpt-test".into(),
            model: "gpt-test".into(),
            display_name: "GPT Test".into(),
            description: Some("Focused test model.".into()),
            hidden: false,
            supported_reasoning_efforts: vec![
                ReasoningEffortOption {
                    reasoning_effort: ReasoningEffort::Low,
                    description: "Fast".into(),
                },
                ReasoningEffortOption {
                    reasoning_effort: ReasoningEffort::High,
                    description: "Deep".into(),
                },
            ],
            default_reasoning_effort: Some(ReasoningEffort::High),
            service_tiers: vec![ModelServiceTier {
                id: "priority".into(),
                name: "Priority".into(),
                description: "Priority processing".into(),
            }],
            default_service_tier: Some("priority".into()),
            context_window: None,
            unsupported_runtime_capabilities: Vec::<ModelRuntimeCapability>::new(),
            unsupported_reasoning_efforts: Vec::new(),
            is_default: true,
        };

        let description = definitions(&[model])[0]["description"]
            .as_str()
            .expect("spawn description should be text")
            .to_string();

        assert!(description.contains("`gpt-test`: Focused test model."));
        assert!(description.contains("low, high (default)"));
        assert!(description.contains("Service tiers: priority."));
        assert!(description.contains("inherited parent model is preferred"));
    }
}
