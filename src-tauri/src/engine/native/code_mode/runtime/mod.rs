mod callbacks;
mod globals;
mod module_loader;
mod timers;
mod v8_init;
mod value;

use std::collections::HashMap;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::mpsc as std_mpsc;
use std::thread;

use serde_json::Value;
use tokio::sync::mpsc;

use self::v8_init::ensure_v8_initialized;
use super::super::provider::FunctionCallOutputContent;
use super::types::{ExecuteRequest, ToolDefinition, ToolKind};

const EXIT_SENTINEL: &str = "__codex_desktop_code_mode_exit__";

pub(super) fn warm_runtime() -> Result<(), String> {
    ensure_v8_initialized()
}

#[derive(Debug)]
pub(super) enum RuntimeCommand {
    ToolResponse { id: String, result: Value },
    ToolError { id: String, error: String },
    TimeoutFired { id: u64 },
    Terminate,
}

#[derive(Debug)]
pub(super) enum RuntimeControlCommand {
    Continue,
    Terminate,
}

#[derive(Debug)]
pub(super) enum RuntimeEvent {
    Started,
    Pending,
    Content(FunctionCallOutputContent),
    YieldRequested,
    ToolCall {
        id: String,
        name: String,
        kind: ToolKind,
        input: Option<Value>,
    },
    Notify {
        call_id: String,
        text: String,
    },
    Completed {
        stored_value_writes: HashMap<String, Value>,
        error: Option<String>,
    },
    Panicked,
}

pub(super) struct RuntimeHandle {
    pub commands: std_mpsc::Sender<RuntimeCommand>,
    pub control: std_mpsc::Sender<RuntimeControlCommand>,
    pub isolate: v8::IsolateHandle,
    pub events: mpsc::UnboundedReceiver<RuntimeEvent>,
    pub thread: thread::JoinHandle<()>,
}

pub(super) fn spawn_runtime(
    stored_values: HashMap<String, Value>,
    request: ExecuteRequest,
) -> Result<RuntimeHandle, String> {
    ensure_v8_initialized()?;
    let (event_tx, event_rx) = mpsc::unbounded_channel();
    let (command_tx, command_rx) = std_mpsc::channel();
    let (control_tx, control_rx) = std_mpsc::channel();
    let runtime_command_tx = command_tx.clone();
    let (isolate_tx, isolate_rx) = std_mpsc::sync_channel(1);
    let config = RuntimeConfig {
        call_id: request.call_id,
        enabled_tools: request.enabled_tools,
        source: request.source,
        stored_values,
    };

    let thread = thread::Builder::new()
        .name("code-mode-v8".into())
        .spawn(move || {
            if catch_unwind(AssertUnwindSafe(|| {
                run_runtime(
                    config,
                    event_tx.clone(),
                    command_rx,
                    control_rx,
                    isolate_tx,
                    runtime_command_tx,
                );
            }))
            .is_err()
            {
                let _ = event_tx.send(RuntimeEvent::Panicked);
            }
        })
        .map_err(|error| format!("failed to spawn V8 runtime thread: {error}"))?;

    let isolate = isolate_rx
        .recv()
        .map_err(|_| "V8 runtime ended before initialization".to_string())?;
    Ok(RuntimeHandle {
        commands: command_tx,
        control: control_tx,
        isolate,
        events: event_rx,
        thread,
    })
}

struct RuntimeConfig {
    call_id: String,
    enabled_tools: Vec<ToolDefinition>,
    source: String,
    stored_values: HashMap<String, Value>,
}

pub(super) struct RuntimeState {
    event_tx: mpsc::UnboundedSender<RuntimeEvent>,
    pending_tool_calls: HashMap<String, v8::Global<v8::PromiseResolver>>,
    pending_timeouts: HashMap<u64, timers::ScheduledTimeout>,
    stored_values: HashMap<String, Value>,
    stored_value_writes: HashMap<String, Value>,
    enabled_tools: Vec<ToolDefinition>,
    next_tool_call_id: u64,
    next_timeout_id: u64,
    emitted_content_bytes: usize,
    emitted_content_items: usize,
    yield_requests: usize,
    call_id: String,
    runtime_command_tx: std_mpsc::Sender<RuntimeCommand>,
    exit_requested: bool,
}

pub(super) enum CompletionState {
    Pending,
    Completed {
        stored_value_writes: HashMap<String, Value>,
        error: Option<String>,
    },
}

fn run_runtime(
    config: RuntimeConfig,
    event_tx: mpsc::UnboundedSender<RuntimeEvent>,
    command_rx: std_mpsc::Receiver<RuntimeCommand>,
    control_rx: std_mpsc::Receiver<RuntimeControlCommand>,
    isolate_tx: std_mpsc::SyncSender<v8::IsolateHandle>,
    runtime_command_tx: std_mpsc::Sender<RuntimeCommand>,
) {
    let isolate = &mut v8::Isolate::new(v8::CreateParams::default());
    let isolate_handle = isolate.thread_safe_handle();
    if isolate_tx.send(isolate_handle).is_err() {
        return;
    }
    isolate.set_host_import_module_dynamically_callback(module_loader::dynamic_import_callback);

    v8::scope!(let scope, isolate);
    let context = v8::Context::new(scope, Default::default());
    let scope = &mut v8::ContextScope::new(scope, context);
    scope.set_slot(RuntimeState {
        event_tx: event_tx.clone(),
        pending_tool_calls: HashMap::new(),
        pending_timeouts: HashMap::new(),
        stored_values: config.stored_values,
        stored_value_writes: HashMap::new(),
        enabled_tools: config.enabled_tools,
        next_tool_call_id: 1,
        next_timeout_id: 1,
        emitted_content_bytes: 0,
        emitted_content_items: 0,
        yield_requests: 0,
        call_id: config.call_id,
        runtime_command_tx,
        exit_requested: false,
    });

    if let Err(error) = globals::install(scope) {
        send_completed(&event_tx, HashMap::new(), Some(error));
        return;
    }
    let _ = event_tx.send(RuntimeEvent::Started);

    let pending_promise = match module_loader::evaluate(scope, &config.source) {
        Ok(promise) => promise,
        Err(error) => {
            capture_error(scope, &event_tx, Some(error));
            return;
        }
    };
    match module_loader::completion_state(scope, pending_promise.as_ref()) {
        CompletionState::Completed {
            stored_value_writes,
            error,
        } => {
            send_completed(&event_tx, stored_value_writes, error);
            return;
        }
        CompletionState::Pending => {}
    }

    let mut pending_promise = pending_promise;
    while let Some(command) = next_command(&event_tx, &command_rx, &control_rx) {
        match command {
            RuntimeCommand::Terminate => break,
            RuntimeCommand::ToolResponse { id, result } => {
                if let Err(error) = module_loader::resolve_tool(scope, &id, Ok(result)) {
                    capture_error(scope, &event_tx, Some(error));
                    return;
                }
            }
            RuntimeCommand::ToolError { id, error } => {
                if let Err(runtime_error) = module_loader::resolve_tool(scope, &id, Err(error)) {
                    capture_error(scope, &event_tx, Some(runtime_error));
                    return;
                }
            }
            RuntimeCommand::TimeoutFired { id } => {
                if let Err(error) = timers::invoke(scope, id) {
                    capture_error(scope, &event_tx, Some(error));
                    return;
                }
            }
        }

        scope.perform_microtask_checkpoint();
        match module_loader::completion_state(scope, pending_promise.as_ref()) {
            CompletionState::Completed {
                stored_value_writes,
                error,
            } => {
                send_completed(&event_tx, stored_value_writes, error);
                return;
            }
            CompletionState::Pending => {}
        }
        if let Some(promise) = pending_promise.as_ref() {
            let promise = v8::Local::new(scope, promise);
            if promise.state() != v8::PromiseState::Pending {
                pending_promise = None;
            }
        }
    }

    capture_error(scope, &event_tx, Some("exec runtime terminated".into()));
}

fn next_command(
    event_tx: &mpsc::UnboundedSender<RuntimeEvent>,
    command_rx: &std_mpsc::Receiver<RuntimeCommand>,
    control_rx: &std_mpsc::Receiver<RuntimeControlCommand>,
) -> Option<RuntimeCommand> {
    match command_rx.try_recv() {
        Ok(command) => return Some(command),
        Err(std_mpsc::TryRecvError::Disconnected) => return None,
        Err(std_mpsc::TryRecvError::Empty) => {}
    }
    let _ = event_tx.send(RuntimeEvent::Pending);
    match control_rx.recv().ok()? {
        RuntimeControlCommand::Continue => command_rx.recv().ok(),
        RuntimeControlCommand::Terminate => Some(RuntimeCommand::Terminate),
    }
}

fn capture_error(
    scope: &mut v8::PinScope<'_, '_>,
    event_tx: &mpsc::UnboundedSender<RuntimeEvent>,
    error: Option<String>,
) {
    let stored_value_writes = scope
        .get_slot::<RuntimeState>()
        .map(|state| state.stored_value_writes.clone())
        .unwrap_or_default();
    send_completed(event_tx, stored_value_writes, error);
}

fn send_completed(
    event_tx: &mpsc::UnboundedSender<RuntimeEvent>,
    stored_value_writes: HashMap<String, Value>,
    error: Option<String>,
) {
    let _ = event_tx.send(RuntimeEvent::Completed {
        stored_value_writes,
        error,
    });
}
