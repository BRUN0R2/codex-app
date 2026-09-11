use super::*;
use crate::process::headless_command;

#[test]
fn registered_tools_join_launch_overrides_without_duplicate_paths() {
    let inherited = OsStr::new(r"C:\Launch Tools;C:\Windows\System32\;C:\ação");
    let registered =
        OsStr::new(r"c:/windows/system32;C:\Program Files\Git\cmd;C:\Rust\bin;;C:\ação");
    let merged = merge_paths(Some(inherited), Some(registered)).expect("paths should compose");
    assert_eq!(
        std::env::split_paths(&merged).collect::<Vec<_>>(),
        [
            r"C:\Launch Tools",
            r"C:\Windows\System32\",
            r"C:\ação",
            r"C:\Program Files\Git\cmd",
            r"C:\Rust\bin"
        ]
        .map(PathBuf::from)
    );
    assert_ne!(path_key(Path::new(r"C:")), path_key(Path::new(r"C:\")));
}

#[test]
fn fresh_snapshots_do_not_accumulate_previously_registered_tools() {
    let inherited = OsStr::new(r"C:\Launch Tools");
    for generation in 0..1_000 {
        let registered = OsString::from(format!(r"C:\Tool Versions\{generation}"));
        let merged =
            merge_paths(Some(inherited), Some(&registered)).expect("new path should compose");
        assert_eq!(std::env::split_paths(&merged).count(), 2);
        assert!(merged.to_string_lossy().ends_with(&generation.to_string()));
    }
}

#[test]
fn path_values_preserve_utf16_and_fail_before_exceeding_windows_limits() {
    let block = "USERPROFILE=C:\\ação\0Path=C:\\ação;C:\\tools\0\0"
        .encode_utf16()
        .collect::<Vec<_>>();
    // SAFETY: the fixture is a live, double-null-terminated UTF-16 block.
    let value = unsafe { read_registered_path(block.as_ptr()) }.expect("path should decode");
    assert_eq!(value, Some(OsString::from(r"C:\ação;C:\tools")));
    let missing = "OTHER=value\0\0".encode_utf16().collect::<Vec<_>>();
    // SAFETY: the fixture is a live, double-null-terminated UTF-16 block.
    assert!(
        unsafe { read_registered_path(missing.as_ptr()) }
            .expect("block should decode")
            .is_none()
    );
    let mut oversized = vec![u16::from(b'x'); MAX_ENVIRONMENT_UNITS];
    oversized.extend([0, 0]);
    // SAFETY: the complete fixture is allocated, including both terminators.
    assert!(unsafe { read_registered_path(oversized.as_ptr()) }.is_err());
    assert!(merge_paths(Some(&OsString::from("x".repeat(MAX_PATH_UNITS + 1))), None).is_err());
}

#[tokio::test]
async fn a_child_with_stale_path_resolves_registered_system_executables() {
    let inherited = OsString::from(r"C:\CodexEnvironmentTest\Missing");
    let path = child_path(Some(inherited)).expect("current registered PATH should load");
    let mut command = headless_command("where.exe");
    let output = command
        .env("PATH", path)
        .arg("cmd.exe")
        .output()
        .await
        .expect("registered executable should start");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        String::from_utf8_lossy(&output.stdout)
            .to_ascii_lowercase()
            .contains("cmd.exe")
    );
}

#[tokio::test]
async fn newly_registered_tool_directory_is_available_to_native_children() {
    let directory = tempfile::tempdir().expect("tool fixture should exist");
    let installed = directory.path().join("newly-installed-tool.exe");
    let registered = registered_path()
        .expect("registered path should load")
        .expect("Windows has a PATH");
    let source = std::env::split_paths(&registered)
        .map(|directory| directory.join("where.exe"))
        .find(|candidate| candidate.is_file())
        .expect("where.exe should be installed in Windows");
    std::fs::copy(source, &installed).expect("isolated native tool should be created");
    let fresh = std::env::join_paths([directory.path()]).expect("path should encode");
    let path = merge_paths(Some(OsStr::new(r"C:\MissingInheritedTools")), Some(&fresh))
        .expect("fresh installed directory should compose");
    let output = headless_command("newly-installed-tool.exe")
        .env("PATH", path)
        .arg("newly-installed-tool.exe")
        .output()
        .await
        .expect("new native tool should resolve without restarting the parent");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("newly-installed-tool.exe"));
}
