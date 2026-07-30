mod keyring;
mod vault;

use std::path::PathBuf;

use tauri::AppHandle;
use tauri::Manager as _;
use zeroize::Zeroizing;

use self::keyring::system_keyring;
use self::vault::CredentialVault;
use super::error::AuthError;
use super::token::AuthRecord;

#[derive(Clone)]
pub(super) struct CredentialStorage {
    vault: CredentialVault,
}

impl CredentialStorage {
    pub fn new(app: &AppHandle) -> Result<Self, AuthError> {
        let codex_home = resolve_codex_home(app)?;
        Ok(Self {
            vault: CredentialVault::new(codex_home, system_keyring()),
        })
    }

    pub async fn load(&self) -> Result<Option<AuthRecord>, AuthError> {
        let vault = self.vault.clone();
        tokio::task::spawn_blocking(move || vault.load())
            .await
            .map_err(|error| AuthError::Task(error.to_string()))?
    }

    pub async fn save(&self, record: &AuthRecord) -> Result<(), AuthError> {
        let vault = self.vault.clone();
        let serialized = serde_json::to_string(record).map_err(|error| {
            AuthError::CredentialStorage(format!("could not serialize credentials: {error}"))
        })?;
        let serialized = Zeroizing::new(serialized);
        tokio::task::spawn_blocking(move || vault.save_serialized(&serialized))
            .await
            .map_err(|error| AuthError::Task(error.to_string()))?
    }

    pub async fn delete(&self) -> Result<bool, AuthError> {
        let vault = self.vault.clone();
        tokio::task::spawn_blocking(move || vault.delete())
            .await
            .map_err(|error| AuthError::Task(error.to_string()))?
    }
}

fn resolve_codex_home(app: &AppHandle) -> Result<PathBuf, AuthError> {
    match std::env::var_os("CODEX_HOME") {
        Some(value) if value.is_empty() => Err(AuthError::CredentialStorage(
            "CODEX_HOME is set but empty".into(),
        )),
        Some(value) => Ok(PathBuf::from(value)),
        None => app
            .path()
            .home_dir()
            .map(|home| home.join(".codex"))
            .map_err(|error| {
                AuthError::CredentialStorage(format!("could not resolve the user profile: {error}"))
            }),
    }
}
