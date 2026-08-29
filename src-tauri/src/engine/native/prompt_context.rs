use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use chrono::{FixedOffset, Utc};

use super::multi_agent::MultiAgentPromptContext;
use super::provider::{ResponseItem, SelectedModel};
use crate::engine::{AppConfig, ApprovalPolicy, ConversationMode, Personality, SandboxMode};
use crate::error::AppError;

const PROJECT_INSTRUCTIONS_MAX_BYTES: u64 = 32 * 1_024;
const PROMPT_CONTEXT_MAX_BYTES: usize = 512 * 1_024;
const PROJECT_INSTRUCTIONS_FILE: &str = "AGENTS.md";
const PROJECT_INSTRUCTIONS_OVERRIDE_FILE: &str = "AGENTS.override.md";

pub(super) struct PromptContext {
    items: Vec<ResponseItem>,
}

impl PromptContext {
    pub(super) fn items(&self) -> &[ResponseItem] {
        &self.items
    }
}

pub(super) async fn compose_prompt_context(
    workspace: &Path,
    config: &AppConfig,
    mode: ConversationMode,
    model: &SelectedModel,
    multi_agent: Option<&MultiAgentPromptContext>,
    timezone: &str,
    timezone_offset_min: i32,
) -> Result<PromptContext, AppError> {
    let mut builder = PromptContextBuilder::default();

    if let Some(instructions) = config
        .developer_instructions
        .as_deref()
        .map(str::trim)
        .filter(|instructions| !instructions.is_empty())
    {
        builder.push(
            "developer",
            instructions.to_string(),
            "generic.developer_instructions",
        )?;
    }
    let personality = (!model.personality_is_baked())
        .then(|| {
            model.personality_context(config.personality).or_else(|| {
                model
                    .uses_legacy_instruction_contract()
                    .then(|| personality_instruction(config.personality))
                    .flatten()
            })
        })
        .flatten();
    if let Some(personality) = personality {
        builder.push(
            "developer",
            format!(
                "<personality_spec>\n The user has requested a new communication style. Future messages should adhere to the following personality: \n{personality} \n</personality_spec>"
            ),
            "personality.spec_instructions",
        )?;
    }
    if let Some(project_instructions) = load_project_instructions(workspace).await? {
        builder.push(
            "user",
            format!(
                "# AGENTS.md instructions for {}\n\n<INSTRUCTIONS>\n{}\n</INSTRUCTIONS>",
                workspace.display(),
                project_instructions
            ),
            "agents_md.instructions",
        )?;
    }
    if let Some(permissions) = model.permissions_context(config.permission_profile) {
        builder.push(
            "developer",
            format!("<permissions instructions>\n{permissions}\n</permissions instructions>"),
            "permissions.instructions",
        )?;
    }
    if let Some(collaboration) = model.collaboration_context(mode) {
        builder.push(
            "developer",
            format!("<collaboration_mode>\n{collaboration}\n</collaboration_mode>"),
            "collaboration_mode.instructions",
        )?;
    }
    if let Some(multi_agent) = multi_agent {
        if let Some(role_instructions) = multi_agent.rendered_role_instructions() {
            builder.push(
                "developer",
                role_instructions,
                "multi_agent.role_instructions",
            )?;
        }
        if let Some(mode_instructions) = multi_agent.mode_instructions.as_ref() {
            builder.push(
                "developer",
                format!("<multi_agent_mode>{mode_instructions}</multi_agent_mode>"),
                "multi_agent.mode_instructions",
            )?;
        }
    }
    let shell_version = crate::process::shell_version().await;
    builder.push(
        "user",
        environment_context(
            workspace,
            config,
            timezone,
            timezone_offset_min,
            shell_version.as_deref(),
            Utc::now(),
        )?,
        "environments.environment_context",
    )?;

    Ok(PromptContext {
        items: builder.items,
    })
}

#[derive(Default)]
struct PromptContextBuilder {
    items: Vec<ResponseItem>,
    bytes: usize,
}

impl PromptContextBuilder {
    fn push(&mut self, role: &str, text: String, content_kind: &str) -> Result<(), AppError> {
        self.bytes = self
            .bytes
            .checked_add(text.len())
            .ok_or_else(|| AppError::Protocol("prompt context byte count overflowed".into()))?;
        if self.bytes > PROMPT_CONTEXT_MAX_BYTES {
            return Err(AppError::Protocol(format!(
                "prompt context exceeds {PROMPT_CONTEXT_MAX_BYTES} bytes"
            )));
        }
        self.items
            .push(ResponseItem::context_text(role, text, content_kind));
        Ok(())
    }
}

async fn load_project_instructions(workspace: &Path) -> Result<Option<String>, AppError> {
    let workspace = tokio::fs::canonicalize(workspace)
        .await
        .map_err(|error| file_error("resolve workspace for", workspace, error))?;
    let project_root = find_project_root(&workspace).await?;
    let mut directories = workspace
        .ancestors()
        .take_while(|directory| *directory != project_root.as_path())
        .map(Path::to_path_buf)
        .collect::<Vec<_>>();
    directories.push(project_root);
    directories.reverse();

    let mut loaded = Vec::new();
    let mut remaining = PROJECT_INSTRUCTIONS_MAX_BYTES;
    for directory in directories {
        let Some(text) = load_directory_instructions(&directory, remaining).await? else {
            continue;
        };
        remaining = remaining.checked_sub(text.len() as u64).ok_or_else(|| {
            AppError::Protocol("project instruction byte budget underflowed".into())
        })?;
        if !text.is_empty() {
            loaded.push(text);
        }
    }

    Ok((!loaded.is_empty()).then(|| loaded.join("\n\n")))
}

async fn find_project_root(workspace: &Path) -> Result<PathBuf, AppError> {
    for directory in workspace.ancestors() {
        let marker = directory.join(".git");
        match tokio::fs::symlink_metadata(&marker).await {
            Ok(_) => return Ok(directory.to_path_buf()),
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(file_error("inspect project marker for", &marker, error)),
        }
    }
    Ok(workspace.to_path_buf())
}

async fn load_directory_instructions(
    directory: &Path,
    remaining: u64,
) -> Result<Option<String>, AppError> {
    for filename in [
        PROJECT_INSTRUCTIONS_OVERRIDE_FILE,
        PROJECT_INSTRUCTIONS_FILE,
    ] {
        let path = directory.join(filename);
        let metadata = match tokio::fs::symlink_metadata(&path).await {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(error) => return Err(file_error("inspect", &path, error)),
        };
        if metadata.file_type().is_symlink() {
            return Err(AppError::FileSystem(format!(
                "project instructions cannot be a symbolic link: {}",
                path.display()
            )));
        }
        if !metadata.is_file() {
            return Err(AppError::FileSystem(format!(
                "project instructions path is not a regular file: {}",
                path.display()
            )));
        }
        if metadata.len() > remaining {
            return Err(AppError::Protocol(format!(
                "project instructions exceed the remaining {remaining}-byte budget: {}",
                path.display(),
            )));
        }
        let bytes = tokio::fs::read(&path)
            .await
            .map_err(|error| file_error("read", &path, error))?;
        if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > remaining {
            return Err(AppError::Protocol(format!(
                "project instructions changed while reading and exceed the remaining {remaining}-byte budget: {}",
                path.display(),
            )));
        }
        let text = String::from_utf8(bytes).map_err(|_| {
            AppError::FileSystem(format!(
                "project instructions must contain valid UTF-8: {}",
                path.display()
            ))
        })?;
        let text = text.strip_prefix('\u{feff}').unwrap_or(&text).trim();
        return Ok((!text.is_empty()).then(|| text.to_string()));
    }
    Ok(None)
}

fn file_error(operation: &str, path: &Path, error: std::io::Error) -> AppError {
    AppError::FileSystem(format!(
        "could not {operation} project instructions at {}: {error}",
        path.display()
    ))
}

const fn personality_instruction(personality: Personality) -> Option<&'static str> {
    match personality {
        Personality::Friendly => Some(
            "You optimize for team morale and being a supportive teammate as much as code quality.",
        ),
        Personality::Pragmatic => Some("You are a deeply pragmatic, effective software engineer."),
        Personality::None => None,
    }
}

fn environment_context(
    workspace: &Path,
    config: &AppConfig,
    timezone: &str,
    timezone_offset_min: i32,
    shell_version: Option<&str>,
    now: chrono::DateTime<Utc>,
) -> Result<String, AppError> {
    let offset_seconds = timezone_offset_min
        .checked_mul(60)
        .ok_or_else(|| AppError::Protocol("timezone offset overflowed".into()))?;
    let offset = FixedOffset::west_opt(offset_seconds).ok_or_else(|| {
        AppError::Protocol(format!(
            "timezone offset `{timezone_offset_min}` is outside the supported range"
        ))
    })?;
    let current_date = now.with_timezone(&offset).format("%Y-%m-%d");
    let shell_version = shell_version
        .map(|version| format!("  <shell_version>{}</shell_version>\n", escape_xml(version)))
        .unwrap_or_default();
    Ok(format!(
        "<environment_context>\n  <cwd>{}</cwd>\n  <shell>{}</shell>\n{shell_version}  <current_date>{current_date}</current_date>\n  <timezone>{}</timezone>\n  <filesystem>\n    <sandbox_mode>{}</sandbox_mode>\n    <approval_policy>{}</approval_policy>\n  </filesystem>\n</environment_context>",
        escape_xml(&workspace.display().to_string()),
        crate::process::shell_name(),
        escape_xml(timezone),
        sandbox_name(config.permission_profile.sandbox),
        approval_name(config.permission_profile.approvals),
    ))
}

const fn sandbox_name(sandbox: SandboxMode) -> &'static str {
    match sandbox {
        SandboxMode::ReadOnly => "read-only",
        SandboxMode::WorkspaceWrite => "workspace-write",
        SandboxMode::DangerFullAccess => "danger-full-access",
    }
}

const fn approval_name(approvals: ApprovalPolicy) -> &'static str {
    match approvals {
        ApprovalPolicy::Untrusted => "untrusted",
        ApprovalPolicy::OnRequest => "on-request",
        ApprovalPolicy::Never => "never",
    }
}

fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(test)]
mod tests {
    use std::fs;

    use chrono::TimeZone as _;
    use tempfile::tempdir;

    use super::*;

    fn test_model() -> SelectedModel {
        let wire = serde_json::from_str::<super::super::provider::ModelsWire>(
            r#"{
                "models": [{
                    "slug": "gpt-test",
                    "display_name": "GPT Test",
                    "description": null,
                    "supported_reasoning_levels": [],
                    "visibility": "list",
                    "priority": 0,
                    "service_tiers": [],
                    "default_service_tier": null,
                    "base_instructions": "Base instructions."
                }]
            }"#,
        )
        .expect("model fixture should decode");
        super::super::provider::ModelCatalog::from_wire(wire, 1)
            .expect("model fixture should validate")
            .select(None)
            .expect("default model should resolve")
    }

    fn modern_model_without_instruction_variables() -> SelectedModel {
        let wire = serde_json::from_str::<super::super::provider::ModelsWire>(
            r#"{
                "models": [{
                    "slug": "gpt-modern",
                    "display_name": "GPT Modern",
                    "description": null,
                    "supported_reasoning_levels": [],
                    "visibility": "list",
                    "priority": 0,
                    "service_tiers": [],
                    "default_service_tier": null,
                    "base_instructions": "Legacy instructions.",
                    "model_messages": {
                        "instructions_template": "Canonical instructions.",
                        "instructions_variables": null,
                        "approvals": null,
                        "collaboration_modes": null,
                        "permissions": null
                    }
                }]
            }"#,
        )
        .expect("modern model fixture should decode");
        super::super::provider::ModelCatalog::from_wire(wire, 1)
            .expect("modern model fixture should validate")
            .select(None)
            .expect("default model should resolve")
    }

    #[tokio::test]
    async fn project_override_has_precedence() {
        let directory = tempdir().expect("temporary directory should exist");
        fs::write(directory.path().join(PROJECT_INSTRUCTIONS_FILE), "base")
            .expect("base instructions should be written");
        fs::write(
            directory.path().join(PROJECT_INSTRUCTIONS_OVERRIDE_FILE),
            "override",
        )
        .expect("override instructions should be written");

        let instructions = load_project_instructions(directory.path())
            .await
            .expect("instructions should load");

        assert_eq!(instructions.as_deref(), Some("override"));
    }

    #[tokio::test]
    async fn project_instructions_are_loaded_from_root_to_workspace() {
        let directory = tempdir().expect("temporary directory should exist");
        fs::create_dir(directory.path().join(".git")).expect("project marker should be written");
        fs::write(directory.path().join(PROJECT_INSTRUCTIONS_FILE), "root")
            .expect("root instructions should be written");
        let nested = directory.path().join("src").join("module");
        fs::create_dir_all(&nested).expect("nested workspace should exist");
        fs::write(
            directory.path().join("src").join(PROJECT_INSTRUCTIONS_FILE),
            "child",
        )
        .expect("child instructions should be written");

        let instructions = load_project_instructions(&nested)
            .await
            .expect("instructions should load");

        assert_eq!(instructions.as_deref(), Some("root\n\nchild"));
    }

    #[tokio::test]
    async fn nested_override_replaces_only_the_same_directory_base() {
        let directory = tempdir().expect("temporary directory should exist");
        fs::write(directory.path().join(".git"), "").expect("project marker should be written");
        fs::write(directory.path().join(PROJECT_INSTRUCTIONS_FILE), "root")
            .expect("root instructions should be written");
        let nested = directory.path().join("nested");
        fs::create_dir(&nested).expect("nested workspace should exist");
        fs::write(nested.join(PROJECT_INSTRUCTIONS_FILE), "base")
            .expect("nested base instructions should be written");
        fs::write(nested.join(PROJECT_INSTRUCTIONS_OVERRIDE_FILE), "override")
            .expect("nested override instructions should be written");

        let instructions = load_project_instructions(&nested)
            .await
            .expect("instructions should load");

        assert_eq!(instructions.as_deref(), Some("root\n\noverride"));
    }

    #[tokio::test]
    async fn missing_project_instructions_are_an_explicit_empty_context() {
        let directory = tempdir().expect("temporary directory should exist");

        assert_eq!(
            load_project_instructions(directory.path())
                .await
                .expect("missing instructions should be valid"),
            None
        );
    }

    #[tokio::test]
    async fn oversized_project_instructions_are_rejected() {
        let directory = tempdir().expect("temporary directory should exist");
        fs::write(
            directory.path().join(PROJECT_INSTRUCTIONS_FILE),
            vec![b'x'; PROJECT_INSTRUCTIONS_MAX_BYTES as usize + 1],
        )
        .expect("oversized instructions should be written");

        let error = load_project_instructions(directory.path())
            .await
            .expect_err("oversized instructions must fail");

        assert!(error.to_string().contains("exceed"));
    }

    #[test]
    fn environment_context_uses_the_client_date_and_escapes_values() {
        let now = Utc
            .with_ymd_and_hms(2026, 1, 1, 1, 30, 0)
            .single()
            .expect("fixture date should be valid");
        let context = environment_context(
            Path::new("C:\\work<&>"),
            &AppConfig::default(),
            "America/Fortaleza<&>",
            180,
            Some("7.6<&>"),
            now,
        )
        .expect("environment should render");

        assert!(context.contains("<current_date>2025-12-31</current_date>"));
        assert!(context.contains("C:\\work&lt;&amp;&gt;"));
        assert!(context.contains("America/Fortaleza&lt;&amp;&gt;"));
        assert!(context.contains("<shell_version>7.6&lt;&amp;&gt;</shell_version>"));
        assert!(context.contains("<sandbox_mode>workspace-write</sandbox_mode>"));
    }

    #[tokio::test]
    async fn prompt_context_keeps_model_instructions_out_of_transient_messages() {
        let directory = tempdir().expect("temporary directory should exist");
        let context = compose_prompt_context(
            directory.path(),
            &AppConfig::default(),
            ConversationMode::Codex,
            &test_model(),
            None,
            "UTC",
            0,
        )
        .await
        .expect("prompt context should compose");
        let encoded =
            serde_json::to_string(context.items()).expect("prompt context should serialize");

        assert!(!encoded.contains("Work execution protocol"));
        assert!(!encoded.contains("built-in browser tools"));
        assert!(encoded.contains("environments.environment_context"));
        assert!(encoded.contains("personality.spec_instructions"));
        assert!(encoded.contains("deeply pragmatic"));
    }

    #[tokio::test]
    async fn modern_model_without_variables_does_not_receive_a_local_personality_prompt() {
        let directory = tempdir().expect("temporary directory should exist");
        let context = compose_prompt_context(
            directory.path(),
            &AppConfig::default(),
            ConversationMode::Codex,
            &modern_model_without_instruction_variables(),
            None,
            "UTC",
            0,
        )
        .await
        .expect("prompt context should compose");
        let encoded =
            serde_json::to_string(context.items()).expect("prompt context should serialize");

        assert!(!encoded.contains("personality.spec_instructions"));
        assert!(!encoded.contains("deeply pragmatic"));
        assert!(!encoded.contains("Canonical instructions."));
        assert!(!encoded.contains("Legacy instructions."));
    }
}
