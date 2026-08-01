#![allow(
    linker_messages,
    reason = "MSVC emits localized informational output while creating import libraries"
)]

fn main() {
    codex_desktop_next_lib::run();
}
