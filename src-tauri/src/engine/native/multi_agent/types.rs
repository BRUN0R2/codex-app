use serde::{Deserialize, Serialize};

use super::path::AgentPath;
use crate::engine::ReasoningEffort;
use crate::error::AppError;

pub(in crate::engine::native) const MAX_CONCURRENT_AGENTS: usize = 4;
pub(in crate::engine::native) const MAX_AGENT_THREADS_PER_TREE: usize = 64;
pub(in crate::engine::native) const MIN_WAIT_TIMEOUT_MS: u64 = 10_000;
pub(in crate::engine::native) const DEFAULT_WAIT_TIMEOUT_MS: u64 = 30_000;
pub(in crate::engine::native) const MAX_WAIT_TIMEOUT_MS: u64 = 60 * 60 * 1_000;
pub(in crate::engine::native) const MAX_AGENT_MESSAGE_BYTES: usize = 1_048_576;
pub(in crate::engine::native) const MAX_FORK_TURNS: usize = 1_000;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(in crate::engine::native) enum MultiAgentVersion {
    #[default]
    Disabled,
    V1,
    V2,
}

impl MultiAgentVersion {
    pub fn is_supported(self) -> bool {
        matches!(self, Self::V2)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::engine::native) struct AgentIdentity {
    pub thread_id: String,
    pub root_thread_id: String,
    pub parent_thread_id: Option<String>,
    pub path: AgentPath,
    pub model: Option<String>,
    pub reasoning_effort: Option<ReasoningEffort>,
    pub service_tier: Option<String>,
}

#[derive(Debug, Clone)]
pub(in crate::engine::native) struct AgentThreadDraft {
    pub parent: AgentIdentity,
    pub path: AgentPath,
    pub task_name: String,
    pub initial_message: crate::engine::native::provider::ResponseItem,
    pub model: String,
    pub reasoning_effort: Option<ReasoningEffort>,
    pub service_tier: Option<String>,
    pub fork_turns: ForkTurns,
    pub parent_spawn_call_id: String,
    pub preview: String,
}

#[derive(Debug, Clone)]
pub(in crate::engine::native) struct AgentInvocationContext {
    pub thread_id: String,
    pub model: String,
    pub reasoning_effort: Option<ReasoningEffort>,
    pub service_tier: Option<String>,
    pub timezone: String,
    pub timezone_offset_min: i32,
}

impl AgentIdentity {
    pub fn root(thread_id: impl Into<String>) -> Self {
        let thread_id = thread_id.into();
        Self {
            root_thread_id: thread_id.clone(),
            thread_id,
            parent_thread_id: None,
            path: AgentPath::root(),
            model: None,
            reasoning_effort: None,
            service_tier: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::engine::native) enum ForkTurns {
    None,
    All,
    Last(usize),
}

impl ForkTurns {
    pub fn parse(value: Option<&str>) -> Result<Self, AppError> {
        let value = value
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("all");
        if value.eq_ignore_ascii_case("none") {
            return Ok(Self::None);
        }
        if value.eq_ignore_ascii_case("all") {
            return Ok(Self::All);
        }
        let turns = value.parse::<usize>().map_err(|_| {
            AppError::Tool("fork_turns must be `none`, `all`, or a positive integer string".into())
        })?;
        if !(1..=MAX_FORK_TURNS).contains(&turns) {
            return Err(AppError::Tool(format!(
                "fork_turns must contain between 1 and {MAX_FORK_TURNS} turns"
            )));
        }
        Ok(Self::Last(turns))
    }

    pub fn inherits_full_history(self) -> bool {
        matches!(self, Self::All)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(in crate::engine::native) enum AgentStatus {
    PendingInit,
    Running,
    Interrupted,
    Completed(Option<String>),
    Errored(String),
    Shutdown,
    NotFound,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(in crate::engine::native) struct ListedAgent {
    pub agent_name: String,
    pub agent_status: AgentStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::engine::native) enum InterAgentMessageType {
    Message,
    NewTask,
    FinalAnswer,
}

impl InterAgentMessageType {
    fn as_str(self) -> &'static str {
        match self {
            Self::Message => "MESSAGE",
            Self::NewTask => "NEW_TASK",
            Self::FinalAnswer => "FINAL_ANSWER",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::engine::native) struct InterAgentMessage {
    pub message_type: InterAgentMessageType,
    pub task_name: AgentPath,
    pub sender: AgentPath,
    pub payload: String,
}

impl InterAgentMessage {
    pub fn render(&self) -> String {
        format!(
            "Message Type: {}\nTask name: {}\nSender: {}\nPayload:\n{}",
            self.message_type.as_str(),
            self.task_name,
            self.sender,
            self.payload
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::engine::native) enum MailboxActivity {
    Message { sender: AgentPath },
    Steer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::engine::native) enum AgentMessageState {
    Missing,
    Pending,
    Delivered,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(in crate::engine::native) struct SpawnAgentArgs {
    pub message: String,
    pub task_name: String,
    pub fork_turns: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<ReasoningEffort>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(in crate::engine::native) struct MessageAgentArgs {
    pub target: String,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(in crate::engine::native) struct InterruptAgentArgs {
    pub target: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(in crate::engine::native) struct ListAgentsArgs {
    pub path_prefix: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(in crate::engine::native) struct WaitAgentArgs {
    pub timeout_ms: Option<u64>,
}

#[cfg(test)]
mod tests {
    use super::{ForkTurns, MAX_FORK_TURNS};

    #[test]
    fn fork_turns_accepts_only_bounded_explicit_modes() {
        assert_eq!(
            ForkTurns::parse(None).expect("default should parse"),
            ForkTurns::All
        );
        assert_eq!(
            ForkTurns::parse(Some("none")).expect("none should parse"),
            ForkTurns::None
        );
        assert_eq!(
            ForkTurns::parse(Some("3")).expect("count should parse"),
            ForkTurns::Last(3)
        );
        assert!(ForkTurns::parse(Some("0")).is_err());
        assert!(ForkTurns::parse(Some(&(MAX_FORK_TURNS + 1).to_string())).is_err());
    }
}
