use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tempfile::TempDir;
use tokio::sync::watch;

use super::{NestedToolExecutionGate, freeform_input};
use crate::engine::PermissionProfile;
use crate::engine::native::code_mode::{
    CellId, CodeModeSession, DelegateFuture, ExecuteRequest, NestedToolCall, RuntimeResponse,
    ToolDelegate, ToolKind,
};
use crate::engine::native::tools::{ToolOperation, ToolRegistry, execute_patch_operation};

struct PatchDelegate {
    workspace: PathBuf,
    gate: Arc<NestedToolExecutionGate>,
}

impl ToolDelegate for PatchDelegate {
    fn invoke(
        &self,
        call: NestedToolCall,
        mut cancellation: watch::Receiver<bool>,
    ) -> DelegateFuture<Value> {
        let workspace = self.workspace.clone();
        let gate = Arc::clone(&self.gate);
        Box::pin(async move {
            if call.kind != ToolKind::Freeform {
                return Err("patch must arrive as a freeform call".into());
            }
            let input = freeform_input(&call.name, call.input)?;
            let prepared = ToolRegistry
                .prepare_custom(call.runtime_call_id, &call.name, &input)
                .map_err(|error| error.to_string())?;
            let ToolOperation::ApplyPatch(patch) = &prepared.operation else {
                return Err("expected apply_patch operation".into());
            };
            let permissions = PermissionProfile::full_access();
            let outcome = gate
                .run(
                    &prepared,
                    permissions,
                    execute_patch_operation(
                        &workspace,
                        patch.clone(),
                        permissions,
                        &mut cancellation,
                    ),
                )
                .await
                .map_err(|error| error.to_string())?;
            Ok(Value::String(outcome.output))
        })
    }

    fn notify(
        &self,
        _call_id: String,
        _cell_id: CellId,
        _text: String,
        _cancellation: watch::Receiver<bool>,
    ) -> DelegateFuture<()> {
        Box::pin(async { Err("unexpected notification in patch test".into()) })
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn code_mode_executes_a_multi_file_patch_and_dependent_patch_in_one_cell() {
    let workspace = TempDir::new().expect("workspace should exist");
    std::fs::write(workspace.path().join("existing.txt"), "old\n").expect("source should exist");
    let first = "*** Begin Patch\n*** Add File: new/first.txt\n+first\n*** Add File: new/second.txt\n+second\n*** Update File: existing.txt\n@@\n-old\n+new\n*** End Patch";
    let second =
        "*** Begin Patch\n*** Update File: new/first.txt\n@@\n-first\n+updated\n*** End Patch";
    let registry = ToolRegistry;
    let enabled_tools =
        registry.code_mode_nested_definitions(PermissionProfile::full_access(), false, false);
    let direct = registry
        .definitions()
        .iter()
        .find(|tool| tool["name"] == "apply_patch")
        .expect("direct patch should exist");
    let nested = enabled_tools
        .iter()
        .find(|tool| tool.name == "apply_patch")
        .expect("nested patch should exist");
    assert_eq!(
        nested.description,
        direct["description"]
            .as_str()
            .expect("description should be text")
    );
    assert!(nested.description.contains("one or more files"));
    assert!(
        registry.code_mode_definitions(&enabled_tools, true)[0]["description"]
            .as_str()
            .expect("Code Mode should have a description")
            .contains("apply_patch(input: string): Promise<string>")
    );
    let runtime = CodeModeSession::new();
    let (_sender, cancellation) = watch::channel(false);
    let response = tokio::time::timeout(
        Duration::from_secs(30),
        runtime.execute(
            "patch-turn".into(),
            ExecuteRequest {
                call_id: "patch-cell".into(),
                enabled_tools,
                source: format!(
                    "text(await tools.apply_patch({})); text(await tools.apply_patch({}));",
                    serde_json::to_string(first).expect("patch should encode"),
                    serde_json::to_string(second).expect("patch should encode")
                ),
                yield_time_ms: 30_000,
                max_output_tokens: 1_000,
            },
            Arc::new(PatchDelegate {
                workspace: workspace.path().to_path_buf(),
                gate: Arc::new(NestedToolExecutionGate::default()),
            }),
            cancellation,
        ),
    )
    .await
    .expect("Code Mode should complete promptly")
    .expect("Code Mode should execute");
    let RuntimeResponse::Completed { content, error, .. } = response else {
        panic!("expected completed cell");
    };
    assert!(error.is_none(), "{error:?}");
    assert_eq!(content.len(), 2);
    for (path, expected) in [
        ("new/first.txt", "updated\n"),
        ("new/second.txt", "second\n"),
        ("existing.txt", "new\n"),
    ] {
        assert_eq!(
            std::fs::read_to_string(workspace.path().join(path))
                .expect("patched file should exist"),
            expected
        );
    }
    runtime.shutdown().await;
}
