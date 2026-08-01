use std::time::Duration;

use futures_util::StreamExt as _;
use reqwest::Client;
use reqwest::Response;
use reqwest::header::HeaderMap;
use reqwest::header::HeaderValue;
use serde::Deserialize;
use serde::Serialize;
use serde::de::DeserializeOwned;
use url::Url;

use super::error::AuthError;
use super::pkce::PkceCodes;
use super::token::SecretString;
use super::token::TokenSet;
use super::token::validate_account_token;

#[cfg(test)]
const AUTH_ISSUER: &str = "https://auth.openai.com";
const AUTHORIZE_ENDPOINT: &str = "https://auth.openai.com/oauth/authorize";
const TOKEN_ENDPOINT: &str = "https://auth.openai.com/oauth/token";
const REVOKE_ENDPOINT: &str = "https://auth.openai.com/oauth/revoke";
const OAUTH_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const OAUTH_SCOPE: &str =
    "openid profile email offline_access api.connectors.read api.connectors.invoke";
const ORIGINATOR: &str = "codex_desktop_next";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const REVOKE_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_TOKEN_RESPONSE_BYTES: usize = 65_536;
const MAX_ERROR_RESPONSE_BYTES: usize = 16_384;
const MAX_ERROR_MESSAGE_CHARS: usize = 320;

pub(super) struct OAuthClient {
    client: Client,
}

pub(super) struct ExchangedTokens {
    pub id_token: SecretString,
    pub access_token: SecretString,
    pub refresh_token: SecretString,
}

pub(super) struct TokenPatch {
    pub id_token: Option<SecretString>,
    pub access_token: Option<SecretString>,
    pub refresh_token: Option<SecretString>,
}

impl OAuthClient {
    pub fn new() -> Result<Self, AuthError> {
        let mut headers = HeaderMap::new();
        headers.insert("originator", HeaderValue::from_static(ORIGINATOR));
        let client = Client::builder()
            .default_headers(headers)
            .https_only(true)
            .timeout(REQUEST_TIMEOUT)
            .user_agent(format!(
                "{ORIGINATOR}/{} ({})",
                env!("CARGO_PKG_VERSION"),
                std::env::consts::OS
            ))
            .build()
            .map_err(|error| {
                AuthError::OAuth(format!("HTTP client initialization failed: {error}"))
            })?;
        Ok(Self { client })
    }

    pub fn authorize_url(
        &self,
        redirect_uri: &str,
        pkce: &PkceCodes,
        state: &SecretString,
    ) -> Result<String, AuthError> {
        let mut url = Url::parse(AUTHORIZE_ENDPOINT)
            .map_err(|error| AuthError::OAuth(format!("authorization URL is invalid: {error}")))?;
        url.query_pairs_mut()
            .append_pair("response_type", "code")
            .append_pair("client_id", OAUTH_CLIENT_ID)
            .append_pair("redirect_uri", redirect_uri)
            .append_pair("scope", OAUTH_SCOPE)
            .append_pair("code_challenge", &pkce.code_challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("id_token_add_organizations", "true")
            .append_pair("codex_cli_simplified_flow", "true")
            .append_pair("state", state.expose())
            .append_pair("originator", ORIGINATOR);
        Ok(url.into())
    }

    pub async fn exchange(
        &self,
        code: &SecretString,
        redirect_uri: &str,
        pkce: &PkceCodes,
    ) -> Result<ExchangedTokens, AuthError> {
        let request = ExchangeRequest {
            grant_type: "authorization_code",
            code: code.expose(),
            redirect_uri,
            client_id: OAUTH_CLIENT_ID,
            code_verifier: pkce.code_verifier.expose(),
        };
        let response = self
            .client
            .post(TOKEN_ENDPOINT)
            .form(&request)
            .send()
            .await
            .map_err(|error| transport_error("token exchange", error))?;
        if !response.status().is_success() {
            return Err(endpoint_error("token exchange", response).await);
        }
        let response = decode_response::<ExchangeResponse>(response, "token exchange").await?;
        Ok(ExchangedTokens {
            id_token: SecretString::from(response.id_token),
            access_token: SecretString::from(response.access_token),
            refresh_token: SecretString::from(response.refresh_token),
        })
    }

    pub async fn refresh(&self, refresh_token: &SecretString) -> Result<TokenPatch, AuthError> {
        let request = RefreshRequest {
            client_id: OAUTH_CLIENT_ID,
            grant_type: "refresh_token",
            refresh_token: refresh_token.expose(),
        };
        let response = self
            .client
            .post(TOKEN_ENDPOINT)
            .json(&request)
            .send()
            .await
            .map_err(|error| transport_error("token refresh", error))?;
        if !response.status().is_success() {
            return Err(endpoint_error("token refresh", response).await);
        }
        let response = decode_response::<RefreshResponse>(response, "token refresh").await?;
        if response.id_token.is_none()
            && response.access_token.is_none()
            && response.refresh_token.is_none()
        {
            return Err(AuthError::OAuth(
                "token refresh returned no updated credentials".into(),
            ));
        }
        let patch = TokenPatch {
            id_token: response.id_token.map(SecretString::from),
            access_token: response.access_token.map(SecretString::from),
            refresh_token: response.refresh_token.map(SecretString::from),
        };
        if let Some(id_token) = patch.id_token.as_ref() {
            validate_account_token(id_token)?;
        }
        Ok(patch)
    }

    pub async fn revoke_tokens(&self, tokens: &TokenSet) -> Result<(), AuthError> {
        if !tokens.refresh_token.is_empty() {
            return self
                .revoke(&tokens.refresh_token, RevokeTokenKind::Refresh)
                .await;
        }
        if !tokens.access_token.is_empty() {
            return self
                .revoke(&tokens.access_token, RevokeTokenKind::Access)
                .await;
        }
        Ok(())
    }

    pub async fn revoke_patch(&self, patch: &TokenPatch) -> Result<(), AuthError> {
        if let Some(refresh_token) = patch.refresh_token.as_ref() {
            return self.revoke(refresh_token, RevokeTokenKind::Refresh).await;
        }
        if let Some(access_token) = patch.access_token.as_ref() {
            return self.revoke(access_token, RevokeTokenKind::Access).await;
        }
        Ok(())
    }

    async fn revoke(&self, token: &SecretString, kind: RevokeTokenKind) -> Result<(), AuthError> {
        let request = RevokeRequest {
            token: token.expose(),
            token_type_hint: kind.hint(),
            client_id: kind.client_id(),
        };
        let response = self
            .client
            .post(REVOKE_ENDPOINT)
            .timeout(REVOKE_TIMEOUT)
            .json(&request)
            .send()
            .await
            .map_err(|error| transport_error("token revocation", error))?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(endpoint_error("token revocation", response).await)
        }
    }
}

#[derive(Serialize)]
struct ExchangeRequest<'a> {
    grant_type: &'static str,
    code: &'a str,
    redirect_uri: &'a str,
    client_id: &'static str,
    code_verifier: &'a str,
}

#[derive(Deserialize)]
struct ExchangeResponse {
    id_token: String,
    access_token: String,
    refresh_token: String,
}

#[derive(Serialize)]
struct RefreshRequest<'a> {
    client_id: &'static str,
    grant_type: &'static str,
    refresh_token: &'a str,
}

#[derive(Deserialize)]
struct RefreshResponse {
    id_token: Option<String>,
    access_token: Option<String>,
    refresh_token: Option<String>,
}

#[derive(Clone, Copy)]
enum RevokeTokenKind {
    Access,
    Refresh,
}

impl RevokeTokenKind {
    fn hint(self) -> &'static str {
        match self {
            Self::Access => "access_token",
            Self::Refresh => "refresh_token",
        }
    }

    fn client_id(self) -> Option<&'static str> {
        match self {
            Self::Access => None,
            Self::Refresh => Some(OAUTH_CLIENT_ID),
        }
    }
}

#[derive(Serialize)]
struct RevokeRequest<'a> {
    token: &'a str,
    token_type_hint: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    client_id: Option<&'static str>,
}

#[derive(Deserialize)]
struct OAuthErrorResponse {
    #[serde(default)]
    error: Option<OAuthErrorValue>,
    #[serde(default)]
    error_description: Option<String>,
    #[serde(default)]
    message: Option<String>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum OAuthErrorValue {
    Code(String),
    Detail {
        code: Option<String>,
        message: Option<String>,
    },
}

async fn endpoint_error(operation: &str, response: Response) -> AuthError {
    let status = response.status();
    let detail = match read_response_limited(response, MAX_ERROR_RESPONSE_BYTES, operation).await {
        Ok(bytes) if bytes.is_empty() => "the OAuth endpoint returned an empty error body".into(),
        Ok(bytes) => match serde_json::from_slice::<OAuthErrorResponse>(&bytes) {
            Ok(error) => error.description().unwrap_or_else(|| {
                "the OAuth endpoint returned an error without a description".into()
            }),
            Err(json_error) => match String::from_utf8(bytes) {
                Ok(body) => sanitized_nonempty(&body).unwrap_or_else(|| {
                    format!("the OAuth error body was invalid JSON: {json_error}")
                }),
                Err(utf8_error) => {
                    format!("the OAuth error body was neither valid JSON nor UTF-8: {utf8_error}")
                }
            },
        },
        Err(error) => format!("the OAuth error body could not be read: {error}"),
    };
    AuthError::OAuth(format!("{operation} returned {status}: {detail}"))
}

async fn decode_response<T: DeserializeOwned>(
    response: Response,
    operation: &'static str,
) -> Result<T, AuthError> {
    let bytes = read_response_limited(response, MAX_TOKEN_RESPONSE_BYTES, operation).await?;
    serde_json::from_slice(&bytes)
        .map_err(|error| AuthError::OAuth(format!("{operation} response is invalid: {error}")))
}

async fn read_response_limited(
    response: Response,
    maximum_bytes: usize,
    operation: &str,
) -> Result<Vec<u8>, AuthError> {
    let mut output = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| {
            AuthError::OAuth(format!("{operation} response could not be read: {error}"))
        })?;
        if output.len().saturating_add(chunk.len()) > maximum_bytes {
            return Err(AuthError::OAuth(format!(
                "{operation} response exceeds {maximum_bytes} bytes"
            )));
        }
        output.extend_from_slice(&chunk);
    }
    Ok(output)
}

impl OAuthErrorResponse {
    fn description(self) -> Option<String> {
        let detail = self
            .error_description
            .or(self.message)
            .or_else(|| match self.error {
                Some(OAuthErrorValue::Code(code)) => Some(code),
                Some(OAuthErrorValue::Detail { code, message }) => message.or(code),
                None => None,
            })?;
        Some(sanitize_error_message(&detail))
    }
}

fn transport_error(operation: &str, error: reqwest::Error) -> AuthError {
    let category = if error.is_timeout() {
        "request timed out"
    } else if error.is_connect() {
        "connection failed"
    } else {
        "transport failed"
    };
    AuthError::OAuth(format!("{operation} {category}"))
}

fn sanitize_error_message(message: &str) -> String {
    message
        .chars()
        .filter(|character| !character.is_control())
        .take(MAX_ERROR_MESSAGE_CHARS)
        .collect()
}

fn sanitized_nonempty(message: &str) -> Option<String> {
    let message = sanitize_error_message(message);
    (!message.trim().is_empty()).then_some(message)
}

#[cfg(test)]
mod tests {
    use super::AUTH_ISSUER;
    use super::OAUTH_CLIENT_ID;
    use super::OAUTH_SCOPE;
    use super::OAuthClient;
    use super::ORIGINATOR;
    use crate::engine::native::auth::token::SecretString;

    fn generate_test_pkce() -> crate::engine::native::auth::pkce::PkceCodes {
        crate::engine::native::auth::pkce::generate_pkce()
    }

    #[test]
    fn authorize_url_contains_the_official_codex_parameters() {
        let client = OAuthClient::new()
            .unwrap_or_else(|error| panic!("OAuth client should initialize: {error}"));
        let state = SecretString::from("state".to_owned());
        let url = client
            .authorize_url(
                "http://localhost:1455/auth/callback",
                &generate_test_pkce(),
                &state,
            )
            .unwrap_or_else(|error| panic!("authorize URL should build: {error}"));
        let parsed = url::Url::parse(&url)
            .unwrap_or_else(|error| panic!("authorize URL should parse: {error}"));
        let query = parsed
            .query_pairs()
            .into_owned()
            .collect::<std::collections::HashMap<_, _>>();

        assert_eq!(parsed.origin().ascii_serialization(), AUTH_ISSUER);
        assert_eq!(query.get("response_type").map(String::as_str), Some("code"));
        assert_eq!(
            query.get("client_id").map(String::as_str),
            Some(OAUTH_CLIENT_ID)
        );
        assert_eq!(
            query.get("redirect_uri").map(String::as_str),
            Some("http://localhost:1455/auth/callback")
        );
        assert_eq!(
            query.get("code_challenge_method").map(String::as_str),
            Some("S256")
        );
        assert_eq!(query.get("state").map(String::as_str), Some("state"));
        assert_eq!(
            query.get("originator").map(String::as_str),
            Some(ORIGINATOR)
        );
        assert_eq!(query.get("scope").map(String::as_str), Some(OAUTH_SCOPE));
        assert_eq!(
            query.get("id_token_add_organizations").map(String::as_str),
            Some("true")
        );
        assert_eq!(
            query.get("codex_cli_simplified_flow").map(String::as_str),
            Some("true")
        );
    }
}
