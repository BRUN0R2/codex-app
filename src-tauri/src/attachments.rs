use std::path::Path;

use base64::Engine as _;
use base64::prelude::BASE64_STANDARD;
use serde::Deserialize;
use serde::Serialize;
use tauri::AppHandle;
use tauri::Manager;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use uuid::Uuid;

use crate::error::AppError;
use crate::error::CommandError;
use crate::error::CommandResult;

const MAX_ATTACHMENT_COUNT: usize = 12;
const MAX_ATTACHMENT_BYTES: u64 = 25 * 1024 * 1024;
const MAX_PASTED_IMAGE_BYTES: usize = 12 * 1024 * 1024;
const MAX_PASTED_IMAGE_BASE64_BYTES: usize = MAX_PASTED_IMAGE_BYTES.div_ceil(3) * 4;

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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PastedImageRequest {
    pub data_base64: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadImageRequest {
    pub path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadImageResponse {
    pub data_url: String,
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
    if request.data_base64.len() > MAX_PASTED_IMAGE_BASE64_BYTES {
        return Err(AppError::InvalidAttachment(format!(
            "encoded pasted images are limited to {MAX_PASTED_IMAGE_BASE64_BYTES} bytes"
        ))
        .into());
    }
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
    write_new_file_atomically(&path, &bytes)
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
pub async fn attachment_read_image(request: ReadImageRequest) -> CommandResult<ReadImageResponse> {
    let attachment = inspect_path(&request.path)
        .await
        .map_err(CommandError::from)?;
    if attachment.kind != AttachmentKind::Image {
        return Err(
            AppError::InvalidAttachment("attachment is not a supported image".into()).into(),
        );
    }

    let bytes = tokio::fs::read(&attachment.path)
        .await
        .map_err(|error| AppError::InvalidAttachment(error.to_string()))?;
    if bytes.len() as u64 != attachment.size || bytes.len() as u64 > MAX_ATTACHMENT_BYTES {
        return Err(
            AppError::InvalidAttachment("image changed while it was being read".into()).into(),
        );
    }
    let media_type = detect_image_media_type(&bytes)
        .ok_or_else(|| AppError::InvalidAttachment("image signature is not supported".into()))?;
    if attachment.media_type.as_deref() != Some(media_type) {
        return Err(
            AppError::InvalidAttachment("image changed while it was being read".into()).into(),
        );
    }

    Ok(ReadImageResponse {
        data_url: image_data_url(media_type, &bytes),
    })
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
    if let Some(expected_media_type) = media_type {
        let mut file = tokio::fs::File::open(path)
            .await
            .map_err(|error| AppError::InvalidAttachment(error.to_string()))?;
        let mut signature = [0_u8; 12];
        let bytes_read = file
            .read(&mut signature)
            .await
            .map_err(|error| AppError::InvalidAttachment(error.to_string()))?;
        if detect_image_media_type(&signature[..bytes_read]) != Some(expected_media_type) {
            return Err(AppError::InvalidAttachment(format!(
                "image signature does not match its extension: {}",
                path.display()
            )));
        }
    }
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

pub(crate) fn detect_image_media_type(bytes: &[u8]) -> Option<&'static str> {
    detect_image_format(bytes).map(|format| format.media_type)
}

fn image_data_url(media_type: &str, bytes: &[u8]) -> String {
    format!("data:{media_type};base64,{}", BASE64_STANDARD.encode(bytes))
}

async fn write_new_file_atomically(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| std::io::Error::other("generated attachment path is not valid UTF-8"))?;
    let temporary_path = path.with_file_name(format!(".{file_name}.part"));
    let result = async {
        let mut file = tokio::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary_path)
            .await?;
        file.write_all(bytes).await?;
        file.sync_all().await?;
        drop(file);
        tokio::fs::rename(&temporary_path, path).await
    }
    .await;
    match result {
        Ok(()) => Ok(()),
        Err(operation_error) => match tokio::fs::remove_file(&temporary_path).await {
            Ok(()) => Err(operation_error),
            Err(cleanup_error) if cleanup_error.kind() == std::io::ErrorKind::NotFound => {
                Err(operation_error)
            }
            Err(cleanup_error) => Err(std::io::Error::new(
                operation_error.kind(),
                format!(
                    "{operation_error}; temporary attachment cleanup also failed: {cleanup_error}"
                ),
            )),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::{detect_image_format, image_data_url};

    #[test]
    fn detects_supported_image_signatures() {
        let png = detect_image_format(b"\x89PNG\r\n\x1a\nrest");
        let jpeg = detect_image_format(&[0xff, 0xd8, 0xff, 0xdb]);
        let webp = detect_image_format(b"RIFF0000WEBPrest");

        assert_eq!(png.map(|format| format.media_type), Some("image/png"));
        assert_eq!(jpeg.map(|format| format.media_type), Some("image/jpeg"));
        assert_eq!(webp.map(|format| format.media_type), Some("image/webp"));
    }

    #[test]
    fn encodes_an_image_as_a_browser_safe_data_url() {
        assert_eq!(
            image_data_url("image/png", b"hello"),
            "data:image/png;base64,aGVsbG8="
        );
    }
}
