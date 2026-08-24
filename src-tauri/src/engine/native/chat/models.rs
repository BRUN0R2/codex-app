use std::collections::{BTreeMap, HashSet};

use serde::Deserialize;

use crate::engine::{ChatModelLane, ChatModelOption, ChatThinkingEffort};
use crate::error::AppError;

const MAX_MODEL_ID_BYTES: usize = 256;
const MAX_MODEL_TEXT_BYTES: usize = 16_384;

#[derive(Debug, Clone)]
pub(in crate::engine::native) struct SelectedChatModel {
    summary: ChatModelOption,
}

impl SelectedChatModel {
    pub fn id(&self) -> &str {
        &self.summary.id
    }

    pub fn model(&self) -> &str {
        &self.summary.model
    }

    pub fn thinking_effort(&self) -> Option<ChatThinkingEffort> {
        self.summary.thinking_effort
    }

    pub fn summary(&self) -> ChatModelOption {
        self.summary.clone()
    }
}

#[derive(Debug)]
pub(super) struct ChatModelCatalog {
    models: Vec<SelectedChatModel>,
}

impl ChatModelCatalog {
    pub fn from_wire(wire: ModelsWire, maximum_models: usize) -> Result<Self, AppError> {
        let default_slug = normalized_optional(wire.default_model_slug);
        let model_metadata = decode_model_metadata(wire.models)?;
        let categories = wire
            .categories
            .into_iter()
            .flatten()
            .filter(|category| category.disabled_by_admin != Some(true))
            .collect::<Vec<_>>();

        let mut candidates = Vec::new();
        for version in &wire.versions {
            let Some(version) = version else { continue };
            let version_options = options_from_version(version, &categories, &model_metadata)?;
            if !version_options.is_empty() {
                candidates = version_options;
                break;
            }
        }
        if candidates.is_empty() {
            candidates = categories
                .iter()
                .rev()
                .filter_map(|category| option_from_category(category, &model_metadata))
                .collect();
        }
        if candidates.is_empty() {
            candidates = model_metadata.values().map(option_from_model).collect();
        }

        let mut seen = HashSet::new();
        let mut models = Vec::new();
        for mut candidate in candidates {
            if models.len() >= maximum_models {
                return Err(AppError::Provider(format!(
                    "ChatGPT model catalog exceeds {maximum_models} options"
                )));
            }
            validate_option(&candidate)?;
            let deduplication_key = (
                candidate.model.clone(),
                candidate.thinking_effort,
                candidate.lane,
            );
            if !seen.insert(deduplication_key) {
                continue;
            }
            candidate.id = option_id(&candidate);
            models.push(SelectedChatModel { summary: candidate });
        }
        if models.is_empty() {
            return Err(AppError::Provider(
                "ChatGPT returned an empty consumer model catalog".into(),
            ));
        }

        let default_effort = default_slug
            .as_deref()
            .and_then(|slug| model_metadata.get(slug))
            .and_then(|model| model.default_thinking_effort);
        if let Some(default_index) = default_slug.as_deref().and_then(|slug| {
            default_effort
                .and_then(|effort| {
                    models.iter().position(|model| {
                        model.model() == slug && model.thinking_effort() == Some(effort)
                    })
                })
                .or_else(|| models.iter().position(|model| model.model() == slug))
        }) {
            models[default_index].summary.is_default = true;
        }
        Ok(Self { models })
    }

    pub fn models(&self) -> &[SelectedChatModel] {
        &self.models
    }

    pub fn select(&self, requested: Option<&str>) -> Result<SelectedChatModel, AppError> {
        let selected = match requested {
            Some(requested) => self
                .models
                .iter()
                .find(|model| model.id() == requested)
                .ok_or_else(|| {
                    AppError::Protocol(format!(
                        "ChatGPT model option `{requested}` is not in the current catalog"
                    ))
                })?,
            None => self
                .models
                .iter()
                .find(|model| model.summary.is_default)
                .ok_or_else(|| {
                    AppError::Protocol("the current model catalog has no default".into())
                })?,
        };
        Ok(selected.clone())
    }
}

#[derive(Debug, Deserialize)]
pub(super) struct ModelsWire {
    #[serde(default)]
    default_model_slug: Option<String>,
    #[serde(default)]
    models: Vec<Option<ModelWire>>,
    #[serde(default)]
    categories: Vec<Option<CategoryWire>>,
    #[serde(default)]
    versions: Vec<Option<VersionWire>>,
    #[serde(default, rename = "slider_settings")]
    _slider_settings: Vec<Option<SliderSettingWire>>,
    #[serde(default, rename = "internal_groups")]
    _internal_groups: Vec<Option<InternalGroupWire>>,
}

#[derive(Debug, Deserialize)]
struct ModelWire {
    slug: String,
    #[serde(default)]
    default_thinking_effort: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    description: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CategoryWire {
    #[serde(default)]
    default_model: Option<String>,
    #[serde(default)]
    disabled_by_admin: Option<bool>,
    #[serde(default)]
    human_category_name: Option<String>,
    #[serde(default)]
    human_category_short_name: Option<String>,
    #[serde(default)]
    model_lane: Option<String>,
    #[serde(default)]
    short_explainer: Option<String>,
    #[serde(default)]
    supported_models: Vec<Option<String>>,
    #[serde(default)]
    tagline: Option<String>,
    #[serde(default)]
    title: Option<String>,
}

#[derive(Debug, Deserialize)]
struct VersionWire {
    id: String,
    #[serde(default)]
    intelligence_presets: Vec<Option<PresetWire>>,
    #[serde(default)]
    slugs: Vec<Option<String>>,
}

#[derive(Debug, Deserialize)]
struct PresetWire {
    #[serde(default)]
    lane: Option<String>,
    model_slug: String,
    #[serde(default)]
    selected_display_title: Option<String>,
    #[serde(default)]
    thinking_effort: Option<String>,
    #[serde(default)]
    title: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SliderSettingWire {
    #[serde(rename = "model_slug")]
    _model_slug: String,
    #[serde(rename = "thinking_effort")]
    _thinking_effort: String,
}

#[derive(Debug, Deserialize)]
struct InternalGroupWire {
    #[serde(default, rename = "model_ids")]
    _model_ids: Vec<Option<String>>,
}

#[derive(Debug, Clone)]
struct ModelMetadata {
    slug: String,
    title: String,
    description: Option<String>,
    default_thinking_effort: Option<ChatThinkingEffort>,
}

fn decode_model_metadata(
    values: Vec<Option<ModelWire>>,
) -> Result<BTreeMap<String, ModelMetadata>, AppError> {
    let mut output = BTreeMap::new();
    for value in values.into_iter().flatten() {
        let slug = normalized_required("model slug", value.slug)?;
        let title = normalized_optional(value.title).unwrap_or_else(|| humanize_slug(&slug));
        let description = normalized_optional(value.description);
        let default_thinking_effort = value
            .default_thinking_effort
            .as_deref()
            .and_then(parse_thinking_effort);
        if output
            .insert(
                slug.clone(),
                ModelMetadata {
                    slug,
                    title,
                    description,
                    default_thinking_effort,
                },
            )
            .is_some()
        {
            return Err(AppError::Provider(
                "ChatGPT model catalog contains duplicate model slugs".into(),
            ));
        }
    }
    Ok(output)
}

fn options_from_version(
    version: &VersionWire,
    categories: &[CategoryWire],
    models: &BTreeMap<String, ModelMetadata>,
) -> Result<Vec<ChatModelOption>, AppError> {
    let version_id = normalized_required("model version id", version.id.clone())?;
    let version_slugs = version
        .slugs
        .iter()
        .flatten()
        .filter_map(|slug| normalized_optional(Some(slug.clone())))
        .collect::<HashSet<_>>();
    let options = version
        .intelligence_presets
        .iter()
        .flatten()
        .filter_map(|preset| {
            let lane = preset.lane.as_deref().and_then(parse_lane);
            let mut model_slug = normalized_optional(Some(preset.model_slug.clone()))?;
            if lane == Some(ChatModelLane::Instant)
                && let Some(automatic) = categories.iter().find(|category| {
                    category.model_lane.as_deref() == Some("auto")
                        && category
                            .default_model
                            .as_ref()
                            .is_some_and(|slug| version_slugs.contains(slug))
                })
                && let Some(default_model) = normalized_optional(automatic.default_model.clone())
            {
                model_slug = default_model;
            }
            let model = models.get(&model_slug);
            let category = categories
                .iter()
                .find(|category| category.default_model.as_deref() == Some(model_slug.as_str()));
            let thinking_effort = preset
                .thinking_effort
                .as_deref()
                .and_then(parse_thinking_effort);
            Some(ChatModelOption {
                id: String::new(),
                model: model_slug.clone(),
                title: normalized_optional(preset.title.clone())
                    .or_else(|| category.and_then(category_title))
                    .or_else(|| model.map(|model| model.title.clone()))
                    .unwrap_or_else(|| humanize_slug(&model_slug)),
                description: category
                    .and_then(category_description)
                    .or_else(|| model.and_then(|model| model.description.clone())),
                lane,
                thinking_effort,
                version_id: Some(version_id.clone()),
                selected_label: normalized_optional(preset.selected_display_title.clone()),
                is_default: false,
            })
        })
        .collect::<Vec<_>>();
    Ok(options)
}

fn option_from_category(
    category: &CategoryWire,
    models: &BTreeMap<String, ModelMetadata>,
) -> Option<ChatModelOption> {
    let slug = normalized_optional(category.default_model.clone()).or_else(|| {
        category
            .supported_models
            .iter()
            .flatten()
            .find_map(|slug| normalized_optional(Some(slug.clone())))
    })?;
    let model = models.get(&slug);
    Some(ChatModelOption {
        id: String::new(),
        model: slug.clone(),
        title: category_title(category)
            .or_else(|| model.map(|model| model.title.clone()))
            .unwrap_or_else(|| humanize_slug(&slug)),
        description: category_description(category)
            .or_else(|| model.and_then(|model| model.description.clone())),
        lane: category.model_lane.as_deref().and_then(parse_lane),
        thinking_effort: None,
        version_id: None,
        selected_label: None,
        is_default: false,
    })
}

fn option_from_model(model: &ModelMetadata) -> ChatModelOption {
    ChatModelOption {
        id: String::new(),
        model: model.slug.clone(),
        title: model.title.clone(),
        description: model.description.clone(),
        lane: None,
        thinking_effort: None,
        version_id: None,
        selected_label: None,
        is_default: false,
    }
}

fn category_title(category: &CategoryWire) -> Option<String> {
    normalized_optional(category.title.clone())
        .or_else(|| normalized_optional(category.human_category_short_name.clone()))
        .or_else(|| normalized_optional(category.human_category_name.clone()))
}

fn category_description(category: &CategoryWire) -> Option<String> {
    normalized_optional(category.short_explainer.clone())
        .or_else(|| normalized_optional(category.tagline.clone()))
}

fn parse_lane(value: &str) -> Option<ChatModelLane> {
    match value {
        "auto" => Some(ChatModelLane::Auto),
        "instant" => Some(ChatModelLane::Instant),
        "thinking" => Some(ChatModelLane::Thinking),
        "thinking_mini" => Some(ChatModelLane::ThinkingMini),
        "pro" => Some(ChatModelLane::Pro),
        _ => None,
    }
}

fn parse_thinking_effort(value: &str) -> Option<ChatThinkingEffort> {
    match value {
        "standard" => Some(ChatThinkingEffort::Standard),
        "extended" => Some(ChatThinkingEffort::Extended),
        "min" => Some(ChatThinkingEffort::Min),
        "max" => Some(ChatThinkingEffort::Max),
        "ultra" => Some(ChatThinkingEffort::Ultra),
        "xhigh" => Some(ChatThinkingEffort::XHigh),
        "zero" => Some(ChatThinkingEffort::Zero),
        _ => None,
    }
}

fn option_id(option: &ChatModelOption) -> String {
    format!(
        "{}#{}#{}",
        option.model,
        option.lane.map(lane_name).unwrap_or("default"),
        option
            .thinking_effort
            .map(ChatThinkingEffort::as_str)
            .unwrap_or("default")
    )
}

const fn lane_name(lane: ChatModelLane) -> &'static str {
    match lane {
        ChatModelLane::Auto => "auto",
        ChatModelLane::Instant => "instant",
        ChatModelLane::Thinking => "thinking",
        ChatModelLane::ThinkingMini => "thinking_mini",
        ChatModelLane::Pro => "pro",
    }
}

fn validate_option(option: &ChatModelOption) -> Result<(), AppError> {
    validate_text("model slug", &option.model, MAX_MODEL_ID_BYTES)?;
    validate_text("model title", &option.title, MAX_MODEL_TEXT_BYTES)?;
    if let Some(description) = option.description.as_deref() {
        validate_text("model description", description, MAX_MODEL_TEXT_BYTES)?;
    }
    Ok(())
}

fn normalized_required(label: &str, value: String) -> Result<String, AppError> {
    normalized_optional(Some(value))
        .ok_or_else(|| AppError::Provider(format!("ChatGPT returned an invalid {label}")))
}

fn normalized_optional(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty() && value.len() <= MAX_MODEL_TEXT_BYTES)
}

fn validate_text(label: &str, value: &str, maximum_bytes: usize) -> Result<(), AppError> {
    if value.trim().is_empty() || value.len() > maximum_bytes || value.chars().any(char::is_control)
    {
        return Err(AppError::Provider(format!(
            "ChatGPT returned an invalid {label}"
        )));
    }
    Ok(())
}

fn humanize_slug(slug: &str) -> String {
    if slug == "auto" {
        return "Auto".into();
    }
    slug.split(['-', '_', ':'])
        .filter(|part| !part.is_empty())
        .map(|part| {
            if part.eq_ignore_ascii_case("gpt") {
                "GPT".into()
            } else {
                let mut characters = part.chars();
                match characters.next() {
                    Some(first) => format!("{}{}", first.to_uppercase(), characters.as_str()),
                    None => String::new(),
                }
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::{ChatModelCatalog, ModelsWire};
    use crate::engine::{ChatModelLane, ChatThinkingEffort};

    #[test]
    fn consumer_catalog_preserves_official_pro_preset_semantics() {
        let wire: ModelsWire = serde_json::from_str(
            r#"{
                "default_model_slug":"gpt-5.6",
                "models":[
                    {"slug":"gpt-5.6","title":"GPT-5.6","default_thinking_effort":"standard"},
                    {"slug":"gpt-5.6-pro","title":"GPT-5.6 Pro","default_thinking_effort":"max"}
                ],
                "categories":[],
                "versions":[{
                    "id":"gpt-5.6",
                    "slugs":["gpt-5.6","gpt-5.6-pro"],
                    "intelligence_presets":[
                        {"lane":"instant","model_slug":"gpt-5.6","title":"Instant","thinking_effort":"zero"},
                        {"lane":"pro","model_slug":"gpt-5.6-pro","title":"Pro","thinking_effort":"max"}
                    ]
                }]
            }"#,
        )
        .expect("wire should decode");

        let catalog = ChatModelCatalog::from_wire(wire, 100).expect("catalog should decode");
        assert_eq!(catalog.models().len(), 2);
        assert!(catalog.models()[0].summary().is_default);
        assert_eq!(catalog.models()[1].model(), "gpt-5.6-pro");
        assert_eq!(catalog.models()[1].summary().lane, Some(ChatModelLane::Pro));
        assert_eq!(
            catalog.models()[1].thinking_effort(),
            Some(ChatThinkingEffort::Max)
        );
    }

    #[test]
    fn unknown_consumer_efforts_are_ignored_instead_of_becoming_codex_efforts() {
        let wire: ModelsWire = serde_json::from_str(
            r#"{
                "default_model_slug":"auto",
                "models":[{"slug":"auto","default_thinking_effort":"future"}],
                "categories":[],
                "versions":[]
            }"#,
        )
        .expect("wire should decode");

        let catalog = ChatModelCatalog::from_wire(wire, 100).expect("catalog should decode");
        assert_eq!(catalog.models()[0].thinking_effort(), None);
    }

    #[test]
    fn default_option_uses_the_catalog_default_thinking_effort() {
        let wire: ModelsWire = serde_json::from_str(
            r#"{
                "default_model_slug":"gpt-5.6",
                "models":[{"slug":"gpt-5.6","default_thinking_effort":"standard"}],
                "categories":[],
                "versions":[{
                    "id":"gpt-5.6",
                    "slugs":["gpt-5.6"],
                    "intelligence_presets":[
                        {"lane":"pro","model_slug":"gpt-5.6","thinking_effort":"max"},
                        {"lane":"thinking","model_slug":"gpt-5.6","thinking_effort":"standard"}
                    ]
                }]
            }"#,
        )
        .expect("wire should decode");

        let catalog = ChatModelCatalog::from_wire(wire, 100).expect("catalog should decode");
        assert!(!catalog.models()[0].summary().is_default);
        assert!(catalog.models()[1].summary().is_default);
        assert_eq!(
            catalog.models()[1].thinking_effort(),
            Some(ChatThinkingEffort::Standard)
        );
    }

    #[test]
    fn catalog_without_a_default_requires_an_explicit_selection() {
        let wire: ModelsWire = serde_json::from_str(
            r#"{
                "models":[{"slug":"gpt-5.6"}],
                "categories":[],
                "versions":[]
            }"#,
        )
        .expect("wire should decode");

        let catalog = ChatModelCatalog::from_wire(wire, 100).expect("catalog should decode");
        assert!(catalog.select(None).is_err());
        assert!(catalog.select(Some("gpt-5.6#default#default")).is_ok());
    }
}
