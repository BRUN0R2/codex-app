use std::io;
use std::time::Duration;

use tokio::io::AsyncReadExt as _;
use tokio::io::AsyncWriteExt as _;
use tokio::net::TcpListener;
use tokio::net::TcpStream;
use tokio::time::timeout;
use url::form_urlencoded;
use zeroize::Zeroize;
use zeroize::Zeroizing;

use super::error::AuthError;
use super::token::SecretString;

const CALLBACK_PORTS: [u16; 2] = [1455, 1457];
const CALLBACK_PATH: &str = "/auth/callback";
const LOGIN_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const CONNECTION_READ_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_CALLBACK_CONNECTIONS: usize = 32;
const MAX_REQUEST_HEADER_BYTES: usize = 16 * 1024;

const SUCCESS_HTML: &str = r#"<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Validação concluída</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #171817; color: #f4f4f2; }
    main { max-width: 680px; padding: 48px; text-align: center; }
    h1 { margin: 0 0 16px; font-size: 25px; letter-spacing: -0.02em; }
    p { margin: 0; color: #c7c7c2; font-size: 16px; line-height: 1.5; }
  </style>
</head>
<body><main><h1>Login concluído</h1><p>A conta ChatGPT foi conectada com segurança. Pode fechar esta janela.</p></main></body>
</html>"#;

const ERROR_HTML: &str = r#"<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Não foi possível concluir o login</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #171817; color: #f4f4f2; }
    main { max-width: 680px; padding: 48px; text-align: center; }
    h1 { margin: 0 0 16px; font-size: 25px; letter-spacing: -0.02em; }
    p { margin: 0; color: #c7c7c2; font-size: 16px; line-height: 1.5; }
  </style>
</head>
<body><main><h1>Não foi possível concluir o login</h1><p>Volte ao aplicativo para ver os detalhes e tentar novamente.</p></main></body>
</html>"#;

pub(super) struct CallbackServer {
    listener: TcpListener,
    redirect_uri: String,
}

pub(super) struct AuthorizationCallback {
    pub code: SecretString,
    connection: TcpStream,
}

impl CallbackServer {
    pub async fn bind() -> Result<Self, AuthError> {
        for port in CALLBACK_PORTS {
            match TcpListener::bind(("127.0.0.1", port)).await {
                Ok(listener) => {
                    return Ok(Self {
                        listener,
                        redirect_uri: format!("http://localhost:{port}{CALLBACK_PATH}"),
                    });
                }
                Err(error) if error.kind() == io::ErrorKind::AddrInUse => continue,
                Err(error) => {
                    return Err(AuthError::InvalidCallback(format!(
                        "could not bind port {port}: {error}"
                    )));
                }
            }
        }
        Err(AuthError::CallbackUnavailable)
    }

    pub fn redirect_uri(&self) -> &str {
        &self.redirect_uri
    }

    pub async fn wait_for_authorization(
        self,
        expected_state: &SecretString,
    ) -> Result<AuthorizationCallback, AuthError> {
        timeout(
            LOGIN_TIMEOUT,
            self.wait_for_authorization_inner(expected_state),
        )
        .await
        .map_err(|_| AuthError::LoginTimedOut)?
    }

    async fn wait_for_authorization_inner(
        self,
        expected_state: &SecretString,
    ) -> Result<AuthorizationCallback, AuthError> {
        for _ in 0..MAX_CALLBACK_CONNECTIONS {
            let (mut connection, _) = self
                .listener
                .accept()
                .await
                .map_err(|error| AuthError::InvalidCallback(error.to_string()))?;
            let target = match timeout(
                CONNECTION_READ_TIMEOUT,
                read_request_target(&mut connection),
            )
            .await
            {
                Ok(Ok(target)) => target,
                Ok(Err(error)) => {
                    respond_html(&mut connection, 400, ERROR_HTML).await?;
                    if matches!(error, AuthError::InvalidCallback(_)) {
                        continue;
                    }
                    return Err(error);
                }
                Err(_) => {
                    respond_html(&mut connection, 408, ERROR_HTML).await?;
                    continue;
                }
            };

            match parse_callback_target(&target, expected_state) {
                Ok(ParsedCallback::Ignore) => {
                    respond_html(&mut connection, 404, ERROR_HTML).await?;
                }
                Ok(ParsedCallback::StateMismatch) => {
                    respond_html(&mut connection, 400, ERROR_HTML).await?;
                }
                Ok(ParsedCallback::Authorized(code)) => {
                    return Ok(AuthorizationCallback { code, connection });
                }
                Err(error) => {
                    respond_html(&mut connection, 400, ERROR_HTML).await?;
                    return Err(error);
                }
            }
        }
        Err(AuthError::InvalidCallback(
            "too many invalid callback requests".into(),
        ))
    }
}

impl AuthorizationCallback {
    pub async fn respond_success(mut self) -> Result<(), AuthError> {
        respond_html(&mut self.connection, 200, SUCCESS_HTML).await
    }

    pub async fn respond_failure(mut self) -> Result<(), AuthError> {
        respond_html(&mut self.connection, 400, ERROR_HTML).await
    }
}

enum ParsedCallback {
    Ignore,
    StateMismatch,
    Authorized(SecretString),
}

fn parse_callback_target(
    target: &str,
    expected_state: &SecretString,
) -> Result<ParsedCallback, AuthError> {
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    if path != CALLBACK_PATH {
        return Ok(ParsedCallback::Ignore);
    }

    let mut code = None;
    let mut state = None;
    let mut oauth_error = None;
    let mut error_description = None;
    for (key, value) in form_urlencoded::parse(query.as_bytes()) {
        match key.as_ref() {
            "code" => {
                set_once(
                    &mut code,
                    SecretString::from(value.into_owned()),
                    "authorization code was provided more than once",
                )?;
            }
            "state" => {
                set_once(
                    &mut state,
                    SecretString::from(value.into_owned()),
                    "OAuth state was provided more than once",
                )?;
            }
            "error" => {
                set_once(
                    &mut oauth_error,
                    value.into_owned(),
                    "OAuth error was provided more than once",
                )?;
            }
            "error_description" => {
                set_once(
                    &mut error_description,
                    value.into_owned(),
                    "OAuth error description was provided more than once",
                )?;
            }
            _ => {}
        }
    }

    if state.as_ref() != Some(expected_state) {
        return Ok(ParsedCallback::StateMismatch);
    }
    if let Some(error) = oauth_error {
        let detail = error_description
            .filter(|description| !description.trim().is_empty())
            .unwrap_or(error);
        return Err(AuthError::OAuth(sanitize_callback_error(&detail)));
    }
    match code {
        Some(code) if !code.is_empty() => Ok(ParsedCallback::Authorized(code)),
        _ => Err(AuthError::InvalidCallback(
            "authorization code is missing".into(),
        )),
    }
}

fn set_once<T>(slot: &mut Option<T>, value: T, duplicate_message: &str) -> Result<(), AuthError> {
    if slot.replace(value).is_some() {
        return Err(AuthError::InvalidCallback(duplicate_message.into()));
    }
    Ok(())
}

async fn read_request_target(connection: &mut TcpStream) -> Result<Zeroizing<String>, AuthError> {
    let mut request = Zeroizing::new(Vec::with_capacity(2048));
    let mut chunk = [0_u8; 1024];
    loop {
        let read = connection
            .read(&mut chunk)
            .await
            .map_err(|error| AuthError::InvalidCallback(error.to_string()))?;
        if read == 0 {
            chunk.zeroize();
            return Err(AuthError::InvalidCallback(
                "callback connection closed before sending a request".into(),
            ));
        }
        request.extend_from_slice(&chunk[..read]);
        chunk[..read].zeroize();
        if request.len() > MAX_REQUEST_HEADER_BYTES {
            return Err(AuthError::InvalidCallback(
                "callback request headers are too large".into(),
            ));
        }
        if request.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }

    let request = String::from_utf8(std::mem::take(&mut *request))
        .map_err(|_| AuthError::InvalidCallback("callback request is not UTF-8".into()))?;
    let mut request = Zeroizing::new(request);
    let first_line = request
        .lines()
        .next()
        .ok_or_else(|| AuthError::InvalidCallback("callback request line is missing".into()))?;
    let mut parts = first_line.split_whitespace();
    let method = parts.next();
    let target = parts.next();
    let version = parts.next();
    if method != Some("GET")
        || version.is_none_or(|value| !value.starts_with("HTTP/1."))
        || parts.next().is_some()
    {
        return Err(AuthError::InvalidCallback(
            "callback request must be an HTTP GET".into(),
        ));
    }
    let target = target
        .filter(|value| value.starts_with('/'))
        .ok_or_else(|| AuthError::InvalidCallback("callback target is invalid".into()))?
        .to_owned();
    request.zeroize();
    Ok(Zeroizing::new(target))
}

async fn respond_html(
    connection: &mut TcpStream,
    status: u16,
    body: &str,
) -> Result<(), AuthError> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        408 => "Request Timeout",
        _ => "Error",
    };
    let headers = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nContent-Security-Policy: default-src 'none'; style-src 'unsafe-inline'\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n",
        body.len()
    );
    connection
        .write_all(headers.as_bytes())
        .await
        .map_err(|error| {
            AuthError::InvalidCallback(format!("could not answer browser: {error}"))
        })?;
    connection
        .write_all(body.as_bytes())
        .await
        .map_err(|error| {
            AuthError::InvalidCallback(format!("could not answer browser: {error}"))
        })?;
    connection
        .shutdown()
        .await
        .map_err(|error| AuthError::InvalidCallback(format!("could not close callback: {error}")))
}

fn sanitize_callback_error(message: &str) -> String {
    message
        .chars()
        .filter(|character| !character.is_control())
        .take(320)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::ParsedCallback;
    use super::parse_callback_target;
    use crate::engine::native::auth::token::SecretString;

    #[test]
    fn callback_requires_the_exact_state() {
        let expected = SecretString::from("expected".to_owned());
        let parsed = parse_callback_target(
            "/auth/callback?code=authorization-code&state=unexpected",
            &expected,
        )
        .unwrap_or_else(|error| panic!("callback should parse: {error}"));

        assert!(matches!(parsed, ParsedCallback::StateMismatch));
    }

    #[test]
    fn callback_decodes_the_authorization_code() {
        let expected = SecretString::from("expected".to_owned());
        let parsed = parse_callback_target(
            "/auth/callback?code=code%2Fwith%2Bcharacters&state=expected",
            &expected,
        )
        .unwrap_or_else(|error| panic!("callback should parse: {error}"));

        let ParsedCallback::Authorized(code) = parsed else {
            panic!("callback should be authorized");
        };
        assert_eq!(code.expose(), "code/with+characters");
    }
}
