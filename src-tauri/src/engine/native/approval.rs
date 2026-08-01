use std::collections::HashMap;
use std::time::Duration;

use tauri::{AppHandle, Emitter as _};
use tokio::sync::{Mutex, oneshot, watch};
use uuid::Uuid;

use crate::engine::{
    ApprovalDecision, CommandApprovalRequest, EngineServerRequest, OperationAck,
    SERVER_REQUEST_EVENT, ServerRequest, ServerResponse,
};
use crate::error::AppError;

const APPROVAL_TIMEOUT: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Default)]
pub struct ApprovalBroker {
    pending: Mutex<HashMap<String, oneshot::Sender<ApprovalDecision>>>,
}

impl ApprovalBroker {
    pub async fn request_command(
        &self,
        app: &AppHandle,
        request: CommandApprovalRequest,
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
                request: ServerRequest::ApproveCommand(request),
            },
        ) {
            self.pending.lock().await.remove(&request_id);
            return Err(AppError::State(format!(
                "could not deliver command approval request: {error}"
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
            result = tokio::time::timeout(APPROVAL_TIMEOUT, receiver) => {
                match result {
                    Ok(Ok(decision)) => Ok(decision),
                    Ok(Err(_)) => Err(AppError::State("approval request was closed without a decision".into())),
                    Err(_) => Err(AppError::Timeout { operation: "command approval" }),
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
}
