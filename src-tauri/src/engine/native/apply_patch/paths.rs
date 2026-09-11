use std::fs::Metadata;
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};

use crate::error::AppError;

pub(super) fn canonical_workspace(workspace: &Path) -> Result<PathBuf, AppError> {
    let workspace = std::fs::canonicalize(workspace)
        .map_err(|error| AppError::FileSystem(error.to_string()))?;
    if !std::fs::metadata(&workspace)
        .map_err(|error| AppError::FileSystem(error.to_string()))?
        .is_dir()
    {
        return Err(AppError::FileSystem("workspace is not a directory".into()));
    }
    Ok(workspace)
}

pub(super) fn resolve_patch_path(workspace: &Path, relative: &Path) -> Result<PathBuf, AppError> {
    validate_relative_path(relative)?;
    let path = workspace.join(relative.components().collect::<PathBuf>());
    validate_target(workspace, &path)?;
    Ok(path)
}

pub(super) fn validate_relative_path(path: &Path) -> Result<(), AppError> {
    const MAX_PATCH_PATH_BYTES: usize = 4_096;
    if path.as_os_str().len() > MAX_PATCH_PATH_BYTES {
        return Err(AppError::Permission(format!(
            "patch path exceeds {MAX_PATCH_PATH_BYTES} bytes"
        )));
    }
    if path.as_os_str().is_empty() || path.is_absolute() {
        return Err(AppError::Permission(
            "patch paths must be non-empty and relative".into(),
        ));
    }
    for component in path.components() {
        let Component::Normal(name) = component else {
            return Err(AppError::Permission(
                "patch paths may contain only normal relative components".into(),
            ));
        };
        let name = name
            .to_str()
            .ok_or_else(|| AppError::Permission("patch path must be valid UTF-8".into()))?;
        if name.contains('\0') {
            return Err(AppError::Permission(
                "patch path contains a null byte".into(),
            ));
        }
        #[cfg(windows)]
        validate_windows_component(name)?;
    }
    Ok(())
}

#[cfg(windows)]
fn validate_windows_component(name: &str) -> Result<(), AppError> {
    let stem = name.split('.').next().unwrap_or_default().to_uppercase();
    let device = matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || ["COM", "LPT"].iter().any(|prefix| {
        stem.strip_prefix(prefix).is_some_and(|suffix| {
            matches!(
                suffix,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
    });
    if device
        || name.ends_with([' ', '.'])
        || name.chars().any(|character| {
            character.is_control() || matches!(character, ':' | '<' | '>' | '"' | '|' | '?' | '*')
        })
    {
        return Err(AppError::Permission(
            "patch path contains a reserved or ambiguous Windows component".into(),
        ));
    }
    Ok(())
}

pub(super) fn validate_target(workspace: &Path, path: &Path) -> Result<(), AppError> {
    let relative = path
        .strip_prefix(workspace)
        .map_err(|_| AppError::Permission("patch path escapes the workspace".into()))?;
    validate_relative_path(relative)?;
    let mut current = workspace.to_path_buf();
    let root = std::fs::symlink_metadata(&current)
        .map_err(|error| AppError::FileSystem(error.to_string()))?;
    require_directory(&current, &root)?;
    for component in relative.components() {
        current.push(component);
        let metadata = match std::fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(AppError::FileSystem(error.to_string())),
        };
        if is_link(&metadata) {
            return Err(AppError::Permission(format!(
                "patch path contains a symbolic link or reparse point: {}",
                current.display()
            )));
        }
        if current != path {
            require_directory(&current, &metadata)?;
        } else if !metadata.is_file() {
            return Err(AppError::Tool(format!(
                "patch path is not a regular file: {}",
                current.display()
            )));
        }
    }
    Ok(())
}

pub(super) fn create_parents(
    workspace: &Path,
    target: &Path,
    created: &mut Vec<PathBuf>,
) -> Result<(), AppError> {
    validate_target(workspace, target)?;
    let parent = target
        .parent()
        .ok_or_else(|| AppError::FileSystem("patch target has no parent".into()))?;
    let relative = parent
        .strip_prefix(workspace)
        .map_err(|_| AppError::Permission("patch parent escapes the workspace".into()))?;
    let mut current = workspace.to_path_buf();
    for component in relative.components() {
        current.push(component);
        match std::fs::create_dir(&current) {
            Ok(()) => created.push(current.clone()),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
            Err(error) => return Err(AppError::FileSystem(error.to_string())),
        }
        let metadata = std::fs::symlink_metadata(&current)
            .map_err(|error| AppError::FileSystem(error.to_string()))?;
        require_directory(&current, &metadata)?;
    }
    Ok(())
}

fn require_directory(path: &Path, metadata: &Metadata) -> Result<(), AppError> {
    if is_link(metadata) || !metadata.is_dir() {
        return Err(AppError::Permission(format!(
            "patch parent must be a directory without symbolic links or reparse points: {}",
            path.display()
        )));
    }
    Ok(())
}

pub(super) fn is_link(metadata: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt as _;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}
