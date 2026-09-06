# Official Codex reference

This document records only upstream conclusions that affect this product. The
local implementation remains independent.

## Audited snapshot

| Source | Version |
| --- | --- |
| [`openai/codex`](https://github.com/openai/codex/tree/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a) | stable `rust-v0.153.4`, audited 2026-09-05 |
| audited source commit | `3d2ee51ca2d5db578f328aa75e20aa22c0197c9a` |
| additional core inspection | `d4dc882998ddf7f3d2b40893ef2f77a5fdfa5715`, audited 2026-09-05 |
| Codex Desktop for Windows | installed package `26.901.5280.0`, inspected 2026-09-05 |
| Desktop conversation and diff presentation | installed package `26.901.6511.0`, inspected 2026-09-06 |

Study checkouts live outside the build, including `.references/openai-codex`.
No referenced crate, package, executable, database, configuration, or credential
enters the local build or runtime.

Desktop conclusions cover the installed JavaScript bundles, documented product
behavior, and public core and app-server contracts. Bundle inspection includes
developer-instruction composition and feature-specific app context; it does not
constitute access to the private Desktop source repository.

The local catalog's `client_version` remains `0.153.2`, its explicit protocol
compatibility version. Auditing a newer release does not change that contract.

## Upstream topology

The CLI, extension, and Desktop share the open core and `app-server` protocol.
The audited Windows Desktop started:

```text
codex.exe -c features.code_mode_host=true app-server --analytics-default-enabled
└─ codex-code-mode-host.exe
```

Desktop does not use the interactive CLI flow, but it uses the same harness for
the agent loop, context, tools, sandbox, approvals, streaming, and continuity.
This project reproduces required contracts in `NativeEngine` without executing
those binaries.

Official references:

- [repository and core](https://github.com/openai/codex);
- [app-server](https://learn.chatgpt.com/docs/app-server);
- [Codex as a platform](https://learn.chatgpt.com/blog/codex-as-a-platform);
- [Browser Use](https://learn.chatgpt.com/docs/browser);
- [Windows application](https://learn.chatgpt.com/docs/windows/windows-app).

## Adopted conclusions

| Area | Confirmed behavior | Local decision |
| --- | --- | --- |
| OAuth | PKCE, local callback, exchange, refresh, and revocation | Independent Rust implementation and isolated vault |
| models | Authoritative capability catalog | Closed parser; UI never infers capability from model name |
| Responses | Standard, Lite, WebSocket/SSE, typed items, prewarm, and incremental continuation | Persistent native transport with strict full-request recovery |
| response metadata | `codex.response.metadata` is a WebSocket control frame | Response-local typed state for model, catalog ETag, and safety treatment |
| rate limits | `codex.rate_limits` is a typed sparse stream update | Validated account notification with non-destructive merge |
| history | Every tool call has exactly one output | Transactional normalization and repair |
| instructions | Catalog template plus factual runtime context | Bounded layers without a duplicate universal prompt |
| cache | Short in-memory catalog cache with ETag invalidation | Five-minute TTL and no persistence |
| context | Confirmed use plus local delta and stable Remote Compaction V2 | Dynamic budget, incremental trigger, and atomic checkpoint |
| commands | Yield, registered sessions, polling, and incremental output | Independent manager with Windows Job Objects |
| parallelism | Dispatch starts when each tool call completes in the stream | Eight concurrent tools, FIFO mutation barriers, ordered durable outputs |
| patch | Freeform tool with a dedicated parser | Local Lark grammar and transactional commit |
| images | Multimodal inspection is a native tool activity | Local `view_image`, thumbnail, and viewer |
| browser | Visible surface, closed actions, and origin approval | Engine-controlled child WebView2 |
| Code Mode | Isolated V8, manifest, callbacks, yield, and cancellation | Independent Rust runtime and bridge |
| multi-agent v2 | Typed tree, mailbox, and lifecycle | Transactional persistence and six direct tools |

Upstream has no single parallel-command maximum equivalent to the local limit;
scheduling depends on handlers and barriers. Its Unified Exec manager accepts up
to 64 processes. This project admits 128 tool calls per response, executes up to
eight concurrently, and limits its process registry to 32 sessions. These limits
are intentional and tested.

The upstream `tools/parallel.rs` spawns dispatch eagerly when the call is
decoded, even though its result is queued in `FuturesOrdered`. The sampling loop
drains those futures before returning a stream error. Native execution follows
that lifecycle, retaining canonical call/output order for incremental Responses
and preserving completed effects across reconnects.

## Astra and multi-file patches

The audited [`apply_patch` grammar](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/assets/tools/apply_patch.lark)
already accepts multiple file hunks in one envelope. The
[`handler`](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/tools/handlers/apply_patch.rs)
retains the executor's default exclusive scheduling. Multi-file editing does
not require concurrent, unordered mutations or a model-name switch.

The native tool and its Code Mode declaration share one description that
explains grouping files, creating parent directories, moving files, appending,
and awaiting dependent edits. A V8 integration test runs a multi-file patch and
a dependent patch in one cell. Preparation validates the whole batch before
commit; failure reverses only recorded effects and removes directories created
by that transaction. Rollback reports integrity conflicts and preserves newer
concurrent content instead of replacing it with a stale snapshot.

[GPT-6 Astra's async tool calling](https://developers.openai.com/api/docs/guides/async-tool-calling)
is a distinct Responses capability for direct function/custom calls, with
pending call IDs and later outputs. The documented compatibility explicitly
excludes programmatic tool calling. The catalog-selected Code Mode/Lite route
therefore keeps its existing `exec`/`wait` lifecycle; it does not attach an
unsupported `async` flag to nested patches. The public API's built-in
[`apply_patch_call`](https://developers.openai.com/api/docs/guides/tools-apply-patch)
format is separate from the freeform tool used by the audited Codex harness.

## Instructions, transport, and context

The upstream instruction flow is layered:

1. the server supplies `model_messages.instructions_template` and capabilities;
2. the client adds user, repository, permission, collaboration, workspace,
   shell, date, and timezone context;
3. each layer reaches the provider with its own role and size limit.

The core retains local text for roles, modes, tools, permissions, and runtime
context that the server cannot know. Catalog data may replace or suppress some
of it. Local instructions are necessary but must not duplicate personality or
protocol already supplied by `instructions_template`.

Inspected Astra and Sol templates already contain progress-message and
persistence instructions. Desktop additionally composes context for supported
app features; there is no evidence here for adding another universal agent
prompt. The native defaults cover execution mode and actual permission behavior.
Catalog sections override them individually, while explicit empty sections
suppress them. A missing personality variable does not invent a local style.

The native timeline carries the provider's commentary/final-answer distinction
through both item lifecycle and incremental Markdown rendering. A completed
response with no tool calls or pending input ends the turn; commentary alone
does not trigger a fabricated user message or an extra sampling round.

Responses Lite preserves semantics over a different wire shape:
`additional_tools`, a `functions` namespace, and base instructions encoded as
a developer message with stable IDs. Model capability selects the contract
before the request; a failed request never triggers a protocol fallback.

The [upstream request projection](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/client_common.rs)
removes image `detail` from messages and both function and custom tool outputs
for Lite. The native projection follows all three paths, including Code Mode
screenshots, while preserving canonical image bytes and detail. Continuation
compares the same wire semantics by borrowing those bytes instead of cloning
each image for every round. Changed text, audio, images, call identity, or
request policy still invalidates reuse.

The audited Desktop resolves an absent `model_reasoning_summary` preference to
`auto`, even though current model metadata commonly publishes `none` as the Core
default. The local native client applies that same explicit product preference
only when the catalog advertises parameter support.

The current official client opens Responses WebSocket with the
`responses_websockets=2026-02-06` beta contract, optionally sends a
`response.create` with `generate:false`, and continues with
`previous_response_id` plus only new input. The local transport implements the
same sequence over the existing authenticated `reqwest` client so TLS, proxy,
cookies, headers, and revocation remain one boundary. A valid HTTP 426 is the
only capability fallback to SSE; connection and protocol defects stay visible
and retry through their typed recovery paths.

Startup prewarm runs when a task is created, resumed, restored, or forked. It
never lies on the active turn's serial path. A generation-tagged lease lets the
real turn supersede an unfinished warmup, while a completed warmup contributes
its response ID and control metadata. Connections are reused only when the
Standard/Lite handshake mode matches. Logout, archive, deletion, bounded cache
eviction, shutdown, and a provider-session-wide 426 decision invalidate the
corresponding state explicitly.

On WebSocket responses, the provider may emit `codex.response.metadata` before
content. The official transport consumes the frame as control state: its
headers can identify the effective model, invalidate the model catalog through
`x-models-etag`, and configure the safety-buffering fallback used by later
events in that response. The local decoder preserves the same response-local
ordering and does not project this frame as assistant output. Transport-only
`responsesapi.websocket_timing` frames are also explicitly enumerated as
non-output; the decoder does not use a wildcard that could hide a new protocol
event.

The provider may emit `codex.rate_limits` on the same Responses stream during
prewarm, normal turns, or compaction. The official client decodes it into a
typed snapshot and the app-server publishes a sparse account update. The local
engine follows that contract: it validates identity, plan, percentages,
durations, and timestamps, then merges present values without clearing account
metadata omitted from the rolling event. Unknown stream discriminators remain
terminal protocol errors.

Incremental reuse is deliberately stricter than a prefix-length check. Model,
instructions, tools, tool policy, reasoning, service tier, prompt-cache key,
verbosity, every prior input, and every provider output must match. Only local
internal message metadata is ignored. Any mutation sends a complete request;
`previous_response_not_found` and connection-limit errors close the chain and
retry from that complete source of truth.

Upstream calculates active context from the latest confirmed usage and local
items after the latest model output. A local audit found that taking the maximum
of that total and a fresh full estimate with margin inflated 200,340 tokens to
252,518 and 186,851 to 250,917, causing two early compactions. The runtime now
uses the same authoritative boundary. Full estimation is restricted to the
phase before compatible telemetry.

Upstream keeps raw, usable, and automatic-compaction limits semantically
distinct. For a 272,000-token catalog window at 95% usability, Core publishes
258,400 as `model_context_window` and defaults automatic compaction to 244,800.
The audited Desktop renders `last.totalTokens / modelContextWindow` directly;
the CLI TUI alone subtracts a 12,000-token presentation baseline. This product
is a desktop surface and follows the Desktop projection. The former frontend
instead preferred the currently selected catalog model and its raw 272,000
tokens over the usage item's execution metadata. It therefore showed 10%
remaining when compaction legitimately began. The composer now consumes only
the usage-associated usable window, which renders that boundary as 95% used and
5% remaining and cannot drift when the next-turn model selection changes.

With compatible confirmed usage, preflight no longer serializes and scans the
complete request. Compaction history stays borrowed unless a bounded tool output
actually needs rewriting. The WebSocket compaction request extends the verified
chain with only `compaction_trigger`, then discards that baseline so the next
sample starts from the new canonical checkpoint. History and its latest usage
marker are loaded in one SQLite read transaction, eliminating both a second
pool round trip and an inconsistent cross-query snapshot.

The previously audited `f88ff940` change adds a bounded reverse-rollout cutoff
after empty wake turns when a surviving full world-state snapshot exists. That
patch is not applicable locally: this engine does not reconstruct provider
context by reverse-scanning paginated rollouts. Its SQLite active-context
prefix is already canonical, including empty `AgentMailbox` turns, and the
combined transactional snapshot has direct regression coverage.

SSE text deltas do not contain exact usage. `response.completed` supplies the
confirmed usage retained for context management. The frontend never attempts to
reproduce the tokenizer. Turn headers display elapsed time without a separate
token-spend projection.

## Conversation footer

Desktop's `thread-scroll-layout-99b3ea3429c1.js` keeps the normal conversation
viewport beneath an absolutely positioned, measured footer. The shared backdrop
in `app-primary-428a0a65766f.js` transitions from transparent to the chat surface
at its midpoint and stays opaque below it. Compact presentation uses a separate
scroll mask; it is not the normal conversation layout.

The native timeline uses the measured dock height for the same surface-gradient
behavior. Bottom spacing is covered along with the composer; the scrollbar stays
above that layer and final-item scroll padding retains its full-height contract.
Pixel regressions verify the fade, opaque footer, and visible lower scroll arrow
with both normal and expanded drafts at three viewports.

The diff renderer in `app-initial-f87238153a19.js` uses dark change bases
`#5ecc71` and `#ff6762`, mixed with 80% of the surface in Lab. The presentation
rules in `app-primary-428a0a65766f.js` use an automatic scrollbar gutter and
explicit line fills. Native diff rows use those colors with continuous solid
fills, including the number column; patterned deletion decorations are excluded
as requested. The regression checks the right edge and consecutive changed rows
at 100% and 112.5% zoom.

## Windows command environment and outcomes

The installed Desktop's `src-VqXTPopo.js` prepares executable directories before
starting its local backend. Its Windows workspace runtime contributes Git,
PowerShell, Node, and validated native executables to the child `PATH`. The
public core's `shell.rs` adds `-NoProfile` only when login-shell loading is
disabled; the unified-exec handler resolves the model's `login` preference.

NativeEngine prepares its own child environment. It merges the inherited launch
path with a fresh registered Windows user/system path for every command and
preserves that result when adding its bundled ripgrep. It does not inspect or
depend on Desktop's runtime directories. PowerShell profile loading is available
through the explicit `login` argument, enabled by default.

The reported `Get-Process cargo,rustc,link -ErrorAction SilentlyContinue` failures
were recorded as exit code 1. An isolated PowerShell reproduction confirms that
requesting an absent process can return existing processes and still fail.
`SilentlyContinue` hides the diagnostic, not the exit status. The same issue can
affect file queries. This matches [PowerShell's command exit semantics](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_pwsh?view=powershell-7.6).
The runtime keeps those outcomes intact; its command contract explains optional
matching, inspecting failures, and polling existing sessions before any retry.

Focused Windows coverage exercises an inherited path missing system tools, a new
executable directory, bounded path composition, process/file queries with partial
output, stderr on success, explicit failure codes, and single execution of a
failed command. Registered paths come from the native
[CreateEnvironmentBlock API](https://learn.microsoft.com/en-us/windows/win32/api/userenv/nf-userenv-createenvironmentblock),
with owned token lifetime and explicit environment-block release.

## Cache and integrity

The model catalog is not persisted. A matching ETag renews TTL, a changed ETag
invalidates immediately, and a missing header does not destroy a valid entry.
The stable task ID is the prompt-cache key, avoiding fragmentation across rounds
and polls.

The [official caching contract](https://developers.openai.com/api/docs/guides/prompt-caching)
reuses matching prefixes without changing answer generation. A smaller wire
payload alone cannot prove a cache hit or lower billable usage. Only confirmed
provider usage establishes those results. The native transport preserves
reasoning effort, encrypted context, tools, and output verbosity.

The stable source contains an experimental `concurrent_reasoning_summaries`
flag, disabled by default and marked `UnderDevelopment`. Its
`sequential_cutoff` delivery changes summary event handling. This audit does
not treat that experimental flag as a supported latency setting.

A read-only `PRAGMA quick_check` returned `ok`. The inspected thread-item table
contained no persisted runs, so it could not establish a live latency or usage
baseline. Code Mode advances the read-cache generation around mutations, with
write and patch regressions preventing reuse of an earlier observation.

Read-cache admission is bounded before an operation starts. Failed and
oversized results are delivered to their callers without being retained;
concurrent callers already sharing an operation still observe its typed result.
Entry identity prevents an evicted operation from accounting or removing a newer
read. Polling independent processes shares the normal execution gate; cache
invalidation runs on entry and scope exit, including cancellation, without
serializing those waits. Mutations still own the exclusive gate.

Upstream does not impose the former local 2,000-line read window and treats EOF
as normal completion. The local tool keeps its 2 MiB per-file bound, accepts
unbounded line ranges, clamps ends to EOF, and returns an explicit EOF marker
when the start is beyond content. Compaction and `read_output` remain
responsible for the model-facing budget.

## Code Mode, multi-agent, and Ultra

Upstream Code Mode is a subsystem with protocol, sandboxed V8 runtime, host,
negotiation, backpressure, limits, yield, and cancellation. The audited Desktop
enabled `features.code_mode_host` and started `codex-code-mode-host.exe`.

The local runtime implements the same boundary with its own V8 isolate and
filtered tool manifest. The isolate has no Node.js or implicit host access;
calls cross a bounded, cancellable Rust bridge. This makes
`code_mode_only` models selectable without an external host.

In `app-server`, each item progresses from `item/started` to
`item/completed`; the terminal event is authoritative for the same identity.
The upstream executor retains an invocation after cancellation is signaled so
the tool-lifecycle owner can publish its terminal result. The local session uses
the same barrier and cooperatively drains tool callbacks on cell completion and
interruption.

`exec` and `wait` are Code Mode orchestration details, not visual activities.
The timeline shows only semantic bridge operations such as commands, reads,
edits, and searches. Yielded JavaScript is neither exposed nor left visually
active.

The audited Desktop uses the latest active semantic action and the latest
reasoning title as a fallback within one persistent group. The local timeline
therefore updates a single reflective header for tools, reads, edits, and
reasoning. During a reasoning stream, only a closed bold heading starts a new
semantic section; partial headings retain the preceding readable title and body
deltas cannot replace it. Completed plain summaries remain readable for stored
or older protocol data. A standalone thinking state appears only before such a
group exists.

Completed reads use direct action language: one file in the singular and files
in the plural. For active commands, the parent header says only "Running
command". After ten seconds, only the child row shows elapsed time with compact
seconds, minutes, or hours. The full command appears in the terminal state, and
expanded output remains available during execution.

The reflective header uses a masked contrast copy with 2D counter-translations
from `-50% to 125%` and `50% to -125%`, synchronized to a one-second,
48-step pulse. It avoids scaling, filtering, and artificial layers. The pulse
belongs only to the current parent title and repeats every 1.2 seconds per
product requirement, rather than the audited snapshot's four seconds.

Multi-agent v2 has four concurrent slots including the root, a 64-task lifetime
limit per tree, persistent mailboxes, and distinct queue-message and start-
follow-up operations. Collaboration tools remain direct and do not enter Code
Mode.

Ultra is a local orchestration preference. It renders purple, requires
multi-agent v2, and becomes unavailable only in the selector when capability is
missing. The provider receives the catalog's multi-agent effort or highest
supported effort; the literal `ultra` never crosses the network.

## Images, browser, and scrolling

Desktop represents image inspection as a tool activity with an expandable
thumbnail. Local `view_image` decodes once, sends those bytes as multimodal
content, stores an identical managed snapshot, and publishes the corresponding
activity. It never navigates to `file://` or opens the browser.

Browser Use is separate: it controls a visible HTTP(S) page through closed
actions, screenshots, snapshots, and first-origin approval. Broad Computer Use,
desktop control, and unrestricted CDP are out of scope. The child-WebView limit
protects live resources; persisted topology for inactive tasks does not consume
native tabs and is removed when its task is deleted.

Outputs, reads, and diffs with their own viewport contain vertical scrolling.
Wheel input at an inner boundary is not transferred or animated into the
conversation. The timeline scrolls only after the pointer enters its surface.
Command output uses the same full native scrollbar as file reads, including
width and arrows.

## Decisions not adopted

- Codex CLI storage, configuration, or process dependencies;
- broad Computer Use;
- arbitrary CDP and external browser profiles;
- public `stream_id` multiplexing until the ChatGPT Codex consumer endpoint and
  official client adopt the same contract;
- automatic `context_management.compact_threshold` on the public API until the
  consumer provider exposes it with Remote Compaction V2 parity;
- experimental `token_budget`, which replaces summarization with a fresh-window
  policy and is disabled upstream; reducing output at an unproven quality cost
  violates this product's requirements;
- generic compatibility for old protocol versions.

## Regression coverage

Local fixtures and tests lock:

- Rust/TypeScript schemas and event methods;
- Standard/Lite WebSocket and SSE transport, upgrade validation, ping/pong,
  bounded buffering, incremental equality, prewarm, fallback, and cancellation;
- capability-gated `auto` reasoning summaries and semantic headline transitions;
- TTL/ETag behavior and absence of persistent catalog cache;
- call/output pairing, ordering, and resume;
- parallelism, barriers, yield, cursors, and cancellation;
- Code Mode isolate, manifest, callbacks, limits, and lifecycle;
- multi-agent tree, mailbox, concurrency, inheritance, and lifecycle;
- compaction and context-window recovery;
- patch atomicity;
- image validation, exact snapshots, presentation, and limits;
- browser origin, bounds, and lifecycle.

## Updating the reference

1. Record the commit and stable release.
2. Review only product-relevant areas.
3. Compare protocol and behavior before porting code.
4. Implement the local domain contract with regression tests.
5. Update `client_version` only after catalog validation.
6. Run `pnpm verify`.
