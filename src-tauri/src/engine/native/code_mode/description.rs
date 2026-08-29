use super::schema_types::render_json_schema_to_typescript;
use super::types::{ToolDefinition, ToolKind};

const EXEC_DESCRIPTION: &str = r#"Run JavaScript code to orchestrate and compose tool calls.
- Evaluates the source in a fresh sandboxed V8 isolate as an async module.
- Nested tools are available on the global `tools` object, for example `await tools.exec_command({...})`.
- Nested function tools accept an object; nested freeform tools accept a string.
- Nested tools return the type declared in their description.
- Runs raw JavaScript with no Node.js, file system, network, imports, or console.
- Accepts JavaScript source text, not JSON, quoted strings, or markdown code fences.
- An optional first line `// @exec: {"yield_time_ms": 10000, "max_output_tokens": 1000}` overrides response limits.
- `yield_time_ms` defaults to 10000 ms; `max_output_tokens` defaults to 10000 tokens.
- When evaluation completes, unawaited tool calls and timers are cancelled.

Global helpers:
- `exit()`: finishes the current script successfully.
- `text(value: string | number | boolean | undefined | null)`: appends text; objects are JSON-stringified when possible.
- `image(imageUrlOrItem: string | { image_url: string; detail?: "auto" | "low" | "high" | "original" | null } | ImageContent, detail?: "auto" | "low" | "high" | "original" | null)`: appends a base64 `data:` image.
- `audio(audioUrlOrItem: string | { audio_url: string } | AudioContent)`: appends a base64 `data:` audio item.
- `generatedImage(result: { image_url: string; output_hint?: string })`: appends an image-generation result.
- `store(key: string, value: unknown)` and `load(key: string)`: persist JSON values within this Code Mode session.
- `notify(value)`: emits an immediate notification output.
- `setTimeout(callback, delayMs?)` and `clearTimeout(timeoutId?)`: schedule or cancel a callback.
- `ALL_TOOLS`: metadata for enabled nested tools as `{ name, description }` entries.
- `yield_control()`: yields accumulated output immediately while the script keeps running."#;

const SHARED_MEDIA_TYPES: &str = r#"type ImageContent = {
  type: "image";
  data: string;
  mimeType: string;
  _meta?: { "codex/imageDetail"?: "auto" | "low" | "high" | "original" };
};
type AudioContent = { type: "audio"; data: string; mimeType: string };"#;

pub(super) fn build_exec_description(
    enabled_tools: &[ToolDefinition],
    code_mode_only: bool,
) -> String {
    if !code_mode_only || enabled_tools.is_empty() {
        return EXEC_DESCRIPTION.into();
    }

    let mut sections = vec![
        EXEC_DESCRIPTION.to_string(),
        format!("Shared media types:\n```ts\n{SHARED_MEDIA_TYPES}\n```"),
    ];
    sections.extend(enabled_tools.iter().map(render_tool_section));
    sections.join("\n\n")
}

fn render_tool_section(tool: &ToolDefinition) -> String {
    let input_name = match tool.kind {
        ToolKind::Function => "args",
        ToolKind::Freeform => "input",
    };
    let input_type = match tool.kind {
        ToolKind::Function => tool
            .input_schema
            .as_ref()
            .map(render_json_schema_to_typescript)
            .unwrap_or_else(|| "unknown".into()),
        ToolKind::Freeform => "string".into(),
    };
    let output_type = tool
        .output_schema
        .as_ref()
        .map(render_json_schema_to_typescript)
        .unwrap_or_else(|| "unknown".into());
    let global_name = normalize_identifier(&tool.name);
    let heading = if global_name == tool.name {
        format!("### `{global_name}`")
    } else {
        format!("### `{global_name}` (`{}`)", tool.name)
    };
    format!(
        "{heading}\n{}\n\nNested tool declaration:\n```ts\ndeclare const tools: {{ {global_name}({input_name}: {input_type}): Promise<{output_type}>; }};\n```",
        tool.description.trim()
    )
}

pub(super) fn normalize_identifier(name: &str) -> String {
    let mut normalized = String::with_capacity(name.len());
    for (index, character) in name.chars().enumerate() {
        let valid = if index == 0 {
            character == '_' || character == '$' || character.is_ascii_alphabetic()
        } else {
            character == '_' || character == '$' || character.is_ascii_alphanumeric()
        };
        normalized.push(if valid { character } else { '_' });
    }
    if normalized.is_empty() {
        "_".into()
    } else {
        normalized
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn code_mode_only_description_exposes_typed_nested_tools() {
        let description = build_exec_description(
            &[
                ToolDefinition {
                    name: "read_file".into(),
                    description: "Read a file.".into(),
                    kind: ToolKind::Function,
                    input_schema: Some(json!({
                        "type": "object",
                        "properties": { "path": { "type": "string" } },
                        "required": ["path"],
                        "additionalProperties": false
                    })),
                    output_schema: Some(json!({ "type": "string" })),
                },
                ToolDefinition {
                    name: "apply_patch".into(),
                    description: "Apply a patch.".into(),
                    kind: ToolKind::Freeform,
                    input_schema: None,
                    output_schema: Some(json!({ "type": "string" })),
                },
            ],
            true,
        );

        assert!(description.contains("read_file(args: { path: string; }): Promise<string>;"));
        assert!(description.contains("apply_patch(input: string): Promise<string>;"));
    }

    #[test]
    fn hybrid_description_does_not_duplicate_top_level_tool_schemas() {
        let description = build_exec_description(
            &[ToolDefinition {
                name: "read_file".into(),
                description: "Read a file.".into(),
                kind: ToolKind::Function,
                input_schema: Some(json!({ "type": "object" })),
                output_schema: Some(json!({ "type": "string" })),
            }],
            false,
        );

        assert!(!description.contains("### `read_file`"));
    }
}
