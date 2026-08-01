use std::fs;
use std::io::ErrorKind;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use age::decrypt;
use age::encrypt;
use age::scrypt::{Identity as ScryptIdentity, Recipient as ScryptRecipient};
use age::secrecy::{ExposeSecret as _, SecretString};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use rand::Rng as _;
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, Zeroizing};

use super::super::error::AuthError;
use super::super::token::AuthRecord;
use super::keyring::KeyringStore;

const CREDENTIAL_VERSION: u8 = 1;
const KEYRING_SERVICE: &str = "codex-desktop-next";
const KEYRING_ACCOUNT: &str = "chatgpt-oauth-v1";
const CREDENTIAL_FILE_NAME: &str = "chatgpt-oauth.age";
const PASSPHRASE_BYTES: usize = 32;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CredentialEnvelope {
    version: u8,
    record: AuthRecord,
}

#[derive(Clone)]
pub(super) struct CredentialVault {
    directory: PathBuf,
    keyring: Arc<dyn KeyringStore>,
}

impl CredentialVault {
    pub fn new(directory: PathBuf, keyring: Arc<dyn KeyringStore>) -> Self {
        Self { directory, keyring }
    }

    pub fn load(&self) -> Result<Option<AuthRecord>, AuthError> {
        let path = self.credential_path();
        let ciphertext = match fs::read(&path) {
            Ok(ciphertext) => ciphertext,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(storage_error(format!(
                    "could not read encrypted credentials at {}: {error}",
                    path.display()
                )));
            }
        };
        let passphrase = self
            .keyring
            .load(KEYRING_SERVICE, KEYRING_ACCOUNT)?
            .ok_or_else(|| {
                storage_error(format!(
                    "the encryption key for {} is missing from the system credential store",
                    path.display()
                ))
            })?;
        let passphrase = SecretString::from(passphrase);
        let plaintext = Zeroizing::new(decrypt_file(&ciphertext, &passphrase)?);
        let envelope: CredentialEnvelope = serde_json::from_slice(&plaintext).map_err(|error| {
            storage_error(format!(
                "could not decode encrypted credentials at {}: {error}",
                path.display()
            ))
        })?;
        if envelope.version != CREDENTIAL_VERSION {
            return Err(storage_error(format!(
                "credential version {} is unsupported; expected {CREDENTIAL_VERSION}",
                envelope.version
            )));
        }
        envelope.record.validate()?;
        Ok(Some(envelope.record))
    }

    pub fn save(&self, record: AuthRecord) -> Result<(), AuthError> {
        record.validate()?;
        fs::create_dir_all(&self.directory).map_err(|error| {
            storage_error(format!(
                "could not create credential directory {}: {error}",
                self.directory.display()
            ))
        })?;
        let envelope = CredentialEnvelope {
            version: CREDENTIAL_VERSION,
            record,
        };
        let plaintext = serde_json::to_vec(&envelope)
            .map_err(|error| storage_error(format!("could not encode credentials: {error}")))?;
        let plaintext = Zeroizing::new(plaintext);
        let passphrase = self.load_or_create_passphrase()?;
        let ciphertext = encrypt_file(&plaintext, &passphrase)?;
        write_file_atomically(&self.credential_path(), &ciphertext).map_err(|error| {
            storage_error(format!(
                "could not replace encrypted credentials at {}: {error}",
                self.credential_path().display()
            ))
        })
    }

    pub fn delete(&self) -> Result<bool, AuthError> {
        let file_removed = match fs::remove_file(self.credential_path()) {
            Ok(()) => true,
            Err(error) if error.kind() == ErrorKind::NotFound => false,
            Err(error) => {
                return Err(storage_error(format!(
                    "could not remove encrypted credentials: {error}"
                )));
            }
        };
        let key_removed = self.keyring.delete(KEYRING_SERVICE, KEYRING_ACCOUNT)?;
        Ok(file_removed || key_removed)
    }

    fn credential_path(&self) -> PathBuf {
        self.directory.join(CREDENTIAL_FILE_NAME)
    }

    fn load_or_create_passphrase(&self) -> Result<SecretString, AuthError> {
        if let Some(passphrase) = self.keyring.load(KEYRING_SERVICE, KEYRING_ACCOUNT)? {
            return Ok(SecretString::from(passphrase));
        }
        let passphrase = generate_passphrase();
        self.keyring
            .save(KEYRING_SERVICE, KEYRING_ACCOUNT, passphrase.expose_secret())?;
        Ok(passphrase)
    }
}

fn generate_passphrase() -> SecretString {
    let mut bytes = [0_u8; PASSPHRASE_BYTES];
    rand::rng().fill_bytes(&mut bytes);
    let encoded = BASE64_STANDARD.encode(bytes);
    bytes.zeroize();
    SecretString::from(encoded)
}

fn encrypt_file(plaintext: &[u8], passphrase: &SecretString) -> Result<Vec<u8>, AuthError> {
    let recipient = ScryptRecipient::new(passphrase.clone());
    encrypt(&recipient, plaintext)
        .map_err(|error| storage_error(format!("could not encrypt credentials: {error}")))
}

fn decrypt_file(ciphertext: &[u8], passphrase: &SecretString) -> Result<Vec<u8>, AuthError> {
    let identity = ScryptIdentity::new(passphrase.clone());
    decrypt(&identity, ciphertext)
        .map_err(|error| storage_error(format!("could not decrypt credentials: {error}")))
}

fn write_file_atomically(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    let directory = path.parent().ok_or_else(|| {
        std::io::Error::other(format!(
            "credential path has no parent directory: {}",
            path.display()
        ))
    })?;
    let mut temporary = tempfile::NamedTempFile::new_in(directory)?;
    temporary.write_all(contents)?;
    temporary.as_file().sync_all()?;
    temporary
        .persist(path)
        .map(|_| ())
        .map_err(|error| error.error)
}

fn storage_error(message: impl Into<String>) -> AuthError {
    AuthError::CredentialStorage(message.into())
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use base64::Engine as _;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use chrono::Utc;
    use serde_json::json;

    use super::*;

    #[derive(Default)]
    struct MemoryKeyring {
        values: Mutex<HashMap<(String, String), String>>,
    }

    impl KeyringStore for MemoryKeyring {
        fn load(&self, service: &str, account: &str) -> Result<Option<String>, AuthError> {
            let values = self
                .values
                .lock()
                .map_err(|_| storage_error("memory keyring lock was poisoned"))?;
            Ok(values
                .get(&(service.to_owned(), account.to_owned()))
                .cloned())
        }

        fn save(&self, service: &str, account: &str, value: &str) -> Result<(), AuthError> {
            let mut values = self
                .values
                .lock()
                .map_err(|_| storage_error("memory keyring lock was poisoned"))?;
            values.insert((service.to_owned(), account.to_owned()), value.to_owned());
            Ok(())
        }

        fn delete(&self, service: &str, account: &str) -> Result<bool, AuthError> {
            let mut values = self
                .values
                .lock()
                .map_err(|_| storage_error("memory keyring lock was poisoned"))?;
            Ok(values
                .remove(&(service.to_owned(), account.to_owned()))
                .is_some())
        }
    }

    fn jwt(payload: serde_json::Value) -> String {
        let payload = serde_json::to_vec(&payload)
            .unwrap_or_else(|error| panic!("JWT fixture should serialize: {error}"));
        format!("e30.{}.signature", URL_SAFE_NO_PAD.encode(payload))
    }

    fn large_record() -> AuthRecord {
        serde_json::from_value(json!({
            "tokens": {
                "idToken": jwt(json!({
                    "https://api.openai.com/auth": {
                        "chatgpt_account_id": "account-1"
                    }
                })),
                "accessToken": "e30.e30.signature",
                "refreshToken": "r".repeat(4_000),
                "accountId": "account-1"
            },
            "lastRefresh": Utc::now()
        }))
        .unwrap_or_else(|error| panic!("credential fixture should deserialize: {error}"))
    }

    #[test]
    fn credentials_round_trip_in_the_private_encrypted_envelope() {
        let directory = tempfile::tempdir()
            .unwrap_or_else(|error| panic!("temporary credential directory should exist: {error}"));
        let keyring = Arc::new(MemoryKeyring::default());
        let vault = CredentialVault::new(directory.path().to_path_buf(), keyring.clone());
        let record = large_record();

        vault
            .save(record.clone())
            .unwrap_or_else(|error| panic!("credential fixture should persist: {error}"));
        let loaded = vault
            .load()
            .unwrap_or_else(|error| panic!("credential fixture should load: {error}"))
            .unwrap_or_else(|| panic!("credential fixture should exist"));

        assert_eq!(
            serde_json::to_value(loaded)
                .unwrap_or_else(|error| panic!("loaded fixture should serialize: {error}")),
            serde_json::to_value(record)
                .unwrap_or_else(|error| panic!("source fixture should serialize: {error}"))
        );
        let encrypted = fs::read(vault.credential_path())
            .unwrap_or_else(|error| panic!("encrypted credential should be readable: {error}"));
        assert!(
            !encrypted
                .windows(32)
                .any(|window| window == b"rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr")
        );
        assert_eq!(
            keyring
                .load(KEYRING_SERVICE, KEYRING_ACCOUNT)
                .unwrap_or_else(|error| panic!("passphrase should load: {error}"))
                .map(|value| value.len()),
            Some(44)
        );
    }

    #[test]
    fn save_replaces_the_envelope_and_delete_removes_file_and_key() {
        let directory = tempfile::tempdir()
            .unwrap_or_else(|error| panic!("temporary credential directory should exist: {error}"));
        let keyring = Arc::new(MemoryKeyring::default());
        let vault = CredentialVault::new(directory.path().to_path_buf(), keyring.clone());

        vault
            .save(large_record())
            .and_then(|()| vault.save(large_record()))
            .unwrap_or_else(|error| panic!("credential replacement should succeed: {error}"));
        assert!(
            vault
                .delete()
                .unwrap_or_else(|error| panic!("credential deletion should succeed: {error}"))
        );
        assert!(!vault.credential_path().exists());
        assert!(
            keyring
                .load(KEYRING_SERVICE, KEYRING_ACCOUNT)
                .unwrap_or_else(|error| panic!("keyring should remain readable: {error}"))
                .is_none()
        );
    }
}
