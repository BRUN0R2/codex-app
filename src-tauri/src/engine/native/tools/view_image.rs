use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::watch;

use super::workspace::{ensure_inside_workspace, relative_display, resolve_existing_file};
use crate::attachments::{ImageContentError, ValidatedImageContent};
use crate::engine::{ImageDetail, PermissionProfile, SandboxMode};
use crate::error::AppError;

const MAX_VIEW_IMAGE_BYTES: u64 = 10 * 1_048_576;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ViewImageArgs {
    pub path: String,
    #[serde(default)]
    detail: Option<ViewImageDetail>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum ViewImageDetail {
    High,
    Original,
}

#[derive(Debug)]
pub(super) struct ViewedImage {
    pub image: ValidatedImageContent,
    pub detail: ImageDetail,
    pub display_path: String,
}

pub(super) fn definition(supports_original_detail: bool) -> Value {
    let mut properties = serde_json::Map::from_iter([(
        "path".into(),
        json!({
            "type": "string",
            "description": "Local filesystem path to an image file. Relative paths resolve from the workspace root."
        }),
    )]);
    if supports_original_detail {
        properties.insert(
            "detail".into(),
            json!({
                "type": "string",
                "enum": ["high", "original"],
                "description": "Image detail level. Defaults to high; use original to preserve exact resolution."
            }),
        );
    }
    json!({
        "type": "function",
        "name": "view_image",
        "description": "View a local image file from the filesystem when visual inspection is needed. Use this for images already available on disk.",
        "strict": false,
        "parameters": {
            "type": "object",
            "properties": properties,
            "required": ["path"],
            "additionalProperties": false
        }
    })
}

pub(super) async fn execute(
    workspace: &Path,
    permissions: PermissionProfile,
    supports_image_input: bool,
    supports_original_detail: bool,
    args: &ViewImageArgs,
    cancellation: &watch::Receiver<bool>,
) -> Result<ViewedImage, AppError> {
    if !supports_image_input {
        return Err(AppError::Tool(
            "view_image is unavailable because the selected model does not accept image input"
                .into(),
        ));
    }
    if *cancellation.borrow() {
        return Err(AppError::Cancelled(
            "the image view was cancelled before the file was read".into(),
        ));
    }
    let detail = match args.detail.unwrap_or(ViewImageDetail::High) {
        ViewImageDetail::High => ImageDetail::High,
        ViewImageDetail::Original if supports_original_detail => ImageDetail::Original,
        ViewImageDetail::Original => {
            return Err(AppError::Tool(
                "the selected model does not support original image detail; omit detail to use high"
                    .into(),
            ));
        }
    };
    let path = resolve_image_path(workspace, permissions, &args.path).await?;
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|error| AppError::FileSystem(error.to_string()))?;
    if !metadata.is_file() {
        return Err(AppError::Tool(format!(
            "image path `{}` is not a regular file",
            path.display()
        )));
    }
    if metadata.len() > MAX_VIEW_IMAGE_BYTES {
        return Err(AppError::Tool(format!(
            "image `{}` exceeds the {} MiB view limit",
            path.display(),
            MAX_VIEW_IMAGE_BYTES / 1_048_576
        )));
    }
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|error| AppError::FileSystem(error.to_string()))?;
    if bytes.len() as u64 != metadata.len() {
        return Err(AppError::Tool(
            "image changed while it was being read; retry the tool call".into(),
        ));
    }
    if *cancellation.borrow() {
        return Err(AppError::Cancelled(
            "the image view was cancelled while the file was being read".into(),
        ));
    }

    let path_for_decode = path.clone();
    let image = tokio::task::spawn_blocking(move || validate_image_bytes(&path_for_decode, bytes))
        .await
        .map_err(|error| AppError::State(format!("image decoder task failed: {error}")))??;
    if *cancellation.borrow() {
        return Err(AppError::Cancelled(
            "the image view was cancelled while the image was being decoded".into(),
        ));
    }
    let display_path =
        relative_display(workspace, &path).unwrap_or_else(|_| path.to_string_lossy().into_owned());

    Ok(ViewedImage {
        image,
        detail,
        display_path,
    })
}

async fn resolve_image_path(
    workspace: &Path,
    permissions: PermissionProfile,
    value: &str,
) -> Result<PathBuf, AppError> {
    let requested = Path::new(value);
    if !requested.is_absolute() {
        return resolve_existing_file(workspace, value).await;
    }
    let canonical = tokio::fs::canonicalize(requested)
        .await
        .map_err(|error| AppError::FileSystem(error.to_string()))?;
    if permissions.sandbox != SandboxMode::DangerFullAccess {
        ensure_inside_workspace(workspace, &canonical)?;
    }
    Ok(canonical)
}

fn validate_image_bytes(path: &Path, bytes: Vec<u8>) -> Result<ValidatedImageContent, AppError> {
    ValidatedImageContent::decode(bytes).map_err(|error| match error {
        ImageContentError::UnsupportedFormat => AppError::Tool(format!(
            "file `{}` is not a supported PNG, JPEG, GIF, or WebP image",
            path.display()
        )),
        ImageContentError::InvalidOrUnsafeData => AppError::Tool(format!(
            "file `{}` could not be decoded safely as an image",
            path.display()
        )),
    })
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use image::{ImageBuffer, ImageFormat, Rgba};

    use super::*;

    fn tiny_png() -> Vec<u8> {
        let image = ImageBuffer::from_pixel(1, 1, Rgba([255_u8, 0, 0, 255]));
        let mut bytes = Vec::new();
        image
            .write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png)
            .expect("test image should encode");
        bytes
    }

    #[test]
    fn definition_exposes_original_detail_only_when_supported() {
        let high = definition(false);
        let original = definition(true);

        assert!(high["parameters"]["properties"].get("detail").is_none());
        assert_eq!(
            original["parameters"]["properties"]["detail"]["enum"],
            json!(["high", "original"])
        );
        assert_eq!(original["parameters"]["required"], json!(["path"]));
        assert_eq!(original["strict"], false);
    }

    #[test]
    fn validates_real_image_content_instead_of_only_a_signature() {
        assert!(
            validate_image_bytes(Path::new("image.png"), tiny_png())
                .expect("valid PNG should decode")
                .data_url()
                .starts_with("data:image/png;base64,")
        );
        assert!(
            validate_image_bytes(
                Path::new("fake.png"),
                b"\x89PNG\r\n\x1a\nnot-an-image".to_vec()
            )
            .is_err()
        );
    }

    #[test]
    fn rejects_images_with_dimensions_outside_the_decode_budget() {
        let image = ImageBuffer::from_pixel(16_385, 1, Rgba([255_u8, 0, 0, 255]));
        let mut bytes = Vec::new();
        image
            .write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png)
            .expect("oversized test image should encode");

        assert!(validate_image_bytes(Path::new("too-wide.png"), bytes).is_err());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn reads_a_workspace_image_into_a_multimodal_data_url() {
        let workspace = tempfile::tempdir().expect("temporary workspace should exist");
        tokio::fs::write(workspace.path().join("image.png"), tiny_png())
            .await
            .expect("test image should be written");
        let canonical_workspace = tokio::fs::canonicalize(workspace.path())
            .await
            .expect("temporary workspace should canonicalize");
        let (_, cancellation) = watch::channel(false);
        let viewed = execute(
            &canonical_workspace,
            PermissionProfile::read_only(),
            true,
            false,
            &ViewImageArgs {
                path: "image.png".into(),
                detail: None,
            },
            &cancellation,
        )
        .await
        .expect("workspace image should be viewable");

        assert_eq!(viewed.display_path, "image.png");
        assert!(
            viewed
                .image
                .data_url()
                .starts_with("data:image/png;base64,")
        );
        assert!(matches!(viewed.detail, ImageDetail::High));
    }

    #[tokio::test]
    async fn rejects_original_detail_when_the_model_does_not_support_it() {
        let workspace = tempfile::tempdir().expect("temporary workspace should exist");
        let (_, cancellation) = watch::channel(false);
        let error = execute(
            workspace.path(),
            PermissionProfile::read_only(),
            true,
            false,
            &ViewImageArgs {
                path: "image.png".into(),
                detail: Some(ViewImageDetail::Original),
            },
            &cancellation,
        )
        .await
        .expect_err("unsupported original detail should fail before reading the file");

        assert!(
            error
                .to_string()
                .contains("does not support original image detail")
        );
    }
}
