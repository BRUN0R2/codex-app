use std::sync::OnceLock;

struct V8Initialization {
    _platform: v8::SharedRef<v8::Platform>,
}

static V8_INITIALIZATION: OnceLock<Result<V8Initialization, String>> = OnceLock::new();

pub(super) fn ensure_v8_initialized() -> Result<(), String> {
    match V8_INITIALIZATION.get_or_init(initialize_v8) {
        Ok(_) => Ok(()),
        Err(error) => Err(error.clone()),
    }
}

fn initialize_v8() -> Result<V8Initialization, String> {
    v8::icu::set_common_data_77(deno_core_icudata::ICU_DATA)
        .map_err(|code| format!("failed to initialize V8 ICU data: {code}"))?;
    let platform = v8::new_default_platform(0, false).make_shared();
    v8::V8::initialize_platform(platform.clone());
    v8::V8::initialize();
    // V8 150 initializes the sandbox-backed ArrayBuffer allocator lazily from the first
    // isolate. That initializer is process-global but is not internally synchronized, so two
    // first-use isolates can both attempt to configure the same PartitionAlloc pool and abort
    // the process. Warm it while this function is still protected by `V8_INITIALIZATION`.
    drop(v8::Isolate::new(v8::CreateParams::default()));
    Ok(V8Initialization {
        _platform: platform,
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn linked_v8_has_sandbox_enabled() {
        unsafe extern "C" {
            fn v8__V8__IsSandboxEnabled() -> bool;
        }

        // SAFETY: rusty_v8 exports this immutable feature probe specifically for verifying the
        // linked artifact. It has no arguments, side effects, or caller-owned memory.
        assert!(
            unsafe { v8__V8__IsSandboxEnabled() },
            "Code Mode must link against sandbox-enabled V8"
        );
    }
}
