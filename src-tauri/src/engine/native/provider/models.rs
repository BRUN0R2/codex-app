use std::collections::HashSet;

use serde::Deserialize;
use serde::Deserializer;

use crate::engine::CodexModel;
use crate::engine::ConversationMode;
use crate::engine::ModelContextWindow;
use crate::engine::ModelContextWindowPreference;
use crate::engine::ModelRuntimeCapability;
use crate::engine::ModelServiceTier;
use crate::engine::ModelVerbosity;
use crate::engine::PermissionProfile;
use crate::engine::Personality;
use crate::engine::ReasoningEffort;
use crate::engine::ReasoningEffortOption;
use crate::error::AppError;

use super::super::output_compaction::ProviderOutputBudget;
use super::responses::ReasoningSummarySetting;
use super::responses::ResponseProtocol;
use crate::engine::native::multi_agent::MultiAgentVersion;

const MAX_MODEL_ID_BYTES: usize = 128;
const MAX_MODEL_TEXT_BYTES: usize = 16_384;
const MAX_INSTRUCTIONS_BYTES: usize = 262_144;
const MAX_CONTEXT_WINDOW_TOKENS: u64 = 1_000_000_000;
const DEFAULT_EFFECTIVE_CONTEXT_WINDOW_PERCENT: u8 = 95;
const AUTO_COMPACT_CONTEXT_WINDOW_PERCENT: u64 = 90;
const PERCENT_SCALE: u64 = 100;
const PERSONALITY_PLACEHOLDER: &str = "{{ personality }}";

#[derive(Debug, Deserialize)]
pub struct ModelsWire {
    models: Vec<ModelWire>,
}

#[derive(Debug, Deserialize)]
struct ModelWire {
    slug: String,
    display_name: String,
    description: Option<String>,
    default_reasoning_level: Option<ReasoningEffort>,
    supported_reasoning_levels: Vec<ReasoningPresetWire>,
    visibility: ModelVisibility,
    priority: i32,
    #[serde(default)]
    service_tiers: Vec<ServiceTierWire>,
    default_service_tier: Option<String>,
    #[serde(default)]
    context_window: Option<u64>,
    #[serde(default)]
    max_context_window: Option<u64>,
    #[serde(default)]
    auto_compact_token_limit: Option<u64>,
    #[serde(default = "default_effective_context_window_percent")]
    effective_context_window_percent: u8,
    #[serde(default)]
    use_responses_lite: bool,
    #[serde(default)]
    supports_parallel_tool_calls: bool,
    #[serde(default = "default_true")]
    supports_reasoning_summary_parameter: bool,
    #[serde(default)]
    default_reasoning_summary: ReasoningSummarySetting,
    #[serde(default)]
    support_verbosity: bool,
    #[serde(default)]
    default_verbosity: Option<ModelVerbosity>,
    #[serde(default = "default_input_modalities")]
    input_modalities: Vec<InputModality>,
    #[serde(default)]
    supports_image_detail_original: bool,
    #[serde(default)]
    web_search_tool_type: WebSearchToolType,
    #[serde(default)]
    multi_agent_reasoning_effort: Option<ReasoningEffort>,
    #[serde(default)]
    tool_mode: Option<ToolModeWire>,
    #[serde(default, deserialize_with = "deserialize_multi_agent_version")]
    multi_agent_version: Option<MultiAgentVersion>,
    #[serde(default)]
    truncation_policy: Option<TruncationPolicyWire>,
    #[serde(default)]
    model_messages: Option<ModelMessagesWire>,
    #[serde(default)]
    base_instructions: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct ModelMessagesWire {
    #[serde(default)]
    instructions_template: Option<String>,
    #[serde(default)]
    instructions_variables: Option<ModelInstructionsVariablesWire>,
    #[serde(default)]
    approvals: Option<ApprovalMessagesWire>,
    #[serde(default)]
    collaboration_modes: Option<CollaborationModeMessagesWire>,
    #[serde(default)]
    permissions: Option<PermissionMessagesWire>,
    #[serde(default)]
    multi_agent: Option<MultiAgentMessagesWire>,
}

#[derive(Debug, Clone, Deserialize)]
struct MultiAgentMessagesWire {
    #[serde(default)]
    role: Option<MultiAgentRoleMessagesWire>,
    #[serde(default)]
    mode: Option<MultiAgentModeMessagesWire>,
}

#[derive(Debug, Clone, Deserialize)]
struct MultiAgentRoleMessagesWire {
    root: Option<String>,
    subagent: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct MultiAgentModeMessagesWire {
    explicit: Option<String>,
    hint_text: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct ModelInstructionsVariablesWire {
    personality_default: Option<String>,
    personality_friendly: Option<String>,
    personality_pragmatic: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct ApprovalMessagesWire {
    on_request: Option<String>,
    on_request_auto_review: Option<String>,
    never: Option<String>,
    unless_trusted: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct CollaborationModeMessagesWire {
    default: Option<String>,
    plan: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct PermissionMessagesWire {
    danger_full_access: Option<String>,
    workspace_write: Option<String>,
    read_only: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
struct TruncationPolicyWire {
    mode: TruncationModeWire,
    limit: u64,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum TruncationModeWire {
    Bytes,
    Tokens,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ToolModeWire {
    Direct,
    CodeMode,
    CodeModeOnly,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) enum ModelToolMode {
    #[default]
    Direct,
    CodeMode,
    CodeModeOnly,
}

impl From<ToolModeWire> for ModelToolMode {
    fn from(value: ToolModeWire) -> Self {
        match value {
            ToolModeWire::Direct => Self::Direct,
            ToolModeWire::CodeMode => Self::CodeMode,
            ToolModeWire::CodeModeOnly => Self::CodeModeOnly,
        }
    }
}

fn deserialize_multi_agent_version<'de, D>(
    deserializer: D,
) -> Result<Option<MultiAgentVersion>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Option::<String>::deserialize(deserializer)?;
    Ok(match value.as_deref() {
        Some("disabled") => Some(MultiAgentVersion::Disabled),
        Some("v1") => Some(MultiAgentVersion::V1),
        Some("v2") => Some(MultiAgentVersion::V2),
        Some(_) | None => None,
    })
}

impl ModelInstructionsVariablesWire {
    fn is_complete(&self) -> bool {
        self.personality_default.is_some()
            && self.personality_friendly.is_some()
            && self.personality_pragmatic.is_some()
    }

    fn personality_message(&self, personality: Personality) -> Option<&str> {
        match personality {
            Personality::Friendly => self.personality_friendly.as_deref(),
            Personality::Pragmatic => self.personality_pragmatic.as_deref(),
            Personality::None => Some(""),
        }
    }
}

#[derive(Debug, Deserialize)]
struct ReasoningPresetWire {
    effort: ReasoningEffort,
    description: String,
}

#[derive(Debug, Deserialize)]
struct ServiceTierWire {
    id: String,
    name: String,
    description: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
enum ModelVisibility {
    List,
    Hide,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
enum InputModality {
    Text,
    Image,
    Audio,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
enum WebSearchToolType {
    #[default]
    Text,
    TextAndImage,
}

#[derive(Debug, Clone)]
pub struct SelectedModel {
    summary: CodexModel,
    instruction_template: String,
    model_messages: Option<ModelMessagesWire>,
    auto_compact_token_limit: Option<u64>,
    response_protocol: ResponseProtocol,
    supports_parallel_tool_calls: bool,
    reasoning_summary: Option<ReasoningSummarySetting>,
    supports_verbosity: bool,
    default_verbosity: Option<ModelVerbosity>,
    supports_image_input: bool,
    supports_image_detail_original: bool,
    web_search_tool_type: WebSearchToolType,
    tool_mode: ModelToolMode,
    multi_agent_version: MultiAgentVersion,
    multi_agent_reasoning_effort: Option<ReasoningEffort>,
    provider_output_budget: ProviderOutputBudget,
}

impl SelectedModel {
    pub fn summary(&self) -> CodexModel {
        self.summary.clone()
    }

    pub fn id(&self) -> &str {
        &self.summary.id
    }

    pub fn instructions(&self, personality: Personality) -> String {
        let Some(variables) = self
            .model_messages
            .as_ref()
            .and_then(|messages| messages.instructions_variables.as_ref())
        else {
            return self.instruction_template.clone();
        };
        self.instruction_template.replace(
            PERSONALITY_PLACEHOLDER,
            variables
                .personality_message(personality)
                .unwrap_or_default(),
        )
    }

    pub fn personality_context(&self, personality: Personality) -> Option<&str> {
        let messages = self.model_messages.as_ref()?;
        let variables = messages.instructions_variables.as_ref()?;
        (!self.personality_is_baked())
            .then(|| variables.personality_message(personality))
            .flatten()
            .filter(|message| !message.trim().is_empty())
    }

    pub fn uses_legacy_instruction_contract(&self) -> bool {
        self.model_messages.is_none()
    }

    pub fn collaboration_context(&self, mode: ConversationMode) -> Option<&str> {
        matches!(mode, ConversationMode::Work | ConversationMode::Codex)
            .then(|| {
                self.model_messages
                    .as_ref()?
                    .collaboration_modes
                    .as_ref()?
                    .default
                    .as_deref()
            })
            .flatten()
            .filter(|message| !message.trim().is_empty())
    }

    pub fn permissions_context(&self, profile: PermissionProfile) -> Option<String> {
        let messages = self.model_messages.as_ref()?;
        let sandbox = messages.permissions.as_ref().and_then(|permissions| {
            use crate::engine::SandboxMode;
            match profile.sandbox {
                SandboxMode::ReadOnly => permissions.read_only.as_deref(),
                SandboxMode::WorkspaceWrite => permissions.workspace_write.as_deref(),
                SandboxMode::DangerFullAccess => permissions.danger_full_access.as_deref(),
            }
        });
        let approvals = messages.approvals.as_ref().and_then(|approvals| {
            use crate::engine::ApprovalPolicy;
            match profile.approvals {
                ApprovalPolicy::Untrusted => approvals.unless_trusted.as_deref(),
                ApprovalPolicy::OnRequest => approvals.on_request.as_deref(),
                ApprovalPolicy::Never => approvals.never.as_deref(),
            }
        });
        let mut sections = [sandbox, approvals]
            .into_iter()
            .flatten()
            .filter(|section| !section.trim().is_empty());
        let first = sections.next()?;
        let mut text = first.replace("{{ network_access }}", "enabled");
        for section in sections {
            text.push_str("\n\n");
            text.push_str(&section.replace("{{ network_access }}", "enabled"));
        }
        Some(text)
    }

    pub fn context_window(&self) -> Option<ModelContextWindow> {
        self.summary.context_window.clone()
    }

    pub fn with_context_window_preference(
        mut self,
        preference: ModelContextWindowPreference,
    ) -> Result<Self, AppError> {
        if preference == ModelContextWindowPreference::Default {
            return Ok(self);
        }
        let Some(default_window) = self.summary.context_window.as_ref() else {
            return Ok(self);
        };
        let Some(maximum_tokens) = default_window
            .maximum_tokens
            .filter(|maximum| *maximum > default_window.tokens)
        else {
            return Ok(self);
        };
        let default_tokens = default_window.tokens;
        let usable_percent = default_window.usable_percent;
        let usable_tokens = maximum_tokens
            .checked_mul(u64::from(usable_percent))
            .ok_or_else(|| AppError::Provider("context-window calculation overflowed".into()))?
            / PERCENT_SCALE;
        let auto_compact_token_limit = self
            .auto_compact_token_limit
            .map(|limit| {
                limit
                    .checked_mul(maximum_tokens)
                    .ok_or_else(|| {
                        AppError::Provider("auto-compaction calculation overflowed".into())
                    })?
                    .checked_div(default_tokens)
                    .ok_or_else(|| {
                        AppError::Provider("auto-compaction calculation divided by zero".into())
                    })
                    .map(|scaled| scaled.min(usable_tokens))
            })
            .transpose()?;

        let context_window = self
            .summary
            .context_window
            .as_mut()
            .ok_or_else(|| AppError::State("model context metadata disappeared".into()))?;
        context_window.tokens = maximum_tokens;
        context_window.usable_tokens = usable_tokens;
        self.auto_compact_token_limit = auto_compact_token_limit;
        Ok(self)
    }

    pub fn auto_compact_token_limit(&self) -> Option<u64> {
        self.auto_compact_token_limit
    }

    pub fn request_parallel_tool_calls(&self) -> bool {
        self.supports_parallel_tool_calls && self.response_protocol == ResponseProtocol::Standard
    }

    pub const fn response_protocol(&self) -> ResponseProtocol {
        self.response_protocol
    }

    pub const fn reasoning_summary(&self) -> Option<ReasoningSummarySetting> {
        self.reasoning_summary
    }

    pub const fn supports_image_input(&self) -> bool {
        self.supports_image_input
    }

    pub const fn supports_image_detail_original(&self) -> bool {
        self.supports_image_detail_original
    }

    pub const fn web_search_includes_images(&self) -> bool {
        matches!(self.web_search_tool_type, WebSearchToolType::TextAndImage)
    }

    pub const fn tool_mode(&self) -> ModelToolMode {
        self.tool_mode
    }

    pub const fn multi_agent_version(&self) -> MultiAgentVersion {
        self.multi_agent_version
    }

    pub fn multi_agent_root_instructions(&self) -> Option<&str> {
        self.model_messages
            .as_ref()?
            .multi_agent
            .as_ref()?
            .role
            .as_ref()?
            .root
            .as_deref()
    }

    pub fn multi_agent_subagent_instructions(&self) -> Option<&str> {
        self.model_messages
            .as_ref()?
            .multi_agent
            .as_ref()?
            .role
            .as_ref()?
            .subagent
            .as_deref()
    }

    pub fn multi_agent_explicit_mode_instructions(&self) -> Option<&str> {
        self.model_messages
            .as_ref()?
            .multi_agent
            .as_ref()?
            .mode
            .as_ref()?
            .explicit
            .as_deref()
    }

    pub fn multi_agent_mode_hint(&self) -> Option<&str> {
        self.model_messages
            .as_ref()?
            .multi_agent
            .as_ref()?
            .mode
            .as_ref()?
            .hint_text
            .as_deref()
    }

    pub const fn provider_output_budget(&self) -> ProviderOutputBudget {
        self.provider_output_budget
    }

    pub fn personality_is_baked(&self) -> bool {
        self.instruction_template.contains(PERSONALITY_PLACEHOLDER)
            && self
                .model_messages
                .as_ref()
                .and_then(|messages| messages.instructions_variables.as_ref())
                .is_some_and(ModelInstructionsVariablesWire::is_complete)
    }

    pub fn select_verbosity(
        &self,
        requested: Option<ModelVerbosity>,
    ) -> Result<Option<ModelVerbosity>, AppError> {
        if !self.supports_verbosity {
            if requested.is_some() {
                return Err(AppError::Protocol(format!(
                    "model `{}` does not support output verbosity",
                    self.id()
                )));
            }
            return Ok(None);
        }
        Ok(requested.or(self.default_verbosity))
    }

    pub fn default_reasoning_effort(&self) -> Option<ReasoningEffort> {
        self.summary.default_reasoning_effort
    }

    pub fn supports_reasoning_effort(&self, effort: ReasoningEffort) -> bool {
        !self.summary.unsupported_reasoning_efforts.contains(&effort)
            && self
                .summary
                .supported_reasoning_efforts
                .iter()
                .any(|option| option.reasoning_effort == effort)
    }

    pub fn provider_reasoning_effort(
        &self,
        selected: Option<ReasoningEffort>,
    ) -> Option<ReasoningEffort> {
        let Some(ReasoningEffort::Ultra) = selected else {
            return selected;
        };
        self.multi_agent_reasoning_effort
            .or_else(|| {
                self.summary
                    .supported_reasoning_efforts
                    .iter()
                    .find(|option| option.reasoning_effort == ReasoningEffort::Max)
                    .or_else(|| {
                        self.summary
                            .supported_reasoning_efforts
                            .iter()
                            .rev()
                            .find(|option| option.reasoning_effort != ReasoningEffort::Ultra)
                    })
                    .map(|option| option.reasoning_effort)
            })
            .or(Some(ReasoningEffort::Medium))
    }

    pub fn select_service_tier(&self, requested: Option<&str>) -> Result<Option<String>, AppError> {
        let selected = requested
            .map(str::to_string)
            .or_else(|| self.summary.default_service_tier.clone());
        if let Some(selected) = selected.as_deref()
            && !self
                .summary
                .service_tiers
                .iter()
                .any(|tier| tier.id == selected)
        {
            return Err(AppError::Protocol(format!(
                "service tier `{selected}` is not supported by model `{}`",
                self.id()
            )));
        }
        Ok(selected)
    }
}

#[derive(Debug)]
pub struct ModelCatalog {
    models: Vec<SelectedModel>,
}

impl ModelCatalog {
    pub fn from_wire(wire: ModelsWire, maximum_models: usize) -> Result<Self, AppError> {
        if wire.models.is_empty() || wire.models.len() > maximum_models {
            return Err(AppError::Provider(format!(
                "model catalog must contain between 1 and {maximum_models} entries"
            )));
        }
        let mut seen = HashSet::with_capacity(wire.models.len());
        let mut models = Vec::with_capacity(wire.models.len());
        let mut wire_models = wire.models;
        wire_models.sort_by_key(|model| model.priority);
        let default_slug = wire_models
            .iter()
            .find(|model| {
                model.visibility == ModelVisibility::List
                    && !(model.default_reasoning_level == Some(ReasoningEffort::Ultra)
                        && model.multi_agent_version != Some(MultiAgentVersion::V2))
            })
            .map(|model| model.slug.clone())
            .ok_or_else(|| {
                AppError::Provider(
                    "model catalog has no visible model supported by this native runtime".into(),
                )
            })?;

        for model in wire_models {
            validate_identifier("model slug", &model.slug, MAX_MODEL_ID_BYTES)?;
            validate_text(
                "model display name",
                &model.display_name,
                MAX_MODEL_TEXT_BYTES,
            )?;
            let instruction_template = model
                .model_messages
                .as_ref()
                .and_then(|messages| messages.instructions_template.as_ref())
                .or(model.base_instructions.as_ref())
                .ok_or_else(|| {
                    AppError::Provider(format!(
                        "model `{}` is missing both base_instructions and model_messages.instructions_template",
                        model.slug
                    ))
                })?
                .clone();
            validate_text(
                "model instructions",
                &instruction_template,
                MAX_INSTRUCTIONS_BYTES,
            )?;
            validate_model_messages(&model)?;
            validate_optional_text(
                "model description",
                model.description.as_deref(),
                MAX_MODEL_TEXT_BYTES,
            )?;
            if !seen.insert(model.slug.clone()) {
                return Err(AppError::Provider(format!(
                    "model catalog contains duplicate slug `{}`",
                    model.slug
                )));
            }
            let mut seen_reasoning_efforts = HashSet::new();
            for preset in &model.supported_reasoning_levels {
                if !seen_reasoning_efforts.insert(preset.effort) {
                    return Err(AppError::Provider(format!(
                        "model `{}` contains duplicate reasoning effort `{}`",
                        model.slug,
                        preset.effort.as_str()
                    )));
                }
                validate_optional_text(
                    "reasoning description",
                    Some(&preset.description),
                    MAX_MODEL_TEXT_BYTES,
                )?;
            }
            let default_reasoning_effort = model.default_reasoning_level;
            if let Some(default_reasoning_effort) = default_reasoning_effort
                && !model
                    .supported_reasoning_levels
                    .iter()
                    .any(|preset| preset.effort == default_reasoning_effort)
            {
                return Err(AppError::Provider(format!(
                    "model `{}` advertises an unsupported default reasoning effort",
                    model.slug
                )));
            }
            if let Some(multi_agent_reasoning_effort) = model.multi_agent_reasoning_effort
                && (multi_agent_reasoning_effort == ReasoningEffort::Ultra
                    || !model
                        .supported_reasoning_levels
                        .iter()
                        .any(|preset| preset.effort == multi_agent_reasoning_effort))
            {
                return Err(AppError::Provider(format!(
                    "model `{}` advertises an invalid multi-agent reasoning effort",
                    model.slug
                )));
            }
            let context_window = decode_context_window(&model)?;
            let auto_compact_token_limit = decode_auto_compact_token_limit(&model)?;
            let provider_output_budget = decode_provider_output_budget(&model)?;
            let unsupported_runtime_capabilities = unsupported_runtime_capabilities(&model);
            let unsupported_reasoning_efforts = (model.multi_agent_version
                != Some(MultiAgentVersion::V2)
                && model
                    .supported_reasoning_levels
                    .iter()
                    .any(|preset| preset.effort == ReasoningEffort::Ultra))
            .then_some(ReasoningEffort::Ultra)
            .into_iter()
            .collect();
            let supported_reasoning_efforts = model
                .supported_reasoning_levels
                .into_iter()
                .map(|preset| ReasoningEffortOption {
                    reasoning_effort: preset.effort,
                    description: preset.description,
                })
                .collect();
            let mut seen_service_tiers = HashSet::new();
            for tier in &model.service_tiers {
                validate_identifier("service tier id", &tier.id, MAX_MODEL_ID_BYTES)?;
                validate_text("service tier name", &tier.name, MAX_MODEL_TEXT_BYTES)?;
                validate_optional_text(
                    "service tier description",
                    Some(&tier.description),
                    MAX_MODEL_TEXT_BYTES,
                )?;
                if !seen_service_tiers.insert(tier.id.as_str()) {
                    return Err(AppError::Provider(format!(
                        "model `{}` contains duplicate service tier `{}`",
                        model.slug, tier.id
                    )));
                }
            }
            if let Some(default_service_tier) = model.default_service_tier.as_deref()
                && !seen_service_tiers.contains(default_service_tier)
            {
                return Err(AppError::Provider(format!(
                    "model `{}` advertises unknown default service tier `{default_service_tier}`",
                    model.slug
                )));
            }
            let service_tiers = model
                .service_tiers
                .into_iter()
                .map(|tier| ModelServiceTier {
                    id: tier.id,
                    name: tier.name,
                    description: tier.description,
                })
                .collect();
            if model.default_verbosity.is_some() && !model.support_verbosity {
                return Err(AppError::Provider(format!(
                    "model `{}` advertises a default verbosity without verbosity support",
                    model.slug
                )));
            }
            let reasoning_summary = (model.supports_reasoning_summary_parameter
                && model.default_reasoning_summary != ReasoningSummarySetting::None)
                .then_some(model.default_reasoning_summary);
            models.push(SelectedModel {
                summary: CodexModel {
                    id: model.slug.clone(),
                    model: model.slug.clone(),
                    display_name: model.display_name,
                    description: model.description,
                    hidden: model.visibility != ModelVisibility::List,
                    supported_reasoning_efforts,
                    default_reasoning_effort,
                    service_tiers,
                    default_service_tier: model.default_service_tier,
                    context_window,
                    unsupported_runtime_capabilities: unsupported_runtime_capabilities.clone(),
                    unsupported_reasoning_efforts,
                    is_default: model.slug == default_slug,
                },
                instruction_template,
                model_messages: model.model_messages,
                auto_compact_token_limit,
                response_protocol: if model.use_responses_lite {
                    ResponseProtocol::Lite
                } else {
                    ResponseProtocol::Standard
                },
                supports_parallel_tool_calls: model.supports_parallel_tool_calls,
                reasoning_summary,
                supports_verbosity: model.support_verbosity,
                default_verbosity: model.default_verbosity,
                supports_image_input: model.input_modalities.contains(&InputModality::Image),
                supports_image_detail_original: model.supports_image_detail_original,
                web_search_tool_type: model.web_search_tool_type,
                tool_mode: model.tool_mode.map(Into::into).unwrap_or_default(),
                multi_agent_version: model.multi_agent_version.unwrap_or_default(),
                multi_agent_reasoning_effort: model.multi_agent_reasoning_effort,
                provider_output_budget,
            });
        }
        Ok(Self { models })
    }

    pub fn models(&self) -> &[SelectedModel] {
        &self.models
    }

    pub fn multi_agent_models(&self) -> Vec<CodexModel> {
        self.models
            .iter()
            .filter(|model| model.multi_agent_version == MultiAgentVersion::V2)
            .map(SelectedModel::summary)
            .filter(|model| !model.hidden)
            .collect()
    }

    pub fn select(&self, requested: Option<&str>) -> Result<SelectedModel, AppError> {
        let selected = match requested {
            Some(id) => self.models.iter().find(|model| model.id() == id),
            None => self.models.iter().find(|model| model.summary.is_default),
        };
        let selected = selected.cloned().ok_or_else(|| {
            AppError::Protocol(match requested {
                Some(id) => format!("model `{id}` is not present in the current catalog"),
                None => "the current model catalog has no default".into(),
            })
        })?;
        Ok(selected)
    }
}

fn unsupported_runtime_capabilities(model: &ModelWire) -> Vec<ModelRuntimeCapability> {
    let mut capabilities = Vec::with_capacity(1);
    if matches!(model.multi_agent_version, Some(MultiAgentVersion::V1)) {
        capabilities.push(ModelRuntimeCapability::MultiAgent);
    }
    capabilities
}

const fn default_effective_context_window_percent() -> u8 {
    DEFAULT_EFFECTIVE_CONTEXT_WINDOW_PERCENT
}

const fn default_true() -> bool {
    true
}

fn default_input_modalities() -> Vec<InputModality> {
    vec![InputModality::Text, InputModality::Image]
}

fn decode_context_window(model: &ModelWire) -> Result<Option<ModelContextWindow>, AppError> {
    let percent = model.effective_context_window_percent;
    if !(1..=100).contains(&percent) {
        return Err(AppError::Provider(format!(
            "model `{}` has an effective context-window percentage outside 1..=100",
            model.slug
        )));
    }
    for (label, tokens) in [
        ("context_window", model.context_window),
        ("max_context_window", model.max_context_window),
    ] {
        if tokens.is_some_and(|tokens| tokens == 0 || tokens > MAX_CONTEXT_WINDOW_TOKENS) {
            return Err(AppError::Provider(format!(
                "model `{}` has an invalid {label}",
                model.slug
            )));
        }
    }
    if let (Some(tokens), Some(maximum)) = (model.context_window, model.max_context_window)
        && tokens > maximum
    {
        return Err(AppError::Provider(format!(
            "model `{}` has a context window above its advertised maximum",
            model.slug
        )));
    }
    let Some(tokens) = model.context_window.or(model.max_context_window) else {
        return Ok(None);
    };
    let usable_tokens = tokens
        .checked_mul(u64::from(percent))
        .ok_or_else(|| AppError::Provider("context-window calculation overflowed".into()))?
        / PERCENT_SCALE;
    Ok(Some(ModelContextWindow {
        tokens,
        usable_tokens,
        usable_percent: percent,
        maximum_tokens: model.max_context_window,
    }))
}

fn decode_auto_compact_token_limit(model: &ModelWire) -> Result<Option<u64>, AppError> {
    if model
        .auto_compact_token_limit
        .is_some_and(|tokens| tokens == 0 || tokens > MAX_CONTEXT_WINDOW_TOKENS)
    {
        return Err(AppError::Provider(format!(
            "model `{}` has an invalid auto_compact_token_limit",
            model.slug
        )));
    }
    let context_limit = model
        .context_window
        .or(model.max_context_window)
        .and_then(|tokens| tokens.checked_mul(AUTO_COMPACT_CONTEXT_WINDOW_PERCENT))
        .map(|scaled| scaled / PERCENT_SCALE);
    Ok(match (context_limit, model.auto_compact_token_limit) {
        (Some(context_limit), Some(advertised_limit)) => Some(context_limit.min(advertised_limit)),
        (Some(context_limit), None) => Some(context_limit),
        (None, advertised_limit) => advertised_limit,
    })
}

fn decode_provider_output_budget(model: &ModelWire) -> Result<ProviderOutputBudget, AppError> {
    let Some(policy) = model.truncation_policy else {
        return Ok(ProviderOutputBudget::default());
    };
    let limit = usize::try_from(policy.limit).map_err(|error| {
        AppError::Provider(format!(
            "model `{}` has a tool-output truncation limit that cannot fit this platform: {error}",
            model.slug
        ))
    })?;
    let budget = match policy.mode {
        TruncationModeWire::Bytes => ProviderOutputBudget::from_bytes(limit),
        TruncationModeWire::Tokens => ProviderOutputBudget::from_tokens(limit),
    };
    budget.ok_or_else(|| {
        AppError::Provider(format!(
            "model `{}` has an invalid tool-output truncation policy",
            model.slug
        ))
    })
}

fn validate_model_messages(model: &ModelWire) -> Result<(), AppError> {
    validate_optional_text(
        "legacy model instructions",
        model.base_instructions.as_deref(),
        MAX_INSTRUCTIONS_BYTES,
    )?;
    let Some(messages) = model.model_messages.as_ref() else {
        if model
            .base_instructions
            .as_deref()
            .is_some_and(|instructions| instructions.contains(PERSONALITY_PLACEHOLDER))
        {
            return Err(AppError::Provider(format!(
                "model `{}` uses the personality placeholder without typed instruction variables",
                model.slug
            )));
        }
        return Ok(());
    };
    let effective_template = messages
        .instructions_template
        .as_deref()
        .or(model.base_instructions.as_deref());
    if effective_template.is_some_and(|template| template.contains(PERSONALITY_PLACEHOLDER))
        && !messages
            .instructions_variables
            .as_ref()
            .is_some_and(ModelInstructionsVariablesWire::is_complete)
    {
        return Err(AppError::Provider(format!(
            "model `{}` uses the personality placeholder without complete instruction variables",
            model.slug
        )));
    }
    for (label, value) in [
        (
            "model instruction template",
            messages.instructions_template.as_deref(),
        ),
        (
            "default personality instructions",
            messages
                .instructions_variables
                .as_ref()
                .and_then(|variables| variables.personality_default.as_deref()),
        ),
        (
            "friendly personality instructions",
            messages
                .instructions_variables
                .as_ref()
                .and_then(|variables| variables.personality_friendly.as_deref()),
        ),
        (
            "pragmatic personality instructions",
            messages
                .instructions_variables
                .as_ref()
                .and_then(|variables| variables.personality_pragmatic.as_deref()),
        ),
        (
            "on-request approval instructions",
            messages
                .approvals
                .as_ref()
                .and_then(|approvals| approvals.on_request.as_deref()),
        ),
        (
            "auto-review approval instructions",
            messages
                .approvals
                .as_ref()
                .and_then(|approvals| approvals.on_request_auto_review.as_deref()),
        ),
        (
            "never-approve instructions",
            messages
                .approvals
                .as_ref()
                .and_then(|approvals| approvals.never.as_deref()),
        ),
        (
            "untrusted-command approval instructions",
            messages
                .approvals
                .as_ref()
                .and_then(|approvals| approvals.unless_trusted.as_deref()),
        ),
        (
            "default collaboration instructions",
            messages
                .collaboration_modes
                .as_ref()
                .and_then(|modes| modes.default.as_deref()),
        ),
        (
            "plan collaboration instructions",
            messages
                .collaboration_modes
                .as_ref()
                .and_then(|modes| modes.plan.as_deref()),
        ),
        (
            "danger-full-access instructions",
            messages
                .permissions
                .as_ref()
                .and_then(|permissions| permissions.danger_full_access.as_deref()),
        ),
        (
            "workspace-write instructions",
            messages
                .permissions
                .as_ref()
                .and_then(|permissions| permissions.workspace_write.as_deref()),
        ),
        (
            "read-only instructions",
            messages
                .permissions
                .as_ref()
                .and_then(|permissions| permissions.read_only.as_deref()),
        ),
    ] {
        validate_optional_text(label, value, MAX_INSTRUCTIONS_BYTES)?;
    }
    Ok(())
}

fn validate_text(label: &str, value: &str, maximum_bytes: usize) -> Result<(), AppError> {
    if value.trim().is_empty() || value.len() > maximum_bytes {
        return Err(AppError::Provider(format!(
            "{label} must contain between 1 and {maximum_bytes} bytes"
        )));
    }
    Ok(())
}

fn validate_identifier(label: &str, value: &str, maximum_bytes: usize) -> Result<(), AppError> {
    validate_text(label, value, maximum_bytes)?;
    if value.chars().any(char::is_control) {
        return Err(AppError::Provider(format!(
            "{label} cannot contain control characters"
        )));
    }
    Ok(())
}

fn validate_optional_text(
    label: &str,
    value: Option<&str>,
    maximum_bytes: usize,
) -> Result<(), AppError> {
    if value.is_some_and(|value| value.len() > maximum_bytes) {
        return Err(AppError::Provider(format!(
            "{label} exceeds {maximum_bytes} bytes"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::ModelCatalog;
    use super::ModelsWire;
    use super::ResponseProtocol;
    use crate::engine::{
        ConversationMode, ModelVerbosity, PermissionProfile, Personality, ReasoningEffort,
    };

    #[test]
    fn catalog_has_one_authoritative_models_shape() {
        let wire: ModelsWire = serde_json::from_str(
            r#"{
                "models": [{
                    "slug": "gpt-test",
                    "display_name": "GPT Test",
                    "description": "test",
                    "default_reasoning_level": "medium",
                    "supported_reasoning_levels": [{"effort":"medium","description":"balanced"}],
                    "visibility": "list",
                    "priority": 0,
                    "service_tiers": [],
                    "default_service_tier": null,
                    "context_window": 272000,
                    "max_context_window": 400000,
                    "effective_context_window_percent": 95,
                    "supports_parallel_tool_calls": true,
                    "use_responses_lite": true,
                    "supports_reasoning_summary_parameter": true,
                    "default_reasoning_summary": "none",
                    "support_verbosity": true,
                    "default_verbosity": "low",
                    "input_modalities": ["text", "image"],
                    "supports_image_detail_original": true,
                    "web_search_tool_type": "text_and_image",
                    "truncation_policy": {"mode": "tokens", "limit": 10000},
                    "base_instructions": "Be useful."
                }]
            }"#,
        )
        .expect("fixture should decode");
        let catalog = ModelCatalog::from_wire(wire, 100).expect("catalog should validate");
        assert_eq!(catalog.models().len(), 1);
        assert!(catalog.models()[0].summary().is_default);
        let context = catalog.models()[0]
            .context_window()
            .expect("context metadata should be preserved");
        assert_eq!(context.tokens, 272_000);
        assert_eq!(context.usable_tokens, 258_400);
        assert_eq!(
            catalog.models()[0].auto_compact_token_limit(),
            Some(244_800)
        );

        let maximum = catalog.models()[0]
            .clone()
            .with_context_window_preference(crate::engine::ModelContextWindowPreference::Maximum)
            .expect("maximum context should resolve");
        let maximum_context = maximum
            .context_window()
            .expect("maximum context metadata should be present");
        assert_eq!(maximum_context.tokens, 400_000);
        assert_eq!(maximum_context.usable_tokens, 380_000);
        assert_eq!(maximum.auto_compact_token_limit(), Some(360_000));
        assert_eq!(maximum.response_protocol(), ResponseProtocol::Lite);
        assert!(!maximum.request_parallel_tool_calls());
        assert!(maximum.supports_image_input());
        assert!(maximum.supports_image_detail_original());
        assert!(maximum.web_search_includes_images());
        assert_eq!(maximum.provider_output_budget().bytes(), 40_000);
        assert_eq!(maximum.reasoning_summary(), None);
        assert_eq!(
            maximum
                .select_verbosity(None)
                .expect("default verbosity should resolve"),
            Some(ModelVerbosity::Low)
        );
    }

    #[test]
    fn catalog_enables_code_mode_and_v2_ultra_models() {
        let wire: ModelsWire = serde_json::from_str(
            r#"{
                "models": [
                    {
                        "slug": "gpt-code-mode",
                        "display_name": "GPT Code Mode",
                        "description": null,
                        "default_reasoning_level": "ultra",
                        "supported_reasoning_levels": [
                            {"effort":"high","description":"deep"},
                            {"effort":"ultra","description":"delegated"}
                        ],
                        "visibility": "list",
                        "priority": 0,
                        "service_tiers": [],
                        "default_service_tier": null,
                        "tool_mode": "code_mode_only",
                        "multi_agent_version": "v2",
                        "base_instructions": "Be useful."
                    },
                    {
                        "slug": "gpt-direct",
                        "display_name": "GPT Direct",
                        "description": null,
                        "default_reasoning_level": "high",
                        "supported_reasoning_levels": [
                            {"effort":"high","description":"deep"}
                        ],
                        "visibility": "list",
                        "priority": 1,
                        "service_tiers": [],
                        "default_service_tier": null,
                        "tool_mode": "direct",
                        "multi_agent_version": "disabled",
                        "base_instructions": "Be useful."
                    }
                ]
            }"#,
        )
        .expect("runtime-capability fixture should decode");
        let catalog = ModelCatalog::from_wire(wire, 2).expect("catalog should validate");
        let code_mode = catalog.models()[0].summary();

        assert!(code_mode.unsupported_runtime_capabilities.is_empty());
        assert!(code_mode.unsupported_reasoning_efforts.is_empty());
        assert!(code_mode.is_default);
        assert_eq!(
            catalog
                .select(None)
                .expect("the supported default should resolve")
                .id(),
            "gpt-code-mode"
        );
        let selected = catalog
            .select(Some("gpt-code-mode"))
            .expect("a Code Mode model must be executable without enabling Ultra");
        assert_eq!(selected.id(), "gpt-code-mode");
        assert_eq!(selected.tool_mode(), super::ModelToolMode::CodeModeOnly);
        assert_eq!(
            catalog
                .multi_agent_models()
                .into_iter()
                .map(|model| model.id)
                .collect::<Vec<_>>(),
            ["gpt-code-mode"]
        );
    }

    #[test]
    fn unknown_multi_agent_versions_fail_closed() {
        let wire: ModelsWire = serde_json::from_str(
            r#"{
                "models": [{
                    "slug": "gpt-future-runtime",
                    "display_name": "GPT Future Runtime",
                    "description": null,
                    "default_reasoning_level": "high",
                    "supported_reasoning_levels": [
                        {"effort":"high","description":"deep"},
                        {"effort":"ultra","description":"delegated"}
                    ],
                    "visibility": "list",
                    "priority": 0,
                    "service_tiers": [],
                    "default_service_tier": null,
                    "multi_agent_version": "v3",
                    "base_instructions": "Be useful."
                }]
            }"#,
        )
        .expect("future runtime fixture should decode without enabling it");
        let model = ModelCatalog::from_wire(wire, 1)
            .expect("future runtime fixture should validate")
            .select(None)
            .expect("non-Ultra model default should remain usable");

        assert_eq!(
            model.multi_agent_version(),
            super::MultiAgentVersion::Disabled
        );
        assert!(
            model
                .summary()
                .unsupported_reasoning_efforts
                .contains(&ReasoningEffort::Ultra)
        );
    }

    #[test]
    fn catalog_preserves_an_absent_reasoning_default() {
        let wire: ModelsWire = serde_json::from_str(
            r#"{
                "models": [{
                    "slug": "gpt-no-reasoning-default",
                    "display_name": "GPT without reasoning default",
                    "description": null,
                    "supported_reasoning_levels": [],
                    "visibility": "list",
                    "priority": 0,
                    "service_tiers": [],
                    "default_service_tier": null,
                    "base_instructions": "Be useful."
                }]
            }"#,
        )
        .expect("fixture should decode");
        let catalog = ModelCatalog::from_wire(wire, 100).expect("catalog should validate");
        let summary = catalog.models()[0].summary();

        assert_eq!(summary.default_reasoning_effort, None);
        assert!(summary.supported_reasoning_efforts.is_empty());
        assert_eq!(summary.description, None);
        assert_eq!(catalog.models()[0].provider_output_budget().bytes(), 10_000);
        assert!(
            catalog.models()[0]
                .select_verbosity(Some(ModelVerbosity::High))
                .is_err()
        );
    }

    #[test]
    fn catalog_never_selects_an_unavailable_ultra_default() {
        let wire: ModelsWire = serde_json::from_str(
            r#"{
                "models": [
                    {
                        "slug": "gpt-legacy-ultra",
                        "display_name": "GPT Legacy Ultra",
                        "description": null,
                        "default_reasoning_level": "ultra",
                        "supported_reasoning_levels": [
                            {"effort":"ultra","description":"delegated"}
                        ],
                        "visibility": "list",
                        "priority": 0,
                        "service_tiers": [],
                        "default_service_tier": null,
                        "multi_agent_version": "v1",
                        "base_instructions": "Be useful."
                    },
                    {
                        "slug": "gpt-native-default",
                        "display_name": "GPT Native Default",
                        "description": null,
                        "default_reasoning_level": "medium",
                        "supported_reasoning_levels": [
                            {"effort":"medium","description":"balanced"}
                        ],
                        "visibility": "list",
                        "priority": 1,
                        "service_tiers": [],
                        "default_service_tier": null,
                        "base_instructions": "Be useful."
                    }
                ]
            }"#,
        )
        .expect("unavailable Ultra fixture should decode");
        let catalog = ModelCatalog::from_wire(wire, 2).expect("catalog should validate");

        assert_eq!(
            catalog
                .select(None)
                .expect("runtime-compatible default should resolve")
                .id(),
            "gpt-native-default"
        );
        assert!(
            !catalog
                .select(Some("gpt-legacy-ultra"))
                .expect("legacy model remains selectable")
                .summary()
                .is_default
        );
    }

    #[test]
    fn ultra_uses_the_catalog_multi_agent_provider_effort() {
        let wire: ModelsWire = serde_json::from_str(
            r#"{
                "models": [{
                    "slug": "gpt-ultra",
                    "display_name": "GPT Ultra",
                    "description": null,
                    "default_reasoning_level": "low",
                    "supported_reasoning_levels": [
                        {"effort":"low","description":"fast"},
                        {"effort":"high","description":"deep"},
                        {"effort":"ultra","description":"delegated"}
                    ],
                    "multi_agent_reasoning_effort": "high",
                    "visibility": "list",
                    "priority": 0,
                    "service_tiers": [],
                    "default_service_tier": null,
                    "base_instructions": "Be useful."
                }]
            }"#,
        )
        .expect("ultra fixture should decode");
        let model = ModelCatalog::from_wire(wire, 1)
            .expect("ultra fixture should validate")
            .select(None)
            .expect("default model should resolve");

        assert_eq!(
            model.provider_reasoning_effort(Some(ReasoningEffort::Ultra)),
            Some(ReasoningEffort::High)
        );
        assert_eq!(
            model.provider_reasoning_effort(Some(ReasoningEffort::Low)),
            Some(ReasoningEffort::Low)
        );
    }

    #[test]
    fn ultra_falls_back_to_max_when_the_catalog_has_no_override() {
        let wire: ModelsWire = serde_json::from_str(
            r#"{
                "models": [{
                    "slug": "gpt-ultra",
                    "display_name": "GPT Ultra",
                    "description": null,
                    "default_reasoning_level": "low",
                    "supported_reasoning_levels": [
                        {"effort":"low","description":"fast"},
                        {"effort":"max","description":"maximum"},
                        {"effort":"ultra","description":"delegated"}
                    ],
                    "visibility": "list",
                    "priority": 0,
                    "service_tiers": [],
                    "default_service_tier": null,
                    "base_instructions": "Be useful."
                }]
            }"#,
        )
        .expect("ultra fixture should decode");
        let model = ModelCatalog::from_wire(wire, 1)
            .expect("ultra fixture should validate")
            .select(None)
            .expect("default model should resolve");

        assert_eq!(
            model.provider_reasoning_effort(Some(ReasoningEffort::Ultra)),
            Some(ReasoningEffort::Max)
        );
    }

    #[test]
    fn ultra_uses_the_official_medium_wire_fallback_without_an_alternative() {
        let wire: ModelsWire = serde_json::from_str(
            r#"{
                "models": [
                    {
                        "slug": "gpt-ultra-only",
                        "display_name": "GPT Ultra Only",
                        "description": null,
                        "default_reasoning_level": "ultra",
                        "supported_reasoning_levels": [
                            {"effort":"ultra","description":"delegated"}
                        ],
                        "visibility": "list",
                        "priority": 0,
                        "service_tiers": [],
                        "default_service_tier": null,
                        "base_instructions": "Be useful."
                    },
                    {
                        "slug": "gpt-direct-default",
                        "display_name": "GPT Direct Default",
                        "description": null,
                        "default_reasoning_level": "medium",
                        "supported_reasoning_levels": [
                            {"effort":"medium","description":"balanced"}
                        ],
                        "visibility": "list",
                        "priority": 1,
                        "service_tiers": [],
                        "default_service_tier": null,
                        "base_instructions": "Be useful."
                    }
                ]
            }"#,
        )
        .expect("ultra-only fixture should decode");
        let model = ModelCatalog::from_wire(wire, 2)
            .expect("ultra-only fixture should validate")
            .select(Some("gpt-ultra-only"))
            .expect("the explicit model should resolve for effort translation");

        assert_eq!(
            model.provider_reasoning_effort(Some(ReasoningEffort::Ultra)),
            Some(ReasoningEffort::Medium)
        );
    }

    #[test]
    fn catalog_prefers_canonical_model_messages_and_renders_personality() {
        let wire: ModelsWire = serde_json::from_str(
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
                    "supports_parallel_tool_calls": true,
                    "base_instructions": "Legacy instructions.",
                    "model_messages": {
                        "instructions_template": "Header. {{ personality }} Rules.",
                        "instructions_variables": {
                            "personality_default": "Default style.",
                            "personality_friendly": "Friendly style.",
                            "personality_pragmatic": "Pragmatic style."
                        },
                        "approvals": {
                            "on_request": "Ask when needed.",
                            "on_request_auto_review": null,
                            "never": "Never ask.",
                            "unless_trusted": "Ask for untrusted commands."
                        },
                        "collaboration_modes": {
                            "default": "Collaborate and execute.",
                            "plan": "Plan only."
                        },
                        "permissions": {
                            "danger_full_access": "Full access; network {{ network_access }}.",
                            "workspace_write": "Workspace access; network {{ network_access }}.",
                            "read_only": "Read-only access; network {{ network_access }}."
                        }
                    }
                }]
            }"#,
        )
        .expect("modern model fixture should decode");
        let model = ModelCatalog::from_wire(wire, 1)
            .expect("modern model fixture should validate")
            .select(None)
            .expect("default model should resolve");

        assert_eq!(
            model.instructions(Personality::Friendly),
            "Header. Friendly style. Rules."
        );
        assert!(model.personality_is_baked());
        assert_eq!(model.personality_context(Personality::Friendly), None);
        assert_eq!(
            model.collaboration_context(ConversationMode::Codex),
            Some("Collaborate and execute.")
        );
        assert_eq!(model.collaboration_context(ConversationMode::Chat), None);
        assert_eq!(
            model.permissions_context(PermissionProfile::workspace_write()),
            Some("Workspace access; network enabled.\n\nAsk when needed.".into())
        );
        assert!(model.request_parallel_tool_calls());
    }

    #[test]
    fn catalog_rejects_models_without_any_instruction_source() {
        let wire: ModelsWire = serde_json::from_str(
            r#"{
                "models": [{
                    "slug": "gpt-missing-instructions",
                    "display_name": "GPT Missing Instructions",
                    "description": null,
                    "supported_reasoning_levels": [],
                    "visibility": "list",
                    "priority": 0,
                    "service_tiers": [],
                    "default_service_tier": null
                }]
            }"#,
        )
        .expect("missing instruction fixture should decode");

        let error =
            ModelCatalog::from_wire(wire, 1).expect_err("a model without instructions must fail");

        assert!(error.to_string().contains("missing both"));
    }

    #[test]
    fn catalog_rejects_an_unbound_personality_placeholder() {
        let wire: ModelsWire = serde_json::from_str(
            r#"{
                "models": [{
                    "slug": "gpt-unbound-personality",
                    "display_name": "GPT Unbound Personality",
                    "description": null,
                    "supported_reasoning_levels": [],
                    "visibility": "list",
                    "priority": 0,
                    "service_tiers": [],
                    "default_service_tier": null,
                    "base_instructions": "Header. {{ personality }} Rules.",
                    "model_messages": {
                        "instructions_template": null,
                        "instructions_variables": {
                            "personality_default": "Default style.",
                            "personality_friendly": null,
                            "personality_pragmatic": "Pragmatic style."
                        }
                    }
                }]
            }"#,
        )
        .expect("unbound placeholder fixture should decode");

        let error = ModelCatalog::from_wire(wire, 1)
            .expect_err("an incompletely bound personality placeholder must fail closed");

        assert!(error.to_string().contains("complete instruction variables"));
    }

    #[test]
    fn catalog_rejects_unbounded_tool_output_policies() {
        let wire: ModelsWire = serde_json::from_str(
            r#"{
                "models": [{
                    "slug": "gpt-invalid-output-budget",
                    "display_name": "GPT Invalid Output Budget",
                    "description": null,
                    "supported_reasoning_levels": [],
                    "visibility": "list",
                    "priority": 0,
                    "service_tiers": [],
                    "default_service_tier": null,
                    "truncation_policy": {"mode": "tokens", "limit": 1000000},
                    "base_instructions": "Be useful."
                }]
            }"#,
        )
        .expect("invalid budget fixture should decode");

        let error = ModelCatalog::from_wire(wire, 1)
            .expect_err("an excessive output budget must fail closed");

        assert!(
            error
                .to_string()
                .contains("invalid tool-output truncation policy")
        );
    }

    #[test]
    fn catalog_rejects_an_invalid_multi_agent_reasoning_override() {
        let wire: ModelsWire = serde_json::from_str(
            r#"{
                "models": [{
                    "slug": "gpt-invalid-multi-agent-effort",
                    "display_name": "GPT Invalid Multi-Agent Effort",
                    "description": null,
                    "supported_reasoning_levels": [
                        {"effort":"medium","description":"balanced"},
                        {"effort":"ultra","description":"delegated"}
                    ],
                    "multi_agent_reasoning_effort": "ultra",
                    "visibility": "list",
                    "priority": 0,
                    "service_tiers": [],
                    "default_service_tier": null,
                    "base_instructions": "Be useful."
                }]
            }"#,
        )
        .expect("invalid multi-agent fixture should decode");

        let error = ModelCatalog::from_wire(wire, 1)
            .expect_err("a recursive Ultra provider override must fail closed");

        assert!(
            error
                .to_string()
                .contains("invalid multi-agent reasoning effort")
        );
    }
}
