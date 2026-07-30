use std::sync::Arc;

use super::super::error::AuthError;

pub(super) trait KeyringStore: Send + Sync {
    fn load(&self, service: &str, account: &str) -> Result<Option<String>, AuthError>;
    fn save(&self, service: &str, account: &str, value: &str) -> Result<(), AuthError>;
}

#[derive(Debug, Clone, Copy)]
struct SystemKeyring;

pub(super) fn system_keyring() -> Arc<dyn KeyringStore> {
    Arc::new(SystemKeyring)
}

#[cfg(windows)]
fn credential_entry(service: &str, account: &str) -> Result<keyring_core::Entry, AuthError> {
    use keyring_core::api::CredentialStoreApi as _;

    let store = windows_native_keyring_store::Store::new().map_err(keyring_error)?;
    store.build(service, account, None).map_err(keyring_error)
}

#[cfg(windows)]
impl KeyringStore for SystemKeyring {
    fn load(&self, service: &str, account: &str) -> Result<Option<String>, AuthError> {
        match credential_entry(service, account)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring_core::Error::NoEntry) => Ok(None),
            Err(error) => Err(keyring_error(error)),
        }
    }

    fn save(&self, service: &str, account: &str, value: &str) -> Result<(), AuthError> {
        credential_entry(service, account)?
            .set_password(value)
            .map_err(keyring_error)
    }
}

#[cfg(windows)]
fn keyring_error(error: keyring_core::Error) -> AuthError {
    AuthError::CredentialStorage(error.to_string())
}

#[cfg(not(windows))]
impl KeyringStore for SystemKeyring {
    fn load(&self, _service: &str, _account: &str) -> Result<Option<String>, AuthError> {
        Err(AuthError::UnsupportedPlatform)
    }

    fn save(&self, _service: &str, _account: &str, _value: &str) -> Result<(), AuthError> {
        Err(AuthError::UnsupportedPlatform)
    }
}
