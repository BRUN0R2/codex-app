use std::collections::HashSet;
use std::ffi::{OsStr, OsString};
use std::io;
use std::os::windows::ffi::{OsStrExt as _, OsStringExt as _};
use std::os::windows::io::{AsRawHandle as _, FromRawHandle as _, OwnedHandle};
use std::path::{Path, PathBuf};

use windows::Win32::Foundation::HANDLE;
use windows::Win32::Security::{TOKEN_DUPLICATE, TOKEN_QUERY};
use windows::Win32::System::Environment::{CreateEnvironmentBlock, DestroyEnvironmentBlock};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

const MAX_ENVIRONMENT_UNITS: usize = 1_048_576;
const MAX_PATH_UNITS: usize = 32_767;

/// Preserve launch-specific tools and append current registered paths. Refresh
/// for every command so installers can add tools while the desktop stays open.
pub(super) fn child_path(inherited: Option<OsString>) -> io::Result<OsString> {
    merge_paths(inherited.as_deref(), registered_path()?.as_deref())
}

fn registered_path() -> io::Result<Option<OsString>> {
    let mut raw_token = HANDLE::default();
    // SAFETY: the pseudo process handle is valid and the output points to an
    // initialized handle. The successful token is owned and closed below.
    unsafe {
        OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_QUERY | TOKEN_DUPLICATE,
            &mut raw_token,
        )
    }
    .map_err(|error| {
        io::Error::other(format!("could not open command environment token: {error}"))
    })?;
    // SAFETY: OpenProcessToken returned a new handle with unique ownership.
    let token = unsafe { OwnedHandle::from_raw_handle(raw_token.0) };
    let mut environment = std::ptr::null_mut();
    // SAFETY: the token remains live, the output pointer is writable, and false
    // requests the current registered environment instead of the stale parent.
    unsafe { CreateEnvironmentBlock(&mut environment, Some(HANDLE(token.as_raw_handle())), false) }
        .map_err(|error| {
            io::Error::other(format!(
                "could not load registered command environment: {error}"
            ))
        })?;
    // SAFETY: the Windows-owned block consists of terminated UTF-16 entries and
    // stays allocated throughout the bounded read. Both success and read errors
    // pass through DestroyEnvironmentBlock before returning.
    let path = unsafe { read_registered_path(environment.cast()) };
    // SAFETY: CreateEnvironmentBlock allocated this exact block. This is its
    // only release, performed after the last borrowed read.
    let released = unsafe { DestroyEnvironmentBlock(environment) };
    if let Err(error) = released {
        return Err(io::Error::other(format!(
            "could not release registered command environment: {error}; path read error: {:?}",
            path.err()
        )));
    }
    path
}

unsafe fn read_registered_path(block: *const u16) -> io::Result<Option<OsString>> {
    if block.is_null() {
        return Err(io::Error::other(
            "Windows returned an empty environment pointer",
        ));
    }
    let mut start = 0;
    for offset in 0..MAX_ENVIRONMENT_UNITS {
        // SAFETY: the caller supplies a live, double-null-terminated Windows
        // environment block. Reading stops at that terminator or the budget.
        if unsafe { *block.add(offset) } != 0 {
            continue;
        }
        if start == offset {
            return Ok(None);
        }
        // SAFETY: this entry ends at the null just observed within the live block.
        let entry = unsafe { std::slice::from_raw_parts(block.add(start), offset - start) };
        if entry.len() >= 5
            && entry[..5]
                .iter()
                .copied()
                .map(ascii_lower)
                .eq("PATH=".encode_utf16().map(ascii_lower))
        {
            return Ok(Some(OsString::from_wide(&entry[5..])));
        }
        start = offset + 1;
    }
    Err(io::Error::other(
        "registered command environment exceeds its size limit",
    ))
}

fn merge_paths(inherited: Option<&OsStr>, registered: Option<&OsStr>) -> io::Result<OsString> {
    let mut seen = HashSet::new();
    let mut paths = Vec::new();
    for source in [inherited, registered].into_iter().flatten() {
        for entry in std::env::split_paths(source) {
            if !entry.as_os_str().is_empty() && seen.insert(path_key(&entry)) {
                paths.push(entry);
            }
        }
    }
    let path = std::env::join_paths(paths).map_err(|error| {
        io::Error::other(format!("command PATH could not be constructed: {error}"))
    })?;
    if path.encode_wide().count() > MAX_PATH_UNITS {
        return Err(io::Error::other(
            "command PATH exceeds the Windows size limit",
        ));
    }
    Ok(path)
}

fn path_key(path: &Path) -> Vec<u16> {
    path.components()
        .collect::<PathBuf>()
        .as_os_str()
        .encode_wide()
        .map(|unit| {
            if unit == u16::from(b'/') {
                u16::from(b'\\')
            } else {
                ascii_lower(unit)
            }
        })
        .collect()
}

fn ascii_lower(unit: u16) -> u16 {
    if (u16::from(b'A')..=u16::from(b'Z')).contains(&unit) {
        unit + 32
    } else {
        unit
    }
}

#[cfg(test)]
mod tests;
