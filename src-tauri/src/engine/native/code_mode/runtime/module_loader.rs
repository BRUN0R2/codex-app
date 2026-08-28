use serde_json::Value;

use super::value::{json_to_v8, value_to_error_text};
use super::{CompletionState, EXIT_SENTINEL, RuntimeState};

pub(super) fn evaluate(
    scope: &mut v8::PinScope<'_, '_>,
    source_text: &str,
) -> Result<Option<v8::Global<v8::Promise>>, String> {
    let try_catch = std::pin::pin!(v8::TryCatch::new(scope));
    let mut try_catch = try_catch.init();
    let source = v8::String::new(&try_catch, source_text)
        .ok_or_else(|| "failed to allocate exec source".to_string())?;
    let origin = script_origin(&mut try_catch, "exec_main.mjs")?;
    let mut source = v8::script_compiler::Source::new(source, Some(&origin));
    let module = v8::script_compiler::compile_module(&try_catch, &mut source).ok_or_else(|| {
        try_catch
            .exception()
            .map(|exception| value_to_error_text(&mut try_catch, exception))
            .unwrap_or_else(|| "unknown Code Mode compilation error".to_string())
    })?;
    module
        .instantiate_module(&try_catch, resolve_module_callback)
        .ok_or_else(|| {
            try_catch
                .exception()
                .map(|exception| value_to_error_text(&mut try_catch, exception))
                .unwrap_or_else(|| "unknown Code Mode module error".to_string())
        })?;
    let result = match module.evaluate(&try_catch) {
        Some(result) => result,
        None => {
            if let Some(exception) = try_catch.exception() {
                if is_exit_exception(&mut try_catch, exception) {
                    return Ok(None);
                }
                return Err(value_to_error_text(&mut try_catch, exception));
            }
            return Err("unknown Code Mode evaluation error".into());
        }
    };
    try_catch.perform_microtask_checkpoint();
    if !result.is_promise() {
        return Ok(None);
    }
    let promise = v8::Local::<v8::Promise>::try_from(result)
        .map_err(|_| "failed to read exec promise".to_string())?;
    Ok(Some(v8::Global::new(&try_catch, promise)))
}

pub(super) fn resolve_tool(
    scope: &mut v8::PinScope<'_, '_>,
    id: &str,
    result: Result<Value, String>,
) -> Result<(), String> {
    let resolver = scope
        .get_slot_mut::<RuntimeState>()
        .and_then(|state| state.pending_tool_calls.remove(id))
        .ok_or_else(|| format!("tool response `{id}` has no pending call"))?;
    let resolver = v8::Local::new(scope, &resolver);
    let settled = match result {
        Ok(value) => {
            let value = json_to_v8(scope, &value)
                .ok_or_else(|| "failed to deserialize nested tool output".to_string())?;
            resolver.resolve(scope, value)
        }
        Err(error) => {
            let error = v8::String::new(scope, &error)
                .map(Into::into)
                .unwrap_or_else(|| v8::undefined(scope).into());
            resolver.reject(scope, error)
        }
    };
    if settled == Some(true) {
        Ok(())
    } else {
        Err(format!("failed to settle nested tool call `{id}`"))
    }
}

pub(super) fn completion_state(
    scope: &mut v8::PinScope<'_, '_>,
    promise: Option<&v8::Global<v8::Promise>>,
) -> CompletionState {
    let stored_value_writes = scope
        .get_slot::<RuntimeState>()
        .map(|state| state.stored_value_writes.clone())
        .unwrap_or_default();
    let Some(promise) = promise else {
        return CompletionState::Completed {
            stored_value_writes,
            error: None,
        };
    };
    let promise = v8::Local::new(scope, promise);
    match promise.state() {
        v8::PromiseState::Pending => CompletionState::Pending,
        v8::PromiseState::Fulfilled => CompletionState::Completed {
            stored_value_writes,
            error: None,
        },
        v8::PromiseState::Rejected => {
            let result = promise.result(scope);
            let exit_requested = scope
                .get_slot::<RuntimeState>()
                .is_some_and(|state| state.exit_requested);
            let error = if exit_requested && is_exit_exception(scope, result) {
                None
            } else {
                Some(value_to_error_text(scope, result))
            };
            CompletionState::Completed {
                stored_value_writes,
                error,
            }
        }
    }
}

fn is_exit_exception(
    scope: &mut v8::PinScope<'_, '_>,
    exception: v8::Local<'_, v8::Value>,
) -> bool {
    exception.is_string() && exception.to_rust_string_lossy(scope) == EXIT_SENTINEL
}

fn script_origin<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    resource_name: &str,
) -> Result<v8::ScriptOrigin<'s>, String> {
    let resource_name = v8::String::new(scope, resource_name)
        .ok_or_else(|| "failed to allocate script origin".to_string())?;
    let source_map_url = v8::String::new(scope, "exec_main.mjs")
        .ok_or_else(|| "failed to allocate source-map URL".to_string())?;
    Ok(v8::ScriptOrigin::new(
        scope,
        resource_name.into(),
        0,
        0,
        true,
        0,
        Some(source_map_url.into()),
        true,
        false,
        true,
        None,
    ))
}

fn resolve_module_callback<'s>(
    context: v8::Local<'s, v8::Context>,
    specifier: v8::Local<'s, v8::String>,
    _import_attributes: v8::Local<'s, v8::FixedArray>,
    _referrer: v8::Local<'s, v8::Module>,
) -> Option<v8::Local<'s, v8::Module>> {
    // SAFETY: V8 provides this live context to its synchronous module-resolution callback. The
    // callback scope never escapes this invocation, so all locals remain bounded by V8's lifetime.
    v8::callback_scope!(unsafe scope, context);
    let specifier = specifier.to_rust_string_lossy(scope);
    reject_import(scope, &specifier);
    None
}

pub(super) fn dynamic_import_callback<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    _host_defined_options: v8::Local<'s, v8::Data>,
    _resource_name: v8::Local<'s, v8::Value>,
    specifier: v8::Local<'s, v8::String>,
    _import_attributes: v8::Local<'s, v8::FixedArray>,
) -> Option<v8::Local<'s, v8::Promise>> {
    let specifier = specifier.to_rust_string_lossy(scope);
    let resolver = v8::PromiseResolver::new(scope)?;
    let error = v8::String::new(scope, &format!("Unsupported import in exec: {specifier}"))
        .map(Into::into)
        .unwrap_or_else(|| v8::undefined(scope).into());
    resolver.reject(scope, error);
    Some(resolver.get_promise(scope))
}

fn reject_import(scope: &mut v8::PinScope<'_, '_>, specifier: &str) {
    let message = v8::String::new(scope, &format!("Unsupported import in exec: {specifier}"))
        .map(Into::into)
        .unwrap_or_else(|| v8::undefined(scope).into());
    scope.throw_exception(message);
}
