use std::future::Future;
use std::pin::Pin;

use serde_json::Value;
use tokio::sync::watch;

use super::super::provider::FunctionCallOutputContent;

pub(crate) const DEFAULT_EXEC_YIELD_TIME_MS: u64 = 10_000;
pub(crate) const DEFAULT_WAIT_YIELD_TIME_MS: u64 = 10_000;
pub(crate) const DEFAULT_MAX_OUTPUT_TOKENS: usize = 10_000;
pub(crate) const MAX_YIELD_TIME_MS: u64 = 60_000;
pub(crate) const MAX_RESPONSE_TOKEN_BUDGET: usize = 1_000_000;
pub(super) const MAX_SOURCE_BYTES: usize = 1_048_576;
pub(super) const MAX_ENABLED_TOOLS: usize = 64;
pub(super) const MAX_ACTIVE_CELLS: usize = 8;
pub(super) const MAX_CELL_OUTPUT_BYTES: usize = 4 * 1_048_576;
pub(super) const MAX_CELL_OUTPUT_ITEMS: usize = 256;
pub(super) const MAX_STORED_VALUE_BYTES: usize = 1_048_576;
pub(super) const MAX_STORED_VALUE_ENTRIES: usize = 128;
pub(super) const MAX_CELL_RUNTIME_SECONDS: u64 = 10 * 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ToolKind {
    Function,
    Freeform,
}

#[derive(Debug, Clone)]
pub(crate) struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub kind: ToolKind,
    pub input_schema: Option<Value>,
    pub output_schema: Option<Value>,
}

#[derive(Debug)]
pub(crate) struct ExecuteRequest {
    pub call_id: String,
    pub enabled_tools: Vec<ToolDefinition>,
    pub source: String,
    pub yield_time_ms: u64,
    pub max_output_tokens: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct CellId(String);

impl CellId {
    pub fn new(value: String) -> Result<Self, CodeModeError> {
        if value.is_empty() || value.len() > 64 || value.chars().any(char::is_control) {
            return Err(CodeModeError::InvalidRequest(
                "exec cell id must contain between 1 and 64 bytes without control characters"
                    .into(),
            ));
        }
        Ok(Self(value))
    }

    pub fn allocated(value: u64) -> Self {
        Self(value.to_string())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for CellId {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[derive(Debug)]
pub(crate) struct NestedToolCall {
    pub cell_id: CellId,
    pub runtime_call_id: String,
    pub name: String,
    pub kind: ToolKind,
    pub input: Option<Value>,
}

pub(crate) type DelegateFuture<T> =
    Pin<Box<dyn Future<Output = Result<T, String>> + Send + 'static>>;

pub(crate) trait ToolDelegate: Send + Sync + 'static {
    fn invoke(
        &self,
        call: NestedToolCall,
        cancellation: watch::Receiver<bool>,
    ) -> DelegateFuture<Value>;

    fn notify(
        &self,
        call_id: String,
        cell_id: CellId,
        text: String,
        cancellation: watch::Receiver<bool>,
    ) -> DelegateFuture<()>;
}

#[derive(Debug, Clone)]
pub(crate) enum RuntimeResponse {
    Yielded {
        cell_id: CellId,
        content: Vec<FunctionCallOutputContent>,
    },
    Terminated {
        cell_id: CellId,
        content: Vec<FunctionCallOutputContent>,
    },
    Completed {
        cell_id: CellId,
        content: Vec<FunctionCallOutputContent>,
        error: Option<String>,
    },
}

impl RuntimeResponse {
    pub fn cell_id(&self) -> &CellId {
        match self {
            Self::Yielded { cell_id, .. }
            | Self::Terminated { cell_id, .. }
            | Self::Completed { cell_id, .. } => cell_id,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum CodeModeError {
    #[error("invalid Code Mode request: {0}")]
    InvalidRequest(String),
    #[error("Code Mode cell {0} does not exist")]
    MissingCell(CellId),
    #[error("Code Mode cell {0} already has an active observer")]
    BusyCell(CellId),
    #[error("Code Mode cell {0} is already terminating")]
    TerminatingCell(CellId),
    #[error("Code Mode runtime is shutting down")]
    ShuttingDown,
    #[error("Code Mode runtime failed: {0}")]
    Runtime(String),
}
