use tokio::process::Command;

mod spool;
mod stream;

pub(super) use spool::TerminalSpoolWriter;
pub(super) use stream::TerminalOperation;
pub(super) use stream::TerminalStreamNormalizer;

const ESCAPE: u8 = 0x1b;
const BELL: u8 = 0x07;

pub(super) fn configure_plain_terminal(command: &mut Command) {
    command
        .env("NO_COLOR", "1")
        .env("CLICOLOR", "0")
        .env("FORCE_COLOR", "0")
        .env("TERM", "dumb");
    #[cfg(windows)]
    command
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8");
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
    use super::normalize_terminal_bytes;

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
}
