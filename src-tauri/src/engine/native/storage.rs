use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension as _, Transaction, params};
use serde::Serialize;
use serde::de::DeserializeOwned;
use tauri::{AppHandle, Manager as _};
use tokio::sync::RwLock;
use uuid::Uuid;

use super::context_window::ContextUsageSnapshot;
use super::provider::ResponseItem;
use crate::engine::{
    AppConfig, CodexThread, CompletedTurn, ConfigReadResponse, ConfigUpdate, ConfigUpdateResponse,
    DesktopPreferences, OperationAck, ThreadActiveFlag, ThreadItem, ThreadListResponse,
    ThreadStatus, ThreadTurn, TurnStatus, TurnSummary,
};
use crate::error::AppError;

const DATABASE_FILE_NAME: &str = "native-state-v1.sqlite3";
const DATABASE_SCHEMA_VERSION: i64 = 2;
const DATABASE_APPLICATION_ID: i64 = 1_128_552_526;
const DATABASE_TABLES: &str = "app_config,provider_items,thread_items,threads,turns";
const THREAD_COLUMNS: &str = "id,cwd,name,preview,archived,created_at,updated_at,project_path";
const THREAD_PAGE_SIZE: usize = 50;
const MAX_CURSOR_BYTES: usize = 20;
const MAX_ITEM_BYTES: usize = 2 * 1_048_576;
const MAX_HISTORY_BYTES: usize = 32 * 1_048_576;
const MAX_HISTORY_ITEMS: usize = 20_000;
const MAX_THREAD_TURNS: usize = 1_000;
const MAX_THREAD_NAME_BYTES: usize = 256;
const MAX_PREVIEW_BYTES: usize = 512;
const MAX_DEVELOPER_INSTRUCTIONS_BYTES: usize = 262_144;
const MAX_IDENTIFIER_BYTES: usize = 256;

#[derive(Debug, Default)]
pub struct NativeStorage {
    database_path: RwLock<Option<PathBuf>>,
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
        if self.database_path.read().await.as_ref() == Some(&database_path) {
            return Ok(());
        }
        let parent = database_path
            .parent()
            .ok_or_else(|| AppError::Storage("database path has no parent".into()))?;
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| AppError::Storage(error.to_string()))?;

        let path = database_path.clone();
        run_blocking(move || {
            let mut connection = open_connection(&path)?;
            let version: i64 = connection
                .query_row("PRAGMA user_version", [], |row| row.get(0))
                .map_err(storage_error)?;
            let application_id: i64 = connection
                .query_row("PRAGMA application_id", [], |row| row.get(0))
                .map_err(storage_error)?;
            if version == 0 && application_id == 0 {
                initialize_database(&mut connection)?;
            } else {
                migrate_database(&mut connection, version, application_id)?;
                let current_version: i64 = connection
                    .query_row("PRAGMA user_version", [], |row| row.get(0))
                    .map_err(storage_error)?;
                validate_database(&connection, current_version, application_id)?;
            }

            connection
                .execute(
                    "UPDATE turns SET status = 'interrupted', updated_at = ?1
                     WHERE status = 'inProgress'",
                    [unix_timestamp()?],
                )
                .map_err(storage_error)?;
            Ok(())
        })
        .await?;

        *self.database_path.write().await = Some(database_path);
        Ok(())
    }

    pub async fn create_thread(
        &self,
        cwd: String,
        project_path: Option<String>,
    ) -> Result<CodexThread, AppError> {
        let path = self.path().await?;
        run_blocking(move || {
            let connection = open_connection(&path)?;
            let id = Uuid::now_v7().to_string();
            let now = unix_timestamp()?;
            connection
                .execute(
                    "INSERT INTO threads
                         (id, cwd, project_path, name, preview, archived, created_at, updated_at)
                     VALUES (?1, ?2, ?3, NULL, '', 0, ?4, ?4)",
                    params![id, cwd, project_path, now],
                )
                .map_err(storage_error)?;
            read_thread(&connection, &id)
        })
        .await
    }

    pub async fn list_threads(
        &self,
        cursor: Option<String>,
        archived: bool,
    ) -> Result<ThreadListResponse, AppError> {
        let offset = parse_cursor(cursor.as_deref())?;
        let path = self.path().await?;
        run_blocking(move || {
            let connection = open_connection(&path)?;
            let requested = THREAD_PAGE_SIZE + 1;
            let requested_sql = i64::try_from(requested)
                .map_err(|error| AppError::Storage(error.to_string()))?;
            let offset_sql = i64::try_from(offset)
                .map_err(|error| AppError::Protocol(format!("thread cursor is too large: {error}")))?;
            let mut statement = connection
                .prepare(
                    "SELECT id, cwd, project_path, name, preview, created_at, updated_at,
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
                        name: row.get(3)?,
                        preview: row.get(4)?,
                        created_at: row.get(5)?,
                        updated_at: row.get(6)?,
                        active: row.get(7)?,
                    })
                })
                .map_err(storage_error)?;
            let mut data = rows
                .collect::<Result<Vec<_>, _>>()
                .map_err(storage_error)?;
            let has_more = data.len() > THREAD_PAGE_SIZE;
            data.truncate(THREAD_PAGE_SIZE);
            let data = data.into_iter().map(ThreadHeader::without_turns).collect();
            Ok(ThreadListResponse {
                data,
                next_cursor: has_more.then(|| (offset + THREAD_PAGE_SIZE).to_string()),
            })
        })
        .await
    }

    pub async fn read_thread(&self, thread_id: String) -> Result<CodexThread, AppError> {
        let path = self.path().await?;
        run_blocking(move || {
            let connection = open_connection(&path)?;
            read_thread(&connection, &thread_id)
        })
        .await
    }

    pub async fn set_thread_name(
        &self,
        thread_id: String,
        name: String,
    ) -> Result<CodexThread, AppError> {
        validate_text("thread name", &name, MAX_THREAD_NAME_BYTES)?;
        let path = self.path().await?;
        run_blocking(move || {
            let connection = open_connection(&path)?;
            let changed = connection
                .execute(
                    "UPDATE threads SET name = ?1, updated_at = ?2
                     WHERE id = ?3 AND archived = 0",
                    params![name, unix_timestamp()?, thread_id],
                )
                .map_err(storage_error)?;
            require_changed(changed, "thread")?;
            read_thread(&connection, &thread_id)
        })
        .await
    }

    pub async fn archive_thread(&self, thread_id: String) -> Result<OperationAck, AppError> {
        let path = self.path().await?;
        run_blocking(move || {
            let connection = open_connection(&path)?;
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

    pub async fn unarchive_thread(&self, thread_id: String) -> Result<CodexThread, AppError> {
        let path = self.path().await?;
        run_blocking(move || {
            let connection = open_connection(&path)?;
            let changed = connection
                .execute(
                    "UPDATE threads SET archived = 0, updated_at = ?1
                     WHERE id = ?2 AND archived = 1",
                    params![unix_timestamp()?, thread_id],
                )
                .map_err(storage_error)?;
            require_changed(changed, "archived thread")?;
            read_thread(&connection, &thread_id)
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
        let path = self.path().await?;
        run_blocking(move || {
            let mut connection = open_connection(&path)?;
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

    pub async fn fork_thread(&self, source_thread_id: String) -> Result<CodexThread, AppError> {
        let path = self.path().await?;
        run_blocking(move || {
            let mut connection = open_connection(&path)?;
            let transaction = connection.transaction().map_err(storage_error)?;
            let source = transaction
                .query_row(
                    "SELECT cwd, project_path, name, preview
                     FROM threads
                     WHERE id = ?1",
                    [&source_thread_id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, Option<String>>(1)?,
                            row.get::<_, Option<String>>(2)?,
                            row.get::<_, String>(3)?,
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

            let turn_count: i64 = transaction
                .query_row(
                    "SELECT COUNT(*) FROM turns WHERE thread_id = ?1",
                    [&source_thread_id],
                    |row| row.get(0),
                )
                .map_err(storage_error)?;
            if turn_count > MAX_THREAD_TURNS as i64 {
                return Err(AppError::Storage(format!(
                    "source thread exceeds {MAX_THREAD_TURNS} turns"
                )));
            }
            let provider_item_count: i64 = transaction
                .query_row(
                    "SELECT COUNT(*) FROM provider_items WHERE thread_id = ?1",
                    [&source_thread_id],
                    |row| row.get(0),
                )
                .map_err(storage_error)?;
            if provider_item_count > MAX_HISTORY_ITEMS as i64 {
                return Err(AppError::Storage(format!(
                    "source provider history exceeds {MAX_HISTORY_ITEMS} items"
                )));
            }

            let fork_id = Uuid::now_v7().to_string();
            let now = unix_timestamp()?;
            transaction
                .execute(
                    "INSERT INTO threads
                         (id, cwd, project_path, name, preview, archived, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?6)",
                    params![fork_id, source.0, source.1, source.2, source.3, now],
                )
                .map_err(storage_error)?;

            let source_turns = {
                let mut statement = transaction
                    .prepare(
                        "SELECT id, status, model, reasoning_effort, error, created_at, updated_at
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
                            row.get::<_, Option<String>>(3)?,
                            row.get::<_, Option<String>>(4)?,
                            row.get::<_, i64>(5)?,
                            row.get::<_, i64>(6)?,
                        ))
                    })
                    .map_err(storage_error)?;
                rows.collect::<Result<Vec<_>, _>>().map_err(storage_error)?
            };
            for (source_turn_id, status, model, effort, error, created_at, updated_at) in
                source_turns
            {
                let fork_turn_id = Uuid::now_v7().to_string();
                transaction
                    .execute(
                        "INSERT INTO turns
                             (id, thread_id, status, model, reasoning_effort, error, created_at, updated_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                        params![
                            fork_turn_id,
                            fork_id,
                            status,
                            model,
                            effort,
                            error,
                            created_at,
                            updated_at
                        ],
                    )
                    .map_err(storage_error)?;
                transaction
                    .execute(
                        "INSERT INTO thread_items (turn_id, item_id, payload)
                         SELECT ?1, item_id, payload
                         FROM thread_items
                         WHERE turn_id = ?2
                         ORDER BY sequence",
                        params![fork_turn_id, source_turn_id],
                    )
                    .map_err(storage_error)?;
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
            transaction.commit().map_err(storage_error)?;
            read_thread(&connection, &fork_id)
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
        let item_id = user_item.id().to_string();
        let item_payload = encode_bounded(&user_item, MAX_ITEM_BYTES, "thread item")?;
        let provider_payload = encode_bounded(&provider_item, MAX_ITEM_BYTES, "provider item")?;
        let preview = truncate_utf8(preview.trim(), MAX_PREVIEW_BYTES);
        let path = self.path().await?;
        run_blocking(move || {
            let mut connection = open_connection(&path)?;
            let transaction = connection.transaction().map_err(storage_error)?;
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
                         (id, thread_id, status, model, reasoning_effort, error, created_at, updated_at)
                     VALUES (?1, ?2, 'inProgress', ?3, ?4, NULL, ?5, ?5)",
                    params![turn_id, thread_id, model, reasoning_effort, now],
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
        let path = self.path().await?;
        run_blocking(move || {
            let mut connection = open_connection(&path)?;
            let transaction = connection.transaction().map_err(storage_error)?;
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
                         (id, thread_id, status, model, reasoning_effort, error, created_at, updated_at)
                     VALUES (?1, ?2, 'inProgress', ?3, ?4, NULL, ?5, ?5)",
                    params![turn_id, thread_id, model, reasoning_effort, now],
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
            })
        })
        .await
    }

    pub async fn append_thread_item(
        &self,
        turn_id: String,
        item: ThreadItem,
    ) -> Result<(), AppError> {
        let item_id = item.id().to_string();
        let payload = encode_bounded(&item, MAX_ITEM_BYTES, "thread item")?;
        let path = self.path().await?;
        run_blocking(move || {
            let connection = open_connection(&path)?;
            connection
                .execute(
                    "INSERT INTO thread_items (turn_id, item_id, payload) VALUES (?1, ?2, ?3)",
                    params![turn_id, item_id, payload],
                )
                .map_err(storage_error)?;
            Ok(())
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
        let item_id = user_item.id().to_string();
        let item_payload = encode_bounded(&user_item, MAX_ITEM_BYTES, "steered thread item")?;
        let provider_payload =
            encode_bounded(&provider_item, MAX_ITEM_BYTES, "steered provider item")?;
        let path = self.path().await?;
        run_blocking(move || {
            let mut connection = open_connection(&path)?;
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
        item: ResponseItem,
    ) -> Result<(), AppError> {
        let payload = encode_bounded(&item, MAX_ITEM_BYTES, "provider item")?;
        let path = self.path().await?;
        run_blocking(move || {
            let connection = open_connection(&path)?;
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

    pub async fn provider_history(&self, thread_id: String) -> Result<Vec<ResponseItem>, AppError> {
        let path = self.path().await?;
        run_blocking(move || {
            let connection = open_connection(&path)?;
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
            let mut statement = connection
                .prepare(
                    "SELECT payload FROM provider_items WHERE thread_id = ?1 ORDER BY sequence",
                )
                .map_err(storage_error)?;
            let rows = statement
                .query_map([thread_id], |row| row.get::<_, String>(0))
                .map_err(storage_error)?;
            let mut total_bytes = 0;
            let mut total_items = 0;
            decode_rows(rows, "provider history", &mut total_bytes, &mut total_items)
        })
        .await
    }

    pub async fn replace_provider_history(
        &self,
        thread_id: String,
        items: Vec<ResponseItem>,
    ) -> Result<(), AppError> {
        let payloads = encode_provider_history(items)?;
        let path = self.path().await?;
        run_blocking(move || {
            let mut connection = open_connection(&path)?;
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
        let path = self.path().await?;
        run_blocking(move || {
            let mut connection = open_connection(&path)?;
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
        let path = self.path().await?;
        run_blocking(move || {
            let connection = open_connection(&path)?;
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
        let path = self.path().await?;
        run_blocking(move || {
            let mut connection = open_connection(&path)?;
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
        let path = self.path().await?;
        run_blocking(move || {
            let connection = open_connection(&path)?;
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
        let path = self.path().await?;
        run_blocking(move || {
            let mut connection = open_connection(&path)?;
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

    async fn path(&self) -> Result<PathBuf, AppError> {
        self.database_path
            .read()
            .await
            .clone()
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
    name: Option<String>,
    preview: String,
    created_at: i64,
    updated_at: i64,
    active: bool,
}

impl ThreadHeader {
    fn without_turns(self) -> CodexThread {
        CodexThread {
            id: self.id,
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
            turns: Vec::new(),
        }
    }
}

fn read_thread(connection: &Connection, thread_id: &str) -> Result<CodexThread, AppError> {
    let header = connection
        .query_row(
            "SELECT id, cwd, project_path, name, preview, created_at, updated_at,
                    EXISTS(SELECT 1 FROM turns WHERE thread_id = threads.id AND status = 'inProgress')
             FROM threads WHERE id = ?1 AND archived = 0",
            [thread_id],
            |row| {
                Ok(ThreadHeader {
                    id: row.get(0)?,
                    cwd: row.get(1)?,
                    project_path: row.get(2)?,
                    name: row.get(3)?,
                    preview: row.get(4)?,
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                    active: row.get(7)?,
                })
            },
        )
        .optional()
        .map_err(storage_error)?
        .ok_or_else(|| AppError::State("thread does not exist or is archived".into()))?;
    let mut turns_statement = connection
        .prepare(
            "SELECT id, status, error, created_at, updated_at
             FROM turns WHERE thread_id = ?1 ORDER BY created_at, id",
        )
        .map_err(storage_error)?;
    let turn_rows = turns_statement
        .query_map([thread_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })
        .map_err(storage_error)?;
    let mut turns = Vec::new();
    let mut total_item_bytes = 0;
    let mut total_items = 0;
    for turn in turn_rows {
        if turns.len() >= MAX_THREAD_TURNS {
            return Err(AppError::Storage(format!(
                "thread exceeds {MAX_THREAD_TURNS} turns"
            )));
        }
        let (turn_id, status, error, created_at, updated_at) = turn.map_err(storage_error)?;
        let status = parse_status(&status)?;
        if (status == TurnStatus::Failed) != error.is_some() {
            return Err(AppError::Storage(format!(
                "turn `{turn_id}` has an incoherent failure status"
            )));
        }
        let mut items_statement = connection
            .prepare("SELECT payload FROM thread_items WHERE turn_id = ?1 ORDER BY sequence")
            .map_err(storage_error)?;
        let item_rows = items_statement
            .query_map([&turn_id], |row| row.get::<_, String>(0))
            .map_err(storage_error)?;
        let items = decode_rows(
            item_rows,
            "thread items",
            &mut total_item_bytes,
            &mut total_items,
        )?;
        turns.push(ThreadTurn {
            id: turn_id,
            items,
            status,
            error,
            created_at,
            updated_at,
        });
    }
    let mut thread = header.without_turns();
    thread.turns = turns;
    Ok(thread)
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

fn truncate_utf8(value: &str, maximum_bytes: usize) -> String {
    if value.len() <= maximum_bytes {
        return value.to_string();
    }
    let mut end = maximum_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
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

fn decode_rows<T: DeserializeOwned>(
    rows: rusqlite::MappedRows<'_, impl FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<String>>,
    label: &str,
    total_bytes: &mut usize,
    total_items: &mut usize,
) -> Result<Vec<T>, AppError> {
    let mut values = Vec::new();
    for payload in rows {
        let payload = payload.map_err(storage_error)?;
        *total_bytes = total_bytes
            .checked_add(payload.len())
            .ok_or_else(|| AppError::Storage(format!("stored {label} size overflow")))?;
        if *total_bytes > MAX_HISTORY_BYTES {
            return Err(AppError::Storage(format!(
                "stored {label} exceeds {MAX_HISTORY_BYTES} bytes"
            )));
        }
        *total_items = total_items
            .checked_add(1)
            .ok_or_else(|| AppError::Storage(format!("stored {label} item count overflow")))?;
        if *total_items > MAX_HISTORY_ITEMS {
            return Err(AppError::Storage(format!(
                "stored {label} exceeds {MAX_HISTORY_ITEMS} items"
            )));
        }
        values.push(decode_bounded(&payload, MAX_ITEM_BYTES, label)?);
    }
    Ok(values)
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
                 project_path TEXT CHECK (project_path IS NULL OR project_path = cwd)
             );
             CREATE TABLE turns (
                 id TEXT PRIMARY KEY,
                 thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
                 status TEXT NOT NULL CHECK (status IN ('completed', 'failed', 'inProgress', 'interrupted')),
                 model TEXT NOT NULL,
                 reasoning_effort TEXT,
                 error TEXT,
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL
             );
             CREATE INDEX turns_thread_created ON turns(thread_id, created_at, id);
             CREATE TABLE thread_items (
                 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                 turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
                 item_id TEXT NOT NULL,
                 payload TEXT NOT NULL,
                 UNIQUE(turn_id, item_id)
             );
             CREATE INDEX thread_items_turn_sequence ON thread_items(turn_id, sequence);
             CREATE TABLE provider_items (
                 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                 thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
                 payload TEXT NOT NULL
             );
             CREATE INDEX provider_items_thread_sequence
                 ON provider_items(thread_id, sequence);
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

fn migrate_database(
    connection: &mut Connection,
    version: i64,
    application_id: i64,
) -> Result<(), AppError> {
    if application_id != DATABASE_APPLICATION_ID {
        return Err(AppError::Storage(format!(
            "database identity is unsupported; expected application {DATABASE_APPLICATION_ID}, received application {application_id}"
        )));
    }
    if version == DATABASE_SCHEMA_VERSION {
        return Ok(());
    }
    if version != 1 {
        return Err(AppError::Storage(format!(
            "database schema {version} cannot be migrated to {DATABASE_SCHEMA_VERSION}"
        )));
    }
    let tables = database_tables(connection)?;
    if tables != DATABASE_TABLES {
        return Err(AppError::Storage(format!(
            "database tables do not match schema {version}: {tables}"
        )));
    }

    let transaction = connection.transaction().map_err(storage_error)?;
    transaction
        .execute_batch(
            "ALTER TABLE threads ADD COLUMN project_path TEXT
                 CHECK (project_path IS NULL OR project_path = cwd);
             UPDATE threads SET project_path = cwd;",
        )
        .map_err(storage_error)?;
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

fn open_connection(path: &Path) -> Result<Connection, AppError> {
    let connection = Connection::open(path).map_err(storage_error)?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(storage_error)?;
    connection
        .execute_batch(
            "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA wal_checkpoint(PASSIVE);",
        )
        .map_err(storage_error)?;
    Ok(connection)
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

    use super::{DATABASE_APPLICATION_ID, DATABASE_SCHEMA_VERSION, NativeStorage};
    use crate::engine::native::provider::{ResponseContent, ResponseItem};
    use crate::engine::{AppConfig, ThreadItem, TokenUsage, TurnStatus, UserContent};

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
            .create_thread(project_path.clone(), Some(project_path.clone()))
            .await
            .expect("thread should persist");
        let loaded = storage
            .read_thread(thread.id.clone())
            .await
            .expect("thread should load");
        assert_eq!(loaded.id, thread.id);
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
                     (id, thread_id, status, model, reasoning_effort, error, created_at, updated_at)
                 VALUES (?1, ?2, 'failed', 'gpt-test', NULL, ?3, 1, 1)",
                params!["failed-turn", thread.id, "provider stream failed"],
            )
            .expect("failed turn fixture should persist");
        drop(connection);

        let loaded = storage
            .read_thread(thread.id)
            .await
            .expect("thread with failed turn should load");
        let failed_turn = loaded.turns.first().expect("failed turn should be present");
        assert_eq!(failed_turn.status, TurnStatus::Failed);
        assert_eq!(failed_turn.error.as_deref(), Some("provider stream failed"));
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
            .create_thread(workspace.display().to_string(), None)
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
        assert_eq!(fork.project_path, None);
        assert!(listed.data.iter().all(|entry| entry.project_path.is_none()));
        assert!(listed.data.iter().all(|entry| entry.cwd == thread.cwd));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn migrates_existing_threads_as_project_threads() {
        let directory = TempDir::new().expect("temporary directory should be created");
        let database_path = directory.path().join("migration.sqlite3");
        let cwd = directory.path().display().to_string();
        let connection = Connection::open(&database_path).expect("database should reopen");
        connection
            .execute_batch(
                "CREATE TABLE threads (
                     id TEXT PRIMARY KEY,
                     cwd TEXT NOT NULL,
                     name TEXT,
                     preview TEXT NOT NULL,
                     archived INTEGER NOT NULL,
                     created_at INTEGER NOT NULL,
                     updated_at INTEGER NOT NULL
                 );
                 CREATE TABLE turns (
                     id TEXT PRIMARY KEY,
                     thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
                     status TEXT NOT NULL,
                     model TEXT NOT NULL,
                     reasoning_effort TEXT,
                     error TEXT,
                     created_at INTEGER NOT NULL,
                     updated_at INTEGER NOT NULL
                 );
                 CREATE TABLE thread_items (
                     sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                     turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
                     item_id TEXT NOT NULL,
                     payload TEXT NOT NULL
                 );
                 CREATE TABLE provider_items (
                     sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                     thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
                     payload TEXT NOT NULL
                 );
                 CREATE TABLE app_config (
                     singleton INTEGER PRIMARY KEY,
                     version INTEGER NOT NULL,
                     payload TEXT NOT NULL
                 );",
            )
            .expect("schema-one tables should be created");
        let config = serde_json::to_string(&AppConfig::default())
            .expect("default configuration should encode");
        connection
            .execute(
                "INSERT INTO app_config (singleton, version, payload) VALUES (1, 1, ?1)",
                [&config],
            )
            .expect("schema-one configuration should persist");
        connection
            .execute(
                "INSERT INTO threads
                     (id, cwd, name, preview, archived, created_at, updated_at)
                 VALUES ('legacy-thread', ?1, NULL, '', 0, 1, 1)",
                [&cwd],
            )
            .expect("schema-one thread should persist");
        connection
            .pragma_update(None, "application_id", DATABASE_APPLICATION_ID)
            .expect("application id should persist");
        connection
            .pragma_update(None, "user_version", 1)
            .expect("schema version should persist");
        drop(connection);

        let migrated = NativeStorage::default();
        migrated
            .initialize_at(database_path.clone())
            .await
            .expect("schema one should migrate");
        let loaded = migrated
            .read_thread("legacy-thread".into())
            .await
            .expect("migrated thread should load");
        assert_eq!(loaded.project_path.as_deref(), Some(cwd.as_str()));
        let connection = Connection::open(database_path).expect("database should reopen");
        let schema_version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("schema version should be readable");
        assert_eq!(schema_version, DATABASE_SCHEMA_VERSION);
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
                thread.id,
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
            .complete_turn(thread.id, turn.id, TurnStatus::Completed, None)
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
            )
            .await
            .expect("compaction marker should persist");
        assert!(
            storage
                .latest_context_usage(thread.id)
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
                .latest_context_usage(thread.id)
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
            .provider_history(thread.id)
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
                    thread.id,
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
        assert!(storage.read_thread(thread.id).await.is_err());
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
        assert!(storage.read_thread(fork.id).await.is_err());
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
