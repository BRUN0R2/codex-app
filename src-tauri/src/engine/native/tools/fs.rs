use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use super::super::text::truncate_utf8;
use super::workspace::{
    relative_display, resolve_existing_file, resolve_existing_path, resolve_write_target,
};
use super::{
    EditFileArgs, ListFilesArgs, MAX_EDIT_OCCURRENCES, MAX_FILE_BYTES, MAX_LIST_DEPTH,
    MAX_LIST_RESULTS, MAX_READ_LINES, MAX_SEARCH_DIRECTORIES, MAX_SEARCH_FILES,
    MAX_SEARCH_LINE_BYTES, MAX_SEARCH_QUERY_BYTES, MAX_SEARCH_RESULTS, ReadFileArgs,
    SearchTextArgs, WriteFileArgs,
};
use crate::error::AppError;

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
    workspace: &Path,
    args: &SearchTextArgs,
) -> Result<String, AppError> {
    if args.query.is_empty() || args.query.len() > MAX_SEARCH_QUERY_BYTES {
        return Err(AppError::Tool(format!(
            "search query must contain between 1 and {MAX_SEARCH_QUERY_BYTES} bytes"
        )));
    }
    let root = resolve_existing_path(workspace, &args.path).await?;
    let workspace = workspace.to_path_buf();
    let query = args.query.clone();
    let case_sensitive = args.case_sensitive;
    tokio::task::spawn_blocking(move || {
        let mut files = Vec::new();
        if root.is_file() {
            files.push(root);
        } else {
            collect_search_files(&root, &mut files)?;
        }
        files.sort();
        let needle = (!case_sensitive).then(|| query.to_lowercase());
        let mut matches = Vec::new();
        let mut skipped_large = 0usize;
        let mut skipped_unreadable = 0usize;
        for file in files {
            let metadata = std::fs::metadata(&file)
                .map_err(|error| AppError::FileSystem(error.to_string()))?;
            if metadata.len() > MAX_FILE_BYTES as u64 {
                skipped_large += 1;
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&file) else {
                skipped_unreadable += 1;
                continue;
            };
            for (index, line) in text.lines().enumerate() {
                let found = match &needle {
                    Some(needle) => line.to_lowercase().contains(needle),
                    None => line.contains(&query),
                };
                if found {
                    let relative = relative_display(&workspace, &file)?;
                    matches.push(format!(
                        "{relative}:{}:{}",
                        index + 1,
                        truncate_utf8(line, MAX_SEARCH_LINE_BYTES)
                    ));
                    if matches.len() >= MAX_SEARCH_RESULTS {
                        return Ok(format_search_output(
                            matches,
                            skipped_large,
                            skipped_unreadable,
                            true,
                        ));
                    }
                }
            }
        }
        Ok(format_search_output(
            matches,
            skipped_large,
            skipped_unreadable,
            false,
        ))
    })
    .await
    .map_err(|error| AppError::Tool(format!("search task failed: {error}")))?
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

fn collect_search_files(directory: &Path, output: &mut Vec<PathBuf>) -> Result<(), AppError> {
    let mut pending_directories = vec![directory.to_path_buf()];
    let mut visited_directories = 0usize;
    while let Some(directory) = pending_directories.pop() {
        visited_directories += 1;
        if visited_directories > MAX_SEARCH_DIRECTORIES {
            return Err(AppError::Tool(format!(
                "search traversal exceeds {MAX_SEARCH_DIRECTORIES} directories"
            )));
        }
        let entries = std::fs::read_dir(directory)
            .map_err(|error| AppError::FileSystem(error.to_string()))?;
        for entry in entries {
            let entry = entry.map_err(|error| AppError::FileSystem(error.to_string()))?;
            let file_type = entry
                .file_type()
                .map_err(|error| AppError::FileSystem(error.to_string()))?;
            if file_type.is_symlink() || ignored_directory(&entry.file_name()) {
                continue;
            }
            if file_type.is_dir() {
                pending_directories.push(entry.path());
            } else if file_type.is_file() {
                if output.len() >= MAX_SEARCH_FILES {
                    return Err(AppError::Tool(format!(
                        "search traversal exceeds {MAX_SEARCH_FILES} files"
                    )));
                }
                output.push(entry.path());
            }
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
fn format_search_output(
    matches: Vec<String>,
    skipped_large: usize,
    skipped_unreadable: usize,
    truncated: bool,
) -> String {
    let mut output = if matches.is_empty() {
        "No matches found.".to_string()
    } else {
        matches.join("\n")
    };
    if truncated {
        output.push_str(&format!("\n[results truncated at {MAX_SEARCH_RESULTS}]"));
    }
    if skipped_large > 0 || skipped_unreadable > 0 {
        output.push_str(&format!(
            "\n[skipped files: {skipped_large} larger than {MAX_FILE_BYTES} bytes, {skipped_unreadable} unreadable or non-UTF-8]"
        ));
    }
    output
}
