use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use tokio::sync::{oneshot, watch};

use super::types::{CellId, CodeModeError, RuntimeResponse};

pub(super) type CellResponseFuture =
    Pin<Box<dyn Future<Output = Result<RuntimeResponse, CodeModeError>> + Send + 'static>>;

pub(super) struct CellState {
    cell_id: CellId,
    phase: Mutex<CellPhase>,
    cancellation: watch::Sender<bool>,
}

enum CellPhase {
    Running,
    Terminating {
        response: Option<oneshot::Sender<Result<RuntimeResponse, CodeModeError>>>,
    },
    Completed(RuntimeResponse),
    CompletionClaimed(RuntimeResponse),
    Tombstone,
}

pub(super) enum CompletionCommit {
    Committed,
    Rejected(RuntimeResponse),
}

pub(super) enum CompletionDelivery {
    Delivered,
    Buffered,
    Rejected(Option<oneshot::Sender<Result<RuntimeResponse, CodeModeError>>>),
}

pub(super) enum ObservationDelivery {
    Running(oneshot::Sender<Result<RuntimeResponse, CodeModeError>>),
    Delivered,
    Buffered,
    Closed,
}

impl CellState {
    pub fn new(cell_id: CellId) -> Arc<Self> {
        let (cancellation, _receiver) = watch::channel(false);
        Arc::new(Self {
            cell_id,
            phase: Mutex::new(CellPhase::Running),
            cancellation,
        })
    }

    pub fn subscribe(&self) -> watch::Receiver<bool> {
        self.cancellation.subscribe()
    }

    pub fn request_termination(&self) -> CellResponseFuture {
        let mut phase = self.lock_phase();
        match std::mem::replace(&mut *phase, CellPhase::Tombstone) {
            CellPhase::Running => {
                let (response, receiver) = oneshot::channel();
                *phase = CellPhase::Terminating {
                    response: Some(response),
                };
                self.cancellation.send_replace(true);
                let cell_id = self.cell_id.clone();
                Box::pin(async move {
                    receiver
                        .await
                        .unwrap_or(Err(CodeModeError::MissingCell(cell_id)))
                })
            }
            CellPhase::Terminating { response } => {
                *phase = CellPhase::Terminating { response };
                let cell_id = self.cell_id.clone();
                Box::pin(async move { Err(CodeModeError::TerminatingCell(cell_id)) })
            }
            CellPhase::Completed(response) => {
                *phase = CellPhase::CompletionClaimed(response.clone());
                self.cancellation.send_replace(true);
                Box::pin(async move { Ok(response) })
            }
            CellPhase::CompletionClaimed(response) => {
                *phase = CellPhase::CompletionClaimed(response);
                let cell_id = self.cell_id.clone();
                Box::pin(async move { Err(CodeModeError::TerminatingCell(cell_id)) })
            }
            CellPhase::Tombstone => {
                *phase = CellPhase::Tombstone;
                let cell_id = self.cell_id.clone();
                Box::pin(async move { Err(CodeModeError::MissingCell(cell_id)) })
            }
        }
    }

    pub fn cancel(&self) {
        let mut phase = self.lock_phase();
        match std::mem::replace(&mut *phase, CellPhase::Tombstone) {
            CellPhase::Running => {
                *phase = CellPhase::Terminating { response: None };
                self.cancellation.send_replace(true);
            }
            CellPhase::Completed(response) => {
                *phase = CellPhase::CompletionClaimed(response);
                self.cancellation.send_replace(true);
            }
            previous => *phase = previous,
        }
    }

    pub fn commit_completion(
        &self,
        response: RuntimeResponse,
        commit: impl FnOnce(),
    ) -> CompletionCommit {
        let mut phase = self.lock_phase();
        if !matches!(*phase, CellPhase::Running) || *self.cancellation.borrow() {
            return CompletionCommit::Rejected(response);
        }
        commit();
        *phase = CellPhase::Completed(response);
        CompletionCommit::Committed
    }

    pub fn deliver_completion(
        &self,
        observer: Option<oneshot::Sender<Result<RuntimeResponse, CodeModeError>>>,
    ) -> CompletionDelivery {
        let mut phase = self.lock_phase();
        let response = match std::mem::replace(&mut *phase, CellPhase::Tombstone) {
            CellPhase::Completed(response) => response,
            previous => {
                *phase = previous;
                return CompletionDelivery::Rejected(observer);
            }
        };
        let Some(observer) = observer else {
            *phase = CellPhase::Completed(response);
            return CompletionDelivery::Buffered;
        };
        match observer.send(Ok(response)) {
            Ok(()) => {
                self.cancellation.send_replace(true);
                CompletionDelivery::Delivered
            }
            Err(Ok(response)) => {
                *phase = CellPhase::Completed(response);
                CompletionDelivery::Buffered
            }
            Err(Err(error)) => {
                panic!("completion delivery unexpectedly carried an actor error: {error}")
            }
        }
    }

    pub fn route_observation(
        &self,
        observer: oneshot::Sender<Result<RuntimeResponse, CodeModeError>>,
    ) -> ObservationDelivery {
        let mut phase = self.lock_phase();
        match std::mem::replace(&mut *phase, CellPhase::Tombstone) {
            CellPhase::Running => {
                *phase = CellPhase::Running;
                ObservationDelivery::Running(observer)
            }
            CellPhase::Completed(response) => match observer.send(Ok(response)) {
                Ok(()) => {
                    self.cancellation.send_replace(true);
                    ObservationDelivery::Delivered
                }
                Err(Ok(response)) => {
                    *phase = CellPhase::Completed(response);
                    ObservationDelivery::Buffered
                }
                Err(Err(error)) => {
                    panic!("observation delivery unexpectedly carried an actor error: {error}")
                }
            },
            CellPhase::Terminating { response } => {
                *phase = CellPhase::Terminating { response };
                let _ = observer.send(Err(CodeModeError::TerminatingCell(self.cell_id.clone())));
                ObservationDelivery::Closed
            }
            CellPhase::CompletionClaimed(response) => {
                *phase = CellPhase::CompletionClaimed(response);
                let _ = observer.send(Err(CodeModeError::TerminatingCell(self.cell_id.clone())));
                ObservationDelivery::Closed
            }
            CellPhase::Tombstone => {
                *phase = CellPhase::Tombstone;
                let _ = observer.send(Err(CodeModeError::MissingCell(self.cell_id.clone())));
                ObservationDelivery::Closed
            }
        }
    }

    pub fn finish_termination(&self, response: RuntimeResponse) -> Option<RuntimeResponse> {
        let mut phase = self.lock_phase();
        let observer_response = match std::mem::replace(&mut *phase, CellPhase::Tombstone) {
            CellPhase::Running => Some(response),
            CellPhase::Terminating {
                response: termination,
            } => {
                if let Some(termination) = termination {
                    let _ = termination.send(Ok(response.clone()));
                }
                Some(response)
            }
            CellPhase::Completed(completed) | CellPhase::CompletionClaimed(completed) => {
                Some(completed)
            }
            CellPhase::Tombstone => None,
        };
        self.cancellation.send_replace(true);
        observer_response
    }

    pub fn tombstone(&self) {
        *self.lock_phase() = CellPhase::Tombstone;
        self.cancellation.send_replace(true);
    }

    fn lock_phase(&self) -> std::sync::MutexGuard<'_, CellPhase> {
        self.phase
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::*;

    fn completed(cell_id: &CellId) -> RuntimeResponse {
        RuntimeResponse::Completed {
            cell_id: cell_id.clone(),
            content: Vec::new(),
            error: None,
        }
    }

    #[tokio::test]
    async fn termination_is_the_linearization_point_before_store_commit() {
        let cell_id = CellId::allocated(1);
        let state = CellState::new(cell_id.clone());
        let termination = state.request_termination();
        let committed = AtomicBool::new(false);

        assert!(matches!(
            state.commit_completion(completed(&cell_id), || {
                committed.store(true, Ordering::Release);
            }),
            CompletionCommit::Rejected(_)
        ));
        assert!(!committed.load(Ordering::Acquire));

        let terminated = RuntimeResponse::Terminated {
            cell_id,
            content: Vec::new(),
        };
        assert!(state.finish_termination(terminated.clone()).is_some());
        assert!(matches!(
            termination.await.expect("termination should resolve"),
            RuntimeResponse::Terminated { .. }
        ));
    }

    #[tokio::test]
    async fn published_completion_wins_a_later_termination() {
        let cell_id = CellId::allocated(1);
        let state = CellState::new(cell_id.clone());
        let completion = completed(&cell_id);
        assert!(matches!(
            state.commit_completion(completion.clone(), || {}),
            CompletionCommit::Committed
        ));

        assert!(matches!(
            state
                .request_termination()
                .await
                .expect("published completion should be returned"),
            RuntimeResponse::Completed { .. }
        ));
        assert!(matches!(
            state
                .finish_termination(RuntimeResponse::Terminated {
                    cell_id,
                    content: Vec::new(),
                })
                .expect("completion should remain observable"),
            RuntimeResponse::Completed { .. }
        ));
    }
}
