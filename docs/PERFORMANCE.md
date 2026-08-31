# Performance

Scripts are authoritative for scenarios and limits. This document records the
method and latest reproducible gate snapshot; it does not accumulate history.

## Measurement

```powershell
pnpm verify:benchmarks         # UI, stream, and command regressions
pnpm measure:code-mode-warmup # cold V8 runtime cost
pnpm measure:tokens           # catalog, context, and compaction
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

Local sample from 2026-08-30 on Windows with 28 logical processors. These values
describe that run; they are not universal guarantees.

### Context and tools

| Scenario | Result |
| --- | ---: |
| base catalog, 20 tools | 13,977 B; ~3,495 tokens |
| read-only catalog, 16 tools | 9,598 B; ~2,400 tokens |
| read-only catalog reduction | 31.33% |
| catalog build and encode | 0.0227 ms median |
| provider output, 2,439,995 B -> 6,372 B | 99.7389% smaller |
| moderate command, 3,216 B -> 414 B | 87.1269% smaller |
| large command, 6,018 B -> 633 B | 89.4816% smaller |
| history, 232.169 MiB -> 0.957 MiB | 99.588% smaller |
| initial history parse and decode | 311.694x faster |
| initial history heap | 99.576% smaller |
| search in 64 MiB output, 65,536 B -> 110 B | 99.8322% smaller; 57.28 ms |
| eight identical reads | one execution; 87.5% fewer calls |

### Interface and execution

| Scenario | Result |
| --- | ---: |
| batched text streaming | 168.746x the sequential path |
| framed command streaming | 72.594x the sequential path |
| cold Code Mode runtime warm-up | 6.362 ms; one initialization |
| 150,001-line diff | 45 mounted rows; 0.324 ms window |
| incremental 64 MiB terminal | 1,573.479 ms; 40.7 MiB/s |
| command after yield | response in 258 ms; independent work in 486 ms |
| incremental polling | 146 B versus a 16,513 B snapshot |
| four independent commands | 735.12 ms parallel versus 2,880.681 ms sequential |

Visual QA passed at 920x640, 1280x820, and 1920x1080 without horizontal
overflow. Ultra rendered as `rgb(167, 139, 250)` (`#a78bfa`); appearance does
not alter the engine capability gate.

### Complete gate

| Check | Result |
| --- | ---: |
| encoding | 411 valid UTF-8 files |
| frontend | 92 files; 491 passing tests |
| main JavaScript bundle | 449.16 kB; 133.81 kB gzip |
| CSS | 144.93 kB; 25.99 kB gzip |
| Rust | 434 passing; 10 ignored benchmarks; no failures |
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
