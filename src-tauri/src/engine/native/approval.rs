use std::collections::{HashMap, HashSet};

use tauri::{AppHandle, Emitter as _};
use tokio::sync::{Mutex, oneshot, watch};
use uuid::Uuid;

use crate::engine::{
    ApprovalDecision, BrowserOriginApprovalRequest, CommandApprovalRequest, EngineServerRequest,
    OperationAck, SERVER_REQUEST_EVENT, ServerRequest, ServerResponse,
};
use crate::error::AppError;

#[derive(Debug, Default)]
pub struct ApprovalBroker {
    pending: Mutex<HashMap<String, oneshot::Sender<ApprovalDecision>>>,
    approved_command_threads: Mutex<HashSet<String>>,
}

impl ApprovalBroker {
    pub async fn request_command(
        &self,
        app: &AppHandle,
        request: CommandApprovalRequest,
        cancellation: &mut watch::Receiver<bool>,
    ) -> Result<ApprovalDecision, AppError> {
        if self
            .approved_command_threads
            .lock()
            .await
            .contains(&request.thread_id)
        {
            return Ok(ApprovalDecision::AcceptForSession);
        }
        let thread_id = request.thread_id.clone();
        let decision = self
            .request(app, ServerRequest::ApproveCommand(request), cancellation)
            .await?;
        if decision == ApprovalDecision::AcceptForSession {
            self.approved_command_threads.lock().await.insert(thread_id);
        }
        Ok(decision)
    }

    pub async fn request_browser_origin(
        &self,
        app: &AppHandle,
        request: BrowserOriginApprovalRequest,
        cancellation: &mut watch::Receiver<bool>,
    ) -> Result<ApprovalDecision, AppError> {
        self.request(
            app,
            ServerRequest::ApproveBrowserOrigin(request),
            cancellation,
        )
        .await
    }

    async fn request(
        &self,
        app: &AppHandle,
        request: ServerRequest,
        cancellation: &mut watch::Receiver<bool>,
    ) -> Result<ApprovalDecision, AppError> {
        let request_id = Uuid::now_v7().to_string();
        let (sender, receiver) = oneshot::channel();
        let previous = self.pending.lock().await.insert(request_id.clone(), sender);
        if previous.is_some() {
            return Err(AppError::State(
                "approval id collision prevented request registration".into(),
            ));
        }

        if let Err(error) = app.emit(
            SERVER_REQUEST_EVENT,
            EngineServerRequest {
                id: request_id.clone(),
                request,
            },
        ) {
            self.pending.lock().await.remove(&request_id);
            return Err(AppError::State(format!(
                "could not deliver approval request: {error}"
            )));
        }

        let result = tokio::select! {
            changed = cancellation.changed() => {
                match changed {
                    Ok(()) if *cancellation.borrow() => Err(AppError::Cancelled("turn was interrupted while awaiting approval".into())),
                    Ok(()) => Err(AppError::State("approval wait observed an invalid cancellation transition".into())),
                    Err(_) => Err(AppError::State("turn cancellation channel closed while awaiting approval".into())),
                }
            }
            result = receiver => {
                match result {
                    Ok(decision) => Ok(decision),
                    Err(_) => Err(AppError::State("approval request was closed without a decision".into())),
                }
            }
        };
        self.pending.lock().await.remove(&request_id);
        result
    }

    pub async fn respond(
        &self,
        request_id: String,
        response: ServerResponse,
    ) -> Result<OperationAck, AppError> {
        let sender = self
            .pending
            .lock()
            .await
            .remove(&request_id)
            .ok_or_else(|| AppError::State("approval request is no longer pending".into()))?;
        sender
            .send(response.decision)
            .map_err(|_| AppError::State("approval consumer is no longer active".into()))?;
        Ok(OperationAck { applied: true })
    }

    pub async fn cancel_all(&self) {
        let senders = self
            .pending
            .lock()
            .await
            .drain()
            .map(|(_, sender)| sender)
            .collect::<Vec<_>>();
        for sender in senders {
            let _decision_was_unobserved = sender.send(ApprovalDecision::Cancel);
        }
        self.approved_command_threads.lock().await.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::ApprovalBroker;
    use crate::engine::{ApprovalDecision, ServerResponse};

    #[tokio::test]
    async fn rejects_responses_for_unknown_requests() {
        let broker = ApprovalBroker::default();
        let result = broker
            .respond(
                "missing".into(),
                ServerResponse {
                    decision: ApprovalDecision::Accept,
                },
            )
            .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn command_session_approval_is_scoped_and_cleared() {
        let broker = ApprovalBroker::default();
        broker
            .approved_command_threads
            .lock()
            .await
            .insert("thread-a".into());

        assert!(
            broker
                .approved_command_threads
                .lock()
                .await
                .contains("thread-a")
        );
        assert!(
            !broker
                .approved_command_threads
                .lock()
                .await
                .contains("thread-b")
        );

        broker.cancel_all().await;
        assert!(broker.approved_command_threads.lock().await.is_empty());
    }
}
