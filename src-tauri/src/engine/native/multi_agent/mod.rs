mod control;
mod manager;
mod path;
mod prompt;
mod types;

pub(super) use control::{
    deliver_completion, followup_task, interrupt_agent, list_agents, send_message, spawn_agent,
    wait_agent,
};
pub(super) use manager::{MultiAgentManager, WaitOutcome};
pub(super) use path::AgentPath;
pub(super) use prompt::{MultiAgentPromptContext, compose as compose_prompt_context};
pub(super) use types::{
    AgentIdentity, AgentInvocationContext, AgentMessageState, AgentStatus, AgentThreadDraft,
    DEFAULT_WAIT_TIMEOUT_MS, ForkTurns, InterAgentMessage, InterAgentMessageType,
    InterruptAgentArgs, ListAgentsArgs, ListedAgent, MAX_AGENT_MESSAGE_BYTES,
    MAX_AGENT_THREADS_PER_TREE, MAX_CONCURRENT_AGENTS, MAX_WAIT_TIMEOUT_MS, MIN_WAIT_TIMEOUT_MS,
    MailboxActivity, MessageAgentArgs, MultiAgentVersion, SpawnAgentArgs, WaitAgentArgs,
};
