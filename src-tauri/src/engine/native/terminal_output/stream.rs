use std::io;

const ESCAPE: u8 = 0x1b;
const BELL: u8 = 0x07;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(in crate::engine::native) enum TerminalOperation {
    Append(String),
    Backspace,
    ClearCurrentLine,
}

#[derive(Clone, Copy, Debug)]
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

pub(in crate::engine::native) struct TerminalStreamNormalizer {
    pending_carriage_return: bool,
    escape_state: EscapeState,
    utf8: Vec<u8>,
    utf8_expected: usize,
}

impl Default for TerminalStreamNormalizer {
    fn default() -> Self {
        Self {
            pending_carriage_return: false,
            escape_state: EscapeState::Text,
            utf8: Vec::with_capacity(4),
            utf8_expected: 0,
        }
    }
}

impl TerminalStreamNormalizer {
    pub(in crate::engine::native) fn push(
        &mut self,
        bytes: &[u8],
    ) -> io::Result<Vec<TerminalOperation>> {
        let mut operations = Vec::new();
        for &byte in bytes {
            self.push_byte(byte, &mut operations)?;
        }
        Ok(operations)
    }

    pub(in crate::engine::native) fn finish(mut self) -> io::Result<Vec<TerminalOperation>> {
        if !self.utf8.is_empty() {
            self.reject_invalid_utf8()?;
        }
        let mut operations = Vec::new();
        if self.pending_carriage_return {
            operations.push(TerminalOperation::ClearCurrentLine);
            self.pending_carriage_return = false;
        }
        Ok(operations)
    }

    fn push_byte(&mut self, byte: u8, operations: &mut Vec<TerminalOperation>) -> io::Result<()> {
        match self.escape_state {
            EscapeState::Text if byte == ESCAPE => {
                if !self.utf8.is_empty() {
                    return self.reject_invalid_utf8();
                }
                self.escape_state = EscapeState::Escape;
            }
            EscapeState::Text => self.push_text_byte(byte, operations)?,
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
                    self.push_text_byte(byte, operations)?;
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
                    self.push_text_byte(byte, operations)?;
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

    fn push_text_byte(
        &mut self,
        byte: u8,
        operations: &mut Vec<TerminalOperation>,
    ) -> io::Result<()> {
        if self.utf8.is_empty() {
            if byte.is_ascii() {
                return self.process_character(char::from(byte), operations);
            }
            let Some(expected) = utf8_sequence_length(byte) else {
                return self.reject_invalid_utf8();
            };
            self.utf8.push(byte);
            self.utf8_expected = expected;
            return Ok(());
        }

        if !matches!(byte, 0x80..=0xbf) {
            return self.reject_invalid_utf8();
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
            Some(character) => self.process_character(character, operations),
            None => self.reject_invalid_utf8(),
        }
    }

    fn process_character(
        &mut self,
        character: char,
        operations: &mut Vec<TerminalOperation>,
    ) -> io::Result<()> {
        if self.pending_carriage_return {
            if character == '\n' {
                self.pending_carriage_return = false;
                push_append(operations, "\n");
                return Ok(());
            }
            operations.push(TerminalOperation::ClearCurrentLine);
            self.pending_carriage_return = false;
        }

        match character {
            '\r' => self.pending_carriage_return = true,
            '\n' => push_append(operations, "\n"),
            '\u{0008}' => operations.push(TerminalOperation::Backspace),
            '\t' => push_append(operations, "\t"),
            control if control.is_control() => {}
            visible => {
                let mut encoded = [0u8; 4];
                push_append(operations, visible.encode_utf8(&mut encoded));
            }
        }
        Ok(())
    }

    fn reject_invalid_utf8(&mut self) -> io::Result<()> {
        self.utf8.clear();
        self.utf8_expected = 0;
        Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "process output is not valid UTF-8",
        ))
    }
}

fn push_append(operations: &mut Vec<TerminalOperation>, value: &str) {
    if let Some(TerminalOperation::Append(current)) = operations.last_mut() {
        current.push_str(value);
    } else {
        operations.push(TerminalOperation::Append(value.to_string()));
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

#[cfg(test)]
#[path = "stream_tests.rs"]
mod tests;
