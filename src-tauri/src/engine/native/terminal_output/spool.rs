use std::fs::File;
use std::io;
use std::io::SeekFrom;

use tokio::io::{AsyncReadExt as _, AsyncSeekExt as _, AsyncWriteExt as _};

use super::TerminalOperation;

pub(in crate::engine::native) struct TerminalSpoolWriter {
    output: tokio::fs::File,
    position: u64,
    line_start: u64,
}

impl TerminalSpoolWriter {
    pub(in crate::engine::native) fn new(output: tokio::fs::File) -> Self {
        Self {
            output,
            position: 0,
            line_start: 0,
        }
    }

    pub(in crate::engine::native) async fn apply(
        &mut self,
        operations: &[TerminalOperation],
    ) -> io::Result<()> {
        for operation in operations {
            match operation {
                TerminalOperation::Append(value) => self.write_visible(value).await?,
                TerminalOperation::Backspace => self.remove_previous_character().await?,
                TerminalOperation::ClearCurrentLine => self.clear_current_line().await?,
            }
        }
        Ok(())
    }

    async fn write_visible(&mut self, value: &str) -> io::Result<()> {
        self.output.write_all(value.as_bytes()).await?;
        self.position = self
            .position
            .checked_add(value.len() as u64)
            .ok_or_else(|| io::Error::other("terminal output position overflow"))?;
        if value.ends_with('\n') {
            self.line_start = self.position;
        } else if let Some(index) = value.rfind('\n') {
            self.line_start = self.position - (value.len() - index - 1) as u64;
        }
        Ok(())
    }

    async fn clear_current_line(&mut self) -> io::Result<()> {
        self.output.set_len(self.line_start).await?;
        self.output.seek(SeekFrom::Start(self.line_start)).await?;
        self.position = self.line_start;
        Ok(())
    }

    async fn remove_previous_character(&mut self) -> io::Result<()> {
        if self.position <= self.line_start {
            return Ok(());
        }
        let available =
            usize::try_from((self.position - self.line_start).min(4)).map_err(io::Error::other)?;
        let start = self.position - available as u64;
        self.output.seek(SeekFrom::Start(start)).await?;
        let mut suffix = [0u8; 4];
        self.output.read_exact(&mut suffix[..available]).await?;
        let character_start = suffix[..available]
            .iter()
            .rposition(|byte| !matches!(byte, 0x80..=0xbf))
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid UTF-8 spool"))?;
        let removed = available - character_start;
        let next_position = self.position - removed as u64;
        self.output.set_len(next_position).await?;
        self.output.seek(SeekFrom::Start(next_position)).await?;
        self.position = next_position;
        Ok(())
    }

    pub(in crate::engine::native) async fn finish(mut self) -> io::Result<File> {
        self.output.flush().await?;
        self.output.seek(SeekFrom::Start(0)).await?;
        Ok(self.output.into_std().await)
    }
}

#[cfg(test)]
#[path = "spool_tests.rs"]
mod tests;
