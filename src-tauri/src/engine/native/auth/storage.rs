mod keyring;
mod vault;

use std::time::Duration;

use tauri::AppHandle;
use tauri::Manager as _;

use self::keyring::system_keyring;
use self::vault::{CredentialNamespace, CredentialVault};
use super::error::AuthError;
use super::token::AuthRecord;

/// Upper bound for a single secure-storage operation. The Windows Credential
/// Manager and the age/scrypt decryption run on the blocking pool; a hung
/// service (locked vault, RDP session) must surface as an error instead of
/// blocking `read_account` forever during boot.
const CREDENTIAL_OPERATION_TIMEOUT: Duration = Duration::from_secs(10);
const CREDENTIALS_DIRECTORY_NAME: &str = "credentials-v2";

#[derive(Clone)]
pub(super) struct CredentialStorage {
    vault: CredentialVault,
}

impl CredentialStorage {
    pub fn new(app: &AppHandle) -> Result<Self, AuthError> {
        let namespace = CredentialNamespace::for_application(&app.config().identifier)?;
        let credentials_directory = app
            .path()
            .app_data_dir()
            .map_err(|error| {
                AuthError::CredentialStorage(format!(
                    "could not resolve the application data directory: {error}"
                ))
            })?
            .join(CREDENTIALS_DIRECTORY_NAME);
        Ok(Self {
            vault: CredentialVault::new(credentials_directory, system_keyring(), namespace),
        })
    }

    pub async fn load(&self) -> Result<Option<AuthRecord>, AuthError> {
        let vault = self.vault.clone();
        let handle = tokio::task::spawn_blocking(move || vault.load());
        match tokio::time::timeout(CREDENTIAL_OPERATION_TIMEOUT, handle).await {
            Ok(result) => result.map_err(|error| AuthError::Task(error.to_string()))?,
            Err(_) => Err(credential_operation_timeout("loading")),
        }
    }

    pub async fn save(&self, record: &AuthRecord) -> Result<(), AuthError> {
        let vault = self.vault.clone();
        let record = record.clone();
        let handle = tokio::task::spawn_blocking(move || vault.save(record));
        match tokio::time::timeout(CREDENTIAL_OPERATION_TIMEOUT, handle).await {
            Ok(result) => result.map_err(|error| AuthError::Task(error.to_string()))?,
            Err(_) => Err(credential_operation_timeout("saving")),
        }
    }

    pub async fn delete(&self) -> Result<bool, AuthError> {
        let vault = self.vault.clone();
        let handle = tokio::task::spawn_blocking(move || vault.delete());
        match tokio::time::timeout(CREDENTIAL_OPERATION_TIMEOUT, handle).await {
            Ok(result) => result.map_err(|error| AuthError::Task(error.to_string()))?,
            Err(_) => Err(credential_operation_timeout("deleting")),
        }
    }
}

fn credential_operation_timeout(operation: &str) -> AuthError {
    AuthError::CredentialStorage(format!(
        "timed out while {operation}; the system credential service may be unavailable"
    ))
}
