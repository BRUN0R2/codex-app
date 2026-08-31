use std::collections::HashMap;
use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use std::sync::Weak;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use futures_util::FutureExt as _;
use serde_json::Value;
use tokio::sync::{Mutex, Semaphore, mpsc, oneshot, watch};
use tokio::task::{JoinHandle, JoinSet};

use super::cell_state::{CellState, CompletionCommit, CompletionDelivery, ObservationDelivery};
use super::runtime::{
    RuntimeCommand, RuntimeControlCommand, RuntimeEvent, RuntimeHandle, spawn_runtime,
};
use super::types::{
    CellId, CodeModeError, ExecuteRequest, MAX_ACTIVE_CELLS, MAX_CELL_OUTPUT_BYTES,
    MAX_CELL_OUTPUT_ITEMS, MAX_CELL_RUNTIME_SECONDS, MAX_ENABLED_TOOLS, MAX_RESPONSE_TOKEN_BUDGET,
    MAX_SOURCE_BYTES, MAX_YIELD_TIME_MS, NestedToolCall, RuntimeResponse, ToolDelegate,
};
use crate::engine::native::provider::FunctionCallOutputContent;

const CELL_COMMAND_CAPACITY: usize = 8;
const NOTIFICATION_DRAIN_SECONDS: u64 = 5;

#[derive(Clone)]
pub(crate) struct CodeModeSession {
    inner: Arc<SessionInner>,
}

struct SessionInner {
    stored_values: Mutex<HashMap<String, Value>>,
    cells: Mutex<HashMap<CellId, CellHandle>>,
    tasks: Mutex<Vec<JoinHandle<()>>>,
    slots: Arc<Semaphore>,
    shutdown: watch::Sender<bool>,
    next_cell_id: AtomicU64,
}

#[derive(Clone)]
struct CellHandle {
    owner_id: String,
    commands: mpsc::Sender<CellCommand>,
    state: Arc<CellState>,
    closed: watch::Receiver<bool>,
}

enum CellCommand {
    Observe {
        yield_time: Duration,
        response: oneshot::Sender<Result<RuntimeResponse, CodeModeError>>,
    },
}

struct Observer {
    response: oneshot::Sender<Result<RuntimeResponse, CodeModeError>>,
    yield_time: Duration,
}

impl CodeModeSession {
    pub fn new() -> Self {
        let (shutdown, _receiver) = watch::channel(false);
        Self {
            inner: Arc::new(SessionInner {
                stored_values: Mutex::new(HashMap::new()),
                cells: Mutex::new(HashMap::new()),
                tasks: Mutex::new(Vec::new()),
                slots: Arc::new(Semaphore::new(MAX_ACTIVE_CELLS)),
                shutdown,
                next_cell_id: AtomicU64::new(1),
            }),
        }
    }

    pub async fn execute(
        &self,
        owner_id: String,
        request: ExecuteRequest,
        delegate: Arc<dyn ToolDelegate>,
        cancellation: watch::Receiver<bool>,
    ) -> Result<RuntimeResponse, CodeModeError> {
        validate_execute_request(&request)?;
        self.ensure_running()?;
        if *cancellation.borrow() {
            return Err(CodeModeError::ShuttingDown);
        }
        let initial_yield_time = Duration::from_millis(request.yield_time_ms);
        let permit = Arc::clone(&self.inner.slots)
            .try_acquire_owned()
            .map_err(|_| {
                CodeModeError::InvalidRequest(format!(
                    "Code Mode supports at most {MAX_ACTIVE_CELLS} active cells"
                ))
            })?;
        let cell_id = self.allocate_cell_id()?;
        let stored_values = self.inner.stored_values.lock().await.clone();
        let runtime = tokio::task::spawn_blocking(move || spawn_runtime(stored_values, request))
            .await
            .map_err(|error| CodeModeError::Runtime(format!("V8 startup task failed: {error}")))?
            .map_err(CodeModeError::Runtime)?;
        if let Err(error) = self.ensure_running().and_then(|()| {
            (!*cancellation.borrow())
                .then_some(())
                .ok_or(CodeModeError::ShuttingDown)
        }) {
            terminate_runtime(&runtime);
            let RuntimeHandle { thread, .. } = runtime;
            let _ = tokio::task::spawn_blocking(move || thread.join()).await;
            return Err(error);
        }

        let (command_tx, command_rx) = mpsc::channel(CELL_COMMAND_CAPACITY);
        let (initial_tx, initial_rx) = oneshot::channel();
        let (closed_tx, closed_rx) = watch::channel(false);
        let state = CellState::new(cell_id.clone());
        let handle = CellHandle {
            owner_id,
            commands: command_tx,
            state: Arc::clone(&state),
            closed: closed_rx,
        };
        self.inner
            .cells
            .lock()
            .await
            .insert(cell_id.clone(), handle);
        let task = tokio::spawn(run_cell(CellActor {
            cell_id: cell_id.clone(),
            runtime,
            commands: command_rx,
            cell_cancellation: state.subscribe(),
            state,
            observer: Some(Observer {
                response: initial_tx,
                yield_time: initial_yield_time,
            }),
            delegate,
            session: Arc::downgrade(&self.inner),
            parent_cancellation: cancellation,
            shutdown: self.inner.shutdown.subscribe(),
            closed: closed_tx,
            _slot: permit,
        }));
        let mut tasks = self.inner.tasks.lock().await;
        tasks.retain(|task| !task.is_finished());
        tasks.push(task);
        drop(tasks);
        initial_rx.await.map_err(|_| {
            CodeModeError::Runtime(format!("Code Mode cell {cell_id} closed before responding"))
        })?
    }

    pub async fn wait(
        &self,
        cell_id: CellId,
        yield_time_ms: u64,
    ) -> Result<RuntimeResponse, CodeModeError> {
        self.ensure_running()?;
        let yield_time = validated_yield_time(yield_time_ms)?;
        let handle = self.cell(&cell_id).await?;
        let (response_tx, response_rx) = oneshot::channel();
        handle
            .commands
            .send(CellCommand::Observe {
                yield_time,
                response: response_tx,
            })
            .await
            .map_err(|_| CodeModeError::MissingCell(cell_id.clone()))?;
        response_rx
            .await
            .map_err(|_| CodeModeError::MissingCell(cell_id))?
    }

    pub async fn terminate(&self, cell_id: CellId) -> Result<RuntimeResponse, CodeModeError> {
        let handle = self.cell(&cell_id).await?;
        handle.state.request_termination().await
    }

    pub async fn shutdown(&self) {
        self.inner.shutdown.send_replace(true);
        let handles = self
            .inner
            .cells
            .lock()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for handle in handles {
            handle.state.cancel();
        }
        let all_slots = Arc::clone(&self.inner.slots)
            .acquire_many_owned(MAX_ACTIVE_CELLS as u32)
            .await
            .ok();
        let tasks = std::mem::take(&mut *self.inner.tasks.lock().await);
        for task in tasks {
            let _ = task.await;
        }
        self.inner.cells.lock().await.clear();
        drop(all_slots);
    }

    pub async fn cancel_owner(&self, owner_id: &str) {
        let handles = self
            .inner
            .cells
            .lock()
            .await
            .values()
            .filter(|handle| handle.owner_id == owner_id)
            .cloned()
            .collect::<Vec<_>>();
        for handle in &handles {
            handle.state.cancel();
        }
        for mut handle in handles {
            if !*handle.closed.borrow() {
                let _ = handle.closed.changed().await;
            }
        }
    }

    fn ensure_running(&self) -> Result<(), CodeModeError> {
        if *self.inner.shutdown.borrow() {
            Err(CodeModeError::ShuttingDown)
        } else {
            Ok(())
        }
    }

    fn allocate_cell_id(&self) -> Result<CellId, CodeModeError> {
        self.inner
            .next_cell_id
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |next| {
                next.checked_add(1)
            })
            .map(CellId::allocated)
            .map_err(|_| CodeModeError::Runtime("Code Mode cell ID space exhausted".into()))
    }

    async fn cell(&self, cell_id: &CellId) -> Result<CellHandle, CodeModeError> {
        self.inner
            .cells
            .lock()
            .await
            .get(cell_id)
            .cloned()
            .ok_or_else(|| CodeModeError::MissingCell(cell_id.clone()))
    }
}

impl Drop for CodeModeSession {
    fn drop(&mut self) {
        if Arc::strong_count(&self.inner) == 1 {
            self.inner.shutdown.send_replace(true);
        }
    }
}

struct CellActor {
    cell_id: CellId,
    runtime: RuntimeHandle,
    commands: mpsc::Receiver<CellCommand>,
    cell_cancellation: watch::Receiver<bool>,
    state: Arc<CellState>,
    observer: Option<Observer>,
    delegate: Arc<dyn ToolDelegate>,
    session: Weak<SessionInner>,
    parent_cancellation: watch::Receiver<bool>,
    shutdown: watch::Receiver<bool>,
    closed: watch::Sender<bool>,
    _slot: tokio::sync::OwnedSemaphorePermit,
}

struct CellCallbacks {
    tool_cancellation: watch::Sender<bool>,
    notification_cancellation: watch::Sender<bool>,
    tool_tasks: JoinSet<()>,
    notification_tasks: JoinSet<()>,
}

impl CellCallbacks {
    fn new() -> Self {
        let (tool_cancellation, _) = watch::channel(false);
        let (notification_cancellation, _) = watch::channel(false);
        Self {
            tool_cancellation,
            notification_cancellation,
            tool_tasks: JoinSet::new(),
            notification_tasks: JoinSet::new(),
        }
    }

    async fn finish(&mut self) {
        self.settle_tool_tasks().await;
        let drain = async { while self.notification_tasks.join_next().await.is_some() {} };
        if tokio::time::timeout(Duration::from_secs(NOTIFICATION_DRAIN_SECONDS), drain)
            .await
            .is_err()
        {
            self.notification_cancellation.send_replace(true);
            self.notification_tasks.abort_all();
            while self.notification_tasks.join_next().await.is_some() {}
        }
    }

    async fn cancel(&mut self) {
        self.notification_cancellation.send_replace(true);
        self.notification_tasks.abort_all();
        self.settle_tool_tasks().await;
        while self.notification_tasks.join_next().await.is_some() {}
    }

    async fn settle_tool_tasks(&mut self) {
        // A delegate can own a visible item after publishing item.started. Cancelling and
        // draining keeps that future alive until it persists and publishes the terminal item.
        self.tool_cancellation.send_replace(true);
        while self.tool_tasks.join_next().await.is_some() {}
    }
}

async fn run_cell(mut actor: CellActor) {
    let mut callbacks = CellCallbacks::new();
    let mut content = Vec::new();
    let mut content_bytes = 0usize;
    let mut runtime_closed = false;
    let mut runtime_paused = false;
    let mut runtime_started = false;
    let mut callbacks_finished = false;
    let mut yield_timer: Option<std::pin::Pin<Box<tokio::time::Sleep>>> = None;
    let hard_deadline = tokio::time::sleep(Duration::from_secs(MAX_CELL_RUNTIME_SECONDS));
    tokio::pin!(hard_deadline);

    loop {
        if actor
            .observer
            .as_ref()
            .is_some_and(|observer| observer.response.is_closed())
        {
            actor.observer = None;
            yield_timer = None;
        }

        tokio::select! {
            biased;
            _ = wait_for_cancellation(&mut actor.parent_cancellation) => {
                actor.state.cancel();
                terminate_cell(
                    &mut actor,
                    &mut content,
                    &mut callbacks,
                ).await;
                callbacks_finished = true;
                break;
            }
            _ = wait_for_cancellation(&mut actor.shutdown) => {
                actor.state.cancel();
                terminate_cell(
                    &mut actor,
                    &mut content,
                    &mut callbacks,
                ).await;
                callbacks_finished = true;
                break;
            }
            _ = wait_for_cancellation(&mut actor.cell_cancellation) => {
                terminate_cell(
                    &mut actor,
                    &mut content,
                    &mut callbacks,
                ).await;
                callbacks_finished = true;
                break;
            }
            _ = &mut hard_deadline, if !runtime_closed => {
                runtime_closed = true;
                terminate_runtime(&actor.runtime);
                let delivered = complete_cell(
                    &mut actor,
                    &mut content,
                    HashMap::new(),
                    Some(format!("exec exceeded its {MAX_CELL_RUNTIME_SECONDS}-second runtime limit")),
                    &mut callbacks,
                ).await;
                callbacks_finished = true;
                if delivered {
                    break;
                }
            }
            Some(command) = actor.commands.recv() => {
                match command {
                    CellCommand::Observe { yield_time, response } => {
                        if response.is_closed() {
                            continue;
                        }
                        if actor.observer.is_some() {
                            let _ = response.send(Err(CodeModeError::BusyCell(actor.cell_id.clone())));
                        } else {
                            match actor.state.route_observation(response) {
                                ObservationDelivery::Running(response) => {
                                    actor.observer = Some(Observer { response, yield_time });
                                    if runtime_started {
                                        yield_timer = actor.observer.as_ref().map(observer_timer);
                                    }
                                    if runtime_paused {
                                        let _ = actor.runtime.control.send(RuntimeControlCommand::Continue);
                                        runtime_paused = false;
                                    }
                                }
                                ObservationDelivery::Delivered => break,
                                ObservationDelivery::Buffered | ObservationDelivery::Closed => {}
                            }
                        }
                    }
                }
            }
            _ = async {
                if let Some(timer) = yield_timer.as_mut() {
                    timer.await;
                } else {
                    std::future::pending::<()>().await;
                }
            } => {
                yield_timer = None;
                if let Some(observer) = actor.observer.take() {
                    let response = RuntimeResponse::Yielded {
                        cell_id: actor.cell_id.clone(),
                        content: std::mem::take(&mut content),
                    };
                    match observer.response.send(Ok(response)) {
                        Ok(()) => content_bytes = 0,
                        Err(Ok(RuntimeResponse::Yielded { content: undelivered, .. })) => {
                            content = undelivered;
                        }
                        Err(_) => {}
                    }
                }
            }
            event = actor.runtime.events.recv(), if !runtime_closed => {
                match event {
                    Some(RuntimeEvent::Started) => {
                        runtime_started = true;
                        yield_timer = actor.observer.as_ref().map(observer_timer);
                    }
                    Some(RuntimeEvent::Pending) => {
                        runtime_paused = true;
                        if actor.observer.is_some() {
                            let _ = actor.runtime.control.send(RuntimeControlCommand::Continue);
                            runtime_paused = false;
                        }
                    }
                    Some(RuntimeEvent::Content(item)) => {
                        match append_content(&mut content, &mut content_bytes, item) {
                            Ok(()) => {}
                            Err(error) => {
                                terminate_runtime(&actor.runtime);
                                let delivered = complete_cell(
                                    &mut actor,
                                    &mut content,
                                    HashMap::new(),
                                    Some(error),
                                    &mut callbacks,
                                ).await;
                                callbacks_finished = true;
                                runtime_closed = true;
                                if delivered {
                                    break;
                                }
                            }
                        }
                    }
                    Some(RuntimeEvent::YieldRequested) => {
                        if let Some(observer) = actor.observer.take() {
                            yield_timer = None;
                            let response = RuntimeResponse::Yielded {
                                cell_id: actor.cell_id.clone(),
                                content: std::mem::take(&mut content),
                            };
                            match observer.response.send(Ok(response)) {
                                Ok(()) => content_bytes = 0,
                                Err(Ok(RuntimeResponse::Yielded { content: undelivered, .. })) => {
                                    content = undelivered;
                                }
                                Err(_) => {}
                            }
                        }
                    }
                    Some(RuntimeEvent::ToolCall { id, name, kind, input }) => {
                        let delegate = Arc::clone(&actor.delegate);
                        let cell_id = actor.cell_id.clone();
                        let runtime_commands = actor.runtime.commands.clone();
                        let cancellation = callbacks.tool_cancellation.subscribe();
                        callbacks.tool_tasks.spawn(async move {
                            let call = NestedToolCall {
                                cell_id,
                                runtime_call_id: id.clone(),
                                name,
                                kind,
                                input,
                            };
                            match AssertUnwindSafe(delegate.invoke(call, cancellation))
                                .catch_unwind()
                                .await
                            {
                                Ok(Ok(result)) => {
                                    let _ = runtime_commands.send(RuntimeCommand::ToolResponse { id, result });
                                }
                                Ok(Err(error)) => {
                                    let _ = runtime_commands.send(RuntimeCommand::ToolError { id, error });
                                }
                                Err(_) => {
                                    let _ = runtime_commands.send(RuntimeCommand::ToolError {
                                        id,
                                        error: "code mode tool callback panicked".into(),
                                    });
                                }
                            }
                        });
                    }
                    Some(RuntimeEvent::Notify { call_id, text }) => {
                        if let Err(error) = append_content(
                            &mut content,
                            &mut content_bytes,
                            FunctionCallOutputContent::InputText { text: text.clone() },
                        ) {
                            terminate_runtime(&actor.runtime);
                            let delivered = complete_cell(
                                &mut actor,
                                &mut content,
                                HashMap::new(),
                                Some(error),
                                &mut callbacks,
                            ).await;
                            callbacks_finished = true;
                            runtime_closed = true;
                            if delivered {
                                break;
                            }
                            continue;
                        }
                        let delegate = Arc::clone(&actor.delegate);
                        let cell_id = actor.cell_id.clone();
                        let cancellation = callbacks.notification_cancellation.subscribe();
                        callbacks.notification_tasks.spawn(async move {
                            let _ = AssertUnwindSafe(
                                delegate.notify(call_id, cell_id, text, cancellation),
                            )
                            .catch_unwind()
                            .await;
                        });
                        if let Some(observer) = actor.observer.take() {
                            yield_timer = None;
                            let response = RuntimeResponse::Yielded {
                                cell_id: actor.cell_id.clone(),
                                content: std::mem::take(&mut content),
                            };
                            match observer.response.send(Ok(response)) {
                                Ok(()) => content_bytes = 0,
                                Err(Ok(RuntimeResponse::Yielded { content: undelivered, .. })) => {
                                    content = undelivered;
                                }
                                Err(_) => {}
                            }
                        }
                    }
                    Some(RuntimeEvent::Completed { stored_value_writes, error }) => {
                        runtime_closed = true;
                        yield_timer = None;
                        let delivered = complete_cell(
                            &mut actor,
                            &mut content,
                            stored_value_writes,
                            error,
                            &mut callbacks,
                        ).await;
                        callbacks_finished = true;
                        if delivered {
                            break;
                        }
                    }
                    Some(RuntimeEvent::Panicked) => {
                        runtime_closed = true;
                        let delivered = complete_cell(
                            &mut actor,
                            &mut content,
                            HashMap::new(),
                            Some("exec V8 runtime panicked".into()),
                            &mut callbacks,
                        ).await;
                        callbacks_finished = true;
                        if delivered {
                            break;
                        }
                    }
                    None => {
                        runtime_closed = true;
                        let delivered = complete_cell(
                            &mut actor,
                            &mut content,
                            HashMap::new(),
                            Some("exec runtime ended unexpectedly".into()),
                            &mut callbacks,
                        ).await;
                        callbacks_finished = true;
                        if delivered {
                            break;
                        }
                    }
                }
            }
            Some(_) = callbacks.tool_tasks.join_next(), if !callbacks.tool_tasks.is_empty() => {}
            Some(_) = callbacks.notification_tasks.join_next(), if !callbacks.notification_tasks.is_empty() => {}
            else => {
                let delivered = complete_cell(
                    &mut actor,
                    &mut content,
                    HashMap::new(),
                    Some("exec cell closed unexpectedly".into()),
                    &mut callbacks,
                ).await;
                callbacks_finished = true;
                if delivered || actor.observer.is_none() {
                    break;
                }
            }
        }
    }

    if !callbacks_finished {
        callbacks.cancel().await;
    }
    actor.state.tombstone();
    terminate_runtime(&actor.runtime);
    let RuntimeHandle { thread, .. } = actor.runtime;
    let _ = tokio::task::spawn_blocking(move || thread.join()).await;
    if let Some(session) = actor.session.upgrade() {
        session.cells.lock().await.remove(&actor.cell_id);
    }
    actor.closed.send_replace(true);
}

async fn complete_cell(
    actor: &mut CellActor,
    content: &mut Vec<FunctionCallOutputContent>,
    stored_value_writes: HashMap<String, Value>,
    error: Option<String>,
    callbacks: &mut CellCallbacks,
) -> bool {
    callbacks.finish().await;

    if *actor.parent_cancellation.borrow() || *actor.shutdown.borrow() {
        actor.state.cancel();
    }
    let response = completed_response(&actor.cell_id, std::mem::take(content), error.clone());
    let commit = if error.is_none() && !stored_value_writes.is_empty() {
        if let Some(session) = actor.session.upgrade() {
            let mut stored_values = session.stored_values.lock().await;
            if *actor.parent_cancellation.borrow() || *actor.shutdown.borrow() {
                actor.state.cancel();
            }
            actor.state.commit_completion(response, || {
                stored_values.extend(stored_value_writes);
            })
        } else {
            actor.state.cancel();
            CompletionCommit::Rejected(response)
        }
    } else {
        actor.state.commit_completion(response, || {})
    };

    match commit {
        CompletionCommit::Committed => match actor
            .state
            .deliver_completion(actor.observer.take().map(|observer| observer.response))
        {
            CompletionDelivery::Delivered => true,
            CompletionDelivery::Buffered => false,
            CompletionDelivery::Rejected(observer) => {
                finish_rejected_completion(actor, observer, None);
                true
            }
        },
        CompletionCommit::Rejected(response) => {
            let observer = actor.observer.take().map(|observer| observer.response);
            finish_rejected_completion(actor, observer, Some(response));
            true
        }
    }
}

async fn terminate_cell(
    actor: &mut CellActor,
    content: &mut Vec<FunctionCallOutputContent>,
    callbacks: &mut CellCallbacks,
) {
    terminate_runtime(&actor.runtime);
    callbacks.cancel().await;
    let response = terminated_response(&actor.cell_id, std::mem::take(content));
    if let Some(response) = actor.state.finish_termination(response)
        && let Some(observer) = actor.observer.take()
    {
        let _ = observer.response.send(Ok(response));
    }
}

fn finish_rejected_completion(
    actor: &mut CellActor,
    observer: Option<oneshot::Sender<Result<RuntimeResponse, CodeModeError>>>,
    rejected: Option<RuntimeResponse>,
) {
    let content = rejected
        .map(|response| match response {
            RuntimeResponse::Completed { content, .. } => content,
            RuntimeResponse::Yielded { .. } | RuntimeResponse::Terminated { .. } => {
                unreachable!("only completion responses enter completion arbitration")
            }
        })
        .unwrap_or_default();
    let response = terminated_response(&actor.cell_id, content);
    if let Some(response) = actor.state.finish_termination(response)
        && let Some(observer) = observer
    {
        let _ = observer.send(Ok(response));
    }
}

fn validate_execute_request(request: &ExecuteRequest) -> Result<(), CodeModeError> {
    if request.call_id.is_empty()
        || request.call_id.len() > 256
        || request.call_id.chars().any(char::is_control)
    {
        return Err(CodeModeError::InvalidRequest(
            "exec call id must contain between 1 and 256 bytes without control characters".into(),
        ));
    }
    if request.source.trim().is_empty() {
        return Err(CodeModeError::InvalidRequest(
            "exec expects non-empty JavaScript source".into(),
        ));
    }
    if request.source.len() > MAX_SOURCE_BYTES {
        return Err(CodeModeError::InvalidRequest(format!(
            "exec source exceeds the {MAX_SOURCE_BYTES}-byte limit"
        )));
    }
    if request.enabled_tools.len() > MAX_ENABLED_TOOLS {
        return Err(CodeModeError::InvalidRequest(format!(
            "exec exposes at most {MAX_ENABLED_TOOLS} nested tools"
        )));
    }
    let mut names = std::collections::HashSet::new();
    for tool in &request.enabled_tools {
        if tool.name.is_empty() || tool.name.len() > 128 || tool.name.chars().any(char::is_control)
        {
            return Err(CodeModeError::InvalidRequest(
                "nested tool names must contain between 1 and 128 bytes without control characters"
                    .into(),
            ));
        }
        if !names.insert(tool.name.as_str()) {
            return Err(CodeModeError::InvalidRequest(format!(
                "nested tool `{}` is defined more than once",
                tool.name
            )));
        }
    }
    validated_yield_time(request.yield_time_ms)?;
    if request.max_output_tokens > MAX_RESPONSE_TOKEN_BUDGET {
        return Err(CodeModeError::InvalidRequest(format!(
            "exec max_output_tokens exceeds the {MAX_RESPONSE_TOKEN_BUDGET}-token limit"
        )));
    }
    Ok(())
}

fn validated_yield_time(yield_time_ms: u64) -> Result<Duration, CodeModeError> {
    if yield_time_ms > MAX_YIELD_TIME_MS {
        return Err(CodeModeError::InvalidRequest(format!(
            "yield_time must not exceed {MAX_YIELD_TIME_MS} milliseconds"
        )));
    }
    Ok(Duration::from_millis(yield_time_ms))
}

fn observer_timer(observer: &Observer) -> std::pin::Pin<Box<tokio::time::Sleep>> {
    Box::pin(tokio::time::sleep(observer.yield_time))
}

fn append_content(
    content: &mut Vec<FunctionCallOutputContent>,
    content_bytes: &mut usize,
    item: FunctionCallOutputContent,
) -> Result<(), String> {
    if content.len() >= MAX_CELL_OUTPUT_ITEMS {
        return Err(format!(
            "exec output exceeded the {MAX_CELL_OUTPUT_ITEMS}-item buffer limit"
        ));
    }
    let item_bytes = serde_json::to_vec(&item)
        .map_err(|error| format!("failed to size exec output: {error}"))?
        .len();
    let next_bytes = content_bytes
        .checked_add(item_bytes)
        .ok_or_else(|| "exec output size overflowed".to_string())?;
    if next_bytes > MAX_CELL_OUTPUT_BYTES {
        return Err(format!(
            "exec output exceeded the {MAX_CELL_OUTPUT_BYTES}-byte buffer limit"
        ));
    }
    *content_bytes = next_bytes;
    content.push(item);
    Ok(())
}

fn completed_response(
    cell_id: &CellId,
    content: Vec<FunctionCallOutputContent>,
    error: Option<String>,
) -> RuntimeResponse {
    RuntimeResponse::Completed {
        cell_id: cell_id.clone(),
        content,
        error,
    }
}

fn terminated_response(
    cell_id: &CellId,
    content: Vec<FunctionCallOutputContent>,
) -> RuntimeResponse {
    RuntimeResponse::Terminated {
        cell_id: cell_id.clone(),
        content,
    }
}

fn terminate_runtime(runtime: &RuntimeHandle) {
    let _ = runtime.commands.send(RuntimeCommand::Terminate);
    let _ = runtime.control.send(RuntimeControlCommand::Terminate);
    let _ = runtime.isolate.terminate_execution();
}

async fn wait_for_cancellation(cancellation: &mut watch::Receiver<bool>) {
    if *cancellation.borrow() {
        return;
    }
    while cancellation.changed().await.is_ok() {
        if *cancellation.borrow() {
            return;
        }
    }
}
