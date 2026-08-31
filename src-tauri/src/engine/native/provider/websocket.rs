use std::collections::VecDeque;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt as _, StreamExt as _};
use reqwest::StatusCode;
use reqwest::header::{
    CONNECTION, HeaderMap, SEC_WEBSOCKET_ACCEPT, SEC_WEBSOCKET_KEY, SEC_WEBSOCKET_VERSION, UPGRADE,
};
use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore, mpsc, oneshot, watch};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::{client::generate_key, derive_accept_key};
use tokio_tungstenite::tungstenite::protocol::{Role, WebSocketConfig};

use super::responses::{
    CompletedWebSocketResponse, MAX_RESPONSE_EVENT_BYTES, ResponseEvent, ResponseMetadataState,
    ResponseStream, decode_websocket_event, initial_response_events,
};
use crate::error::AppError;

const WEBSOCKET_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const WEBSOCKET_IDLE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const WEBSOCKET_COMMAND_CAPACITY: usize = 32;
const WEBSOCKET_RAW_MESSAGE_CAPACITY: usize = 1_024;
const WEBSOCKET_RAW_BUFFER_BYTES: usize = 16 * 1_048_576;
const WEBSOCKET_RAW_BUFFER_UNIT_BYTES: usize = 1_024;
const WEBSOCKET_RAW_BUFFER_PERMITS: usize =
    WEBSOCKET_RAW_BUFFER_BYTES / WEBSOCKET_RAW_BUFFER_UNIT_BYTES;
const WEBSOCKET_EVENT_CAPACITY: usize = 1_600;

struct ResponsesWebSocketPump {
    commands: mpsc::Sender<WebSocketCommand>,
    messages: mpsc::Receiver<BufferedWebSocketMessage>,
    task: tokio::task::JoinHandle<()>,
}

struct BufferedWebSocketMessage {
    result: Result<Message, tokio_tungstenite::tungstenite::Error>,
    _buffer_permit: OwnedSemaphorePermit,
}

enum WebSocketCommand {
    Send {
        message: Message,
        result: oneshot::Sender<Result<(), tokio_tungstenite::tungstenite::Error>>,
    },
}

impl ResponsesWebSocketPump {
    fn new<S>(mut stream: WebSocketStream<S>) -> Self
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
    {
        let (commands, mut command_rx) = mpsc::channel(WEBSOCKET_COMMAND_CAPACITY);
        let (message_tx, messages) = mpsc::channel(WEBSOCKET_RAW_MESSAGE_CAPACITY);
        let message_budget = Arc::new(Semaphore::new(WEBSOCKET_RAW_BUFFER_PERMITS));
        let task = tokio::spawn(async move {
            loop {
                tokio::select! {
                    command = command_rx.recv() => {
                        let Some(command) = command else {
                            break;
                        };
                        match command {
                            WebSocketCommand::Send { message, result } => {
                                let sent = stream.send(message).await;
                                let should_stop = sent.is_err();
                                let _ = result.send(sent);
                                if should_stop {
                                    break;
                                }
                            }
                        }
                    }
                    message = stream.next() => {
                        let Some(message) = message else {
                            break;
                        };
                        match message {
                            Ok(Message::Ping(payload)) => {
                                if let Err(error) = stream.send(Message::Pong(payload)).await {
                                    try_buffer_websocket_message(
                                        &message_tx,
                                        &message_budget,
                                        Err(error),
                                    );
                                    break;
                                }
                            }
                            Ok(Message::Pong(_)) => {}
                            Ok(message @ (Message::Text(_)
                                | Message::Binary(_)
                                | Message::Close(_)
                                | Message::Frame(_))) => {
                                let should_stop = matches!(message, Message::Close(_));
                                if !try_buffer_websocket_message(
                                    &message_tx,
                                    &message_budget,
                                    Ok(message),
                                ) || should_stop
                                {
                                    break;
                                }
                            }
                            Err(error) => {
                                try_buffer_websocket_message(
                                    &message_tx,
                                    &message_budget,
                                    Err(error),
                                );
                                break;
                            }
                        }
                    }
                }
            }
        });
        Self {
            commands,
            messages,
            task,
        }
    }

    fn is_closed(&self) -> bool {
        self.commands.is_closed() || self.task.is_finished()
    }

    async fn send(&self, message: Message) -> Result<(), tokio_tungstenite::tungstenite::Error> {
        let (result, receiver) = oneshot::channel();
        self.commands
            .send(WebSocketCommand::Send { message, result })
            .await
            .map_err(|_| tokio_tungstenite::tungstenite::Error::ConnectionClosed)?;
        receiver
            .await
            .unwrap_or(Err(tokio_tungstenite::tungstenite::Error::ConnectionClosed))
    }

    async fn next(&mut self) -> Option<Result<Message, tokio_tungstenite::tungstenite::Error>> {
        self.messages.recv().await.map(|message| message.result)
    }
}

fn try_buffer_websocket_message(
    sender: &mpsc::Sender<BufferedWebSocketMessage>,
    budget: &Arc<Semaphore>,
    result: Result<Message, tokio_tungstenite::tungstenite::Error>,
) -> bool {
    let bytes = result.as_ref().map_or(1, websocket_message_bytes).max(1);
    let permits = bytes
        .div_ceil(WEBSOCKET_RAW_BUFFER_UNIT_BYTES)
        .min(WEBSOCKET_RAW_BUFFER_PERMITS);
    let Ok(permits) = u32::try_from(permits) else {
        return false;
    };
    let Ok(buffer_permit) = Arc::clone(budget).try_acquire_many_owned(permits) else {
        return false;
    };
    sender
        .try_send(BufferedWebSocketMessage {
            result,
            _buffer_permit: buffer_permit,
        })
        .is_ok()
}

fn websocket_message_bytes(message: &Message) -> usize {
    match message {
        Message::Text(text) => text.len(),
        Message::Binary(bytes) | Message::Ping(bytes) | Message::Pong(bytes) => bytes.len(),
        Message::Close(frame) => frame.as_ref().map_or(0, |frame| frame.reason.len()),
        Message::Frame(frame) => frame.payload().len(),
    }
}

impl Drop for ResponsesWebSocketPump {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[derive(Debug)]
pub(super) enum WebSocketConnectError {
    Http(Box<reqwest::Response>),
    Error(AppError),
}

pub(super) struct ResponsesWebSocketConnection {
    stream: Arc<Mutex<Option<ResponsesWebSocketPump>>>,
    pending: VecDeque<ResponseEvent>,
    safety_faster_model: Option<String>,
}

impl ResponsesWebSocketConnection {
    pub(super) async fn is_closed(&self) -> bool {
        self.stream
            .lock()
            .await
            .as_ref()
            .is_none_or(ResponsesWebSocketPump::is_closed)
    }

    pub(super) async fn connect(
        request: reqwest::RequestBuilder,
        cancellation: &mut watch::Receiver<bool>,
    ) -> Result<Self, WebSocketConnectError> {
        let websocket_key = generate_key();
        let request = request
            .version(reqwest::Version::HTTP_11)
            .header(CONNECTION, "Upgrade")
            .header(UPGRADE, "websocket")
            .header(SEC_WEBSOCKET_VERSION, "13")
            .header(SEC_WEBSOCKET_KEY, &websocket_key);
        let send = tokio::time::timeout(WEBSOCKET_CONNECT_TIMEOUT, request.send());
        let response = tokio::select! {
            changed = cancellation.changed() => {
                if changed.is_err() || *cancellation.borrow() {
                    return Err(WebSocketConnectError::Error(AppError::Cancelled(
                        "websocket connection was cancelled".into(),
                    )));
                }
                return Err(WebSocketConnectError::Error(AppError::State(
                    "websocket cancellation changed without becoming active".into(),
                )));
            }
            result = send => match result {
                Ok(Ok(response)) => response,
                Ok(Err(error)) => {
                    return Err(WebSocketConnectError::Error(AppError::Transport(
                        error.to_string(),
                    )));
                }
                Err(_) => {
                    return Err(WebSocketConnectError::Error(AppError::Timeout {
                        operation: "websocket connection",
                    }));
                }
            }
        };
        if response.status() != StatusCode::SWITCHING_PROTOCOLS {
            return Err(WebSocketConnectError::Http(Box::new(response)));
        }
        validate_upgrade_response(response.headers(), &websocket_key)
            .map_err(WebSocketConnectError::Error)?;
        let (pending, safety_faster_model) =
            initial_response_events(response.headers()).map_err(WebSocketConnectError::Error)?;
        let upgrade = tokio::time::timeout(WEBSOCKET_CONNECT_TIMEOUT, response.upgrade());
        let upgraded = tokio::select! {
            changed = cancellation.changed() => {
                if changed.is_err() || *cancellation.borrow() {
                    return Err(WebSocketConnectError::Error(AppError::Cancelled(
                        "websocket upgrade was cancelled".into(),
                    )));
                }
                return Err(WebSocketConnectError::Error(AppError::State(
                    "websocket cancellation changed without becoming active".into(),
                )));
            }
            result = upgrade => match result {
                Ok(Ok(upgraded)) => upgraded,
                Ok(Err(error)) => {
                    return Err(WebSocketConnectError::Error(AppError::Transport(format!(
                        "websocket upgrade failed: {error}"
                    ))));
                }
                Err(_) => {
                    return Err(WebSocketConnectError::Error(AppError::Timeout {
                        operation: "websocket upgrade",
                    }));
                }
            }
        };
        let stream = WebSocketStream::from_raw_socket(
            upgraded,
            Role::Client,
            Some(response_websocket_config()),
        )
        .await;
        Ok(Self {
            stream: Arc::new(Mutex::new(Some(ResponsesWebSocketPump::new(stream)))),
            pending,
            safety_faster_model,
        })
    }

    pub(super) fn stream_request(
        &mut self,
        payload: String,
        completed_response: oneshot::Sender<CompletedWebSocketResponse>,
    ) -> ResponseStream {
        let (events_tx, events_rx) = mpsc::channel(WEBSOCKET_EVENT_CAPACITY);
        let stream = Arc::clone(&self.stream);
        let safety_faster_model = self.safety_faster_model.clone();
        tokio::spawn(async move {
            let mut guard = tokio::select! {
                biased;
                () = events_tx.closed() => return,
                guard = stream.lock() => guard,
            };
            if events_tx.is_closed() {
                return;
            }
            let result = match guard.as_mut() {
                Some(stream) => {
                    run_response_stream(
                        stream,
                        &events_tx,
                        payload,
                        safety_faster_model.as_deref(),
                        completed_response,
                    )
                    .await
                }
                None => Err(AppError::Transport(
                    "websocket connection is unavailable".into(),
                )),
            };
            if let Err(error) = result {
                let failed_stream = guard.take();
                drop(guard);
                drop(failed_stream);
                let _ = events_tx.send(Err(error)).await;
            }
        });
        ResponseStream::from_events(events_rx, std::mem::take(&mut self.pending))
    }
}

fn response_websocket_config() -> WebSocketConfig {
    WebSocketConfig::default()
        .max_message_size(Some(MAX_RESPONSE_EVENT_BYTES))
        .max_frame_size(Some(MAX_RESPONSE_EVENT_BYTES))
}

fn validate_upgrade_response(headers: &HeaderMap, websocket_key: &str) -> Result<(), AppError> {
    let connection_upgraded = headers
        .get_all(CONNECTION)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .any(|token| token.trim().eq_ignore_ascii_case("upgrade"));
    if !connection_upgraded {
        return Err(AppError::Protocol(
            "websocket upgrade response omitted `Connection: Upgrade`".into(),
        ));
    }
    let upgraded = headers
        .get(UPGRADE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.eq_ignore_ascii_case("websocket"));
    if !upgraded {
        return Err(AppError::Protocol(
            "websocket upgrade response omitted `Upgrade: websocket`".into(),
        ));
    }
    let expected_accept = derive_accept_key(websocket_key.as_bytes());
    let accepted = headers
        .get(SEC_WEBSOCKET_ACCEPT)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value == expected_accept);
    if !accepted {
        return Err(AppError::Protocol(
            "websocket upgrade response has an invalid acceptance key".into(),
        ));
    }
    Ok(())
}

async fn run_response_stream(
    stream: &mut ResponsesWebSocketPump,
    events: &mpsc::Sender<Result<ResponseEvent, AppError>>,
    payload: String,
    safety_faster_model: Option<&str>,
    completed_response: oneshot::Sender<CompletedWebSocketResponse>,
) -> Result<(), AppError> {
    send_message(stream, Message::Text(payload.into())).await?;
    let mut output_items = Vec::new();
    let mut completed_response = Some(completed_response);
    let mut metadata_state = ResponseMetadataState::new(safety_faster_model.map(str::to_owned));
    loop {
        let message = tokio::select! {
            biased;
            () = events.closed() => {
                return Err(AppError::Cancelled(
                    "websocket response consumer was dropped".into(),
                ));
            }
            result = tokio::time::timeout(WEBSOCKET_IDLE_TIMEOUT, stream.next()) => {
                match result {
                    Ok(Some(Ok(message))) => message,
                    Ok(Some(Err(error))) => {
                        return Err(AppError::Transport(format!(
                            "websocket response failed: {error}"
                        )));
                    }
                    Ok(None) => {
                        return Err(AppError::Transport(
                            "websocket closed before response.completed".into(),
                        ));
                    }
                    Err(_) => {
                        return Err(AppError::Timeout {
                            operation: "websocket response stream",
                        });
                    }
                }
            }
        };
        match message {
            Message::Text(text) => {
                let decoded = decode_websocket_event(text.as_str(), &mut metadata_state)?;
                for event in decoded {
                    if let ResponseEvent::OutputItemDone(item) = &event {
                        output_items.push(item.clone());
                    }
                    let completed = if let ResponseEvent::Completed(completed) = &event {
                        completed.response_id.clone().map(|response_id| {
                            CompletedWebSocketResponse {
                                response_id,
                                output_items: std::mem::take(&mut output_items),
                            }
                        })
                    } else {
                        None
                    };
                    if let Some(completed) = completed
                        && let Some(sender) = completed_response.take()
                    {
                        let _ = sender.send(completed);
                    }
                    let is_completed = matches!(event, ResponseEvent::Completed(_));
                    events.send(Ok(event)).await.map_err(|_| {
                        AppError::Cancelled("websocket response consumer was dropped".into())
                    })?;
                    if is_completed {
                        return Ok(());
                    }
                }
            }
            Message::Ping(payload) => send_message(stream, Message::Pong(payload)).await?,
            Message::Pong(_) | Message::Frame(_) => {}
            Message::Binary(_) => {
                return Err(AppError::Protocol(
                    "provider returned an unexpected binary websocket event".into(),
                ));
            }
            Message::Close(_) => {
                return Err(AppError::Transport(
                    "websocket closed before response.completed".into(),
                ));
            }
        }
    }
}

async fn send_message(
    stream: &mut ResponsesWebSocketPump,
    message: Message,
) -> Result<(), AppError> {
    tokio::time::timeout(WEBSOCKET_IDLE_TIMEOUT, stream.send(message))
        .await
        .map_err(|_| AppError::Timeout {
            operation: "websocket response send",
        })?
        .map_err(|error| AppError::Transport(format!("websocket send failed: {error}")))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use futures_util::{SinkExt as _, StreamExt as _};
    use reqwest::header::{HeaderMap, HeaderValue};
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _, duplex};
    use tokio::net::TcpListener;
    use tokio::sync::{mpsc, oneshot, watch};
    use tokio::time::{Duration, timeout};
    use tokio_tungstenite::WebSocketStream;
    use tokio_tungstenite::tungstenite::Message;
    use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
    use tokio_tungstenite::tungstenite::protocol::Role;

    use super::{
        ResponsesWebSocketConnection, ResponsesWebSocketPump, WEBSOCKET_RAW_BUFFER_BYTES,
        WEBSOCKET_RAW_BUFFER_PERMITS, WEBSOCKET_RAW_MESSAGE_CAPACITY, response_websocket_config,
        run_response_stream, try_buffer_websocket_message, validate_upgrade_response,
    };
    use crate::engine::native::provider::responses::MAX_RESPONSE_EVENT_BYTES;
    use crate::engine::native::provider::{ResponseEvent, ResponseItem};

    #[test]
    fn validates_the_complete_websocket_upgrade_contract() {
        let key = "dGhlIHNhbXBsZSBub25jZQ==";
        let mut headers = HeaderMap::new();
        headers.insert(
            "connection",
            HeaderValue::from_static("keep-alive, Upgrade"),
        );
        headers.insert("upgrade", HeaderValue::from_static("websocket"));
        headers.insert(
            "sec-websocket-accept",
            HeaderValue::from_str(&derive_accept_key(key.as_bytes()))
                .expect("derived acceptance key should be a header"),
        );

        validate_upgrade_response(&headers, key)
            .expect("complete websocket upgrade should validate");
    }

    #[test]
    fn rejects_an_unbound_websocket_upgrade() {
        let key = "dGhlIHNhbXBsZSBub25jZQ==";
        let mut headers = HeaderMap::new();
        headers.insert("connection", HeaderValue::from_static("Upgrade"));
        headers.insert("upgrade", HeaderValue::from_static("websocket"));
        headers.insert("sec-websocket-accept", HeaderValue::from_static("invalid"));

        assert!(validate_upgrade_response(&headers, key).is_err());
    }

    #[test]
    fn bounds_websocket_frames_to_the_response_event_limit() {
        let config = response_websocket_config();

        assert_eq!(config.max_message_size, Some(MAX_RESPONSE_EVENT_BYTES));
        assert_eq!(config.max_frame_size, Some(MAX_RESPONSE_EVENT_BYTES));
    }

    #[test]
    fn bounds_queued_websocket_messages_by_encoded_bytes() {
        let (sender, mut receiver) = mpsc::channel(WEBSOCKET_RAW_MESSAGE_CAPACITY);
        let budget = Arc::new(tokio::sync::Semaphore::new(WEBSOCKET_RAW_BUFFER_PERMITS));
        let messages_that_fit = WEBSOCKET_RAW_BUFFER_BYTES / MAX_RESPONSE_EVENT_BYTES;

        for _ in 0..messages_that_fit {
            assert!(try_buffer_websocket_message(
                &sender,
                &budget,
                Ok(Message::Binary(vec![0_u8; MAX_RESPONSE_EVENT_BYTES].into())),
            ));
        }
        assert!(!try_buffer_websocket_message(
            &sender,
            &budget,
            Ok(Message::Binary(vec![0_u8; MAX_RESPONSE_EVENT_BYTES].into())),
        ));

        drop(
            receiver
                .try_recv()
                .expect("one buffered message should be available"),
        );
        assert!(try_buffer_websocket_message(
            &sender,
            &budget,
            Ok(Message::Binary(vec![0_u8; MAX_RESPONSE_EVENT_BYTES].into())),
        ));
    }

    #[tokio::test]
    async fn websocket_pump_answers_ping_between_response_requests() {
        let (client_io, server_io) = duplex(64 * 1_024);
        let client = WebSocketStream::from_raw_socket(client_io, Role::Client, None).await;
        let mut server = WebSocketStream::from_raw_socket(server_io, Role::Server, None).await;
        let _pump = ResponsesWebSocketPump::new(client);

        server
            .send(Message::Ping(vec![1, 2, 3].into()))
            .await
            .expect("server ping should send");
        let message = timeout(Duration::from_secs(1), server.next())
            .await
            .expect("client should answer ping promptly")
            .expect("websocket should remain open")
            .expect("pong should decode");

        assert_eq!(message, Message::Pong(vec![1, 2, 3].into()));
    }

    #[tokio::test]
    async fn websocket_pump_reuses_one_connection_for_sequential_responses() {
        let (client_io, server_io) = duplex(64 * 1_024);
        let client = WebSocketStream::from_raw_socket(client_io, Role::Client, None).await;
        let mut server = WebSocketStream::from_raw_socket(server_io, Role::Server, None).await;
        let mut pump = ResponsesWebSocketPump::new(client);
        let server_task = tokio::spawn(async move {
            for sequence in 1..=2 {
                let request = server
                    .next()
                    .await
                    .expect("request should arrive")
                    .expect("request frame should decode");
                assert_eq!(request, Message::Text(format!("request-{sequence}").into()));
                server
                    .send(Message::Text(
                        format!(
                            "{{\"type\":\"response.output_item.done\",\"item\":{{\"type\":\"message\",\"id\":\"message-{sequence}\",\"role\":\"assistant\",\"content\":[{{\"type\":\"output_text\",\"text\":\"done-{sequence}\"}}],\"phase\":\"final_answer\"}}}}"
                        )
                        .into(),
                    ))
                    .await
                    .expect("output event should send");
                server
                    .send(Message::Text(
                        format!(
                            "{{\"type\":\"response.completed\",\"response\":{{\"id\":\"response-{sequence}\"}}}}"
                        )
                        .into(),
                    ))
                    .await
                    .expect("completion event should send");
            }
        });

        for sequence in 1..=2 {
            let (events_tx, mut events_rx) = mpsc::channel(8);
            let (completed_tx, completed_rx) = oneshot::channel();
            run_response_stream(
                &mut pump,
                &events_tx,
                format!("request-{sequence}"),
                None,
                completed_tx,
            )
            .await
            .expect("response should complete");
            let output = events_rx
                .recv()
                .await
                .expect("output event should arrive")
                .expect("output event should succeed");
            let completed = events_rx
                .recv()
                .await
                .expect("completed event should arrive")
                .expect("completed event should succeed");
            let baseline = completed_rx
                .await
                .expect("completed response baseline should arrive");

            assert!(matches!(
                output,
                ResponseEvent::OutputItemDone(ResponseItem::Message { .. })
            ));
            assert!(matches!(completed, ResponseEvent::Completed(_)));
            assert_eq!(baseline.response_id, format!("response-{sequence}"));
            assert_eq!(baseline.output_items.len(), 1);
        }
        server_task.await.expect("server should finish");
    }

    #[tokio::test]
    async fn reqwest_upgrade_drives_a_complete_websocket_response() {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("loopback listener should bind");
        let address = listener
            .local_addr()
            .expect("loopback listener should expose its address");
        let server_task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("client should connect");
            let mut request = Vec::with_capacity(2_048);
            let mut chunk = [0_u8; 1_024];
            while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                let read = socket.read(&mut chunk).await.expect("request should read");
                assert!(read > 0, "client closed before completing the handshake");
                request.extend_from_slice(&chunk[..read]);
                assert!(request.len() <= 16 * 1_024, "handshake exceeded test bound");
            }
            let request = String::from_utf8(request).expect("handshake should be UTF-8");
            let key = request
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("sec-websocket-key")
                        .then(|| value.trim().to_string())
                })
                .expect("handshake should contain a websocket key");
            let response = format!(
                "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: {}\r\n\r\n",
                derive_accept_key(key.as_bytes())
            );
            socket
                .write_all(response.as_bytes())
                .await
                .expect("upgrade response should write");
            let mut websocket = WebSocketStream::from_raw_socket(socket, Role::Server, None).await;
            let request = websocket
                .next()
                .await
                .expect("response request should arrive")
                .expect("response request should decode");
            assert_eq!(request, Message::Text("request".into()));
            websocket
                .send(Message::Text(
                    "{\"type\":\"response.completed\",\"response\":{\"id\":\"response-1\"}}".into(),
                ))
                .await
                .expect("completion should send");
        });
        let (_cancellation_tx, mut cancellation) = watch::channel(false);
        let mut connection = ResponsesWebSocketConnection::connect(
            reqwest::Client::new().get(format!("http://{address}/responses")),
            &mut cancellation,
        )
        .await
        .expect("reqwest upgrade should create a websocket");
        let (completed_tx, completed_rx) = oneshot::channel();
        let mut response = connection.stream_request("request".into(), completed_tx);
        let event = response
            .next_event(&mut cancellation)
            .await
            .expect("response event should decode");
        let baseline = completed_rx
            .await
            .expect("completed response baseline should arrive");

        assert!(matches!(event, Some(ResponseEvent::Completed(_))));
        assert_eq!(baseline.response_id, "response-1");
        server_task.await.expect("server should finish");
    }
}
