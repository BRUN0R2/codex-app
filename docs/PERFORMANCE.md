# Performance

Scripts are authoritative for scenarios and limits. This document records the
method and latest reproducible gate snapshot; it does not accumulate history.

## Measurement

```powershell
pnpm verify:benchmarks         # UI, stream, and command regressions
pnpm measure:code-mode-warmup # cold V8 runtime cost
pnpm measure:tokens           # catalog, context, and compaction
pnpm measure:credentials      # cold vault versus process-local session cache
pnpm measure:context-window   # confirmed-use preflight and compaction preparation
pnpm measure:response-transport # full versus incremental Responses payload
pnpm measure:release          # release startup and memory
pnpm measure:browser          # Browser Use metrics
```

Use a release build, an idle machine, and identical hardware. Record operating
system, model, effort, service tier, and network when a provider is involved.
Never compare different conditions or treat a functional smoke test as a
benchmark.

`measure:release` opens the selected executable, measures the first responsive
window, waits for stabilization, records working set and private memory, and
closes that same instance normally. It never terminates another process to
produce a sample.

Time to first delta requires a controlled authenticated task. An error, rate
limit, or total request duration is not a substitute.

Wire payload bytes and local serialization time are not billable-token or
end-to-end latency measurements. `previous_response_id` avoids retransmitting
known input and lets the provider reuse response state, but only provider usage
telemetry can establish token billing. The runtime therefore keeps the
catalog-selected output verbosity and never truncates an answer merely to make
a benchmark smaller.

## Solid transform analysis

The reported message

```text
[PLUGIN_TIMINGS] ... solid transform ... 157 calls
```

is Rolldown's aggregate time for the stable `vite-plugin-solid` transform hook.
It is not evidence that 157 application modules were compiled by Babel. A local
instrumented run on 2026-08-30 observed 157 hook callbacks but only 35 actual
TSX/Babel transforms. The callbacks totaled about 1.47 seconds; the largest
individual modules were the timeline, application entry, settings, icon,
composer, and sidebar. Instrumentation was removed after measurement.

An explicit TSX-only `include` produced no material improvement because it still
filtered inside the JavaScript callback. The production and test configurations
now wrap the plugin with Vite's native `withFilter` hook filter. Rolldown rejects
non-JSX module identifiers before crossing the plugin boundary, while the
plugin retains its own authoritative checks.

The first measured build after this change transformed 161 modules but invoked
the Solid hook only 36 times, down from 157. Solid took 1.7 seconds; the same
cold run spent 1.6 seconds in the single CSS transform. Two immediately repeated
builds completed in 2.15 and 2.12 seconds without a timing warning. This confirms
that the original call count was callback fan-out and that the remaining cold
cost is actual compiler and CSS initialization, not duplicate Solid transforms.

Splitting components would not reduce the total Solid AST and would add
boundaries without a measured runtime benefit. Suppressing Rolldown's warning
would hide evidence rather than reduce work. The stable Solid 1 toolchain still
uses the Babel-based compiler. Its OXC replacement belongs to the Solid 2
integration, which remains prerelease in the currently audited dependency
graph. The project will not replace a stable compiler with a prerelease solely
to remove a timing warning. The migration criterion is tracked in
[TODO.md](TODO.md).

Recheck this diagnosis whenever Solid, the Vite plugin, or Rolldown changes.
Compare at least three clean production builds on the same idle machine, inspect
actual compiler invocations, and keep the warning enabled.

## Current baseline

Local sample from 2026-08-31 on Windows with 28 logical processors. These values
describe that run; they are not universal guarantees.

### Agent startup, continuation, and compaction

Each range is two consecutive optimized runs after warm-up. The response case
uses a 3 MiB history and five samples per run; context cases use the same history
and 40 samples per run.

| Scenario | Previous work | Current work | Result |
| --- | ---: | ---: | ---: |
| credential load after the first vault read | 1,461.460-1,485.377 ms | 3.555-4.030 us | 368,580x-411,100x faster |
| confirmed context preflight | 2.205-2.207 ms | 0.170-0.173 us | 12,781x-12,983x faster |
| compaction preparation with no rewrite | 3.986-4.035 ms | 0.120-0.130 us | 31,037x-33,213x faster |
| compaction request encoding | 3.618-3.707 ms | 0.621-0.631 ms | 5.74x-5.97x faster |
| compaction wire payload | 3,146,213 B | 425 B | 99.98649% smaller |

The credential comparison intentionally includes the real Windows Credential
Manager cold read and compares it with 100 process-local loads. The context
results measure the now-constant fast paths; they do not include SQLite or
provider time. There is no authenticated time-to-first-delta claim in this
snapshot. First-turn work is nevertheless removed from the serial path by
background `generate:false` prewarm, parallel prompt/session preparation, and
connection reuse, with loopback protocol tests guarding the behavior.

### Context and tools

| Scenario | Result |
| --- | ---: |
| base catalog, 20 tools | 14,264 B; ~3,566 tokens |
| read-only catalog, 16 tools | 9,885 B; ~2,472 tokens |
| read-only catalog reduction | 30.70% |
| catalog build and encode | 0.023 ms median |
| provider output, 2,439,995 B -> 6,372 B | 99.7389% smaller |
| moderate command, 3,216 B -> 414 B | 87.1269% smaller |
| large command, 6,018 B -> 633 B | 89.4816% smaller |
| history, 232.169 MiB -> 0.957 MiB | 99.588% smaller |
| initial history parse and decode | 319.355x faster |
| initial history heap | 99.576% smaller |
| search in 64 MiB output, 65,536 B -> 110 B | 99.8322% smaller; 56.259 ms |
| eight identical reads | one execution; 87.5% fewer calls; 1.506x faster |

### Interface and execution

| Scenario | Result |
| --- | ---: |
| batched text streaming | 199x the sequential path |
| framed command streaming | 71.129x the sequential path |
| cold Code Mode runtime warm-up | 5.546 ms; one initialization |
| 150,001-line diff | 45 mounted rows; 0.263 ms visible window |
| incremental 64 MiB terminal | 1,360.816 ms; 47.0 MiB/s |
| command after yield | response in 258 ms; independent work in 445 ms |
| incremental polling | 146 B versus a 165,133 B snapshot |
| four independent commands | 698.987 ms parallel versus 2,715.103 ms sequential |

Visual QA passed at 920x640, 1280x820, and 1920x1080 without horizontal
overflow. Ultra rendered as `rgb(167, 139, 250)` (`#a78bfa`); appearance does
not alter the engine capability gate.

### Complete gate

| Check | Result |
| --- | ---: |
| encoding | 412 valid UTF-8 files |
| frontend | 92 files; 491 passing tests |
| main JavaScript bundle | 449.16 kB; 133.81 kB gzip |
| CSS | 144.93 kB; 25.99 kB gzip |
| Rust | 454 passing; 13 ignored benchmarks; no failures |
| Cargo, formatting, and Clippy | passed without warnings |

## Regression protection

| Risk | Protection |
| --- | --- |
| deltas block the UI | batching, worker, and streaming benchmarks |
| history grows with the conversation | pagination, virtualization, and a 100,000-turn soak |
| output fills memory or IPC | spool, cursor, compaction, and a 64 MiB scenario |
| diff mounts the whole document | virtual window and a 150,000-line corpus |
| long commands block the agent | yield, incremental polling, and independent work |
| first `exec` pays cold V8 cost | tracked prewarm, `OnceLock`, and release benchmark |
| first response pays vault, catalog, and socket setup serially | credential cache, startup prewarm, and parallel preparation |
| every tool round resends the complete transcript | strict `previous_response_id` continuation with full-request reset on mismatch |
| compaction clones and re-encodes a confirmed history | borrowed fast path and compaction-trigger-only WebSocket extension |
| WebSocket buffering grows without a limit | 1,024-message and 16 MiB raw-frame budgets plus bounded decoded events |
| a stale startup warmup replaces an active turn | generation-tagged session leases and invalidation tests |
| concurrency changes order | barriers and parallel-command benchmark |
| tools consume unbounded context | catalog budget and `measure:tokens` |
| local estimates compact early | provider-confirmed use plus post-model delta only |
| browser degrades layout | viewport matrix, metrics, and WebView2 smoke test |
| refresh rate distorts QA | controlled identity probe separate from fast scrolling |
| processes escape a turn | Windows tests with Job Object and a real descendant |
| translations diverge | exact catalog and placeholder validation tests |

Thresholds live in scripts so documentation and gates cannot diverge. Changing a
scenario requires updating its test, justifying its limit, and replacing this
snapshot after a complete `pnpm verify`.
