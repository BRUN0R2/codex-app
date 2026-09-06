use std::sync::Mutex;

use tokio::sync::watch;

use crate::error::AppError;

#[derive(Clone, Debug)]
enum DesktopIntegrationStatus {
    Initializing,
    Ready,
    Failed(AppError),
}

#[derive(Debug)]
pub struct DesktopIntegrationLifecycle {
    completion: Mutex<()>,
    status: watch::Sender<DesktopIntegrationStatus>,
}

impl Default for DesktopIntegrationLifecycle {
    fn default() -> Self {
        let (status, _) = watch::channel(DesktopIntegrationStatus::Initializing);
        Self {
            completion: Mutex::new(()),
            status,
        }
    }
}

impl DesktopIntegrationLifecycle {
    pub async fn wait_until_ready(&self) -> Result<(), AppError> {
        let mut status = self.status.subscribe();
        loop {
            let current = status.borrow_and_update().clone();
            match current {
                DesktopIntegrationStatus::Initializing => status.changed().await.map_err(|_| {
                    AppError::State("desktop integration lifecycle is unavailable".into())
                })?,
                DesktopIntegrationStatus::Ready => return Ok(()),
                DesktopIntegrationStatus::Failed(error) => return Err(error),
            }
        }
    }

    pub fn finish(&self, initialization: &Result<(), AppError>) -> Result<(), AppError> {
        let _completion = self
            .completion
            .lock()
            .map_err(|_| AppError::State("desktop integration lifecycle is unavailable".into()))?;
        if !matches!(
            *self.status.borrow(),
            DesktopIntegrationStatus::Initializing
        ) {
            return Err(AppError::State(
                "desktop integration initialization was already completed".into(),
            ));
        }
        self.status.send_replace(match initialization {
            Ok(()) => DesktopIntegrationStatus::Ready,
            Err(error) => DesktopIntegrationStatus::Failed(error.clone()),
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::DesktopIntegrationLifecycle;
    use crate::error::AppError;

    #[tokio::test]
    async fn early_command_waits_for_successful_initialization() {
        let lifecycle = Arc::new(DesktopIntegrationLifecycle::default());
        let waiting_lifecycle = Arc::clone(&lifecycle);
        let waiter = tokio::spawn(async move { waiting_lifecycle.wait_until_ready().await });

        tokio::task::yield_now().await;
        assert!(!waiter.is_finished());

        lifecycle
            .finish(&Ok(()))
            .expect("initialization should complete");
        waiter
            .await
            .expect("waiter should finish")
            .expect("successful initialization should release the waiter");
    }

    #[tokio::test]
    async fn early_command_receives_the_original_initialization_failure() {
        let lifecycle = DesktopIntegrationLifecycle::default();
        lifecycle
            .finish(&Err(AppError::State("tray initialization failed".into())))
            .expect("failed initialization should be published");

        let error = lifecycle
            .wait_until_ready()
            .await
            .expect_err("failed initialization should reject waiting commands");

        assert_eq!(
            error.to_string(),
            "engine state is invalid: tray initialization failed"
        );
    }

    #[test]
    fn initialization_can_only_finish_once() {
        let lifecycle = DesktopIntegrationLifecycle::default();
        lifecycle
            .finish(&Ok(()))
            .expect("initialization should complete once");

        assert!(lifecycle.finish(&Ok(())).is_err());
    }
}
