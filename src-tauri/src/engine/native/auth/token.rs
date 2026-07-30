use std::collections::BTreeMap;
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
use serde_json::Value;
use zeroize::Zeroize;

use super::error::AuthError;
use super::oauth::ExchangedTokens;
use super::oauth::TokenPatch;

const ACCESS_TOKEN_REFRESH_WINDOW: Duration = Duration::minutes(5);
const LAST_REFRESH_FALLBACK_INTERVAL: Duration = Duration::days(8);

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
pub(super) struct TokenSet {
    pub id_token: SecretString,
    pub access_token: SecretString,
    pub refresh_token: SecretString,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
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
pub(super) struct AuthRecord {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    auth_mode: Option<String>,
    #[serde(rename = "OPENAI_API_KEY", default)]
    openai_api_key: Option<SecretString>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tokens: Option<TokenSet>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_refresh: Option<DateTime<Utc>>,
    #[serde(flatten)]
    extra: BTreeMap<String, Value>,
}

impl fmt::Debug for AuthRecord {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AuthRecord")
            .field("auth_mode", &self.auth_mode)
            .field("has_api_key", &self.openai_api_key.is_some())
            .field("tokens", &self.tokens)
            .field("last_refresh", &self.last_refresh)
            .field("extra_fields", &self.extra.keys().collect::<Vec<_>>())
            .finish()
    }
}

impl Drop for AuthRecord {
    fn drop(&mut self) {
        for value in self.extra.values_mut() {
            zeroize_json(value);
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum StoredAuthMode {
    ChatGpt,
    ApiKey,
    Other(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct AccountClaims {
    pub email: Option<String>,
    pub plan_type: Option<String>,
    pub account_id: Option<String>,
}

impl AuthRecord {
    pub fn from_exchange(tokens: ExchangedTokens) -> Result<Self, AuthError> {
        let claims = parse_account_claims(&tokens.id_token)?;
        Ok(Self {
            auth_mode: Some("chatgpt".into()),
            openai_api_key: None,
            tokens: Some(TokenSet {
                id_token: tokens.id_token,
                access_token: tokens.access_token,
                refresh_token: tokens.refresh_token,
                account_id: claims.account_id,
            }),
            last_refresh: Some(Utc::now()),
            extra: BTreeMap::new(),
        })
    }

    pub fn mode(&self) -> StoredAuthMode {
        match self.auth_mode.as_deref() {
            Some("chatgpt") => StoredAuthMode::ChatGpt,
            Some("apikey") => StoredAuthMode::ApiKey,
            Some(other) => StoredAuthMode::Other(other.to_owned()),
            None if self.openai_api_key.is_some() => StoredAuthMode::ApiKey,
            None => StoredAuthMode::ChatGpt,
        }
    }

    pub fn tokens(&self) -> Result<&TokenSet, AuthError> {
        self.tokens.as_ref().ok_or_else(|| {
            AuthError::InvalidToken("stored ChatGPT credentials do not contain tokens".into())
        })
    }

    pub fn account_claims(&self) -> Result<AccountClaims, AuthError> {
        let tokens = self.tokens()?;
        let mut claims = parse_account_claims(&tokens.id_token)?;
        if tokens.account_id.is_some() {
            claims.account_id.clone_from(&tokens.account_id);
        }
        Ok(claims)
    }

    pub fn should_refresh(&self, now: DateTime<Utc>) -> bool {
        let Some(tokens) = self.tokens.as_ref() else {
            return false;
        };
        if let Ok(Some(expires_at)) = parse_expiration(&tokens.access_token) {
            return expires_at <= now + ACCESS_TOKEN_REFRESH_WINDOW;
        }
        self.last_refresh
            .is_some_and(|last_refresh| last_refresh < now - LAST_REFRESH_FALLBACK_INTERVAL)
    }

    pub fn same_refresh_source(&self, other: &Self) -> bool {
        match (self.tokens.as_ref(), other.tokens.as_ref()) {
            (Some(left), Some(right)) => {
                left.refresh_token == right.refresh_token && left.account_id == right.account_id
            }
            _ => false,
        }
    }

    pub fn apply_refresh(&mut self, patch: TokenPatch) -> Result<(), AuthError> {
        let tokens = self.tokens.as_mut().ok_or_else(|| {
            AuthError::InvalidToken("stored ChatGPT credentials do not contain tokens".into())
        })?;
        if let Some(id_token) = patch.id_token {
            tokens.id_token = id_token;
        }
        if let Some(access_token) = patch.access_token {
            tokens.access_token = access_token;
        }
        if let Some(refresh_token) = patch.refresh_token {
            tokens.refresh_token = refresh_token;
        }
        self.last_refresh = Some(Utc::now());
        Ok(())
    }
}

pub(super) fn validate_account_token(token: &SecretString) -> Result<(), AuthError> {
    parse_account_claims(token).map(|_| ())
}

#[derive(Deserialize)]
struct JwtClaims {
    #[serde(default)]
    email: Option<String>,
    #[serde(rename = "https://api.openai.com/profile", default)]
    profile: Option<ProfileClaims>,
    #[serde(rename = "https://api.openai.com/auth", default)]
    auth: Option<ChatGptClaims>,
}

#[derive(Deserialize)]
struct ProfileClaims {
    #[serde(default)]
    email: Option<String>,
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
    let email = claims
        .email
        .or_else(|| claims.profile.and_then(|profile| profile.email));
    let (plan_type, account_id) = claims
        .auth
        .map(|auth| (auth.chatgpt_plan_type, auth.chatgpt_account_id))
        .unwrap_or_default();
    Ok(AccountClaims {
        email,
        plan_type,
        account_id,
    })
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

fn zeroize_json(value: &mut Value) {
    match value {
        Value::String(string) => string.zeroize(),
        Value::Array(values) => values.iter_mut().for_each(zeroize_json),
        Value::Object(values) => {
            for value in values.values_mut() {
                zeroize_json(value);
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

#[cfg(test)]
mod tests {
    use base64::Engine as _;
    use chrono::Duration;
    use chrono::Utc;
    use serde_json::json;

    use super::AuthRecord;
    use super::SecretString;
    use super::StoredAuthMode;

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
            "auth_mode": "chatgpt",
            "OPENAI_API_KEY": null,
            "tokens": {
                "id_token": jwt(json!({
                    "email": "person@example.com",
                    "https://api.openai.com/auth": {
                        "chatgpt_plan_type": "plus",
                        "chatgpt_account_id": "account-1"
                    }
                })).expose(),
                "access_token": jwt(json!({ "exp": Utc::now().timestamp() + 3600 })).expose(),
                "refresh_token": "refresh",
                "account_id": "account-1"
            },
            "last_refresh": Utc::now()
        }))
        .unwrap_or_else(|error| panic!("fixture should deserialize: {error}"));

        let claims = record
            .account_claims()
            .unwrap_or_else(|error| panic!("claims should parse: {error}"));
        assert_eq!(claims.email.as_deref(), Some("person@example.com"));
        assert_eq!(claims.plan_type.as_deref(), Some("plus"));
        assert_eq!(claims.account_id.as_deref(), Some("account-1"));
        assert_eq!(record.mode(), StoredAuthMode::ChatGpt);
        assert!(!record.should_refresh(Utc::now()));
    }

    #[test]
    fn preserves_forward_compatible_fields_during_round_trip() {
        let value = json!({
            "auth_mode": "chatgpt",
            "OPENAI_API_KEY": null,
            "future_auth": { "private": "value", "enabled": true },
            "last_refresh": Utc::now() - Duration::days(9)
        });
        let record: AuthRecord = serde_json::from_value(value.clone())
            .unwrap_or_else(|error| panic!("fixture should deserialize: {error}"));
        let serialized = serde_json::to_value(record)
            .unwrap_or_else(|error| panic!("record should serialize: {error}"));

        assert_eq!(serialized["future_auth"], value["future_auth"]);
    }

    #[test]
    fn recognizes_the_official_api_key_auth_mode() {
        let record: AuthRecord = serde_json::from_value(json!({
            "auth_mode": "apikey",
            "OPENAI_API_KEY": "secret"
        }))
        .unwrap_or_else(|error| panic!("fixture should deserialize: {error}"));

        assert_eq!(record.mode(), StoredAuthMode::ApiKey);
    }
}
