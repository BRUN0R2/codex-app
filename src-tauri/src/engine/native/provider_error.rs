use futures_util::StreamExt as _;
use reqwest::Response;
use reqwest::header::{CONTENT_TYPE, HeaderMap, RETRY_AFTER};
use serde_json::Value;

use super::text::format_duration;
use crate::error::AppError;

const MAX_ERROR_BYTES: usize = 65_536;
const MAX_PUBLIC_ERROR_CHARACTERS: usize = 2_000;
const MAX_REQUEST_IDENTIFIER_CHARACTERS: usize = 256;
const EDGE_ACCESS_BLOCKED_CODE: &str = "edge_access_blocked";
const HTML_ERROR_RESPONSE_CODE: &str = "html_error_response";

#[derive(Debug)]
pub(super) struct ProviderResponseFailure {
    pub error: AppError,
    pub edge_blocked: bool,
}

#[derive(Debug, PartialEq, Eq)]
struct DecodedProviderError {
    code: Option<String>,
    message: String,
    retry_after_seconds: Option<u64>,
    edge_blocked: bool,
}

pub(super) async fn decode_provider_response_failure(
    response: Response,
) -> ProviderResponseFailure {
    let status = response.status().as_u16();
    let retry_after_header = response
        .headers()
        .get(RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|seconds| *seconds > 0);
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let request_identifier = provider_request_identifier(response.headers());
    let decoded = match read_error_body(response).await {
        Ok(bytes) => decode_provider_error_body(
            status,
            content_type.as_deref(),
            request_identifier.as_deref(),
            &bytes,
        ),
        Err(_) if status == 403 && content_type_is_html(content_type.as_deref()) => {
            html_error(status, request_identifier.as_deref())
        }
        Err(error) => DecodedProviderError {
            code: None,
            message: bounded_error_text(&format!(
                "the provider error body could not be read: {error}"
            )),
            retry_after_seconds: None,
            edge_blocked: false,
        },
    };
    let error = AppError::from_provider_rejection(
        Some(status),
        decoded.code.as_deref(),
        decoded.message,
        decoded.retry_after_seconds.or(retry_after_header),
    );
    ProviderResponseFailure {
        error,
        edge_blocked: decoded.edge_blocked,
    }
}

fn decode_provider_error_body(
    status: u16,
    content_type: Option<&str>,
    request_identifier: Option<&str>,
    bytes: &[u8],
) -> DecodedProviderError {
    if bytes.is_empty() {
        return DecodedProviderError {
            code: None,
            message: "the provider returned an empty error body".into(),
            retry_after_seconds: None,
            edge_blocked: false,
        };
    }
    let body = match std::str::from_utf8(bytes) {
        Ok(body) if !body.trim().is_empty() => body,
        Ok(_) => {
            return DecodedProviderError {
                code: None,
                message: "the provider returned a blank error body".into(),
                retry_after_seconds: None,
                edge_blocked: false,
            };
        }
        Err(error) => {
            return DecodedProviderError {
                code: None,
                message: format!("the provider returned a non-UTF-8 error body: {error}"),
                retry_after_seconds: None,
                edge_blocked: false,
            };
        }
    };

    if content_type_is_html(content_type) || looks_like_html(body) {
        return html_error(status, request_identifier);
    }

    let Ok(value) = serde_json::from_str::<Value>(body) else {
        return DecodedProviderError {
            code: None,
            message: bounded_error_text(body),
            retry_after_seconds: None,
            edge_blocked: false,
        };
    };
    let error = value.get("error").unwrap_or(&value);
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .map(bounded_error_text)
        .filter(|message| !message.is_empty())
        .unwrap_or_else(|| "the provider rejected the request".into());
    let kind = error
        .get("type")
        .and_then(Value::as_str)
        .or_else(|| error.get("code").and_then(Value::as_str));
    let code = error
        .get("code")
        .and_then(Value::as_str)
        .or_else(|| error.get("type").and_then(Value::as_str))
        .map(bounded_error_text)
        .filter(|code| !code.is_empty());
    let reset_seconds = error
        .get("resets_in_seconds")
        .and_then(Value::as_u64)
        .filter(|seconds| *seconds > 0);

    let mut formatted = message;
    if let Some(reset) = reset_seconds.map(format_duration) {
        formatted.push_str("; reset in approximately ");
        formatted.push_str(&reset);
    }
    if let Some(kind) = kind {
        formatted.push_str(" (provider type: ");
        formatted.push_str(&bounded_error_text(kind));
        formatted.push(')');
    }
    DecodedProviderError {
        code,
        message: bounded_error_text(&formatted),
        retry_after_seconds: reset_seconds,
        edge_blocked: false,
    }
}

fn html_error(status: u16, request_identifier: Option<&str>) -> DecodedProviderError {
    let edge_blocked = status == 403;
    let (code, mut message) = if edge_blocked {
        (
            EDGE_ACCESS_BLOCKED_CODE,
            "OpenAI edge blocked the request before it reached the provider API".to_string(),
        )
    } else {
        (
            HTML_ERROR_RESPONSE_CODE,
            "the provider returned an HTML error page".to_string(),
        )
    };
    if let Some(identifier) = request_identifier {
        message.push_str("; edge request ID ");
        message.push_str(identifier);
    }
    message.push_str(" (provider type: ");
    message.push_str(code);
    message.push(')');
    DecodedProviderError {
        code: Some(code.into()),
        message,
        retry_after_seconds: None,
        edge_blocked,
    }
}

fn provider_request_identifier(headers: &HeaderMap) -> Option<String> {
    [
        "cf-ray",
        "x-request-id",
        "openai-request-id",
        "x-openai-request-id",
    ]
    .into_iter()
    .find_map(|name| {
        headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .and_then(bounded_request_identifier)
    })
}

fn bounded_request_identifier(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    let identifier = value
        .chars()
        .take(MAX_REQUEST_IDENTIFIER_CHARACTERS)
        .filter(|character| !character.is_control() && !character.is_whitespace())
        .collect::<String>();
    (!identifier.is_empty()).then_some(identifier)
}

fn content_type_is_html(content_type: Option<&str>) -> bool {
    content_type
        .and_then(|value| value.split(';').next())
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("text/html"))
}

fn looks_like_html(body: &str) -> bool {
    let prefix = body
        .trim_start_matches('\u{feff}')
        .trim_start()
        .chars()
        .take(256)
        .collect::<String>()
        .to_ascii_lowercase();
    prefix.starts_with("<!doctype html")
        || prefix.starts_with("<html")
        || prefix.starts_with("<head")
        || prefix.starts_with("<body")
}

fn bounded_error_text(value: &str) -> String {
    let mut output = String::new();
    let mut previous_was_space = false;
    for character in value.trim().chars().take(MAX_PUBLIC_ERROR_CHARACTERS) {
        let character = if character.is_control() {
            ' '
        } else {
            character
        };
        if character.is_whitespace() {
            if previous_was_space {
                continue;
            }
            output.push(' ');
            previous_was_space = true;
        } else {
            output.push(character);
            previous_was_space = false;
        }
    }
    if output.is_empty() {
        "the provider rejected the request".into()
    } else {
        output
    }
}

async fn read_error_body(response: Response) -> Result<Vec<u8>, AppError> {
    let mut output = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| AppError::Transport(error.to_string()))?;
        if output.len().saturating_add(chunk.len()) > MAX_ERROR_BYTES {
            return Err(AppError::Provider(format!(
                "provider error response exceeds {MAX_ERROR_BYTES} bytes"
            )));
        }
        output.extend_from_slice(&chunk);
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::{EDGE_ACCESS_BLOCKED_CODE, decode_provider_error_body};
    use crate::error::AppError;

    #[test]
    fn usage_limit_error_preserves_code_and_reset_delay() {
        let decoded = decode_provider_error_body(
            429,
            Some("application/json"),
            None,
            br#"{"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","resets_in_seconds":511936}}"#,
        );

        assert_eq!(
            decoded.message,
            "The usage limit has been reached; reset in approximately 5d 22h (provider type: usage_limit_reached)"
        );
        assert_eq!(decoded.code.as_deref(), Some("usage_limit_reached"));
        assert_eq!(decoded.retry_after_seconds, Some(511_936));
        assert!(matches!(
            AppError::from_provider_rejection(
                Some(429),
                decoded.code.as_deref(),
                decoded.message,
                decoded.retry_after_seconds,
            ),
            AppError::RateLimited {
                retry_after_seconds: Some(511_936),
                ..
            }
        ));
    }

    #[test]
    fn context_error_prefers_the_provider_code() {
        let decoded = decode_provider_error_body(
            400,
            Some("application/json"),
            None,
            br#"{"error":{"code":"context_length_exceeded","type":"invalid_request_error","message":"too large"}}"#,
        );

        assert_eq!(decoded.code.as_deref(), Some("context_length_exceeded"));
        assert_eq!(
            decoded.message,
            "too large (provider type: invalid_request_error)"
        );
    }

    #[test]
    fn html_403_is_typed_without_exposing_markup() {
        let decoded = decode_provider_error_body(
            403,
            Some("text/html; charset=utf-8"),
            Some("8f1234-IAD"),
            br#"<html><head><style>.blocked-icon{color:red}</style></head><body>blocked</body></html>"#,
        );

        assert!(decoded.edge_blocked);
        assert_eq!(decoded.code.as_deref(), Some(EDGE_ACCESS_BLOCKED_CODE));
        assert!(decoded.message.contains("edge request ID 8f1234-IAD"));
        assert!(
            decoded
                .message
                .contains("provider type: edge_access_blocked")
        );
        assert!(!decoded.message.contains("<html"));
        assert!(!decoded.message.contains("blocked-icon"));
    }

    #[test]
    fn non_403_html_is_sanitized_without_becoming_an_edge_block() {
        let decoded = decode_provider_error_body(
            502,
            None,
            None,
            b"<!doctype html><title>Bad gateway</title>",
        );

        assert!(!decoded.edge_blocked);
        assert_eq!(decoded.code.as_deref(), Some("html_error_response"));
        assert_eq!(
            decoded.message,
            "the provider returned an HTML error page (provider type: html_error_response)"
        );
    }
}
