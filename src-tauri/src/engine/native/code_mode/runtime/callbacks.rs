use super::super::types::{
    MAX_CELL_OUTPUT_BYTES, MAX_CELL_OUTPUT_ITEMS, MAX_STORED_VALUE_BYTES, MAX_STORED_VALUE_ENTRIES,
};
use super::value::{
    json_to_v8, normalize_audio, normalize_image, serialize_output_text, throw_type_error,
    v8_value_to_json,
};
use super::{EXIT_SENTINEL, RuntimeEvent, RuntimeState, timers};
use crate::engine::native::provider::FunctionCallOutputContent;

const MAX_PENDING_TOOL_CALLS: usize = 64;
const MAX_YIELD_REQUESTS: usize = 64;

pub(super) fn tool_callback(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments,
    mut retval: v8::ReturnValue<v8::Value>,
) {
    let tool_index = match args.data().to_rust_string_lossy(scope).parse::<usize>() {
        Ok(tool_index) => tool_index,
        Err(_) => {
            throw_type_error(scope, "invalid tool callback data");
            return;
        }
    };
    let input = if args.length() == 0 {
        Ok(None)
    } else {
        v8_value_to_json(scope, args.get(0))
    };
    let input = match input {
        Ok(input) => input,
        Err(error) => {
            throw_type_error(scope, &error);
            return;
        }
    };
    let (name, kind) = {
        let Some(state) = scope.get_slot::<RuntimeState>() else {
            throw_type_error(scope, "runtime state unavailable");
            return;
        };
        if state.pending_tool_calls.len() >= MAX_PENDING_TOOL_CALLS {
            throw_type_error(
                scope,
                &format!("nested tool limit of {MAX_PENDING_TOOL_CALLS} concurrent calls exceeded"),
            );
            return;
        }
        let Some(tool) = state.enabled_tools.get(tool_index) else {
            throw_type_error(scope, "tool callback data is out of range");
            return;
        };
        (tool.name.clone(), tool.kind)
    };
    let Some(resolver) = v8::PromiseResolver::new(scope) else {
        throw_type_error(scope, "failed to create nested tool promise");
        return;
    };
    let promise = resolver.get_promise(scope);
    let resolver = v8::Global::new(scope, resolver);
    let Some(state) = scope.get_slot_mut::<RuntimeState>() else {
        throw_type_error(scope, "runtime state unavailable");
        return;
    };
    let id = format!("tool-{}", state.next_tool_call_id);
    let Some(next_tool_call_id) = state.next_tool_call_id.checked_add(1) else {
        throw_type_error(scope, "nested tool call id space exhausted");
        return;
    };
    state.next_tool_call_id = next_tool_call_id;
    state.pending_tool_calls.insert(id.clone(), resolver);
    let event = RuntimeEvent::ToolCall {
        id: id.clone(),
        name,
        kind,
        input,
    };
    if state.event_tx.send(event).is_err() {
        state.pending_tool_calls.remove(&id);
        throw_type_error(scope, "Code Mode cell closed before nested tool dispatch");
        return;
    }
    retval.set(promise.into());
}

pub(super) fn text_callback(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments,
    mut retval: v8::ReturnValue<v8::Value>,
) {
    let value = if args.length() == 0 {
        v8::undefined(scope).into()
    } else {
        args.get(0)
    };
    let text = match serialize_output_text(scope, value) {
        Ok(text) => text,
        Err(error) => {
            throw_type_error(scope, &error);
            return;
        }
    };
    if let Err(error) = emit_content(scope, FunctionCallOutputContent::InputText { text }) {
        throw_type_error(scope, &error);
        return;
    }
    retval.set(v8::undefined(scope).into());
}

pub(super) fn image_callback(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments,
    mut retval: v8::ReturnValue<v8::Value>,
) {
    let detail_override = if args.length() < 2 {
        None
    } else {
        let detail = args.get(1);
        if detail.is_string() {
            Some(detail.to_rust_string_lossy(scope))
        } else if detail.is_null_or_undefined() {
            None
        } else {
            throw_type_error(scope, "image detail must be a string when provided");
            return;
        }
    };
    let value = if args.length() == 0 {
        v8::undefined(scope).into()
    } else {
        args.get(0)
    };
    let content = match normalize_image(scope, value, detail_override) {
        Ok(content) => content,
        Err(error) => {
            throw_type_error(scope, &error);
            return;
        }
    };
    if let Err(error) = emit_content(scope, content) {
        throw_type_error(scope, &error);
        return;
    }
    retval.set(v8::undefined(scope).into());
}

pub(super) fn audio_callback(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments,
    mut retval: v8::ReturnValue<v8::Value>,
) {
    let value = if args.length() == 0 {
        v8::undefined(scope).into()
    } else {
        args.get(0)
    };
    let content = match normalize_audio(scope, value) {
        Ok(content) => content,
        Err(error) => {
            throw_type_error(scope, &error);
            return;
        }
    };
    if let Err(error) = emit_content(scope, content) {
        throw_type_error(scope, &error);
        return;
    }
    retval.set(v8::undefined(scope).into());
}

pub(super) fn generated_image_callback(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments,
    mut retval: v8::ReturnValue<v8::Value>,
) {
    let value = if args.length() == 0 {
        v8::undefined(scope).into()
    } else {
        args.get(0)
    };
    let output_hint = match generated_image_output_hint(scope, value) {
        Ok(output_hint) => output_hint,
        Err(error) => {
            throw_type_error(scope, &error);
            return;
        }
    };
    let content = match normalize_image(scope, value, None) {
        Ok(content) => content,
        Err(error) => {
            throw_type_error(scope, &error);
            return;
        }
    };
    if let Err(error) = emit_content(scope, content) {
        throw_type_error(scope, &error);
        return;
    }
    if let Some(text) = output_hint
        && let Err(error) = emit_content(scope, FunctionCallOutputContent::InputText { text })
    {
        throw_type_error(scope, &error);
        return;
    }
    retval.set(v8::undefined(scope).into());
}

pub(super) fn store_callback(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments,
    mut retval: v8::ReturnValue<v8::Value>,
) {
    let key_value = args.get(0);
    if !key_value.is_string() {
        throw_type_error(scope, "store key must be a string");
        return;
    }
    let key = key_value.to_rust_string_lossy(scope);
    if key.is_empty() || key.len() > 256 || key.chars().any(char::is_control) {
        throw_type_error(
            scope,
            "store key must contain between 1 and 256 bytes without control characters",
        );
        return;
    }
    let value = match v8_value_to_json(scope, args.get(1)) {
        Ok(Some(value)) => value,
        Ok(None) => {
            throw_type_error(
                scope,
                "store accepts only JSON-serializable values; undefined and functions are unsupported",
            );
            return;
        }
        Err(error) => {
            throw_type_error(scope, &error);
            return;
        }
    };
    let Some(state) = scope.get_slot::<RuntimeState>() else {
        throw_type_error(scope, "runtime state unavailable");
        return;
    };
    let mut candidate = state.stored_values.clone();
    candidate.insert(key.clone(), value.clone());
    if let Err(error) = validate_stored_values(&candidate) {
        throw_type_error(scope, &error);
        return;
    }
    let Some(state) = scope.get_slot_mut::<RuntimeState>() else {
        throw_type_error(scope, "runtime state unavailable");
        return;
    };
    state.stored_values.insert(key.clone(), value.clone());
    state.stored_value_writes.insert(key, value);
    retval.set(v8::undefined(scope).into());
}

pub(super) fn load_callback(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments,
    mut retval: v8::ReturnValue<v8::Value>,
) {
    let key_value = args.get(0);
    if !key_value.is_string() {
        throw_type_error(scope, "load key must be a string");
        return;
    }
    let key = key_value.to_rust_string_lossy(scope);
    let value = scope
        .get_slot::<RuntimeState>()
        .and_then(|state| state.stored_values.get(&key))
        .cloned();
    let Some(value) = value else {
        retval.set(v8::undefined(scope).into());
        return;
    };
    let Some(value) = json_to_v8(scope, &value) else {
        throw_type_error(scope, "failed to deserialize stored value");
        return;
    };
    retval.set(value);
}

pub(super) fn notify_callback(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments,
    mut retval: v8::ReturnValue<v8::Value>,
) {
    let value = if args.length() == 0 {
        v8::undefined(scope).into()
    } else {
        args.get(0)
    };
    let text = match serialize_output_text(scope, value) {
        Ok(text) if !text.trim().is_empty() => text,
        Ok(_) => {
            throw_type_error(scope, "notify expects non-empty text");
            return;
        }
        Err(error) => {
            throw_type_error(scope, &error);
            return;
        }
    };
    if let Err(error) = emit_notification(scope, text) {
        throw_type_error(scope, &error);
        return;
    }
    retval.set(v8::undefined(scope).into());
}

pub(super) fn set_timeout_callback(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments,
    mut retval: v8::ReturnValue<v8::Value>,
) {
    let timeout_id = match timers::schedule(scope, args) {
        Ok(timeout_id) => timeout_id,
        Err(error) => {
            throw_type_error(scope, &error);
            return;
        }
    };
    retval.set(v8::Number::new(scope, timeout_id as f64).into());
}

pub(super) fn clear_timeout_callback(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments,
    mut retval: v8::ReturnValue<v8::Value>,
) {
    if let Err(error) = timers::clear(scope, args) {
        throw_type_error(scope, &error);
        return;
    }
    retval.set(v8::undefined(scope).into());
}

pub(super) fn yield_control_callback(
    scope: &mut v8::PinScope<'_, '_>,
    _args: v8::FunctionCallbackArguments,
    mut retval: v8::ReturnValue<v8::Value>,
) {
    let Some(state) = scope.get_slot_mut::<RuntimeState>() else {
        throw_type_error(scope, "runtime state unavailable");
        return;
    };
    if state.yield_requests >= MAX_YIELD_REQUESTS {
        throw_type_error(
            scope,
            &format!("yield_control limit of {MAX_YIELD_REQUESTS} calls exceeded"),
        );
        return;
    }
    state.yield_requests += 1;
    if state.event_tx.send(RuntimeEvent::YieldRequested).is_err() {
        throw_type_error(scope, "Code Mode cell closed before yielding");
        return;
    }
    retval.set(v8::undefined(scope).into());
}

pub(super) fn exit_callback(
    scope: &mut v8::PinScope<'_, '_>,
    _args: v8::FunctionCallbackArguments,
    _retval: v8::ReturnValue<v8::Value>,
) {
    if let Some(state) = scope.get_slot_mut::<RuntimeState>() {
        state.exit_requested = true;
    }
    if let Some(error) = v8::String::new(scope, EXIT_SENTINEL) {
        scope.throw_exception(error.into());
    }
}

fn emit_content(
    scope: &mut v8::PinScope<'_, '_>,
    content: FunctionCallOutputContent,
) -> Result<(), String> {
    let state = scope
        .get_slot_mut::<RuntimeState>()
        .ok_or_else(|| "runtime state unavailable".to_string())?;
    reserve_content(state, &content)?;
    state
        .event_tx
        .send(RuntimeEvent::Content(content))
        .map_err(|_| "Code Mode cell closed before emitting output".to_string())
}

fn emit_notification(scope: &mut v8::PinScope<'_, '_>, text: String) -> Result<(), String> {
    let state = scope
        .get_slot_mut::<RuntimeState>()
        .ok_or_else(|| "runtime state unavailable".to_string())?;
    reserve_content(
        state,
        &FunctionCallOutputContent::InputText { text: text.clone() },
    )?;
    state
        .event_tx
        .send(RuntimeEvent::Notify {
            call_id: state.call_id.clone(),
            text,
        })
        .map_err(|_| "Code Mode cell closed before emitting a notification".to_string())
}

fn reserve_content(
    state: &mut RuntimeState,
    content: &FunctionCallOutputContent,
) -> Result<(), String> {
    if state.emitted_content_items >= MAX_CELL_OUTPUT_ITEMS {
        return Err(format!(
            "exec output exceeded the {MAX_CELL_OUTPUT_ITEMS}-item limit"
        ));
    }
    let item_bytes = serde_json::to_vec(content)
        .map_err(|error| format!("failed to size exec output: {error}"))?
        .len();
    let next_bytes = state
        .emitted_content_bytes
        .checked_add(item_bytes)
        .ok_or_else(|| "exec output size overflowed".to_string())?;
    if next_bytes > MAX_CELL_OUTPUT_BYTES {
        return Err(format!(
            "exec output exceeded the {MAX_CELL_OUTPUT_BYTES}-byte limit"
        ));
    }
    state.emitted_content_items += 1;
    state.emitted_content_bytes = next_bytes;
    Ok(())
}

fn generated_image_output_hint(
    scope: &mut v8::PinScope<'_, '_>,
    value: v8::Local<'_, v8::Value>,
) -> Result<Option<String>, String> {
    let object = v8::Local::<v8::Object>::try_from(value)
        .map_err(|_| "generatedImage expects an image generation result object".to_string())?;
    let key = v8::String::new(scope, "output_hint")
        .ok_or_else(|| "failed to allocate generatedImage output_hint key".to_string())?;
    let output_hint = object
        .get(scope, key.into())
        .ok_or_else(|| "failed to read generatedImage output_hint".to_string())?;
    if output_hint.is_null_or_undefined() {
        return Ok(None);
    }
    if !output_hint.is_string() {
        return Err("generatedImage output_hint must be a string when provided".into());
    }
    Ok(Some(output_hint.to_rust_string_lossy(scope)))
}

fn validate_stored_values(
    values: &std::collections::HashMap<String, serde_json::Value>,
) -> Result<(), String> {
    if values.len() > MAX_STORED_VALUE_ENTRIES {
        return Err(format!(
            "store limit of {MAX_STORED_VALUE_ENTRIES} entries exceeded"
        ));
    }
    let bytes = serde_json::to_vec(values)
        .map_err(|error| format!("failed to size stored values: {error}"))?
        .len();
    if bytes > MAX_STORED_VALUE_BYTES {
        return Err(format!(
            "stored values exceed the {MAX_STORED_VALUE_BYTES}-byte limit"
        ));
    }
    Ok(())
}
