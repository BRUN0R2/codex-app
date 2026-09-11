use std::time::{Duration, Instant};

use tempfile::TempDir;
use tokio::sync::watch;

use super::parser::parse_patch;
use super::plan::{PreparedChange, prepare_patch};
use super::transaction::commit_patch;

#[tokio::test]
async fn additions_without_old_lines_append_to_the_file() {
    let workspace = TempDir::new().expect("workspace should exist");
    std::fs::write(workspace.path().join("source.txt"), "first\nlast\n")
        .expect("source should exist");
    let parsed =
        parse_patch("*** Begin Patch\n*** Update File: source.txt\n@@\n+appended\n*** End Patch")
            .expect("append should parse");
    let prepared = prepare_patch(workspace.path(), parsed)
        .await
        .expect("append should prepare");
    let PreparedChange::Write { final_bytes, .. } = &prepared.changes[0] else {
        panic!("expected write");
    };
    assert_eq!(final_bytes, b"first\nlast\nappended\n");
}

#[tokio::test]
async fn one_patch_creates_nested_directories_and_moves_files() {
    let workspace = TempDir::new().expect("workspace should exist");
    std::fs::write(workspace.path().join("source.txt"), "old\n").expect("source should exist");
    let parsed = parse_patch(
        "*** Begin Patch\n*** Add File: new/deep/first.txt\n+first\n*** Add File: new/deep/second.txt\n+second\n*** Update File: source.txt\n*** Move to: new/moved/source.txt\n@@\n-old\n+updated\n*** End Patch",
    )
    .expect("batch should parse");
    let prepared = prepare_patch(workspace.path(), parsed)
        .await
        .expect("new directories should prepare without writes");
    assert!(!workspace.path().join("new").exists());
    let (_sender, mut cancellation) = watch::channel(false);
    let outcome = commit_patch(prepared, &mut cancellation)
        .await
        .expect("batch should commit");
    assert_eq!(outcome.changes.len(), 3);
    for (path, expected) in [
        ("new/deep/first.txt", "first\n"),
        ("new/deep/second.txt", "second\n"),
        ("new/moved/source.txt", "updated\n"),
    ] {
        assert_eq!(
            std::fs::read_to_string(workspace.path().join(path)).expect("file should exist"),
            expected
        );
    }
    assert!(!workspace.path().join("source.txt").exists());
}

#[tokio::test]
async fn invalid_later_hunk_does_not_create_directories_or_change_earlier_files() {
    let workspace = TempDir::new().expect("workspace should exist");
    std::fs::write(workspace.path().join("source.txt"), "old\n").expect("source should exist");
    let patch = "*** Begin Patch\n*** Add File: new/deep/added.txt\n+added\n*** Update File: source.txt\n@@\n-missing\n+new\n*** End Patch";
    assert!(
        prepare_patch(
            workspace.path(),
            parse_patch(patch).expect("patch should parse")
        )
        .await
        .is_err()
    );
    assert!(!workspace.path().join("new").exists());
    assert_eq!(
        std::fs::read_to_string(workspace.path().join("source.txt")).expect("source should remain"),
        "old\n"
    );
}

#[tokio::test]
async fn normalized_aliases_and_file_parent_collisions_are_rejected_before_staging() {
    let workspace = TempDir::new().expect("workspace should exist");
    for (first, second) in [
        ("new/file.txt", "new/./file.txt"),
        ("new", "new/file.txt"),
        ("new//file.txt", "new/file.txt"),
    ] {
        let patch = format!(
            "*** Begin Patch\n*** Add File: {first}\n+one\n*** Add File: {second}\n+two\n*** End Patch"
        );
        assert!(
            prepare_patch(
                workspace.path(),
                parse_patch(&patch).expect("patch should parse")
            )
            .await
            .is_err()
        );
        assert_eq!(
            std::fs::read_dir(workspace.path())
                .expect("workspace should list")
                .count(),
            0
        );
    }
}

#[tokio::test]
async fn file_and_batch_content_limits_fail_before_writes() {
    let workspace = TempDir::new().expect("workspace should exist");
    let path = workspace.path().join("large.txt");
    let file = std::fs::File::create(&path).expect("source should exist");
    file.set_len(super::MAX_PATCH_FILE_BYTES as u64 + 1)
        .expect("sparse file should grow");
    let patch = parse_patch("*** Begin Patch\n*** Delete File: large.txt\n*** End Patch")
        .expect("delete should parse");
    assert!(
        prepare_patch(workspace.path(), patch)
            .await
            .expect_err("oversized source should fail")
            .to_string()
            .contains("content limit")
    );
    assert!(path.exists());
    drop(file);

    let mut patch = String::from("*** Begin Patch\n");
    let file_count = super::MAX_PATCH_TOTAL_BYTES / super::MAX_PATCH_FILE_BYTES + 1;
    for index in 0..file_count {
        let file = std::fs::File::create(workspace.path().join(format!("bounded-{index}.txt")))
            .expect("source should exist");
        file.set_len(super::MAX_PATCH_FILE_BYTES as u64)
            .expect("bounded sparse file should grow");
        patch.push_str(&format!("*** Delete File: bounded-{index}.txt\n"));
    }
    patch.push_str("*** End Patch");
    assert!(
        prepare_patch(
            workspace.path(),
            parse_patch(&patch).expect("batch should parse")
        )
        .await
        .expect_err("aggregate limit should fail")
        .to_string()
        .contains("content limit")
    );
    assert_eq!(
        std::fs::read_dir(workspace.path())
            .expect("workspace should list")
            .count(),
        file_count + 1
    );
}

#[test]
fn file_hunk_limit_accepts_the_boundary_and_rejects_one_more() {
    let mut patch = String::from("*** Begin Patch\n");
    for index in 0..super::MAX_PATCH_FILES {
        patch.push_str(&format!("*** Add File: file-{index}.txt\n+content\n"));
    }
    assert_eq!(
        parse_patch(&format!("{patch}*** End Patch"))
            .expect("boundary should parse")
            .hunks
            .len(),
        super::MAX_PATCH_FILES
    );
    patch.push_str("*** Add File: extra.txt\n+extra\n*** End Patch");
    assert!(
        parse_patch(&patch)
            .expect_err("excess file should fail")
            .to_string()
            .contains("file hunks")
    );
}

#[cfg(windows)]
#[tokio::test]
async fn windows_aliases_and_alternate_streams_are_rejected() {
    let workspace = TempDir::new().expect("workspace should exist");
    for path in [
        "source.txt:stream",
        "new./file.txt",
        "new /file.txt",
        "CON",
        "aux.txt",
        "COM1/file.txt",
    ] {
        let patch = format!("*** Begin Patch\n*** Add File: {path}\n+content\n*** End Patch");
        assert!(
            prepare_patch(
                workspace.path(),
                parse_patch(&patch).expect("patch should parse")
            )
            .await
            .is_err(),
            "{path}"
        );
    }
    assert_eq!(
        std::fs::read_dir(workspace.path())
            .expect("workspace should list")
            .count(),
        0
    );
}

#[tokio::test]
#[ignore = "manual filesystem preparation benchmark"]
async fn benchmark_multi_file_patch_preparation() {
    const FILE_COUNT: usize = 128;
    const SAMPLES: usize = 9;
    let workspace = TempDir::new().expect("workspace should exist");
    let mut patch = String::from("*** Begin Patch\n");
    for index in 0..FILE_COUNT {
        std::fs::write(
            workspace.path().join(format!("file-{index}.txt")),
            format!("{}\nold\n", "context".repeat(512)),
        )
        .expect("source should exist");
        patch.push_str(&format!(
            "*** Update File: file-{index}.txt\n@@\n-old\n+new\n"
        ));
    }
    patch.push_str("*** End Patch");
    let mut elapsed = Vec::with_capacity(SAMPLES);
    for _ in 0..SAMPLES {
        let parsed = parse_patch(&patch).expect("patch should parse");
        let started = Instant::now();
        let prepared = prepare_patch(workspace.path(), parsed)
            .await
            .expect("batch should prepare");
        elapsed.push(started.elapsed());
        assert_eq!(prepared.changes.len(), FILE_COUNT);
        for change in &prepared.changes {
            let PreparedChange::Write { final_bytes, .. } = change else {
                panic!("expected prepared update");
            };
            assert!(final_bytes.ends_with(b"\nnew\n"));
        }
    }
    elapsed.sort_unstable();
    let median = elapsed[SAMPLES / 2];
    let profile = if cfg!(debug_assertions) {
        "debug"
    } else {
        "release"
    };
    println!(
        "multi_file_patch_preparation profile={profile} files={FILE_COUNT} samples={SAMPLES} median_ms={:.3}",
        median.as_secs_f64() * 1_000.0
    );
    assert!(
        median < Duration::from_millis(500),
        "128-file patch preparation exceeded 500 ms: {median:?}"
    );
}
