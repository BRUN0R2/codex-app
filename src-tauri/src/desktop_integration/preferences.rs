use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tempfile::NamedTempFile;

use crate::{
    desktop_integration::startup,
    error::{AppError, CommandResult},
};

const APPLICATION_PREFERENCES_FILE_NAME: &str = "application-preferences.json";
const APPLICATION_PREFERENCES_SCHEMA_VERSION: u8 = 1;
const MAX_APPLICATION_PREFERENCES_BYTES: u64 = 16 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplicationPreferences {
    pub schema_version: u8,
    pub start_with_windows: bool,
    pub start_minimized: bool,
    pub close_to_tray: bool,
}

impl Default for ApplicationPreferences {
    fn default() -> Self {
        Self {
            schema_version: APPLICATION_PREFERENCES_SCHEMA_VERSION,
            start_with_windows: false,
            start_minimized: false,
            close_to_tray: false,
        }
    }
}

impl ApplicationPreferences {
    fn validate(self) -> Result<Self, AppError> {
        if self.schema_version != APPLICATION_PREFERENCES_SCHEMA_VERSION {
            return Err(AppError::Protocol(format!(
                "application preferences schema version {} is unsupported",
                self.schema_version
            )));
        }
        if self.start_minimized && !self.start_with_windows {
            return Err(AppError::Protocol(
                "starting minimized requires Windows startup to be enabled".to_string(),
            ));
        }
        Ok(self)
    }
}

#[derive(Debug)]
pub struct ApplicationPreferencesState {
    preferences: Mutex<ApplicationPreferences>,
}

impl ApplicationPreferencesState {
    pub fn load(app: &AppHandle) -> Result<Self, AppError> {
        let path = application_preferences_path(app)?;
        let preferences = read(&path)?;
        startup::synchronize(app, preferences.start_with_windows)?;

        Ok(Self {
            preferences: Mutex::new(preferences),
        })
    }

    pub fn current(&self) -> Result<ApplicationPreferences, AppError> {
        self.preferences
            .lock()
            .map(|preferences| *preferences)
            .map_err(|_| AppError::State("application preferences are unavailable".to_string()))
    }

    fn lock(&self) -> Result<MutexGuard<'_, ApplicationPreferences>, AppError> {
        self.preferences
            .lock()
            .map_err(|_| AppError::State("application preferences are unavailable".to_string()))
    }
}

#[tauri::command]
pub fn application_preferences_read(
    state: State<'_, ApplicationPreferencesState>,
) -> CommandResult<ApplicationPreferences> {
    Ok(state.current()?)
}

#[tauri::command(rename_all = "camelCase")]
pub fn application_preferences_update(
    app: AppHandle,
    state: State<'_, ApplicationPreferencesState>,
    preferences: ApplicationPreferences,
) -> CommandResult<ApplicationPreferences> {
    let preferences = preferences.validate()?;
    let path = application_preferences_path(&app)?;
    let mut current = state.lock()?;
    let prepared_write = PreparedPreferencesWrite::prepare(path, &preferences)?;
    let previous_startup_registration = startup::registration_enabled(&app)?;

    startup::synchronize(&app, preferences.start_with_windows)?;
    if let Err(persist_error) = prepared_write.commit() {
        if let Err(rollback_error) = startup::synchronize(&app, previous_startup_registration) {
            return Err(AppError::State(format!(
                "could not persist application preferences ({persist_error}); Windows startup rollback also failed ({rollback_error})"
            ))
            .into());
        }
        return Err(persist_error.into());
    }

    *current = preferences;
    Ok(preferences)
}

fn read(path: &Path) -> Result<ApplicationPreferences, AppError> {
    if !path.exists() {
        return Ok(ApplicationPreferences::default());
    }

    let metadata = fs::metadata(path).map_err(|error| {
        AppError::Storage(format!("could not inspect {}: {error}", path.display()))
    })?;
    if metadata.len() > MAX_APPLICATION_PREFERENCES_BYTES {
        return Err(AppError::Protocol(
            "application preferences exceed the 16 KiB safety limit".to_string(),
        ));
    }

    let source = fs::read_to_string(path).map_err(|error| {
        AppError::Storage(format!("could not read {}: {error}", path.display()))
    })?;
    serde_json::from_str::<ApplicationPreferences>(&source)
        .map_err(|error| {
            AppError::Protocol(format!(
                "invalid application preferences JSON structure: {error}"
            ))
        })?
        .validate()
}

struct PreparedPreferencesWrite {
    target: PathBuf,
    temporary: NamedTempFile,
}

impl PreparedPreferencesWrite {
    fn prepare(target: PathBuf, preferences: &ApplicationPreferences) -> Result<Self, AppError> {
        let parent = target.parent().ok_or_else(|| {
            AppError::Storage(format!("{} has no parent directory", target.display()))
        })?;
        fs::create_dir_all(parent).map_err(|error| {
            AppError::Storage(format!(
                "could not create application preferences directory {}: {error}",
                parent.display()
            ))
        })?;

        let serialized = serde_json::to_vec_pretty(preferences).map_err(|error| {
            AppError::Protocol(format!(
                "could not serialize application preferences: {error}"
            ))
        })?;
        if serialized.len() as u64 > MAX_APPLICATION_PREFERENCES_BYTES {
            return Err(AppError::Protocol(
                "application preferences exceed the 16 KiB safety limit".to_string(),
            ));
        }

        let mut temporary = NamedTempFile::new_in(parent).map_err(|error| {
            AppError::Storage(format!(
                "could not create a temporary application preferences file in {}: {error}",
                parent.display()
            ))
        })?;
        temporary
            .write_all(&serialized)
            .and_then(|()| temporary.write_all(b"\n"))
            .map_err(|error| {
                AppError::Storage(format!("could not write application preferences: {error}"))
            })?;
        temporary.as_file_mut().sync_all().map_err(|error| {
            AppError::Storage(format!("could not flush application preferences: {error}"))
        })?;

        Ok(Self { target, temporary })
    }

    fn commit(self) -> Result<(), AppError> {
        self.temporary.persist(&self.target).map_err(|error| {
            AppError::Storage(format!(
                "could not atomically replace {}: {}",
                self.target.display(),
                error.error
            ))
        })?;
        Ok(())
    }
}

fn application_preferences_path(app: &AppHandle) -> Result<PathBuf, AppError> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join(APPLICATION_PREFERENCES_FILE_NAME))
        .map_err(|error| {
            AppError::Storage(format!(
                "could not resolve the application preferences path: {error}"
            ))
        })
}

#[cfg(test)]
mod tests {
    use super::{APPLICATION_PREFERENCES_SCHEMA_VERSION, ApplicationPreferences};

    #[test]
    fn defaults_keep_background_behaviors_disabled() {
        let preferences = ApplicationPreferences::default();

        assert!(!preferences.start_with_windows);
        assert!(!preferences.start_minimized);
        assert!(!preferences.close_to_tray);
    }

    #[test]
    fn rejects_minimized_start_without_windows_startup() {
        let preferences = ApplicationPreferences {
            schema_version: APPLICATION_PREFERENCES_SCHEMA_VERSION,
            start_with_windows: false,
            start_minimized: true,
            close_to_tray: false,
        };

        assert!(preferences.validate().is_err());
    }

    #[test]
    fn rejects_unknown_application_preference_fields() {
        let source = r#"{
            "schemaVersion": 1,
            "startWithWindows": false,
            "startMinimized": false,
            "closeToTray": false,
            "legacy": true
        }"#;

        assert!(serde_json::from_str::<ApplicationPreferences>(source).is_err());
    }
}
