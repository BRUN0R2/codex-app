use std::collections::{BTreeSet, HashMap};
use std::fs::Permissions;
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};

use sha2::{Digest as _, Sha256};

use crate::engine::{FileChange, FileChangeKind};
use crate::error::AppError;

use super::super::tools::MAX_DIFF_BYTES;
use super::parser::{ParsedPatch, PatchHunk, UpdateChunk};

pub(in crate::engine::native) fn preview_changes(parsed: &ParsedPatch) -> Vec<FileChange> {
    parsed
        .hunks
        .iter()
        .map(|hunk| match hunk {
            PatchHunk::Add { path, contents } => {
                let relative = display_unchecked(path);
                FileChange {
                    path: relative.clone(),
                    kind: FileChangeKind::Add,
                    diff: truncate_diff(&render_add_diff(&relative, contents)),
                }
            }
            PatchHunk::Delete { path } => {
                let relative = display_unchecked(path);
                FileChange {
                    path: relative.clone(),
                    kind: FileChangeKind::Delete,
                    diff: truncate_diff(&format!("*** Delete File: {relative}\n")),
                }
            }
            PatchHunk::Update {
                path,
                move_path,
                chunks,
            } => {
                let relative = display_unchecked(path);
                let move_path = move_path.as_deref().map(display_unchecked);
                FileChange {
                    path: relative.clone(),
                    kind: FileChangeKind::Update {
                        move_path: move_path.clone(),
                    },
                    diff: truncate_diff(&render_update_diff(
                        &relative,
                        move_path.as_deref(),
                        chunks,
                    )),
                }
            }
        })
        .collect()
}

#[derive(Debug)]
pub(in crate::engine::native) struct PreparedPatch {
    pub changes: Vec<PreparedChange>,
    pub thread_changes: Vec<FileChange>,
}

#[derive(Debug)]
pub(in crate::engine::native) enum PreparedChange {
    Write {
        original: FileSnapshot,
        final_bytes: Vec<u8>,
    },
    Delete {
        original: FileSnapshot,
    },
    Move {
        source_original: FileSnapshot,
        destination_original: FileSnapshot,
        final_bytes: Vec<u8>,
    },
}

#[derive(Debug, Clone)]
pub(in crate::engine::native) struct FileSnapshot {
    pub path: PathBuf,
    pub exists: bool,
    pub bytes: Vec<u8>,
    pub permissions: Option<Permissions>,
    pub digest: [u8; 32],
}

pub(in crate::engine::native) async fn prepare_patch(
    workspace: &Path,
    parsed: ParsedPatch,
) -> Result<PreparedPatch, AppError> {
    let workspace = canonical_workspace(workspace).await?;
    let mut resolved = Vec::with_capacity(parsed.hunks.len());
    for hunk in parsed.hunks {
        resolved.push(resolve_hunk(&workspace, hunk).await?);
    }
    validate_claims(&resolved)?;

    let mut changes = Vec::with_capacity(resolved.len());
    let mut thread_changes = Vec::with_capacity(resolved.len());
    for hunk in resolved {
        match hunk {
            ResolvedHunk::Add {
                relative,
                path,
                contents,
            } => {
                let original = snapshot(path).await?;
                if original.exists {
                    return Err(AppError::Tool(format!(
                        "cannot add existing file `{relative}`"
                    )));
                }
                thread_changes.push(FileChange {
                    path: relative.clone(),
                    kind: FileChangeKind::Add,
                    diff: truncate_diff(&render_add_diff(&relative, &contents)),
                });
                changes.push(PreparedChange::Write {
                    original,
                    final_bytes: contents.into_bytes(),
                });
            }
            ResolvedHunk::Delete { relative, path } => {
                let original = snapshot(path).await?;
                require_existing_file(&original, &relative, "delete")?;
                thread_changes.push(FileChange {
                    path: relative.clone(),
                    kind: FileChangeKind::Delete,
                    diff: truncate_diff(&format!("*** Delete File: {relative}\n")),
                });
                changes.push(PreparedChange::Delete { original });
            }
            ResolvedHunk::Update {
                relative,
                path,
                move_relative,
                move_path,
                chunks,
            } => {
                let source_original = snapshot(path).await?;
                require_existing_file(&source_original, &relative, "update")?;
                let final_bytes = if chunks.is_empty() {
                    source_original.bytes.clone()
                } else {
                    apply_chunks(&relative, &source_original.bytes, &chunks)?
                };
                let diff = truncate_diff(&render_update_diff(
                    &relative,
                    move_relative.as_deref(),
                    &chunks,
                ));
                let kind = FileChangeKind::Update {
                    move_path: move_relative.clone(),
                };
                thread_changes.push(FileChange {
                    path: relative,
                    kind,
                    diff,
                });

                if let Some(destination) = move_path {
                    let destination_original = snapshot(destination).await?;
                    if destination_original.exists {
                        return Err(AppError::Tool(format!(
                            "move destination `{}` already exists",
                            move_relative.unwrap_or_default()
                        )));
                    }
                    changes.push(PreparedChange::Move {
                        source_original,
                        destination_original,
                        final_bytes,
                    });
                } else {
                    changes.push(PreparedChange::Write {
                        original: source_original,
                        final_bytes,
                    });
                }
            }
        }
    }
    Ok(PreparedPatch {
        changes,
        thread_changes,
    })
}

#[derive(Debug)]
enum ResolvedHunk {
    Add {
        relative: String,
        path: PathBuf,
        contents: String,
    },
    Delete {
        relative: String,
        path: PathBuf,
    },
    Update {
        relative: String,
        path: PathBuf,
        move_relative: Option<String>,
        move_path: Option<PathBuf>,
        chunks: Vec<UpdateChunk>,
    },
}

impl ResolvedHunk {
    fn source(&self) -> Option<&Path> {
        match self {
            Self::Add { .. } => None,
            Self::Delete { path, .. } | Self::Update { path, .. } => Some(path),
        }
    }

    fn destination(&self) -> Option<&Path> {
        match self {
            Self::Add { path, .. } => Some(path),
            Self::Delete { .. } => None,
            Self::Update {
                path, move_path, ..
            } => Some(move_path.as_deref().unwrap_or(path)),
        }
    }

    fn is_in_place_update(&self) -> bool {
        matches!(
            self,
            Self::Update {
                move_path: None,
                ..
            }
        )
    }
}

async fn resolve_hunk(workspace: &Path, hunk: PatchHunk) -> Result<ResolvedHunk, AppError> {
    match hunk {
        PatchHunk::Add { path, contents } => {
            let relative = display_relative(&path)?;
            let path = resolve_patch_path(workspace, &path).await?;
            Ok(ResolvedHunk::Add {
                relative,
                path,
                contents,
            })
        }
        PatchHunk::Delete { path } => {
            let relative = display_relative(&path)?;
            let path = resolve_patch_path(workspace, &path).await?;
            Ok(ResolvedHunk::Delete { relative, path })
        }
        PatchHunk::Update {
            path,
            move_path,
            chunks,
        } => {
            let relative = display_relative(&path)?;
            let path = resolve_patch_path(workspace, &path).await?;
            let (move_relative, move_path) = match move_path {
                Some(destination) => (
                    Some(display_relative(&destination)?),
                    Some(resolve_patch_path(workspace, &destination).await?),
                ),
                None => (None, None),
            };
            Ok(ResolvedHunk::Update {
                relative,
                path,
                move_relative,
                move_path,
                chunks,
            })
        }
    }
}

fn validate_claims(hunks: &[ResolvedHunk]) -> Result<(), AppError> {
    let mut sources = HashMap::<String, usize>::new();
    let mut destinations = HashMap::<String, usize>::new();
    for (index, hunk) in hunks.iter().enumerate() {
        if let Some(source) = hunk.source() {
            let key = path_identity(source);
            if sources.insert(key, index).is_some() {
                return Err(AppError::Tool(
                    "patch contains a duplicate source path".into(),
                ));
            }
        }
        if let Some(destination) = hunk.destination() {
            let key = path_identity(destination);
            if destinations.insert(key, index).is_some() {
                return Err(AppError::Tool(
                    "patch contains a duplicate destination path".into(),
                ));
            }
        }
    }
    for (destination, destination_index) in destinations {
        if let Some(source_index) = sources.get(&destination)
            && (source_index != &destination_index
                || !hunks[destination_index].is_in_place_update())
        {
            return Err(AppError::Tool(
                "patch source and destination paths overlap".into(),
            ));
        }
    }
    Ok(())
}

async fn canonical_workspace(workspace: &Path) -> Result<PathBuf, AppError> {
    let workspace = tokio::fs::canonicalize(workspace)
        .await
        .map_err(|error| AppError::FileSystem(error.to_string()))?;
    let metadata = tokio::fs::metadata(&workspace)
        .await
        .map_err(|error| AppError::FileSystem(error.to_string()))?;
    if !metadata.is_dir() {
        return Err(AppError::FileSystem("workspace is not a directory".into()));
    }
    Ok(workspace)
}

async fn resolve_patch_path(workspace: &Path, relative: &Path) -> Result<PathBuf, AppError> {
    validate_relative_path(relative)?;
    let parent = relative
        .parent()
        .ok_or_else(|| AppError::Permission("patch path has no parent".into()))?;
    let canonical_parent = tokio::fs::canonicalize(workspace.join(parent))
        .await
        .map_err(|error| AppError::FileSystem(format!("patch parent is invalid: {error}")))?;
    if !canonical_parent.starts_with(workspace) {
        return Err(AppError::Permission(
            "patch path escapes the workspace".into(),
        ));
    }
    reject_existing_symlinks(workspace, relative).await?;
    let file_name = relative
        .file_name()
        .ok_or_else(|| AppError::Permission("patch path has no file name".into()))?;
    Ok(canonical_parent.join(file_name))
}

fn validate_relative_path(path: &Path) -> Result<(), AppError> {
    if path.as_os_str().is_empty() || path.is_absolute() {
        return Err(AppError::Permission(
            "patch paths must be non-empty and relative".into(),
        ));
    }
    let mut saw_component = false;
    for component in path.components() {
        match component {
            Component::Normal(_) => saw_component = true,
            Component::Prefix(_)
            | Component::RootDir
            | Component::CurDir
            | Component::ParentDir => {
                return Err(AppError::Permission(
                    "patch paths may contain only normal relative components".into(),
                ));
            }
        }
    }
    if !saw_component {
        return Err(AppError::Permission("patch path is empty".into()));
    }
    Ok(())
}

async fn reject_existing_symlinks(workspace: &Path, relative: &Path) -> Result<(), AppError> {
    let mut current = workspace.to_path_buf();
    for component in relative.components() {
        let Component::Normal(component) = component else {
            return Err(AppError::Permission("patch path is invalid".into()));
        };
        current.push(component);
        match tokio::fs::symlink_metadata(&current).await {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(AppError::Permission(format!(
                    "patch path contains a symbolic link: {}",
                    current.display()
                )));
            }
            Ok(_) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => break,
            Err(error) => return Err(AppError::FileSystem(error.to_string())),
        }
    }
    Ok(())
}

async fn snapshot(path: PathBuf) -> Result<FileSnapshot, AppError> {
    let metadata = match tokio::fs::symlink_metadata(&path).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return Ok(FileSnapshot {
                path,
                exists: false,
                bytes: Vec::new(),
                permissions: None,
                digest: Sha256::digest([]).into(),
            });
        }
        Err(error) => return Err(AppError::FileSystem(error.to_string())),
    };
    if metadata.file_type().is_symlink() {
        return Err(AppError::Permission(format!(
            "patch path is a symbolic link: {}",
            path.display()
        )));
    }
    if !metadata.is_file() {
        return Err(AppError::Tool(format!(
            "patch path is not a regular file: {}",
            path.display()
        )));
    }
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|error| AppError::FileSystem(error.to_string()))?;
    let metadata_after = tokio::fs::symlink_metadata(&path)
        .await
        .map_err(|error| AppError::FileSystem(error.to_string()))?;
    if metadata_after.file_type().is_symlink() || !metadata_after.is_file() {
        return Err(AppError::Tool(format!(
            "file changed while patch was being prepared: {}",
            path.display()
        )));
    }
    let digest = Sha256::digest(&bytes).into();
    Ok(FileSnapshot {
        path,
        exists: true,
        bytes,
        permissions: Some(metadata_after.permissions()),
        digest,
    })
}

fn require_existing_file(
    snapshot: &FileSnapshot,
    relative: &str,
    action: &str,
) -> Result<(), AppError> {
    if snapshot.exists {
        Ok(())
    } else {
        Err(AppError::Tool(format!(
            "cannot {action} missing file `{relative}`"
        )))
    }
}

fn apply_chunks(relative: &str, bytes: &[u8], chunks: &[UpdateChunk]) -> Result<Vec<u8>, AppError> {
    let text = std::str::from_utf8(bytes).map_err(|_| {
        AppError::Tool(format!(
            "cannot update non-UTF-8 file `{relative}` with text chunks"
        ))
    })?;
    let mut document = TextDocument::parse(text);
    let mut cursor = 0usize;
    for chunk in chunks {
        let position = locate_chunk(&document.lines, chunk, cursor).ok_or_else(|| {
            AppError::Tool(format!("context not found while updating `{relative}`"))
        })??;
        let old_len = chunk.old_lines.len();
        document
            .lines
            .splice(position..position + old_len, chunk.new_lines.clone());
        cursor = position + chunk.new_lines.len();
    }
    Ok(document.render().into_bytes())
}

fn locate_chunk(
    lines: &[String],
    chunk: &UpdateChunk,
    start: usize,
) -> Option<Result<usize, AppError>> {
    let candidates = if let Some(context) = &chunk.context {
        let anchors = best_matches(lines, std::slice::from_ref(context), start, false);
        let mut positions = BTreeSet::new();
        for anchor in anchors {
            if chunk.old_lines.is_empty() {
                positions.insert(if chunk.end_of_file {
                    lines.len()
                } else {
                    anchor + 1
                });
            } else if let Some(position) =
                best_matches(lines, &chunk.old_lines, anchor + 1, chunk.end_of_file)
                    .into_iter()
                    .next()
            {
                positions.insert(position);
            }
        }
        positions
    } else if chunk.old_lines.is_empty() {
        BTreeSet::from([if chunk.end_of_file {
            lines.len()
        } else {
            start.min(lines.len())
        }])
    } else {
        best_matches(lines, &chunk.old_lines, start, chunk.end_of_file)
            .into_iter()
            .collect()
    };

    match candidates.len() {
        0 => None,
        1 => candidates.into_iter().next().map(Ok),
        _ => Some(Err(AppError::Tool("ambiguous context in patch".into()))),
    }
}

fn best_matches(lines: &[String], pattern: &[String], start: usize, eof: bool) -> Vec<usize> {
    if pattern.is_empty() || pattern.len() > lines.len() || start > lines.len() {
        return Vec::new();
    }
    let last = lines.len() - pattern.len();
    let range_start = if eof { last } else { start };
    if range_start > last {
        return Vec::new();
    }
    for mode in 0..4 {
        let matches = (range_start..=last)
            .filter(|position| sequence_matches(lines, pattern, *position, mode))
            .collect::<Vec<_>>();
        if !matches.is_empty() {
            return matches;
        }
    }
    Vec::new()
}

fn sequence_matches(lines: &[String], pattern: &[String], position: usize, mode: u8) -> bool {
    lines[position..position + pattern.len()]
        .iter()
        .zip(pattern)
        .all(|(line, pattern)| match mode {
            0 => line == pattern,
            1 => line.trim_end() == pattern.trim_end(),
            2 => line.trim() == pattern.trim(),
            _ => normalize_punctuation(line) == normalize_punctuation(pattern),
        })
}

fn normalize_punctuation(value: &str) -> String {
    value
        .trim()
        .chars()
        .map(|character| match character {
            '\u{2010}' | '\u{2011}' | '\u{2012}' | '\u{2013}' | '\u{2014}' | '\u{2015}'
            | '\u{2212}' => '-',
            '\u{2018}' | '\u{2019}' | '\u{201a}' | '\u{201b}' => '\'',
            '\u{201c}' | '\u{201d}' | '\u{201e}' | '\u{201f}' => '"',
            '\u{00a0}' | '\u{2002}' | '\u{2003}' | '\u{2004}' | '\u{2005}' | '\u{2006}'
            | '\u{2007}' | '\u{2008}' | '\u{2009}' | '\u{200a}' | '\u{202f}' | '\u{205f}'
            | '\u{3000}' => ' ',
            other => other,
        })
        .collect()
}

struct TextDocument {
    lines: Vec<String>,
    trailing_newline: bool,
    line_ending: &'static str,
}

impl TextDocument {
    fn parse(text: &str) -> Self {
        let line_ending = if text.as_bytes().windows(2).any(|pair| pair == b"\r\n") {
            "\r\n"
        } else {
            "\n"
        };
        let normalized = text.replace("\r\n", "\n");
        let trailing_newline = normalized.ends_with('\n');
        let mut lines = normalized
            .split('\n')
            .map(str::to_string)
            .collect::<Vec<_>>();
        if trailing_newline {
            lines.pop();
        }
        if normalized.is_empty() {
            lines.clear();
        }
        Self {
            lines,
            trailing_newline,
            line_ending,
        }
    }

    fn render(self) -> String {
        let mut output = self.lines.join(self.line_ending);
        if self.trailing_newline {
            output.push_str(self.line_ending);
        }
        output
    }
}

fn render_add_diff(relative: &str, contents: &str) -> String {
    let mut output = format!("*** Add File: {relative}\n");
    for line in contents.strip_suffix('\n').unwrap_or(contents).split('\n') {
        output.push('+');
        output.push_str(line);
        output.push('\n');
    }
    output
}

fn render_update_diff(relative: &str, move_path: Option<&str>, chunks: &[UpdateChunk]) -> String {
    let mut output = format!("*** Update File: {relative}\n");
    if let Some(move_path) = move_path {
        output.push_str(&format!("*** Move to: {move_path}\n"));
    }
    for chunk in chunks {
        match &chunk.context {
            Some(context) => output.push_str(&format!("@@ {context}\n")),
            None => output.push_str("@@\n"),
        }
        for line in &chunk.old_lines {
            output.push('-');
            output.push_str(line);
            output.push('\n');
        }
        for line in &chunk.new_lines {
            output.push('+');
            output.push_str(line);
            output.push('\n');
        }
        if chunk.end_of_file {
            output.push_str("*** End of File\n");
        }
    }
    output
}

fn truncate_diff(value: &str) -> String {
    if value.len() <= MAX_DIFF_BYTES {
        return value.to_string();
    }
    let mut end = MAX_DIFF_BYTES;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n[diff truncated]", &value[..end])
}

fn display_relative(path: &Path) -> Result<String, AppError> {
    validate_relative_path(path)?;
    Ok(display_unchecked(path))
}

fn display_unchecked(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn path_identity(path: &Path) -> String {
    let value = path.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        value.to_lowercase()
    } else {
        value
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use tempfile::TempDir;

    use crate::engine::FileChangeKind;

    use super::super::parser::parse_patch;
    use super::{PreparedChange, prepare_patch};

    #[tokio::test]
    async fn prepares_all_changes_and_canonical_timeline_entries() {
        let workspace = TempDir::new().expect("workspace should exist");
        tokio::fs::create_dir(workspace.path().join("src"))
            .await
            .expect("source directory should exist");
        tokio::fs::write(
            workspace.path().join("src/update.txt"),
            "heading\nold\nending\n",
        )
        .await
        .expect("update source should exist");
        tokio::fs::write(workspace.path().join("src/delete.txt"), "delete me\n")
            .await
            .expect("delete source should exist");
        tokio::fs::write(workspace.path().join("src/move.txt"), "move me\n")
            .await
            .expect("move source should exist");
        let parsed = parse_patch(
            "*** Begin Patch\n\
*** Add File: src/add.txt\n\
+added\n\
*** Delete File: src/delete.txt\n\
*** Update File: src/update.txt\n\
@@ heading\n\
-old\n\
+new\n\
*** Update File: src/move.txt\n\
*** Move to: src/moved.txt\n\
*** End Patch",
        )
        .expect("patch should parse");

        let prepared = prepare_patch(workspace.path(), parsed)
            .await
            .expect("patch should prepare");

        assert_eq!(prepared.changes.len(), 4);
        assert_eq!(prepared.thread_changes.len(), 4);
        assert!(matches!(
            &prepared.changes[0],
            PreparedChange::Write { original, final_bytes }
                if !original.exists && original.path.ends_with("add.txt") && final_bytes == b"added\n"
        ));
        assert!(matches!(
            &prepared.changes[1],
            PreparedChange::Delete { original }
                if original.exists && original.path.ends_with("delete.txt")
        ));
        assert!(matches!(
            &prepared.changes[2],
            PreparedChange::Write { original, final_bytes }
                if original.exists && final_bytes == b"heading\nnew\nending\n"
        ));
        assert!(matches!(
            &prepared.changes[3],
            PreparedChange::Move { source_original, destination_original, final_bytes }
                if source_original.path.ends_with("move.txt")
                    && destination_original.path.ends_with("moved.txt")
                    && !destination_original.exists
                    && final_bytes == b"move me\n"
        ));
        assert!(matches!(
            prepared.thread_changes[0].kind,
            FileChangeKind::Add
        ));
        assert!(matches!(
            prepared.thread_changes[1].kind,
            FileChangeKind::Delete
        ));
        assert!(matches!(
            &prepared.thread_changes[3].kind,
            FileChangeKind::Update { move_path: Some(path) } if path == "src/moved.txt"
        ));
    }

    #[tokio::test]
    async fn applies_ordered_chunks_preserves_crlf_and_honors_eof() {
        let workspace = TempDir::new().expect("workspace should exist");
        let path = workspace.path().join("source.txt");
        tokio::fs::write(&path, "one\r\nold\r\ntwo\r\nold\r\n")
            .await
            .expect("source should exist");
        let parsed = parse_patch(
            "*** Begin Patch\n\
*** Update File: source.txt\n\
@@ one\n\
-old\n\
+first\n\
@@\n\
-old\n\
+last\n\
*** End of File\n\
*** End Patch",
        )
        .expect("patch should parse");

        let prepared = prepare_patch(workspace.path(), parsed)
            .await
            .expect("ordered patch should prepare");
        let PreparedChange::Write { final_bytes, .. } = &prepared.changes[0] else {
            panic!("expected write");
        };
        assert_eq!(final_bytes, b"one\r\nfirst\r\ntwo\r\nlast\r\n");
    }

    #[tokio::test]
    async fn rejects_ambiguous_or_missing_context_without_writes() {
        let workspace = TempDir::new().expect("workspace should exist");
        let path = workspace.path().join("source.txt");
        tokio::fs::write(&path, "same\nsame\n")
            .await
            .expect("source should exist");

        for old in ["same", "missing"] {
            let parsed = parse_patch(&format!(
                "*** Begin Patch\n*** Update File: source.txt\n@@\n-{old}\n+new\n*** End Patch"
            ))
            .expect("patch should parse");
            let error = prepare_patch(workspace.path(), parsed)
                .await
                .expect_err("context should be rejected");
            let rendered = error.to_string();
            assert!(
                rendered.contains("ambiguous context") || rendered.contains("context not found"),
                "{rendered}"
            );
            assert_eq!(
                tokio::fs::read_to_string(&path)
                    .await
                    .expect("source should remain readable"),
                "same\nsame\n"
            );
        }
    }

    #[tokio::test]
    async fn rejects_invalid_paths_duplicate_claims_and_invalid_existence() {
        let workspace = TempDir::new().expect("workspace should exist");
        tokio::fs::write(workspace.path().join("existing.txt"), "content\n")
            .await
            .expect("existing file should exist");
        let absolute = workspace.path().join("absolute.txt");
        let cases = [
            "*** Begin Patch\n*** Add File: ../outside.txt\n+x\n*** End Patch".to_string(),
            format!(
                "*** Begin Patch\n*** Add File: {}\n+x\n*** End Patch",
                absolute.display()
            ),
            "*** Begin Patch\n*** Add File: duplicate.txt\n+x\n*** Add File: duplicate.txt\n+y\n*** End Patch".to_string(),
            "*** Begin Patch\n*** Add File: existing.txt\n+x\n*** End Patch".to_string(),
            "*** Begin Patch\n*** Delete File: missing.txt\n*** End Patch".to_string(),
            "*** Begin Patch\n*** Update File: missing.txt\n@@\n-old\n+new\n*** End Patch".to_string(),
        ];

        for patch in cases {
            let parsed = parse_patch(&patch).expect("parser should accept structural patch");
            assert!(prepare_patch(workspace.path(), parsed).await.is_err());
        }
        assert!(!Path::new(&workspace.path().join("duplicate.txt")).exists());
    }

    #[cfg(any(unix, windows))]
    #[tokio::test]
    async fn rejects_symlink_sources() {
        let workspace = TempDir::new().expect("workspace should exist");
        let outside = TempDir::new().expect("outside directory should exist");
        let outside_file = outside.path().join("outside.txt");
        tokio::fs::write(&outside_file, "outside\n")
            .await
            .expect("outside source should exist");
        let link = workspace.path().join("linked.txt");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside_file, &link).expect("symlink should be created");
        #[cfg(windows)]
        if let Err(error) = std::os::windows::fs::symlink_file(&outside_file, &link) {
            if error.kind() == std::io::ErrorKind::PermissionDenied {
                return;
            }
            panic!("symlink should be created: {error}");
        }
        let parsed = parse_patch("*** Begin Patch\n*** Delete File: linked.txt\n*** End Patch")
            .expect("patch should parse");

        let error = prepare_patch(workspace.path(), parsed)
            .await
            .expect_err("symlink should be rejected");
        assert!(error.to_string().contains("symbolic link"));
    }
}
