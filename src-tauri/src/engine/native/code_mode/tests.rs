use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::watch;

use super::types::CodeModeError;
use super::{
    CellId, CodeModeSession, DelegateFuture, ExecuteRequest, NestedToolCall, RuntimeResponse,
    ToolDefinition, ToolDelegate, ToolKind,
};
use crate::engine::native::provider::FunctionCallOutputContent;

const TEST_TIMEOUT: Duration = Duration::from_secs(30);
const TEST_YIELD_MILLISECONDS: u64 = 30_000;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_runtime_warmups_share_one_process_initialization() {
    let tasks = (0..32)
        .map(|_| tokio::spawn(super::warm_runtime()))
        .collect::<Vec<_>>();

    for task in tasks {
        task.await
            .expect("warmup task should remain joinable")
            .expect("Code Mode runtime should warm successfully");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "performance benchmark"]
async fn benchmark_code_mode_runtime_warmup() {
    let started_at = std::time::Instant::now();
    super::warm_runtime()
        .await
        .expect("Code Mode runtime should warm successfully");
    let elapsed = started_at.elapsed();

    println!(
        "Code Mode runtime warmup: {:.3} ms",
        elapsed.as_secs_f64() * 1_000.0
    );
    assert!(
        elapsed <= Duration::from_secs(2),
        "Code Mode runtime warmup exceeded two seconds: {elapsed:?}"
    );
}

#[derive(Debug, Clone, PartialEq)]
struct RecordedToolCall {
    name: String,
    kind: ToolKind,
    input: Option<Value>,
}

#[derive(Default)]
struct RecordingDelegate {
    calls: Arc<Mutex<Vec<RecordedToolCall>>>,
    notifications: Arc<Mutex<Vec<String>>>,
}

struct PanickingDelegate;

#[derive(Default)]
struct CancellationSettlingDelegate {
    started_calls: Arc<AtomicUsize>,
    settled_calls: Arc<AtomicUsize>,
}

impl CancellationSettlingDelegate {
    fn started_calls(&self) -> usize {
        self.started_calls.load(Ordering::SeqCst)
    }

    fn settled_calls(&self) -> usize {
        self.settled_calls.load(Ordering::SeqCst)
    }
}

impl ToolDelegate for PanickingDelegate {
    fn invoke(
        &self,
        _call: NestedToolCall,
        _cancellation: watch::Receiver<bool>,
    ) -> DelegateFuture<Value> {
        Box::pin(async { panic!("tool callback panic probe") })
    }

    fn notify(
        &self,
        _call_id: String,
        _cell_id: CellId,
        _text: String,
        _cancellation: watch::Receiver<bool>,
    ) -> DelegateFuture<()> {
        Box::pin(async { panic!("notification callback panic probe") })
    }
}

impl ToolDelegate for CancellationSettlingDelegate {
    fn invoke(
        &self,
        _call: NestedToolCall,
        mut cancellation: watch::Receiver<bool>,
    ) -> DelegateFuture<Value> {
        let started_calls = Arc::clone(&self.started_calls);
        let settled_calls = Arc::clone(&self.settled_calls);
        Box::pin(async move {
            started_calls.fetch_add(1, Ordering::SeqCst);
            while !*cancellation.borrow() {
                cancellation
                    .changed()
                    .await
                    .map_err(|_| "tool cancellation channel closed".to_string())?;
            }
            settled_calls.fetch_add(1, Ordering::SeqCst);
            Err("nested tool call was cancelled".into())
        })
    }

    fn notify(
        &self,
        _call_id: String,
        _cell_id: CellId,
        _text: String,
        _cancellation: watch::Receiver<bool>,
    ) -> DelegateFuture<()> {
        Box::pin(async { Ok(()) })
    }
}

impl RecordingDelegate {
    fn calls(&self) -> Vec<RecordedToolCall> {
        self.calls.lock().expect("tool calls lock").clone()
    }

    fn notifications(&self) -> Vec<String> {
        self.notifications
            .lock()
            .expect("notifications lock")
            .clone()
    }
}

impl ToolDelegate for RecordingDelegate {
    fn invoke(
        &self,
        call: NestedToolCall,
        _cancellation: watch::Receiver<bool>,
    ) -> DelegateFuture<Value> {
        let calls = Arc::clone(&self.calls);
        Box::pin(async move {
            calls
                .lock()
                .map_err(|error| error.to_string())?
                .push(RecordedToolCall {
                    name: call.name,
                    kind: call.kind,
                    input: call.input.clone(),
                });
            Ok(call.input.unwrap_or(Value::Null))
        })
    }

    fn notify(
        &self,
        _call_id: String,
        _cell_id: CellId,
        text: String,
        _cancellation: watch::Receiver<bool>,
    ) -> DelegateFuture<()> {
        let notifications = Arc::clone(&self.notifications);
        Box::pin(async move {
            notifications
                .lock()
                .map_err(|error| error.to_string())?
                .push(text);
            Ok(())
        })
    }
}

#[derive(Clone)]
struct TestSession {
    runtime: CodeModeSession,
    delegate: Arc<dyn ToolDelegate>,
    cancellation: watch::Receiver<bool>,
}

impl TestSession {
    async fn execute(&self, request: ExecuteRequest) -> Result<RuntimeResponse, CodeModeError> {
        self.execute_for("test-turn", request).await
    }

    async fn execute_for(
        &self,
        owner_id: &str,
        request: ExecuteRequest,
    ) -> Result<RuntimeResponse, CodeModeError> {
        self.runtime
            .execute(
                owner_id.into(),
                request,
                Arc::clone(&self.delegate),
                self.cancellation.clone(),
            )
            .await
    }

    async fn wait(
        &self,
        cell_id: CellId,
        yield_time_ms: u64,
    ) -> Result<RuntimeResponse, CodeModeError> {
        self.runtime.wait(cell_id, yield_time_ms).await
    }

    async fn terminate(&self, cell_id: CellId) -> Result<RuntimeResponse, CodeModeError> {
        self.runtime.terminate(cell_id).await
    }

    async fn shutdown(&self) {
        self.runtime.shutdown().await;
    }

    async fn cancel_owner(&self, owner_id: &str) {
        self.runtime.cancel_owner(owner_id).await;
    }
}

fn session(delegate: Arc<dyn ToolDelegate>) -> (TestSession, watch::Sender<bool>) {
    let (cancellation, receiver) = watch::channel(false);
    (
        TestSession {
            runtime: CodeModeSession::new(),
            delegate,
            cancellation: receiver,
        },
        cancellation,
    )
}

fn request(source: impl Into<String>) -> ExecuteRequest {
    ExecuteRequest {
        call_id: "call-1".into(),
        enabled_tools: Vec::new(),
        source: source.into(),
        yield_time_ms: TEST_YIELD_MILLISECONDS,
        max_output_tokens: 10_000,
    }
}

async fn execute(session: &TestSession, request: ExecuteRequest) -> RuntimeResponse {
    tokio::time::timeout(TEST_TIMEOUT, session.execute(request))
        .await
        .expect("Code Mode execution timed out")
        .expect("Code Mode execution should start")
}

async fn shutdown(session: &TestSession) {
    tokio::time::timeout(TEST_TIMEOUT, session.shutdown())
        .await
        .expect("Code Mode shutdown timed out");
}

fn completed(response: RuntimeResponse) -> (Vec<FunctionCallOutputContent>, Option<String>) {
    match response {
        RuntimeResponse::Completed { content, error, .. } => (content, error),
        response => panic!("expected completed Code Mode response, got {response:?}"),
    }
}

fn yielded(response: RuntimeResponse) -> (CellId, Vec<FunctionCallOutputContent>) {
    match response {
        RuntimeResponse::Yielded { cell_id, content } => (cell_id, content),
        response => panic!("expected yielded Code Mode response, got {response:?}"),
    }
}

fn content_json(content: Vec<FunctionCallOutputContent>) -> Value {
    serde_json::to_value(content).expect("Code Mode content should serialize")
}

#[tokio::test]
async fn evaluates_async_modules_in_a_restricted_global_scope() {
    let delegate = Arc::new(RecordingDelegate::default());
    let (session, _cancellation) = session(delegate);
    let response = execute(
        &session,
        request(
            r#"
await Promise.resolve();
text({
  process: typeof process,
  require: typeof require,
  fetch: typeof fetch,
  console: typeof console,
  atomics: typeof Atomics,
  sharedArrayBuffer: typeof SharedArrayBuffer,
  webAssembly: typeof WebAssembly,
  tools: typeof tools,
  allTools: Array.isArray(ALL_TOOLS),
});
"#,
        ),
    )
    .await;
    let (content, error) = completed(response);

    assert_eq!(error, None);
    assert_eq!(
        content_json(content),
        json!([{
            "type": "input_text",
            "text": "{\"process\":\"undefined\",\"require\":\"undefined\",\"fetch\":\"undefined\",\"console\":\"undefined\",\"atomics\":\"undefined\",\"sharedArrayBuffer\":\"undefined\",\"webAssembly\":\"undefined\",\"tools\":\"object\",\"allTools\":true}"
        }])
    );
    shutdown(&session).await;
}

#[tokio::test]
async fn invokes_function_and_freeform_tools_with_typed_inputs() {
    let delegate = Arc::new(RecordingDelegate::default());
    let (session, _cancellation) = session(delegate.clone());
    let mut execution = request(
        r#"
const objectResult = await tools.echo({ value: 42 });
const stringResult = await tools.patch("hello");
text({ objectResult, stringResult, names: ALL_TOOLS.map((tool) => tool.name) });
"#,
    );
    execution.enabled_tools = vec![
        ToolDefinition {
            name: "echo".into(),
            description: "Echo an object".into(),
            kind: ToolKind::Function,
            input_schema: None,
            output_schema: None,
        },
        ToolDefinition {
            name: "patch".into(),
            description: "Apply a patch".into(),
            kind: ToolKind::Freeform,
            input_schema: None,
            output_schema: None,
        },
    ];
    let (content, error) = completed(execute(&session, execution).await);

    assert_eq!(error, None);
    assert_eq!(
        delegate.calls(),
        vec![
            RecordedToolCall {
                name: "echo".into(),
                kind: ToolKind::Function,
                input: Some(json!({ "value": 42 })),
            },
            RecordedToolCall {
                name: "patch".into(),
                kind: ToolKind::Freeform,
                input: Some(json!("hello")),
            },
        ]
    );
    assert_eq!(
        content_json(content),
        json!([{
            "type": "input_text",
            "text": "{\"objectResult\":{\"value\":42},\"stringResult\":\"hello\",\"names\":[\"echo\",\"patch\"]}"
        }])
    );
    shutdown(&session).await;
}

#[tokio::test]
async fn yields_explicitly_and_resumes_the_same_cell() {
    let delegate = Arc::new(RecordingDelegate::default());
    let (session, _cancellation) = session(delegate);
    let mut execution = request(
        r#"
text("before");
yield_control();
await new Promise((resolve) => setTimeout(resolve, 10));
text("after");
"#,
    );
    execution.yield_time_ms = 60_000;
    let (cell_id, content) = yielded(execute(&session, execution).await);
    assert_eq!(
        content_json(content),
        json!([{ "type": "input_text", "text": "before" }])
    );

    let response = tokio::time::timeout(TEST_TIMEOUT, session.wait(cell_id.clone(), 1_000))
        .await
        .expect("Code Mode wait timed out")
        .expect("yielded cell should exist");
    let (content, error) = completed(response);
    assert_eq!(error, None);
    assert_eq!(
        content_json(content),
        json!([{ "type": "input_text", "text": "after" }])
    );
    assert!(session.wait(cell_id, 0).await.is_err());
    shutdown(&session).await;
}

#[tokio::test]
async fn notification_yields_immediately_and_is_delivered_once() {
    let delegate = Arc::new(RecordingDelegate::default());
    let (session, _cancellation) = session(delegate.clone());
    let mut execution = request(
        r#"
notify("progress");
await new Promise((resolve) => setTimeout(resolve, 10));
text("done");
"#,
    );
    execution.yield_time_ms = 60_000;
    let (cell_id, content) = yielded(execute(&session, execution).await);
    assert_eq!(
        content_json(content),
        json!([{ "type": "input_text", "text": "progress" }])
    );

    let (content, error) = completed(
        tokio::time::timeout(TEST_TIMEOUT, session.wait(cell_id, 1_000))
            .await
            .expect("Code Mode wait timed out")
            .expect("notifying cell should exist"),
    );
    assert_eq!(error, None);
    assert_eq!(
        content_json(content),
        json!([{ "type": "input_text", "text": "done" }])
    );
    assert_eq!(delegate.notifications(), vec!["progress"]);
    shutdown(&session).await;
}

#[tokio::test]
async fn commits_stored_values_only_after_successful_completion() {
    let delegate = Arc::new(RecordingDelegate::default());
    let (session, _cancellation) = session(delegate);
    let (_, error) =
        completed(execute(&session, request(r#"store("answer", { value: 42 });"#)).await);
    assert_eq!(error, None);

    let (_, error) = completed(
        execute(
            &session,
            request(r#"store("answer", { value: 99 }); throw new Error("rollback");"#),
        )
        .await,
    );
    assert!(error.is_some_and(|error| error.contains("rollback")));

    let (content, error) = completed(execute(&session, request(r#"text(load("answer"));"#)).await);
    assert_eq!(error, None);
    assert_eq!(
        content_json(content),
        json!([{ "type": "input_text", "text": "{\"value\":42}" }])
    );
    shutdown(&session).await;
}

#[tokio::test]
async fn exit_completes_successfully_and_skips_following_statements() {
    let delegate = Arc::new(RecordingDelegate::default());
    let (session, _cancellation) = session(delegate);
    let (content, error) = completed(
        execute(
            &session,
            request(r#"text("before"); exit(); text("after");"#),
        )
        .await,
    );

    assert_eq!(error, None);
    assert_eq!(
        content_json(content),
        json!([{ "type": "input_text", "text": "before" }])
    );
    shutdown(&session).await;
}

#[tokio::test]
async fn rejects_static_and_dynamic_imports() {
    for source in [
        r#"import value from "node:fs"; text(value);"#,
        r#"await import("node:fs");"#,
    ] {
        let delegate = Arc::new(RecordingDelegate::default());
        let (session, _cancellation) = session(delegate);
        let (content, error) = completed(execute(&session, request(source)).await);

        assert!(content.is_empty());
        assert!(error.is_some_and(|error| error.contains("Unsupported import in exec: node:fs")));
        shutdown(&session).await;
    }
}

#[tokio::test]
async fn emits_structured_image_and_audio_content_without_remote_urls() {
    let delegate = Arc::new(RecordingDelegate::default());
    let (session, _cancellation) = session(delegate);
    let (content, error) = completed(
        execute(
            &session,
            request(
                r#"
image("data:image/png;base64,AAA", "original");
audio({ audio_url: "data:audio/wav;base64,YXVkaW8=" });
generatedImage({ image_url: "data:image/png;base64,BBB", output_hint: "save hint" });
"#,
            ),
        )
        .await,
    );
    assert_eq!(error, None);
    assert_eq!(
        content_json(content),
        json!([
            { "type": "input_image", "image_url": "data:image/png;base64,AAA", "detail": "original" },
            { "type": "input_audio", "audio_url": "data:audio/wav;base64,YXVkaW8=" },
            { "type": "input_image", "image_url": "data:image/png;base64,BBB", "detail": "high" },
            { "type": "input_text", "text": "save hint" }
        ])
    );

    let (content, error) = completed(
        execute(
            &session,
            request(r#"image("https://example.com/image.png");"#),
        )
        .await,
    );
    assert!(content.is_empty());
    assert!(error.is_some_and(|error| error.contains("remote image URLs are not supported")));
    shutdown(&session).await;
}

#[tokio::test]
async fn enforces_request_and_output_limits_without_poisoning_the_session() {
    let delegate = Arc::new(RecordingDelegate::default());
    let (session, _cancellation) = session(delegate);
    let oversized_source = "x".repeat(super::types::MAX_SOURCE_BYTES + 1);
    let error = session
        .execute(request(oversized_source))
        .await
        .expect_err("oversized source must fail before V8 startup");
    assert!(error.to_string().contains("source exceeds"));

    let mut too_many_tools = request("text('never')");
    too_many_tools.enabled_tools = (0..=super::types::MAX_ENABLED_TOOLS)
        .map(|index| ToolDefinition {
            name: format!("tool_{index}"),
            description: String::new(),
            kind: ToolKind::Function,
            input_schema: None,
            output_schema: None,
        })
        .collect();
    let error = session
        .execute(too_many_tools)
        .await
        .expect_err("too many tools must fail before V8 startup");
    assert!(error.to_string().contains("nested tools"));

    let (content, error) = completed(
        execute(
            &session,
            request("for (let index = 0; index < 300; index += 1) text(index);"),
        )
        .await,
    );
    assert_eq!(content.len(), super::types::MAX_CELL_OUTPUT_ITEMS);
    assert!(error.is_some_and(|error| error.contains("output exceeded")));

    let (content, error) = completed(
        execute(
            &session,
            request(format!(
                "text('x'.repeat({}));",
                super::types::MAX_CELL_OUTPUT_BYTES
            )),
        )
        .await,
    );
    assert!(content.is_empty());
    assert!(error.is_some_and(|error| error.contains("output exceeded")));

    let (content, error) = completed(execute(&session, request("text('healthy');")).await);
    assert_eq!(error, None);
    assert_eq!(
        content_json(content),
        json!([{ "type": "input_text", "text": "healthy" }])
    );
    shutdown(&session).await;
}

#[tokio::test]
async fn bounds_unawaited_nested_tool_calls_inside_the_isolate() {
    let delegate = Arc::new(RecordingDelegate::default());
    let (session, _cancellation) = session(delegate);
    let mut execution =
        request("for (let index = 0; index < 65; index += 1) tools.echo({ index });");
    execution.enabled_tools = vec![ToolDefinition {
        name: "echo".into(),
        description: "Echo an object".into(),
        kind: ToolKind::Function,
        input_schema: None,
        output_schema: None,
    }];
    let (content, error) = completed(execute(&session, execution).await);

    assert!(content.is_empty());
    assert!(error.is_some_and(|error| error.contains("concurrent calls exceeded")));
    shutdown(&session).await;
}

#[tokio::test]
async fn cell_completion_settles_unawaited_nested_tool_callbacks() {
    let delegate = Arc::new(CancellationSettlingDelegate::default());
    let (session, _cancellation) = session(delegate.clone());
    let mut execution = request(
        r#"
tools.read({ path: "Icon.tsx" });
tools.read({ path: "Icon.tsx" });
tools.read({ path: "Timeline.tsx" });
yield_control();
await new Promise((resolve) => setTimeout(resolve, 1));
"#,
    );
    execution.enabled_tools = vec![ToolDefinition {
        name: "read".into(),
        description: "Read a file".into(),
        kind: ToolKind::Function,
        input_schema: None,
        output_schema: None,
    }];

    let (cell_id, content) = yielded(execute(&session, execution).await);
    assert!(content.is_empty());
    tokio::time::timeout(TEST_TIMEOUT, async {
        while delegate.started_calls() != 3 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("all nested tool callbacks should start before resuming the cell");

    let response =
        tokio::time::timeout(TEST_TIMEOUT, session.wait(cell_id, TEST_YIELD_MILLISECONDS))
            .await
            .expect("Code Mode completion timed out")
            .expect("Code Mode cell should remain observable");
    let (content, error) = completed(response);

    assert!(content.is_empty());
    assert_eq!(error, None);
    assert_eq!(delegate.started_calls(), 3);
    assert_eq!(delegate.settled_calls(), 3);
    shutdown(&session).await;
}

#[tokio::test]
async fn owner_cancellation_settles_active_nested_tool_callbacks() {
    let delegate = Arc::new(CancellationSettlingDelegate::default());
    let (session, _cancellation) = session(delegate.clone());
    let mut execution = request("await tools.read({ path: \"Icon.tsx\" });");
    execution.yield_time_ms = 0;
    execution.enabled_tools = vec![ToolDefinition {
        name: "read".into(),
        description: "Read a file".into(),
        kind: ToolKind::Function,
        input_schema: None,
        output_schema: None,
    }];

    let (cell_id, content) = yielded(execute(&session, execution).await);
    assert!(content.is_empty());
    tokio::time::timeout(TEST_TIMEOUT, async {
        while delegate.started_calls() != 1 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the nested tool callback should start before owner cancellation");

    tokio::time::timeout(TEST_TIMEOUT, session.cancel_owner("test-turn"))
        .await
        .expect("owner cancellation timed out");

    assert_eq!(delegate.started_calls(), 1);
    assert_eq!(delegate.settled_calls(), 1);
    assert!(session.wait(cell_id, 0).await.is_err());
    shutdown(&session).await;
}

#[tokio::test]
async fn callback_panics_are_contained_without_stranding_javascript_promises() {
    let delegate = Arc::new(PanickingDelegate);
    let (session, _cancellation) = session(delegate);
    let mut tool_execution = request(
        r#"
try {
  await tools.panic({});
} catch (error) {
  text(String(error));
}
"#,
    );
    tool_execution.enabled_tools = vec![ToolDefinition {
        name: "panic".into(),
        description: "Panic probe".into(),
        kind: ToolKind::Function,
        input_schema: None,
        output_schema: None,
    }];
    let (content, error) = completed(execute(&session, tool_execution).await);
    assert_eq!(error, None);
    assert!(
        content_json(content)
            .to_string()
            .contains("tool callback panicked")
    );

    let mut notification = request(
        r#"
notify("progress");
await Promise.resolve();
text("done");
"#,
    );
    notification.yield_time_ms = 60_000;
    let (cell_id, content) = yielded(execute(&session, notification).await);
    assert_eq!(
        content_json(content),
        json!([{ "type": "input_text", "text": "progress" }])
    );
    let (content, error) = completed(
        session
            .wait(cell_id, 1_000)
            .await
            .expect("notification panic must not poison the cell"),
    );
    assert_eq!(error, None);
    assert_eq!(
        content_json(content),
        json!([{ "type": "input_text", "text": "done" }])
    );
    shutdown(&session).await;
}

#[tokio::test]
async fn shutdown_interrupts_a_cpu_bound_yielded_cell() {
    let delegate = Arc::new(RecordingDelegate::default());
    let (session, _cancellation) = session(delegate);
    let mut execution = request("while (true) {}");
    execution.yield_time_ms = 0;
    let (cell_id, _) = yielded(execute(&session, execution).await);

    shutdown(&session).await;
    assert!(session.wait(cell_id, 0).await.is_err());
}

#[tokio::test]
async fn a_second_observer_cannot_displace_the_first() {
    let delegate = Arc::new(RecordingDelegate::default());
    let (session, cancellation) = session(delegate);
    let mut execution = request("await new Promise(() => {});");
    execution.yield_time_ms = 0;
    let (cell_id, _) = yielded(execute(&session, execution).await);

    let waiting_session = session.clone();
    let waiting_cell_id = cell_id.clone();
    let first_observer =
        tokio::spawn(async move { waiting_session.wait(waiting_cell_id, 60_000).await });
    tokio::time::sleep(Duration::from_millis(25)).await;
    let error = session
        .wait(cell_id, 0)
        .await
        .expect_err("a second observer must fail closed");
    assert!(error.to_string().contains("active observer"));

    cancellation.send_replace(true);
    let response = tokio::time::timeout(TEST_TIMEOUT, first_observer)
        .await
        .expect("first observer should be released by cancellation")
        .expect("observer task should not panic")
        .expect("observer should receive termination");
    assert!(matches!(response, RuntimeResponse::Terminated { .. }));
    shutdown(&session).await;
}

#[tokio::test]
async fn termination_preempts_an_active_observer_and_resolves_both_callers() {
    let delegate = Arc::new(RecordingDelegate::default());
    let (session, _cancellation) = session(delegate);
    let mut execution = request("await new Promise(() => {});");
    execution.yield_time_ms = 0;
    let (cell_id, _) = yielded(execute(&session, execution).await);

    let waiting_session = session.clone();
    let waiting_cell_id = cell_id.clone();
    let observer = tokio::spawn(async move { waiting_session.wait(waiting_cell_id, 60_000).await });
    tokio::time::sleep(Duration::from_millis(25)).await;
    assert!(matches!(
        session
            .wait(cell_id.clone(), 0)
            .await
            .expect_err("the first observer must own the cell"),
        CodeModeError::BusyCell(_)
    ));

    assert!(matches!(
        tokio::time::timeout(TEST_TIMEOUT, session.terminate(cell_id))
            .await
            .expect("termination timed out")
            .expect("termination should resolve"),
        RuntimeResponse::Terminated { .. }
    ));
    assert!(matches!(
        tokio::time::timeout(TEST_TIMEOUT, observer)
            .await
            .expect("observer did not resolve")
            .expect("observer task panicked")
            .expect("observer should receive the terminal response"),
        RuntimeResponse::Terminated { .. }
    ));
    shutdown(&session).await;
}

#[tokio::test]
async fn session_state_persists_across_turns_and_owner_cancellation_is_scoped() {
    let delegate = Arc::new(RecordingDelegate::default());
    let (session, _cancellation) = session(delegate);

    let (content, error) = completed(
        session
            .execute_for("turn-a", request("store('shared', { value: 7 });"))
            .await
            .expect("first turn should execute"),
    );
    assert!(content.is_empty());
    assert_eq!(error, None);

    let (content, error) = completed(
        session
            .execute_for("turn-b", request("text(load('shared'));"))
            .await
            .expect("second turn should execute"),
    );
    assert_eq!(error, None);
    assert_eq!(
        content_json(content),
        json!([{ "type": "input_text", "text": "{\"value\":7}" }])
    );

    let mut first = request("while (true) {}");
    first.yield_time_ms = 0;
    let first_cell = yielded(
        session
            .execute_for("turn-a", first)
            .await
            .expect("first owner cell should start"),
    )
    .0;
    let mut second = request("while (true) {}");
    second.yield_time_ms = 0;
    let second_cell = yielded(
        session
            .execute_for("turn-b", second)
            .await
            .expect("second owner cell should start"),
    )
    .0;

    tokio::time::timeout(TEST_TIMEOUT, session.cancel_owner("turn-a"))
        .await
        .expect("owner cancellation should complete");
    assert!(session.wait(first_cell, 0).await.is_err());
    assert!(matches!(
        session
            .wait(second_cell, 0)
            .await
            .expect("the other owner must remain active"),
        RuntimeResponse::Yielded { .. }
    ));

    session.cancel_owner("turn-b").await;
    shutdown(&session).await;
}
