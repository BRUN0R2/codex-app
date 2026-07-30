use std::path::PathBuf;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use rusqlite::Connection;
use rusqlite::params;
use tauri::AppHandle;
use tauri::Manager as _;
use tokio::sync::RwLock;

use crate::error::AppError;

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
        self.initialize_at(directory.join("native-engine.sqlite3"))
            .await
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
        tokio::task::spawn_blocking(move || -> Result<(), AppError> {
            let connection =
                Connection::open(path).map_err(|error| AppError::Storage(error.to_string()))?;
            connection
                .execute_batch(
                    "PRAGMA journal_mode = WAL;
                     PRAGMA foreign_keys = ON;
                     CREATE TABLE IF NOT EXISTS engine_threads (
                         id TEXT PRIMARY KEY,
                         workspace TEXT NOT NULL,
                         created_at INTEGER NOT NULL,
                         updated_at INTEGER NOT NULL
                     );
                     CREATE TABLE IF NOT EXISTS engine_events (
                         sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                         thread_id TEXT,
                         operation TEXT NOT NULL,
                         created_at INTEGER NOT NULL
                     );
                     PRAGMA user_version = 1;",
                )
                .map_err(|error| AppError::Storage(error.to_string()))?;
            Ok(())
        })
        .await
        .map_err(|error| AppError::Storage(error.to_string()))??;

        *self.database_path.write().await = Some(database_path);
        Ok(())
    }

    pub async fn record_operation(
        &self,
        operation: &str,
        thread_id: Option<&str>,
    ) -> Result<(), AppError> {
        let path = self.path().await?;
        let operation = operation.to_string();
        let thread_id = thread_id.map(str::to_string);
        let created_at = unix_timestamp()?;
        tokio::task::spawn_blocking(move || -> Result<(), AppError> {
            let connection =
                Connection::open(path).map_err(|error| AppError::Storage(error.to_string()))?;
            connection
                .execute(
                    "INSERT INTO engine_events (thread_id, operation, created_at)
                     VALUES (?1, ?2, ?3)",
                    params![thread_id, operation, created_at],
                )
                .map_err(|error| AppError::Storage(error.to_string()))?;
            Ok(())
        })
        .await
        .map_err(|error| AppError::Storage(error.to_string()))?
    }

    pub async fn upsert_thread(&self, id: &str, workspace: &str) -> Result<(), AppError> {
        let path = self.path().await?;
        let id = id.to_string();
        let workspace = workspace.to_string();
        let now = unix_timestamp()?;
        tokio::task::spawn_blocking(move || -> Result<(), AppError> {
            let connection =
                Connection::open(path).map_err(|error| AppError::Storage(error.to_string()))?;
            connection
                .execute(
                    "INSERT INTO engine_threads (id, workspace, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?3)
                     ON CONFLICT(id) DO UPDATE SET
                         workspace = excluded.workspace,
                         updated_at = excluded.updated_at",
                    params![id, workspace, now],
                )
                .map_err(|error| AppError::Storage(error.to_string()))?;
            Ok(())
        })
        .await
        .map_err(|error| AppError::Storage(error.to_string()))?
    }

    async fn path(&self) -> Result<PathBuf, AppError> {
        self.database_path
            .read()
            .await
            .clone()
            .ok_or_else(|| AppError::Storage("native storage is not initialized".into()))
    }
}

fn unix_timestamp() -> Result<i64, AppError> {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| AppError::Storage(error.to_string()))?
        .as_secs();
    i64::try_from(seconds).map_err(|error| AppError::Storage(error.to_string()))
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;
    use uuid::Uuid;

    use super::NativeStorage;

    #[tokio::test(flavor = "current_thread")]
    async fn initializes_schema_and_records_metadata_without_payloads() {
        let database_path = std::env::temp_dir().join(format!(
            "codex-app-native-storage-{}.sqlite3",
            Uuid::now_v7()
        ));
        let storage = NativeStorage::default();
        storage
            .initialize_at(database_path.clone())
            .await
            .expect("storage should initialize");
        storage
            .upsert_thread("thread-1", "C:\\workspace")
            .await
            .expect("thread metadata should persist");
        storage
            .record_operation("turn.start", Some("thread-1"))
            .await
            .expect("operation metadata should persist");

        let connection = Connection::open(&database_path).expect("database should open");
        let thread_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM engine_threads", [], |row| row.get(0))
            .expect("thread count should be readable");
        let event_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM engine_events", [], |row| row.get(0))
            .expect("event count should be readable");
        assert_eq!(thread_count, 1);
        assert_eq!(event_count, 1);
        drop(connection);

        std::fs::remove_file(&database_path).expect("test database should be removable");
    }
}
