use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{Mutex, RwLock, watch};

use super::path::AgentPath;
use super::types::{AgentIdentity, MailboxActivity};
use crate::engine::native::storage::NativeStorage;
use crate::error::AppError;

#[derive(Default)]
pub(in crate::engine::native) struct MultiAgentManager {
    identities: RwLock<HashMap<String, AgentIdentity>>,
    mailboxes: Mutex<HashMap<String, Mailbox>>,
    turn_settlements: Mutex<HashMap<String, watch::Sender<u64>>>,
    spawn_gates: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

struct Mailbox {
    events: VecDeque<MailboxActivity>,
    revision: u64,
    sender: watch::Sender<u64>,
}

impl Default for Mailbox {
    fn default() -> Self {
        let (sender, _receiver) = watch::channel(0);
        Self {
            events: VecDeque::new(),
            revision: 0,
            sender,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::engine::native) enum WaitOutcome {
    Activity(Vec<MailboxActivity>),
    TimedOut,
    Cancelled,
}

impl MultiAgentManager {
    pub async fn spawn_gate(&self, root_thread_id: &str) -> Arc<Mutex<()>> {
        self.spawn_gates
            .lock()
            .await
            .entry(root_thread_id.to_string())
            .or_default()
            .clone()
    }

    pub async fn identity(
        &self,
        storage: &NativeStorage,
        thread_id: &str,
    ) -> Result<AgentIdentity, AppError> {
        if let Some(identity) = self.identities.read().await.get(thread_id).cloned() {
            return Ok(identity);
        }
        let identity = storage
            .read_agent_identity(thread_id.to_string())
            .await?
            .unwrap_or_else(|| AgentIdentity::root(thread_id));
        self.identities
            .write()
            .await
            .insert(thread_id.to_string(), identity.clone());
        Ok(identity)
    }

    pub async fn register(&self, identity: AgentIdentity) {
        self.identities
            .write()
            .await
            .insert(identity.thread_id.clone(), identity);
    }

    pub async fn forget_tree(&self, root_thread_id: &str) {
        let forgotten_thread_ids = {
            let mut identities = self.identities.write().await;
            let forgotten = identities
                .iter()
                .filter(|(_, identity)| identity.root_thread_id == root_thread_id)
                .map(|(thread_id, _)| thread_id.clone())
                .collect::<Vec<_>>();
            identities.retain(|_, identity| identity.root_thread_id != root_thread_id);
            forgotten
        };
        let mut forgotten_thread_ids = forgotten_thread_ids.into_iter().collect::<HashSet<_>>();
        forgotten_thread_ids.insert(root_thread_id.to_string());
        self.mailboxes
            .lock()
            .await
            .retain(|thread_id, _| !forgotten_thread_ids.contains(thread_id));
        self.turn_settlements
            .lock()
            .await
            .retain(|thread_id, _| !forgotten_thread_ids.contains(thread_id));
        self.spawn_gates.lock().await.remove(root_thread_id);
    }

    pub async fn subscribe_turn_settlement(&self, thread_id: &str) -> watch::Receiver<u64> {
        self.turn_settlements
            .lock()
            .await
            .entry(thread_id.to_string())
            .or_insert_with(|| watch::channel(0).0)
            .subscribe()
    }

    pub async fn notify_turn_settled(&self, thread_id: &str) {
        let mut settlements = self.turn_settlements.lock().await;
        let sender = settlements
            .entry(thread_id.to_string())
            .or_insert_with(|| watch::channel(0).0);
        let revision = sender.borrow().saturating_add(1);
        sender.send_replace(revision);
    }

    pub async fn resolve_target(
        &self,
        storage: &NativeStorage,
        current_thread_id: &str,
        target: &str,
    ) -> Result<AgentIdentity, AppError> {
        let current = self.identity(storage, current_thread_id).await?;
        let path = current
            .path
            .resolve(target.trim())
            .map_err(AppError::Tool)?;
        if path.is_root() {
            return Ok(AgentIdentity::root(current.root_thread_id));
        }
        let identity = storage
            .find_agent_by_path(current.root_thread_id.clone(), path.as_str().to_string())
            .await?
            .ok_or_else(|| AppError::Tool(format!("live agent path `{path}` was not found")))?;
        self.register(identity.clone()).await;
        Ok(identity)
    }

    pub async fn list_tree(
        &self,
        storage: &NativeStorage,
        current_thread_id: &str,
        path_prefix: Option<&str>,
    ) -> Result<Vec<AgentIdentity>, AppError> {
        let current = self.identity(storage, current_thread_id).await?;
        let prefix = path_prefix
            .map(str::trim)
            .filter(|prefix| !prefix.is_empty())
            .map(|prefix| current.path.resolve(prefix).map_err(AppError::Tool))
            .transpose()?;
        let mut agents = vec![AgentIdentity::root(current.root_thread_id.clone())];
        agents.extend(
            storage
                .list_agent_identities(current.root_thread_id.clone())
                .await?,
        );
        agents.retain(|identity| {
            prefix.as_ref().is_none_or(|prefix| {
                identity.path == *prefix
                    || identity
                        .path
                        .as_str()
                        .strip_prefix(prefix.as_str())
                        .is_some_and(|suffix| suffix.starts_with('/'))
            })
        });
        agents.sort_by(|left, right| left.path.cmp(&right.path));
        for identity in &agents {
            self.register(identity.clone()).await;
        }
        Ok(agents)
    }

    pub async fn notify_message(&self, recipient_thread_id: &str, sender: AgentPath) {
        self.push_activity(recipient_thread_id, MailboxActivity::Message { sender })
            .await;
    }

    pub async fn notify_steer(&self, thread_id: &str) {
        self.push_activity(thread_id, MailboxActivity::Steer).await;
    }

    async fn push_activity(&self, thread_id: &str, activity: MailboxActivity) {
        let mut mailboxes = self.mailboxes.lock().await;
        let mailbox = mailboxes.entry(thread_id.to_string()).or_default();
        mailbox.events.push_back(activity);
        mailbox.revision = mailbox.revision.saturating_add(1);
        mailbox.sender.send_replace(mailbox.revision);
    }

    pub async fn wait(
        &self,
        thread_id: &str,
        timeout: Duration,
        cancellation: &mut watch::Receiver<bool>,
    ) -> WaitOutcome {
        let mut receiver = {
            let mut mailboxes = self.mailboxes.lock().await;
            let mailbox = mailboxes.entry(thread_id.to_string()).or_default();
            if !mailbox.events.is_empty() {
                return WaitOutcome::Activity(mailbox.events.drain(..).collect());
            }
            mailbox.sender.subscribe()
        };
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            if *cancellation.borrow() {
                return WaitOutcome::Cancelled;
            }
            let changed = receiver.changed();
            tokio::select! {
                _ = tokio::time::sleep_until(deadline) => return WaitOutcome::TimedOut,
                result = cancellation.changed() => {
                    if result.is_err() || *cancellation.borrow() {
                        return WaitOutcome::Cancelled;
                    }
                }
                result = changed => {
                    if result.is_err() {
                        return WaitOutcome::TimedOut;
                    }
                    let mut mailboxes = self.mailboxes.lock().await;
                    let Some(mailbox) = mailboxes.get_mut(thread_id) else {
                        return WaitOutcome::TimedOut;
                    };
                    if !mailbox.events.is_empty() {
                        return WaitOutcome::Activity(mailbox.events.drain(..).collect());
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn wait_observes_activity_queued_before_subscription() {
        let manager = MultiAgentManager::default();
        manager
            .notify_message("root", AgentPath::try_from("/root/worker").expect("path"))
            .await;
        let (_sender, mut cancellation) = watch::channel(false);
        let outcome = manager
            .wait("root", Duration::from_secs(1), &mut cancellation)
            .await;
        assert!(matches!(outcome, WaitOutcome::Activity(events) if events.len() == 1));
    }

    #[tokio::test]
    async fn wait_is_cancellation_aware() {
        let manager = Arc::new(MultiAgentManager::default());
        let (sender, cancellation) = watch::channel(false);
        let task = {
            let manager = Arc::clone(&manager);
            tokio::spawn(async move {
                let mut cancellation = cancellation;
                manager
                    .wait("root", Duration::from_secs(30), &mut cancellation)
                    .await
            })
        };
        sender.send_replace(true);
        assert_eq!(
            task.await.expect("wait task should finish"),
            WaitOutcome::Cancelled
        );
    }

    #[tokio::test]
    async fn turn_settlement_subscription_cannot_miss_the_next_completion() {
        let manager = MultiAgentManager::default();
        let mut settlement = manager.subscribe_turn_settlement("worker").await;

        manager.notify_turn_settled("worker").await;

        settlement
            .changed()
            .await
            .expect("settlement sender should remain available");
        assert_eq!(*settlement.borrow(), 1);
    }

    #[tokio::test]
    async fn spawn_gates_are_shared_within_a_tree_and_isolated_between_trees() {
        let manager = MultiAgentManager::default();

        let first = manager.spawn_gate("root-a").await;
        let same_tree = manager.spawn_gate("root-a").await;
        let other_tree = manager.spawn_gate("root-b").await;

        assert!(Arc::ptr_eq(&first, &same_tree));
        assert!(!Arc::ptr_eq(&first, &other_tree));
    }
}
