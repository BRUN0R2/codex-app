use std::fs::{File, Permissions};
use std::io::{ErrorKind, Read as _, Write as _};
use std::path::{Path, PathBuf};

use tempfile::NamedTempFile;
use tokio::sync::watch;

use crate::engine::FileChange;
use crate::error::AppError;

use super::paths::{create_parents, is_link, validate_target};
use super::plan::{FileSnapshot, PreparedChange, PreparedPatch};

#[derive(Debug)]
pub(in crate::engine::native) struct PatchOutcome {
    pub changes: Vec<FileChange>,
    pub output: String,
}

#[derive(Clone, Copy)]
enum ExpectedContent<'a> {
    Missing,
    Present(&'a [u8]),
}

struct AppliedFile<'a> {
    original: &'a FileSnapshot,
    current: ExpectedContent<'a>,
}

struct StagedFile {
    temporary: NamedTempFile,
    permissions: Option<Permissions>,
}

pub(in crate::engine::native) async fn commit_patch(
    prepared: PreparedPatch,
    cancellation: &mut watch::Receiver<bool>,
) -> Result<PatchOutcome, AppError> {
    commit_patch_internal(prepared, cancellation.clone(), |_| Ok(())).await
}

#[cfg(test)]
async fn commit_patch_with_failure(
    prepared: PreparedPatch,
    cancellation: &mut watch::Receiver<bool>,
    fail_at: usize,
) -> Result<PatchOutcome, AppError> {
    commit_patch_internal(prepared, cancellation.clone(), move |index| {
        if index == fail_at {
            Err(AppError::Tool(format!(
                "injected patch commit failure at change {}",
                index + 1
            )))
        } else {
            Ok(())
        }
    })
    .await
}

async fn commit_patch_internal(
    prepared: PreparedPatch,
    cancellation: watch::Receiver<bool>,
    before_change: impl FnMut(usize) -> Result<(), AppError> + Send + 'static,
) -> Result<PatchOutcome, AppError> {
    tokio::task::spawn_blocking(move || {
        commit_patch_blocking(prepared, cancellation, before_change)
    })
    .await
    .map_err(|error| AppError::FileSystem(format!("patch commit task failed: {error}")))?
}

fn commit_patch_blocking(
    prepared: PreparedPatch,
    cancellation: watch::Receiver<bool>,
    mut before_change: impl FnMut(usize) -> Result<(), AppError>,
) -> Result<PatchOutcome, AppError> {
    if is_cancelled(&cancellation) {
        return Err(AppError::Cancelled(
            "the turn was canceled before applying the patch".into(),
        ));
    }
    let PreparedPatch {
        workspace,
        changes,
        thread_changes,
    } = prepared;
    let mut touched = Vec::new();
    let mut directories = Vec::new();
    let result = (|| {
        revalidate_snapshots(&workspace, &changes)?;
        let mut temporary_files =
            prepare_temporary_files(&workspace, &changes, &mut directories, &cancellation)?;
        revalidate_snapshots(&workspace, &changes)?;
        for (index, change) in changes.iter().enumerate() {
            before_change(index)?;
            check_cancellation(&cancellation)?;
            match change {
                PreparedChange::Write {
                    original,
                    final_bytes,
                } => {
                    revalidate_snapshot(&workspace, original)?;
                    let temporary = take_temporary(&mut temporary_files, index)?;
                    persist_change(temporary, original, final_bytes, &mut touched)?;
                }
                PreparedChange::Delete { original } => {
                    revalidate_snapshot(&workspace, original)?;
                    remove_change(original, &mut touched)?;
                }
                PreparedChange::Move {
                    source_original,
                    destination_original,
                    final_bytes,
                } => {
                    revalidate_snapshot(&workspace, source_original)?;
                    revalidate_snapshot(&workspace, destination_original)?;
                    let temporary = take_temporary(&mut temporary_files, index)?;
                    persist_change(temporary, destination_original, final_bytes, &mut touched)?;
                    revalidate_snapshot(&workspace, source_original)?;
                    remove_change(source_original, &mut touched)?;
                }
            }
        }
        Ok(())
    })();
    if let Err(error) = result {
        return Err(rollback_or_integrity_error(
            error,
            &workspace,
            &touched,
            &directories,
        ));
    }

    let count = thread_changes.len();
    let noun = if count == 1 { "file" } else { "files" };
    Ok(PatchOutcome {
        changes: thread_changes,
        output: format!("Applied patch to {count} {noun}."),
    })
}

fn prepare_temporary_files(
    workspace: &Path,
    changes: &[PreparedChange],
    directories: &mut Vec<PathBuf>,
    cancellation: &watch::Receiver<bool>,
) -> Result<Vec<Option<StagedFile>>, AppError> {
    let mut temporary_files = Vec::with_capacity(changes.len());
    for change in changes {
        check_cancellation(cancellation)?;
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
        create_parents(workspace, destination, directories)?;
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
        temporary_files.push(Some(StagedFile {
            temporary,
            permissions: permissions.cloned(),
        }));
    }
    Ok(temporary_files)
}

fn revalidate_snapshots(workspace: &Path, changes: &[PreparedChange]) -> Result<(), AppError> {
    for snapshot in snapshots(changes) {
        revalidate_snapshot(workspace, snapshot)?;
    }
    Ok(())
}

fn revalidate_snapshot(workspace: &Path, snapshot: &FileSnapshot) -> Result<(), AppError> {
    validate_target(workspace, &snapshot.path)?;
    if !snapshot_matches(snapshot)? {
        return Err(AppError::Tool(format!(
            "file changed while patch was being prepared: {}",
            snapshot.path.display()
        )));
    }
    Ok(())
}

fn snapshot_matches(snapshot: &FileSnapshot) -> Result<bool, AppError> {
    content_matches(
        &snapshot.path,
        if snapshot.exists {
            ExpectedContent::Present(&snapshot.bytes)
        } else {
            ExpectedContent::Missing
        },
    )
}

fn content_matches(path: &Path, expected: ExpectedContent<'_>) -> Result<bool, AppError> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return Ok(matches!(expected, ExpectedContent::Missing));
        }
        Err(error) => return Err(AppError::FileSystem(error.to_string())),
    };
    let ExpectedContent::Present(expected) = expected else {
        return Ok(false);
    };
    if is_link(&metadata) || !metadata.is_file() || metadata.len() != expected.len() as u64 {
        return Ok(false);
    }
    let mut file =
        std::fs::File::open(path).map_err(|error| AppError::FileSystem(error.to_string()))?;
    const COMPARISON_BUFFER_BYTES: usize = 8_192;
    let mut buffer = [0; COMPARISON_BUFFER_BYTES];
    for expected_chunk in expected.chunks(COMPARISON_BUFFER_BYTES) {
        let chunk = &mut buffer[..expected_chunk.len()];
        match file.read_exact(chunk) {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::UnexpectedEof => return Ok(false),
            Err(error) => return Err(AppError::FileSystem(error.to_string())),
        }
        if chunk != expected_chunk {
            return Ok(false);
        }
    }
    file.read(&mut buffer[..1])
        .map(|read| read == 0)
        .map_err(|error| AppError::FileSystem(error.to_string()))
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
    temporary_files: &mut [Option<StagedFile>],
    index: usize,
) -> Result<StagedFile, AppError> {
    temporary_files[index]
        .take()
        .ok_or_else(|| AppError::State("patch temporary file is missing".into()))
}

fn persist_temporary(
    temporary: NamedTempFile,
    destination: &Path,
    permissions: Option<Permissions>,
) -> Result<(), AppError> {
    make_replaceable(destination)?;
    let file = temporary
        .persist(destination)
        .map_err(|error| AppError::FileSystem(error.error.to_string()))?;
    finish_persisted_file(file, permissions)
}

fn finish_persisted_file(file: File, permissions: Option<Permissions>) -> Result<(), AppError> {
    if let Some(permissions) = permissions {
        file.set_permissions(permissions)
            .map_err(|error| AppError::FileSystem(error.to_string()))?;
    }
    file.sync_all()
        .map_err(|error| AppError::FileSystem(error.to_string()))
}

fn persist_change<'a>(
    staged: StagedFile,
    original: &'a FileSnapshot,
    final_bytes: &'a [u8],
    touched: &mut Vec<AppliedFile<'a>>,
) -> Result<(), AppError> {
    let StagedFile {
        temporary,
        permissions,
    } = staged;
    if original.exists {
        touched.push(AppliedFile {
            original,
            current: ExpectedContent::Present(&original.bytes),
        });
        make_replaceable(&original.path)?;
        let file = temporary
            .persist(&original.path)
            .map_err(|error| AppError::FileSystem(error.error.to_string()))?;
        let index = touched.len() - 1;
        touched[index].current = ExpectedContent::Present(final_bytes);
        finish_persisted_file(file, permissions)
    } else {
        let file = temporary
            .persist_noclobber(&original.path)
            .map_err(|error| AppError::FileSystem(error.error.to_string()))?;
        touched.push(AppliedFile {
            original,
            current: ExpectedContent::Present(final_bytes),
        });
        finish_persisted_file(file, permissions)
    }
}

fn remove_change<'a>(
    original: &'a FileSnapshot,
    touched: &mut Vec<AppliedFile<'a>>,
) -> Result<(), AppError> {
    touched.push(AppliedFile {
        original,
        current: ExpectedContent::Present(&original.bytes),
    });
    remove_file(&original.path)?;
    let index = touched.len() - 1;
    touched[index].current = ExpectedContent::Missing;
    Ok(())
}

fn remove_file(path: &Path) -> Result<(), AppError> {
    make_replaceable(path)?;
    std::fs::remove_file(path).map_err(|error| AppError::FileSystem(error.to_string()))
}

fn rollback_or_integrity_error(
    original: AppError,
    workspace: &Path,
    touched: &[AppliedFile<'_>],
    directories: &[PathBuf],
) -> AppError {
    let mut failures = rollback(workspace, touched);
    for directory in directories.iter().rev() {
        if let Err(error) = std::fs::remove_dir(directory) {
            failures.push(format!("{} ({error})", directory.display()));
        }
    }
    if failures.is_empty() {
        original
    } else {
        AppError::State(format!(
            "patch integrity failure after `{original}`; could not restore: {}",
            failures.join(", ")
        ))
    }
}

fn rollback(workspace: &Path, touched: &[AppliedFile<'_>]) -> Vec<String> {
    let mut failures = Vec::new();
    for applied in touched.iter().rev() {
        let result = (|| {
            validate_target(workspace, &applied.original.path)?;
            if !content_matches(&applied.original.path, applied.current)? {
                return Err(AppError::State(
                    "file changed after the patch wrote it; concurrent content was preserved"
                        .into(),
                ));
            }
            restore_snapshot(applied.original)
        })();
        if let Err(error) = result {
            failures.push(format!("{} ({error})", applied.original.path.display()));
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
    persist_temporary(temporary, &snapshot.path, snapshot.permissions.clone())
}

fn is_cancelled(cancellation: &watch::Receiver<bool>) -> bool {
    *cancellation.borrow()
}

fn check_cancellation(cancellation: &watch::Receiver<bool>) -> Result<(), AppError> {
    if is_cancelled(cancellation) {
        Err(AppError::Cancelled(
            "the turn was canceled while applying the patch".into(),
        ))
    } else {
        Ok(())
    }
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
        // This function is Windows-only, where false clears the read-only file
        // attribute. The Unix behavior described by the lint cannot apply.
        #[allow(clippy::permissions_set_readonly_false)]
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

    const NESTED_PATCH: &str = "*** Begin Patch\n*** Update File: first.txt\n@@\n-old\n+new\n*** Update File: move.txt\n*** Move to: new/deep/moved.txt\n*** Add File: new/added.txt\n+added\n*** Delete File: last.txt\n*** End Patch";

    fn batch_workspace() -> TempDir {
        let workspace = TempDir::new().expect("workspace should exist");
        for name in ["first.txt", "move.txt", "last.txt"] {
            std::fs::write(workspace.path().join(name), "old\n").expect("source should exist");
        }
        workspace
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn windows_readonly_attributes_survive_commit_and_rollback_without_staging_leaks() {
        for fail_at in [Some(0), Some(2), None] {
            let workspace = batch_workspace();
            for name in ["first.txt", "move.txt", "last.txt"] {
                let path = workspace.path().join(name);
                let mut permissions = std::fs::metadata(&path)
                    .expect("source metadata should exist")
                    .permissions();
                permissions.set_readonly(true);
                std::fs::set_permissions(path, permissions).expect("source should become readonly");
            }
            let prepared = prepare_patch(
                workspace.path(),
                parse_patch(NESTED_PATCH).expect("batch should parse"),
            )
            .await
            .expect("readonly sources should prepare");
            let (_sender, mut cancellation) = watch::channel(false);
            let paths = if let Some(fail_at) = fail_at {
                commit_patch_with_failure(prepared, &mut cancellation, fail_at)
                    .await
                    .expect_err("injected failure should roll back");
                assert!(!workspace.path().join("new").exists());
                vec!["first.txt", "move.txt", "last.txt"]
            } else {
                commit_patch(prepared, &mut cancellation)
                    .await
                    .expect("readonly sources should commit");
                vec!["first.txt", "new/deep/moved.txt"]
            };
            for path in paths {
                assert!(
                    std::fs::metadata(workspace.path().join(path))
                        .expect("file should exist")
                        .permissions()
                        .readonly(),
                    "{path}"
                );
            }
            assert_eq!(
                std::fs::read_dir(workspace.path())
                    .expect("workspace should list")
                    .count(),
                if fail_at.is_some() { 3 } else { 2 }
            );
        }
    }

    #[tokio::test]
    async fn failure_at_every_commit_position_restores_files_and_removes_created_directories() {
        for fail_at in 0..4 {
            let workspace = batch_workspace();
            let parsed = parse_patch(NESTED_PATCH).expect("batch should parse");
            let prepared = prepare_patch(workspace.path(), parsed)
                .await
                .expect("batch should prepare");
            let (_sender, mut cancellation) = watch::channel(false);
            let error = commit_patch_with_failure(prepared, &mut cancellation, fail_at)
                .await
                .expect_err("injected failure should abort");
            assert!(
                error.to_string().contains("injected patch commit failure"),
                "{error}"
            );
            for name in ["first.txt", "move.txt", "last.txt"] {
                assert_eq!(
                    std::fs::read_to_string(workspace.path().join(name))
                        .expect("source should be restored"),
                    "old\n"
                );
            }
            assert!(!workspace.path().join("new").exists());
            assert_eq!(
                std::fs::read_dir(workspace.path())
                    .expect("workspace should list")
                    .count(),
                3
            );
        }
    }

    #[tokio::test]
    async fn cancellation_after_a_committed_file_rolls_back_and_cleans_staging() {
        let workspace = batch_workspace();
        let prepared = prepare_patch(
            workspace.path(),
            parse_patch(NESTED_PATCH).expect("batch should parse"),
        )
        .await
        .expect("batch should prepare");
        let (sender, cancellation) = watch::channel(false);
        let error = super::commit_patch_internal(prepared, cancellation, move |index| {
            if index == 1 {
                sender.send(true).expect("cancellation should send");
            }
            Ok(())
        })
        .await
        .expect_err("batch should cancel");
        assert!(matches!(error, crate::error::AppError::Cancelled(_)));
        assert_eq!(
            std::fs::read_to_string(workspace.path().join("first.txt"))
                .expect("source should be restored"),
            "old\n"
        );
        assert!(!workspace.path().join("new").exists());
    }

    #[tokio::test]
    async fn rollback_preserves_concurrent_changes_to_untouched_files() {
        let workspace = batch_workspace();
        let parsed = parse_patch(NESTED_PATCH).expect("batch should parse");
        let prepared = prepare_patch(workspace.path(), parsed)
            .await
            .expect("batch should prepare");
        let concurrent_path = workspace.path().join("last.txt");
        let (_sender, cancellation) = watch::channel(false);
        let error = super::commit_patch_internal(prepared, cancellation, move |index| {
            if index == 1 {
                std::fs::write(&concurrent_path, "concurrent\n")
                    .expect("concurrent change should succeed");
                return Err(crate::error::AppError::Tool(
                    "injected failure after concurrent edit".into(),
                ));
            }
            Ok(())
        })
        .await
        .expect_err("batch should fail");
        assert!(error.to_string().contains("injected failure"));
        assert_eq!(
            std::fs::read_to_string(workspace.path().join("last.txt"))
                .expect("concurrent file should remain"),
            "concurrent\n"
        );
        assert_eq!(
            std::fs::read_to_string(workspace.path().join("first.txt"))
                .expect("changed file should be restored"),
            "old\n"
        );
        assert!(!workspace.path().join("new").exists());
    }

    #[tokio::test]
    async fn rollback_reports_integrity_conflicts_without_overwriting_newer_content() {
        let workspace = batch_workspace();
        let prepared = prepare_patch(
            workspace.path(),
            parse_patch(NESTED_PATCH).expect("batch should parse"),
        )
        .await
        .expect("batch should prepare");
        let concurrent_path = workspace.path().join("first.txt");
        let (_sender, cancellation) = watch::channel(false);
        let error = super::commit_patch_internal(prepared, cancellation, move |index| {
            if index == 1 {
                std::fs::write(&concurrent_path, "newer user edit\n")
                    .expect("concurrent change should succeed");
                return Err(crate::error::AppError::Tool(
                    "injected failure after concurrent edit".into(),
                ));
            }
            Ok(())
        })
        .await
        .expect_err("rollback conflict should fail visibly");
        assert!(matches!(error, crate::error::AppError::State(_)));
        assert!(
            error
                .to_string()
                .contains("concurrent content was preserved")
        );
        assert_eq!(
            std::fs::read_to_string(workspace.path().join("first.txt"))
                .expect("newer edit should remain"),
            "newer user edit\n"
        );
        assert!(!workspace.path().join("new").exists());
    }

    #[test]
    fn content_revalidation_detects_same_length_edits_truncation_growth_and_deletion() {
        let workspace = TempDir::new().expect("workspace should exist");
        let path = workspace.path().join("content.txt");
        let expected = vec![b'x'; 20_000];
        std::fs::write(&path, &expected).expect("source should exist");
        assert!(
            super::content_matches(&path, super::ExpectedContent::Present(&expected))
                .expect("comparison should succeed")
        );
        for content in [
            vec![b'y'; expected.len()],
            vec![b'x'; expected.len() - 1],
            vec![b'x'; expected.len() + 1],
        ] {
            std::fs::write(&path, content).expect("content should change");
            assert!(
                !super::content_matches(&path, super::ExpectedContent::Present(&expected))
                    .expect("comparison should succeed")
            );
        }
        std::fs::remove_file(&path).expect("test file should be removed");
        assert!(
            !super::content_matches(&path, super::ExpectedContent::Present(&expected))
                .expect("comparison should succeed")
        );
        assert!(
            super::content_matches(&path, super::ExpectedContent::Missing)
                .expect("missing comparison should succeed")
        );
    }

    #[tokio::test]
    async fn competing_prepared_patches_cannot_overwrite_a_completed_patch() {
        let workspace = batch_workspace();
        let patch = "*** Begin Patch\n*** Update File: first.txt\n@@\n-old\n+new\n*** End Patch";
        let first = prepare_patch(
            workspace.path(),
            parse_patch(patch).expect("patch should parse"),
        );
        let second = prepare_patch(
            workspace.path(),
            parse_patch(patch).expect("patch should parse"),
        );
        let (first, second) = tokio::join!(first, second);
        let (_sender, mut cancellation) = watch::channel(false);
        commit_patch(first.expect("first should prepare"), &mut cancellation)
            .await
            .expect("first should commit");
        assert!(
            commit_patch(second.expect("second should prepare"), &mut cancellation)
                .await
                .is_err()
        );
        assert_eq!(
            std::fs::read_to_string(workspace.path().join("first.txt"))
                .expect("completed change should remain"),
            "new\n"
        );
    }

    #[tokio::test]
    async fn a_new_destination_is_never_overwritten_or_removed_on_a_create_conflict() {
        let workspace = TempDir::new().expect("workspace should exist");
        let prepared = prepare_patch(
            workspace.path(),
            parse_patch("*** Begin Patch\n*** Add File: added.txt\n+patch\n*** End Patch")
                .expect("patch should parse"),
        )
        .await
        .expect("patch should prepare");
        let super::PreparedChange::Write { original, .. } = &prepared.changes[0] else {
            panic!("expected write");
        };
        let temporary =
            tempfile::NamedTempFile::new_in(workspace.path()).expect("staging should exist");
        std::fs::write(&original.path, "concurrent\n").expect("concurrent file should exist");
        let mut touched = Vec::new();
        let staged = super::StagedFile {
            temporary,
            permissions: None,
        };
        assert!(super::persist_change(staged, original, b"patch\n", &mut touched).is_err());
        assert!(touched.is_empty());
        assert_eq!(
            std::fs::read_to_string(&original.path).expect("concurrent content should remain"),
            "concurrent\n"
        );
    }

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
