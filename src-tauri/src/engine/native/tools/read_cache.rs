use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::sync::{Mutex, OnceCell};

use super::{
    ListFilesArgs, ReadFileArgs, ReadOutputArgs, ReadOutputSelector, SearchTextArgs,
    StoredToolOutput, ToolOperation,
};
use crate::engine::native::output_compaction::TextOutputKind;
use crate::error::AppError;

type CacheEntry = OnceCell<Result<CachedReadOutput, AppError>>;

const READ_CACHE_MAXIMUM_ENTRIES: usize = 64;
const READ_CACHE_MAXIMUM_BYTES: usize = 64 * 1_048_576;

#[derive(Default)]
pub(in crate::engine::native) struct ReadToolCache {
    state: Mutex<ReadCacheState>,
}

#[derive(Default)]
struct ReadCacheState {
    slots: HashMap<ReadToolCacheKey, ReadCacheSlot>,
    insertion_order: VecDeque<ReadToolCacheKey>,
    cached_bytes: usize,
}

struct ReadCacheSlot {
    entry: Arc<CacheEntry>,
    accounted: bool,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(in crate::engine::native) struct ReadToolCacheKey {
    workspace: PathBuf,
    thread_id: String,
    operation: ReadToolOperationKey,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
enum ReadToolOperationKey {
    ReadFile {
        path: String,
        start_line: u32,
        end_line: u32,
    },
    ListFiles {
        path: String,
        max_depth: u8,
    },
    SearchText {
        path: String,
        query: String,
        case_sensitive: bool,
    },
    ReadOutputPage {
        output_id: String,
        cursor: Option<String>,
    },
    SearchOutput {
        output_id: String,
        query: String,
    },
}

#[derive(Clone, Debug)]
pub(super) enum CachedReadOutput {
    Text {
        output: Arc<str>,
        kind: TextOutputKind,
    },
    OutputPage(Arc<str>),
}

impl ReadToolCache {
    pub(super) async fn get_or_execute<F, Fut>(
        &self,
        key: ReadToolCacheKey,
        execute: F,
    ) -> Result<CachedReadOutput, AppError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<CachedReadOutput, AppError>>,
    {
        let entry = {
            let mut state = self.state.lock().await;
            match state.slots.get(&key) {
                Some(slot) => Arc::clone(&slot.entry),
                None => {
                    let slot = ReadCacheSlot {
                        entry: Arc::new(OnceCell::new()),
                        accounted: false,
                    };
                    let entry = Arc::clone(&slot.entry);
                    state.slots.insert(key.clone(), slot);
                    state.insertion_order.push_back(key.clone());
                    entry
                }
            }
        };
        let result = entry.get_or_init(execute).await.clone();
        self.account_completed_entry(&key, &result).await;
        result
    }

    async fn account_completed_entry(
        &self,
        key: &ReadToolCacheKey,
        result: &Result<CachedReadOutput, AppError>,
    ) {
        let Ok(output) = result else {
            return;
        };
        let mut state = self.state.lock().await;
        let Some(slot) = state.slots.get_mut(key) else {
            return;
        };
        if slot.accounted {
            return;
        }
        slot.accounted = true;
        state.cached_bytes = state.cached_bytes.saturating_add(output.byte_len());
        while state.slots.len() > READ_CACHE_MAXIMUM_ENTRIES
            || state.cached_bytes > READ_CACHE_MAXIMUM_BYTES
        {
            let Some(oldest) = state.insertion_order.pop_front() else {
                break;
            };
            if oldest == *key {
                state.insertion_order.push_front(oldest);
                break;
            }
            let Some(evicted) = state.slots.remove(&oldest) else {
                continue;
            };
            if let Some(Ok(cached)) = evicted.entry.get() {
                state.cached_bytes = state.cached_bytes.saturating_sub(cached.byte_len());
            }
        }
    }
}

impl ReadToolCacheKey {
    pub(super) fn from_operation(
        workspace: &Path,
        thread_id: &str,
        operation: &ToolOperation,
    ) -> Option<Self> {
        let operation = match operation {
            ToolOperation::ReadFile(ReadFileArgs {
                path,
                start_line,
                end_line,
            }) => ReadToolOperationKey::ReadFile {
                path: path.clone(),
                start_line: *start_line,
                end_line: *end_line,
            },
            ToolOperation::ListFiles(ListFilesArgs { path, max_depth }) => {
                ReadToolOperationKey::ListFiles {
                    path: path.clone(),
                    max_depth: *max_depth,
                }
            }
            ToolOperation::SearchText(SearchTextArgs {
                path,
                query,
                case_sensitive,
            }) => ReadToolOperationKey::SearchText {
                path: path.clone(),
                query: query.clone(),
                case_sensitive: *case_sensitive,
            },
            ToolOperation::ReadOutput(ReadOutputArgs {
                output_id,
                selector,
            }) => match selector {
                ReadOutputSelector::Page { cursor } => ReadToolOperationKey::ReadOutputPage {
                    output_id: output_id.clone(),
                    cursor: cursor.clone(),
                },
                ReadOutputSelector::Search { query } => ReadToolOperationKey::SearchOutput {
                    output_id: output_id.clone(),
                    query: query.clone(),
                },
            },
            ToolOperation::ApplyPatch(_)
            | ToolOperation::Browser(_)
            | ToolOperation::ViewImage(_)
            | ToolOperation::EditFile(_)
            | ToolOperation::WriteFile(_)
            | ToolOperation::ExecCommand(_)
            | ToolOperation::PollCommand(_)
            | ToolOperation::UpdatePlan { .. }
            | ToolOperation::CodeExec(_)
            | ToolOperation::CodeWait(_)
            | ToolOperation::MultiAgent(_) => return None,
        };
        Some(Self {
            workspace: workspace.to_path_buf(),
            thread_id: thread_id.to_string(),
            operation,
        })
    }
}

impl CachedReadOutput {
    fn byte_len(&self) -> usize {
        match self {
            Self::Text { output, .. } | Self::OutputPage(output) => output.len(),
        }
    }

    pub(super) fn text(output: String, kind: TextOutputKind) -> Self {
        Self::Text {
            output: Arc::from(output),
            kind,
        }
    }

    pub(super) fn output_page(output: String) -> Self {
        Self::OutputPage(Arc::from(output))
    }

    pub(super) fn into_stored_output(self) -> StoredToolOutput {
        match self {
            Self::Text { output, kind } => StoredToolOutput::Text {
                output: output.as_ref().to_string(),
                kind,
            },
            Self::OutputPage(output) => StoredToolOutput::OutputPage(output.as_ref().to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::path::Path;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    use futures_util::future::join_all;

    use super::{CachedReadOutput, READ_CACHE_MAXIMUM_ENTRIES, ReadToolCache, ReadToolCacheKey};
    use crate::engine::native::output_compaction::{ProviderOutputBudget, TextOutputKind};
    use crate::engine::native::tools::ToolRegistry;
    use crate::error::AppError;

    #[tokio::test]
    async fn identical_in_flight_reads_execute_once() {
        let registry = ToolRegistry;
        let prepared = registry
            .prepare(
                "read-1".into(),
                "read_file",
                r#"{"path":"src/lib.rs","start_line":1,"end_line":20}"#,
            )
            .expect("read should prepare");
        let key = ReadToolCacheKey::from_operation(
            Path::new("C:\\workspace"),
            "thread-1",
            &prepared.operation,
        )
        .expect("read should be cacheable");
        let cache = ReadToolCache::default();
        let executions = AtomicUsize::new(0);

        let results = join_all((0..8).map(|_| {
            let key = key.clone();
            let executions = &executions;
            async {
                cache
                    .get_or_execute(key, || async {
                        executions.fetch_add(1, Ordering::Relaxed);
                        tokio::time::sleep(Duration::from_millis(10)).await;
                        Ok(CachedReadOutput::text(
                            "shared result".into(),
                            TextOutputKind::ReadFile,
                        ))
                    })
                    .await
            }
        }))
        .await;

        let mut output_ids = BTreeSet::new();
        for result in results {
            let output = result
                .expect("coalesced read should succeed")
                .into_stored_output()
                .into_output(ProviderOutputBudget::default())
                .await
                .expect("each result should materialize independently");
            assert_eq!(output.provider_output, "shared result");
            assert_eq!(output.exit_code, None);
            output_ids.insert(output.source.reference().id);
        }
        assert_eq!(executions.load(Ordering::Relaxed), 1);
        assert_eq!(output_ids.len(), 8);
    }

    #[tokio::test]
    async fn cache_scope_and_arguments_are_part_of_the_identity() {
        let registry = ToolRegistry;
        let first = registry
            .prepare(
                "read-1".into(),
                "read_file",
                r#"{"path":"src/lib.rs","start_line":1,"end_line":20}"#,
            )
            .expect("first read should prepare");
        let second = registry
            .prepare(
                "read-2".into(),
                "read_file",
                r#"{"path":"src/lib.rs","start_line":21,"end_line":40}"#,
            )
            .expect("second read should prepare");
        let first_key = ReadToolCacheKey::from_operation(
            Path::new("C:\\workspace-a"),
            "thread-1",
            &first.operation,
        )
        .expect("first read should be cacheable");
        let keys = [
            first_key.clone(),
            ReadToolCacheKey::from_operation(
                Path::new("C:\\workspace-a"),
                "thread-1",
                &second.operation,
            )
            .expect("second read should be cacheable"),
            ReadToolCacheKey::from_operation(
                Path::new("C:\\workspace-b"),
                "thread-1",
                &first.operation,
            )
            .expect("workspace scoped read should be cacheable"),
            ReadToolCacheKey::from_operation(
                Path::new("C:\\workspace-a"),
                "thread-2",
                &first.operation,
            )
            .expect("thread scoped read should be cacheable"),
        ];
        let cache = ReadToolCache::default();
        let executions = Arc::new(AtomicUsize::new(0));

        for key in keys {
            let executions = Arc::clone(&executions);
            cache
                .get_or_execute(key, || async move {
                    executions.fetch_add(1, Ordering::Relaxed);
                    Ok(CachedReadOutput::text(
                        "distinct result".into(),
                        TextOutputKind::ReadFile,
                    ))
                })
                .await
                .expect("distinct read should complete");
        }
        cache
            .get_or_execute(first_key, || async {
                executions.fetch_add(1, Ordering::Relaxed);
                Ok(CachedReadOutput::text(
                    "should not execute".into(),
                    TextOutputKind::ReadFile,
                ))
            })
            .await
            .expect("cached read should complete");

        assert_eq!(executions.load(Ordering::Relaxed), 4);
    }

    #[tokio::test]
    async fn a_new_batch_never_reuses_a_previous_read() {
        let registry = ToolRegistry;
        let prepared = registry
            .prepare(
                "list-1".into(),
                "list_files",
                r#"{"path":".","max_depth":3}"#,
            )
            .expect("listing should prepare");
        let key = ReadToolCacheKey::from_operation(
            Path::new("C:\\workspace"),
            "thread-1",
            &prepared.operation,
        )
        .expect("listing should be cacheable");
        let executions = AtomicUsize::new(0);

        for _ in 0..2 {
            ReadToolCache::default()
                .get_or_execute(key.clone(), || async {
                    executions.fetch_add(1, Ordering::Relaxed);
                    Ok(CachedReadOutput::text(
                        "fresh batch result".into(),
                        TextOutputKind::ListFiles,
                    ))
                })
                .await
                .expect("batch-local read should complete");
        }

        assert_eq!(executions.load(Ordering::Relaxed), 2);
    }

    #[tokio::test]
    async fn typed_failures_are_coalesced_without_erasing_the_variant() {
        let registry = ToolRegistry;
        let prepared = registry
            .prepare(
                "search-1".into(),
                "search_text",
                r#"{"path":".","query":"needle","case_sensitive":true}"#,
            )
            .expect("search should prepare");
        let key = ReadToolCacheKey::from_operation(
            Path::new("C:\\workspace"),
            "thread-1",
            &prepared.operation,
        )
        .expect("search should be cacheable");
        let cache = ReadToolCache::default();
        let executions = AtomicUsize::new(0);

        let results = join_all((0..4).map(|_| {
            let key = key.clone();
            let executions = &executions;
            async {
                cache
                    .get_or_execute(key, || async {
                        executions.fetch_add(1, Ordering::Relaxed);
                        Err(AppError::Timeout {
                            operation: "text search",
                        })
                    })
                    .await
            }
        }))
        .await;

        assert_eq!(executions.load(Ordering::Relaxed), 1);
        assert!(results.into_iter().all(|result| matches!(
            result,
            Err(AppError::Timeout {
                operation: "text search"
            })
        )));
    }

    #[tokio::test]
    async fn eviction_enforces_the_maximum_entry_count() {
        let registry = ToolRegistry;
        let cache = ReadToolCache::default();
        let executions = AtomicUsize::new(0);
        let mut keys = Vec::new();
        for index in 0..=READ_CACHE_MAXIMUM_ENTRIES {
            let prepared = registry
                .prepare(
                    format!("read-eviction-{index}"),
                    "read_file",
                    &format!(r#"{{"path":"eviction-{index}.rs","start_line":1,"end_line":20}}"#),
                )
                .expect("cached read should prepare");
            keys.push(
                ReadToolCacheKey::from_operation(
                    Path::new("C:\\workspace"),
                    "thread-eviction",
                    &prepared.operation,
                )
                .expect("read should be cacheable"),
            );
        }

        for key in &keys {
            cache
                .get_or_execute(key.clone(), || async {
                    executions.fetch_add(1, Ordering::Relaxed);
                    Ok(CachedReadOutput::text(
                        "evictable result".into(),
                        TextOutputKind::ReadFile,
                    ))
                })
                .await
                .expect("each seeded read should complete");
        }
        assert_eq!(executions.load(Ordering::Relaxed), keys.len());

        cache
            .get_or_execute(keys[0].clone(), || async {
                executions.fetch_add(1, Ordering::Relaxed);
                Ok(CachedReadOutput::text(
                    "re-executed result".into(),
                    TextOutputKind::ReadFile,
                ))
            })
            .await
            .expect("the oldest read should have been evicted");
        assert_eq!(executions.load(Ordering::Relaxed), keys.len() + 1);

        let newest = keys
            .last()
            .cloned()
            .expect("the seeded cache should contain entries");
        cache
            .get_or_execute(newest, || async {
                executions.fetch_add(1, Ordering::Relaxed);
                Ok(CachedReadOutput::text(
                    "should not execute".into(),
                    TextOutputKind::ReadFile,
                ))
            })
            .await
            .expect("the newest read should remain cached");
        assert_eq!(executions.load(Ordering::Relaxed), keys.len() + 1);
    }
}
