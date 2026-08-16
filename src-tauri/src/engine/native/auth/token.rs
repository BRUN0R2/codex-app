use std::fmt;

use base64::Engine as _;
use chrono::DateTime;
use chrono::Duration;
use chrono::Utc;
use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde::Serializer;
use serde::de::DeserializeOwned;
use url::Url;
use zeroize::Zeroize;

use super::error::AuthError;
use super::oauth::ExchangedTokens;
use super::oauth::TokenPatch;

const ACCESS_TOKEN_REFRESH_WINDOW: Duration = Duration::minutes(5);
const LAST_REFRESH_FALLBACK_INTERVAL: Duration = Duration::days(8);
const MAX_ACCOUNT_ID_BYTES: usize = 256;
pub(super) const MAX_PROFILE_NAME_BYTES: usize = 256;
const MAX_PROFILE_PICTURE_BYTES: usize = 8_192;

#[derive(Clone, Default, PartialEq, Eq)]
pub(super) struct SecretString(String);

impl SecretString {
    pub fn expose(&self) -> &str {
        &self.0
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl From<String> for SecretString {
    fn from(value: String) -> Self {
        Self(value)
    }
}

impl fmt::Debug for SecretString {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("[REDACTED]")
    }
}

impl Drop for SecretString {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

impl Serialize for SecretString {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.expose())
    }
}

impl<'de> Deserialize<'de> for SecretString {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        String::deserialize(deserializer).map(Self)
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct TokenSet {
    pub id_token: SecretString,
    pub access_token: SecretString,
    pub refresh_token: SecretString,
    pub account_id: String,
}

impl fmt::Debug for TokenSet {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TokenSet")
            .field("id_token", &self.id_token)
            .field("access_token", &self.access_token)
            .field("refresh_token", &self.refresh_token)
            .field("account_id", &self.account_id)
            .finish()
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct AuthRecord {
    tokens: TokenSet,
    last_refresh: DateTime<Utc>,
}

impl fmt::Debug for AuthRecord {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AuthRecord")
            .field("tokens", &self.tokens)
            .field("last_refresh", &self.last_refresh)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct AccountClaims {
    pub email: Option<String>,
    pub name: Option<String>,
    pub picture: Option<String>,
    pub plan_type: Option<String>,
    pub account_id: Option<String>,
}

impl AuthRecord {
    pub fn from_exchange(tokens: ExchangedTokens) -> Result<Self, AuthError> {
        let claims = parse_account_claims(&tokens.id_token)?;
        let account_id = claims.account_id.ok_or_else(|| {
            AuthError::InvalidToken("the ChatGPT identity token has no account id".into())
        })?;
        let record = Self {
            tokens: TokenSet {
                id_token: tokens.id_token,
                access_token: tokens.access_token,
                refresh_token: tokens.refresh_token,
                account_id,
            },
            last_refresh: Utc::now(),
        };
        record.validate()?;
        Ok(record)
    }

    pub fn validate(&self) -> Result<(), AuthError> {
        if self.tokens.id_token.is_empty()
            || self.tokens.access_token.is_empty()
            || self.tokens.refresh_token.is_empty()
            || self.tokens.account_id.trim().is_empty()
            || self.tokens.account_id.len() > MAX_ACCOUNT_ID_BYTES
            || self.tokens.account_id.chars().any(char::is_control)
        {
            return Err(AuthError::InvalidToken(
                "stored ChatGPT credentials contain an invalid token or account id".into(),
            ));
        }
        let claims = parse_account_claims(&self.tokens.id_token)?;
        if claims.account_id.as_deref() != Some(self.tokens.account_id.as_str()) {
            return Err(AuthError::InvalidToken(
                "stored ChatGPT account id does not match the identity token".into(),
            ));
        }
        Ok(())
    }

    pub fn tokens(&self) -> &TokenSet {
        &self.tokens
    }

    pub fn account_claims(&self) -> Result<AccountClaims, AuthError> {
        let tokens = &self.tokens;
        let mut claims = parse_account_claims(&tokens.id_token)?;
        claims.account_id = Some(tokens.account_id.clone());
        Ok(claims)
    }

    pub fn should_refresh(&self, now: DateTime<Utc>) -> bool {
        match parse_expiration(&self.tokens.access_token) {
            Ok(Some(expires_at)) => expires_at <= now + ACCESS_TOKEN_REFRESH_WINDOW,
            Ok(None) => self.last_refresh < now - LAST_REFRESH_FALLBACK_INTERVAL,
            // An unparseable access token cannot be trusted for scheduling; refresh promptly so
            // the real failure surfaces through the refresh call itself.
            Err(_) => true,
        }
    }

    pub fn same_refresh_source(&self, other: &Self) -> bool {
        self.tokens.refresh_token == other.tokens.refresh_token
            && self.tokens.account_id == other.tokens.account_id
    }

    pub fn apply_refresh(&mut self, patch: TokenPatch) -> Result<(), AuthError> {
        let tokens = &mut self.tokens;
        if let Some(id_token) = patch.id_token {
            let claims = parse_account_claims(&id_token)?;
            tokens.account_id = claims.account_id.ok_or_else(|| {
                AuthError::InvalidToken("the refreshed identity token has no account id".into())
            })?;
            tokens.id_token = id_token;
        }
        if let Some(access_token) = patch.access_token {
            tokens.access_token = access_token;
        }
        if let Some(refresh_token) = patch.refresh_token {
            tokens.refresh_token = refresh_token;
        }
        self.last_refresh = Utc::now();
        self.validate()
    }
}

pub(super) fn validate_account_token(token: &SecretString) -> Result<(), AuthError> {
    parse_account_claims(token).map(|_| ())
}

#[derive(Deserialize)]
struct JwtClaims {
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    picture: Option<String>,
    #[serde(rename = "https://api.openai.com/profile", default)]
    profile: Option<ProfileClaims>,
    #[serde(rename = "https://api.openai.com/auth", default)]
    auth: Option<ChatGptClaims>,
}

#[derive(Default, Deserialize)]
struct ProfileClaims {
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    picture: Option<String>,
}

#[derive(Deserialize)]
struct ChatGptClaims {
    #[serde(default)]
    chatgpt_plan_type: Option<String>,
    #[serde(default)]
    chatgpt_account_id: Option<String>,
}

#[derive(Deserialize)]
struct ExpirationClaims {
    #[serde(default)]
    exp: Option<i64>,
}

fn parse_account_claims(token: &SecretString) -> Result<AccountClaims, AuthError> {
    let claims: JwtClaims = decode_jwt_payload(token)?;
    let profile = claims.profile.unwrap_or_default();
    let email = claims.email.or(profile.email);
    let name = clean_profile_text(claims.name.or(profile.name), MAX_PROFILE_NAME_BYTES);
    let picture = clean_profile_picture(claims.picture.or(profile.picture));
    let (plan_type, account_id) = claims
        .auth
        .map(|auth| (auth.chatgpt_plan_type, auth.chatgpt_account_id))
        .unwrap_or_default();
    Ok(AccountClaims {
        email,
        name,
        picture,
        plan_type,
        account_id,
    })
}

pub(super) fn clean_profile_text(value: Option<String>, maximum_length: usize) -> Option<String> {
    let value = value?.trim().to_owned();
    (!value.is_empty() && value.len() <= maximum_length && !value.chars().any(char::is_control))
        .then_some(value)
}

pub(super) fn clean_profile_picture(value: Option<String>) -> Option<String> {
    let value = clean_profile_text(value, MAX_PROFILE_PICTURE_BYTES)?;
    let url = Url::parse(&value).ok()?;
    (url.scheme() == "https" && url.username().is_empty() && url.password().is_none())
        .then_some(value)
}

fn parse_expiration(token: &SecretString) -> Result<Option<DateTime<Utc>>, AuthError> {
    let claims: ExpirationClaims = decode_jwt_payload(token)?;
    Ok(claims
        .exp
        .and_then(|timestamp| DateTime::<Utc>::from_timestamp(timestamp, 0)))
}

fn decode_jwt_payload<T>(token: &SecretString) -> Result<T, AuthError>
where
    T: DeserializeOwned,
{
    let mut parts = token.expose().split('.');
    let header = parts.next();
    let payload = parts.next();
    let signature = parts.next();
    if header.is_none_or(str::is_empty)
        || payload.is_none_or(str::is_empty)
        || signature.is_none_or(str::is_empty)
        || parts.next().is_some()
    {
        return Err(AuthError::InvalidToken("JWT format is invalid".into()));
    }
    let payload =
        payload.ok_or_else(|| AuthError::InvalidToken("JWT payload is missing".into()))?;
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|error| {
            AuthError::InvalidToken(format!("JWT payload is not base64url: {error}"))
        })?;
    let decoded = zeroize::Zeroizing::new(decoded);
    serde_json::from_slice(&decoded)
        .map_err(|error| AuthError::InvalidToken(format!("JWT claims are invalid: {error}")))
}

#[cfg(test)]
mod tests {
    use base64::Engine as _;
    use chrono::Duration;
    use chrono::Utc;
    use serde_json::json;

    use super::AuthRecord;
    use super::SecretString;

    fn jwt(payload: serde_json::Value) -> SecretString {
        let payload = serde_json::to_vec(&payload).unwrap_or_default();
        SecretString::from(format!(
            "e30.{}.signature",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload)
        ))
    }

    #[test]
    fn parses_the_official_namespaced_chatgpt_claims() {
        let record: AuthRecord = serde_json::from_value(json!({
            "tokens": {
                "idToken": jwt(json!({
                    "email": "person@example.com",
                    "name": "Person Example",
                    "picture": "https://images.example.com/person.png",
                    "https://api.openai.com/auth": {
                        "chatgpt_plan_type": "plus",
                        "chatgpt_account_id": "account-1"
                    }
                })).expose(),
                "accessToken": jwt(json!({ "exp": Utc::now().timestamp() + 3600 })).expose(),
                "refreshToken": "refresh",
                "accountId": "account-1"
            },
            "lastRefresh": Utc::now()
        }))
        .unwrap_or_else(|error| panic!("fixture should deserialize: {error}"));

        let claims = record
            .account_claims()
            .unwrap_or_else(|error| panic!("claims should parse: {error}"));
        assert_eq!(claims.email.as_deref(), Some("person@example.com"));
        assert_eq!(claims.name.as_deref(), Some("Person Example"));
        assert_eq!(
            claims.picture.as_deref(),
            Some("https://images.example.com/person.png")
        );
        assert_eq!(claims.plan_type.as_deref(), Some("plus"));
        assert_eq!(claims.account_id.as_deref(), Some("account-1"));
        assert!(record.validate().is_ok());
        assert!(!record.should_refresh(Utc::now()));
    }

    #[test]
    fn rejects_unknown_credential_fields() {
        let record = serde_json::from_value::<AuthRecord>(json!({
            "authMode": "chatgpt",
            "tokens": {
                "idToken": jwt(json!({})).expose(),
                "accessToken": jwt(json!({})).expose(),
                "refreshToken": "refresh",
                "accountId": "account-1"
            },
            "lastRefresh": Utc::now() - Duration::days(9)
        }));

        assert!(record.is_err());
    }
}
