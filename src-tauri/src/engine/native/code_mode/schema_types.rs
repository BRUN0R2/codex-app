use std::collections::BTreeMap;

use serde_json::Value;

const MAX_RENDERED_SCHEMA_BYTES: usize = 16_000;
const MAX_SCHEMA_DEPTH: usize = 32;
const MAX_REF_EXPANSIONS: usize = 32;

pub(super) fn render_json_schema_to_typescript(schema: &Value) -> String {
    let mut renderer = SchemaRenderer {
        root: schema,
        active_refs: BTreeMap::new(),
        remaining_refs: MAX_REF_EXPANSIONS,
    };
    let rendered = renderer.render(schema, 0);
    if rendered.len() <= MAX_RENDERED_SCHEMA_BYTES {
        rendered
    } else {
        "unknown".into()
    }
}

struct SchemaRenderer<'a> {
    root: &'a Value,
    active_refs: BTreeMap<String, usize>,
    remaining_refs: usize,
}

impl SchemaRenderer<'_> {
    fn render(&mut self, schema: &Value, depth: usize) -> String {
        if depth > MAX_SCHEMA_DEPTH {
            return "unknown".into();
        }
        match schema {
            Value::Bool(true) => "unknown".into(),
            Value::Bool(false) => "never".into(),
            Value::Object(schema) => self.render_object_schema(schema, depth),
            _ => "unknown".into(),
        }
    }

    fn render_object_schema(
        &mut self,
        schema: &serde_json::Map<String, Value>,
        depth: usize,
    ) -> String {
        if let Some(reference) = schema.get("$ref").and_then(Value::as_str) {
            return self.render_reference(reference, depth);
        }
        if let Some(value) = schema.get("const") {
            return render_literal(value);
        }
        if let Some(values) = schema.get("enum").and_then(Value::as_array)
            && !values.is_empty()
        {
            return values
                .iter()
                .map(render_literal)
                .collect::<Vec<_>>()
                .join(" | ");
        }
        for keyword in ["anyOf", "oneOf"] {
            if let Some(branches) = schema.get(keyword).and_then(Value::as_array)
                && !branches.is_empty()
            {
                return branches
                    .iter()
                    .map(|branch| self.render(branch, depth + 1))
                    .collect::<Vec<_>>()
                    .join(" | ");
            }
        }
        if let Some(branches) = schema.get("allOf").and_then(Value::as_array)
            && !branches.is_empty()
        {
            return branches
                .iter()
                .map(|branch| parenthesize_union(self.render(branch, depth + 1)))
                .collect::<Vec<_>>()
                .join(" & ");
        }
        if let Some(types) = schema.get("type").and_then(Value::as_array) {
            let rendered = types
                .iter()
                .filter_map(Value::as_str)
                .map(|kind| self.render_type(schema, kind, depth))
                .collect::<Vec<_>>();
            if !rendered.is_empty() {
                return rendered.join(" | ");
            }
        }
        if let Some(kind) = schema.get("type").and_then(Value::as_str) {
            return self.render_type(schema, kind, depth);
        }
        if schema.contains_key("properties") || schema.contains_key("additionalProperties") {
            return self.render_record(schema, depth);
        }
        if schema.contains_key("items") || schema.contains_key("prefixItems") {
            return self.render_array(schema, depth);
        }
        "unknown".into()
    }

    fn render_reference(&mut self, reference: &str, depth: usize) -> String {
        let Some(pointer) = reference.strip_prefix('#') else {
            return "unknown".into();
        };
        let Some(pointer) = decode_uri_fragment(pointer) else {
            return "unknown".into();
        };
        if !pointer.is_empty() && !pointer.starts_with('/') {
            return "unknown".into();
        }
        let expansions = self.active_refs.get(&pointer).copied().unwrap_or_default();
        if expansions >= 2 || self.remaining_refs == 0 {
            return "unknown".into();
        }
        let Some(target) = (if pointer.is_empty() {
            Some(self.root)
        } else {
            self.root.pointer(&pointer)
        }) else {
            return "unknown".into();
        };
        self.remaining_refs -= 1;
        self.active_refs.insert(pointer.clone(), expansions + 1);
        let rendered = self.render(target, depth + 1);
        if expansions == 0 {
            self.active_refs.remove(&pointer);
        } else {
            self.active_refs.insert(pointer, expansions);
        }
        rendered
    }

    fn render_type(
        &mut self,
        schema: &serde_json::Map<String, Value>,
        kind: &str,
        depth: usize,
    ) -> String {
        match kind {
            "string" => "string".into(),
            "integer" | "number" => "number".into(),
            "boolean" => "boolean".into(),
            "null" => "null".into(),
            "array" => self.render_array(schema, depth),
            "object" => self.render_record(schema, depth),
            _ => "unknown".into(),
        }
    }

    fn render_array(&mut self, schema: &serde_json::Map<String, Value>, depth: usize) -> String {
        if let Some(items) = schema.get("items") {
            return format!("Array<{}>", self.render(items, depth + 1));
        }
        if let Some(items) = schema.get("prefixItems").and_then(Value::as_array) {
            return format!(
                "[{}]",
                items
                    .iter()
                    .map(|item| self.render(item, depth + 1))
                    .collect::<Vec<_>>()
                    .join(", ")
            );
        }
        "unknown[]".into()
    }

    fn render_record(&mut self, schema: &serde_json::Map<String, Value>, depth: usize) -> String {
        let required = schema
            .get("required")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect::<std::collections::BTreeSet<_>>();
        let mut properties = schema
            .get("properties")
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
        properties.sort_unstable_by_key(|(name, _)| name.as_str());

        let multiline = properties.iter().any(|(_, property)| {
            property
                .get("description")
                .and_then(Value::as_str)
                .is_some_and(|description| !description.trim().is_empty())
        });
        let mut fields = Vec::new();
        for (name, property) in properties {
            let field_name = render_property_name(name);
            let optional = if required.contains(name.as_str()) {
                ""
            } else {
                "?"
            };
            let field = format!(
                "{field_name}{optional}: {};",
                self.render(property, depth + 1)
            );
            if multiline {
                for line in property
                    .get("description")
                    .and_then(Value::as_str)
                    .into_iter()
                    .flat_map(str::lines)
                    .map(str::trim)
                    .filter(|line| !line.is_empty())
                {
                    fields.push(format!("  // {line}"));
                }
                fields.push(format!("  {field}"));
            } else {
                fields.push(field);
            }
        }
        match schema.get("additionalProperties") {
            Some(Value::Bool(true)) | None if fields.is_empty() => {
                fields.push("[key: string]: unknown;".into());
            }
            Some(Value::Object(_)) | Some(Value::Bool(true)) => {
                let value = schema
                    .get("additionalProperties")
                    .map(|schema| self.render(schema, depth + 1))
                    .unwrap_or_else(|| "unknown".into());
                fields.push(format!("[key: string]: {value};"));
            }
            _ => {}
        }
        if fields.is_empty() {
            "{}".into()
        } else if multiline {
            format!("{{\n{}\n}}", fields.join("\n"))
        } else {
            format!("{{ {} }}", fields.join(" "))
        }
    }
}

fn render_property_name(name: &str) -> String {
    if super::description::normalize_identifier(name) == name {
        name.into()
    } else {
        serde_json::to_string(name).unwrap_or_else(|_| "\"invalid\"".into())
    }
}

fn render_literal(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "unknown".into())
}

fn parenthesize_union(rendered: String) -> String {
    if rendered.contains(" | ") {
        format!("({rendered})")
    } else {
        rendered
    }
}

fn decode_uri_fragment(fragment: &str) -> Option<String> {
    let bytes = fragment.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let high = decode_hex_digit(*bytes.get(index + 1)?)?;
            let low = decode_hex_digit(*bytes.get(index + 2)?)?;
            decoded.push((high << 4) | low);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).ok()
}

fn decode_hex_digit(digit: u8) -> Option<u8> {
    match digit {
        b'0'..=b'9' => Some(digit - b'0'),
        b'a'..=b'f' => Some(digit - b'a' + 10),
        b'A'..=b'F' => Some(digit - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::render_json_schema_to_typescript;

    #[test]
    fn renders_nested_strict_objects_deterministically() {
        let schema = json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "File path." },
                "options": {
                    "type": "array",
                    "items": { "type": "string", "enum": ["a", "b"] }
                }
            },
            "required": ["path"],
            "additionalProperties": false
        });

        assert_eq!(
            render_json_schema_to_typescript(&schema),
            "{\n  options?: Array<\"a\" | \"b\">;\n  // File path.\n  path: string;\n}"
        );
    }

    #[test]
    fn bounds_recursive_local_references() {
        let schema = json!({
            "$defs": {
                "node": {
                    "type": "object",
                    "properties": { "next": { "$ref": "#/$defs/node" } }
                }
            },
            "$ref": "#/$defs/node"
        });

        let rendered = render_json_schema_to_typescript(&schema);
        assert!(rendered.contains("next?:"));
        assert!(rendered.contains("unknown"));
        assert!(rendered.len() < 1_000);
    }
}
