use std::time::Instant;

use base64::{Engine as _, prelude::BASE64_STANDARD};
use rand::RngExt as _;
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::error::AppError;

const REQUIREMENTS_PREFIX: &str = "gAAAAAC";
const PROOF_PREFIX: &str = "gAAAAAB";
const MAX_PROOF_ATTEMPTS: u64 = 500_000;
const BROWSER_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

#[derive(Debug, Deserialize)]
pub(super) struct IntegrityRequirements {
    #[serde(default)]
    token: Option<String>,
    #[serde(default)]
    prepare_token: Option<String>,
    #[serde(default)]
    proofofwork: Option<ProofOfWork>,
    #[serde(default)]
    turnstile: Option<Turnstile>,
}

#[derive(Debug, Deserialize)]
struct ProofOfWork {
    #[serde(default)]
    required: bool,
    #[serde(default)]
    seed: Option<String>,
    #[serde(default)]
    difficulty: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Turnstile {
    #[serde(default)]
    required: bool,
    #[serde(default, rename = "dx")]
    _vm_payload: Option<String>,
}

#[derive(Debug, Default)]
pub(super) struct IntegrityHeaders {
    pub requirements_token: Option<String>,
    pub requirements_prepare_token: Option<String>,
    pub proof_token: Option<String>,
}

impl IntegrityRequirements {
    pub fn solve(self) -> Result<IntegrityHeaders, AppError> {
        validate_optional_token(self.token.as_deref())?;
        validate_optional_token(self.prepare_token.as_deref())?;
        if self.turnstile.is_some_and(|turnstile| turnstile.required) {
            return Err(AppError::Provider(
                "ChatGPT requested an interactive Turnstile integrity challenge; open the official ChatGPT client to re-establish the account session before retrying"
                    .into(),
            ));
        }
        let proof_token = match self.proofofwork {
            Some(proof) if proof.required => {
                let seed = proof.seed.filter(|seed| !seed.is_empty()).ok_or_else(|| {
                    AppError::Provider("ChatGPT requested proof of work without a seed".into())
                })?;
                let difficulty = proof
                    .difficulty
                    .filter(|difficulty| valid_difficulty(difficulty))
                    .ok_or_else(|| {
                        AppError::Provider(
                            "ChatGPT requested proof of work with an invalid difficulty".into(),
                        )
                    })?;
                Some(format!(
                    "{PROOF_PREFIX}{}",
                    solve_proof_of_work(&seed, &difficulty)?
                ))
            }
            _ => None,
        };
        Ok(IntegrityHeaders {
            requirements_token: self.token,
            requirements_prepare_token: self.prepare_token,
            proof_token,
        })
    }
}

pub(super) fn requirements_key() -> Result<String, AppError> {
    let started = Instant::now();
    let mut fingerprint = fingerprint();
    fingerprint[3] = json!(1);
    fingerprint[9] = json!(started.elapsed().as_secs_f64() * 1_000.0);
    Ok(format!(
        "{REQUIREMENTS_PREFIX}{}",
        encode_fingerprint(&fingerprint)?
    ))
}

fn solve_proof_of_work(seed: &str, difficulty: &str) -> Result<String, AppError> {
    let started = Instant::now();
    let mut fingerprint = fingerprint();
    for nonce in 0..MAX_PROOF_ATTEMPTS {
        fingerprint[3] = json!(nonce);
        fingerprint[9] = json!(started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64);
        let encoded = encode_fingerprint(&fingerprint)?;
        let hash = sentinel_hash(&format!("{seed}{encoded}"));
        if hash
            .get(..difficulty.len())
            .is_some_and(|prefix| prefix <= difficulty)
        {
            return Ok(format!("{encoded}~S"));
        }
    }
    Err(AppError::Provider(format!(
        "ChatGPT proof of work exceeded {MAX_PROOF_ATTEMPTS} attempts"
    )))
}

fn fingerprint() -> Vec<Value> {
    let mut random = rand::rng();
    vec![
        json!(3000),
        json!(chrono::Utc::now().to_rfc2822()),
        Value::Null,
        json!(random.random::<f64>()),
        json!(BROWSER_USER_AGENT),
        json!("app-initial.js"),
        Value::Null,
        json!("pt-BR"),
        json!("pt-BR,en-US,en"),
        json!(random.random::<f64>()),
        json!("platform−Win32"),
        json!("document"),
        json!("window"),
        json!(0),
        json!(Uuid::now_v7().to_string()),
        json!(""),
        json!(std::thread::available_parallelism().map_or(1, usize::from)),
        json!(chrono::Utc::now().timestamp_millis()),
        json!(0),
        json!(0),
        json!(0),
        json!(0),
        json!(0),
        json!(0),
        json!(0),
    ]
}

fn encode_fingerprint(fingerprint: &[Value]) -> Result<String, AppError> {
    let bytes = serde_json::to_vec(fingerprint).map_err(|error| {
        AppError::Provider(format!("could not encode ChatGPT integrity state: {error}"))
    })?;
    Ok(BASE64_STANDARD.encode(bytes))
}

fn sentinel_hash(value: &str) -> String {
    let mut hash = 2_166_136_261_u32;
    for code_unit in value.encode_utf16() {
        hash ^= u32::from(code_unit);
        hash = hash.wrapping_mul(16_777_619);
    }
    hash ^= hash >> 16;
    hash = hash.wrapping_mul(2_246_822_507);
    hash ^= hash >> 13;
    hash = hash.wrapping_mul(3_266_489_909);
    hash ^= hash >> 16;
    format!("{hash:08x}")
}

fn valid_difficulty(value: &str) -> bool {
    (1..=8).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn validate_optional_token(value: Option<&str>) -> Result<(), AppError> {
    if value.is_some_and(|value| {
        value.is_empty() || value.len() > 16_384 || value.chars().any(char::is_control)
    }) {
        return Err(AppError::Provider(
            "ChatGPT returned an invalid integrity token".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use base64::Engine as _;
    use serde_json::Value;

    use super::{
        BASE64_STANDARD, IntegrityRequirements, REQUIREMENTS_PREFIX, requirements_key,
        sentinel_hash, valid_difficulty,
    };

    #[test]
    fn requirements_key_uses_the_official_fixed_probe_fields() {
        let key = requirements_key().expect("requirements key should encode");
        let encoded = key
            .strip_prefix(REQUIREMENTS_PREFIX)
            .expect("requirements prefix should be present");
        let bytes = BASE64_STANDARD
            .decode(encoded)
            .expect("fingerprint should be base64");
        let fingerprint: Vec<Value> =
            serde_json::from_slice(&bytes).expect("fingerprint should be JSON");

        assert_eq!(fingerprint[3], 1);
        assert!(fingerprint[9].is_number());
    }

    #[test]
    fn sentinel_hash_matches_the_browser_algorithm() {
        assert_eq!(sentinel_hash("seedpayload"), "769860aa");
    }

    #[test]
    fn rejects_interactive_turnstile_instead_of_bypassing_it() {
        let requirements: IntegrityRequirements =
            serde_json::from_str(r#"{"turnstile":{"required":true,"dx":"opaque"}}"#)
                .expect("requirements should decode");
        assert!(requirements.solve().is_err());
    }

    #[test]
    fn difficulty_is_a_bounded_lowercase_hex_prefix() {
        assert!(valid_difficulty("0fffffff"));
        assert!(!valid_difficulty(""));
        assert!(!valid_difficulty("ABC"));
        assert!(!valid_difficulty("000000000"));
    }
}
