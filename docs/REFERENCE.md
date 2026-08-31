# Official Codex reference

This document records only upstream conclusions that affect this product. The
local implementation remains independent.

## Audited snapshot

| Source | Version |
| --- | --- |
| [`openai/codex`](https://github.com/openai/codex) | commit `d9511fb7888d98f89526d4ae019dd9be2f14199e`, 2026-08-28 |
| stable release | `rust-v0.150.1`, commit `90854393966b21e9ebfd21b122334eb09a20c93d` |
| Codex Desktop for Windows | build `26.825.5331.0`, validated 2026-08-29 |

The ignored study clone lives in `.references/openai-codex`. No referenced
crate, package, executable, database, configuration, or credential enters the
local build or runtime.

The local catalog's `client_version` remains `0.150.1`, the latest stable
release whose protocol was audited.

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
| Responses | Standard, Lite, SSE, and typed items | Separate native parsers and requests |
| history | Every tool call has exactly one output | Transactional normalization and repair |
| instructions | Catalog template plus factual runtime context | Bounded layers without a duplicate universal prompt |
| cache | Short in-memory catalog cache with ETag invalidation | Five-minute TTL and no persistence |
| context | Confirmed use plus local delta and Remote Compaction V2 | Dynamic budget and atomic checkpoint |
| commands | Yield, registered sessions, polling, and incremental output | Independent manager with Windows Job Objects |
| parallelism | Independent tools may overlap | Eight-call local batch with deterministic order |
| patch | Freeform tool with a dedicated parser | Local Lark grammar and transactional commit |
| images | Multimodal inspection is a native tool activity | Local `view_image`, thumbnail, and viewer |
| browser | Visible surface, closed actions, and origin approval | Engine-controlled child WebView2 |
| Code Mode | Isolated V8, manifest, callbacks, yield, and cancellation | Independent Rust runtime and bridge |
| multi-agent v2 | Typed tree, mailbox, and lifecycle | Transactional persistence and six direct tools |

Upstream has no single parallel-command maximum equivalent to the local limit;
scheduling depends on handlers and barriers. Its Unified Exec manager accepts up
to 64 processes. This project limits one round to eight tools and its registry
to 32 sessions. Both limits are intentional and tested.

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

Responses Lite preserves semantics over a different wire shape:
`additional_tools`, a `functions` namespace, and base instructions encoded as
a developer message with stable IDs. Model capability selects the contract
before the request; a failed request never triggers a protocol fallback.
The audited Desktop resolves an absent `model_reasoning_summary` preference to
`auto`, even though current model metadata commonly publishes `none` as the Core
default. The local native client applies that same explicit product preference
only when the catalog advertises parameter support.

Upstream calculates active context from the latest confirmed usage and local
items after the latest model output. A local audit found that taking the maximum
of that total and a fresh full estimate with margin inflated 200,340 tokens to
252,518 and 186,851 to 250,917, causing two early compactions. The runtime now
uses the same authoritative boundary. Full estimation is restricted to the
phase before compatible telemetry.

SSE text deltas do not contain exact usage. `response.completed` supplies
`output_tokens`, so the timeline accumulates only confirmed values per turn.
The count updates after confirmed cycles, remains attached to completed turns,
and survives history reload. The frontend never attempts to reproduce the
tokenizer.

## Cache and integrity

The model catalog is not persisted. A matching ETag renews TTL, a changed ETag
invalidates immediately, and a missing header does not destroy a valid entry.
The stable task ID is the prompt-cache key, avoiding fragmentation across rounds
and polls.

The local audit validated `PRAGMA integrity_check`, persisted JSON, and table
references without finding database, catalog-cache, or prompt-cache corruption.
It did find a nested Code Mode read-cache defect: a mutation could leave an old
read reusable. Every mutation now advances the cache generation, with write and
patch regressions.

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
- Responses WebSocket without proven SSE parity;
- generic compatibility for old protocol versions.

## Regression coverage

Local fixtures and tests lock:

- Rust/TypeScript schemas and event methods;
- Standard/Lite transport and capability-driven instructions;
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
