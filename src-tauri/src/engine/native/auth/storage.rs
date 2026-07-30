use std::path::Path;
use std::path::PathBuf;

use sha2::Digest as _;
use sha2::Sha256;
use tauri::AppHandle;
use tauri::Manager as _;
use zeroize::Zeroizing;

use super::error::AuthError;
use super::token::AuthRecord;

const KEYRING_SERVICE: &str = "Codex Auth";
const HEX_DIGITS: &[u8; 16] = b"0123456789abcdef";

#[derive(Clone, Debug)]
pub(super) struct CredentialStorage {
    key: String,
}

impl CredentialStorage {
    pub fn new(app: &AppHandle) -> Result<Self, AuthError> {
        let codex_home = resolve_codex_home(app)?;
        Ok(Self {
            key: compute_store_key(&codex_home),
        })
    }

    pub async fn load(&self) -> Result<Option<AuthRecord>, AuthError> {
        let key = self.key.clone();
        tokio::task::spawn_blocking(move || load_blocking(&key))
            .await
            .map_err(|error| AuthError::Task(error.to_string()))?
    }

    pub async fn save(&self, record: &AuthRecord) -> Result<(), AuthError> {
        let key = self.key.clone();
        let serialized = serde_json::to_string(record).map_err(|error| {
            AuthError::CredentialStorage(format!("could not serialize credentials: {error}"))
        })?;
        let serialized = Zeroizing::new(serialized);
        tokio::task::spawn_blocking(move || save_blocking(&key, &serialized))
            .await
            .map_err(|error| AuthError::Task(error.to_string()))?
    }

    pub async fn delete(&self) -> Result<bool, AuthError> {
        let key = self.key.clone();
        tokio::task::spawn_blocking(move || delete_blocking(&key))
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

fn compute_store_key(codex_home: &Path) -> String {
    let canonical = codex_home
        .canonicalize()
        .unwrap_or_else(|_| codex_home.to_path_buf());
    let mut hasher = Sha256::new();
    hasher.update(canonical.to_string_lossy().as_bytes());
    let digest = hasher.finalize();
    let mut truncated = String::with_capacity(16);
    for byte in digest.iter().take(8) {
        truncated.push(HEX_DIGITS[usize::from(byte >> 4)] as char);
        truncated.push(HEX_DIGITS[usize::from(byte & 0x0f)] as char);
    }
    format!("cli|{truncated}")
}

#[cfg(windows)]
fn credential_entry(key: &str) -> Result<keyring_core::Entry, AuthError> {
    use keyring_core::api::CredentialStoreApi as _;

    let store = windows_native_keyring_store::Store::new().map_err(keyring_error)?;
    store
        .build(KEYRING_SERVICE, key, None)
        .map_err(keyring_error)
}

#[cfg(windows)]
fn load_blocking(key: &str) -> Result<Option<AuthRecord>, AuthError> {
    let serialized = match credential_entry(key)?.get_password() {
        Ok(serialized) => serialized,
        Err(keyring_core::Error::NoEntry) => return Ok(None),
        Err(error) => return Err(keyring_error(error)),
    };
    let serialized = Zeroizing::new(serialized);
    serde_json::from_str(&serialized)
        .map(Some)
        .map_err(|error| {
            AuthError::CredentialStorage(format!("stored credentials are invalid: {error}"))
        })
}

#[cfg(windows)]
fn save_blocking(key: &str, serialized: &str) -> Result<(), AuthError> {
    credential_entry(key)?
        .set_password(serialized)
        .map_err(keyring_error)
}

#[cfg(windows)]
fn delete_blocking(key: &str) -> Result<bool, AuthError> {
    match credential_entry(key)?.delete_credential() {
        Ok(()) => Ok(true),
        Err(keyring_core::Error::NoEntry) => Ok(false),
        Err(error) => Err(keyring_error(error)),
    }
}

#[cfg(windows)]
fn keyring_error(error: keyring_core::Error) -> AuthError {
    AuthError::CredentialStorage(error.to_string())
}

#[cfg(not(windows))]
fn load_blocking(_key: &str) -> Result<Option<AuthRecord>, AuthError> {
    Err(AuthError::UnsupportedPlatform)
}

#[cfg(not(windows))]
fn save_blocking(_key: &str, _serialized: &str) -> Result<(), AuthError> {
    Err(AuthError::UnsupportedPlatform)
}

#[cfg(not(windows))]
fn delete_blocking(_key: &str) -> Result<bool, AuthError> {
    Err(AuthError::UnsupportedPlatform)
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::compute_store_key;

    #[test]
    fn store_key_matches_the_codex_direct_keyring_shape() {
        let key = compute_store_key(Path::new("C:\\Users\\codex\\.codex"));

        assert!(key.starts_with("cli|"));
        assert_eq!(key.len(), 20);
    }
}
