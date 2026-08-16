use std::fs::File;
use std::io::{self, Read as _, Seek as _, SeekFrom, Write as _};

use tokio::process::Command;

const ESCAPE: u8 = 0x1b;
const BELL: u8 = 0x07;

pub(super) fn configure_plain_terminal(command: &mut Command) {
    command
        .env("NO_COLOR", "1")
        .env("CLICOLOR", "0")
        .env("FORCE_COLOR", "0")
        .env("TERM", "dumb");
}

pub(super) fn normalize_terminal_file(mut input: File) -> io::Result<File> {
    input.seek(SeekFrom::Start(0))?;
    let output = tempfile::tempfile()?;
    let mut normalizer = TerminalFileNormalizer::new(output);
    let mut buffer = [0u8; 64 * 1_024];
    loop {
        let count = input.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        normalizer.push(&buffer[..count])?;
    }
    normalizer.finish()
}

#[derive(Clone, Copy)]
enum EscapeState {
    Text,
    Escape,
    ControlSequence,
    Intermediate,
    String {
        bell_terminated: bool,
        saw_escape: bool,
    },
}

struct TerminalFileNormalizer {
    output: File,
    position: u64,
    line_start: u64,
    pending_carriage_return: bool,
    escape_state: EscapeState,
    utf8: Vec<u8>,
    utf8_expected: usize,
}

impl TerminalFileNormalizer {
    fn new(output: File) -> Self {
        Self {
            output,
            position: 0,
            line_start: 0,
            pending_carriage_return: false,
            escape_state: EscapeState::Text,
            utf8: Vec::with_capacity(4),
            utf8_expected: 0,
        }
    }

    fn push(&mut self, bytes: &[u8]) -> io::Result<()> {
        for &byte in bytes {
            self.push_byte(byte)?;
        }
        Ok(())
    }

    fn push_byte(&mut self, byte: u8) -> io::Result<()> {
        match self.escape_state {
            EscapeState::Text if byte == ESCAPE => {
                if !self.utf8.is_empty() {
                    self.write_replacement()?;
                }
                self.escape_state = EscapeState::Escape;
            }
            EscapeState::Text => self.push_text_byte(byte)?,
            EscapeState::Escape => match byte {
                b'[' => self.escape_state = EscapeState::ControlSequence,
                b']' => {
                    self.escape_state = EscapeState::String {
                        bell_terminated: true,
                        saw_escape: false,
                    };
                }
                b'P' | b'X' | b'^' | b'_' => {
                    self.escape_state = EscapeState::String {
                        bell_terminated: false,
                        saw_escape: false,
                    };
                }
                0x20..=0x2f => self.escape_state = EscapeState::Intermediate,
                0x30..=0x7e => self.escape_state = EscapeState::Text,
                _ => {
                    self.escape_state = EscapeState::Text;
                    self.push_text_byte(byte)?;
                }
            },
            EscapeState::ControlSequence => {
                if matches!(byte, 0x40..=0x7e) {
                    self.escape_state = EscapeState::Text;
                }
            }
            EscapeState::Intermediate => match byte {
                0x20..=0x2f => {}
                0x30..=0x7e => self.escape_state = EscapeState::Text,
                _ => {
                    self.escape_state = EscapeState::Text;
                    self.push_text_byte(byte)?;
                }
            },
            EscapeState::String {
                bell_terminated,
                saw_escape,
            } => {
                if (bell_terminated && byte == BELL) || (saw_escape && byte == b'\\') {
                    self.escape_state = EscapeState::Text;
                } else {
                    self.escape_state = EscapeState::String {
                        bell_terminated,
                        saw_escape: byte == ESCAPE,
                    };
                }
            }
        }
        Ok(())
    }

    fn push_text_byte(&mut self, byte: u8) -> io::Result<()> {
        if self.utf8.is_empty() {
            if byte.is_ascii() {
                return self.process_character(char::from(byte));
            }
            let Some(expected) = utf8_sequence_length(byte) else {
                return self.write_replacement();
            };
            self.utf8.push(byte);
            self.utf8_expected = expected;
            return Ok(());
        }

        if !matches!(byte, 0x80..=0xbf) {
            self.write_replacement()?;
            return self.push_text_byte(byte);
        }
        self.utf8.push(byte);
        if self.utf8.len() < self.utf8_expected {
            return Ok(());
        }
        let character = std::str::from_utf8(&self.utf8)
            .ok()
            .and_then(|value| value.chars().next());
        self.utf8.clear();
        self.utf8_expected = 0;
        match character {
            Some(character) => self.process_character(character),
            None => self.process_character('\u{fffd}'),
        }
    }

    fn write_replacement(&mut self) -> io::Result<()> {
        self.utf8.clear();
        self.utf8_expected = 0;
        self.process_character('\u{fffd}')
    }

    fn process_character(&mut self, character: char) -> io::Result<()> {
        if self.pending_carriage_return {
            if character == '\n' {
                self.pending_carriage_return = false;
                return self.write_visible("\n");
            }
            self.clear_current_line()?;
            self.pending_carriage_return = false;
        }

        match character {
            '\r' => self.pending_carriage_return = true,
            '\n' => self.write_visible("\n")?,
            '\u{0008}' => self.remove_previous_character()?,
            '\t' => self.write_visible("\t")?,
            control if control.is_control() => {}
            visible => {
                let mut encoded = [0u8; 4];
                self.write_visible(visible.encode_utf8(&mut encoded))?;
            }
        }
        Ok(())
    }

    fn write_visible(&mut self, value: &str) -> io::Result<()> {
        self.output.write_all(value.as_bytes())?;
        self.position = self
            .position
            .checked_add(value.len() as u64)
            .ok_or_else(|| io::Error::other("terminal output position overflow"))?;
        if value == "\n" {
            self.line_start = self.position;
        }
        Ok(())
    }

    fn clear_current_line(&mut self) -> io::Result<()> {
        self.output.set_len(self.line_start)?;
        self.output.seek(SeekFrom::Start(self.line_start))?;
        self.position = self.line_start;
        Ok(())
    }

    fn remove_previous_character(&mut self) -> io::Result<()> {
        if self.position <= self.line_start {
            return Ok(());
        }
        let available =
            usize::try_from((self.position - self.line_start).min(4)).map_err(io::Error::other)?;
        let start = self.position - available as u64;
        let mut tail = [0u8; 4];
        self.output.seek(SeekFrom::Start(start))?;
        self.output.read_exact(&mut tail[..available])?;
        let mut character_start = available - 1;
        while character_start > 0 && matches!(tail[character_start], 0x80..=0xbf) {
            character_start -= 1;
        }
        let removed = available - character_start;
        let next_position = self.position - removed as u64;
        self.output.set_len(next_position)?;
        self.output.seek(SeekFrom::Start(next_position))?;
        self.position = next_position;
        Ok(())
    }

    fn finish(mut self) -> io::Result<File> {
        if !self.utf8.is_empty() {
            self.write_replacement()?;
        }
        if self.pending_carriage_return {
            self.clear_current_line()?;
        }
        self.output.flush()?;
        self.output.seek(SeekFrom::Start(0))?;
        Ok(self.output)
    }
}

fn utf8_sequence_length(first: u8) -> Option<usize> {
    match first {
        0xc2..=0xdf => Some(2),
        0xe0..=0xef => Some(3),
        0xf0..=0xf4 => Some(4),
        _ => None,
    }
}

pub(super) fn normalize_terminal_bytes(bytes: &[u8]) -> String {
    let stripped = strip_escape_sequences(bytes);
    normalize_terminal_controls(&String::from_utf8_lossy(&stripped))
}

fn strip_escape_sequences(bytes: &[u8]) -> Vec<u8> {
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == ESCAPE {
            index = skip_escape_sequence(bytes, index);
        } else {
            output.push(bytes[index]);
            index += 1;
        }
    }
    output
}

fn skip_escape_sequence(bytes: &[u8], escape_index: usize) -> usize {
    let Some(&kind) = bytes.get(escape_index + 1) else {
        return bytes.len();
    };
    match kind {
        b'[' => skip_control_sequence(bytes, escape_index + 2),
        b']' => skip_string_sequence(bytes, escape_index + 2, true),
        b'P' | b'X' | b'^' | b'_' => skip_string_sequence(bytes, escape_index + 2, false),
        _ => {
            let mut index = escape_index + 1;
            while bytes
                .get(index)
                .is_some_and(|byte| matches!(byte, 0x20..=0x2f))
            {
                index += 1;
            }
            match bytes.get(index) {
                Some(0x30..=0x7e) => index + 1,
                Some(_) => escape_index + 1,
                None => bytes.len(),
            }
        }
    }
}

fn skip_control_sequence(bytes: &[u8], mut index: usize) -> usize {
    while let Some(&byte) = bytes.get(index) {
        index += 1;
        if matches!(byte, 0x40..=0x7e) {
            return index;
        }
    }
    bytes.len()
}

fn skip_string_sequence(bytes: &[u8], mut index: usize, bell_terminated: bool) -> usize {
    while let Some(&byte) = bytes.get(index) {
        if bell_terminated && byte == BELL {
            return index + 1;
        }
        if byte == ESCAPE && bytes.get(index + 1) == Some(&b'\\') {
            return index + 2;
        }
        index += 1;
    }
    bytes.len()
}

fn normalize_terminal_controls(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut line = String::new();
    let mut characters = value.chars().peekable();

    while let Some(character) = characters.next() {
        match character {
            '\r' if characters.peek() == Some(&'\n') => {
                characters.next();
                flush_line(&mut output, &mut line, true);
            }
            '\r' => line.clear(),
            '\n' => flush_line(&mut output, &mut line, true),
            '\u{0008}' => {
                line.pop();
            }
            '\t' => line.push(character),
            control if control.is_control() => {}
            visible => line.push(visible),
        }
    }
    flush_line(&mut output, &mut line, false);
    output
}

fn flush_line(output: &mut String, line: &mut String, newline: bool) {
    output.push_str(line);
    line.clear();
    if newline {
        output.push('\n');
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Read as _, Seek as _, SeekFrom, Write as _};

    use super::{normalize_terminal_bytes, normalize_terminal_file};

    #[test]
    fn removes_color_and_style_sequences() {
        assert_eq!(
            normalize_terminal_bytes(b"\x1b[1m\x1b[32mPASS\x1b[39m\x1b[22m\n"),
            "PASS\n"
        );
    }

    #[test]
    fn keeps_hyperlink_text_without_the_terminal_envelope() {
        assert_eq!(
            normalize_terminal_bytes(b"\x1b]8;;https://example.com\x1b\\OpenAI\x1b]8;;\x1b\\\n"),
            "OpenAI\n"
        );
    }

    #[test]
    fn resolves_carriage_return_progress_to_the_final_visible_line() {
        assert_eq!(
            normalize_terminal_bytes(b"loading 10%\rloading 100%\x1b[2K\rDone\r\n"),
            "Done\n"
        );
    }

    #[test]
    fn preserves_utf8_and_removes_malformed_trailing_escape_data() {
        assert_eq!(
            normalize_terminal_bytes("ação concluída\x1b[31".as_bytes()),
            "ação concluída"
        );
    }

    #[test]
    fn normalizes_large_spooled_output_across_buffer_boundaries() {
        let mut input = tempfile::tempfile().expect("input spool should open");
        let prefix = "x".repeat(64 * 1_024 - 1);
        write!(input, "{prefix}ação\x1b[31m!\x1b[0m\rfinal\r\n").expect("fixture should write");
        input.seek(SeekFrom::Start(0)).expect("input should rewind");

        let mut output = normalize_terminal_file(input).expect("spool should normalize");
        let mut text = String::new();
        output
            .read_to_string(&mut text)
            .expect("normalized output should be UTF-8");

        assert!(text.ends_with("final\n"));
        assert!(!text.contains("\x1b["));
        assert!(!text.contains('\u{fffd}'));
    }
}
