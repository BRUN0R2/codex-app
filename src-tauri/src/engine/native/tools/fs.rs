use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt as _, AsyncRead, AsyncReadExt as _, BufReader};
use tokio::sync::watch;

use super::super::text::truncate_utf8;
use super::ripgrep::Ripgrep;
use super::workspace::{
    relative_display, resolve_existing_file, resolve_existing_path, resolve_write_target,
};
use super::{
    EditFileArgs, ListFilesArgs, MAX_EDIT_OCCURRENCES, MAX_FILE_BYTES, MAX_LIST_DEPTH,
    MAX_LIST_RESULTS, MAX_READ_LINES, MAX_SEARCH_LINE_BYTES, MAX_SEARCH_QUERY_BYTES,
    MAX_SEARCH_RESULTS, MAX_TOOL_PATH_BYTES, ReadFileArgs, SearchTextArgs, WriteFileArgs,
};
use crate::error::AppError;
use crate::process::headless_command;

const SEARCH_TIMEOUT: Duration = Duration::from_secs(30);
const RIPGREP_THREADS_PER_SEARCH: &str = "2";
const MAX_SEARCH_STDERR_BYTES: usize = 32 * 1_024;
const SEARCH_LINE_OVERHEAD_BYTES: usize = 128;
const MAX_SEARCH_OUTPUT_LINE_BYTES: usize =
    MAX_TOOL_PATH_BYTES + MAX_SEARCH_LINE_BYTES + SEARCH_LINE_OVERHEAD_BYTES;
const SEARCH_LINE_INITIAL_CAPACITY: usize = 1_024;

fn search_query_variants(query: &str) -> Vec<String> {
    let normalized = query.replace("\r\n", "\n").replace('\r', "\n");
    if normalized.contains('\n') {
        vec![normalized.clone(), normalized.replace('\n', "\r\n")]
    } else {
        vec![normalized]
    }
}

pub(super) async fn read_file(workspace: &Path, args: &ReadFileArgs) -> Result<String, AppError> {
    let start =
        usize::try_from(args.start_line).map_err(|error| AppError::Tool(error.to_string()))?;
    let end = usize::try_from(args.end_line).map_err(|error| AppError::Tool(error.to_string()))?;
    if start == 0 || end < start || end - start + 1 > MAX_READ_LINES {
        return Err(AppError::Tool(format!(
            "line range must contain between 1 and {MAX_READ_LINES} lines"
        )));
    }
    let path = resolve_existing_file(workspace, &args.path).await?;
    let bytes = read_file_bounded(&path).await?;
    let text = String::from_utf8(bytes)
        .map_err(|_| AppError::Tool("read_file supports UTF-8 text only".into()))?;
    let lines = text
        .lines()
        .enumerate()
        .filter(|(index, _)| *index + 1 >= start && *index < end)
        .map(|(index, line)| format!("{}: {line}", index + 1))
        .collect::<Vec<_>>();
    if lines.is_empty() {
        return Err(AppError::Tool(
            "requested line range is outside the file".into(),
        ));
    }
    Ok(lines.join("\n"))
}

pub(super) async fn list_files(workspace: &Path, args: &ListFilesArgs) -> Result<String, AppError> {
    let depth = usize::from(args.max_depth);
    if depth == 0 || depth > MAX_LIST_DEPTH {
        return Err(AppError::Tool(format!(
            "list depth must be between 1 and {MAX_LIST_DEPTH}"
        )));
    }
    let root = resolve_existing_path(workspace, &args.path).await?;
    let workspace = workspace.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let mut files = Vec::new();
        walk_files(&workspace, &root, depth, &mut files)?;
        files.sort();
        Ok(files.join("\n"))
    })
    .await
    .map_err(|error| AppError::Tool(format!("file listing task failed: {error}")))?
}

pub(super) async fn search_text(
    ripgrep: &Ripgrep,
    workspace: &Path,
    args: &SearchTextArgs,
    cancellation: &mut watch::Receiver<bool>,
) -> Result<String, AppError> {
    if args.query.is_empty()
        || args.query.len() > MAX_SEARCH_QUERY_BYTES
        || args.query.contains('\0')
    {
        return Err(AppError::Tool(format!(
            "search query must contain between 1 and {MAX_SEARCH_QUERY_BYTES} bytes"
        )));
    }
    if *cancellation.borrow() {
        return Err(AppError::Cancelled(
            "turn was interrupted before text search started".into(),
        ));
    }
    let root = resolve_existing_path(workspace, &args.path).await?;
    let relative_root = relative_display(workspace, &root)?;
    let search_root = if relative_root.is_empty() {
        "."
    } else {
        relative_root.as_str()
    };
    let maximum_columns = MAX_SEARCH_LINE_BYTES.to_string();
    let queries = search_query_variants(&args.query);
    let mut command = headless_command(ripgrep.executable()?);
    command.current_dir(workspace).args([
        "--fixed-strings",
        "--line-number",
        "--with-filename",
        "--no-heading",
        "--color=never",
        "--no-config",
        "--no-require-git",
        "--hidden",
        "--max-columns-preview",
        "--path-separator=/",
        "--encoding=utf-8",
        "--glob=!.git/**",
        "--threads",
        RIPGREP_THREADS_PER_SEARCH,
        "--max-columns",
        maximum_columns.as_str(),
    ]);
    if queries.len() > 1 {
        command.arg("--multiline");
    }
    command.arg(if args.case_sensitive {
        "--case-sensitive"
    } else {
        "--ignore-case"
    });
    for query in &queries {
        command.arg("--regexp").arg(query);
    }
    command
        .arg("--")
        .arg(search_root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|error| AppError::Tool(format!("could not start ripgrep: {error}")))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Tool("ripgrep stdout pipe was not created".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::Tool("ripgrep stderr pipe was not created".into()))?;
    let mut stderr_task = tokio::spawn(read_bounded_stream(
        stderr,
        MAX_SEARCH_STDERR_BYTES,
        "ripgrep stderr",
    ));
    let deadline = tokio::time::Instant::now() + SEARCH_TIMEOUT;
    let mut stdout = BufReader::new(stdout);
    let mut matches = Vec::new();
    let mut line = Vec::with_capacity(SEARCH_LINE_INITIAL_CAPACITY);
    let mut truncated = false;

    loop {
        line.clear();
        let count = tokio::select! {
            changed = cancellation.changed() => {
                if changed.is_err() || *cancellation.borrow() {
                    stop_search_process(&mut child).await?;
                    stderr_task.abort();
                    return Err(AppError::Cancelled("turn was interrupted during text search".into()));
                }
                continue;
            }
            result = stdout.read_until(b'\n', &mut line) => {
                result.map_err(|error| AppError::Tool(format!("could not read ripgrep output: {error}")))?
            }
            () = tokio::time::sleep_until(deadline) => {
                stop_search_process(&mut child).await?;
                stderr_task.abort();
                return Err(AppError::Timeout { operation: "text search" });
            }
        };
        if count == 0 {
            break;
        }
        if matches.len() >= MAX_SEARCH_RESULTS {
            truncated = true;
            stop_search_process(&mut child).await?;
            break;
        }
        while matches!(line.last(), Some(b'\n' | b'\r')) {
            line.pop();
        }
        let output_line = String::from_utf8_lossy(&line);
        let output_line = output_line
            .strip_prefix("./")
            .unwrap_or(output_line.as_ref());
        matches.push(truncate_utf8(output_line, MAX_SEARCH_OUTPUT_LINE_BYTES));
    }

    let status = if truncated {
        None
    } else {
        match wait_for_search_process(&mut child, cancellation, deadline).await {
            Ok(status) => Some(status),
            Err(error) => {
                stderr_task.abort();
                return Err(error);
            }
        }
    };
    let stderr = finish_stderr_task(&mut stderr_task).await?;
    if truncated {
        return Ok(format_search_output(matches, true));
    }
    match status.and_then(|status| status.code()) {
        Some(0) => Ok(format_search_output(matches, false)),
        Some(1) => Ok("No matches found.".into()),
        Some(exit_code) => Err(AppError::Tool(format!(
            "ripgrep failed with exit code {exit_code}: {}",
            stderr.trim()
        ))),
        None => Err(AppError::Tool(
            "ripgrep ended without a process exit code".into(),
        )),
    }
}

pub(super) async fn edit_file(workspace: &Path, args: &EditFileArgs) -> Result<String, AppError> {
    if args.old_text.is_empty()
        || args.expected_occurrences == 0
        || args.expected_occurrences > MAX_EDIT_OCCURRENCES
    {
        return Err(AppError::Tool(format!(
            "edit_file requires an exact non-empty match count from 1 to {MAX_EDIT_OCCURRENCES}"
        )));
    }
    let path = resolve_existing_file(workspace, &args.path).await?;
    let bytes = read_file_bounded(&path).await?;
    let current = String::from_utf8(bytes)
        .map_err(|_| AppError::Tool("edit_file supports UTF-8 text only".into()))?;
    let occurrences = current.matches(&args.old_text).count();
    if occurrences != usize::from(args.expected_occurrences) {
        return Err(AppError::Tool(format!(
            "edit target occurred {occurrences} times; expected {}",
            args.expected_occurrences
        )));
    }
    let updated = current.replace(&args.old_text, &args.new_text);
    if updated.len() > MAX_FILE_BYTES {
        return Err(AppError::Tool(format!(
            "edited file exceeds {MAX_FILE_BYTES} bytes"
        )));
    }
    atomic_write(path, updated.into_bytes()).await?;
    Ok(format!(
        "Updated {} exact occurrence(s) in {}.",
        occurrences, args.path
    ))
}

pub(super) async fn write_file(workspace: &Path, args: &WriteFileArgs) -> Result<String, AppError> {
    if args.content.len() > MAX_FILE_BYTES {
        return Err(AppError::Tool(format!(
            "file content exceeds {MAX_FILE_BYTES} bytes"
        )));
    }
    let path = resolve_write_target(workspace, &args.path).await?;
    let existed = tokio::fs::try_exists(&path)
        .await
        .map_err(|error| AppError::FileSystem(error.to_string()))?;
    if existed && !args.overwrite {
        return Err(AppError::Tool(
            "target exists; set overwrite to true only when replacement is intended".into(),
        ));
    }
    if !existed && args.overwrite {
        return Err(AppError::Tool(
            "target does not exist; overwrite must be false for creation".into(),
        ));
    }
    atomic_write(path, args.content.as_bytes().to_vec()).await?;
    Ok(if existed {
        format!("Replaced {}.", args.path)
    } else {
        format!("Created {}.", args.path)
    })
}

async fn read_file_bounded(path: &Path) -> Result<Vec<u8>, AppError> {
    let metadata = tokio::fs::metadata(path)
        .await
        .map_err(|error| AppError::FileSystem(error.to_string()))?;
    if metadata.len() > MAX_FILE_BYTES as u64 {
        return Err(AppError::Tool(format!(
            "file exceeds {MAX_FILE_BYTES} bytes"
        )));
    }
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|error| AppError::FileSystem(error.to_string()))?;
    if bytes.len() > MAX_FILE_BYTES {
        return Err(AppError::Tool(format!(
            "file changed while reading and now exceeds {MAX_FILE_BYTES} bytes"
        )));
    }
    Ok(bytes)
}

pub(super) async fn atomic_write(path: PathBuf, bytes: Vec<u8>) -> Result<(), AppError> {
    tokio::task::spawn_blocking(move || {
        let parent = path
            .parent()
            .ok_or_else(|| AppError::FileSystem("write target has no parent".into()))?;
        let mut temporary = tempfile::NamedTempFile::new_in(parent)
            .map_err(|error| AppError::FileSystem(error.to_string()))?;
        std::io::Write::write_all(&mut temporary, &bytes)
            .map_err(|error| AppError::FileSystem(error.to_string()))?;
        temporary
            .as_file()
            .sync_all()
            .map_err(|error| AppError::FileSystem(error.to_string()))?;
        temporary
            .persist(&path)
            .map_err(|error| AppError::FileSystem(error.error.to_string()))?;
        Ok(())
    })
    .await
    .map_err(|error| AppError::FileSystem(format!("file write task failed: {error}")))?
}

fn walk_files(
    workspace: &Path,
    directory: &Path,
    depth: usize,
    output: &mut Vec<String>,
) -> Result<(), AppError> {
    if output.len() >= MAX_LIST_RESULTS || depth == 0 {
        return Ok(());
    }
    if directory.is_file() {
        output.push(relative_display(workspace, directory)?);
        return Ok(());
    }
    let mut entries = std::fs::read_dir(directory)
        .map_err(|error| AppError::FileSystem(error.to_string()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| AppError::FileSystem(error.to_string()))?;
    entries.sort_by_key(std::fs::DirEntry::file_name);
    for entry in entries {
        if output.len() >= MAX_LIST_RESULTS {
            output.push(format!("[results truncated at {MAX_LIST_RESULTS}]"));
            break;
        }
        let file_type = entry
            .file_type()
            .map_err(|error| AppError::FileSystem(error.to_string()))?;
        if file_type.is_symlink() || ignored_directory(&entry.file_name()) {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            walk_files(workspace, &path, depth - 1, output)?;
        } else if file_type.is_file() {
            output.push(relative_display(workspace, &path)?);
        }
    }
    Ok(())
}

fn ignored_directory(name: &OsStr) -> bool {
    matches!(
        name.to_str(),
        Some(".git" | ".idea" | ".reference" | ".vscode" | "node_modules" | "target")
    )
}
fn format_search_output(matches: Vec<String>, truncated: bool) -> String {
    let mut output = if matches.is_empty() {
        "No matches found.".to_string()
    } else {
        matches.join("\n")
    };
    if truncated {
        output.push_str(&format!("\n[results truncated at {MAX_SEARCH_RESULTS}]"));
    }
    output
}

async fn read_bounded_stream<R>(
    reader: R,
    maximum_bytes: usize,
    label: &'static str,
) -> Result<String, AppError>
where
    R: AsyncRead + Unpin,
{
    let mut bytes = Vec::new();
    reader
        .take((maximum_bytes + 1) as u64)
        .read_to_end(&mut bytes)
        .await
        .map_err(|error| AppError::Tool(format!("could not read {label}: {error}")))?;
    if bytes.len() > maximum_bytes {
        bytes.truncate(maximum_bytes);
        bytes.extend_from_slice(b"\n[stderr truncated]");
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

async fn finish_stderr_task(
    task: &mut tokio::task::JoinHandle<Result<String, AppError>>,
) -> Result<String, AppError> {
    task.await
        .map_err(|error| AppError::Tool(format!("ripgrep stderr reader failed: {error}")))?
}

async fn wait_for_search_process(
    child: &mut tokio::process::Child,
    cancellation: &mut watch::Receiver<bool>,
    deadline: tokio::time::Instant,
) -> Result<std::process::ExitStatus, AppError> {
    loop {
        tokio::select! {
            changed = cancellation.changed() => {
                if changed.is_err() || *cancellation.borrow() {
                    stop_search_process(child).await?;
                    return Err(AppError::Cancelled("turn was interrupted during text search".into()));
                }
            }
            status = child.wait() => {
                return status.map_err(|error| AppError::Tool(format!("could not wait for ripgrep: {error}")));
            }
            () = tokio::time::sleep_until(deadline) => {
                stop_search_process(child).await?;
                return Err(AppError::Timeout { operation: "text search" });
            }
        }
    }
}

async fn stop_search_process(child: &mut tokio::process::Child) -> Result<(), AppError> {
    if child
        .try_wait()
        .map_err(|error| AppError::Tool(format!("could not inspect ripgrep: {error}")))?
        .is_some()
    {
        return Ok(());
    }
    child
        .kill()
        .await
        .map_err(|error| AppError::Tool(format!("could not terminate ripgrep: {error}")))
}

#[cfg(test)]
mod tests {
    use std::ffi::OsStr;
    use std::hint::black_box;
    use std::path::Path;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{Duration, Instant};

    use futures_util::future::join_all;
    use tokio::sync::watch;

    use super::super::ToolRegistry;
    use super::super::read_cache::{CachedReadOutput, ReadToolCache, ReadToolCacheKey};
    use super::{SearchTextArgs, search_text};
    use crate::engine::native::output_compaction::TextOutputKind;
    use crate::engine::native::tools::ripgrep::Ripgrep;
    use crate::error::AppError;

    #[tokio::test]
    async fn ripgrep_search_is_literal_case_aware_hidden_and_ignore_aware() {
        let workspace = tempfile::tempdir().expect("workspace should be created");
        let workspace_path =
            std::fs::canonicalize(workspace.path()).expect("workspace should canonicalize");
        std::fs::create_dir(workspace.path().join(".hidden"))
            .expect("hidden directory should be created");
        std::fs::write(
            workspace.path().join("visible.txt"),
            "Needle[0]\nneedle[0]\n",
        )
        .expect("visible fixture should be written");
        std::fs::write(
            workspace.path().join(".hidden").join("inside.txt"),
            "Needle[0]\n",
        )
        .expect("hidden fixture should be written");
        std::fs::write(workspace.path().join("ignored.txt"), "Needle[0]\n")
            .expect("ignored fixture should be written");
        std::fs::write(workspace.path().join(".gitignore"), "ignored.txt\n")
            .expect("ignore file should be written");
        let ripgrep = test_ripgrep();
        let (_sender, mut cancellation) = watch::channel(false);

        let sensitive = search_text(
            &ripgrep,
            &workspace_path,
            &SearchTextArgs {
                path: ".".into(),
                query: "Needle[0]".into(),
                case_sensitive: true,
            },
            &mut cancellation,
        )
        .await
        .expect("case-sensitive search should succeed");
        assert!(sensitive.contains("visible.txt:1:Needle[0]"));
        assert!(sensitive.contains(".hidden/inside.txt:1:Needle[0]"));
        assert!(!sensitive.contains("visible.txt:2:needle[0]"));
        assert!(!sensitive.contains("ignored.txt"));

        let insensitive = search_text(
            &ripgrep,
            &workspace_path,
            &SearchTextArgs {
                path: ".".into(),
                query: "needle[0]".into(),
                case_sensitive: false,
            },
            &mut cancellation,
        )
        .await
        .expect("case-insensitive search should succeed");
        assert!(insensitive.contains("visible.txt:1:Needle[0]"));
        assert!(insensitive.contains("visible.txt:2:needle[0]"));
    }

    #[tokio::test]
    async fn ripgrep_search_supports_literal_multiline_queries_across_lf_and_crlf() {
        let workspace = tempfile::tempdir().expect("workspace should be created");
        let workspace_path =
            std::fs::canonicalize(workspace.path()).expect("workspace should canonicalize");
        std::fs::write(
            workspace.path().join("lf.rs"),
            "const ação: &str = \"ready\";\nlet value = ação.len();\n",
        )
        .expect("LF fixture should be written");
        std::fs::write(
            workspace.path().join("crlf.rs"),
            "const ação: &str = \"ready\";\r\nlet value = ação.len();\r\n",
        )
        .expect("CRLF fixture should be written");
        let ripgrep = test_ripgrep();
        let (_sender, mut cancellation) = watch::channel(false);

        let output = search_text(
            &ripgrep,
            &workspace_path,
            &SearchTextArgs {
                path: ".".into(),
                query: "const ação: &str = \"ready\";\r\nlet value = ação.len();".into(),
                case_sensitive: true,
            },
            &mut cancellation,
        )
        .await
        .expect("multiline search should succeed");

        for path in ["lf.rs", "crlf.rs"] {
            assert!(output.contains(&format!("{path}:1:const ação: &str = \"ready\";")));
            assert!(output.contains(&format!("{path}:2:let value = ação.len();")));
        }
    }

    #[tokio::test]
    async fn ripgrep_search_stops_at_the_global_result_limit() {
        let workspace = tempfile::tempdir().expect("workspace should be created");
        let workspace_path =
            std::fs::canonicalize(workspace.path()).expect("workspace should canonicalize");
        let content = (0..205)
            .map(|index| format!("needle {index}"))
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(workspace.path().join("many.txt"), content)
            .expect("search fixture should be written");
        let ripgrep = test_ripgrep();
        let (_sender, mut cancellation) = watch::channel(false);

        let output = search_text(
            &ripgrep,
            &workspace_path,
            &SearchTextArgs {
                path: ".".into(),
                query: "needle".into(),
                case_sensitive: true,
            },
            &mut cancellation,
        )
        .await
        .expect("bounded search should succeed");

        assert_eq!(
            output
                .lines()
                .filter(|line| line.starts_with("many.txt:"))
                .count(),
            200
        );
        assert!(output.ends_with("[results truncated at 200]"));
    }

    #[tokio::test]
    async fn ripgrep_search_honors_preexisting_cancellation() {
        let workspace = tempfile::tempdir().expect("workspace should be created");
        let ripgrep = test_ripgrep();
        let (_sender, mut cancellation) = watch::channel(true);

        let result = search_text(
            &ripgrep,
            workspace.path(),
            &SearchTextArgs {
                path: ".".into(),
                query: "needle".into(),
                case_sensitive: true,
            },
            &mut cancellation,
        )
        .await;

        assert!(matches!(result, Err(AppError::Cancelled(_))));
    }

    #[ignore = "performance benchmark; run through `pnpm measure:search`"]
    #[tokio::test]
    async fn benchmark_ripgrep_against_previous_scanner() {
        const DIRECTORY_COUNT: usize = 48;
        const FILES_PER_DIRECTORY: usize = 50;
        const FILE_BYTES: usize = 32 * 1_024;
        const SAMPLE_COUNT: usize = 7;
        const QUERY: &str = "needle-that-is-deliberately-absent-7f6097e6";

        let workspace = tempfile::tempdir().expect("benchmark workspace should be created");
        create_search_benchmark_corpus(
            workspace.path(),
            DIRECTORY_COUNT,
            FILES_PER_DIRECTORY,
            FILE_BYTES,
        );
        let workspace_path =
            std::fs::canonicalize(workspace.path()).expect("workspace should canonicalize");
        let ripgrep = test_ripgrep();
        let args = SearchTextArgs {
            path: ".".into(),
            query: QUERY.into(),
            case_sensitive: true,
        };

        let mut ripgrep_samples = Vec::with_capacity(SAMPLE_COUNT);
        let mut legacy_samples = Vec::with_capacity(SAMPLE_COUNT);
        for sample in 0..SAMPLE_COUNT + 2 {
            if sample % 2 == 0 {
                let ripgrep_duration =
                    measure_ripgrep_search(&ripgrep, &workspace_path, &args).await;
                let legacy_duration = measure_previous_scanner(&workspace_path, QUERY);
                if sample >= 2 {
                    ripgrep_samples.push(ripgrep_duration);
                    legacy_samples.push(legacy_duration);
                }
            } else {
                let legacy_duration = measure_previous_scanner(&workspace_path, QUERY);
                let ripgrep_duration =
                    measure_ripgrep_search(&ripgrep, &workspace_path, &args).await;
                if sample >= 2 {
                    legacy_samples.push(legacy_duration);
                    ripgrep_samples.push(ripgrep_duration);
                }
            }
        }

        let ripgrep_median = median(ripgrep_samples);
        let legacy_median = median(legacy_samples);
        let speedup = legacy_median.as_secs_f64() / ripgrep_median.as_secs_f64();
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "directories": DIRECTORY_COUNT,
                "files": DIRECTORY_COUNT * FILES_PER_DIRECTORY,
                "fileBytes": FILE_BYTES,
                "corpusMiB": (DIRECTORY_COUNT * FILES_PER_DIRECTORY * FILE_BYTES) as f64
                    / (1024.0 * 1024.0),
                "samples": SAMPLE_COUNT,
                "previousScannerMedianMs": legacy_median.as_secs_f64() * 1_000.0,
                "ripgrepMedianMs": ripgrep_median.as_secs_f64() * 1_000.0,
                "speedup": speedup,
            }))
            .expect("benchmark result should serialize")
        );
        assert!(
            speedup >= 2.0,
            "bundled ripgrep must remain at least 2x faster in the reference corpus; measured {speedup:.3}x"
        );
    }

    #[ignore = "performance benchmark; run through `pnpm measure:tool-cache`"]
    #[tokio::test(flavor = "multi_thread", worker_threads = 8)]
    async fn benchmark_duplicate_search_coalescence() {
        const DIRECTORY_COUNT: usize = 32;
        const FILES_PER_DIRECTORY: usize = 40;
        const FILE_BYTES: usize = 32 * 1_024;
        const DUPLICATE_CALLS: usize = 8;
        const SAMPLE_COUNT: usize = 7;
        const QUERY: &str = "absent-cache-probe-f081a760";

        let workspace = tempfile::tempdir().expect("benchmark workspace should be created");
        create_search_benchmark_corpus(
            workspace.path(),
            DIRECTORY_COUNT,
            FILES_PER_DIRECTORY,
            FILE_BYTES,
        );
        let workspace_path =
            std::fs::canonicalize(workspace.path()).expect("workspace should canonicalize");
        let ripgrep = test_ripgrep();
        let args = SearchTextArgs {
            path: ".".into(),
            query: QUERY.into(),
            case_sensitive: true,
        };
        let prepared = ToolRegistry
            .prepare(
                "cache-benchmark".into(),
                "search_text",
                &format!(r#"{{"path":".","query":"{QUERY}","case_sensitive":true}}"#),
            )
            .expect("benchmark search should prepare");
        let key = ReadToolCacheKey::from_operation(
            &workspace_path,
            "benchmark-thread",
            &prepared.operation,
        )
        .expect("search should be cacheable");

        let mut independent_samples = Vec::with_capacity(SAMPLE_COUNT);
        let mut coalesced_samples = Vec::with_capacity(SAMPLE_COUNT);
        for sample in 0..SAMPLE_COUNT + 2 {
            let (independent, coalesced) = if sample % 2 == 0 {
                (
                    measure_parallel_duplicate_search(
                        &ripgrep,
                        &workspace_path,
                        &args,
                        DUPLICATE_CALLS,
                    )
                    .await,
                    measure_coalesced_duplicate_search(
                        &ripgrep,
                        &workspace_path,
                        &args,
                        &key,
                        DUPLICATE_CALLS,
                    )
                    .await,
                )
            } else {
                let coalesced = measure_coalesced_duplicate_search(
                    &ripgrep,
                    &workspace_path,
                    &args,
                    &key,
                    DUPLICATE_CALLS,
                )
                .await;
                let independent = measure_parallel_duplicate_search(
                    &ripgrep,
                    &workspace_path,
                    &args,
                    DUPLICATE_CALLS,
                )
                .await;
                (independent, coalesced)
            };
            if sample >= 2 {
                independent_samples.push(independent);
                coalesced_samples.push(coalesced);
            }
        }

        let independent_median = median(independent_samples);
        let coalesced_median = median(coalesced_samples);
        let speedup = independent_median.as_secs_f64() / coalesced_median.as_secs_f64();
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "corpusMiB": (DIRECTORY_COUNT * FILES_PER_DIRECTORY * FILE_BYTES) as f64
                    / (1024.0 * 1024.0),
                "duplicateCalls": DUPLICATE_CALLS,
                "independentSearchExecutions": DUPLICATE_CALLS,
                "coalescedSearchExecutions": 1,
                "executionReductionPercent": (1.0 - 1.0 / DUPLICATE_CALLS as f64) * 100.0,
                "samples": SAMPLE_COUNT,
                "independentMedianMs": independent_median.as_secs_f64() * 1_000.0,
                "coalescedMedianMs": coalesced_median.as_secs_f64() * 1_000.0,
                "latencySpeedup": speedup,
            }))
            .expect("benchmark result should serialize")
        );
        assert!(
            speedup >= 0.8,
            "coalescence must not introduce a material latency regression; measured {speedup:.3}x"
        );
    }

    fn test_ripgrep() -> Ripgrep {
        Ripgrep::for_project_tests()
    }

    fn create_search_benchmark_corpus(
        root: &Path,
        directory_count: usize,
        files_per_directory: usize,
        file_bytes: usize,
    ) {
        let line = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda\n";
        let content = line.repeat(file_bytes.div_ceil(line.len()));
        let content = &content.as_bytes()[..file_bytes];
        for directory_index in 0..directory_count {
            let directory = root.join(format!("module-{directory_index:03}"));
            std::fs::create_dir(&directory).expect("benchmark directory should be created");
            for file_index in 0..files_per_directory {
                std::fs::write(
                    directory.join(format!("source-{file_index:03}.txt")),
                    content,
                )
                .expect("benchmark file should be written");
            }
        }
    }

    async fn measure_ripgrep_search(
        ripgrep: &Ripgrep,
        workspace: &Path,
        args: &SearchTextArgs,
    ) -> Duration {
        let (_sender, mut cancellation) = watch::channel(false);
        let started_at = Instant::now();
        let output = search_text(ripgrep, workspace, args, &mut cancellation)
            .await
            .expect("ripgrep benchmark search should succeed");
        let duration = started_at.elapsed();
        assert_eq!(output, "No matches found.");
        black_box(output);
        duration
    }

    async fn measure_parallel_duplicate_search(
        ripgrep: &Ripgrep,
        workspace: &Path,
        args: &SearchTextArgs,
        duplicate_calls: usize,
    ) -> Duration {
        let (_sender, cancellation) = watch::channel(false);
        let started_at = Instant::now();
        let outputs = join_all((0..duplicate_calls).map(|_| {
            let mut cancellation = cancellation.clone();
            async move { search_text(ripgrep, workspace, args, &mut cancellation).await }
        }))
        .await;
        let duration = started_at.elapsed();
        for output in outputs {
            let output = output.expect("independent search should succeed");
            assert_eq!(output, "No matches found.");
            black_box(output);
        }
        duration
    }

    async fn measure_coalesced_duplicate_search(
        ripgrep: &Ripgrep,
        workspace: &Path,
        args: &SearchTextArgs,
        key: &ReadToolCacheKey,
        duplicate_calls: usize,
    ) -> Duration {
        let cache = ReadToolCache::default();
        let executions = Arc::new(AtomicUsize::new(0));
        let (_sender, cancellation) = watch::channel(false);
        let started_at = Instant::now();
        let outputs = join_all((0..duplicate_calls).map(|_| {
            let cache = &cache;
            let key = key.clone();
            let executions = Arc::clone(&executions);
            let mut cancellation = cancellation.clone();
            async move {
                cache
                    .get_or_execute(key, || async move {
                        executions.fetch_add(1, Ordering::Relaxed);
                        search_text(ripgrep, workspace, args, &mut cancellation)
                            .await
                            .map(|output| {
                                assert_eq!(output, "No matches found.");
                                CachedReadOutput::text(output, TextOutputKind::SearchText)
                            })
                    })
                    .await
            }
        }))
        .await;
        let duration = started_at.elapsed();
        assert_eq!(executions.load(Ordering::Relaxed), 1);
        for output in outputs {
            black_box(
                output
                    .expect("coalesced search should succeed")
                    .into_stored_output(),
            );
        }
        duration
    }

    fn measure_previous_scanner(workspace: &Path, query: &str) -> Duration {
        let started_at = Instant::now();
        let matches = previous_scanner_match_count(workspace, query);
        let duration = started_at.elapsed();
        assert_eq!(matches, 0);
        black_box(matches);
        duration
    }

    fn previous_scanner_match_count(root: &Path, query: &str) -> usize {
        let mut files = Vec::new();
        let mut pending_directories = vec![root.to_path_buf()];
        while let Some(directory) = pending_directories.pop() {
            let entries = std::fs::read_dir(directory)
                .expect("benchmark directory should be readable")
                .collect::<Result<Vec<_>, _>>()
                .expect("benchmark entries should be readable");
            for entry in entries {
                let file_type = entry
                    .file_type()
                    .expect("benchmark entry type should be readable");
                if file_type.is_symlink() || previous_scanner_ignored_directory(&entry.file_name())
                {
                    continue;
                }
                if file_type.is_dir() {
                    pending_directories.push(entry.path());
                } else if file_type.is_file() {
                    files.push(entry.path());
                }
            }
        }
        files.sort();

        files
            .into_iter()
            .map(|file| {
                let metadata =
                    std::fs::metadata(&file).expect("benchmark file metadata should be readable");
                assert!(metadata.len() <= super::MAX_FILE_BYTES as u64);
                std::fs::read_to_string(file)
                    .expect("benchmark file should be UTF-8")
                    .lines()
                    .filter(|line| line.contains(query))
                    .count()
            })
            .sum()
    }

    fn previous_scanner_ignored_directory(name: &OsStr) -> bool {
        matches!(
            name.to_str(),
            Some(".git" | ".idea" | ".reference" | ".vscode" | "node_modules" | "target")
        )
    }

    fn median(mut samples: Vec<Duration>) -> Duration {
        samples.sort_unstable();
        samples[samples.len() / 2]
    }
}
