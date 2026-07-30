use std::path::Path;

use base64::Engine as _;
use base64::prelude::BASE64_STANDARD;
use serde::Deserialize;
use serde::Serialize;
use tauri::AppHandle;
use tauri::Manager;
use tauri::ipc::Response;
use uuid::Uuid;

use crate::error::AppError;
use crate::error::CommandError;
use crate::error::CommandResult;

const MAX_ATTACHMENT_COUNT: usize = 12;
const MAX_ATTACHMENT_BYTES: u64 = 25 * 1024 * 1024;
const MAX_PASTED_IMAGE_BYTES: usize = 12 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AttachmentKind {
    File,
    Image,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: String,
    pub name: String,
    pub path: String,
    pub kind: AttachmentKind,
    pub size: u64,
    pub media_type: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PastedImageRequest {
    pub data_base64: String,
}

#[derive(Debug, Clone, Copy)]
struct ImageFormat {
    extension: &'static str,
    media_type: &'static str,
}

#[tauri::command]
pub async fn attachment_inspect(paths: Vec<String>) -> CommandResult<Vec<Attachment>> {
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    if paths.len() > MAX_ATTACHMENT_COUNT {
        return Err(AppError::InvalidAttachment(format!(
            "at most {MAX_ATTACHMENT_COUNT} files can be attached at once"
        ))
        .into());
    }

    let mut attachments = Vec::with_capacity(paths.len());
    for path in paths {
        attachments.push(inspect_path(&path).await.map_err(CommandError::from)?);
    }
    Ok(attachments)
}

#[tauri::command]
pub async fn attachment_save_pasted_image(
    app: AppHandle,
    request: PastedImageRequest,
) -> CommandResult<Attachment> {
    let estimated_size = request.data_base64.len().saturating_mul(3) / 4;
    if estimated_size > MAX_PASTED_IMAGE_BYTES {
        return Err(AppError::InvalidAttachment(format!(
            "pasted images are limited to {} MiB",
            MAX_PASTED_IMAGE_BYTES / 1024 / 1024
        ))
        .into());
    }

    let bytes = BASE64_STANDARD
        .decode(request.data_base64)
        .map_err(|_| AppError::InvalidAttachment("clipboard image is not valid base64".into()))?;
    if bytes.len() > MAX_PASTED_IMAGE_BYTES {
        return Err(AppError::InvalidAttachment(format!(
            "pasted images are limited to {} MiB",
            MAX_PASTED_IMAGE_BYTES / 1024 / 1024
        ))
        .into());
    }

    let format = detect_image_format(&bytes).ok_or_else(|| {
        AppError::InvalidAttachment("clipboard image must be PNG, JPEG, GIF, or WebP".into())
    })?;
    let cache_directory = app
        .path()
        .app_cache_dir()
        .map_err(|error| AppError::FileSystem(error.to_string()))?
        .join("attachments");
    tokio::fs::create_dir_all(&cache_directory)
        .await
        .map_err(|error| AppError::FileSystem(error.to_string()))?;

    let name = format!("pasted-{}.{}", Uuid::now_v7(), format.extension);
    let path = cache_directory.join(&name);
    tokio::fs::write(&path, &bytes)
        .await
        .map_err(|error| AppError::FileSystem(error.to_string()))?;

    Ok(Attachment {
        id: Uuid::now_v7().to_string(),
        name,
        path: path.to_string_lossy().into_owned(),
        kind: AttachmentKind::Image,
        size: bytes.len() as u64,
        media_type: Some(format.media_type.into()),
    })
}

#[tauri::command]
pub async fn attachment_read_image(path: String) -> CommandResult<Response> {
    let attachment = inspect_path(&path).await.map_err(CommandError::from)?;
    if attachment.kind != AttachmentKind::Image {
        return Err(AppError::InvalidAttachment("preview target is not an image".into()).into());
    }

    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|error| AppError::FileSystem(error.to_string()))?;
    if bytes.len() as u64 > MAX_ATTACHMENT_BYTES {
        return Err(AppError::InvalidAttachment(format!(
            "image preview exceeds the {} MiB attachment limit",
            MAX_ATTACHMENT_BYTES / 1024 / 1024
        ))
        .into());
    }
    if detect_image_format(&bytes).is_none() {
        return Err(AppError::InvalidAttachment(
            "image preview has an unsupported file signature".into(),
        )
        .into());
    }

    Ok(Response::new(bytes))
}

pub async fn inspect_path(path: &str) -> Result<Attachment, AppError> {
    let path = Path::new(path);
    if !path.is_absolute() {
        return Err(AppError::InvalidAttachment(
            "attachment paths must be absolute".into(),
        ));
    }

    let metadata = tokio::fs::metadata(path)
        .await
        .map_err(|error| AppError::InvalidAttachment(error.to_string()))?;
    if !metadata.is_file() {
        return Err(AppError::InvalidAttachment(format!(
            "not a regular file: {}",
            path.display()
        )));
    }
    if metadata.len() > MAX_ATTACHMENT_BYTES {
        return Err(AppError::InvalidAttachment(format!(
            "{} exceeds the {} MiB attachment limit",
            path.display(),
            MAX_ATTACHMENT_BYTES / 1024 / 1024
        )));
    }

    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| AppError::InvalidAttachment("file name is not valid UTF-8".into()))?
        .to_owned();
    let media_type = media_type_from_extension(path);
    let kind = if media_type.is_some() {
        AttachmentKind::Image
    } else {
        AttachmentKind::File
    };

    Ok(Attachment {
        id: Uuid::now_v7().to_string(),
        name,
        path: path.to_string_lossy().into_owned(),
        kind,
        size: metadata.len(),
        media_type: media_type.map(str::to_owned),
    })
}

fn media_type_from_extension(path: &Path) -> Option<&'static str> {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("png") => Some("image/png"),
        Some("jpg" | "jpeg") => Some("image/jpeg"),
        Some("gif") => Some("image/gif"),
        Some("webp") => Some("image/webp"),
        _ => None,
    }
}

fn detect_image_format(bytes: &[u8]) -> Option<ImageFormat> {
    const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";
    const GIF_87_SIGNATURE: &[u8] = b"GIF87a";
    const GIF_89_SIGNATURE: &[u8] = b"GIF89a";

    if bytes.starts_with(PNG_SIGNATURE) {
        return Some(ImageFormat {
            extension: "png",
            media_type: "image/png",
        });
    }
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some(ImageFormat {
            extension: "jpg",
            media_type: "image/jpeg",
        });
    }
    if bytes.starts_with(GIF_87_SIGNATURE) || bytes.starts_with(GIF_89_SIGNATURE) {
        return Some(ImageFormat {
            extension: "gif",
            media_type: "image/gif",
        });
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some(ImageFormat {
            extension: "webp",
            media_type: "image/webp",
        });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::detect_image_format;

    #[test]
    fn detects_supported_image_signatures() {
        let png = detect_image_format(b"\x89PNG\r\n\x1a\nrest");
        let jpeg = detect_image_format(&[0xff, 0xd8, 0xff, 0xdb]);
        let webp = detect_image_format(b"RIFF0000WEBPrest");

        assert_eq!(png.map(|format| format.media_type), Some("image/png"));
        assert_eq!(jpeg.map(|format| format.media_type), Some("image/jpeg"));
        assert_eq!(webp.map(|format| format.media_type), Some("image/webp"));
    }
}
