use std::collections::HashSet;

use serde::Deserialize;

use crate::engine::CodexModel;
use crate::engine::ModelContextWindow;
use crate::engine::ModelContextWindowPreference;
use crate::engine::ModelServiceTier;
use crate::engine::ReasoningEffort;
use crate::engine::ReasoningEffortOption;
use crate::error::AppError;

const MAX_MODEL_ID_BYTES: usize = 128;
const MAX_MODEL_TEXT_BYTES: usize = 16_384;
const MAX_INSTRUCTIONS_BYTES: usize = 262_144;
const MAX_CONTEXT_WINDOW_TOKENS: u64 = 1_000_000_000;
const DEFAULT_EFFECTIVE_CONTEXT_WINDOW_PERCENT: u8 = 95;
const AUTO_COMPACT_CONTEXT_WINDOW_PERCENT: u64 = 90;
const PERCENT_SCALE: u64 = 100;

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
    supports_parallel_tool_calls: bool,
    base_instructions: String,
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

#[derive(Debug, Clone)]
pub struct SelectedModel {
    summary: CodexModel,
    instructions: String,
    auto_compact_token_limit: Option<u64>,
    supports_parallel_tool_calls: bool,
}

impl SelectedModel {
    pub fn summary(&self) -> CodexModel {
        self.summary.clone()
    }

    pub fn id(&self) -> &str {
        &self.summary.id
    }

    pub fn instructions(&self) -> &str {
        &self.instructions
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

    pub fn supports_parallel_tool_calls(&self) -> bool {
        self.supports_parallel_tool_calls
    }

    pub fn default_reasoning_effort(&self) -> Option<ReasoningEffort> {
        self.summary.default_reasoning_effort
    }

    pub fn supports_reasoning_effort(&self, effort: ReasoningEffort) -> bool {
        self.summary
            .supported_reasoning_efforts
            .iter()
            .any(|option| option.reasoning_effort == effort)
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
            .find(|model| model.visibility == ModelVisibility::List)
            .map(|model| model.slug.clone())
            .ok_or_else(|| AppError::Provider("model catalog has no visible model".into()))?;

        for model in wire_models {
            validate_identifier("model slug", &model.slug, MAX_MODEL_ID_BYTES)?;
            validate_text(
                "model display name",
                &model.display_name,
                MAX_MODEL_TEXT_BYTES,
            )?;
            validate_text(
                "model instructions",
                &model.base_instructions,
                MAX_INSTRUCTIONS_BYTES,
            )?;
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
            let context_window = decode_context_window(&model)?;
            let auto_compact_token_limit = decode_auto_compact_token_limit(&model)?;
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
                    is_default: model.slug == default_slug,
                },
                instructions: model.base_instructions,
                auto_compact_token_limit,
                supports_parallel_tool_calls: model.supports_parallel_tool_calls,
            });
        }
        Ok(Self { models })
    }

    pub fn models(&self) -> &[SelectedModel] {
        &self.models
    }

    pub fn select(&self, requested: Option<&str>) -> Result<SelectedModel, AppError> {
        let selected = match requested {
            Some(id) => self.models.iter().find(|model| model.id() == id),
            None => self.models.iter().find(|model| model.summary.is_default),
        };
        selected.cloned().ok_or_else(|| {
            AppError::Protocol(match requested {
                Some(id) => format!("model `{id}` is not present in the current catalog"),
                None => "the current model catalog has no default".into(),
            })
        })
    }
}

const fn default_effective_context_window_percent() -> u8 {
    DEFAULT_EFFECTIVE_CONTEXT_WINDOW_PERCENT
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
    }
}
