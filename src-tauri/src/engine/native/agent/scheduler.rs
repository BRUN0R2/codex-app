use std::collections::{BTreeMap, VecDeque};
use std::future::Future;
use std::pin::Pin;

use tokio::task::JoinSet;

use crate::error::AppError;

pub(super) const MAX_PARALLEL_TOOLS: usize = 8;
const MAX_TOOLS_PER_RESPONSE: usize = 128;

type Execution<T> = Pin<Box<dyn Future<Output = T> + Send>>;

struct QueuedTool<T> {
    index: usize,
    parallel: bool,
    execution: Execution<T>,
}

/// Starts admitted calls while the model is streaming, preserving mutation
/// barriers and retaining results in provider call order until the stream ends.
pub(super) struct ToolScheduler<T> {
    queued: VecDeque<QueuedTool<T>>,
    running: JoinSet<(usize, T)>,
    completed: BTreeMap<usize, T>,
    exclusive: bool,
    submitted: usize,
    failure: Option<AppError>,
}

pub(super) struct ToolDrain<T> {
    pub results: Vec<T>,
    pub failure: Option<AppError>,
}

impl<T: Send + 'static> ToolScheduler<T> {
    pub fn new() -> Self {
        Self {
            queued: VecDeque::new(),
            running: JoinSet::new(),
            completed: BTreeMap::new(),
            exclusive: false,
            submitted: 0,
            failure: None,
        }
    }

    pub fn has_calls(&self) -> bool {
        self.submitted > 0
    }

    pub fn has_running(&self) -> bool {
        !self.running.is_empty()
    }

    pub async fn next_response_event<F: Future>(&mut self, event: F) -> F::Output {
        tokio::pin!(event);
        loop {
            tokio::select! {
                result = &mut event => return result,
                () = self.advance(), if self.has_running() => {}
            }
        }
    }

    pub fn enqueue(
        &mut self,
        parallel: bool,
        execution: impl Future<Output = T> + Send + 'static,
    ) -> Result<(), AppError> {
        if self.submitted >= MAX_TOOLS_PER_RESPONSE {
            return Err(AppError::Protocol(format!(
                "a response cannot contain more than {MAX_TOOLS_PER_RESPONSE} tool calls"
            )));
        }
        self.queued.push_back(QueuedTool {
            index: self.submitted,
            parallel,
            execution: Box::pin(execution),
        });
        self.submitted += 1;
        self.start_ready();
        Ok(())
    }

    pub async fn advance(&mut self) {
        match self.running.join_next().await {
            Some(Ok((index, result))) => {
                self.completed.insert(index, result);
            }
            Some(Err(error)) => {
                self.failure.get_or_insert_with(|| {
                    AppError::State(format!("tool execution task failed: {error}"))
                });
            }
            None => {}
        }
        if self.running.is_empty() {
            self.exclusive = false;
        }
        self.start_ready();
    }

    pub async fn drain(mut self) -> ToolDrain<T> {
        while self.has_running() {
            self.advance().await;
        }
        ToolDrain {
            results: self.completed.into_values().collect(),
            failure: self.failure,
        }
    }

    fn start_ready(&mut self) {
        while let Some(next) = self.queued.front() {
            if self.running.len() >= MAX_PARALLEL_TOOLS
                || (!self.running.is_empty() && (self.exclusive || !next.parallel))
            {
                break;
            }
            let Some(next) = self.queued.pop_front() else {
                break;
            };
            self.exclusive = !next.parallel;
            self.running
                .spawn(async move { (next.index, next.execution.await) });
        }
    }
}

#[cfg(test)]
mod tests;
