use super::TerminalOperation;
use super::TerminalStreamNormalizer;

#[test]
fn preserves_utf8_split_across_input_chunks() {
    let bytes = "ação".as_bytes();
    let mut normalizer = TerminalStreamNormalizer::default();
    let first = normalizer
        .push(&bytes[..2])
        .expect("prefix should normalize");
    let second = normalizer
        .push(&bytes[2..])
        .expect("suffix should normalize");
    let finish = normalizer.finish().expect("stream should finish");

    assert_eq!(render([first, second, finish].concat()), "ação");
}

#[test]
fn strips_escape_sequences_split_across_chunks() {
    let mut normalizer = TerminalStreamNormalizer::default();
    let first = normalizer
        .push(b"\x1b[3")
        .expect("partial escape should normalize");
    let second = normalizer
        .push(b"1mPASS\x1b[0m\n")
        .expect("remaining escape should normalize");

    assert_eq!(render([first, second].concat()), "PASS\n");
}

#[test]
fn exposes_append_clear_and_backspace_operations() {
    let mut normalizer = TerminalStreamNormalizer::default();
    let operations = normalizer
        .push(b"loading 10%\rloading 100%\x08!\n")
        .expect("progress output should normalize");

    assert_eq!(
        operations,
        vec![
            TerminalOperation::Append("loading 10%".into()),
            TerminalOperation::ClearCurrentLine,
            TerminalOperation::Append("loading 100%".into()),
            TerminalOperation::Backspace,
            TerminalOperation::Append("!\n".into()),
        ]
    );
    assert_eq!(render(operations), "loading 100!\n");
}

#[test]
fn rejects_invalid_or_incomplete_utf8() {
    let mut invalid = TerminalStreamNormalizer::default();
    assert!(invalid.push(&[0xff]).is_err());

    let mut incomplete = TerminalStreamNormalizer::default();
    incomplete
        .push(&[0xc3])
        .expect("incomplete prefix should wait for more input");
    assert!(incomplete.finish().is_err());
}

#[test]
#[ignore = "performance benchmark; run through `pnpm measure:command-stream`"]
fn benchmark_incremental_terminal_stream() {
    use std::hint::black_box;
    use std::time::Instant;

    const TARGET_BYTES: usize = 64 * 1_024 * 1_024;
    const SAMPLE_COUNT: usize = 7;
    const WARMUP_COUNT: usize = 2;
    const READ_CHUNK_BYTES: usize = 8 * 1_024;
    const PATTERN: &str = "building 10%\rbuilding 100%\x1b[32m done\x1b[0m\n";

    let input = PATTERN.repeat(TARGET_BYTES.div_ceil(PATTERN.len()));
    let mut durations = Vec::with_capacity(SAMPLE_COUNT);
    let mut expected_checksum = None;
    for sample in 0..SAMPLE_COUNT + WARMUP_COUNT {
        let started_at = Instant::now();
        let mut normalizer = TerminalStreamNormalizer::default();
        let mut visible_bytes = 0usize;
        let mut control_operations = 0usize;
        for chunk in input.as_bytes().chunks(READ_CHUNK_BYTES) {
            for operation in normalizer
                .push(chunk)
                .expect("benchmark input should normalize")
            {
                match operation {
                    TerminalOperation::Append(value) => visible_bytes += value.len(),
                    TerminalOperation::Backspace | TerminalOperation::ClearCurrentLine => {
                        control_operations += 1;
                    }
                }
            }
        }
        for operation in normalizer.finish().expect("benchmark stream should finish") {
            match operation {
                TerminalOperation::Append(value) => visible_bytes += value.len(),
                TerminalOperation::Backspace | TerminalOperation::ClearCurrentLine => {
                    control_operations += 1;
                }
            }
        }
        let checksum = black_box((visible_bytes, control_operations));
        match expected_checksum {
            Some(expected) => assert_eq!(checksum, expected),
            None => expected_checksum = Some(checksum),
        }
        if sample >= WARMUP_COUNT {
            durations.push(started_at.elapsed());
        }
    }
    durations.sort_unstable();
    let median = durations[SAMPLE_COUNT / 2];
    let throughput_mib_per_second = input.len() as f64 / 1_048_576.0 / median.as_secs_f64();

    println!(
        "incremental terminal stream: {:.3} ms median, {:.1} MiB/s, {} input bytes",
        median.as_secs_f64() * 1_000.0,
        throughput_mib_per_second,
        input.len()
    );
}

fn render(operations: Vec<TerminalOperation>) -> String {
    let mut output = String::new();
    for operation in operations {
        match operation {
            TerminalOperation::Append(value) => output.push_str(&value),
            TerminalOperation::Backspace => {
                if let Some(line_start) = output.rfind('\n') {
                    if output.len() > line_start + 1 {
                        output.pop();
                    }
                } else {
                    output.pop();
                }
            }
            TerminalOperation::ClearCurrentLine => {
                output.truncate(output.rfind('\n').map_or(0, |index| index + 1));
            }
        }
    }
    output
}
