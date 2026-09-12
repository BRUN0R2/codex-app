# Performance

Scripts are authoritative for scenarios and limits. This document records the
method and latest reproducible gate snapshot; it does not accumulate history.

## Measurement

```powershell
pnpm verify:benchmarks         # UI, stream, and command regressions
pnpm measure:code-mode-warmup # cold V8 runtime cost
pnpm measure:code-mode-execution # eight concurrent sandboxed cells
pnpm measure:tokens           # catalog, context, and compaction
pnpm measure:credentials      # cold vault versus process-local session cache
pnpm measure:context-window   # confirmed-use preflight and compaction preparation
pnpm measure:response-transport # full versus incremental Responses payload
pnpm measure:multimodal-continuation # image-preserving continuation comparison
pnpm measure:nested-polls     # independent Code Mode waits through the native gate
pnpm measure:patch-preparation # bounded 128-file native patch preparation
pnpm measure:tool-dispatch    # controlled response/tool overlap
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

Controlled command benchmarks explicitly skip PowerShell profiles, preserving
their previous execution conditions. Normal agent commands load profiles by
default; user profile startup work is outside these controlled measurements.

Wire payload bytes and local serialization time are not billable-token or
end-to-end latency measurements. `previous_response_id` avoids retransmitting
known input and lets the provider reuse response state, but only provider usage
telemetry can establish token billing. The runtime therefore keeps the
catalog-selected output verbosity and never truncates an answer merely to make
a benchmark smaller.

### Visual measurement isolation

Each scenario and viewport owns one background browser target, closed through
the browser protocol before the next measurement. Closure runs after success
or failure; simultaneous measurement and cleanup failures are both preserved.

Reusing one target across all 153 cases retained earlier documents in Chromium.
A CPU profile captured 12.816 ms of V8 garbage collection inside a 17.9 ms
timeline callback. Comparing the complete corpus before and after target
isolation recorded these renderer maxima:

| Resource | Reused target | Isolated targets |
| --- | ---: | ---: |
| documents | 107 | 32 |
| DOM nodes | 64,549 | 34,737 |
| event listeners | 1,084 | 86 |
| JavaScript heap | 97,568,944 B | 43,462,216 B |

All 153 isolated cases passed with the same fixtures, motion settings, frame
budgets, and 12 ms maximum application-work limit. These are measurements of
the QA renderer, not application memory savings. Profiling is diagnostic only
and does not run in the verification gate.

The 100,000-file scenario also probes six small overlapping scrolls before
timing rapid motion. Its fixed-height branch previously keyed components by
window position, replacing all 118 retained summaries and wrappers at 920x640.
It now uses the same bounded keyed-slot store as variable-height activities.
The focused regression compared 118, 147, and 192 retained items at the three
viewports with zero replacements. Rapid-scroll timing and identity limits
remain unchanged.

### Expanded timelines

The browser gate covers 100,000 collapsed files and the same 100,000 files with
every detail opened through its real summary control. Each file contains a
two-line diff. A separate 180-item corpus covers mixed commands, tools, and
larger diffs. Expansion setup temporarily grows the viewport to 8,192 pixels
and restores the measured size before timing, exercising release of the peak
render window as well as steady scrolling.

`pnpm measure:disclosure-memory` retains all 100,000 expansion states and caps
their incremental Node heap at 28 MiB. Child indexes are allocated only for
parents: the same corpus fell from 41,041,120 to 22,637,704 bytes (44.8%). Explicit
collection belongs only to this isolated retained-memory benchmark; the browser
gate measures normal collection and frame latency without forcing collection.

Frame-work accounting includes native scroll handlers and animation callbacks;
audit work remains separately visible. Whole-frame intervals and long tasks
protect the complete rendering path. Correctness runs check continuous visible
coverage above the composer, expanded contents, retained element identities,
reversal, resizing, and anchor drift. Each case writes its metrics and screenshot
to `.artifacts/visual-audit` after measurement.

Navigation probes cover existing and live user messages, both motion
preferences, manual cancellation, and one-pixel target accuracy. Fractional
and compressed coordinates also have 100,000-position numerical regressions.

Chat layout regressions exercise empty, wrapped, pasted, restored, and submitted
drafts across the standard viewports, including clearing an expanded draft while
another browser target owns focus and then returning. Dock growth and contraction
must keep the real scroll end, scrollbar range, thumb, and end controls
consistent, including native wheel input, thumb dragging, arrow clicks, and
smooth end navigation.
Closing the final workspace tab must remove the panel and splitter and restore
the conversation width.

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

Measurements use Windows with 28 logical processors. Credential and encoding
baselines date from 2026-08-31; context boundaries and streamed dispatch were
measured on 2026-09-05; the tool catalog and Code Mode were measured on
2026-09-07; the current gate was measured on 2026-09-11. These values describe
local runs.

### Agent startup, continuation, and compaction

Ranges represent two consecutive optimized runs after warm-up. The response
case uses a 3 MiB history and five samples per run. Context rows are the latest
40-sample optimized run over the same history after persisting usage boundaries.

| Scenario | Previous work | Current work | Result |
| --- | ---: | ---: | ---: |
| credential load after the first vault read | 1,461.460-1,485.377 ms | 3.555-4.030 us | 368,580x-411,100x faster |
| confirmed context preflight | 2.227 ms | 0.215 us | 10,358x faster |
| compaction preparation with no rewrite | 4.146 ms | 0.425 us | 9,756x faster |
| compaction request encoding | 3.618-3.707 ms | 0.621-0.631 ms | 5.74x-5.97x faster |
| compaction wire payload | 3,146,213 B | 425 B | 99.98649% smaller |

The credential comparison intentionally includes the real Windows Credential
Manager cold read and compares it with 100 process-local loads. The context
results measure the now-constant fast paths; they do not include SQLite or
provider time. There is no authenticated time-to-first-delta claim in this
snapshot. First-turn work is nevertheless removed from the serial path by
background `generate:false` prewarm, parallel prompt/session preparation, and
connection reuse, with loopback protocol tests guarding the behavior.

### Independent polls and multimodal continuation

Three optimized runs per scenario used the same native contracts. Each poll run
compares five samples of four independent 100 ms waits under the previous
exclusive gate and the current shared gate, with identical cache invalidation.
Each continuation run prepares 40 requests over a 3 MiB image after constructing
the baselines outside the timed region. The previous implementation was measured
before replacing the image-copying comparison.

| Scenario | Previous work | Current work | Result |
| --- | ---: | ---: | ---: |
| four independent Code Mode polls | 426.770-436.840 ms | 107.936-109.631 ms | 3.893x-4.047x faster |
| prepare an incremental image request | 1.471-1.544 ms | 0.412-0.458 ms | 3.21x-3.75x faster |
| compare copied versus borrowed image content, 40 samples | 53.131-54.232 ms | 8.803-9.607 ms | 5.641x-6.161x faster |
| incremental image request payload | 493 B | 493 B | same continuation and content |
| represented large Code Mode results in a 1,000-token budget fixture | 1 of 4 | 4 of 4 | each keeps its own head and tail |

Poll tests exercise the scheduling boundary with deterministic waits, not remote
process execution. Image comparison removes a repeated 3 MiB allocation while
checking the same bytes and policy. These improvements do not alter model,
reasoning effort, service tier, encrypted reasoning, or output verbosity.
Provider time to first delta, actual cache hits, billed tokens, and task quality
still require paired authenticated measurements; see [TODO.md](TODO.md).

The output fixture verifies information coverage within the existing limit;
it does not estimate downstream token savings. Fitting outputs remain exact,
and a large earlier result cannot hide a later small result or script error.

### Multi-file patch preparation

Three before/after runs used the same debug profile, workspace fixture, and
nine samples per run. Each patch updates 128 existing files of roughly 3.5 KiB;
fixture creation and parsing are outside the timer. The previous implementation
was measured before changing preparation or content validation.

| Scenario | Previous median range | Current median range | Result |
| --- | ---: | ---: | ---: |
| prepare 128 file updates | 154.310-162.374 ms | 38.706-39.660 ms | 3.89x-4.20x faster |

One blocking preparation task replaces repeated asynchronous filesystem
dispatch, and exact retained bytes remove redundant hashing. These numbers
measure preparation only, excluding persistence and provider latency. The
release benchmark is reproducible with `pnpm measure:patch-preparation` and
guards a 500 ms median limit in `pnpm verify:benchmarks`. The optimized full-gate
run prepared the same 128 updates in 34.882 ms median; the debug speedup ratio
does not claim an unmeasured release baseline.

Focused tests cover nested directories, moves, append positions, original
context bytes and line endings, size limits, Windows aliases and attributes,
failure at every commit position, cancellation, concurrent changes, and V8 Code
Mode executing a batch followed by a dependent patch. The tool description
includes the complete grouping contract for the nested freeform route.

### Streamed tool dispatch and long turns

`pnpm measure:tool-dispatch` runs five controlled rounds with a 100 ms response
tail and 100 ms of tool work. Deferring execution until the response ended took
1,084 ms total; eager bounded dispatch took 543 ms (2.00x). The gate requires at
least 20% reduction. This measures local overlap, not authenticated provider
latency or model quality.

The stream-state soak completes 100,000 item identities over 10,000 responses.
Only one deliberately live background-command identity remains after each
response, and finishing that command empties the state. Interrupted responses,
channel admission, cancellation, FIFO mutation barriers, and ordered tool-result
recovery have focused native regressions. Live 72-hour qualification remains
separate from these bounded simulations.

### Context and tools

| Scenario | Result |
| --- | ---: |
| base catalog, 20 tools | 15,219 B; ~3,805 tokens |
| read-only catalog, 16 tools | 9,885 B; ~2,472 tokens |
| read-only catalog reduction | 35.05% |
| catalog build and encode | 0.0325 ms median |
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
| batched text streaming | 212.958x the sequential path |
| framed command streaming | 76.848x the sequential path |
| cold Code Mode runtime warm-up, nine fresh processes | 4.012-4.606 ms; 4.299 ms median |
| eight concurrent Code Mode cells, nine fresh processes | 6.159-10.237 ms; 7.804 ms median |
| 150,001-line diff | 45 mounted rows; 0.151 ms visible window |
| incremental 64 MiB terminal | 1,586.538 ms; 40.3 MiB/s |
| command after yield | response in 262 ms; independent work in 532 ms |
| incremental polling | 146 B versus a 16,513 B snapshot |
| four independent commands | 790.152 ms parallel versus 2,989.990 ms sequential |

The Code Mode comparison uses the same release artifact and representative
10,000-iteration modules. An explicit eight-worker V8 pool was rejected: it
raised warm-up from 4.299 to 4.497 ms median and parallel execution from 7.804
to 8.187 ms median. V8's automatic pool remains authoritative; the cold gate is
now 25 ms, and the eight-cell gate is 250 ms so regressions fail verification
without tuning the runtime to this workstation.

Visual QA passed at 920x640, 1280x820, and 1920x1080 without horizontal
overflow. Ultra rendered as `rgb(167, 139, 250)` (`#a78bfa`); appearance does
not alter the engine capability gate.

### Complete gate

| Check | Result |
| --- | ---: |
| encoding | 526 valid UTF-8 files |
| frontend | 118 files; 617 passing tests |
| main JavaScript bundle | 453.74 kB; 134.14 kB gzip |
| CSS | 152.01 kB; 27.10 kB gzip |
| visual QA | 152/153 cases; the 1920x1080 expanded 100k timeline exceeded the P99 frame-work paint guard (13.40 ms vs 12 ms) while application work stayed within contract; the pre-change baseline measured 13.60 ms under the same conditions |
| Rust | 540 passing; 18 ignored checks; no failures |
| Cargo, formatting, and Clippy | passed without warnings |

The extreme expanded timeline isolates each case in a fresh target and treats
application work as the product contract. On the current host, the 1920x1080
case exceeded only the P99 total-frame-work paint guard in both the current
build (13.40 ms) and the pre-change baseline (13.60 ms); application work P99
was 6.70 ms, maximum application work was 8.20 ms, and scrolling produced zero
long tasks. The guard is unchanged and the measurement stays visible.

## Regression protection

| Risk | Protection |
| --- | --- |
| deltas block the UI | batching, worker, and streaming benchmarks |
| history grows with the conversation | pagination, virtualization, and a 100,000-turn soak |
| output fills memory or IPC | spool, cursor, compaction, and a 64 MiB scenario |
| diff mounts the whole document | virtual window and a 150,000-line corpus |
| long commands block the agent | yield, incremental polling, and independent work |
| tools wait for response completion | eager-dispatch regression and controlled overlap benchmark |
| a stream failure loses executed tool results | drain before retry, ordered outputs, and cancellation regression |
| one long turn retains every streamed item ID | 100,000-item lifecycle soak, response cleanup, and explicit admission limits |
| commentary repeatedly rebuilds completed Markdown | browser regression preserves paragraph identity across live deltas |
| multi-file edits require avoidable retries | batch preparation benchmark, transactional failures, and Code Mode integration |
| first `exec` pays cold V8 cost | tracked prewarm, `OnceLock`, and release benchmark |
| first response pays vault, catalog, and socket setup serially | credential cache, startup prewarm, and parallel preparation |
| every tool round resends the complete transcript | strict `previous_response_id` continuation with full-request reset on mismatch |
| compaction clones and re-encodes a confirmed history | borrowed fast path and compaction-trigger-only WebSocket extension |
| WebSocket buffering grows without a limit | 1,024-message and 16 MiB raw-frame budgets plus bounded decoded events |
| a stale startup warmup replaces an active turn | generation-tagged session leases and invalidation tests |
| concurrency changes order | barriers and parallel-command benchmark |
| independent polls serialize inside Code Mode | native shared-gate benchmark and mutation-exclusion tests |
| a transient read failure poisons subsequent attempts | shared failure followed by a fresh successful execution |
| pending, failed, or oversized reads exceed cache bounds | admission, retention, cancellation, and late-completion identity tests |
| a large Code Mode result hides later results or errors | fair bounded output projection with UTF-8 and media regressions |
| Lite image output changes canonical history or defeats continuation | message, function, and custom-output projection and identity tests |
| tools consume unbounded context | catalog budget and `measure:tokens` |
| local estimates compact early | provider-confirmed use plus additions after its durable boundary |
| interrupted output shifts an older context measurement | durable response boundary, transactional migration, restart and fork tests |
| browser degrades layout | viewport matrix, metrics, and WebView2 smoke test |
| messages diverge from composer edges or show through the footer | shared-column bounds plus fade, footer-opacity, and scrollbar pixel checks with normal and expanded drafts |
| refresh rate distorts QA | controlled identity probe separate from fast scrolling |
| fixed-height scrolling replaces retained file components | overlapping-scroll identity probe over 100,000 files and shared keyed slots |
| previous visual cases contaminate later measurements | one scoped browser target per case with confirmed cleanup and failure tests |
| processes escape a turn | Windows tests with Job Object and a real descendant |
| long-lived launch environments hide newly installed tools | fresh registered Windows paths, preserved child overrides, and native executable lookup tests |
| partial PowerShell output is mistaken for success or an automatic retry | real process/file failures, explicit exit codes, stderr-on-success, and single-execution coverage |
| translations diverge | exact catalog and placeholder validation tests |

Thresholds live in scripts so documentation and gates cannot diverge. Changing a
scenario requires updating its test, justifying its limit, and replacing this
snapshot after a complete `pnpm verify`.
