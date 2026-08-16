use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::{Connection, OptionalExtension as _, Transaction, TransactionBehavior, params};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tauri::{AppHandle, Manager as _};
use tokio::sync::RwLock;
use uuid::Uuid;

use super::context_window::ContextUsageSnapshot;
use super::output::{OUTPUT_CHUNK_BYTES, OutputSource};
use super::provider::ResponseItem;
use super::terminal_output::normalize_terminal_bytes;
use super::text::truncate_utf8;
use crate::engine::{
    AppConfig, CompletedTurn, ConfigReadResponse, ConfigUpdate, ConfigUpdateResponse,
    ConversationMode, DesktopPreferences, OperationAck, OutputReadResponse, ThreadActiveFlag,
    ThreadItem, ThreadListResponse, ThreadOutput, ThreadStatus, ThreadSummary, TurnStatus,
    TurnSummary,
};
use crate::error::AppError;

#[cfg(test)]
use crate::engine::CodexThread;

mod history;

use self::history::{StoredThreadPage, parse_history_cursor, read_thread_page as load_thread_page};

const DATABASE_FILE_NAME: &str = "native-state-profile-v2.sqlite3";
const DATABASE_SCHEMA_VERSION: i64 = 2;
const DATABASE_APPLICATION_ID: i64 = 1_128_552_527;
const DATABASE_TABLES: &str = "app_config,chat_conversations,output_chunks,output_resources,provider_items,thread_items,threads,turns";
const THREAD_COLUMNS: &str = "id,cwd,name,preview,archived,created_at,updated_at,project_path,mode";
const TURN_COLUMNS: &str =
    "id,thread_id,owner_id,status,model,reasoning_effort,error,created_at,updated_at";
const THREAD_PAGE_SIZE: usize = 50;
const MAX_CURSOR_BYTES: usize = 20;
const MAX_OUTPUT_CURSOR_BYTES: usize = 20;
const MAX_ITEM_BYTES: usize = 2 * 1_048_576;
const MAX_HISTORY_BYTES: usize = 32 * 1_048_576;
const MAX_HISTORY_ITEMS: usize = 20_000;
const MAX_THREAD_NAME_BYTES: usize = 256;
const MAX_PREVIEW_BYTES: usize = 512;
const MAX_DEVELOPER_INSTRUCTIONS_BYTES: usize = 262_144;
const MAX_IDENTIFIER_BYTES: usize = 256;
const MAX_DATABASE_CONNECTIONS: u32 = 8;

type SqlitePool = Pool<SqliteConnectionManager>;

#[derive(Debug)]
struct Database {
    path: PathBuf,
    pool: SqlitePool,
}

#[derive(Debug)]
pub struct NativeStorage {
    database: RwLock<Option<Database>>,
    owner_id: String,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(super) struct ChatConversationState {
    pub conversation_id: Option<String>,
    pub parent_message_id: Option<String>,
}

#[derive(Debug)]
pub(super) struct ProviderHistorySnapshot {
    pub items: Vec<ResponseItem>,
    encoded_bytes: usize,
    last_sequence: i64,
}

impl ProviderHistorySnapshot {
    fn extend(&mut self, page: ProviderHistoryPage) -> Result<(), AppError> {
        let total_items = self
            .items
            .len()
            .checked_add(page.items.len())
            .ok_or_else(|| {
                AppError::Storage("stored provider history item count overflow".into())
            })?;
        if total_items > MAX_HISTORY_ITEMS {
            return Err(AppError::Storage(format!(
                "stored provider history exceeds {MAX_HISTORY_ITEMS} items"
            )));
        }
        let total_bytes = self
            .encoded_bytes
            .checked_add(page.encoded_bytes)
            .ok_or_else(|| AppError::Storage("stored provider history size overflow".into()))?;
        if total_bytes > MAX_HISTORY_BYTES {
            return Err(AppError::Storage(format!(
                "stored provider history exceeds {MAX_HISTORY_BYTES} bytes"
            )));
        }
        self.items.extend(page.items);
        self.encoded_bytes = total_bytes;
        self.last_sequence = page.last_sequence;
        Ok(())
    }
}

struct ProviderHistoryPage {
    items: Vec<ResponseItem>,
    encoded_bytes: usize,
    last_sequence: i64,
}

impl Default for NativeStorage {
    fn default() -> Self {
        Self {
            database: RwLock::new(None),
            owner_id: Uuid::now_v7().to_string(),
        }
    }
}

impl NativeStorage {
    pub async fn initialize(&self, app: &AppHandle) -> Result<(), AppError> {
        let directory = app
            .path()
            .app_data_dir()
            .map_err(|error| AppError::Storage(error.to_string()))?;
        self.initialize_at(directory.join(DATABASE_FILE_NAME)).await
    }

    async fn initialize_at(&self, database_path: PathBuf) -> Result<(), AppError> {
        if self
            .database
            .read()
            .await
            .as_ref()
            .is_some_and(|database| database.path == database_path)
        {
            return Ok(());
        }
        let parent = database_path
            .parent()
            .ok_or_else(|| AppError::Storage("database path has no parent".into()))?;
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| AppError::Storage(error.to_string()))?;

        let database = run_blocking(move || {
            let mut connection = open_database_connection(&database_path)?;
            let version: i64 = connection
                .query_row("PRAGMA user_version", [], |row| row.get(0))
                .map_err(storage_error)?;
            let application_id: i64 = connection
                .query_row("PRAGMA application_id", [], |row| row.get(0))
                .map_err(storage_error)?;
            if version == 0 && application_id == 0 {
                initialize_database(&mut connection)?;
            } else {
                if application_id == DATABASE_APPLICATION_ID && version == 1 {
                    migrate_database_v1_to_v2(&mut connection)?;
                }
                let migrated_version: i64 = connection
                    .query_row("PRAGMA user_version", [], |row| row.get(0))
                    .map_err(storage_error)?;
                validate_database(&connection, migrated_version, application_id)?;
            }

            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(storage_error)?;
            transaction
                .execute(
                    "UPDATE turns SET status = 'interrupted', updated_at = ?1
                     WHERE status = 'inProgress'",
                    [unix_timestamp()?],
                )
                .map_err(storage_error)?;
            transaction.commit().map_err(storage_error)?;
            drop(connection);

            let manager = SqliteConnectionManager::file(&database_path)
                .with_init(|connection| configure_database_connection(connection));
            let pool = Pool::builder()
                .max_size(database_connection_limit())
                .min_idle(Some(1))
                .connection_timeout(Duration::from_secs(5))
                .build(manager)
                .map_err(pool_error)?;
            Ok(Database {
                path: database_path,
                pool,
            })
        })
        .await?;

        *self.database.write().await = Some(database);
        Ok(())
    }

    pub async fn create_thread(
        &self,
        cwd: String,
        project_path: Option<String>,
        mode: ConversationMode,
    ) -> Result<StoredThreadPage, AppError> {
        let pool = self.pool().await?;
        run_blocking(move || {
            let connection = pool.get().map_err(pool_error)?;
            let id = Uuid::now_v7().to_string();
            let now = unix_timestamp()?;
            connection
                .execute(
                    "INSERT INTO threads
                         (id, cwd, project_path, mode, name, preview, archived, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, NULL, '', 0, ?5, ?5)",
                    params![id, cwd, project_path, mode.as_str(), now],
                )
                .map_err(storage_error)?;
            load_thread_page(&connection, &id, None)
        })
        .await
    }

    pub async fn list_threads(
        &self,
        cursor: Option<String>,
        archived: bool,
    ) -> Result<ThreadListResponse, AppError> {
        let offset = parse_cursor(cursor.as_deref())?;
        let pool = self.pool().await?;
        run_blocking(move || {
            let connection = pool.get().map_err(pool_error)?;
            let requested = THREAD_PAGE_SIZE + 1;
            let requested_sql = i64::try_from(requested)
                .map_err(|error| AppError::Storage(error.to_string()))?;
            let offset_sql = i64::try_from(offset)
                .map_err(|error| AppError::Protocol(format!("thread cursor is too large: {error}")))?;
            let mut statement = connection
                .prepare(
                    "SELECT id, cwd, project_path, mode, name, preview, created_at, updated_at,
                            EXISTS(SELECT 1 FROM turns WHERE thread_id = threads.id AND status = 'inProgress')
                     FROM threads
                     WHERE archived = ?3
                     ORDER BY updated_at DESC, id DESC
                     LIMIT ?1 OFFSET ?2",
                )
                .map_err(storage_error)?;
            let rows = statement
                .query_map(params![requested_sql, offset_sql, archived], |row| {
                    Ok(ThreadHeader {
                        id: row.get(0)?,
                        cwd: row.get(1)?,
                        project_path: row.get(2)?,
                        mode: parse_conversation_mode(&row.get::<_, String>(3)?)?,
                        name: row.get(4)?,
                        preview: row.get(5)?,
                        created_at: row.get(6)?,
                        updated_at: row.get(7)?,
                        active: row.get(8)?,
                    })
                })
                .map_err(storage_error)?;
            let mut data = rows
                .collect::<Result<Vec<_>, _>>()
                .map_err(storage_error)?;
            let has_more = data.len() > THREAD_PAGE_SIZE;
            data.truncate(THREAD_PAGE_SIZE);
            let data = data.into_iter().map(ThreadHeader::into_summary).collect();
            Ok(ThreadListResponse {
                data,
                next_cursor: has_more.then(|| (offset + THREAD_PAGE_SIZE).to_string()),
            })
        })
        .await
    }

    #[cfg(test)]
    async fn read_thread(&self, thread_id: String) -> Result<CodexThread, AppError> {
        Ok(self.read_thread_page(thread_id, None).await?.thread)
    }

    pub async fn read_thread_page(
        &self,
        thread_id: String,
        cursor: Option<String>,
    ) -> Result<StoredThreadPage, AppError> {
        let cursor = parse_history_cursor(cursor.as_deref(), &thread_id)?;
        let pool = self.pool().await?;
        run_blocking(move || {
            let connection = pool.get().map_err(pool_error)?;
            load_thread_page(&connection, &thread_id, cursor.as_ref())
        })
        .await
    }

    pub async fn read_output(
        &self,
        output_id: String,
        cursor: Option<String>,
    ) -> Result<OutputReadResponse, AppError> {
        self.read_output_scoped(None, output_id, cursor).await
    }

    pub(super) async fn read_output_for_thread(
        &self,
        thread_id: String,
        output_id: String,
        cursor: Option<String>,
    ) -> Result<OutputReadResponse, AppError> {
        self.read_output_scoped(Some(thread_id), output_id, cursor)
            .await
    }

    async fn read_output_scoped(
        &self,
        thread_id: Option<String>,
        output_id: String,
        cursor: Option<String>,
    ) -> Result<OutputReadResponse, AppError> {
        validate_text("output id", &output_id, MAX_IDENTIFIER_BYTES)?;
        if output_id.chars().any(char::is_control) {
            return Err(AppError::Protocol(
                "output id contains control characters".into(),
            ));
        }
        let sequence = parse_output_cursor(cursor.as_deref())?;
        let pool = self.pool().await?;
        run_blocking(move || {
            let connection = pool.get().map_err(pool_error)?;
            let sequence_sql = i64::try_from(sequence).map_err(|error| {
                AppError::Protocol(format!("output cursor is too large: {error}"))
            })?;
            let metadata = connection
                .query_row(
                    "SELECT output_resources.byte_length
                     FROM output_resources
                     JOIN turns ON turns.id = output_resources.turn_id
                     WHERE output_resources.id = ?1
                       AND (?2 IS NULL OR turns.thread_id = ?2)",
                    params![output_id, thread_id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()
                .map_err(storage_error)?
                .ok_or_else(|| AppError::State("stored output does not exist".into()))?;
            let byte_length = u64::try_from(metadata)
                .map_err(|error| AppError::Storage(format!("invalid output size: {error}")))?;
            let chunk = connection
                .query_row(
                    "SELECT content FROM output_chunks
                     WHERE output_id = ?1 AND sequence = ?2",
                    params![output_id, sequence_sql],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(storage_error)?
                .ok_or_else(|| {
                    AppError::Protocol("output cursor is outside the resource".into())
                })?;
            let next_sequence = sequence_sql
                .checked_add(1)
                .ok_or_else(|| AppError::Storage("output sequence overflowed".into()))?;
            let has_more: bool = connection
                .query_row(
                    "SELECT EXISTS(
                         SELECT 1 FROM output_chunks
                         WHERE output_id = ?1 AND sequence = ?2
                     )",
                    params![output_id, next_sequence],
                    |row| row.get(0),
                )
                .map_err(storage_error)?;
            Ok(OutputReadResponse {
                output_id,
                chunk,
                byte_length,
                next_cursor: has_more.then(|| next_sequence.to_string()),
            })
        })
        .await
    }

    pub async fn read_thread_summary(&self, thread_id: String) -> Result<ThreadSummary, AppError> {
        let pool = self.pool().await?;
        run_blocking(move || {
            let connection = pool.get().map_err(pool_error)?;
            read_thread_header(&connection, &thread_id).map(ThreadHeader::into_summary)
        })
        .await
    }

    pub async fn set_thread_name(
        &self,
        thread_id: String,
        name: String,
    ) -> Result<ThreadSummary, AppError> {
        validate_text("thread name", &name, MAX_THREAD_NAME_BYTES)?;
        let pool = self.pool().await?;
        run_blocking(move || {
            let connection = pool.get().map_err(pool_error)?;
            let changed = connection
                .execute(
                    "UPDATE threads SET name = ?1, updated_at = ?2
                     WHERE id = ?3 AND archived = 0",
                    params![name, unix_timestamp()?, thread_id],
                )
                .map_err(storage_error)?;
            require_changed(changed, "thread")?;
            read_thread_header(&connection, &thread_id).map(ThreadHeader::into_summary)
        })
        .await
    }

    pub async fn archive_thread(&self, thread_id: String) -> Result<OperationAck, AppError> {
        let pool = self.pool().await?;
        run_blocking(move || {
            let connection = pool.get().map_err(pool_error)?;
            let transaction = connection
                .unchecked_transaction()
                .map_err(storage_error)?;
            let active: bool = transaction
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM turns WHERE thread_id = ?1 AND status = 'inProgress')",
                    [&thread_id],
                    |row| row.get(0),
                )
                .map_err(storage_error)?;
            if active {
                return Err(AppError::State(
                    "an active thread cannot be archived; interrupt its turn first".into(),
                ));
            }
            let changed = transaction
                .execute(
                    "UPDATE threads SET archived = 1, updated_at = ?1
                     WHERE id = ?2 AND archived = 0",
                    params![unix_timestamp()?, thread_id],
                )
                .map_err(storage_error)?;
            require_changed(changed, "thread")?;
            transaction.commit().map_err(storage_error)?;
            Ok(OperationAck { applied: true })
        })
        .await
    }

    pub async fn unarchive_thread(&self, thread_id: String) -> Result<StoredThreadPage, AppError> {
        let pool = self.pool().await?;
        run_blocking(move || {
            let connection = pool.get().map_err(pool_error)?;
            let changed = connection
                .execute(
                    "UPDATE threads SET archived = 0, updated_at = ?1
                     WHERE id = ?2 AND archived = 1",
                    params![unix_timestamp()?, thread_id],
                )
                .map_err(storage_error)?;
            require_changed(changed, "archived thread")?;
            load_thread_page(&connection, &thread_id, None)
        })
        .await
    }

    pub async fn delete_thread(&self, thread_id: String) -> Result<OperationAck, AppError> {
        self.delete_thread_with_active_owner(thread_id, None).await
    }

    pub async fn delete_owned_active_thread(
        &self,
        thread_id: String,
        turn_id: String,
    ) -> Result<OperationAck, AppError> {
        self.delete_thread_with_active_owner(thread_id, Some(turn_id))
            .await
    }

    async fn delete_thread_with_active_owner(
        &self,
        thread_id: String,
        active_turn_id: Option<String>,
    ) -> Result<OperationAck, AppError> {
        let pool = self.pool().await?;
        run_blocking(move || {
            let mut connection = pool.get().map_err(pool_error)?;
            let transaction = connection.transaction().map_err(storage_error)?;
            if let Some(active_turn_id) = active_turn_id {
                let owned: bool = transaction
                    .query_row(
                        "SELECT EXISTS(
                             SELECT 1 FROM turns
                             WHERE thread_id = ?1 AND id = ?2 AND status = 'inProgress'
                         )",
                        params![thread_id, active_turn_id],
                        |row| row.get(0),
                    )
                    .map_err(storage_error)?;
                if !owned {
                    return Err(AppError::State(
                        "active-turn ownership does not match the thread deletion request".into(),
                    ));
                }
            } else {
                let active: bool = transaction
                    .query_row(
                        "SELECT EXISTS(
                             SELECT 1 FROM turns
                             WHERE thread_id = ?1 AND status = 'inProgress'
                         )",
                        [&thread_id],
                        |row| row.get(0),
                    )
                    .map_err(storage_error)?;
                if active {
                    return Err(AppError::State(
                        "an active thread cannot be deleted by an idle-thread operation".into(),
                    ));
                }
            }
            let changed = transaction
                .execute("DELETE FROM threads WHERE id = ?1", [&thread_id])
                .map_err(storage_error)?;
            require_changed(changed, "thread")?;
            transaction.commit().map_err(storage_error)?;
            Ok(OperationAck { applied: true })
        })
        .await
    }

    pub async fn fork_thread(
        &self,
        source_thread_id: String,
    ) -> Result<StoredThreadPage, AppError> {
        let pool = self.pool().await?;
        run_blocking(move || {
            let mut connection = pool.get().map_err(pool_error)?;
            let transaction = connection.transaction().map_err(storage_error)?;
            let source = transaction
                .query_row(
                    "SELECT cwd, project_path, mode, name, preview
                     FROM threads
                     WHERE id = ?1",
                    [&source_thread_id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, Option<String>>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, Option<String>>(3)?,
                            row.get::<_, String>(4)?,
                        ))
                    },
                )
                .optional()
                .map_err(storage_error)?
                .ok_or_else(|| AppError::State("source thread does not exist".into()))?;
            let active: bool = transaction
                .query_row(
                    "SELECT EXISTS(
                         SELECT 1 FROM turns
                         WHERE thread_id = ?1 AND status = 'inProgress'
                     )",
                    [&source_thread_id],
                    |row| row.get(0),
                )
                .map_err(storage_error)?;
            if active {
                return Err(AppError::State(
                    "an active thread cannot be forked until its current turn completes".into(),
                ));
            }

            let fork_id = Uuid::now_v7().to_string();
            let now = unix_timestamp()?;
            transaction
                .execute(
                    "INSERT INTO threads
                         (id, cwd, project_path, mode, name, preview, archived, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?7)",
                    params![fork_id, source.0, source.1, source.2, source.3, source.4, now],
                )
                .map_err(storage_error)?;

            let source_turns = {
                let mut statement = transaction
                    .prepare(
                        "SELECT id, status, owner_id, model, reasoning_effort, error, created_at, updated_at
                         FROM turns
                         WHERE thread_id = ?1
                         ORDER BY created_at, id",
                    )
                    .map_err(storage_error)?;
                let rows = statement
                    .query_map([&source_thread_id], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, Option<String>>(4)?,
                            row.get::<_, Option<String>>(5)?,
                            row.get::<_, i64>(6)?,
                            row.get::<_, i64>(7)?,
                        ))
                    })
                    .map_err(storage_error)?;
                rows.collect::<Result<Vec<_>, _>>().map_err(storage_error)?
            };
            for (source_turn_id, status, owner_id, model, effort, error, created_at, updated_at) in
                source_turns
            {
                let fork_turn_id = Uuid::now_v7().to_string();
                transaction
                    .execute(
                        "INSERT INTO turns
                             (id, thread_id, owner_id, status, model, reasoning_effort, error, created_at, updated_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                        params![
                            fork_turn_id,
                            fork_id,
                            owner_id,
                            status,
                            model,
                            effort,
                            error,
                            created_at,
                            updated_at
                        ],
                    )
                    .map_err(storage_error)?;
                copy_thread_items_for_fork(&transaction, &source_turn_id, &fork_turn_id)?;
            }
            transaction
                .execute(
                    "INSERT INTO provider_items (thread_id, payload)
                     SELECT ?1, payload
                     FROM provider_items
                     WHERE thread_id = ?2
                     ORDER BY sequence",
                    params![fork_id, source_thread_id],
                )
                .map_err(storage_error)?;
            transaction
                .execute(
                    "INSERT INTO chat_conversations
                         (thread_id, conversation_id, parent_message_id, updated_at)
                     SELECT ?1, conversation_id, parent_message_id, ?3
                     FROM chat_conversations
                     WHERE thread_id = ?2",
                    params![fork_id, source_thread_id, now],
                )
                .map_err(storage_error)?;
            transaction.commit().map_err(storage_error)?;
            load_thread_page(&connection, &fork_id, None)
        })
        .await
    }

    pub async fn begin_chat_turn(
        &self,
        thread_id: String,
        model: String,
        thinking_effort: Option<String>,
        user_item: ThreadItem,
        preview: String,
    ) -> Result<TurnSummary, AppError> {
        validate_user_item(&user_item)?;
        let item_id = user_item.id().to_string();
        let item_payload = encode_bounded(&user_item, MAX_ITEM_BYTES, "ChatGPT thread item")?;
        let preview = truncate_utf8(preview.trim(), MAX_PREVIEW_BYTES);
        let owner_id = self.owner_id.clone();
        let pool = self.pool().await?;
        run_blocking(move || {
            let mut connection = pool.get().map_err(pool_error)?;
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(storage_error)?;
            require_available_thread(&transaction, &thread_id)?;
            let mode: String = transaction
                .query_row(
                    "SELECT mode FROM threads WHERE id = ?1",
                    [&thread_id],
                    |row| row.get(0),
                )
                .map_err(storage_error)?;
            if mode != ConversationMode::Chat.as_str() {
                return Err(AppError::State(
                    "a ChatGPT consumer turn requires a Chat thread".into(),
                ));
            }
            let active: bool = transaction
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM turns WHERE thread_id = ?1 AND status = 'inProgress')",
                    [&thread_id],
                    |row| row.get(0),
                )
                .map_err(storage_error)?;
            if active {
                return Err(AppError::State("the thread already has an active turn".into()));
            }
            let turn_id = Uuid::now_v7().to_string();
            let now = unix_timestamp()?;
            transaction
                .execute(
                    "INSERT INTO turns
                         (id, thread_id, owner_id, status, model, reasoning_effort, error, created_at, updated_at)
                     VALUES (?1, ?2, ?3, 'inProgress', ?4, ?5, NULL, ?6, ?6)",
                    params![turn_id, thread_id, owner_id, model, thinking_effort, now],
                )
                .map_err(storage_error)?;
            transaction
                .execute(
                    "INSERT INTO thread_items (turn_id, item_id, payload) VALUES (?1, ?2, ?3)",
                    params![turn_id, item_id, item_payload],
                )
                .map_err(storage_error)?;
            transaction
                .execute(
                    "UPDATE threads
                     SET preview = CASE WHEN preview = '' THEN ?1 ELSE preview END,
                         updated_at = ?2
                     WHERE id = ?3",
                    params![preview, now, thread_id],
                )
                .map_err(storage_error)?;
            transaction.commit().map_err(storage_error)?;
            Ok(TurnSummary {
                id: turn_id,
                status: TurnStatus::InProgress,
                created_at: now,
                updated_at: now,
            })
        })
        .await
    }

    pub async fn chat_conversation_state(
        &self,
        thread_id: String,
    ) -> Result<ChatConversationState, AppError> {
        let pool = self.pool().await?;
        run_blocking(move || {
            let connection = pool.get().map_err(pool_error)?;
            let thread_mode = connection
                .query_row(
                    "SELECT mode FROM threads WHERE id = ?1 AND archived = 0",
                    [&thread_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(storage_error)?
                .ok_or_else(|| AppError::State("thread does not exist or is archived".into()))?;
            if thread_mode != ConversationMode::Chat.as_str() {
                return Err(AppError::State(
                    "ChatGPT conversation state belongs only to Chat threads".into(),
                ));
            }
            connection
                .query_row(
                    "SELECT conversation_id, parent_message_id
                     FROM chat_conversations WHERE thread_id = ?1",
                    [&thread_id],
                    |row| {
                        Ok(ChatConversationState {
                            conversation_id: row.get(0)?,
                            parent_message_id: row.get(1)?,
                        })
                    },
                )
                .optional()
                .map(|state| state.unwrap_or_default())
                .map_err(storage_error)
        })
        .await
    }

    pub async fn update_chat_conversation_state(
        &self,
        thread_id: String,
        conversation_id: String,
        parent_message_id: String,
    ) -> Result<(), AppError> {
        validate_text(
            "ChatGPT conversation id",
            &conversation_id,
            MAX_IDENTIFIER_BYTES,
        )?;
        validate_text(
            "ChatGPT parent message id",
            &parent_message_id,
            MAX_IDENTIFIER_BYTES,
        )?;
        let pool = self.pool().await?;
        run_blocking(move || {
            let mut connection = pool.get().map_err(pool_error)?;
            let transaction = connection.transaction().map_err(storage_error)?;
            let available: bool = transaction
                .query_row(
                    "SELECT EXISTS(
                         SELECT 1 FROM threads
                         WHERE id = ?1 AND archived = 0 AND mode = 'chat'
                     )",
                    [&thread_id],
                    |row| row.get(0),
                )
                .map_err(storage_error)?;
            if !available {
                return Err(AppError::State(
                    "ChatGPT conversation state requires an available Chat thread".into(),
                ));
            }
            transaction
                .execute(
                    "INSERT INTO chat_conversations
                         (thread_id, conversation_id, parent_message_id, updated_at)
                     VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT(thread_id) DO UPDATE SET
                         conversation_id = excluded.conversation_id,
                         parent_message_id = excluded.parent_message_id,
                         updated_at = excluded.updated_at",
                    params![
                        thread_id,
                        conversation_id,
                        parent_message_id,
                        unix_timestamp()?
                    ],
                )
                .map_err(storage_error)?;
            transaction.commit().map_err(storage_error)
        })
        .await
    }

    pub async fn begin_turn(
        &self,
        thread_id: String,
        model: String,
        reasoning_effort: Option<String>,
        user_item: ThreadItem,
        provider_item: ResponseItem,
        preview: String,
    ) -> Result<TurnSummary, AppError> {
        validate_user_item(&user_item)?;
        let item_id = user_item.id().to_string();
        let item_payload = encode_bounded(&user_item, MAX_ITEM_BYTES, "thread item")?;
        let provider_payload = encode_bounded(&provider_item, MAX_ITEM_BYTES, "provider item")?;
        let preview = truncate_utf8(preview.trim(), MAX_PREVIEW_BYTES);
        let owner_id = self.owner_id.clone();
        let pool = self.pool().await?;
        run_blocking(move || {
            let mut connection = pool.get().map_err(pool_error)?;
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(storage_error)?;
            require_available_thread(&transaction, &thread_id)?;
            let active: bool = transaction
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM turns WHERE thread_id = ?1 AND status = 'inProgress')",
                    [&thread_id],
                    |row| row.get(0),
                )
                .map_err(storage_error)?;
            if active {
                return Err(AppError::State("the thread already has an active turn".into()));
            }
            let turn_id = Uuid::now_v7().to_string();
            let now = unix_timestamp()?;
            transaction
                .execute(
                    "INSERT INTO turns
                         (id, thread_id, owner_id, status, model, reasoning_effort, error, created_at, updated_at)
                     VALUES (?1, ?2, ?3, 'inProgress', ?4, ?5, NULL, ?6, ?6)",
                    params![turn_id, thread_id, owner_id, model, reasoning_effort, now],
                )
                .map_err(storage_error)?;
            transaction
                .execute(
                    "INSERT INTO thread_items (turn_id, item_id, payload) VALUES (?1, ?2, ?3)",
                    params![turn_id, item_id, item_payload],
                )
                .map_err(storage_error)?;
            transaction
                .execute(
                    "INSERT INTO provider_items (thread_id, payload) VALUES (?1, ?2)",
                    params![thread_id, provider_payload],
                )
                .map_err(storage_error)?;
            transaction
                .execute(
                    "UPDATE threads
                     SET preview = CASE WHEN preview = '' THEN ?1 ELSE preview END,
                         updated_at = ?2
                     WHERE id = ?3",
                    params![preview, now, thread_id],
                )
                .map_err(storage_error)?;
            transaction.commit().map_err(storage_error)?;
            Ok(TurnSummary {
                id: turn_id,
                status: TurnStatus::InProgress,
                created_at: now,
                updated_at: now,
            })
        })
        .await
    }

    pub async fn begin_compaction_turn(
        &self,
        thread_id: String,
        model: String,
        reasoning_effort: Option<String>,
    ) -> Result<TurnSummary, AppError> {
        let owner_id = self.owner_id.clone();
        let pool = self.pool().await?;
        run_blocking(move || {
            let mut connection = pool.get().map_err(pool_error)?;
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(storage_error)?;
            require_available_thread(&transaction, &thread_id)?;
            let active: bool = transaction
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM turns WHERE thread_id = ?1 AND status = 'inProgress')",
                    [&thread_id],
                    |row| row.get(0),
                )
                .map_err(storage_error)?;
            if active {
                return Err(AppError::State("the thread already has an active turn".into()));
            }
            let turn_id = Uuid::now_v7().to_string();
            let now = unix_timestamp()?;
            transaction
                .execute(
                    "INSERT INTO turns
                         (id, thread_id, owner_id, status, model, reasoning_effort, error, created_at, updated_at)
                     VALUES (?1, ?2, ?3, 'inProgress', ?4, ?5, NULL, ?6, ?6)",
                    params![turn_id, thread_id, owner_id, model, reasoning_effort, now],
                )
                .map_err(storage_error)?;
            transaction
                .execute(
                    "UPDATE threads SET updated_at = ?1 WHERE id = ?2",
                    params![now, thread_id],
                )
                .map_err(storage_error)?;
            transaction.commit().map_err(storage_error)?;
            Ok(TurnSummary {
                id: turn_id,
                status: TurnStatus::InProgress,
                created_at: now,
                updated_at: now,
            })
        })
        .await
    }

    pub async fn append_thread_item(
        &self,
        turn_id: String,
        mut item: ThreadItem,
        output: Option<OutputSource>,
    ) -> Result<ThreadItem, AppError> {
        let item_id = item.id().to_string();
        prepare_thread_item_output(&mut item, output.as_ref())?;
        let payload = encode_bounded(&item, MAX_ITEM_BYTES, "thread item")?;
        let pool = self.pool().await?;
        run_blocking(move || {
            let mut connection = pool.get().map_err(pool_error)?;
            let transaction = connection.transaction().map_err(storage_error)?;
            transaction
                .execute(
                    "INSERT INTO thread_items (turn_id, item_id, payload) VALUES (?1, ?2, ?3)",
                    params![&turn_id, &item_id, payload],
                )
                .map_err(storage_error)?;
            if let Some(output) = output {
                persist_output_source(&transaction, &turn_id, &item_id, output)?;
            }
            transaction.commit().map_err(storage_error)?;
            Ok(item)
        })
        .await
    }

    pub async fn append_turn_input(
        &self,
        thread_id: String,
        turn_id: String,
        user_item: ThreadItem,
        provider_item: ResponseItem,
    ) -> Result<(), AppError> {
        validate_user_item(&user_item)?;
        let item_id = user_item.id().to_string();
        let item_payload = encode_bounded(&user_item, MAX_ITEM_BYTES, "steered thread item")?;
        let provider_payload =
            encode_bounded(&provider_item, MAX_ITEM_BYTES, "steered provider item")?;
        let pool = self.pool().await?;
        run_blocking(move || {
            let mut connection = pool.get().map_err(pool_error)?;
            let transaction = connection.transaction().map_err(storage_error)?;
            let active: bool = transaction
                .query_row(
                    "SELECT EXISTS(
                         SELECT 1
                         FROM turns
                         JOIN threads ON threads.id = turns.thread_id
                         WHERE turns.id = ?1
                           AND turns.thread_id = ?2
                           AND turns.status = 'inProgress'
                           AND threads.archived = 0
                     )",
                    params![turn_id, thread_id],
                    |row| row.get(0),
                )
                .map_err(storage_error)?;
            if !active {
                return Err(AppError::State(
                    "turn is no longer active or does not belong to the thread".into(),
                ));
            }
            transaction
                .execute(
                    "INSERT INTO thread_items (turn_id, item_id, payload) VALUES (?1, ?2, ?3)",
                    params![turn_id, item_id, item_payload],
                )
                .map_err(storage_error)?;
            transaction
                .execute(
                    "INSERT INTO provider_items (thread_id, payload) VALUES (?1, ?2)",
                    params![thread_id, provider_payload],
                )
                .map_err(storage_error)?;
            transaction
                .execute(
                    "UPDATE threads SET updated_at = ?1 WHERE id = ?2",
                    params![unix_timestamp()?, thread_id],
                )
                .map_err(storage_error)?;
            transaction.commit().map_err(storage_error)
        })
        .await
    }

    pub async fn append_provider_item(
        &self,
        thread_id: String,
        item: &ResponseItem,
    ) -> Result<(), AppError> {
        let payload = encode_bounded(&item, MAX_ITEM_BYTES, "provider item")?;
        let pool = self.pool().await?;
        run_blocking(move || {
            let connection = pool.get().map_err(pool_error)?;
            connection
                .execute(
                    "INSERT INTO provider_items (thread_id, payload) VALUES (?1, ?2)",
                    params![thread_id, payload],
                )
                .map_err(storage_error)?;
            Ok(())
        })
        .await
    }

    pub async fn append_provider_and_thread_item(
        &self,
        thread_id: String,
        turn_id: String,
        provider_item: &ResponseItem,
        mut thread_item: ThreadItem,
        output: Option<OutputSource>,
    ) -> Result<ThreadItem, AppError> {
        let item_id = thread_item.id().to_string();
        prepare_thread_item_output(&mut thread_item, output.as_ref())?;
        let provider_payload = encode_bounded(provider_item, MAX_ITEM_BYTES, "provider item")?;
        let thread_payload = encode_bounded(&thread_item, MAX_ITEM_BYTES, "thread item")?;
        let pool = self.pool().await?;
        run_blocking(move || {
            let mut connection = pool.get().map_err(pool_error)?;
            let transaction = connection.transaction().map_err(storage_error)?;
            transaction
                .execute(
                    "INSERT INTO provider_items (thread_id, payload) VALUES (?1, ?2)",
                    params![&thread_id, provider_payload],
                )
                .map_err(storage_error)?;
            transaction
                .execute(
                    "INSERT INTO thread_items (turn_id, item_id, payload) VALUES (?1, ?2, ?3)",
                    params![&turn_id, &item_id, thread_payload],
                )
                .map_err(storage_error)?;
            if let Some(output) = output {
                persist_output_source(&transaction, &turn_id, &item_id, output)?;
            }
            transaction.commit().map_err(storage_error)?;
            Ok(thread_item)
        })
        .await
    }

    #[cfg(test)]
    pub async fn provider_history(&self, thread_id: String) -> Result<Vec<ResponseItem>, AppError> {
        Ok(self.provider_history_snapshot(thread_id).await?.items)
    }

    pub(super) async fn provider_history_snapshot(
        &self,
        thread_id: String,
    ) -> Result<ProviderHistorySnapshot, AppError> {
        let pool = self.pool().await?;
        run_blocking(move || {
            let connection = pool.get().map_err(pool_error)?;
            require_readable_thread(&connection, &thread_id)?;
            let page = read_provider_history_page(&connection, &thread_id, 0)?;
            Ok(ProviderHistorySnapshot {
                items: page.items,
                encoded_bytes: page.encoded_bytes,
                last_sequence: page.last_sequence,
            })
        })
        .await
    }

    pub(super) async fn refresh_provider_history(
        &self,
        thread_id: String,
        snapshot: &mut ProviderHistorySnapshot,
    ) -> Result<(), AppError> {
        let pool = self.pool().await?;
        let after_sequence = snapshot.last_sequence;
        let page = run_blocking(move || {
            let connection = pool.get().map_err(pool_error)?;
            require_readable_thread(&connection, &thread_id)?;
            read_provider_history_page(&connection, &thread_id, after_sequence)
        })
        .await?;
        snapshot.extend(page)
    }

    pub async fn replace_provider_history(
        &self,
        thread_id: String,
        items: Vec<ResponseItem>,
    ) -> Result<(), AppError> {
        let payloads = encode_provider_history(items)?;
        let pool = self.pool().await?;
        run_blocking(move || {
            let mut connection = pool.get().map_err(pool_error)?;
            let transaction = connection.transaction().map_err(storage_error)?;
            let exists: bool = transaction
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM threads WHERE id = ?1 AND archived = 0)",
                    [&thread_id],
                    |row| row.get(0),
                )
                .map_err(storage_error)?;
            if !exists {
                return Err(AppError::State(
                    "thread does not exist or is archived".into(),
                ));
            }
            replace_provider_history_rows(&transaction, &thread_id, &payloads)?;
            transaction.commit().map_err(storage_error)
        })
        .await
    }

    pub async fn install_compacted_history(
        &self,
        thread_id: String,
        turn_id: String,
        items: Vec<ResponseItem>,
        compaction_id: String,
    ) -> Result<(), AppError> {
        let payloads = encode_provider_history(items)?;
        let compaction_item = ThreadItem::ContextCompaction {
            id: compaction_id.clone(),
        };
        let compaction_payload =
            encode_bounded(&compaction_item, MAX_ITEM_BYTES, "context compaction item")?;
        let pool = self.pool().await?;
        run_blocking(move || {
            let mut connection = pool.get().map_err(pool_error)?;
            let transaction = connection.transaction().map_err(storage_error)?;
            let active: bool = transaction
                .query_row(
                    "SELECT EXISTS(
                         SELECT 1
                         FROM turns
                         JOIN threads ON threads.id = turns.thread_id
                         WHERE turns.id = ?1
                           AND turns.thread_id = ?2
                           AND turns.status = 'inProgress'
                           AND threads.archived = 0
                     )",
                    params![turn_id, thread_id],
                    |row| row.get(0),
                )
                .map_err(storage_error)?;
            if !active {
                return Err(AppError::State(
                    "turn is no longer active or does not belong to the thread".into(),
                ));
            }

            replace_provider_history_rows(&transaction, &thread_id, &payloads)?;
            transaction
                .execute(
                    "INSERT INTO thread_items (turn_id, item_id, payload) VALUES (?1, ?2, ?3)",
                    params![turn_id, compaction_id, compaction_payload],
                )
                .map_err(storage_error)?;
            transaction
                .execute(
                    "UPDATE threads SET updated_at = ?1 WHERE id = ?2",
                    params![unix_timestamp()?, thread_id],
                )
                .map_err(storage_error)?;
            transaction.commit().map_err(storage_error)
        })
        .await
    }

    pub async fn latest_context_usage(
        &self,
        thread_id: String,
    ) -> Result<Option<ContextUsageSnapshot>, AppError> {
        let pool = self.pool().await?;
        run_blocking(move || {
            let connection = pool.get().map_err(pool_error)?;
            let exists: bool = connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM threads WHERE id = ?1 AND archived = 0)",
                    [&thread_id],
                    |row| row.get(0),
                )
                .map_err(storage_error)?;
            if !exists {
                return Err(AppError::State(
                    "thread does not exist or is archived".into(),
                ));
            }
            let payload = connection
                .query_row(
                    "SELECT thread_items.payload
                     FROM thread_items
                     JOIN turns ON turns.id = thread_items.turn_id
                     WHERE turns.thread_id = ?1
                       AND json_extract(thread_items.payload, '$.type') IN (
                           'contextUsage',
                           'contextCompaction'
                       )
                     ORDER BY thread_items.sequence DESC
                     LIMIT 1",
                    [thread_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(storage_error)?;
            let Some(payload) = payload else {
                return Ok(None);
            };
            match decode_bounded::<ThreadItem>(&payload, MAX_ITEM_BYTES, "context usage")? {
                ThreadItem::ContextUsage { model, usage, .. } => {
                    Ok(Some(ContextUsageSnapshot { model, usage }))
                }
                ThreadItem::ContextCompaction { .. } => Ok(None),
                _ => Err(AppError::Storage(
                    "context-state query returned a different item type".into(),
                )),
            }
        })
        .await
    }

    pub async fn complete_turn(
        &self,
        thread_id: String,
        turn_id: String,
        status: TurnStatus,
        error: Option<String>,
    ) -> Result<CompletedTurn, AppError> {
        if status == TurnStatus::InProgress {
            return Err(AppError::State(
                "complete_turn cannot preserve an in-progress status".into(),
            ));
        }
        let pool = self.pool().await?;
        run_blocking(move || {
            let mut connection = pool.get().map_err(pool_error)?;
            let transaction = connection.transaction().map_err(storage_error)?;
            let now = unix_timestamp()?;
            let changed = transaction
                .execute(
                    "UPDATE turns SET status = ?1, error = ?2, updated_at = ?3
                     WHERE id = ?4 AND thread_id = ?5 AND status = 'inProgress'",
                    params![
                        status_name(status),
                        error.as_deref(),
                        now,
                        turn_id,
                        thread_id
                    ],
                )
                .map_err(storage_error)?;
            require_changed(changed, "active turn")?;
            transaction
                .execute(
                    "UPDATE threads SET updated_at = ?1 WHERE id = ?2",
                    params![now, thread_id],
                )
                .map_err(storage_error)?;
            transaction.commit().map_err(storage_error)?;
            Ok(CompletedTurn {
                id: turn_id,
                status,
                error,
                updated_at: now,
            })
        })
        .await
    }

    pub async fn read_config(&self) -> Result<ConfigReadResponse, AppError> {
        let pool = self.pool().await?;
        run_blocking(move || {
            let connection = pool.get().map_err(pool_error)?;
            let (version, payload): (i64, String) = connection
                .query_row(
                    "SELECT version, payload FROM app_config WHERE singleton = 1",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(storage_error)?;
            let version = u64::try_from(version)
                .map_err(|error| AppError::Storage(format!("invalid config version: {error}")))?;
            let config = decode_bounded(&payload, MAX_ITEM_BYTES, "config")?;
            validate_config(&config)?;
            Ok(ConfigReadResponse { config, version })
        })
        .await
    }

    pub async fn update_config(
        &self,
        expected_version: u64,
        update: ConfigUpdate,
    ) -> Result<ConfigUpdateResponse, AppError> {
        let pool = self.pool().await?;
        run_blocking(move || {
            let mut connection = pool.get().map_err(pool_error)?;
            let transaction = connection.transaction().map_err(storage_error)?;
            let (current_version, payload): (i64, String) = transaction
                .query_row(
                    "SELECT version, payload FROM app_config WHERE singleton = 1",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(storage_error)?;
            let current_version = u64::try_from(current_version)
                .map_err(|error| AppError::Storage(format!("invalid config version: {error}")))?;
            if current_version != expected_version {
                return Err(AppError::State(format!(
                    "configuration version changed from {expected_version} to {current_version}"
                )));
            }
            let mut config: AppConfig = decode_bounded(&payload, MAX_ITEM_BYTES, "config")?;
            apply_config_update(&mut config, update)?;
            validate_config(&config)?;
            let version = current_version
                .checked_add(1)
                .ok_or_else(|| AppError::Storage("configuration version overflow".into()))?;
            let payload = encode_bounded(&config, MAX_ITEM_BYTES, "config")?;
            let version_sql = i64::try_from(version)
                .map_err(|error| AppError::Storage(format!("config version overflow: {error}")))?;
            transaction
                .execute(
                    "UPDATE app_config SET version = ?1, payload = ?2 WHERE singleton = 1",
                    params![version_sql, payload],
                )
                .map_err(storage_error)?;
            transaction.commit().map_err(storage_error)?;
            Ok(ConfigUpdateResponse { config, version })
        })
        .await
    }

    async fn pool(&self) -> Result<SqlitePool, AppError> {
        self.database
            .read()
            .await
            .as_ref()
            .map(|database| database.pool.clone())
            .ok_or_else(|| AppError::Storage("native storage is not initialized".into()))
    }
}

fn encode_provider_history(items: Vec<ResponseItem>) -> Result<Vec<String>, AppError> {
    if items.is_empty() || items.len() > MAX_HISTORY_ITEMS {
        return Err(AppError::Provider(format!(
            "provider history must contain between 1 and {MAX_HISTORY_ITEMS} items"
        )));
    }
    let mut total_bytes = 0usize;
    let mut payloads = Vec::with_capacity(items.len());
    for item in items {
        let payload = encode_bounded(&item, MAX_ITEM_BYTES, "provider history item")?;
        total_bytes = total_bytes
            .checked_add(payload.len())
            .ok_or_else(|| AppError::Provider("provider history size overflowed".into()))?;
        if total_bytes > MAX_HISTORY_BYTES {
            return Err(AppError::Provider(format!(
                "provider history exceeds {MAX_HISTORY_BYTES} bytes"
            )));
        }
        payloads.push(payload);
    }
    Ok(payloads)
}

fn replace_provider_history_rows(
    transaction: &Transaction<'_>,
    thread_id: &str,
    payloads: &[String],
) -> Result<(), AppError> {
    transaction
        .execute(
            "DELETE FROM provider_items WHERE thread_id = ?1",
            [thread_id],
        )
        .map_err(storage_error)?;
    for payload in payloads {
        transaction
            .execute(
                "INSERT INTO provider_items (thread_id, payload) VALUES (?1, ?2)",
                params![thread_id, payload],
            )
            .map_err(storage_error)?;
    }
    Ok(())
}

fn require_readable_thread(connection: &Connection, thread_id: &str) -> Result<(), AppError> {
    let exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM threads WHERE id = ?1 AND archived = 0)",
            [thread_id],
            |row| row.get(0),
        )
        .map_err(storage_error)?;
    if exists {
        Ok(())
    } else {
        Err(AppError::State(
            "thread does not exist or is archived".into(),
        ))
    }
}

fn read_provider_history_page(
    connection: &Connection,
    thread_id: &str,
    after_sequence: i64,
) -> Result<ProviderHistoryPage, AppError> {
    let mut statement = connection
        .prepare(
            "SELECT sequence, payload
             FROM provider_items
             WHERE thread_id = ?1 AND sequence > ?2
             ORDER BY sequence",
        )
        .map_err(storage_error)?;
    let rows = statement
        .query_map(params![thread_id, after_sequence], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(storage_error)?;
    let mut page = ProviderHistoryPage {
        items: Vec::new(),
        encoded_bytes: 0,
        last_sequence: after_sequence,
    };
    for row in rows {
        let (sequence, payload) = row.map_err(storage_error)?;
        page.encoded_bytes = page
            .encoded_bytes
            .checked_add(payload.len())
            .ok_or_else(|| AppError::Storage("stored provider history size overflow".into()))?;
        if page.encoded_bytes > MAX_HISTORY_BYTES {
            return Err(AppError::Storage(format!(
                "stored provider history exceeds {MAX_HISTORY_BYTES} bytes"
            )));
        }
        if page.items.len() >= MAX_HISTORY_ITEMS {
            return Err(AppError::Storage(format!(
                "stored provider history exceeds {MAX_HISTORY_ITEMS} items"
            )));
        }
        page.items.push(decode_bounded(
            &payload,
            MAX_ITEM_BYTES,
            "provider history",
        )?);
        page.last_sequence = sequence;
    }
    Ok(page)
}

impl ThreadItem {
    pub fn id(&self) -> &str {
        match self {
            Self::ContextUsage { id, .. }
            | Self::ContextCompaction { id }
            | Self::UserMessage { id, .. }
            | Self::AgentMessage { id, .. }
            | Self::Reasoning { id, .. }
            | Self::Plan { id, .. }
            | Self::CommandExecution { id, .. }
            | Self::FileChange { id, .. }
            | Self::ToolExecution { id, .. } => id,
        }
    }
}

#[derive(Debug)]
struct ThreadHeader {
    id: String,
    cwd: String,
    project_path: Option<String>,
    mode: ConversationMode,
    name: Option<String>,
    preview: String,
    created_at: i64,
    updated_at: i64,
    active: bool,
}

impl ThreadHeader {
    fn into_summary(self) -> ThreadSummary {
        ThreadSummary {
            id: self.id,
            mode: self.mode,
            preview: self.preview,
            name: self.name,
            cwd: self.cwd,
            project_path: self.project_path,
            created_at: self.created_at,
            updated_at: self.updated_at,
            recency_at: Some(self.updated_at),
            status: if self.active {
                ThreadStatus::Active {
                    active_flags: Vec::<ThreadActiveFlag>::new(),
                }
            } else {
                ThreadStatus::Idle
            },
        }
    }
}

fn read_thread_header(connection: &Connection, thread_id: &str) -> Result<ThreadHeader, AppError> {
    connection
        .query_row(
            "SELECT id, cwd, project_path, mode, name, preview, created_at, updated_at,
                    EXISTS(SELECT 1 FROM turns WHERE thread_id = threads.id AND status = 'inProgress')
             FROM threads WHERE id = ?1 AND archived = 0",
            [thread_id],
            |row| {
                Ok(ThreadHeader {
                    id: row.get(0)?,
                    cwd: row.get(1)?,
                    project_path: row.get(2)?,
                    mode: parse_conversation_mode(&row.get::<_, String>(3)?)?,
                    name: row.get(4)?,
                    preview: row.get(5)?,
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                    active: row.get(8)?,
                })
            },
        )
        .optional()
        .map_err(storage_error)?
        .ok_or_else(|| AppError::State("thread does not exist or is archived".into()))
}

fn require_available_thread(
    transaction: &Transaction<'_>,
    thread_id: &str,
) -> Result<(), AppError> {
    let exists: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM threads WHERE id = ?1 AND archived = 0)",
            [thread_id],
            |row| row.get(0),
        )
        .map_err(storage_error)?;
    if exists {
        Ok(())
    } else {
        Err(AppError::State(
            "thread does not exist or is archived".into(),
        ))
    }
}

fn apply_config_update(config: &mut AppConfig, update: ConfigUpdate) -> Result<(), AppError> {
    match update {
        ConfigUpdate::ModelDefaults { value } => {
            let model = validate_optional_id("model", value.model)?;
            let service_tier = validate_optional_id("service tier", value.service_tier)?;
            config.model = model;
            config.model_reasoning_effort = value.reasoning_effort;
            config.service_tier = service_tier;
        }
        ConfigUpdate::PermissionProfile { value } => config.permission_profile = value,
        ConfigUpdate::WebSearch { value } => config.web_search = value,
        ConfigUpdate::ModelVerbosity { value } => config.model_verbosity = value,
        ConfigUpdate::Personality { value } => config.personality = value,
        ConfigUpdate::DeveloperInstructions { value } => {
            config.developer_instructions = value
                .map(|value| {
                    let value = value.trim().to_string();
                    if value.is_empty() || value.len() > MAX_DEVELOPER_INSTRUCTIONS_BYTES {
                        return Err(AppError::Protocol(format!(
                            "developer instructions must contain between 1 and {MAX_DEVELOPER_INSTRUCTIONS_BYTES} bytes"
                        )));
                    }
                    Ok(value)
                })
                .transpose()?;
        }
        ConfigUpdate::Desktop { value } => config.desktop = value,
    }
    Ok(())
}

fn validate_config(config: &AppConfig) -> Result<(), AppError> {
    if !config.permission_profile.is_supported() {
        return Err(AppError::Protocol(
            "permission profile is not one of the supported presets".into(),
        ));
    }
    validate_desktop(&config.desktop)?;
    if let Some(model) = config.model.as_deref() {
        validate_text("model", model, MAX_IDENTIFIER_BYTES)?;
    }
    if let Some(tier) = config.service_tier.as_deref() {
        validate_text("service tier", tier, MAX_IDENTIFIER_BYTES)?;
    }
    if config
        .developer_instructions
        .as_ref()
        .is_some_and(|value| value.is_empty() || value.len() > MAX_DEVELOPER_INSTRUCTIONS_BYTES)
    {
        return Err(AppError::Protocol("invalid developer instructions".into()));
    }
    Ok(())
}

fn validate_desktop(preferences: &DesktopPreferences) -> Result<(), AppError> {
    if !(12..=24).contains(&preferences.ui_font_size) {
        return Err(AppError::Protocol(
            "UI font size must be between 12 and 24".into(),
        ));
    }
    Ok(())
}

fn validate_optional_id(label: &str, value: Option<String>) -> Result<Option<String>, AppError> {
    value
        .map(|value| {
            let value = value.trim().to_string();
            validate_text(label, &value, MAX_IDENTIFIER_BYTES)?;
            Ok(value)
        })
        .transpose()
}

fn validate_text(label: &str, value: &str, maximum_bytes: usize) -> Result<(), AppError> {
    if value.trim().is_empty() || value.len() > maximum_bytes {
        return Err(AppError::Protocol(format!(
            "{label} must contain between 1 and {maximum_bytes} bytes"
        )));
    }
    Ok(())
}

fn validate_user_item(item: &ThreadItem) -> Result<(), AppError> {
    let ThreadItem::UserMessage { id, content } = item else {
        return Err(AppError::State(
            "a turn must begin with a user message item".into(),
        ));
    };
    validate_text("user message id", id, MAX_IDENTIFIER_BYTES)?;
    if id.chars().any(char::is_control) {
        return Err(AppError::Protocol(
            "user message id contains control characters".into(),
        ));
    }
    if content.is_empty() {
        return Err(AppError::Protocol(
            "a turn cannot begin with an empty user message".into(),
        ));
    }
    Ok(())
}

fn copy_thread_items_for_fork(
    transaction: &Transaction<'_>,
    source_turn_id: &str,
    fork_turn_id: &str,
) -> Result<(), AppError> {
    let rows = {
        let mut statement = transaction
            .prepare(
                "SELECT item_id, payload FROM thread_items
                 WHERE turn_id = ?1 ORDER BY sequence",
            )
            .map_err(storage_error)?;
        statement
            .query_map([source_turn_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(storage_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(storage_error)?
    };

    for (item_id, payload) in rows {
        let mut item: ThreadItem = decode_bounded(&payload, MAX_ITEM_BYTES, "forked thread item")?;
        let copied_output = thread_item_output_mut(&mut item)
            .and_then(Option::as_mut)
            .map(|reference| {
                let source_id = reference.id.clone();
                reference.id = Uuid::now_v7().to_string();
                (source_id, reference.clone())
            });
        let payload = encode_bounded(&item, MAX_ITEM_BYTES, "forked thread item")?;
        transaction
            .execute(
                "INSERT INTO thread_items (turn_id, item_id, payload) VALUES (?1, ?2, ?3)",
                params![fork_turn_id, item_id, payload],
            )
            .map_err(storage_error)?;

        let Some((source_output_id, target)) = copied_output else {
            continue;
        };
        let byte_length = i64::try_from(target.byte_length)
            .map_err(|error| AppError::Storage(format!("output size overflow: {error}")))?;
        let changed = transaction
            .execute(
                "INSERT INTO output_resources (id, turn_id, item_id, byte_length)
                 SELECT ?1, ?2, ?3, byte_length
                 FROM output_resources
                 WHERE id = ?4 AND turn_id = ?5 AND item_id = ?3 AND byte_length = ?6",
                params![
                    target.id,
                    fork_turn_id,
                    item_id,
                    source_output_id,
                    source_turn_id,
                    byte_length
                ],
            )
            .map_err(storage_error)?;
        require_changed(changed, "forked output resource")?;
        transaction
            .execute(
                "INSERT INTO output_chunks (output_id, sequence, content)
                 SELECT ?1, sequence, content FROM output_chunks
                 WHERE output_id = ?2 ORDER BY sequence",
                params![target.id, source_output_id],
            )
            .map_err(storage_error)?;
    }
    Ok(())
}

fn thread_item_output_mut(item: &mut ThreadItem) -> Option<&mut Option<ThreadOutput>> {
    match item {
        ThreadItem::CommandExecution {
            aggregated_output, ..
        } => Some(aggregated_output),
        ThreadItem::ToolExecution { output, .. } => Some(output),
        _ => None,
    }
}

fn prepare_thread_item_output(
    item: &mut ThreadItem,
    output: Option<&OutputSource>,
) -> Result<(), AppError> {
    let target = thread_item_output_mut(item);
    match (target, output) {
        (Some(target), Some(output)) if target.is_none() => {
            *target = Some(output.reference());
            Ok(())
        }
        (Some(_), Some(_)) => Err(AppError::State(
            "thread item already contains an output reference".into(),
        )),
        (Some(target), None) if target.is_none() => Ok(()),
        (Some(_), None) => Err(AppError::State(
            "thread item output reference has no stored source".into(),
        )),
        (None, Some(_)) => Err(AppError::State(
            "this thread item type cannot own stored output".into(),
        )),
        (None, None) => Ok(()),
    }
}

fn persist_output_source(
    transaction: &Transaction<'_>,
    turn_id: &str,
    item_id: &str,
    source: OutputSource,
) -> Result<(), AppError> {
    let reference = source.reference();
    let byte_length = i64::try_from(reference.byte_length)
        .map_err(|error| AppError::Storage(format!("output size overflow: {error}")))?;
    transaction
        .execute(
            "INSERT INTO output_resources (id, turn_id, item_id, byte_length)
             VALUES (?1, ?2, ?3, ?4)",
            params![reference.id, turn_id, item_id, byte_length],
        )
        .map_err(storage_error)?;

    let mut reader = source
        .into_reader()
        .map_err(|error| AppError::Storage(format!("could not open output source: {error}")))?;
    let mut pending = Vec::with_capacity(OUTPUT_CHUNK_BYTES + 4);
    let mut buffer = [0u8; OUTPUT_CHUNK_BYTES];
    let mut sequence = 0i64;
    let mut total_bytes = 0u64;
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|error| AppError::Storage(format!("could not read output source: {error}")))?;
        if count == 0 {
            if !pending.is_empty() || sequence == 0 {
                let content = std::str::from_utf8(&pending).map_err(|error| {
                    AppError::Storage(format!("stored output is not valid UTF-8: {error}"))
                })?;
                insert_output_chunk(transaction, &reference.id, sequence, content)?;
            }
            break;
        }
        total_bytes = total_bytes
            .checked_add(count as u64)
            .ok_or_else(|| AppError::Storage("output byte count overflowed".into()))?;
        pending.extend_from_slice(&buffer[..count]);
        while pending.len() >= OUTPUT_CHUNK_BYTES {
            let split = utf8_chunk_boundary(&pending, OUTPUT_CHUNK_BYTES)?;
            let content = std::str::from_utf8(&pending[..split]).map_err(|error| {
                AppError::Storage(format!("stored output is not valid UTF-8: {error}"))
            })?;
            insert_output_chunk(transaction, &reference.id, sequence, content)?;
            sequence = sequence
                .checked_add(1)
                .ok_or_else(|| AppError::Storage("output chunk sequence overflowed".into()))?;
            pending.drain(..split);
        }
    }
    if total_bytes != reference.byte_length {
        return Err(AppError::Storage(format!(
            "output source changed size from {} to {total_bytes} bytes",
            reference.byte_length
        )));
    }
    Ok(())
}

fn insert_output_chunk(
    transaction: &Transaction<'_>,
    output_id: &str,
    sequence: i64,
    content: &str,
) -> Result<(), AppError> {
    transaction
        .execute(
            "INSERT INTO output_chunks (output_id, sequence, content) VALUES (?1, ?2, ?3)",
            params![output_id, sequence, content],
        )
        .map_err(storage_error)?;
    Ok(())
}

fn utf8_chunk_boundary(bytes: &[u8], maximum_bytes: usize) -> Result<usize, AppError> {
    let end = bytes.len().min(maximum_bytes);
    match std::str::from_utf8(&bytes[..end]) {
        Ok(_) => Ok(end),
        Err(error) if error.error_len().is_none() && error.valid_up_to() > 0 => {
            Ok(error.valid_up_to())
        }
        Err(error) => Err(AppError::Storage(format!(
            "stored output is not valid UTF-8: {error}"
        ))),
    }
}

fn parse_cursor(cursor: Option<&str>) -> Result<usize, AppError> {
    let Some(cursor) = cursor else {
        return Ok(0);
    };
    if cursor.is_empty()
        || cursor.len() > MAX_CURSOR_BYTES
        || !cursor.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(AppError::Protocol("thread cursor is invalid".into()));
    }
    cursor
        .parse()
        .map_err(|_| AppError::Protocol("thread cursor is outside the supported range".into()))
}

fn parse_output_cursor(cursor: Option<&str>) -> Result<usize, AppError> {
    let Some(cursor) = cursor else {
        return Ok(0);
    };
    if cursor.is_empty()
        || cursor.len() > MAX_OUTPUT_CURSOR_BYTES
        || !cursor.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(AppError::Protocol("output cursor is invalid".into()));
    }
    cursor
        .parse()
        .map_err(|_| AppError::Protocol("output cursor is outside the supported range".into()))
}

fn status_name(status: TurnStatus) -> &'static str {
    match status {
        TurnStatus::Completed => "completed",
        TurnStatus::Failed => "failed",
        TurnStatus::InProgress => "inProgress",
        TurnStatus::Interrupted => "interrupted",
    }
}

fn parse_status(status: &str) -> Result<TurnStatus, AppError> {
    match status {
        "completed" => Ok(TurnStatus::Completed),
        "failed" => Ok(TurnStatus::Failed),
        "inProgress" => Ok(TurnStatus::InProgress),
        "interrupted" => Ok(TurnStatus::Interrupted),
        _ => Err(AppError::Storage(format!(
            "database contains unknown turn status `{status}`"
        ))),
    }
}

fn parse_conversation_mode(value: &str) -> rusqlite::Result<ConversationMode> {
    match value {
        "chat" => Ok(ConversationMode::Chat),
        "work" => Ok(ConversationMode::Work),
        "codex" => Ok(ConversationMode::Codex),
        _ => Err(rusqlite::Error::FromSqlConversionFailure(
            3,
            rusqlite::types::Type::Text,
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("database contains unknown conversation mode `{value}`"),
            )
            .into(),
        )),
    }
}

fn encode_bounded<T: Serialize>(
    value: &T,
    maximum_bytes: usize,
    label: &str,
) -> Result<String, AppError> {
    let payload = serde_json::to_string(value)
        .map_err(|error| AppError::Storage(format!("could not encode {label}: {error}")))?;
    if payload.len() > maximum_bytes {
        return Err(AppError::Storage(format!(
            "{label} exceeds {maximum_bytes} bytes"
        )));
    }
    Ok(payload)
}

fn decode_bounded<T: DeserializeOwned>(
    payload: &str,
    maximum_bytes: usize,
    label: &str,
) -> Result<T, AppError> {
    if payload.len() > maximum_bytes {
        return Err(AppError::Storage(format!(
            "stored {label} exceeds {maximum_bytes} bytes"
        )));
    }
    serde_json::from_str(payload)
        .map_err(|error| AppError::Storage(format!("stored {label} is invalid: {error}")))
}

fn initialize_database(connection: &mut Connection) -> Result<(), AppError> {
    let existing_tables = database_tables(connection)?;
    if !existing_tables.is_empty() {
        return Err(AppError::Storage(format!(
            "unversioned database contains unexpected tables: {existing_tables}"
        )));
    }
    let default_payload = encode_bounded(&AppConfig::default(), MAX_ITEM_BYTES, "config")?;
    let transaction = connection.transaction().map_err(storage_error)?;
    transaction
        .execute_batch(
            "CREATE TABLE threads (
                 id TEXT PRIMARY KEY,
                 cwd TEXT NOT NULL,
                 name TEXT,
                 preview TEXT NOT NULL,
                 archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL,
                 project_path TEXT CHECK (project_path IS NULL OR project_path = cwd),
                 mode TEXT NOT NULL CHECK (mode IN ('chat', 'work', 'codex'))
             );
             CREATE TABLE turns (
                 id TEXT PRIMARY KEY,
                 thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
                 owner_id TEXT NOT NULL,
                 status TEXT NOT NULL CHECK (status IN ('completed', 'failed', 'inProgress', 'interrupted')),
                 model TEXT NOT NULL,
                 reasoning_effort TEXT,
                 error TEXT,
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL
             );
             CREATE INDEX turns_thread_created ON turns(thread_id, created_at, id);
             CREATE UNIQUE INDEX turns_one_active_per_thread
                 ON turns(thread_id) WHERE status = 'inProgress';
             CREATE TABLE thread_items (
                 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                 turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
                 item_id TEXT NOT NULL,
                 payload TEXT NOT NULL,
                 UNIQUE(turn_id, item_id)
             );
             CREATE INDEX thread_items_turn_sequence ON thread_items(turn_id, sequence);
             CREATE TABLE output_resources (
                 id TEXT PRIMARY KEY,
                 turn_id TEXT NOT NULL,
                 item_id TEXT NOT NULL,
                 byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
                 FOREIGN KEY (turn_id, item_id)
                     REFERENCES thread_items(turn_id, item_id) ON DELETE CASCADE,
                 UNIQUE(turn_id, item_id)
             );
             CREATE INDEX output_resources_turn_item
                 ON output_resources(turn_id, item_id);
             CREATE TABLE output_chunks (
                 output_id TEXT NOT NULL REFERENCES output_resources(id) ON DELETE CASCADE,
                 sequence INTEGER NOT NULL CHECK (sequence >= 0),
                 content TEXT NOT NULL,
                 PRIMARY KEY (output_id, sequence)
             );
             CREATE TABLE provider_items (
                 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                 thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
                 payload TEXT NOT NULL
             );
             CREATE INDEX provider_items_thread_sequence
                 ON provider_items(thread_id, sequence);
             CREATE TABLE chat_conversations (
                 thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
                 conversation_id TEXT NOT NULL,
                 parent_message_id TEXT NOT NULL,
                 updated_at INTEGER NOT NULL
             );
             CREATE TABLE app_config (
                 singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                 version INTEGER NOT NULL CHECK (version >= 1),
                 payload TEXT NOT NULL
             );",
        )
        .map_err(storage_error)?;
    transaction
        .execute(
            "INSERT INTO app_config (singleton, version, payload) VALUES (1, 1, ?1)",
            [default_payload],
        )
        .map_err(storage_error)?;
    transaction
        .pragma_update(None, "application_id", DATABASE_APPLICATION_ID)
        .map_err(storage_error)?;
    transaction
        .pragma_update(None, "user_version", DATABASE_SCHEMA_VERSION)
        .map_err(storage_error)?;
    transaction.commit().map_err(storage_error)
}

fn migrate_database_v1_to_v2(connection: &mut Connection) -> Result<(), AppError> {
    let transaction = connection.transaction().map_err(storage_error)?;
    transaction
        .execute_batch(
            "CREATE TABLE output_resources (
                 id TEXT PRIMARY KEY,
                 turn_id TEXT NOT NULL,
                 item_id TEXT NOT NULL,
                 byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
                 FOREIGN KEY (turn_id, item_id)
                     REFERENCES thread_items(turn_id, item_id) ON DELETE CASCADE,
                 UNIQUE(turn_id, item_id)
             );
             CREATE INDEX output_resources_turn_item
                 ON output_resources(turn_id, item_id);
             CREATE TABLE output_chunks (
                 output_id TEXT NOT NULL REFERENCES output_resources(id) ON DELETE CASCADE,
                 sequence INTEGER NOT NULL CHECK (sequence >= 0),
                 content TEXT NOT NULL,
                 PRIMARY KEY (output_id, sequence)
             );",
        )
        .map_err(storage_error)?;

    let rows = {
        let mut statement = transaction
            .prepare(
                "SELECT sequence, turn_id, item_id, payload
                 FROM thread_items
                 ORDER BY sequence",
            )
            .map_err(storage_error)?;
        statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(storage_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(storage_error)?
    };

    for (sequence, turn_id, item_id, payload) in rows {
        let mut item: Value = decode_bounded(&payload, MAX_ITEM_BYTES, "legacy thread item")?;
        let object = item.as_object_mut().ok_or_else(|| {
            AppError::Storage(format!("legacy thread item {sequence} is not an object"))
        })?;
        let item_type = object.get("type").and_then(Value::as_str).ok_or_else(|| {
            AppError::Storage(format!("legacy thread item {sequence} has no type"))
        })?;
        let field = match item_type {
            "commandExecution" => "aggregatedOutput",
            "toolExecution" => "output",
            _ => continue,
        };
        let Some(value) = object.get(field) else {
            return Err(AppError::Storage(format!(
                "legacy thread item {sequence} has no {field} field"
            )));
        };
        if value.is_null() {
            continue;
        }
        let output = value.as_str().ok_or_else(|| {
            AppError::Storage(format!(
                "legacy thread item {sequence} contains a non-text {field} field"
            ))
        })?;
        let output = if item_type == "commandExecution" {
            normalize_terminal_bytes(output.as_bytes())
        } else {
            output.to_string()
        };
        let source = OutputSource::text(output);
        let reference = source.reference();
        object.insert(field.into(), json!(reference));
        let migrated_payload = encode_bounded(&item, MAX_ITEM_BYTES, "migrated thread item")?;
        transaction
            .execute(
                "UPDATE thread_items SET payload = ?1 WHERE sequence = ?2",
                params![migrated_payload, sequence],
            )
            .map_err(storage_error)?;
        persist_output_source(&transaction, &turn_id, &item_id, source)?;
    }

    transaction
        .pragma_update(None, "user_version", DATABASE_SCHEMA_VERSION)
        .map_err(storage_error)?;
    transaction.commit().map_err(storage_error)
}

fn validate_database(
    connection: &Connection,
    version: i64,
    application_id: i64,
) -> Result<(), AppError> {
    if version != DATABASE_SCHEMA_VERSION || application_id != DATABASE_APPLICATION_ID {
        return Err(AppError::Storage(format!(
            "database identity is unsupported; expected application {DATABASE_APPLICATION_ID} schema {DATABASE_SCHEMA_VERSION}, received application {application_id} schema {version}"
        )));
    }
    let tables = database_tables(connection)?;
    if tables != DATABASE_TABLES {
        return Err(AppError::Storage(format!(
            "database tables do not match schema {DATABASE_SCHEMA_VERSION}: {tables}"
        )));
    }
    let columns = thread_columns(connection)?;
    if columns != THREAD_COLUMNS {
        return Err(AppError::Storage(format!(
            "thread columns do not match schema {DATABASE_SCHEMA_VERSION}: {columns}"
        )));
    }
    let columns = turn_columns(connection)?;
    if columns != TURN_COLUMNS {
        return Err(AppError::Storage(format!(
            "turn columns do not match schema {DATABASE_SCHEMA_VERSION}: {columns}"
        )));
    }
    let integrity: String = connection
        .query_row("PRAGMA quick_check(1)", [], |row| row.get(0))
        .map_err(storage_error)?;
    if integrity != "ok" {
        return Err(AppError::Storage(format!(
            "database integrity check failed: {integrity}"
        )));
    }
    let (config_version, payload): (i64, String) = connection
        .query_row(
            "SELECT version, payload FROM app_config WHERE singleton = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(storage_error)?;
    if config_version < 1 {
        return Err(AppError::Storage(
            "database contains an invalid configuration version".into(),
        ));
    }
    let config: AppConfig = decode_bounded(&payload, MAX_ITEM_BYTES, "config")?;
    validate_config(&config)
}

fn database_tables(connection: &Connection) -> Result<String, AppError> {
    connection
        .query_row(
            "SELECT COALESCE(group_concat(name, ','), '')
             FROM (
                 SELECT name FROM sqlite_schema
                 WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
                 ORDER BY name
             )",
            [],
            |row| row.get(0),
        )
        .map_err(storage_error)
}

fn thread_columns(connection: &Connection) -> Result<String, AppError> {
    connection
        .query_row(
            "SELECT COALESCE(group_concat(name, ','), '')
             FROM (SELECT name FROM pragma_table_info('threads') ORDER BY cid)",
            [],
            |row| row.get(0),
        )
        .map_err(storage_error)
}

fn turn_columns(connection: &Connection) -> Result<String, AppError> {
    connection
        .query_row(
            "SELECT COALESCE(group_concat(name, ','), '')
             FROM (SELECT name FROM pragma_table_info('turns') ORDER BY cid)",
            [],
            |row| row.get(0),
        )
        .map_err(storage_error)
}

fn open_database_connection(path: &Path) -> Result<Connection, AppError> {
    let connection = Connection::open(path).map_err(storage_error)?;
    configure_database_connection(&connection).map_err(storage_error)?;
    connection
        .execute_batch("PRAGMA journal_mode = WAL;")
        .map_err(storage_error)?;
    Ok(connection)
}

fn configure_database_connection(connection: &Connection) -> rusqlite::Result<()> {
    connection.busy_timeout(Duration::from_secs(5))?;
    connection.execute_batch(
        "PRAGMA foreign_keys = ON;
             PRAGMA synchronous = NORMAL;
             PRAGMA temp_store = MEMORY;
             PRAGMA wal_autocheckpoint = 1000;",
    )
}

fn database_connection_limit() -> u32 {
    std::thread::available_parallelism()
        .map_or(4, std::num::NonZeroUsize::get)
        .clamp(4, MAX_DATABASE_CONNECTIONS as usize) as u32
}

fn unix_timestamp() -> Result<i64, AppError> {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| AppError::Storage(error.to_string()))?
        .as_secs();
    i64::try_from(seconds).map_err(|error| AppError::Storage(error.to_string()))
}

fn require_changed(changed: usize, label: &str) -> Result<(), AppError> {
    if changed == 1 {
        Ok(())
    } else {
        Err(AppError::State(format!(
            "{label} does not exist in the expected state"
        )))
    }
}

fn storage_error(error: rusqlite::Error) -> AppError {
    AppError::Storage(error.to_string())
}

fn pool_error(error: r2d2::Error) -> AppError {
    AppError::Storage(format!("database connection pool failed: {error}"))
}

async fn run_blocking<T, F>(operation: F) -> Result<T, AppError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, AppError> + Send + 'static,
{
    tokio::task::spawn_blocking(operation)
        .await
        .map_err(|error| AppError::Storage(format!("storage task failed: {error}")))?
}

#[cfg(test)]
mod tests {
    use rusqlite::{Connection, params};
    use tempfile::TempDir;

    use super::{
        DATABASE_APPLICATION_ID, DATABASE_SCHEMA_VERSION, NativeStorage, encode_bounded,
        initialize_database,
    };
    use crate::engine::native::output::OutputSource;
    use crate::engine::native::provider::{ResponseContent, ResponseItem};
    use crate::engine::{
        ActivityStatus, ConfigUpdate, ConversationMode, ModelVerbosity, ThreadItem, ThreadOutput,
        TokenUsage, TurnStatus, UserContent,
    };

    async fn read_complete_output(storage: &NativeStorage, output_id: &str) -> String {
        let mut content = String::new();
        let mut cursor = None;
        loop {
            let page = storage
                .read_output(output_id.to_string(), cursor)
                .await
                .expect("stored output page should load");
            assert_eq!(page.output_id, output_id);
            content.push_str(&page.chunk);
            cursor = page.next_cursor;
            if cursor.is_none() {
                return content;
            }
        }
    }

    fn tool_output(item: &ThreadItem) -> &ThreadOutput {
        match item {
            ThreadItem::ToolExecution {
                output: Some(output),
                ..
            } => output,
            item => panic!("expected a tool output reference, received {item:?}"),
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn initializes_the_native_schema_directly() {
        let directory = TempDir::new().expect("temporary directory should be created");
        let database_path = directory.path().join("test.sqlite3");
        let storage = NativeStorage::default();
        storage
            .initialize_at(database_path.clone())
            .await
            .expect("storage should initialize");
        let project_path = directory.path().display().to_string();
        let thread = storage
            .create_thread(
                project_path.clone(),
                Some(project_path.clone()),
                ConversationMode::Codex,
            )
            .await
            .expect("thread should persist");
        let loaded = storage
            .read_thread(thread.id.clone())
            .await
            .expect("thread should load");
        assert_eq!(loaded.id, thread.id);
        assert_eq!(loaded.mode, ConversationMode::Codex);
        assert_eq!(loaded.project_path.as_deref(), Some(project_path.as_str()));
        assert!(loaded.turns.is_empty());

        let connection = Connection::open(database_path).expect("database should reopen");
        let application_id: i64 = connection
            .query_row("PRAGMA application_id", [], |row| row.get(0))
            .expect("application id should be readable");
        let schema_version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("schema version should be readable");
        assert_eq!(application_id, DATABASE_APPLICATION_ID);
        assert_eq!(schema_version, DATABASE_SCHEMA_VERSION);

        connection
            .execute(
                "INSERT INTO turns
                     (id, thread_id, owner_id, status, model, reasoning_effort, error, created_at, updated_at)
                 VALUES (?1, ?2, 'test-owner', 'failed', 'gpt-test', NULL, ?3, 1, 1)",
                params!["failed-turn", thread.id, "provider stream failed"],
            )
            .expect("failed turn fixture should persist");
        drop(connection);

        let loaded = storage
            .read_thread(thread.id.clone())
            .await
            .expect("thread with failed turn should load");
        let failed_turn = loaded.turns.first().expect("failed turn should be present");
        assert_eq!(failed_turn.status, TurnStatus::Failed);
        assert_eq!(failed_turn.error.as_deref(), Some("provider stream failed"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn paginates_threads_beyond_the_previous_turn_limit() {
        const TURN_COUNT: usize = 1_200;

        let directory = TempDir::new().expect("temporary directory should be created");
        let database_path = directory.path().join("maximum-thread.sqlite3");
        let storage = NativeStorage::default();
        storage
            .initialize_at(database_path.clone())
            .await
            .expect("storage should initialize");
        let thread = storage
            .create_thread(
                directory.path().display().to_string(),
                Some(directory.path().display().to_string()),
                ConversationMode::Codex,
            )
            .await
            .expect("thread should persist");

        let mut connection = Connection::open(database_path).expect("database should reopen");
        connection
            .execute("PRAGMA foreign_keys = ON", [])
            .expect("foreign keys should enable");
        let transaction = connection.transaction().expect("transaction should begin");
        for turn_index in 0..TURN_COUNT {
            let turn_id = format!("turn-{turn_index:04}");
            let timestamp = i64::try_from(turn_index).expect("turn index should fit SQLite");
            transaction
                .execute(
                    "INSERT INTO turns
                         (id, thread_id, owner_id, status, model, reasoning_effort, error, created_at, updated_at)
                     VALUES (?1, ?2, 'stress-owner', 'completed', 'gpt-test', NULL, NULL, ?3, ?3)",
                    params![turn_id, thread.id, timestamp],
                )
                .expect("stress turn should persist");
            let item_id = format!("item-{turn_index:04}");
            let payload = encode_bounded(
                &ThreadItem::AgentMessage {
                    id: item_id.clone(),
                    text: "x".into(),
                    phase: None,
                },
                super::MAX_ITEM_BYTES,
                "stress thread item",
            )
            .expect("stress item should encode");
            transaction
                .execute(
                    "INSERT INTO thread_items (turn_id, item_id, payload) VALUES (?1, ?2, ?3)",
                    params![turn_id, item_id, payload],
                )
                .expect("stress item should persist");
        }
        transaction.commit().expect("stress fixture should commit");
        drop(connection);

        let mut cursor = None;
        let mut turn_ids = Vec::new();
        let mut page_index = 0usize;
        loop {
            let page = storage
                .read_thread_page(thread.id.clone(), cursor)
                .await
                .expect("history page should load");
            let maximum_page_rows = if page_index == 0 {
                super::history::INITIAL_THREAD_HISTORY_PAGE_ROWS
            } else {
                super::history::OLDER_THREAD_HISTORY_PAGE_ROWS
            };
            assert!(page.thread.turns.len() <= maximum_page_rows);
            if page_index == 0 {
                assert_eq!(
                    page.thread.turns.len(),
                    super::history::INITIAL_THREAD_HISTORY_PAGE_ROWS
                );
            }
            let mut page_ids = page
                .thread
                .turns
                .iter()
                .map(|turn| turn.id.clone())
                .collect::<Vec<_>>();
            page_ids.extend(turn_ids);
            turn_ids = page_ids;
            cursor = page.next_cursor;
            page_index += 1;
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(page_index, 6);
        assert_eq!(turn_ids.len(), TURN_COUNT);
        assert_eq!(turn_ids.first().map(String::as_str), Some("turn-0000"));
        assert_eq!(turn_ids.last().map(String::as_str), Some("turn-1199"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn persists_output_detail_overrides_and_restores_the_model_default() {
        let directory = TempDir::new().expect("temporary directory should be created");
        let storage = NativeStorage::default();
        storage
            .initialize_at(directory.path().join("output-detail.sqlite3"))
            .await
            .expect("storage should initialize");

        let initial = storage
            .read_config()
            .await
            .expect("default configuration should load");
        assert!(initial.config.model_verbosity.is_none());
        let mut version = initial.version;

        for verbosity in [
            ModelVerbosity::Low,
            ModelVerbosity::Medium,
            ModelVerbosity::High,
        ] {
            let updated = storage
                .update_config(
                    version,
                    ConfigUpdate::ModelVerbosity {
                        value: Some(verbosity),
                    },
                )
                .await
                .expect("output detail override should persist");
            assert_eq!(updated.config.model_verbosity, Some(verbosity));
            version = updated.version;

            let reloaded = storage
                .read_config()
                .await
                .expect("output detail override should reload");
            assert_eq!(reloaded.config.model_verbosity, Some(verbosity));
        }

        let restored = storage
            .update_config(version, ConfigUpdate::ModelVerbosity { value: None })
            .await
            .expect("model default should persist");
        assert!(restored.config.model_verbosity.is_none());

        let reloaded = storage
            .read_config()
            .await
            .expect("model default should reload");
        assert!(reloaded.config.model_verbosity.is_none());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn persists_projectless_threads_without_inventing_a_project() {
        let directory = TempDir::new().expect("temporary directory should be created");
        let workspace = directory.path().join("projectless-workspace");
        std::fs::create_dir_all(&workspace).expect("workspace should be created");
        let storage = NativeStorage::default();
        storage
            .initialize_at(directory.path().join("projectless.sqlite3"))
            .await
            .expect("storage should initialize");

        let thread = storage
            .create_thread(
                workspace.display().to_string(),
                None,
                ConversationMode::Chat,
            )
            .await
            .expect("projectless thread should persist");
        let fork = storage
            .fork_thread(thread.id.clone())
            .await
            .expect("projectless thread should fork");
        let listed = storage
            .list_threads(None, false)
            .await
            .expect("projectless threads should list");

        assert_eq!(thread.project_path, None);
        assert_eq!(thread.mode, ConversationMode::Chat);
        assert_eq!(fork.project_path, None);
        assert_eq!(fork.mode, ConversationMode::Chat);
        assert!(listed.data.iter().all(|entry| entry.project_path.is_none()));
        assert!(listed.data.iter().all(|entry| entry.cwd == thread.cwd));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn persists_and_forks_chatgpt_conversation_continuity() {
        let directory = TempDir::new().expect("temporary directory should be created");
        let storage = NativeStorage::default();
        storage
            .initialize_at(directory.path().join("chat-continuity.sqlite3"))
            .await
            .expect("storage should initialize");
        let thread = storage
            .create_thread(
                directory.path().display().to_string(),
                None,
                ConversationMode::Chat,
            )
            .await
            .expect("Chat thread should persist");
        let turn = storage
            .begin_chat_turn(
                thread.id.clone(),
                "gpt-5.6-pro".into(),
                Some("max".into()),
                ThreadItem::UserMessage {
                    id: "user-chat".into(),
                    content: vec![UserContent::Text {
                        text: "Olá".into()
                    }],
                },
                "Olá".into(),
            )
            .await
            .expect("Chat turn should begin");
        storage
            .update_chat_conversation_state(
                thread.id.clone(),
                "conversation-1".into(),
                "assistant-1".into(),
            )
            .await
            .expect("continuity should persist");
        storage
            .complete_turn(thread.id.clone(), turn.id, TurnStatus::Completed, None)
            .await
            .expect("turn should complete");

        let state = storage
            .chat_conversation_state(thread.id.clone())
            .await
            .expect("continuity should load");
        let history = storage
            .provider_history(thread.id.clone())
            .await
            .expect("Codex history should remain readable");
        assert_eq!(state.conversation_id.as_deref(), Some("conversation-1"));
        assert_eq!(state.parent_message_id.as_deref(), Some("assistant-1"));
        assert!(history.is_empty());

        let fork = storage
            .fork_thread(thread.id.clone())
            .await
            .expect("Chat thread should fork");
        let fork_state = storage
            .chat_conversation_state(fork.id.clone())
            .await
            .expect("fork continuity should load");
        assert_eq!(fork_state, state);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn rejects_an_incomplete_current_schema_without_repairing_it() {
        let directory = TempDir::new().expect("temporary directory should be created");
        let database_path = directory.path().join("schema-one.sqlite3");
        let mut connection = Connection::open(&database_path).expect("database should open");
        initialize_database(&mut connection).expect("current fixture should initialize");
        connection
            .execute("DROP TABLE chat_conversations", [])
            .expect("new table should be removed from the legacy fixture");
        drop(connection);

        let storage = NativeStorage::default();
        let error = storage
            .initialize_at(database_path.clone())
            .await
            .expect_err("an incomplete profile database must be rejected");
        assert!(
            error
                .to_string()
                .contains("database tables do not match schema")
        );

        let connection = Connection::open(database_path).expect("database should reopen");
        let table_exists: bool = connection
            .query_row(
                "SELECT EXISTS(
                     SELECT 1 FROM sqlite_schema
                     WHERE type = 'table' AND name = 'chat_conversations'
                 )",
                [],
                |row| row.get(0),
            )
            .expect("table existence should be readable");
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("schema version should be readable");
        assert!(!table_exists);
        assert_eq!(version, DATABASE_SCHEMA_VERSION);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn migrates_legacy_inline_outputs_to_chunked_resources_transactionally() {
        let directory = TempDir::new().expect("temporary directory should be created");
        let database_path = directory.path().join("legacy-output.sqlite3");
        let legacy_output = "😀".repeat(300_000);
        let mut connection = Connection::open(&database_path).expect("database should open");
        initialize_database(&mut connection).expect("current fixture should initialize");
        connection
            .execute(
                "INSERT INTO threads
                     (id, cwd, name, preview, archived, created_at, updated_at, project_path, mode)
                 VALUES ('legacy-thread', 'C:\\workspace', NULL, 'legacy', 0, 1, 1,
                         'C:\\workspace', 'codex')",
                [],
            )
            .expect("legacy thread should persist");
        connection
            .execute(
                "INSERT INTO turns
                     (id, thread_id, owner_id, status, model, reasoning_effort, error,
                      created_at, updated_at)
                 VALUES ('legacy-turn', 'legacy-thread', 'legacy-owner', 'completed',
                         'gpt-test', NULL, NULL, 1, 1)",
                [],
            )
            .expect("legacy turn should persist");
        let payload = serde_json::json!({
            "type": "toolExecution",
            "id": "legacy-tool",
            "name": "read_file",
            "description": "Legacy output",
            "status": "completed",
            "output": &legacy_output,
        })
        .to_string();
        connection
            .execute(
                "INSERT INTO thread_items (turn_id, item_id, payload)
                 VALUES ('legacy-turn', 'legacy-tool', ?1)",
                [payload],
            )
            .expect("legacy item should persist");
        connection
            .execute_batch(
                "DROP TABLE output_chunks;
                 DROP TABLE output_resources;
                 PRAGMA user_version = 1;",
            )
            .expect("fixture should become schema one");
        drop(connection);

        let storage = NativeStorage::default();
        storage
            .initialize_at(database_path.clone())
            .await
            .expect("legacy profile should migrate");
        let thread = storage
            .read_thread("legacy-thread".into())
            .await
            .expect("migrated thread should load");
        let item = thread
            .turns
            .first()
            .and_then(|turn| turn.items.first())
            .expect("migrated output item should exist");
        let output = tool_output(item);
        assert_eq!(output.byte_length, legacy_output.len() as u64);
        assert!(output.preview.len() <= super::OUTPUT_CHUNK_BYTES);
        assert_eq!(
            read_complete_output(&storage, &output.id).await,
            legacy_output
        );

        let connection = Connection::open(database_path).expect("database should reopen");
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("schema version should load");
        let inline_payload_bytes: i64 = connection
            .query_row(
                "SELECT length(payload) FROM thread_items WHERE item_id = 'legacy-tool'",
                [],
                |row| row.get(0),
            )
            .expect("migrated payload size should load");
        assert_eq!(version, DATABASE_SCHEMA_VERSION);
        assert!(inline_payload_bytes < 70_000);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn completed_turn_returns_terminal_projection() {
        let directory = TempDir::new().expect("temporary directory should be created");
        let storage = NativeStorage::default();
        storage
            .initialize_at(directory.path().join("completed-turn.sqlite3"))
            .await
            .expect("storage should initialize");
        let thread = storage
            .create_thread(
                directory.path().display().to_string(),
                Some(directory.path().display().to_string()),
                ConversationMode::Codex,
            )
            .await
            .expect("thread should persist");
        let turn = storage
            .begin_compaction_turn(thread.id.clone(), "gpt-test".into(), None)
            .await
            .expect("turn should begin");
        let created_at = storage
            .read_thread(thread.id.clone())
            .await
            .expect("thread should load")
            .turns[0]
            .created_at;

        let completed = storage
            .complete_turn(
                thread.id.clone(),
                turn.id,
                TurnStatus::Interrupted,
                Some("interrupted by user".into()),
            )
            .await
            .expect("turn should complete");

        assert_eq!(completed.status, TurnStatus::Interrupted);
        assert_eq!(completed.error.as_deref(), Some("interrupted by user"));
        assert!(completed.updated_at >= created_at);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn rejects_an_unversioned_existing_database() {
        let directory = TempDir::new().expect("temporary directory should be created");
        let database_path = directory.path().join("unexpected.sqlite3");
        let connection = Connection::open(&database_path).expect("database should open");
        connection
            .execute("CREATE TABLE legacy_state (value TEXT NOT NULL)", [])
            .expect("fixture table should be created");
        drop(connection);

        let storage = NativeStorage::default();
        assert!(storage.initialize_at(database_path).await.is_err());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn begins_manual_compaction_without_synthesizing_user_history() {
        let directory = TempDir::new().expect("temporary directory should be created");
        let storage = NativeStorage::default();
        storage
            .initialize_at(directory.path().join("manual-compaction.sqlite3"))
            .await
            .expect("storage should initialize");
        let thread = storage
            .create_thread(
                directory.path().display().to_string(),
                Some(directory.path().display().to_string()),
                ConversationMode::Codex,
            )
            .await
            .expect("thread should persist");

        let turn = storage
            .begin_compaction_turn(thread.id.clone(), "gpt-test".into(), Some("medium".into()))
            .await
            .expect("compaction turn should begin");
        let loaded = storage
            .read_thread(thread.id.clone())
            .await
            .expect("thread should load");
        let history = storage
            .provider_history(thread.id.clone())
            .await
            .expect("provider history should load");
        assert_eq!(loaded.turns.len(), 1);
        assert!(loaded.turns[0].items.is_empty());
        assert!(history.is_empty());

        storage
            .complete_turn(thread.id.clone(), turn.id, TurnStatus::Completed, None)
            .await
            .expect("compaction turn should complete");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn replaces_only_the_active_provider_context_transactionally() {
        let directory = TempDir::new().expect("temporary directory should be created");
        let storage = NativeStorage::default();
        storage
            .initialize_at(directory.path().join("compaction.sqlite3"))
            .await
            .expect("storage should initialize");
        let thread = storage
            .create_thread(
                directory.path().display().to_string(),
                Some(directory.path().display().to_string()),
                ConversationMode::Codex,
            )
            .await
            .expect("thread should persist");
        let turn = storage
            .begin_turn(
                thread.id.clone(),
                "gpt-test".into(),
                None,
                ThreadItem::UserMessage {
                    id: "user-1".into(),
                    content: vec![UserContent::Text { text: "old".into() }],
                },
                ResponseItem::user_content(vec![ResponseContent::InputText { text: "old".into() }]),
                "old".into(),
            )
            .await
            .expect("turn should begin");
        storage
            .append_thread_item(
                turn.id.clone(),
                ThreadItem::ContextUsage {
                    id: "usage-1".into(),
                    model: "gpt-test".into(),
                    usage: TokenUsage {
                        input_tokens: 95,
                        cached_input_tokens: 0,
                        output_tokens: 5,
                        reasoning_output_tokens: 0,
                        total_tokens: 100,
                    },
                    context_window: None,
                },
                None,
            )
            .await
            .expect("usage should persist");
        storage
            .replace_provider_history(
                thread.id.clone(),
                vec![ResponseItem::user_content(vec![
                    ResponseContent::InputText {
                        text: "replacement".into(),
                    },
                ])],
            )
            .await
            .expect("history should be replaced");

        let history = storage
            .provider_history(thread.id.clone())
            .await
            .expect("replacement history should load");
        let usage = storage
            .latest_context_usage(thread.id.clone())
            .await
            .expect("usage lookup should succeed")
            .expect("usage should exist");
        assert_eq!(history.len(), 1);
        assert!(
            serde_json::to_string(&history[0])
                .expect("history should encode")
                .contains("replacement")
        );
        assert_eq!(usage.model, "gpt-test");
        assert_eq!(usage.usage.total_tokens, 100);

        storage
            .append_thread_item(
                turn.id,
                ThreadItem::ContextCompaction {
                    id: "compaction-1".into(),
                },
                None,
            )
            .await
            .expect("compaction marker should persist");
        assert!(
            storage
                .latest_context_usage(thread.id.clone())
                .await
                .expect("context state should load")
                .is_none()
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn installs_compacted_history_and_marker_together() {
        let directory = TempDir::new().expect("temporary directory should be created");
        let storage = NativeStorage::default();
        storage
            .initialize_at(directory.path().join("atomic-compaction.sqlite3"))
            .await
            .expect("storage should initialize");
        let thread = storage
            .create_thread(
                directory.path().display().to_string(),
                Some(directory.path().display().to_string()),
                ConversationMode::Codex,
            )
            .await
            .expect("thread should persist");
        let turn = storage
            .begin_turn(
                thread.id.clone(),
                "gpt-test".into(),
                None,
                ThreadItem::UserMessage {
                    id: "user-atomic".into(),
                    content: vec![UserContent::Text { text: "old".into() }],
                },
                ResponseItem::user_content(vec![ResponseContent::InputText { text: "old".into() }]),
                "old".into(),
            )
            .await
            .expect("turn should begin");
        storage
            .install_compacted_history(
                thread.id.clone(),
                turn.id,
                vec![ResponseItem::Compaction {
                    id: Some("checkpoint-atomic".into()),
                    encrypted_content: "encrypted".into(),
                    internal_chat_message_metadata_passthrough: None,
                }],
                "compaction-atomic".into(),
            )
            .await
            .expect("compacted history and marker should install");

        let history = storage
            .provider_history(thread.id.clone())
            .await
            .expect("compacted history should load");
        let loaded = storage
            .read_thread(thread.id.clone())
            .await
            .expect("thread should load");
        assert!(matches!(
            history.as_slice(),
            [ResponseItem::Compaction { .. }]
        ));
        assert!(matches!(
            loaded.turns[0].items.last(),
            Some(ThreadItem::ContextCompaction { id }) if id == "compaction-atomic"
        ));
        assert!(
            storage
                .latest_context_usage(thread.id.clone())
                .await
                .expect("context state should load")
                .is_none()
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn rolls_back_compacted_history_when_marker_insert_fails() {
        let directory = TempDir::new().expect("temporary directory should be created");
        let storage = NativeStorage::default();
        storage
            .initialize_at(directory.path().join("rollback-compaction.sqlite3"))
            .await
            .expect("storage should initialize");
        let thread = storage
            .create_thread(
                directory.path().display().to_string(),
                Some(directory.path().display().to_string()),
                ConversationMode::Codex,
            )
            .await
            .expect("thread should persist");
        let turn = storage
            .begin_turn(
                thread.id.clone(),
                "gpt-test".into(),
                None,
                ThreadItem::UserMessage {
                    id: "user-rollback".into(),
                    content: vec![UserContent::Text {
                        text: "original".into(),
                    }],
                },
                ResponseItem::user_content(vec![ResponseContent::InputText {
                    text: "original".into(),
                }]),
                "original".into(),
            )
            .await
            .expect("turn should begin");
        storage
            .append_thread_item(
                turn.id.clone(),
                ThreadItem::ContextCompaction {
                    id: "duplicate-compaction".into(),
                },
                None,
            )
            .await
            .expect("duplicate fixture should persist");

        let result = storage
            .install_compacted_history(
                thread.id.clone(),
                turn.id,
                vec![ResponseItem::Compaction {
                    id: Some("replacement-checkpoint".into()),
                    encrypted_content: "replacement".into(),
                    internal_chat_message_metadata_passthrough: None,
                }],
                "duplicate-compaction".into(),
            )
            .await;

        assert!(result.is_err());
        let history = storage
            .provider_history(thread.id.clone())
            .await
            .expect("original history should remain readable");
        let encoded = serde_json::to_string(&history).expect("history should encode");
        assert!(encoded.contains("original"));
        assert!(!encoded.contains("replacement-checkpoint"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn appends_steered_input_to_the_active_turn_and_provider_history_atomically() {
        let directory = TempDir::new().expect("temporary directory should be created");
        let storage = NativeStorage::default();
        storage
            .initialize_at(directory.path().join("steer.sqlite3"))
            .await
            .expect("storage should initialize");
        let thread = storage
            .create_thread(
                directory.path().display().to_string(),
                Some(directory.path().display().to_string()),
                ConversationMode::Codex,
            )
            .await
            .expect("thread should persist");
        let turn = storage
            .begin_turn(
                thread.id.clone(),
                "gpt-test".into(),
                None,
                ThreadItem::UserMessage {
                    id: "user-1".into(),
                    content: vec![UserContent::Text {
                        text: "initial".into(),
                    }],
                },
                ResponseItem::user_content(vec![ResponseContent::InputText {
                    text: "initial".into(),
                }]),
                "initial".into(),
            )
            .await
            .expect("turn should begin");
        let mut incremental_history = storage
            .provider_history_snapshot(thread.id.clone())
            .await
            .expect("initial provider history should load");
        assert_eq!(incremental_history.items.len(), 1);

        storage
            .append_turn_input(
                thread.id.clone(),
                turn.id.clone(),
                ThreadItem::UserMessage {
                    id: "user-2".into(),
                    content: vec![UserContent::Text {
                        text: "steer".into(),
                    }],
                },
                ResponseItem::user_content(vec![ResponseContent::InputText {
                    text: "steer".into(),
                }]),
            )
            .await
            .expect("steer should append");
        storage
            .refresh_provider_history(thread.id.clone(), &mut incremental_history)
            .await
            .expect("incremental provider history should refresh");
        assert_eq!(incremental_history.items.len(), 2);
        storage
            .refresh_provider_history(thread.id.clone(), &mut incremental_history)
            .await
            .expect("an unchanged provider history should remain refreshable");
        assert_eq!(incremental_history.items.len(), 2);

        let loaded = storage
            .read_thread(thread.id.clone())
            .await
            .expect("thread should load");
        let history = storage
            .provider_history(thread.id.clone())
            .await
            .expect("provider history should load");
        assert_eq!(loaded.turns[0].items.len(), 2);
        assert_eq!(history.len(), 2);

        storage
            .complete_turn(
                thread.id.clone(),
                turn.id.clone(),
                TurnStatus::Completed,
                None,
            )
            .await
            .expect("turn should complete");
        assert!(
            storage
                .append_turn_input(
                    thread.id.clone(),
                    turn.id,
                    ThreadItem::UserMessage {
                        id: "user-3".into(),
                        content: vec![UserContent::Text {
                            text: "late".into(),
                        }],
                    },
                    ResponseItem::user_content(vec![ResponseContent::InputText {
                        text: "late".into(),
                    }]),
                )
                .await
                .is_err()
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn deletes_only_the_matching_owned_active_turn_transactionally() {
        let directory = TempDir::new().expect("temporary directory should be created");
        let storage = NativeStorage::default();
        storage
            .initialize_at(directory.path().join("active-thread-deletion.sqlite3"))
            .await
            .expect("storage should initialize");
        let thread = storage
            .create_thread(
                directory.path().display().to_string(),
                Some(directory.path().display().to_string()),
                ConversationMode::Codex,
            )
            .await
            .expect("thread should persist");
        let turn = storage
            .begin_turn(
                thread.id.clone(),
                "gpt-test".into(),
                None,
                ThreadItem::UserMessage {
                    id: "user-active-delete".into(),
                    content: vec![UserContent::Text {
                        text: "delete while active".into(),
                    }],
                },
                ResponseItem::user_content(vec![ResponseContent::InputText {
                    text: "delete while active".into(),
                }]),
                "delete while active".into(),
            )
            .await
            .expect("turn should begin");

        assert!(storage.delete_thread(thread.id.clone()).await.is_err());
        assert!(
            storage
                .delete_owned_active_thread(thread.id.clone(), "wrong-turn".into())
                .await
                .is_err()
        );
        assert_eq!(
            storage
                .read_thread(thread.id.clone())
                .await
                .expect("failed deletion must preserve the thread")
                .turns[0]
                .status,
            TurnStatus::InProgress
        );

        let response = storage
            .delete_owned_active_thread(thread.id.clone(), turn.id)
            .await
            .expect("the owning active turn should authorize deletion");
        assert!(response.applied);
        assert!(storage.read_thread(thread.id.clone()).await.is_err());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn stores_large_outputs_in_pages_and_forks_them_independently() {
        let directory = TempDir::new().expect("temporary directory should be created");
        let storage = NativeStorage::default();
        storage
            .initialize_at(directory.path().join("large-output.sqlite3"))
            .await
            .expect("storage should initialize");
        let source = storage
            .create_thread(
                directory.path().display().to_string(),
                Some(directory.path().display().to_string()),
                ConversationMode::Codex,
            )
            .await
            .expect("source thread should persist");
        let turn = storage
            .begin_turn(
                source.id.clone(),
                "gpt-test".into(),
                None,
                ThreadItem::UserMessage {
                    id: "large-output-user".into(),
                    content: vec![UserContent::Text {
                        text: "produce a large output".into(),
                    }],
                },
                ResponseItem::user_content(vec![ResponseContent::InputText {
                    text: "produce a large output".into(),
                }]),
                "produce a large output".into(),
            )
            .await
            .expect("turn should begin");
        let content = format!("{}{}", "x".repeat(1_100_000), "😀".repeat(300_000));
        let stored_item = storage
            .append_thread_item(
                turn.id.clone(),
                ThreadItem::ToolExecution {
                    id: "large-output-tool".into(),
                    name: "read_file".into(),
                    description: "Large UTF-8 output".into(),
                    status: ActivityStatus::Completed,
                    output: None,
                },
                Some(OutputSource::text(content.clone())),
            )
            .await
            .expect("large output should persist");
        let output = tool_output(&stored_item).clone();
        assert!(output.byte_length > 1_048_576);
        assert!(output.preview.len() <= super::OUTPUT_CHUNK_BYTES);

        let first_page = storage
            .read_output(output.id.clone(), None)
            .await
            .expect("first output page should load");
        assert_eq!(first_page.chunk, output.preview);
        assert_eq!(first_page.byte_length, output.byte_length);
        assert!(first_page.next_cursor.is_some());
        assert_eq!(read_complete_output(&storage, &output.id).await, content);

        storage
            .complete_turn(source.id.clone(), turn.id, TurnStatus::Completed, None)
            .await
            .expect("source turn should complete");
        let fork = storage
            .fork_thread(source.id.clone())
            .await
            .expect("thread with output should fork");
        let fork_output = fork
            .turns
            .first()
            .and_then(|turn| {
                turn.items
                    .iter()
                    .find(|item| item.id() == "large-output-tool")
            })
            .map(tool_output)
            .expect("forked output should exist")
            .clone();
        assert_ne!(fork_output.id, output.id);
        assert_eq!(fork_output.byte_length, output.byte_length);
        assert_eq!(
            read_complete_output(&storage, &fork_output.id).await,
            content
        );

        storage
            .delete_thread(source.id.clone())
            .await
            .expect("source thread should delete");
        assert!(storage.read_output(output.id, None).await.is_err());
        assert_eq!(
            read_complete_output(&storage, &fork_output.id).await,
            content
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn thread_lifecycle_forks_archives_restores_and_deletes_transactionally() {
        let directory = TempDir::new().expect("temporary directory should be created");
        let storage = NativeStorage::default();
        storage
            .initialize_at(directory.path().join("thread-lifecycle.sqlite3"))
            .await
            .expect("storage should initialize");
        let source = storage
            .create_thread(
                directory.path().display().to_string(),
                Some(directory.path().display().to_string()),
                ConversationMode::Codex,
            )
            .await
            .expect("source thread should persist");
        let turn = storage
            .begin_turn(
                source.id.clone(),
                "gpt-test".into(),
                Some("high".into()),
                ThreadItem::UserMessage {
                    id: "user-source".into(),
                    content: vec![UserContent::Text {
                        text: "fork me".into(),
                    }],
                },
                ResponseItem::user_content(vec![ResponseContent::InputText {
                    text: "fork me".into(),
                }]),
                "fork me".into(),
            )
            .await
            .expect("source turn should begin");
        storage
            .complete_turn(source.id.clone(), turn.id, TurnStatus::Completed, None)
            .await
            .expect("source turn should complete");

        let fork = storage
            .fork_thread(source.id.clone())
            .await
            .expect("thread should fork");
        assert_ne!(fork.id, source.id);
        assert_eq!(fork.cwd, source.cwd);
        assert_eq!(fork.turns.len(), 1);
        assert_eq!(fork.turns[0].items.len(), 1);
        assert_eq!(
            storage
                .provider_history(fork.id.clone())
                .await
                .expect("fork history should load")
                .len(),
            1
        );

        storage
            .archive_thread(source.id.clone())
            .await
            .expect("source should archive");
        let archived = storage
            .list_threads(None, true)
            .await
            .expect("archived threads should list");
        assert_eq!(archived.data.len(), 1);
        assert_eq!(archived.data[0].id, source.id);
        storage
            .unarchive_thread(source.id.clone())
            .await
            .expect("source should restore");
        let active = storage
            .list_threads(None, false)
            .await
            .expect("active threads should list");
        assert_eq!(active.data.len(), 2);

        storage
            .delete_thread(fork.id.clone())
            .await
            .expect("fork should delete");
        assert!(storage.read_thread(fork.id.clone()).await.is_err());
    }

    #[test]
    fn rejects_ambiguous_cursors() {
        assert!(super::parse_cursor(Some(" 1")).is_err());
        assert!(super::parse_cursor(Some("-1")).is_err());
        assert_eq!(
            super::parse_cursor(Some("12")).expect("cursor should parse"),
            12
        );
    }
}
