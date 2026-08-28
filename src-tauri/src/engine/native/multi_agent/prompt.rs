use super::types::{AgentIdentity, MAX_CONCURRENT_AGENTS};
use crate::engine::ReasoningEffort;
use crate::engine::native::provider::SelectedModel;

const DEFAULT_ROOT_USAGE_HINT: &str = r#"You are `/root`, the primary agent in a team of agents collaborating to fulfill the user's goals.

At the start of your turn, you are the active agent.
You can spawn sub-agents to handle subtasks, and those sub-agents can spawn their own sub-agents.
All agents in the team, including the agents that you can assign tasks to, are equally intelligent and capable, and have access to the same set of tools.

You can use `spawn_agent` to create a new agent, `followup_task` to give an existing agent a new task and trigger a turn, and `send_message` to pass a message to a running agent without triggering a turn.
Child agents can also spawn their own sub-agents.
You can decide how much context you want to propagate to your sub-agents with the `fork_turns` parameter.

You will receive messages in the analysis channel in the form:
```
Message Type: MESSAGE | FINAL_ANSWER
Task name: <recipient>
Sender: <author>
Payload:
<payload text>
```
They may be addressed as to=/root
"#;

const DEFAULT_SUBAGENT_USAGE_HINT: &str = r#"You are an agent in a team of agents collaborating to complete a task.

You can spawn sub-agents to handle subtasks, and those sub-agents can spawn their own sub-agents. All agents in the team, including the agents that you can assign tasks to, are equally intelligent and capable, and have access to the same set of tools.

You can use `spawn_agent` to create a new agent, `followup_task` to give an existing agent a new task and trigger a turn, and `send_message` to pass a message to a running agent.
Child agents can also spawn their own sub-agents.

When you provide a response in the final channel, that content is immediately delivered back to your parent agent.

You will receive messages in the analysis channel in the form:
```
Message Type: NEW_TASK | MESSAGE | FINAL_ANSWER
Task name: <recipient>
Sender: <author>
Payload:
<payload text>
```
You may also see them addressed as to=/root/..., which indicates your identity is /root/...
"#;

const SHARED_USAGE_HINT: &str = r#"Collaboration tools cannot be called from inside the Code Mode `exec` tool. Call `spawn_agent`, `send_message`, `followup_task`, `wait_agent`, `interrupt_agent`, and `list_agents` only as direct tool calls; they are intentionally absent from the nested Code Mode tool catalog.

All agents share the same directory. In detail:
- All agents have access to the same container and filesystem as you.
- All agents use the same current working directory.
- As a result, edits made by one agent are immediately visible to all other agents.

When calling `wait_agent`, prefer longer waits (minutes) to avoid busy polling."#;

const MODEL_OVERRIDE_HINT: &str = "Full-history forks (`fork_turns` omitted or `\"all\"`) inherit the parent model and reasoning effort and do not accept overrides. Only set `model` or `reasoning_effort` when explicitly requested by the user, applicable `AGENTS.md` instructions, or skill instructions; when doing so, set `fork_turns` to `\"none\"` or a positive integer string.";

const EXPLICIT_REQUEST_ONLY_MODE: &str = "Any earlier instruction enabling proactive multi-agent delegation no longer applies. Do not spawn sub-agents unless the user or applicable AGENTS.md/skill instructions explicitly ask for sub-agents, delegation, or parallel agent work.";

const PROACTIVE_MODE: &str = "Proactive multi-agent delegation is active. Any earlier developer instruction requiring an explicit user request before spawning sub-agents no longer applies. This mode remains active until a later multi-agent mode developer message changes it. User requests override this hint.\n\nIf any point you can parallelize work by delegating tasks to another agent (no matter if you are root or subagent), you should do so using collaboration tools if it could save time or improve quality.";

pub(in crate::engine::native) struct MultiAgentPromptContext {
    role_instructions: Option<MultiAgentRoleInstructions>,
    pub mode_instructions: Option<String>,
}

struct MultiAgentRoleInstructions {
    text: String,
    source: MultiAgentRoleSource,
}

#[derive(Clone, Copy)]
enum MultiAgentRoleSource {
    Bundled,
    Catalog,
}

impl MultiAgentPromptContext {
    pub fn rendered_role_instructions(&self) -> Option<String> {
        self.role_instructions
            .as_ref()
            .map(|instructions| match instructions.source {
                MultiAgentRoleSource::Bundled => instructions.text.clone(),
                MultiAgentRoleSource::Catalog => {
                    format!("<multi_agent_role>{}</multi_agent_role>", instructions.text)
                }
            })
    }
}

pub(in crate::engine::native) fn compose(
    identity: &AgentIdentity,
    model: &SelectedModel,
    effort: Option<ReasoningEffort>,
) -> MultiAgentPromptContext {
    let catalog_role = if identity.path.is_root() {
        model.multi_agent_root_instructions()
    } else {
        model.multi_agent_subagent_instructions()
    };
    let fallback_role = if identity.path.is_root() {
        DEFAULT_ROOT_USAGE_HINT
    } else {
        DEFAULT_SUBAGENT_USAGE_HINT
    };
    let role_instructions = match catalog_role {
        Some("") => None,
        Some(role) => Some((role, MultiAgentRoleSource::Catalog)),
        None => Some((fallback_role, MultiAgentRoleSource::Bundled)),
    }
    .map(|(role, source)| MultiAgentRoleInstructions {
        text: format!(
            "{role}\n\n{SHARED_USAGE_HINT}\n\nThere are {MAX_CONCURRENT_AGENTS} available concurrency slots, meaning that up to {MAX_CONCURRENT_AGENTS} agents can be active at once, including you.\n\n{MODEL_OVERRIDE_HINT}"
        ),
        source,
    });

    let mode_instructions = match model.multi_agent_mode_hint() {
        Some(custom) => (!custom.is_empty()).then(|| custom.to_string()),
        None if effort == Some(ReasoningEffort::Ultra) => Some(PROACTIVE_MODE.to_string()),
        None => model
            .multi_agent_explicit_mode_instructions()
            .map(str::to_string)
            .or_else(|| Some(EXPLICIT_REQUEST_ONLY_MODE.to_string())),
    };

    MultiAgentPromptContext {
        role_instructions,
        mode_instructions,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::native::provider::{ModelCatalog, ModelsWire};

    fn model(messages: &str) -> SelectedModel {
        let wire: ModelsWire = serde_json::from_str(&format!(
            r#"{{
                "models": [{{
                    "slug": "gpt-test",
                    "display_name": "GPT Test",
                    "description": null,
                    "supported_reasoning_levels": [
                        {{"effort": "max", "description": "Max"}},
                        {{"effort": "ultra", "description": "Ultra"}}
                    ],
                    "visibility": "list",
                    "priority": 0,
                    "service_tiers": [],
                    "default_service_tier": null,
                    "multi_agent_version": "v2",
                    "base_instructions": "Base",
                    "model_messages": {messages}
                }}]
            }}"#
        ))
        .expect("fixture should decode");
        ModelCatalog::from_wire(wire, 1)
            .expect("fixture should validate")
            .select(None)
            .expect("model should resolve")
    }

    #[test]
    fn ultra_enables_proactive_mode_without_overriding_catalog_roles() {
        let model = model(
            r#"{
                "instructions_template": "Base",
                "multi_agent": {
                    "role": {"root": "Catalog root", "subagent": "Catalog child"},
                    "mode": {"explicit": null, "hint_text": null}
                }
            }"#,
        );
        let context = compose(
            &AgentIdentity::root("root-thread"),
            &model,
            Some(ReasoningEffort::Ultra),
        );
        assert_eq!(
            context.rendered_role_instructions().as_deref(),
            Some(
                "<multi_agent_role>Catalog root\n\nCollaboration tools cannot be called from inside the Code Mode `exec` tool. Call `spawn_agent`, `send_message`, `followup_task`, `wait_agent`, `interrupt_agent`, and `list_agents` only as direct tool calls; they are intentionally absent from the nested Code Mode tool catalog.\n\nAll agents share the same directory. In detail:\n- All agents have access to the same container and filesystem as you.\n- All agents use the same current working directory.\n- As a result, edits made by one agent are immediately visible to all other agents.\n\nWhen calling `wait_agent`, prefer longer waits (minutes) to avoid busy polling.\n\nThere are 4 available concurrency slots, meaning that up to 4 agents can be active at once, including you.\n\nFull-history forks (`fork_turns` omitted or `\"all\"`) inherit the parent model and reasoning effort and do not accept overrides. Only set `model` or `reasoning_effort` when explicitly requested by the user, applicable `AGENTS.md` instructions, or skill instructions; when doing so, set `fork_turns` to `\"none\"` or a positive integer string.</multi_agent_role>"
            )
        );
        assert!(
            context
                .mode_instructions
                .as_deref()
                .is_some_and(|message| message.contains("Proactive"))
        );
    }

    #[test]
    fn empty_catalog_mode_suppresses_local_fallback() {
        let model = model(
            r#"{
                "instructions_template": "Base",
                "multi_agent": {
                    "role": {"root": null, "subagent": null},
                    "mode": {"explicit": null, "hint_text": ""}
                }
            }"#,
        );
        let context = compose(
            &AgentIdentity::root("root-thread"),
            &model,
            Some(ReasoningEffort::Ultra),
        );
        assert_eq!(context.mode_instructions, None);
    }

    #[test]
    fn empty_catalog_role_suppresses_bundled_role_and_shared_hints() {
        let model = model(
            r#"{
                "instructions_template": "Base",
                "multi_agent": {
                    "role": {"root": "", "subagent": ""},
                    "mode": {"explicit": null, "hint_text": null}
                }
            }"#,
        );

        let context = compose(
            &AgentIdentity::root("root-thread"),
            &model,
            Some(ReasoningEffort::Ultra),
        );

        assert_eq!(context.rendered_role_instructions(), None);
    }
}
