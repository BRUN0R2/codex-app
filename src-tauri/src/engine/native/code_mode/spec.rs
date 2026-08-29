use serde::Deserialize;
use serde_json::{Value, json};

use super::description::build_exec_description;
use super::types::ToolDefinition;
use super::types::{CodeModeError, DEFAULT_EXEC_YIELD_TIME_MS, DEFAULT_MAX_OUTPUT_TOKENS};
use super::types::{MAX_RESPONSE_TOKEN_BUDGET, MAX_YIELD_TIME_MS};

const PRAGMA_PREFIX: &str = "// @exec:";
const MAX_JS_SAFE_INTEGER: u64 = (1_u64 << 53) - 1;
const EXEC_GRAMMAR: &str = r#"
start: pragma_source | plain_source
pragma_source: PRAGMA_LINE NEWLINE SOURCE
plain_source: SOURCE

PRAGMA_LINE: /[ \t]*\/\/ @exec:[^\r\n]*/
NEWLINE: /\r?\n/
SOURCE: /[\s\S]+/
"#;

const WAIT_DESCRIPTION: &str = r#"Wait on a yielded `exec` cell and return only output produced since the previous observation.
- Use only after `exec` returns a running cell ID.
- `yield_time_ms` defaults to 10000 ms.
- `max_tokens` defaults to 10000 tokens.
- `terminate: true` stops the cell.
- A running cell may yield repeatedly with the same ID; a completed or terminated cell closes."#;

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct ParsedExecSource {
    pub source: String,
    pub yield_time_ms: u64,
    pub max_output_tokens: usize,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExecPragma {
    #[serde(default)]
    yield_time_ms: Option<u64>,
    #[serde(default)]
    max_output_tokens: Option<usize>,
}

pub(crate) fn parse_exec_source(input: &str) -> Result<ParsedExecSource, CodeModeError> {
    if input.trim().is_empty() {
        return Err(CodeModeError::InvalidRequest(
            "exec expects raw non-empty JavaScript source".into(),
        ));
    }
    let mut source = input.to_string();
    let mut yield_time_ms = DEFAULT_EXEC_YIELD_TIME_MS;
    let mut max_output_tokens = DEFAULT_MAX_OUTPUT_TOKENS;
    let mut lines = input.splitn(2, '\n');
    let first_line = lines.next().unwrap_or_default();
    let rest = lines.next().unwrap_or_default();
    if let Some(directive) = first_line.trim_start().strip_prefix(PRAGMA_PREFIX) {
        if rest.trim().is_empty() {
            return Err(CodeModeError::InvalidRequest(
                "exec pragma must be followed by JavaScript source on subsequent lines".into(),
            ));
        }
        let directive = directive.trim();
        if directive.is_empty() {
            return Err(CodeModeError::InvalidRequest(
                "exec pragma must be a JSON object".into(),
            ));
        }
        let pragma: ExecPragma = serde_json::from_str(directive).map_err(|error| {
            CodeModeError::InvalidRequest(format!("exec pragma is invalid: {error}"))
        })?;
        if pragma
            .yield_time_ms
            .is_some_and(|value| value > MAX_JS_SAFE_INTEGER)
            || pragma.max_output_tokens.is_some_and(|value| {
                u64::try_from(value).map_or(true, |value| value > MAX_JS_SAFE_INTEGER)
            })
        {
            return Err(CodeModeError::InvalidRequest(
                "exec pragma values must be non-negative JavaScript-safe integers".into(),
            ));
        }
        source = rest.to_string();
        yield_time_ms = pragma.yield_time_ms.unwrap_or(DEFAULT_EXEC_YIELD_TIME_MS);
        max_output_tokens = pragma
            .max_output_tokens
            .unwrap_or(DEFAULT_MAX_OUTPUT_TOKENS);
    }
    Ok(ParsedExecSource {
        source,
        yield_time_ms,
        max_output_tokens,
    })
}

pub(crate) fn exec_definition(enabled_tools: &[ToolDefinition], code_mode_only: bool) -> Value {
    json!({
        "type": "custom",
        "name": "exec",
        "description": build_exec_description(enabled_tools, code_mode_only),
        "format": {
            "type": "grammar",
            "syntax": "lark",
            "definition": EXEC_GRAMMAR
        }
    })
}

pub(crate) fn wait_definition() -> Value {
    json!({
        "type": "function",
        "name": "wait",
        "description": WAIT_DESCRIPTION,
        "strict": false,
        "parameters": {
            "type": "object",
            "properties": {
                "cell_id": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 64,
                    "description": "Identifier returned by exec."
                },
                "yield_time_ms": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": MAX_YIELD_TIME_MS,
                    "description": "Wait before yielding more output. Defaults to 10000 ms."
                },
                "max_tokens": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": MAX_RESPONSE_TOKEN_BUDGET,
                    "description": "Output budget for this observation. Defaults to 10000 tokens."
                },
                "terminate": {
                    "type": "boolean",
                    "description": "True stops the running cell; false or omitted waits."
                }
            },
            "required": ["cell_id"],
            "additionalProperties": false
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_strict_exec_pragma_and_removes_only_its_first_line() {
        let parsed = parse_exec_source(
            "// @exec: {\"yield_time_ms\":25,\"max_output_tokens\":50}\r\ntext('ok')",
        )
        .expect("pragma should parse");
        assert_eq!(parsed.source, "text('ok')");
        assert_eq!(parsed.yield_time_ms, 25);
        assert_eq!(parsed.max_output_tokens, 50);
    }

    #[test]
    fn rejects_unknown_pragma_fields() {
        let error = parse_exec_source("// @exec: {\"timeout\":1}\ntext('ok')")
            .expect_err("unknown fields must fail closed");
        assert!(error.to_string().contains("unknown field"));
    }

    #[test]
    fn preserves_plain_source_that_mentions_pragma_later() {
        let source = "text('before')\n// @exec: {\"yield_time_ms\":1}";
        assert_eq!(
            parse_exec_source(source).expect("plain source should parse"),
            ParsedExecSource {
                source: source.into(),
                yield_time_ms: DEFAULT_EXEC_YIELD_TIME_MS,
                max_output_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
            }
        );
    }
}
