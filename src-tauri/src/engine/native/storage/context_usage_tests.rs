use tempfile::TempDir;

use super::*;
use crate::engine::native::provider::{ResponseContent, ResponseMessagePhase};
use crate::engine::{TokenUsage, UserContent};

fn message(id: &str, text: &str) -> ResponseItem {
    ResponseItem::Message {
        id: Some(id.into()),
        role: "assistant".into(),
        content: vec![ResponseContent::OutputText { text: text.into() }],
        phase: Some(ResponseMessagePhase::Commentary),
        internal_chat_message_metadata_passthrough: None,
    }
}

async fn fixture() -> (TempDir, NativeStorage, String, String) {
    let directory = TempDir::new().expect("temporary directory should exist");
    let storage = NativeStorage::default();
    storage
        .initialize_at(directory.path().join("context.sqlite3"))
        .await
        .expect("storage should open");
    let thread = storage
        .create_thread(
            directory.path().display().to_string(),
            None,
            ConversationMode::Codex,
        )
        .await
        .expect("thread should persist");
    let turn = storage
        .begin_turn(
            thread.id.clone(),
            "test-model".into(),
            None,
            ThreadItem::UserMessage {
                id: "user-1".into(),
                content: vec![UserContent::Text {
                    text: "work".into(),
                }],
            },
            ResponseItem::user_content(vec![ResponseContent::InputText {
                text: "work".into(),
            }]),
            "work".into(),
        )
        .await
        .expect("turn should start");
    storage
        .append_provider_item(thread.id.clone(), &message("model-1", "progress"))
        .await
        .expect("model item should persist");
    storage
        .append_thread_item(
            turn.id.clone(),
            ThreadItem::ContextUsage {
                id: "usage-1".into(),
                model: "test-model".into(),
                usage: TokenUsage {
                    input_tokens: 90,
                    output_tokens: 10,
                    total_tokens: 100,
                    cached_input_tokens: 0,
                    reasoning_output_tokens: 0,
                },
                context_window: None,
            },
            None,
        )
        .await
        .expect("usage should persist");
    (directory, storage, thread.id.clone(), turn.id)
}

#[tokio::test]
async fn usage_boundary_survives_partial_responses_restart_and_fork() {
    let (directory, storage, thread_id, turn_id) = fixture().await;
    storage
        .append_provider_item(
            thread_id.clone(),
            &message(
                "partial-2",
                "later completed item from an interrupted response",
            ),
        )
        .await
        .expect("partial response item should persist");
    storage
        .complete_turn(thread_id.clone(), turn_id, TurnStatus::Interrupted, None)
        .await
        .expect("interruption should settle");
    drop(storage);

    let storage = NativeStorage::default();
    storage
        .initialize_at(directory.path().join("context.sqlite3"))
        .await
        .expect("storage should reopen");
    let fork = storage
        .fork_thread(thread_id.clone())
        .await
        .expect("interrupted task should fork");
    for id in [thread_id, fork.id.clone()] {
        let snapshot = storage
            .provider_prompt_snapshot(id)
            .await
            .expect("snapshot should load");
        let usage = snapshot
            .context_usage
            .expect("confirmed sample should persist");
        assert_eq!(usage.history_item_count, 2);
        assert_eq!(usage.usage.total_tokens, 100);
        assert_eq!(snapshot.history.items.len(), 3);
        assert_eq!(snapshot.history.items[2].id(), Some("partial-2"));
    }
}

#[tokio::test]
async fn schema_five_migration_preserves_telemetry_without_inventing_a_boundary() {
    let (directory, storage, thread_id, turn_id) = fixture().await;
    storage
        .complete_turn(thread_id.clone(), turn_id, TurnStatus::Completed, None)
        .await
        .expect("turn should settle");
    drop(storage);
    let path = directory.path().join("context.sqlite3");
    let connection = Connection::open(&path).expect("database should open");
    let original: String = connection
        .query_row(
            "SELECT payload FROM thread_items WHERE item_id = 'usage-1'",
            [],
            |row| row.get(0),
        )
        .expect("usage should exist");
    connection
        .execute_batch(
            "ALTER TABLE thread_items DROP COLUMN provider_item_count; PRAGMA user_version = 5;",
        )
        .expect("schema five fixture should be created");
    drop(connection);

    let storage = NativeStorage::default();
    storage
        .initialize_at(path.clone())
        .await
        .expect("schema five should migrate");
    let snapshot = storage
        .provider_prompt_snapshot(thread_id)
        .await
        .expect("snapshot should load");
    assert!(snapshot.context_usage.is_none());
    assert_eq!(snapshot.history.items.len(), 2);
    let connection = Connection::open(&path).expect("database should open");
    let retained: String = connection
        .query_row(
            "SELECT payload FROM thread_items WHERE item_id = 'usage-1'",
            [],
            |row| row.get(0),
        )
        .expect("usage should remain");
    assert_eq!(retained, original);
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .expect("schema should be readable");
    assert_eq!(version, DATABASE_SCHEMA_VERSION);
    assert_eq!(
        table_columns(&connection, "thread_items").expect("columns should be readable"),
        THREAD_ITEM_COLUMNS
    );
}

#[tokio::test]
async fn invalid_schema_five_is_rejected_without_a_partial_migration() {
    let (directory, storage, _, _) = fixture().await;
    drop(storage);
    let path = directory.path().join("context.sqlite3");
    let connection = Connection::open(&path).expect("database should open");
    connection.execute_batch("ALTER TABLE thread_items DROP COLUMN provider_item_count; ALTER TABLE thread_items ADD COLUMN unexpected TEXT; PRAGMA user_version = 5;").expect("invalid schema fixture should be created");
    drop(connection);
    let storage = NativeStorage::default();
    assert!(storage.initialize_at(path.clone()).await.is_err());
    let connection = Connection::open(path).expect("database should reopen");
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .expect("schema should be readable");
    assert_eq!(version, 5);
    assert_eq!(
        table_columns(&connection, "thread_items").expect("columns should be readable"),
        "sequence,turn_id,item_id,payload,unexpected"
    );
    let items: i64 = connection
        .query_row("SELECT COUNT(*) FROM thread_items", [], |row| row.get(0))
        .expect("items should remain");
    assert_eq!(items, 2);
}
