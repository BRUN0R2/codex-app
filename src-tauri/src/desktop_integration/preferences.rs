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
const APPLICATION_PREFERENCES_SCHEMA_VERSION: u8 = 2;
const MAX_APPLICATION_PREFERENCES_BYTES: u64 = 16 * 1024;
const MIN_TRANSIENT_NOTIFICATION_DURATION_SECONDS: u8 = 3;
const MAX_TRANSIENT_NOTIFICATION_DURATION_SECONDS: u8 = 30;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplicationPreferences {
    pub schema_version: u8,
    pub start_with_windows: bool,
    pub start_minimized: bool,
    pub close_to_tray: bool,
    pub notifications: NotificationPreferences,
}

impl Default for ApplicationPreferences {
    fn default() -> Self {
        Self {
            schema_version: APPLICATION_PREFERENCES_SCHEMA_VERSION,
            start_with_windows: false,
            start_minimized: false,
            close_to_tray: false,
            notifications: NotificationPreferences::default(),
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
        self.notifications.validate()?;
        Ok(self)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NotificationPreferences {
    pub enabled: bool,
    pub transient_position: TransientNotificationPosition,
    pub transient_duration_seconds: u8,
    pub events: NotificationEventPreferences,
}

impl Default for NotificationPreferences {
    fn default() -> Self {
        Self {
            enabled: true,
            transient_position: TransientNotificationPosition::BottomRight,
            transient_duration_seconds: 8,
            events: NotificationEventPreferences::default(),
        }
    }
}

impl NotificationPreferences {
    fn validate(self) -> Result<Self, AppError> {
        if !(MIN_TRANSIENT_NOTIFICATION_DURATION_SECONDS
            ..=MAX_TRANSIENT_NOTIFICATION_DURATION_SECONDS)
            .contains(&self.transient_duration_seconds)
        {
            return Err(AppError::Protocol(format!(
                "transient notification duration must be between {MIN_TRANSIENT_NOTIFICATION_DURATION_SECONDS} and {MAX_TRANSIENT_NOTIFICATION_DURATION_SECONDS} seconds"
            )));
        }
        Ok(self)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TransientNotificationPosition {
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NotificationRule {
    pub enabled: bool,
    pub priority: bool,
}

impl NotificationRule {
    const fn new(enabled: bool, priority: bool) -> Self {
        Self { enabled, priority }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NotificationEventPreferences {
    pub approval_required: NotificationRule,
    pub task_completed: NotificationRule,
    pub task_failed: NotificationRule,
    pub usage_limit_reset: NotificationRule,
    pub usage_reset_available: NotificationRule,
    pub luna_reserve_available: NotificationRule,
}

impl Default for NotificationEventPreferences {
    fn default() -> Self {
        Self {
            approval_required: NotificationRule::new(true, true),
            task_completed: NotificationRule::new(true, false),
            task_failed: NotificationRule::new(true, true),
            usage_limit_reset: NotificationRule::new(true, false),
            usage_reset_available: NotificationRule::new(true, true),
            luna_reserve_available: NotificationRule::new(true, true),
        }
    }
}

#[derive(Debug)]
pub struct ApplicationPreferencesState {
    preferences: Mutex<ApplicationPreferences>,
}

impl ApplicationPreferencesState {
    pub fn load(app: &AppHandle) -> Result<Self, AppError> {
        let path = application_preferences_path(app)?;
        let decoded = read(&path)?;
        if decoded.migrated {
            PreparedPreferencesWrite::prepare(path, &decoded.preferences)?.commit()?;
        }
        startup::synchronize(app, decoded.preferences.start_with_windows)?;

        Ok(Self {
            preferences: Mutex::new(decoded.preferences),
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

struct DecodedApplicationPreferences {
    preferences: ApplicationPreferences,
    migrated: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VersionOneApplicationPreferences {
    schema_version: u8,
    start_with_windows: bool,
    start_minimized: bool,
    close_to_tray: bool,
}

impl VersionOneApplicationPreferences {
    fn migrate(self) -> Result<ApplicationPreferences, AppError> {
        if self.schema_version != 1 {
            return Err(AppError::Protocol(format!(
                "application preferences schema version {} is unsupported",
                self.schema_version
            )));
        }
        ApplicationPreferences {
            schema_version: APPLICATION_PREFERENCES_SCHEMA_VERSION,
            start_with_windows: self.start_with_windows,
            start_minimized: self.start_minimized,
            close_to_tray: self.close_to_tray,
            notifications: NotificationPreferences::default(),
        }
        .validate()
    }
}

fn read(path: &Path) -> Result<DecodedApplicationPreferences, AppError> {
    if !path.exists() {
        return Ok(DecodedApplicationPreferences {
            preferences: ApplicationPreferences::default(),
            migrated: false,
        });
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
    decode(&source)
}

fn decode(source: &str) -> Result<DecodedApplicationPreferences, AppError> {
    let value = serde_json::from_str::<serde_json::Value>(source).map_err(|error| {
        AppError::Protocol(format!(
            "invalid application preferences JSON structure: {error}"
        ))
    })?;
    let schema_version = value
        .as_object()
        .and_then(|object| object.get("schemaVersion"))
        .and_then(serde_json::Value::as_u64)
        .and_then(|version| u8::try_from(version).ok())
        .ok_or_else(|| {
            AppError::Protocol(
                "application preferences schemaVersion must be an unsigned byte".to_string(),
            )
        })?;

    match schema_version {
        1 => {
            let previous = serde_json::from_value::<VersionOneApplicationPreferences>(value)
                .map_err(invalid_preferences_structure)?;
            Ok(DecodedApplicationPreferences {
                preferences: previous.migrate()?,
                migrated: true,
            })
        }
        APPLICATION_PREFERENCES_SCHEMA_VERSION => {
            let preferences = serde_json::from_value::<ApplicationPreferences>(value)
                .map_err(invalid_preferences_structure)?
                .validate()?;
            Ok(DecodedApplicationPreferences {
                preferences,
                migrated: false,
            })
        }
        unsupported => Err(AppError::Protocol(format!(
            "application preferences schema version {unsupported} is unsupported"
        ))),
    }
}

fn invalid_preferences_structure(error: serde_json::Error) -> AppError {
    AppError::Protocol(format!(
        "invalid application preferences JSON structure: {error}"
    ))
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
    use super::{
        APPLICATION_PREFERENCES_SCHEMA_VERSION, ApplicationPreferences, NotificationPreferences,
        decode,
    };

    #[test]
    fn defaults_keep_background_behaviors_disabled_and_notifications_enabled() {
        let preferences = ApplicationPreferences::default();

        assert!(!preferences.start_with_windows);
        assert!(!preferences.start_minimized);
        assert!(!preferences.close_to_tray);
        assert!(preferences.notifications.enabled);
        assert_eq!(preferences.notifications.transient_duration_seconds, 8);
    }

    #[test]
    fn rejects_minimized_start_without_windows_startup() {
        let preferences = ApplicationPreferences {
            schema_version: APPLICATION_PREFERENCES_SCHEMA_VERSION,
            start_with_windows: false,
            start_minimized: true,
            close_to_tray: false,
            notifications: NotificationPreferences::default(),
        };

        assert!(preferences.validate().is_err());
    }

    #[test]
    fn migrates_version_one_without_losing_application_behaviors() {
        let decoded = decode(
            r#"{
                "schemaVersion": 1,
                "startWithWindows": true,
                "startMinimized": true,
                "closeToTray": true
            }"#,
        )
        .expect("version one preferences should migrate");

        assert!(decoded.migrated);
        assert_eq!(decoded.preferences.schema_version, 2);
        assert!(decoded.preferences.start_with_windows);
        assert!(decoded.preferences.start_minimized);
        assert!(decoded.preferences.close_to_tray);
        assert_eq!(
            decoded.preferences.notifications,
            NotificationPreferences::default()
        );
    }

    #[test]
    fn rejects_unknown_application_preference_fields() {
        let source = r#"{
            "schemaVersion": 2,
            "startWithWindows": false,
            "startMinimized": false,
            "closeToTray": false,
            "notifications": {
                "enabled": true,
                "transientPosition": "bottomRight",
                "transientDurationSeconds": 8,
                "events": {
                    "approvalRequired": {"enabled": true, "priority": true},
                    "taskCompleted": {"enabled": true, "priority": false},
                    "taskFailed": {"enabled": true, "priority": true},
                    "usageLimitReset": {"enabled": true, "priority": false},
                    "usageResetAvailable": {"enabled": true, "priority": true},
                    "lunaReserveAvailable": {"enabled": true, "priority": true}
                }
            },
            "legacy": true
        }"#;

        assert!(decode(source).is_err());
    }

    #[test]
    fn rejects_out_of_range_notification_duration() {
        let mut preferences = ApplicationPreferences::default();
        preferences.notifications.transient_duration_seconds = 31;

        assert!(preferences.validate().is_err());
    }

    #[test]
    fn rejects_unknown_schema_versions() {
        assert!(decode(r#"{"schemaVersion": 3}"#).is_err());
    }
}
