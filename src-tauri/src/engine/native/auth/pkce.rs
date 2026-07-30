use base64::Engine as _;
use rand::Rng as _;
use sha2::Digest as _;
use sha2::Sha256;

use super::token::SecretString;

pub(super) struct PkceCodes {
    pub code_verifier: SecretString,
    pub code_challenge: String,
}

pub(super) fn generate_pkce() -> PkceCodes {
    let mut bytes = [0_u8; 64];
    rand::rng().fill_bytes(&mut bytes);

    let code_verifier = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
    let digest = Sha256::digest(code_verifier.as_bytes());
    let code_challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest);

    PkceCodes {
        code_verifier: SecretString::from(code_verifier),
        code_challenge,
    }
}

pub(super) fn generate_state() -> SecretString {
    let mut bytes = [0_u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    SecretString::from(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes))
}

#[cfg(test)]
mod tests {
    use super::generate_pkce;
    use super::generate_state;

    #[test]
    fn generated_pkce_values_match_the_oauth_constraints() {
        let codes = generate_pkce();

        assert!((43..=128).contains(&codes.code_verifier.expose().len()));
        assert_eq!(codes.code_challenge.len(), 43);
        assert!(!codes.code_challenge.contains('='));
    }

    #[test]
    fn generated_state_has_256_bits_of_entropy() {
        assert_eq!(generate_state().expose().len(), 43);
    }
}
