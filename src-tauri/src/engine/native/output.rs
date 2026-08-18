use std::fs::File;
use std::io::{self, Cursor, Read, Seek as _, SeekFrom, Write as _};

use uuid::Uuid;

use crate::engine::ThreadOutput;

pub(super) const OUTPUT_CHUNK_BYTES: usize = 64 * 1_024;

#[derive(Debug)]
enum OutputContent {
    File(File),
    Text(String),
}

#[derive(Debug)]
pub(super) struct OutputSource {
    reference: ThreadOutput,
    content: OutputContent,
}

impl OutputSource {
    pub fn text(content: String) -> Self {
        let byte_length = content.len() as u64;
        let preview = utf8_prefix(&content, OUTPUT_CHUNK_BYTES).to_string();
        Self {
            reference: ThreadOutput {
                id: Uuid::now_v7().to_string(),
                preview,
                byte_length,
                next_cursor: (byte_length > OUTPUT_CHUNK_BYTES as u64).then(|| "1".into()),
            },
            content: OutputContent::Text(content),
        }
    }

    pub fn file(mut content: File) -> io::Result<Self> {
        content.seek(SeekFrom::Start(0))?;
        let byte_length = content.metadata()?.len();
        let preview = read_utf8_prefix(&mut content, OUTPUT_CHUNK_BYTES)?;
        let preview_bytes = preview.len() as u64;
        content.seek(SeekFrom::Start(0))?;
        Ok(Self {
            reference: ThreadOutput {
                id: Uuid::now_v7().to_string(),
                preview,
                byte_length,
                next_cursor: (byte_length > preview_bytes).then(|| "1".into()),
            },
            content: OutputContent::File(content),
        })
    }

    pub fn command(exit_code: i32, mut stdout: File, mut stderr: File) -> io::Result<Self> {
        stdout.seek(SeekFrom::Start(0))?;
        stderr.seek(SeekFrom::Start(0))?;
        let mut combined = tempfile::tempfile()?;
        write!(combined, "exit_code: {exit_code}\nstdout:\n")?;
        io::copy(&mut stdout, &mut combined)?;
        combined.write_all(b"\nstderr:\n")?;
        io::copy(&mut stderr, &mut combined)?;
        combined.flush()?;
        combined.seek(SeekFrom::Start(0))?;
        Self::file(combined)
    }

    pub fn reference(&self) -> ThreadOutput {
        self.reference.clone()
    }

    pub fn provider_output(&self) -> String {
        if self.reference.next_cursor.is_none() {
            return self.reference.preview.clone();
        }
        let separator = if self.reference.preview.is_empty() {
            ""
        } else {
            "\n\n"
        };
        format!(
            "{}{separator}[Full output stored as `{}` ({} UTF-8 bytes). Continue with the `read_output` tool using this output_id and cursor `{}`; follow each next_cursor until it is null.]",
            self.reference.preview,
            self.reference.id,
            self.reference.byte_length,
            self.reference.next_cursor.as_deref().unwrap_or("null")
        )
    }

    pub fn provider_output_with_preview(&self, preview: &str, complete: bool) -> String {
        if complete {
            return preview.to_string();
        }
        let separator = if preview.is_empty() { "" } else { "\n\n" };
        format!(
            "{preview}{separator}[Full output stored as `{}` ({} UTF-8 bytes). Use the `read_output` tool with this output_id and cursor `null`; follow each next_cursor until it is null.]",
            self.reference.id, self.reference.byte_length
        )
    }

    pub fn into_reader(mut self) -> io::Result<Box<dyn Read + Send>> {
        match &mut self.content {
            OutputContent::File(file) => {
                file.seek(SeekFrom::Start(0))?;
            }
            OutputContent::Text(_) => {}
        }
        Ok(match self.content {
            OutputContent::File(file) => Box::new(file),
            OutputContent::Text(text) => Box::new(Cursor::new(text.into_bytes())),
        })
    }
}

fn read_utf8_prefix(file: &mut File, maximum_bytes: usize) -> io::Result<String> {
    let capacity = maximum_bytes.saturating_add(4);
    let mut bytes = Vec::with_capacity(capacity);
    file.take(capacity as u64).read_to_end(&mut bytes)?;
    let text = match std::str::from_utf8(&bytes) {
        Ok(text) => text,
        Err(error) if error.error_len().is_none() => {
            std::str::from_utf8(&bytes[..error.valid_up_to()]).map_err(|error| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("captured output is not valid UTF-8: {error}"),
                )
            })?
        }
        Err(error) => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("captured output is not valid UTF-8: {error}"),
            ));
        }
    };
    Ok(utf8_prefix(text, maximum_bytes).to_string())
}

fn utf8_prefix(value: &str, maximum_bytes: usize) -> &str {
    if value.len() <= maximum_bytes {
        return value;
    }
    let mut end = maximum_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}

#[cfg(test)]
mod tests {
    use std::io::{Seek as _, SeekFrom, Write as _};

    use super::{OUTPUT_CHUNK_BYTES, OutputSource};

    #[test]
    fn exposes_a_utf8_preview_and_preserves_the_complete_resource() {
        let content = "😀".repeat(OUTPUT_CHUNK_BYTES / 4 + 1);
        let source = OutputSource::text(content.clone());
        let reference = source.reference();

        assert!(reference.preview.len() <= OUTPUT_CHUNK_BYTES);
        assert!(!reference.preview.contains('\u{fffd}'));
        assert_eq!(reference.byte_length, content.len() as u64);
        assert!(source.provider_output().contains(&reference.id));
    }

    #[test]
    fn combines_command_streams_without_loading_them_into_the_contract() {
        let mut stdout = tempfile::tempfile().expect("stdout spool should open");
        let mut stderr = tempfile::tempfile().expect("stderr spool should open");
        stdout.write_all(b"ok").expect("stdout should write");
        stderr.write_all(b"warning").expect("stderr should write");
        stdout
            .seek(SeekFrom::Start(0))
            .expect("stdout should rewind");
        stderr
            .seek(SeekFrom::Start(0))
            .expect("stderr should rewind");

        let source = OutputSource::command(0, stdout, stderr).expect("output should combine");
        assert_eq!(
            source.reference().preview,
            "exit_code: 0\nstdout:\nok\nstderr:\nwarning"
        );
    }
}
