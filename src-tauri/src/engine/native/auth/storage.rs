mod keyring;
mod vault;

use tauri::AppHandle;
use tauri::Manager as _;

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
        let credentials_directory = app
            .path()
            .app_data_dir()
            .map_err(|error| {
                AuthError::CredentialStorage(format!(
                    "could not resolve the application data directory: {error}"
                ))
            })?
            .join("credentials");
        Ok(Self {
            vault: CredentialVault::new(credentials_directory, system_keyring()),
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
        let record = record.clone();
        tokio::task::spawn_blocking(move || vault.save(record))
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
