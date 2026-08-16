use std::fs::{self, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use chrono::Utc;
use serde::Serialize;
use tauri::{AppHandle, Emitter as _, Manager as _};

use crate::engine::{
    DiagnosticStream, RUNTIME_DIAGNOSTIC_EVENT, RuntimeDiagnostic, RuntimeDiagnosticSubsystem,
};
use crate::error::AppError;

const LOG_DIRECTORY: &str = "logs";
const CURRENT_LOG_FILE: &str = "runtime.jsonl";
const PREVIOUS_LOG_FILE: &str = "runtime.previous.jsonl";
const MAX_LOG_BYTES: u64 = 1_048_576;
const MAX_DIAGNOSTIC_MESSAGE_BYTES: usize = 4_096;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum DiagnosticLevel {
    Error,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedDiagnostic<'a> {
    timestamp: String,
    level: DiagnosticLevel,
    subsystem: &'a str,
    message: &'a str,
}

#[derive(Debug, Default)]
pub(super) struct RuntimeDiagnostics {
    path: Mutex<Option<PathBuf>>,
}

impl RuntimeDiagnostics {
    pub(super) fn initialize(&self, app: &AppHandle) -> Result<String, AppError> {
        let directory = app
            .path()
            .app_data_dir()
            .map_err(|error| AppError::FileSystem(error.to_string()))?
            .join(LOG_DIRECTORY);
        self.initialize_at(directory)
    }

    pub(super) fn record(
        &self,
        level: DiagnosticLevel,
        subsystem: RuntimeDiagnosticSubsystem,
        message: &str,
    ) -> Result<(), AppError> {
        let path = self
            .path
            .lock()
            .map_err(|_| AppError::State("diagnostic log ownership was poisoned".into()))?
            .clone()
            .ok_or_else(|| AppError::State("diagnostic log is not initialized".into()))?;
        let message = truncate_utf8(message.trim(), MAX_DIAGNOSTIC_MESSAGE_BYTES);
        let record = PersistedDiagnostic {
            timestamp: Utc::now().to_rfc3339(),
            level,
            subsystem: subsystem.as_str(),
            message: &message,
        };
        let mut encoded = serde_json::to_vec(&record).map_err(|error| {
            AppError::State(format!("diagnostic could not be encoded: {error}"))
        })?;
        encoded.push(b'\n');
        append_rotating(&path, &encoded, MAX_LOG_BYTES)
    }

    pub(super) fn record_error(
        &self,
        subsystem: RuntimeDiagnosticSubsystem,
        message: &str,
    ) -> Result<(), AppError> {
        self.record(DiagnosticLevel::Error, subsystem, message)
    }

    pub(super) fn emit(
        &self,
        app: &AppHandle,
        subsystem: RuntimeDiagnosticSubsystem,
        message: String,
    ) {
        let visible_message = match self.record(DiagnosticLevel::Error, subsystem, &message) {
            Ok(()) => message,
            Err(error) => {
                eprintln!(
                    "diagnostic persistence failed for `{}`: {error}",
                    subsystem.as_str()
                );
                format!("{message}; diagnostic persistence failed: {error}")
            }
        };
        if let Err(error) = app.emit(
            RUNTIME_DIAGNOSTIC_EVENT,
            RuntimeDiagnostic {
                stream: DiagnosticStream::Runtime,
                message: visible_message,
            },
        ) {
            eprintln!("runtime diagnostic delivery failed: {error}");
        }
    }

    fn initialize_at(&self, directory: PathBuf) -> Result<String, AppError> {
        fs::create_dir_all(&directory).map_err(|error| {
            AppError::FileSystem(format!(
                "could not create diagnostic directory `{}`: {error}",
                directory.display()
            ))
        })?;
        let path = directory.join(CURRENT_LOG_FILE);
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|error| {
                AppError::FileSystem(format!(
                    "could not open diagnostic log `{}`: {error}",
                    path.display()
                ))
            })?;
        *self
            .path
            .lock()
            .map_err(|_| AppError::State("diagnostic log ownership was poisoned".into()))? =
            Some(path.clone());
        Ok(path.to_string_lossy().into_owned())
    }
}

fn append_rotating(path: &Path, encoded: &[u8], maximum_bytes: u64) -> Result<(), AppError> {
    let current_bytes = match fs::metadata(path) {
        Ok(metadata) => metadata.len(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
        Err(error) => {
            return Err(AppError::FileSystem(format!(
                "could not inspect diagnostic log `{}`: {error}",
                path.display()
            )));
        }
    };
    if current_bytes.saturating_add(encoded.len() as u64) > maximum_bytes && current_bytes > 0 {
        let previous = path.with_file_name(PREVIOUS_LOG_FILE);
        match fs::remove_file(&previous) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(AppError::FileSystem(format!(
                    "could not replace previous diagnostic log `{}`: {error}",
                    previous.display()
                )));
            }
        }
        fs::rename(path, &previous).map_err(|error| {
            AppError::FileSystem(format!(
                "could not rotate diagnostic log `{}`: {error}",
                path.display()
            ))
        })?;
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| {
            AppError::FileSystem(format!(
                "could not append diagnostic log `{}`: {error}",
                path.display()
            ))
        })?;
    file.write_all(encoded).map_err(|error| {
        AppError::FileSystem(format!(
            "could not write diagnostic log `{}`: {error}",
            path.display()
        ))
    })?;
    file.flush().map_err(|error| {
        AppError::FileSystem(format!(
            "could not flush diagnostic log `{}`: {error}",
            path.display()
        ))
    })
}

fn truncate_utf8(value: &str, maximum_bytes: usize) -> String {
    if value.len() <= maximum_bytes {
        return value.to_string();
    }
    let mut end = maximum_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
}

#[cfg(test)]
mod tests {
    use std::fs;

    use uuid::Uuid;

    use super::{DiagnosticLevel, RuntimeDiagnostics, append_rotating};
    use crate::engine::RuntimeDiagnosticSubsystem;

    #[test]
    fn persists_bounded_structured_diagnostics() {
        let directory =
            std::env::temp_dir().join(format!("codex-app-diagnostics-{}", Uuid::now_v7()));
        let diagnostics = RuntimeDiagnostics::default();
        let path = diagnostics
            .initialize_at(directory.clone())
            .expect("diagnostic log should initialize");

        diagnostics
            .record(
                DiagnosticLevel::Error,
                RuntimeDiagnosticSubsystem::Runtime,
                "command failed",
            )
            .expect("diagnostic should persist");

        let content = fs::read_to_string(path).expect("diagnostic log should be readable");
        assert!(content.contains(r#""level":"error""#));
        assert!(content.contains(r#""subsystem":"runtime""#));
        assert!(content.contains(r#""message":"command failed""#));
        fs::remove_dir_all(directory).expect("temporary diagnostic directory should be removed");
    }

    #[test]
    fn keeps_one_previous_log_when_the_bound_is_crossed() {
        let directory =
            std::env::temp_dir().join(format!("codex-app-diagnostic-rotation-{}", Uuid::now_v7()));
        fs::create_dir_all(&directory).expect("temporary directory should be created");
        let current = directory.join(super::CURRENT_LOG_FILE);

        append_rotating(&current, b"first\n", 10).expect("first record should be written");
        append_rotating(&current, b"second\n", 10).expect("second record should rotate");

        assert_eq!(
            fs::read_to_string(directory.join(super::PREVIOUS_LOG_FILE))
                .expect("previous log should exist"),
            "first\n"
        );
        assert_eq!(
            fs::read_to_string(&current).expect("current log should exist"),
            "second\n"
        );
        fs::remove_dir_all(directory).expect("temporary diagnostic directory should be removed");
    }
}
