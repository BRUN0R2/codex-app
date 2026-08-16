use std::path::{Component, Path, PathBuf};

use super::MAX_TOOL_PATH_BYTES;
use crate::error::AppError;

pub(super) async fn canonical_workspace(workspace: &Path) -> Result<PathBuf, AppError> {
    let canonical = tokio::fs::canonicalize(workspace)
        .await
        .map_err(|error| AppError::FileSystem(error.to_string()))?;
    let metadata = tokio::fs::metadata(&canonical)
        .await
        .map_err(|error| AppError::FileSystem(error.to_string()))?;
    if !metadata.is_dir() {
        return Err(AppError::FileSystem("workspace is not a directory".into()));
    }
    Ok(canonical)
}

pub(super) async fn resolve_existing_path(
    workspace: &Path,
    relative: &str,
) -> Result<PathBuf, AppError> {
    let relative = validate_relative_path(relative)?;
    let path = tokio::fs::canonicalize(workspace.join(relative))
        .await
        .map_err(|error| AppError::FileSystem(error.to_string()))?;
    ensure_inside_workspace(workspace, &path)?;
    Ok(path)
}

pub(super) async fn resolve_existing_file(
    workspace: &Path,
    relative: &str,
) -> Result<PathBuf, AppError> {
    let path = resolve_existing_path(workspace, relative).await?;
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|error| AppError::FileSystem(error.to_string()))?;
    if !metadata.is_file() {
        return Err(AppError::FileSystem("path is not a regular file".into()));
    }
    Ok(path)
}

pub(super) async fn resolve_existing_directory(
    workspace: &Path,
    relative: &str,
) -> Result<PathBuf, AppError> {
    let path = resolve_existing_path(workspace, relative).await?;
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|error| AppError::FileSystem(error.to_string()))?;
    if !metadata.is_dir() {
        return Err(AppError::FileSystem("path is not a directory".into()));
    }
    Ok(path)
}

pub(super) async fn resolve_write_target(
    workspace: &Path,
    relative: &str,
) -> Result<PathBuf, AppError> {
    let relative = validate_relative_path(relative)?;
    let target = workspace.join(relative);
    let parent = target
        .parent()
        .ok_or_else(|| AppError::FileSystem("write target has no parent".into()))?;
    let canonical_parent = tokio::fs::canonicalize(parent).await.map_err(|error| {
        AppError::FileSystem(format!("write target parent is invalid: {error}"))
    })?;
    ensure_inside_workspace(workspace, &canonical_parent)?;
    let file_name = target
        .file_name()
        .ok_or_else(|| AppError::FileSystem("write target has no file name".into()))?;
    let target = canonical_parent.join(file_name);
    if tokio::fs::try_exists(&target)
        .await
        .map_err(|error| AppError::FileSystem(error.to_string()))?
    {
        let canonical = tokio::fs::canonicalize(&target)
            .await
            .map_err(|error| AppError::FileSystem(error.to_string()))?;
        ensure_inside_workspace(workspace, &canonical)?;
        return Ok(canonical);
    }
    Ok(target)
}

pub(super) fn validate_relative_path(value: &str) -> Result<&Path, AppError> {
    if value.is_empty() || value.len() > MAX_TOOL_PATH_BYTES {
        return Err(AppError::Protocol(
            "workspace path is empty or too long".into(),
        ));
    }
    let path = Path::new(value);
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(AppError::Permission(
            "tool paths must be workspace-relative and cannot contain parent traversal".into(),
        ));
    }
    Ok(path)
}

pub(super) fn ensure_inside_workspace(workspace: &Path, path: &Path) -> Result<(), AppError> {
    if path.starts_with(workspace) {
        Ok(())
    } else {
        Err(AppError::Permission(
            "resolved path escapes the workspace".into(),
        ))
    }
}
pub(super) fn relative_display(workspace: &Path, path: &Path) -> Result<String, AppError> {
    path.strip_prefix(workspace)
        .map(|relative| relative.to_string_lossy().replace('\\', "/"))
        .map_err(|_| AppError::Permission("path is outside the workspace".into()))
}

pub(super) fn display_workspace_path(workspace: &Path, relative: &str) -> String {
    workspace.join(relative).display().to_string()
}
