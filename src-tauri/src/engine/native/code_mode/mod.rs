use std::collections::HashMap;

use tokio::sync::Mutex;

mod cell_state;
mod description;
mod runtime;
mod schema_types;
mod session;
mod spec;
mod types;

#[cfg(test)]
mod tests;

pub(super) use session::CodeModeSession;
pub(super) use spec::ParsedExecSource;
pub(super) use spec::exec_definition;
pub(super) use spec::parse_exec_source;
pub(super) use spec::wait_definition;
pub(super) use types::CellId;
pub(super) use types::DEFAULT_MAX_OUTPUT_TOKENS;
pub(super) use types::DEFAULT_WAIT_YIELD_TIME_MS;
pub(super) use types::DelegateFuture;
pub(super) use types::ExecuteRequest;
pub(super) use types::MAX_RESPONSE_TOKEN_BUDGET;
pub(super) use types::MAX_YIELD_TIME_MS;
pub(super) use types::NestedToolCall;
pub(super) use types::RuntimeResponse;
pub(super) use types::ToolDefinition;
pub(super) use types::ToolDelegate;
pub(super) use types::ToolKind;

#[derive(Default)]
pub(super) struct CodeModeSessionRegistry {
    sessions: Mutex<HashMap<String, CodeModeSession>>,
}

impl CodeModeSessionRegistry {
    pub async fn session(&self, thread_id: &str) -> CodeModeSession {
        self.sessions
            .lock()
            .await
            .entry(thread_id.to_string())
            .or_insert_with(CodeModeSession::new)
            .clone()
    }

    pub async fn close(&self, thread_id: &str) {
        let session = self.sessions.lock().await.remove(thread_id);
        if let Some(session) = session {
            session.shutdown().await;
        }
    }

    pub async fn shutdown(&self) {
        let sessions = std::mem::take(&mut *self.sessions.lock().await);
        for session in sessions.into_values() {
            session.shutdown().await;
        }
    }
}
