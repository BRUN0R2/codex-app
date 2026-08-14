const CONTENT_REFERENCE_START: char = '\u{E200}';
const CONTENT_REFERENCE_END: char = '\u{E201}';

/// Removes complete provider-only content-reference envelopes from persisted assistant text.
///
/// Streaming presentation handles an unfinished tail separately. Persistence deliberately mirrors
/// the Codex Desktop boundary: only a complete U+E200 ... U+E201 envelope is removed.
pub(super) fn strip_content_reference_markers(value: &str) -> String {
    let Some(mut start) = value.find(CONTENT_REFERENCE_START) else {
        return value.to_string();
    };

    let mut output = String::with_capacity(value.len());
    let mut cursor = 0;
    loop {
        output.push_str(&value[cursor..start]);
        let content_start = start + CONTENT_REFERENCE_START.len_utf8();
        let Some(relative_end) = value[content_start..].find(CONTENT_REFERENCE_END) else {
            output.push_str(&value[start..]);
            break;
        };
        cursor = content_start + relative_end + CONTENT_REFERENCE_END.len_utf8();
        let Some(relative_start) = value[cursor..].find(CONTENT_REFERENCE_START) else {
            output.push_str(&value[cursor..]);
            break;
        };
        start = cursor + relative_start;
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_complete_private_content_reference_envelopes() {
        assert_eq!(
            strip_content_reference_markers(
                "Antes \u{E200}cite\u{E202}turn0search0\u{E202}turn0search5\u{E201} depois"
            ),
            "Antes  depois"
        );
    }

    #[test]
    fn strips_multiple_envelopes_and_preserves_plain_text() {
        assert_eq!(
            strip_content_reference_markers(
                "A\u{E200}cite\u{E202}one\u{E201}B\u{E200}source\u{E202}two\u{E201}C"
            ),
            "ABC"
        );
        assert_eq!(strip_content_reference_markers("plain"), "plain");
    }

    #[test]
    fn preserves_an_incomplete_envelope_for_the_streaming_boundary() {
        assert_eq!(
            strip_content_reference_markers("text \u{E200}cite\u{E202}partial"),
            "text \u{E200}cite\u{E202}partial"
        );
    }
}
