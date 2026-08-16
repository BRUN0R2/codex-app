use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

use super::{
    MAX_IDENTIFIER_BYTES, MAX_ITEM_BYTES, decode_bounded, parse_status, read_thread_header,
    storage_error, validate_text,
};
use crate::engine::{CodexThread, ThreadTurn, TurnStatus};
use crate::error::AppError;

pub(super) const INITIAL_THREAD_HISTORY_PAGE_ROWS: usize = 64;
pub(super) const OLDER_THREAD_HISTORY_PAGE_ROWS: usize = 256;
const THREAD_HISTORY_PAGE_BYTES: usize = 4 * 1_048_576;
const MAX_HISTORY_CURSOR_BYTES: usize = 1_024;
const HISTORY_CURSOR_VERSION: u8 = 1;

#[derive(Debug)]
pub(in crate::engine::native) struct StoredThreadPage {
    pub thread: CodexThread,
    pub next_cursor: Option<String>,
}

impl std::ops::Deref for StoredThreadPage {
    type Target = CodexThread;

    fn deref(&self) -> &Self::Target {
        &self.thread
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ThreadHistoryCursor {
    version: u8,
    thread_id: String,
    created_at: i64,
    turn_id: String,
    sequence: i64,
}

#[derive(Debug)]
struct ThreadHistoryRow {
    turn_id: String,
    status: String,
    error: Option<String>,
    created_at: i64,
    updated_at: i64,
    sequence: i64,
    payload: Option<String>,
}

impl ThreadHistoryRow {
    fn cursor(&self, thread_id: &str) -> ThreadHistoryCursor {
        ThreadHistoryCursor {
            version: HISTORY_CURSOR_VERSION,
            thread_id: thread_id.into(),
            created_at: self.created_at,
            turn_id: self.turn_id.clone(),
            sequence: self.sequence,
        }
    }
}

pub(super) fn parse_history_cursor(
    cursor: Option<&str>,
    expected_thread_id: &str,
) -> Result<Option<ThreadHistoryCursor>, AppError> {
    let Some(cursor) = cursor else {
        return Ok(None);
    };
    if cursor.is_empty() || cursor.len() > MAX_HISTORY_CURSOR_BYTES {
        return Err(AppError::Protocol(
            "thread history cursor is invalid".into(),
        ));
    }
    let payload = URL_SAFE_NO_PAD
        .decode(cursor)
        .map_err(|_| AppError::Protocol("thread history cursor is invalid".into()))?;
    if payload.len() > MAX_HISTORY_CURSOR_BYTES {
        return Err(AppError::Protocol(
            "thread history cursor is invalid".into(),
        ));
    }
    let decoded: ThreadHistoryCursor = serde_json::from_slice(&payload)
        .map_err(|_| AppError::Protocol("thread history cursor is invalid".into()))?;
    if decoded.version != HISTORY_CURSOR_VERSION
        || decoded.thread_id != expected_thread_id
        || decoded.created_at < 0
        || decoded.sequence < 0
    {
        return Err(AppError::Protocol(
            "thread history cursor does not match the requested thread".into(),
        ));
    }
    validate_text(
        "thread history cursor turn id",
        &decoded.turn_id,
        MAX_IDENTIFIER_BYTES,
    )?;
    Ok(Some(decoded))
}

pub(super) fn read_thread_page(
    connection: &Connection,
    thread_id: &str,
    cursor: Option<&ThreadHistoryCursor>,
) -> Result<StoredThreadPage, AppError> {
    let header = read_thread_header(connection, thread_id)?;
    let page_rows = if cursor.is_none() {
        INITIAL_THREAD_HISTORY_PAGE_ROWS
    } else {
        OLDER_THREAD_HISTORY_PAGE_ROWS
    };
    let requested = page_rows + 1;
    let requested_sql =
        i64::try_from(requested).map_err(|error| AppError::Storage(error.to_string()))?;
    let cursor_created_at = cursor.map(|value| value.created_at);
    let cursor_turn_id = cursor.map(|value| value.turn_id.as_str());
    let cursor_sequence = cursor.map(|value| value.sequence);
    let mut statement = connection
        .prepare(
            "SELECT turns.id, turns.status, turns.error, turns.created_at, turns.updated_at,
                    COALESCE(thread_items.sequence, 0), thread_items.payload
             FROM turns
             LEFT JOIN thread_items ON thread_items.turn_id = turns.id
             WHERE turns.thread_id = ?1
               AND (
                    ?2 IS NULL
                    OR turns.created_at < ?2
                    OR (turns.created_at = ?2 AND turns.id < ?3)
                    OR (
                        turns.created_at = ?2
                        AND turns.id = ?3
                        AND COALESCE(thread_items.sequence, 0) < ?4
                    )
               )
             ORDER BY turns.created_at DESC, turns.id DESC,
                      COALESCE(thread_items.sequence, 0) DESC
             LIMIT ?5",
        )
        .map_err(storage_error)?;
    let rows = statement
        .query_map(
            params![
                thread_id,
                cursor_created_at,
                cursor_turn_id,
                cursor_sequence,
                requested_sql
            ],
            |row| {
                Ok(ThreadHistoryRow {
                    turn_id: row.get(0)?,
                    status: row.get(1)?,
                    error: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                    sequence: row.get(5)?,
                    payload: row.get(6)?,
                })
            },
        )
        .map_err(storage_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(storage_error)?;

    let mut selected_rows = Vec::with_capacity(rows.len().min(page_rows));
    let mut encoded_bytes = 0usize;
    let mut has_more = rows.len() > page_rows;
    for row in rows.into_iter().take(page_rows) {
        let row_bytes = row.payload.as_ref().map_or(0, String::len);
        let next_bytes = encoded_bytes
            .checked_add(row_bytes)
            .ok_or_else(|| AppError::Storage("thread history page size overflowed".into()))?;
        if !selected_rows.is_empty() && next_bytes > THREAD_HISTORY_PAGE_BYTES {
            has_more = true;
            break;
        }
        encoded_bytes = next_bytes;
        selected_rows.push(row);
    }

    let next_cursor = if has_more {
        selected_rows
            .last()
            .map(|row| encode_history_cursor(&row.cursor(thread_id)))
            .transpose()?
    } else {
        None
    };
    selected_rows.reverse();

    let mut turns: Vec<ThreadTurn> = Vec::new();
    for row in selected_rows {
        if turns.last().is_none_or(|turn| turn.id != row.turn_id) {
            let status = parse_status(&row.status)?;
            if (status == TurnStatus::Failed) != row.error.is_some() {
                return Err(AppError::Storage(format!(
                    "turn `{}` has an incoherent failure status",
                    row.turn_id
                )));
            }
            turns.push(ThreadTurn {
                id: row.turn_id,
                items: Vec::new(),
                status,
                error: row.error,
                created_at: row.created_at,
                updated_at: row.updated_at,
            });
        }
        let Some(payload) = row.payload else {
            continue;
        };
        let item = decode_bounded(&payload, MAX_ITEM_BYTES, "thread history item")?;
        turns
            .last_mut()
            .ok_or_else(|| AppError::State("thread item has no owning turn".into()))?
            .items
            .push(item);
    }

    Ok(StoredThreadPage {
        thread: CodexThread {
            summary: header.into_summary(),
            turns,
        },
        next_cursor,
    })
}

fn encode_history_cursor(cursor: &ThreadHistoryCursor) -> Result<String, AppError> {
    let payload = serde_json::to_vec(cursor)
        .map_err(|error| AppError::Storage(format!("could not encode history cursor: {error}")))?;
    let encoded = URL_SAFE_NO_PAD.encode(payload);
    if encoded.len() > MAX_HISTORY_CURSOR_BYTES {
        return Err(AppError::Storage(
            "encoded thread history cursor exceeds its transport bound".into(),
        ));
    }
    Ok(encoded)
}
