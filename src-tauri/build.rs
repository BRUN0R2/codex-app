use std::collections::HashMap;
use std::env;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use sha2::{Digest as _, Sha256};

const RIPGREP_MANIFEST_PATH: &str = "../scripts/ripgrep-manifest.json";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RipgrepManifest {
    schema_version: u32,
    version: String,
    revision: String,
    targets: HashMap<String, RipgrepTarget>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RipgrepTarget {
    architecture: String,
    executable_sha256: String,
}

fn main() {
    prepare_ripgrep_sidecar().unwrap_or_else(|error| {
        panic!("could not prepare the bundled ripgrep executable: {error}");
    });
    tauri_build::build();
}

fn prepare_ripgrep_sidecar() -> Result<(), String> {
    let manifest_directory = PathBuf::from(
        env::var_os("CARGO_MANIFEST_DIR")
            .ok_or_else(|| "CARGO_MANIFEST_DIR is unavailable".to_string())?,
    );
    let target = env::var("TARGET").map_err(|error| format!("TARGET is unavailable: {error}"))?;
    let manifest_path = manifest_directory.join(RIPGREP_MANIFEST_PATH);
    let manifest_bytes = fs::read(&manifest_path).map_err(|error| {
        format!(
            "could not read {}: {error}",
            manifest_path.to_string_lossy()
        )
    })?;
    let manifest: RipgrepManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|error| format!("ripgrep manifest is invalid: {error}"))?;
    if manifest.schema_version != 1 || manifest.version.trim().is_empty() {
        return Err("ripgrep manifest schema or version is invalid".into());
    }
    let definition = manifest
        .targets
        .get(&target)
        .ok_or_else(|| format!("ripgrep does not support Rust target {target}"))?;
    let project_root = manifest_directory
        .parent()
        .ok_or_else(|| "src-tauri has no project parent".to_string())?;
    let source = project_root
        .join(".tools")
        .join("ripgrep")
        .join(&manifest.version)
        .join(&definition.architecture)
        .join("rg.exe");
    let source_bytes = fs::read(&source).map_err(|error| {
        format!(
            "{} is unavailable or unreadable: {error}. Run `pnpm tools:bootstrap` first",
            source.to_string_lossy()
        )
    })?;
    verify_sha256(&source, &source_bytes, &definition.executable_sha256)?;

    let sidecar_directory = manifest_directory.join("binaries");
    let destination = sidecar_directory.join(format!("rg-{target}.exe"));
    fs::create_dir_all(&sidecar_directory).map_err(|error| {
        format!(
            "could not create {}: {error}",
            sidecar_directory.to_string_lossy()
        )
    })?;
    let destination_is_current = fs::read(&destination)
        .ok()
        .is_some_and(|bytes| sha256(&bytes) == definition.executable_sha256);
    if !destination_is_current {
        fs::write(&destination, source_bytes).map_err(|error| {
            format!("could not write {}: {error}", destination.to_string_lossy())
        })?;
    }

    println!("cargo:rerun-if-changed={}", manifest_path.display());
    println!("cargo:rerun-if-changed={}", source.display());
    println!(
        "cargo:rustc-env=CODEX_BUNDLED_RG_VERSION={}",
        manifest.version
    );
    println!(
        "cargo:rustc-env=CODEX_BUNDLED_RG_REVISION={}",
        manifest.revision
    );
    println!(
        "cargo:rustc-env=CODEX_BUNDLED_RG_SHA256={}",
        definition.executable_sha256
    );
    Ok(())
}

fn verify_sha256(path: &Path, bytes: &[u8], expected: &str) -> Result<(), String> {
    let actual = sha256(bytes);
    if actual == expected {
        Ok(())
    } else {
        Err(format!(
            "{} has SHA-256 {actual}, expected {expected}",
            path.to_string_lossy()
        ))
    }
}

fn sha256(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut encoded = String::with_capacity(digest.len() * 2);
    for byte in digest {
        write!(&mut encoded, "{byte:02x}").expect("writing to a String cannot fail");
    }
    encoded
}
