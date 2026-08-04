use std::collections::HashSet;
use std::io::{ErrorKind, Write as _};
use std::path::Path;

use sha2::{Digest as _, Sha256};
use tempfile::NamedTempFile;
use tokio::sync::watch;

use crate::engine::FileChange;
use crate::error::AppError;

use super::plan::{FileSnapshot, PreparedChange, PreparedPatch};

#[derive(Debug)]
pub(super) struct PatchOutcome {
    pub changes: Vec<FileChange>,
    pub output: String,
}

pub(super) async fn commit_patch(
    prepared: PreparedPatch,
    cancellation: &mut watch::Receiver<bool>,
) -> Result<PatchOutcome, AppError> {
    commit_patch_internal(prepared, cancellation.clone(), None).await
}

#[cfg(test)]
async fn commit_patch_with_failure(
    prepared: PreparedPatch,
    cancellation: &mut watch::Receiver<bool>,
    fail_at: usize,
) -> Result<PatchOutcome, AppError> {
    commit_patch_internal(prepared, cancellation.clone(), Some(fail_at)).await
}

async fn commit_patch_internal(
    prepared: PreparedPatch,
    cancellation: watch::Receiver<bool>,
    fail_at: Option<usize>,
) -> Result<PatchOutcome, AppError> {
    tokio::task::spawn_blocking(move || commit_patch_blocking(prepared, cancellation, fail_at))
        .await
        .map_err(|error| AppError::FileSystem(format!("patch commit task failed: {error}")))?
}

fn commit_patch_blocking(
    prepared: PreparedPatch,
    cancellation: watch::Receiver<bool>,
    fail_at: Option<usize>,
) -> Result<PatchOutcome, AppError> {
    if is_cancelled(&cancellation) {
        return Err(AppError::Cancelled(
            "the turn was canceled before applying the patch".into(),
        ));
    }
    let PreparedPatch {
        changes,
        thread_changes,
    } = prepared;
    let mut temporary_files = prepare_temporary_files(&changes)?;
    if is_cancelled(&cancellation) {
        return Err(AppError::Cancelled(
            "the turn was canceled before applying the patch".into(),
        ));
    }
    revalidate_snapshots(&changes)?;

    let mut touched = false;
    for (index, change) in changes.iter().enumerate() {
        if is_cancelled(&cancellation) {
            return Err(rollback_or_integrity_error(
                AppError::Cancelled("the turn was canceled while applying the patch".into()),
                touched,
                &changes,
            ));
        }
        if fail_at == Some(index) {
            return Err(rollback_or_integrity_error(
                AppError::Tool(format!(
                    "injected patch commit failure at change {}",
                    index + 1
                )),
                touched,
                &changes,
            ));
        }
        touched = true;
        let result = match change {
            PreparedChange::Write { original, .. } => take_temporary(&mut temporary_files, index)
                .and_then(|temporary| persist_temporary(temporary, &original.path)),
            PreparedChange::Delete { original } => remove_file(&original.path),
            PreparedChange::Move {
                source_original,
                destination_original,
                ..
            } => take_temporary(&mut temporary_files, index)
                .and_then(|temporary| persist_temporary(temporary, &destination_original.path))
                .and_then(|()| remove_file(&source_original.path)),
        };
        if let Err(error) = result {
            return Err(rollback_or_integrity_error(error, touched, &changes));
        }
    }

    let count = thread_changes.len();
    let noun = if count == 1 { "file" } else { "files" };
    Ok(PatchOutcome {
        changes: thread_changes,
        output: format!("Applied patch to {count} {noun}."),
    })
}

fn prepare_temporary_files(
    changes: &[PreparedChange],
) -> Result<Vec<Option<NamedTempFile>>, AppError> {
    let mut temporary_files = Vec::with_capacity(changes.len());
    for change in changes {
        let write = match change {
            PreparedChange::Write {
                original,
                final_bytes,
            } => Some((
                original.path.as_path(),
                final_bytes.as_slice(),
                original.permissions.as_ref(),
            )),
            PreparedChange::Delete { .. } => None,
            PreparedChange::Move {
                source_original,
                destination_original,
                final_bytes,
            } => Some((
                destination_original.path.as_path(),
                final_bytes.as_slice(),
                source_original.permissions.as_ref(),
            )),
        };
        let Some((destination, bytes, permissions)) = write else {
            temporary_files.push(None);
            continue;
        };
        let parent = destination
            .parent()
            .ok_or_else(|| AppError::FileSystem("patch target has no parent".into()))?;
        let mut temporary = NamedTempFile::new_in(parent)
            .map_err(|error| AppError::FileSystem(error.to_string()))?;
        temporary
            .as_file_mut()
            .write_all(bytes)
            .map_err(|error| AppError::FileSystem(error.to_string()))?;
        temporary
            .as_file()
            .sync_all()
            .map_err(|error| AppError::FileSystem(error.to_string()))?;
        if let Some(permissions) = permissions {
            std::fs::set_permissions(temporary.path(), permissions.clone())
                .map_err(|error| AppError::FileSystem(error.to_string()))?;
            temporary
                .as_file()
                .sync_all()
                .map_err(|error| AppError::FileSystem(error.to_string()))?;
        }
        temporary_files.push(Some(temporary));
    }
    Ok(temporary_files)
}

fn revalidate_snapshots(changes: &[PreparedChange]) -> Result<(), AppError> {
    for snapshot in snapshots(changes) {
        if !snapshot_matches(snapshot)? {
            return Err(AppError::Tool(format!(
                "file changed while patch was being prepared: {}",
                snapshot.path.display()
            )));
        }
    }
    Ok(())
}

fn snapshot_matches(snapshot: &FileSnapshot) -> Result<bool, AppError> {
    let metadata = match std::fs::symlink_metadata(&snapshot.path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(!snapshot.exists),
        Err(error) => return Err(AppError::FileSystem(error.to_string())),
    };
    if !snapshot.exists || metadata.file_type().is_symlink() || !metadata.is_file() {
        return Ok(false);
    }
    let bytes =
        std::fs::read(&snapshot.path).map_err(|error| AppError::FileSystem(error.to_string()))?;
    let digest: [u8; 32] = Sha256::digest(&bytes).into();
    Ok(digest == snapshot.digest)
}

fn snapshots(changes: &[PreparedChange]) -> Vec<&FileSnapshot> {
    let mut output = Vec::with_capacity(changes.len() * 2);
    for change in changes {
        match change {
            PreparedChange::Write { original, .. } | PreparedChange::Delete { original } => {
                output.push(original)
            }
            PreparedChange::Move {
                source_original,
                destination_original,
                ..
            } => {
                output.push(source_original);
                output.push(destination_original);
            }
        }
    }
    output
}

fn take_temporary(
    temporary_files: &mut [Option<NamedTempFile>],
    index: usize,
) -> Result<NamedTempFile, AppError> {
    temporary_files[index]
        .take()
        .ok_or_else(|| AppError::State("patch temporary file is missing".into()))
}

fn persist_temporary(temporary: NamedTempFile, destination: &Path) -> Result<(), AppError> {
    make_replaceable(destination)?;
    let file = temporary
        .persist(destination)
        .map_err(|error| AppError::FileSystem(error.error.to_string()))?;
    file.sync_all()
        .map_err(|error| AppError::FileSystem(error.to_string()))?;
    Ok(())
}

fn remove_file(path: &Path) -> Result<(), AppError> {
    make_replaceable(path)?;
    std::fs::remove_file(path).map_err(|error| AppError::FileSystem(error.to_string()))
}

fn rollback_or_integrity_error(
    original: AppError,
    touched: bool,
    changes: &[PreparedChange],
) -> AppError {
    if !touched {
        return original;
    }
    let failures = rollback(changes);
    if failures.is_empty() {
        original
    } else {
        AppError::State(format!(
            "patch integrity failure after `{original}`; could not restore: {}",
            failures.join(", ")
        ))
    }
}

fn rollback(changes: &[PreparedChange]) -> Vec<String> {
    let mut restored = HashSet::new();
    let mut failures = Vec::new();
    for snapshot in snapshots(changes).into_iter().rev() {
        if !restored.insert(snapshot.path.clone()) {
            continue;
        }
        if let Err(error) = restore_snapshot(snapshot) {
            failures.push(format!("{} ({error})", snapshot.path.display()));
        }
    }
    failures
}

fn restore_snapshot(snapshot: &FileSnapshot) -> Result<(), AppError> {
    if !snapshot.exists {
        match std::fs::symlink_metadata(&snapshot.path) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
                return Err(AppError::FileSystem(
                    "rollback target became a directory".into(),
                ));
            }
            Ok(_) => return remove_file(&snapshot.path),
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(AppError::FileSystem(error.to_string())),
        }
    }
    let parent = snapshot
        .path
        .parent()
        .ok_or_else(|| AppError::FileSystem("rollback target has no parent".into()))?;
    let mut temporary =
        NamedTempFile::new_in(parent).map_err(|error| AppError::FileSystem(error.to_string()))?;
    temporary
        .as_file_mut()
        .write_all(&snapshot.bytes)
        .map_err(|error| AppError::FileSystem(error.to_string()))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| AppError::FileSystem(error.to_string()))?;
    if let Some(permissions) = &snapshot.permissions {
        std::fs::set_permissions(temporary.path(), permissions.clone())
            .map_err(|error| AppError::FileSystem(error.to_string()))?;
    }
    persist_temporary(temporary, &snapshot.path)
}

fn is_cancelled(cancellation: &watch::Receiver<bool>) -> bool {
    *cancellation.borrow()
}

#[cfg(windows)]
fn make_replaceable(path: &Path) -> Result<(), AppError> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(AppError::FileSystem(error.to_string())),
    };
    if metadata.file_type().is_symlink() {
        return Err(AppError::Permission(format!(
            "refusing to replace symbolic link during patch commit: {}",
            path.display()
        )));
    }
    let mut permissions = metadata.permissions();
    if permissions.readonly() {
        permissions.set_readonly(false);
        std::fs::set_permissions(path, permissions)
            .map_err(|error| AppError::FileSystem(error.to_string()))?;
    }
    Ok(())
}

#[cfg(not(windows))]
fn make_replaceable(_path: &Path) -> Result<(), AppError> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;
    use tokio::sync::watch;

    use super::super::parser::parse_patch;
    use super::super::plan::prepare_patch;
    use super::{commit_patch, commit_patch_with_failure};

    #[tokio::test]
    async fn commits_multi_file_patch_move_and_permissions() {
        let workspace = TempDir::new().expect("workspace should exist");
        tokio::fs::write(workspace.path().join("a.txt"), "old a\n")
            .await
            .expect("a should exist");
        tokio::fs::write(workspace.path().join("b.txt"), "delete\n")
            .await
            .expect("b should exist");
        tokio::fs::write(workspace.path().join("move.txt"), "move\n")
            .await
            .expect("move source should exist");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            tokio::fs::set_permissions(
                workspace.path().join("a.txt"),
                std::fs::Permissions::from_mode(0o640),
            )
            .await
            .expect("permissions should be set");
        }
        let parsed = parse_patch(
            "*** Begin Patch\n\
*** Update File: a.txt\n\
@@\n\
-old a\n\
+new a\n\
*** Delete File: b.txt\n\
*** Update File: move.txt\n\
*** Move to: moved.txt\n\
*** Add File: added.txt\n\
+added\n\
*** End Patch",
        )
        .expect("patch should parse");
        let prepared = prepare_patch(workspace.path(), parsed)
            .await
            .expect("patch should prepare");
        let (_sender, mut cancellation) = watch::channel(false);

        let outcome = commit_patch(prepared, &mut cancellation)
            .await
            .expect("patch should commit");

        assert_eq!(outcome.changes.len(), 4);
        assert_eq!(outcome.output, "Applied patch to 4 files.");
        assert_eq!(
            tokio::fs::read_to_string(workspace.path().join("a.txt"))
                .await
                .expect("a should remain"),
            "new a\n"
        );
        assert!(!workspace.path().join("b.txt").exists());
        assert!(!workspace.path().join("move.txt").exists());
        assert_eq!(
            tokio::fs::read_to_string(workspace.path().join("moved.txt"))
                .await
                .expect("move destination should exist"),
            "move\n"
        );
        assert_eq!(
            tokio::fs::read_to_string(workspace.path().join("added.txt"))
                .await
                .expect("add destination should exist"),
            "added\n"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = tokio::fs::metadata(workspace.path().join("a.txt"))
                .await
                .expect("a metadata should exist")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o640);
        }
    }

    #[tokio::test]
    async fn cancellation_before_commit_writes_nothing() {
        let workspace = TempDir::new().expect("workspace should exist");
        let parsed = parse_patch("*** Begin Patch\n*** Add File: added.txt\n+added\n*** End Patch")
            .expect("patch should parse");
        let prepared = prepare_patch(workspace.path(), parsed)
            .await
            .expect("patch should prepare");
        let (sender, mut cancellation) = watch::channel(false);
        sender.send(true).expect("cancellation should send");

        let error = commit_patch(prepared, &mut cancellation)
            .await
            .expect_err("commit should cancel");

        assert!(matches!(error, crate::error::AppError::Cancelled(_)));
        assert!(!workspace.path().join("added.txt").exists());
    }

    #[tokio::test]
    async fn concurrent_source_change_is_detected_before_writes() {
        let workspace = TempDir::new().expect("workspace should exist");
        let path = workspace.path().join("source.txt");
        tokio::fs::write(&path, "old\n")
            .await
            .expect("source should exist");
        let parsed = parse_patch(
            "*** Begin Patch\n*** Update File: source.txt\n@@\n-old\n+new\n*** End Patch",
        )
        .expect("patch should parse");
        let prepared = prepare_patch(workspace.path(), parsed)
            .await
            .expect("patch should prepare");
        tokio::fs::write(&path, "concurrent\n")
            .await
            .expect("concurrent writer should succeed");
        let (_sender, mut cancellation) = watch::channel(false);

        let error = commit_patch(prepared, &mut cancellation)
            .await
            .expect_err("snapshot mismatch should fail");

        assert!(error.to_string().contains("file changed while patch"));
        assert_eq!(
            tokio::fs::read_to_string(&path)
                .await
                .expect("concurrent content should remain"),
            "concurrent\n"
        );
    }

    #[tokio::test]
    async fn injected_second_swap_failure_rolls_back_everything_and_cleans_temps() {
        let workspace = TempDir::new().expect("workspace should exist");
        for name in ["a.txt", "b.txt"] {
            tokio::fs::write(workspace.path().join(name), format!("old {name}\n"))
                .await
                .expect("source should exist");
        }
        let parsed = parse_patch(
            "*** Begin Patch\n\
*** Update File: a.txt\n\
@@\n\
-old a.txt\n\
+new a\n\
*** Update File: b.txt\n\
@@\n\
-old b.txt\n\
+new b\n\
*** End Patch",
        )
        .expect("patch should parse");
        let prepared = prepare_patch(workspace.path(), parsed)
            .await
            .expect("patch should prepare");
        let (_sender, mut cancellation) = watch::channel(false);

        let error = commit_patch_with_failure(prepared, &mut cancellation, 1)
            .await
            .expect_err("second swap should fail");

        assert!(error.to_string().contains("injected patch commit failure"));
        assert_eq!(
            tokio::fs::read_to_string(workspace.path().join("a.txt"))
                .await
                .expect("a should be restored"),
            "old a.txt\n"
        );
        assert_eq!(
            tokio::fs::read_to_string(workspace.path().join("b.txt"))
                .await
                .expect("b should be unchanged"),
            "old b.txt\n"
        );
        let mut names = std::fs::read_dir(workspace.path())
            .expect("workspace should list")
            .map(|entry| {
                entry
                    .expect("entry should be readable")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect::<Vec<_>>();
        names.sort();
        assert_eq!(names, ["a.txt", "b.txt"]);
    }
}
