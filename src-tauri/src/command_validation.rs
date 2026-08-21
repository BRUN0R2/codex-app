use std::path::Path;

use crate::error::{AppError, CommandError, CommandResult};

pub const MAX_IDENTIFIER_BYTES: usize = 256;
pub const MAX_MODEL_NAME_BYTES: usize = 256;
pub const MAX_TIMEZONE_BYTES: usize = 128;
pub const MAX_TURN_TEXT_BYTES: usize = 1_048_576;
pub const MAX_TURN_ATTACHMENTS: usize = 12;
pub const MAX_DIAGNOSTIC_MESSAGE_BYTES: usize = 4_096;

/// Single semantic rule for every engine identifier: non-blank, bounded and
/// free of control characters.
pub fn identifier_is_valid(value: &str) -> bool {
    !value.trim().is_empty()
        && value.len() <= MAX_IDENTIFIER_BYTES
        && !value.chars().any(char::is_control)
}

pub async fn validate_workspace(value: &str) -> CommandResult<String> {
    let path = Path::new(value);
    if !path.is_absolute() {
        return Err(AppError::FileSystem("workspace path must be absolute".into()).into());
    }
    let canonical = tokio::fs::canonicalize(path)
        .await
        .map_err(|error| CommandError::from(AppError::FileSystem(error.to_string())))?;
    let metadata = tokio::fs::metadata(&canonical)
        .await
        .map_err(|error| CommandError::from(AppError::FileSystem(error.to_string())))?;
    if !metadata.is_dir() {
        return Err(AppError::FileSystem("workspace path is not a directory".into()).into());
    }
    Ok(normalize_windows_canonical_path(
        &canonical.to_string_lossy(),
    ))
}

pub fn normalize_windows_canonical_path(value: &str) -> String {
    if let Some(path) = value.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{path}")
    } else {
        value.strip_prefix(r"\\?\").unwrap_or(value).to_string()
    }
}

pub fn validate_protocol_id(label: &str, value: &str) -> CommandResult<()> {
    if identifier_is_valid(value) {
        return Ok(());
    }
    Err(AppError::Protocol(format!(
        "{label} must contain between 1 and {MAX_IDENTIFIER_BYTES} bytes without control characters"
    ))
    .into())
}

pub fn validate_model_name(model: String) -> CommandResult<String> {
    let model = model.trim();
    if model.is_empty() || model.len() > MAX_MODEL_NAME_BYTES || model.chars().any(char::is_control)
    {
        return Err(AppError::Protocol(format!(
            "model must contain between 1 and {MAX_MODEL_NAME_BYTES} bytes"
        ))
        .into());
    }
    Ok(model.into())
}

pub fn validate_timezone(value: String) -> CommandResult<String> {
    let value = value.trim().to_string();
    if value.is_empty()
        || value.len() > MAX_TIMEZONE_BYTES
        || value.chars().any(|character| {
            character.is_control()
                || !(character.is_ascii_alphanumeric()
                    || matches!(character, '/' | '_' | '-' | '+'))
        })
    {
        return Err(AppError::Protocol("timezone is invalid".into()).into());
    }
    Ok(value)
}

pub fn validate_diagnostic_message(value: String) -> CommandResult<String> {
    let value = value.trim().to_string();
    if value.is_empty()
        || value.len() > MAX_DIAGNOSTIC_MESSAGE_BYTES
        || value
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    {
        return Err(AppError::Protocol(format!(
            "diagnostic message must contain between 1 and {MAX_DIAGNOSTIC_MESSAGE_BYTES} bytes"
        ))
        .into());
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use serde_json::json;
    use tempfile::TempDir;

    use super::{
        normalize_windows_canonical_path, validate_diagnostic_message, validate_protocol_id,
        validate_workspace,
    };

    #[test]
    fn canonical_windows_prefix_is_not_exposed_to_the_ui() {
        assert_eq!(
            normalize_windows_canonical_path(r"\\?\C:\workspace"),
            r"C:\workspace"
        );
        assert_eq!(
            normalize_windows_canonical_path(r"\\?\UNC\server\share"),
            r"\\server\share"
        );
    }

    #[test]
    fn protocol_ids_reject_empty_control_and_oversized_values() {
        assert!(validate_protocol_id("thread id", "thread-1").is_ok());
        assert!(validate_protocol_id("thread id", "").is_err());
        assert!(validate_protocol_id("thread id", "thread\n1").is_err());
        assert!(
            validate_protocol_id("thread id", &"x".repeat(super::MAX_IDENTIFIER_BYTES + 1))
                .is_err()
        );
        assert!(validate_protocol_id("thread id", "   ").is_err());
    }

    #[tokio::test]
    async fn workspace_validation_accepts_only_existing_absolute_directories() {
        let directory = TempDir::new().expect("temporary directory should be created");
        let validated = validate_workspace(&directory.path().display().to_string())
            .await
            .expect("absolute directory should validate");
        assert!(Path::new(&validated).is_absolute());

        let file = directory.path().join("not-a-directory.txt");
        tokio::fs::write(&file, b"test")
            .await
            .expect("fixture file should be written");
        assert!(
            validate_workspace(&file.display().to_string())
                .await
                .is_err()
        );
        assert!(validate_workspace("relative-workspace").await.is_err());
    }

    #[test]
    fn service_tier_payload_remains_explicit() {
        let payload = json!({ "type": "tier", "id": "priority" });
        assert_eq!(payload["type"], "tier");
        assert_eq!(payload["id"], "priority");
    }

    #[test]
    fn frontend_diagnostics_are_bounded_and_reject_hidden_controls() {
        assert_eq!(
            validate_diagnostic_message("  markdown worker failed  ".into())
                .expect("valid diagnostic should be accepted"),
            "markdown worker failed"
        );
        assert!(validate_diagnostic_message("".into()).is_err());
        assert!(validate_diagnostic_message("invalid\u{0000}message".into()).is_err());
        assert!(
            validate_diagnostic_message("x".repeat(super::MAX_DIAGNOSTIC_MESSAGE_BYTES + 1))
                .is_err()
        );
    }
}
