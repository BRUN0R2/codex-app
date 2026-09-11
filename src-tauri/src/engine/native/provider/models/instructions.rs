use super::SelectedModel;
use crate::engine::{ApprovalPolicy, ConversationMode, PermissionProfile, SandboxMode};

// The catalog owns model behavior; these defaults describe this runtime. As in
// Codex Core, a missing section selects its default and an empty section disables it.
const DEFAULT_COLLABORATION: &str = "# Collaboration Mode: Default\n\nExecute the user's request. Prefer reasonable assumptions and continuing work to stopping for questions.\n\nUse `request_user_input` only when available, for optional clarification that materially improves the result. If it returns no answer, continue with best judgment. Never use it to request permission or escalate approvals.\n\nWhen progress requires explicit user input for another reason, ask one concise plain-text question directly. Do not write multiple-choice options in a text message.";

impl SelectedModel {
    pub fn collaboration_context(&self, mode: ConversationMode) -> Option<&str> {
        if mode == ConversationMode::Chat {
            return None;
        }
        let instruction = self
            .model_messages
            .as_ref()
            .and_then(|messages| messages.collaboration_modes.as_ref())
            .and_then(|modes| modes.default.as_deref())
            .unwrap_or(DEFAULT_COLLABORATION);
        (!instruction.trim().is_empty()).then_some(instruction)
    }

    pub fn permissions_context(&self, profile: PermissionProfile) -> Option<String> {
        let permissions = self
            .model_messages
            .as_ref()
            .and_then(|messages| messages.permissions.as_ref());
        let approvals = self
            .model_messages
            .as_ref()
            .and_then(|messages| messages.approvals.as_ref());
        let sandbox = permissions
            .and_then(|permissions| match profile.sandbox {
                SandboxMode::ReadOnly => permissions.read_only.as_deref(),
                SandboxMode::WorkspaceWrite => permissions.workspace_write.as_deref(),
                SandboxMode::DangerFullAccess => permissions.danger_full_access.as_deref(),
            })
            .unwrap_or_else(|| sandbox_instructions(profile.sandbox));
        let approval = approvals
            .and_then(|approvals| match profile.approvals {
                ApprovalPolicy::Untrusted => approvals.unless_trusted.as_deref(),
                ApprovalPolicy::OnRequest => approvals.on_request.as_deref(),
                ApprovalPolicy::Never => approvals.never.as_deref(),
            })
            .unwrap_or_else(|| approval_instructions(profile.approvals));
        let sections = [sandbox, approval]
            .into_iter()
            .filter(|section| !section.trim().is_empty())
            .map(|section| section.replace("{{ network_access }}", "enabled"))
            .collect::<Vec<_>>();
        (!sections.is_empty()).then(|| sections.join("\n\n"))
    }
}

const fn sandbox_instructions(sandbox: SandboxMode) -> &'static str {
    match sandbox {
        SandboxMode::ReadOnly => {
            "The permission profile is read-only. File tools can read within the workspace. File mutations and shell commands are unavailable. Network access is enabled."
        }
        SandboxMode::WorkspaceWrite => {
            "The permission profile is workspace-write. File tools can read and edit within the workspace. Shell commands require approval and run without an operating-system filesystem sandbox. Network access is enabled."
        }
        SandboxMode::DangerFullAccess => {
            "The permission profile is danger-full-access. Shell commands run without filesystem sandboxing or command approval. File tools still require workspace-relative paths. Network access is enabled."
        }
    }
}

const fn approval_instructions(approvals: ApprovalPolicy) -> &'static str {
    match approvals {
        ApprovalPolicy::Untrusted => {
            "The application handles approval for available tools. The current read-only profile does not allow shell execution or file mutations."
        }
        ApprovalPolicy::OnRequest => {
            "Submit commands through the available command tool. The application presents the command and its reason for approval before execution; do not request that approval again in a chat message."
        }
        ApprovalPolicy::Never => {
            "Approval policy is never. The available tools do not accept sandbox_permissions or escalation parameters. Complete authorized work with the granted access."
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::{ModelCatalog, ModelsWire};
    use super::*;

    fn model(messages: serde_json::Value) -> SelectedModel {
        let wire: ModelsWire = serde_json::from_value(serde_json::json!({
            "models": [{
                "slug": "test-model", "display_name": "Test", "visibility": "list",
                "priority": 0, "supported_reasoning_levels": [],
                "base_instructions": "Model instructions.", "model_messages": messages
            }]
        }))
        .expect("model should decode");
        ModelCatalog::from_wire(wire, 1)
            .expect("catalog should validate")
            .select_for_account(None, true)
            .expect("model should resolve")
    }

    #[test]
    fn missing_catalog_sections_receive_native_runtime_context() {
        for messages in [
            serde_json::Value::Null,
            serde_json::json!({
                "instructions_template": "Canonical instructions.",
                "permissions": null, "approvals": null, "collaboration_modes": null
            }),
        ] {
            let model = model(messages);
            assert_eq!(
                model.collaboration_context(ConversationMode::Codex),
                Some(DEFAULT_COLLABORATION)
            );
            assert_eq!(
                model.collaboration_context(ConversationMode::Work),
                Some(DEFAULT_COLLABORATION)
            );
            assert_eq!(model.collaboration_context(ConversationMode::Chat), None);
            for profile in [
                PermissionProfile::read_only(),
                PermissionProfile::workspace_write(),
                PermissionProfile::full_access(),
            ] {
                let context = model
                    .permissions_context(profile)
                    .expect("runtime facts are required");
                assert!(context.contains(sandbox_instructions(profile.sandbox)));
                assert!(context.contains(approval_instructions(profile.approvals)));
            }
        }
    }

    #[test]
    fn explicit_empty_sections_suppress_defaults_independently() {
        let model = model(serde_json::json!({
            "instructions_template": "Canonical instructions.",
            "permissions": { "workspace_write": "" },
            "approvals": { "on_request": "" },
            "collaboration_modes": { "default": "" }
        }));
        assert_eq!(
            model.permissions_context(PermissionProfile::workspace_write()),
            None
        );
        assert_eq!(model.collaboration_context(ConversationMode::Work), None);
        assert!(
            model
                .permissions_context(PermissionProfile::full_access())
                .is_some()
        );
    }

    #[test]
    fn supplied_section_overrides_only_its_own_default() {
        let model = model(serde_json::json!({
            "instructions_template": "Canonical instructions.",
            "permissions": { "workspace_write": "Catalog permissions; network {{ network_access }}." },
            "approvals": null
        }));
        assert_eq!(
            model.permissions_context(PermissionProfile::workspace_write()),
            Some(format!(
                "Catalog permissions; network enabled.\n\n{}",
                approval_instructions(ApprovalPolicy::OnRequest)
            ))
        );
    }
}
