use std::collections::BTreeMap;
use std::fs;
use std::io::ErrorKind;
use std::io::Write as _;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use age::decrypt;
use age::encrypt;
use age::scrypt::Identity as ScryptIdentity;
use age::scrypt::Recipient as ScryptRecipient;
use age::secrecy::ExposeSecret as _;
use age::secrecy::SecretString;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use rand::Rng as _;
use serde::Deserialize;
use serde::Serialize;
use sha2::Digest as _;
use sha2::Sha256;
use zeroize::Zeroize;
use zeroize::Zeroizing;

use super::super::error::AuthError;
use super::super::token::AuthRecord;
use super::keyring::KeyringStore;

const SECRETS_VERSION: u8 = 1;
const KEYRING_SERVICE: &str = "codex";
const AUTH_SECRET_KEY: &str = "global/CODEX_AUTH";
const AUTH_SECRETS_PATH: [&str; 2] = ["secrets", "codex_auth.age"];
const PASSPHRASE_BYTES: usize = 32;
const HEX_DIGITS: &[u8; 16] = b"0123456789abcdef";

#[derive(Debug, Default, Serialize, Deserialize)]
struct SecretsFile {
    version: u8,
    secrets: BTreeMap<String, String>,
}

impl SecretsFile {
    fn empty() -> Self {
        Self {
            version: SECRETS_VERSION,
            secrets: BTreeMap::new(),
        }
    }
}

impl Drop for SecretsFile {
    fn drop(&mut self) {
        self.secrets.values_mut().for_each(Zeroize::zeroize);
    }
}

#[derive(Clone)]
pub(super) struct CredentialVault {
    codex_home: PathBuf,
    keyring: Arc<dyn KeyringStore>,
}

impl CredentialVault {
    pub fn new(codex_home: PathBuf, keyring: Arc<dyn KeyringStore>) -> Self {
        Self {
            codex_home,
            keyring,
        }
    }

    pub fn load(&self) -> Result<Option<AuthRecord>, AuthError> {
        let file = self.load_file()?;
        file.secrets
            .get(AUTH_SECRET_KEY)
            .map(|serialized| {
                serde_json::from_str(serialized).map_err(|error| {
                    storage_error(format!(
                        "stored credentials in encrypted auth storage are invalid: {error}"
                    ))
                })
            })
            .transpose()
    }

    pub fn save_serialized(&self, serialized: &str) -> Result<(), AuthError> {
        if serialized.is_empty() {
            return Err(storage_error("serialized credentials must not be empty"));
        }
        let mut file = self.load_file()?;
        file.secrets
            .insert(AUTH_SECRET_KEY.to_owned(), serialized.to_owned());
        self.save_file(&file)
    }

    pub fn delete(&self) -> Result<bool, AuthError> {
        if !self.secrets_path().exists() {
            return Ok(false);
        }
        let mut file = self.load_file()?;
        let Some(mut removed) = file.secrets.remove(AUTH_SECRET_KEY) else {
            return Ok(false);
        };
        removed.zeroize();
        self.save_file(&file)?;
        Ok(true)
    }

    fn secrets_path(&self) -> PathBuf {
        AUTH_SECRETS_PATH
            .iter()
            .fold(self.codex_home.clone(), |path, segment| path.join(segment))
    }

    fn load_file(&self) -> Result<SecretsFile, AuthError> {
        let path = self.secrets_path();
        let ciphertext = match fs::read(&path) {
            Ok(ciphertext) => ciphertext,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(SecretsFile::empty()),
            Err(error) => {
                return Err(storage_error(format!(
                    "could not read encrypted auth storage at {}: {error}",
                    path.display()
                )));
            }
        };
        let passphrase = self.load_passphrase()?.ok_or_else(|| {
            storage_error(format!(
                "the encryption key for {} is missing from the system credential store",
                path.display()
            ))
        })?;
        let plaintext = decrypt_file(&ciphertext, &passphrase)?;
        let plaintext = Zeroizing::new(plaintext);
        let mut file: SecretsFile = serde_json::from_slice(&plaintext).map_err(|error| {
            storage_error(format!(
                "could not decode encrypted auth storage at {}: {error}",
                path.display()
            ))
        })?;
        if file.version == 0 {
            file.version = SECRETS_VERSION;
        }
        if file.version > SECRETS_VERSION {
            return Err(storage_error(format!(
                "encrypted auth storage version {} is newer than supported version {}",
                file.version, SECRETS_VERSION
            )));
        }
        Ok(file)
    }

    fn save_file(&self, file: &SecretsFile) -> Result<(), AuthError> {
        let path = self.secrets_path();
        let directory = path.parent().ok_or_else(|| {
            storage_error(format!(
                "could not resolve the encrypted auth storage directory for {}",
                path.display()
            ))
        })?;
        fs::create_dir_all(directory).map_err(|error| {
            storage_error(format!(
                "could not create encrypted auth storage directory {}: {error}",
                directory.display()
            ))
        })?;

        let passphrase = self.load_or_create_passphrase()?;
        let plaintext = serde_json::to_vec(file).map_err(|error| {
            storage_error(format!("could not encode encrypted auth storage: {error}"))
        })?;
        let plaintext = Zeroizing::new(plaintext);
        let ciphertext = encrypt_file(&plaintext, &passphrase)?;
        write_file_atomically(&path, &ciphertext).map_err(|error| {
            storage_error(format!(
                "could not replace encrypted auth storage at {}: {error}",
                path.display()
            ))
        })
    }

    fn load_passphrase(&self) -> Result<Option<SecretString>, AuthError> {
        let account = compute_keyring_account(&self.codex_home);
        self.keyring
            .load(KEYRING_SERVICE, &account)
            .map(|value| value.map(SecretString::from))
    }

    fn load_or_create_passphrase(&self) -> Result<SecretString, AuthError> {
        if let Some(passphrase) = self.load_passphrase()? {
            return Ok(passphrase);
        }
        let passphrase = generate_passphrase();
        let account = compute_keyring_account(&self.codex_home);
        self.keyring
            .save(KEYRING_SERVICE, &account, passphrase.expose_secret())?;
        Ok(passphrase)
    }
}

fn compute_keyring_account(codex_home: &Path) -> String {
    let canonical = codex_home
        .canonicalize()
        .unwrap_or_else(|_| codex_home.to_path_buf());
    let mut hasher = Sha256::new();
    hasher.update(canonical.to_string_lossy().as_bytes());
    let digest = hasher.finalize();
    let mut short_hash = String::with_capacity(16);
    for byte in digest.iter().take(8) {
        short_hash.push(HEX_DIGITS[usize::from(byte >> 4)] as char);
        short_hash.push(HEX_DIGITS[usize::from(byte & 0x0f)] as char);
    }
    format!("secrets|{short_hash}")
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
        .map_err(|error| storage_error(format!("could not encrypt auth storage: {error}")))
}

fn decrypt_file(ciphertext: &[u8], passphrase: &SecretString) -> Result<Vec<u8>, AuthError> {
    let identity = ScryptIdentity::new(passphrase.clone());
    decrypt(&identity, ciphertext)
        .map_err(|error| storage_error(format!("could not decrypt auth storage: {error}")))
}

fn write_file_atomically(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    let directory = path.parent().ok_or_else(|| {
        std::io::Error::other(format!(
            "encrypted auth storage has no parent directory: {}",
            path.display()
        ))
    })?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_nanos());
    let filename = path.file_name().ok_or_else(|| {
        std::io::Error::other(format!(
            "encrypted auth storage has no filename: {}",
            path.display()
        ))
    })?;
    let temporary_path = directory.join(format!(
        ".{}.tmp-{}-{nonce}",
        filename.to_string_lossy(),
        std::process::id()
    ));
    let write_result = (|| {
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary_path)?;
        file.write_all(contents)?;
        file.sync_all()
    })();
    if let Err(error) = write_result {
        return Err(cleanup_after_error(&temporary_path, error));
    }

    let replace_result = match fs::rename(&temporary_path, path) {
        Ok(()) => Ok(()),
        Err(initial_error) => {
            #[cfg(windows)]
            if path.exists() {
                return match fs::remove_file(path).and_then(|()| fs::rename(&temporary_path, path))
                {
                    Ok(()) => Ok(()),
                    Err(error) => Err(cleanup_after_error(&temporary_path, error)),
                };
            }
            Err(initial_error)
        }
    };
    match replace_result {
        Ok(()) => Ok(()),
        Err(error) => Err(cleanup_after_error(&temporary_path, error)),
    }
}

fn cleanup_after_error(temporary_path: &Path, original: std::io::Error) -> std::io::Error {
    match fs::remove_file(temporary_path) {
        Ok(()) => original,
        Err(error) if error.kind() == ErrorKind::NotFound => original,
        Err(cleanup_error) => std::io::Error::new(
            original.kind(),
            format!(
                "{original}; could not remove temporary auth storage at {}: {cleanup_error}",
                temporary_path.display()
            ),
        ),
    }
}

fn storage_error(message: impl Into<String>) -> AuthError {
    AuthError::CredentialStorage(message.into())
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Mutex;

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
    }

    fn large_record() -> AuthRecord {
        serde_json::from_value(json!({
            "auth_mode": "chatgpt",
            "OPENAI_API_KEY": null,
            "tokens": {
                "id_token": "header.payload.signature",
                "access_token": "a".repeat(3_000),
                "refresh_token": "r".repeat(1_000),
                "account_id": "account-1"
            },
            "last_refresh": "2026-07-30T12:00:00Z"
        }))
        .unwrap_or_else(|error| panic!("large auth fixture should deserialize: {error}"))
    }

    #[test]
    fn credentials_larger_than_the_windows_limit_round_trip_encrypted() {
        let codex_home = tempfile::tempdir()
            .unwrap_or_else(|error| panic!("temporary CODEX_HOME should be created: {error}"));
        let keyring = Arc::new(MemoryKeyring::default());
        let vault = CredentialVault::new(codex_home.path().to_path_buf(), keyring.clone());
        let record = large_record();
        let serialized = serde_json::to_string(&record)
            .unwrap_or_else(|error| panic!("auth fixture should serialize: {error}"));
        assert!(serialized.len() > 2_560);

        vault
            .save_serialized(&serialized)
            .unwrap_or_else(|error| panic!("large auth fixture should persist: {error}"));
        let loaded = vault
            .load()
            .unwrap_or_else(|error| panic!("large auth fixture should load: {error}"))
            .unwrap_or_else(|| panic!("large auth fixture should exist"));

        assert_eq!(
            serde_json::to_value(loaded)
                .unwrap_or_else(|error| panic!("loaded fixture should serialize: {error}")),
            serde_json::to_value(record)
                .unwrap_or_else(|error| panic!("source fixture should serialize: {error}"))
        );
        let encrypted = fs::read(vault.secrets_path())
            .unwrap_or_else(|error| panic!("encrypted auth file should be readable: {error}"));
        assert!(
            !encrypted
                .windows(32)
                .any(|window| window == b"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        );

        let account = compute_keyring_account(codex_home.path());
        let passphrase = keyring
            .load(KEYRING_SERVICE, &account)
            .unwrap_or_else(|error| panic!("passphrase should load: {error}"))
            .unwrap_or_else(|| panic!("passphrase should exist"));
        assert_eq!(passphrase.len(), 44);
    }

    #[test]
    fn delete_removes_only_the_auth_entry() {
        let codex_home = tempfile::tempdir()
            .unwrap_or_else(|error| panic!("temporary CODEX_HOME should be created: {error}"));
        let keyring = Arc::new(MemoryKeyring::default());
        let vault = CredentialVault::new(codex_home.path().to_path_buf(), keyring);
        let serialized = serde_json::to_string(&large_record())
            .unwrap_or_else(|error| panic!("auth fixture should serialize: {error}"));
        vault
            .save_serialized(&serialized)
            .unwrap_or_else(|error| panic!("auth fixture should persist: {error}"));

        assert!(
            vault
                .delete()
                .unwrap_or_else(|error| panic!("auth fixture should delete: {error}"))
        );
        assert!(
            vault
                .load()
                .unwrap_or_else(|error| panic!("empty vault should load: {error}"))
                .is_none()
        );
        assert!(vault.secrets_path().exists());
    }

    #[test]
    fn keyring_account_matches_the_codex_secrets_contract() {
        let account = compute_keyring_account(Path::new("C:\\Users\\codex\\.codex"));

        assert!(account.starts_with("secrets|"));
        assert_eq!(account.len(), 24);
    }
}
