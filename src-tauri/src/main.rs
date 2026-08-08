#![allow(
    linker_messages,
    reason = "MSVC emits localized informational output while creating import libraries"
)]
#![cfg_attr(all(not(debug_assertions), windows), windows_subsystem = "windows")]

fn main() {
    codex_desktop_next_lib::run();
}
