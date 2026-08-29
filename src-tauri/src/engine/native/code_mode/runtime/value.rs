use serde_json::Value;

use super::super::super::provider::FunctionCallOutputContent;
use crate::engine::ImageDetail;

const IMAGE_EXPECTS: &str = "image expects a non-empty data URL, an object with image_url and optional detail, or an MCP image block";
const AUDIO_EXPECTS: &str =
    "audio expects a non-empty data URL, an object with audio_url, or an MCP audio block";
const IMAGE_DETAIL_META_KEY: &str = "codex/imageDetail";

pub(super) fn serialize_output_text(
    scope: &mut v8::PinScope<'_, '_>,
    value: v8::Local<'_, v8::Value>,
) -> Result<String, String> {
    if value.is_undefined()
        || value.is_null()
        || value.is_boolean()
        || value.is_number()
        || value.is_big_int()
        || value.is_string()
    {
        return Ok(value.to_rust_string_lossy(scope));
    }
    let try_catch = std::pin::pin!(v8::TryCatch::new(scope));
    let mut try_catch = try_catch.init();
    if let Some(stringified) = v8::json::stringify(&try_catch, value) {
        return Ok(stringified.to_rust_string_lossy(&try_catch));
    }
    if try_catch.has_caught() {
        return Err(try_catch
            .exception()
            .map(|exception| value_to_error_text(&mut try_catch, exception))
            .unwrap_or_else(|| "unknown Code Mode serialization error".to_string()));
    }
    Ok(value.to_rust_string_lossy(&try_catch))
}

pub(super) fn normalize_image(
    scope: &mut v8::PinScope<'_, '_>,
    value: v8::Local<'_, v8::Value>,
    detail_override: Option<String>,
) -> Result<FunctionCallOutputContent, String> {
    let (image_url, detail) = if value.is_string() {
        (value.to_rust_string_lossy(scope), None)
    } else if value.is_object() && !value.is_array() {
        let object =
            v8::Local::<v8::Object>::try_from(value).map_err(|_| IMAGE_EXPECTS.to_string())?;
        if let Some(image) = parse_image_object(scope, object)? {
            image
        } else {
            parse_mcp_image(scope, value)?
        }
    } else {
        return Err(IMAGE_EXPECTS.into());
    };
    validate_data_url("image", &image_url)?;
    let detail =
        detail_override
            .or(detail)
            .map(|detail| match detail.to_ascii_lowercase().as_str() {
                "auto" => Ok(ImageDetail::Auto),
                "low" => Ok(ImageDetail::Low),
                "high" => Ok(ImageDetail::High),
                "original" => Ok(ImageDetail::Original),
                _ => Err("image detail must be auto, low, high, or original".to_string()),
            });
    Ok(FunctionCallOutputContent::InputImage {
        image_url,
        detail: detail.transpose()?.or(Some(ImageDetail::High)),
    })
}

pub(super) fn normalize_audio(
    scope: &mut v8::PinScope<'_, '_>,
    value: v8::Local<'_, v8::Value>,
) -> Result<FunctionCallOutputContent, String> {
    let audio_url = if value.is_string() {
        value.to_rust_string_lossy(scope)
    } else if value.is_object() && !value.is_array() {
        let object =
            v8::Local::<v8::Object>::try_from(value).map_err(|_| AUDIO_EXPECTS.to_string())?;
        if let Some(audio_url) = parse_audio_object(scope, object)? {
            audio_url
        } else {
            parse_mcp_audio(scope, value)?
        }
    } else {
        return Err(AUDIO_EXPECTS.into());
    };
    validate_data_url("audio", &audio_url)?;
    Ok(FunctionCallOutputContent::InputAudio { audio_url })
}

fn parse_image_object(
    scope: &mut v8::PinScope<'_, '_>,
    object: v8::Local<'_, v8::Object>,
) -> Result<Option<(String, Option<String>)>, String> {
    let image_url_key = v8::String::new(scope, "image_url")
        .ok_or_else(|| "failed to allocate image helper key".to_string())?;
    let Some(image_url) = object.get(scope, image_url_key.into()) else {
        return Ok(None);
    };
    if image_url.is_undefined() {
        return Ok(None);
    }
    if !image_url.is_string() {
        return Err(IMAGE_EXPECTS.into());
    }
    let detail_key = v8::String::new(scope, "detail")
        .ok_or_else(|| "failed to allocate image detail key".to_string())?;
    let detail =
        parse_optional_string(scope, object.get(scope, detail_key.into()), "image detail")?;
    Ok(Some((image_url.to_rust_string_lossy(scope), detail)))
}

fn parse_audio_object(
    scope: &mut v8::PinScope<'_, '_>,
    object: v8::Local<'_, v8::Object>,
) -> Result<Option<String>, String> {
    let key = v8::String::new(scope, "audio_url")
        .ok_or_else(|| "failed to allocate audio helper key".to_string())?;
    let Some(audio_url) = object.get(scope, key.into()) else {
        return Ok(None);
    };
    if audio_url.is_undefined() {
        return Ok(None);
    }
    if !audio_url.is_string() {
        return Err(AUDIO_EXPECTS.into());
    }
    Ok(Some(audio_url.to_rust_string_lossy(scope)))
}

fn parse_mcp_image(
    scope: &mut v8::PinScope<'_, '_>,
    value: v8::Local<'_, v8::Value>,
) -> Result<(String, Option<String>), String> {
    let object = v8_value_to_json(scope, value)?
        .and_then(|value| value.as_object().cloned())
        .ok_or_else(|| IMAGE_EXPECTS.to_string())?;
    if object.get("type").and_then(Value::as_str) != Some("image") {
        return Err(IMAGE_EXPECTS.into());
    }
    let data = object
        .get("data")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "MCP image data is empty".to_string())?;
    let image_url = if data.to_ascii_lowercase().starts_with("data:") {
        data.to_string()
    } else {
        let media_type = object
            .get("mimeType")
            .or_else(|| object.get("mime_type"))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .unwrap_or("application/octet-stream");
        format!("data:{media_type};base64,{data}")
    };
    let detail = object
        .get("_meta")
        .and_then(Value::as_object)
        .and_then(|metadata| metadata.get(IMAGE_DETAIL_META_KEY))
        .and_then(Value::as_str)
        .filter(|detail| matches!(*detail, "auto" | "low" | "high" | "original"))
        .map(str::to_string);
    Ok((image_url, detail))
}

fn parse_mcp_audio(
    scope: &mut v8::PinScope<'_, '_>,
    value: v8::Local<'_, v8::Value>,
) -> Result<String, String> {
    let object = v8_value_to_json(scope, value)?
        .and_then(|value| value.as_object().cloned())
        .ok_or_else(|| AUDIO_EXPECTS.to_string())?;
    if object.get("type").and_then(Value::as_str) != Some("audio") {
        return Err(AUDIO_EXPECTS.into());
    }
    let data = object
        .get("data")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "MCP audio data is empty".to_string())?;
    if data.to_ascii_lowercase().starts_with("data:") {
        return Ok(data.to_string());
    }
    let media_type = object
        .get("mimeType")
        .or_else(|| object.get("mime_type"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or("application/octet-stream");
    Ok(format!("data:{media_type};base64,{data}"))
}

fn validate_data_url(kind: &str, value: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err(format!("{kind} URL cannot be empty"));
    }
    let Some((scheme, _)) = value.split_once(':') else {
        return Err(format!("{kind} output must use a base64 data URL"));
    };
    if !scheme.eq_ignore_ascii_case("data") {
        return Err(format!(
            "remote {kind} URLs are not supported; use a base64 data URL"
        ));
    }
    Ok(())
}

fn parse_optional_string(
    scope: &mut v8::PinScope<'_, '_>,
    value: Option<v8::Local<'_, v8::Value>>,
    label: &str,
) -> Result<Option<String>, String> {
    match value {
        Some(value) if value.is_string() => Ok(Some(value.to_rust_string_lossy(scope))),
        Some(value) if value.is_null_or_undefined() => Ok(None),
        Some(_) => Err(format!("{label} must be a string when provided")),
        None => Ok(None),
    }
}

pub(super) fn v8_value_to_json(
    scope: &mut v8::PinScope<'_, '_>,
    value: v8::Local<'_, v8::Value>,
) -> Result<Option<Value>, String> {
    let try_catch = std::pin::pin!(v8::TryCatch::new(scope));
    let mut try_catch = try_catch.init();
    let Some(stringified) = v8::json::stringify(&try_catch, value) else {
        if try_catch.has_caught() {
            return Err(try_catch
                .exception()
                .map(|exception| value_to_error_text(&mut try_catch, exception))
                .unwrap_or_else(|| "unknown Code Mode serialization error".to_string()));
        }
        return Ok(None);
    };
    serde_json::from_str(&stringified.to_rust_string_lossy(&try_catch))
        .map(Some)
        .map_err(|error| format!("failed to serialize JavaScript value: {error}"))
}

pub(super) fn json_to_v8<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    value: &Value,
) -> Option<v8::Local<'s, v8::Value>> {
    let json = serde_json::to_string(value).ok()?;
    let json = v8::String::new(scope, &json)?;
    v8::json::parse(scope, json)
}

pub(super) fn value_to_error_text(
    scope: &mut v8::PinScope<'_, '_>,
    value: v8::Local<'_, v8::Value>,
) -> String {
    if value.is_object()
        && let Ok(object) = v8::Local::<v8::Object>::try_from(value)
        && let Some(key) = v8::String::new(scope, "stack")
        && let Some(stack) = object.get(scope, key.into())
        && stack.is_string()
    {
        return stack.to_rust_string_lossy(scope);
    }
    value.to_rust_string_lossy(scope)
}

pub(super) fn throw_type_error(scope: &mut v8::PinScope<'_, '_>, message: &str) {
    if let Some(message) = v8::String::new(scope, message) {
        scope.throw_exception(message.into());
    }
}
