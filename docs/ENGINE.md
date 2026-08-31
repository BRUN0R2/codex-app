# Engine contract

`NativeEngine` is the product's only backend. It uses ChatGPT OAuth,
HTTPS/WebSocket/SSE, and SQLite without running the Codex CLI or importing its
data.

| Contract | Current value |
| --- | --- |
| IPC schema | `20` |
| SQLite schema | `5` |
| Codex provider | ChatGPT Codex Responses |
| Transport | persistent Responses WebSocket; HTTPS/SSE on explicit 426 |
| Sidecar | hash-validated `rg.exe` 15.2.0 |

## Tauri commands

Every command has a closed request and response. There is no generic RPC or
arbitrary JSON path.

| Area | Commands |
| --- | --- |
| lifecycle | `engine_start`, `engine_runtime_diagnostic_report` |
| account | `engine_account_read`, `engine_account_profile_read`, `engine_account_rate_limits_read`, `engine_account_usage_resets_read`, `engine_account_usage_reset_redeem`, `engine_account_auto_top_up_read`, `engine_account_auto_top_up_enable`, `engine_account_auto_top_up_update`, `engine_account_auto_top_up_disable` |
| session | `engine_login_chatgpt`, `engine_login_cancel`, `engine_logout` |
| tasks | `engine_thread_start`, `engine_thread_list`, `engine_thread_resume`, `engine_thread_read`, `engine_thread_set_name`, `engine_thread_archive`, `engine_thread_unarchive`, `engine_thread_delete`, `engine_thread_fork` |
| turns and output | `engine_turn_start`, `engine_turn_steer`, `engine_turn_interrupt`, `engine_output_read` |
| automations | `engine_automation_list`, `engine_automation_create`, `engine_automation_update`, `engine_automation_delete`, `engine_automation_run_now`, `engine_automation_run_mark_reviewed` |
| models and configuration | `engine_config_update`, `engine_model_list`, `engine_chat_model_list` |
| approvals | `engine_server_request_respond` |
| attachments | `attachment_inspect`, `attachment_read_image`, `attachment_save_pasted_image` |
| browser | `browser_tab_create`, `browser_tab_navigate`, `browser_tab_back`, `browser_tab_forward`, `browser_tab_reload`, `browser_tab_close`, `browser_viewport_set`, `browser_surface_sync` |
| desktop | `application_menu_update`, `application_preferences_read`, `application_preferences_update`, `application_workspace_open` |

`application_workspace_open` accepts only an existing, canonicalized absolute
directory. The WebView cannot open paths directly.

`application_menu_update` applies the validated active catalog to the native
application and tray menus. The application menu is rolled back if tray menu
synchronization fails.

## Events

| Channel | Content |
| --- | --- |
| `engine://runtime-status` | `starting`, `ready`, `failed`, or `stopped` |
| `engine://runtime-diagnostic` | Structured operational failure |
| `engine://notification` | Authentication, task, turn, item, model, and automation events |
| `engine://server-request` | `approval.command` or `approval.browserOrigin` |
| `browser://state` | Authoritative tab state |
| `browser://new-window` | Validated HTTP(S) URL for a controlled new tab |
| `browser://agent-activity` | Conversation, action, and panel-open state |
| `browser://metric` | Bounded QA and latency sample |

Accepted notifications are `auth.loginCompleted`, `auth.sessionChanged`,
`thread.created`, `thread.updated`, `thread.archived`,
`thread.unarchived`, `thread.deleted`, `turn.started`, `turn.completed`,
`item.started`, `item.completed`, `item.streamDeltas`, `model.rerouted`,
`model.verification`, `model.safetyBufferingUpdated`, `automation.changed`,
`automation.deleted`, and `automation.runUpdated`. Decoders reject unknown
methods.

Golden fixtures in `src/contracts/fixtures` lock Rust and TypeScript together.
Regenerate them only intentionally:

```powershell
cargo test --locked --manifest-path src-tauri/Cargo.toml engine::contracts_fixtures::tests::regenerate_golden_contract_fixtures -- --ignored
```

## Models, instructions, and context

Consumer Chat and Codex use separate protocols and catalogs. The Codex catalog
is cached in memory for five minutes. A matching ETag renews validity; a changed
ETag invalidates the entry. Catalogs are never persisted. The frontend does not
duplicate this TTL: opening an empty task or starting a draft revalidates through
the native boundary, which returns a valid cached value or coalesces one network
refresh. Starting a new turn requires the active catalog; steering an active turn
does not.

The first successful credential-vault load is retained in the process-local
credential store and replaced or cleared only after a successful save/delete.
Engine startup warms credentials and shell discovery in a tracked background
task. Creating, resuming, restoring, or forking a Codex task also starts a
best-effort `generate:false` Responses warmup with the selected default
configuration. A real turn always supersedes an unfinished warmup and never
waits for it.

Base instructions come from `model_messages.instructions_template`, with
`base_instructions` reserved for legacy catalogs. The runtime adds separate,
bounded repository, permission, collaboration, and environment items. It does
not maintain a universal prompt that duplicates model protocol.

Unknown `tool_mode` values fail at the boundary. A future unknown
`multi_agent_version` remains decodable but disables MultiAgent and Ultra until
implemented explicitly. `direct`, `code_mode`, and `code_mode_only` select
distinct contracts. Ultra requires multi-agent v2 and is never sent as the
literal `ultra`; catalog capabilities determine effective effort, service tier,
modalities, image detail, and context window.

Before compatible provider telemetry exists, the engine estimates the real
request and applies a 12% margin. After `response.completed`, provider totals
are authoritative and receive only the local cost of items added after the last
model output. A full estimate never inflates that confirmed value again. At the
catalog limit, Remote Compaction V2 sends only the verified incremental
`compaction_trigger` when a response chain exists and installs one valid
checkpoint transactionally. History remains borrowed unless a tool output must
be rewritten to fit. `context_length_exceeded` permits one compaction recovery
before becoming terminal.

Initial history and latest compatible usage come from one SQLite read
transaction. Prompt composition, that snapshot, Code Mode session acquisition,
model/tool resolution, and transport preconnection run concurrently. This keeps
the first request and the first request after compaction off avoidable local
serial work while preserving one canonical snapshot.

Each confirmed usage sample is persisted as `contextUsage`. During a turn, the
UI sums provider-confirmed `output_tokens` and shows the total next to elapsed
time. Text deltas are not tokenized or extrapolated locally. The projection is
derived from persisted items, so the total survives completion and reload.

## Agent loop

1. Load one consistent prompt snapshot, normalize history, and guarantee one
   output for every tool call.
2. Build instructions, input items, capabilities, and the permitted catalog in
   parallel with transport and session preparation.
3. Consume Standard or Lite Responses over a persistent WebSocket. Continue
   only after strict equality of the complete prior request and output, sending
   `previous_response_id` plus new items; otherwise send the complete request.
4. Persist complete items; deltas and `item.started` remain transient
   projections.
5. Execute tools, persist outputs in original call order, and continue.
6. Complete, interrupt, or fail the turn transactionally.

The WebSocket upgrade validates status, `Connection`, `Upgrade`, and
`Sec-WebSocket-Accept`. It retains the authenticated HTTP client's TLS, system
proxy, cookies, and headers; answers ping/pong between requests; limits frames
to 2 MiB and its raw queue to 1,024 messages/16 MiB; and serializes responses on
one connection. HTTP 426 disables WebSocket for that provider session and uses
the existing bounded SSE parser. No other error silently changes protocols.

Heartbeats do not extend the semantic-event deadline. Transient transport,
timeout, HTTP 5xx, WebSocket, and SSE failures may resume with backoff and
immediate cancellation. A lost incremental response resets the chain and
retries from complete canonical input. Invalid protocol is terminal. Rate
limiting follows the provider deadline without an arbitrary local retry
counter.

Consecutive read-only calls may overlap. A mutation, approval, or exclusive
command creates a barrier. A local batch contains at most eight calls, and
results return to the provider in call order.

## Tools

The base catalog has 20 definitions. Code Mode adds `exec` and `wait`, or
replaces direct tools with them in `code_mode_only`. Multi-agent v2 adds six
direct collaboration tools when enabled.

| Group | Tools |
| --- | --- |
| files and state | `read_file`, `list_files`, `search_text`, `view_image`, `edit_file`, `write_file`, `read_output`, `update_plan` |
| execution | `exec_command`, `poll_command` |
| freeform patch | `apply_patch` |
| browser | `browser_manage`, `browser_snapshot`, `browser_screenshot`, `browser_viewport`, `browser_pointer`, `browser_type`, `browser_key`, `browser_wait`, `browser_metrics` |
| Code Mode | `exec`, `wait` |
| collaboration | `spawn_agent`, `send_message`, `followup_task`, `interrupt_agent`, `list_agents`, `wait_agent` |

| Tool class | Read-only | Workspace write | Full access |
| --- | ---: | ---: | ---: |
| read, search, image, output, and plan | yes | yes | yes |
| browser tools | yes | yes | yes |
| `edit_file`, `write_file`, `apply_patch` | no | yes | yes |
| `exec_command` | no | approval | no approval |
| `poll_command` | yes | yes | yes |

Read-only mode does not advertise prohibited tools. Identical pure calls in the
same segment may be coalesced; effects are never deduplicated. Schemas are
strict, and Rust validates constraints that JSON Schema cannot represent.

`read_file` retains a 2 MiB per-file limit, accepts nullable line bounds, and
does not impose an arbitrary line-count window. Requested ends clamp to EOF; a
start beyond content returns an explicit EOF marker. Full content remains
subject to provider compaction and becomes paginated output when over budget.

### Files and patches

Paths are normalized inside the workspace. Writes are UTF-8 and atomic.
`apply_patch` uses a dedicated Lark grammar without a shell or `git apply`.
It plans every file in memory, rejects escapes, symlinks, and overlaps,
revalidates snapshots, and commits or rolls back the complete transaction.

`search_text` executes bundled ripgrep by absolute path without a shell or
`PATH` dependency. The engine applies ignore rules, limits, timeout,
cancellation, and incremental reads.

### Commands

`exec_command` uses hidden, colorless PowerShell 7 in UTF-8. On Windows, each
tree enters a Job Object with `KILL_ON_JOB_CLOSE`; launch fails if ownership
cannot be established.

| Limit | Value |
| --- | ---: |
| concurrent sessions | 32 |
| default initial wait | 10 s |
| `yield_time_ms` | 250 ms to 30 s |
| `poll_command` wait | 0 to 30 s |
| live preview | 256 KiB per stream |
| cooperative shutdown | 6 s |
| shutdown after forced abort | 2 s |

After yielding, the session remains owned by its task and returns cursor-based
deltas. The full transcript is persisted in chunks and read through
`read_output` or `engine_output_read`. Turn completion, deletion, and shutdown
cancel and drain sessions before the terminal event. Interruption records
idempotent cancellation and returns immediately; the finalizer alone owns the
drain. A non-cooperative execution is aborted by the task that owns its Job
Object without blocking the terminal turn transaction.

### Code Mode

`exec` evaluates JavaScript in a V8 isolate without Node.js, network,
filesystem, or host APIs. Its manifest contains only tools already filtered by
permission and capability. Collaboration remains direct and is unavailable from
the isolate. `wait` resumes or terminates a yielded cell.

| Limit | Value |
| --- | ---: |
| source per execution | 1 MiB |
| nested tool calls | 64 |
| active cells | 8 |
| runtime per cell | 10 min |
| output per cell | 4 MiB or 256 items |
| stored values | 128 entries, 1 MiB each |
| pending callbacks | 64 |

V8 warm-up is claimed atomically once at engine startup and runs in the tracked
background task set. The process initialization barrier still protects the
isolate, so a cell arriving during warm-up shares the same work and never starts
a second cold runtime. The first `exec` no longer owns this cost, while engine
`ready` is not delayed.

Callbacks preserve cancellation and backpressure. Cancellation first completes
the visual item as failed and then propagates to the cell. Completion or
cancellation signals the session and drains callbacks that own visual items;
those futures are never aborted after `item.started`. Mutations serialize the
cell and invalidate its read cache before the next call.

### Multi-agent v2

Six collaboration tools operate on a persistent tree. A tree allows four active
agents including the root and 64 lifetime tasks. Spawn and messages are
transactional. `followup_task` wakes an idle agent, `send_message` only
queues, and user steering wakes `wait_agent`.

`fork_turns=all` inherits model and effort and rejects overrides. `none`
inherits no context; a positive value accepts up to 1,000 turns. Waits have a
10-second minimum, 30-second default, and one-hour maximum. Completion and
interruption publish typed states and do not depend on frontend polling.

### Images

`view_image` is the only local visual-inspection tool. It validates sandbox and
cancellation, decodes PNG, JPEG, GIF, or WebP, limits files to 10 MiB,
dimensions to 16,384 px, and decoded allocation to 256 MiB. The provider gets a
data URL; the timeline references a managed snapshot of the same validated
bytes, so later source changes do not alter history.

### Browser Use

The runtime materializes at most 16 child WebViews, each owned by a conversation.
Persisted metadata is separate: up to 16 tabs per task and 256 tasks without
consuming a WebView until use. Deleting a task removes topology and releases its
native WebViews. URLs allow only HTTP, HTTPS, or `about:blank`, without embedded
credentials. Remote webviews receive no IPC, filesystem, or opener access.

Automation exposes only closed tab, viewport, snapshot, screenshot, pointer,
text, keyboard, wait, and metric actions. There is no arbitrary CDP command.
Screenshots enter tool output as multimodal content. A new origin requires
`approval.browserOrigin` for the current conversation.

## Persistence and recovery

SQLite uses WAL and transactions for compound changes. Interrupted calls without
outputs receive `aborted`; orphan outputs are removed. Active turns at startup
recover to an explicit terminal state, and old commands are never reactivated.
Schema 5 adds multi-agent identities and mailboxes with cumulative migration and
exact table and column validation.

`engine_turn_steer` persists the message and causal input atomically. A queued
message is promoted only after the response that could not observe it, preserving
order across process failure. Deleting an active task cancels it, blocks new
acquisition, and responds only after removal commits. Concurrent requests to
interrupt, delete, archive, fork, or answer one approval coalesce by identity.
Native-tab initialization, catalog revalidation, and immediate automation runs
use the same single-flight contract. One logical effect issues one native
command.

Large outputs live in paginated resources, not timeline items. Live events have
independent limits; the completed item is authoritative. The last semantic group
within a turn owns one reflective header: it shows the active tool, then the
latest complete reasoning-section heading. Partial markers and summary bodies do
not replace a readable heading; a completed legacy plain summary remains
supported. Raw reasoning content is never promoted into the header. Command
parents say only "Running command"; the child row alone owns elapsed time.

The model catalog's reasoning-summary default describes Core behavior, not the
Desktop interface preference. When the model advertises the summary parameter,
the native request explicitly sends `summary: "auto"`, including Responses Lite;
unsupported models omit the parameter. This matches the audited Desktop default
and keeps capability selection separate from product policy.

## Automations

Automations have version, timezone, interval, next run, and state. Updates
require `expectedVersion`. The scheduler permits two global runs and one per
automation. Claim, advancement, and run creation are atomic. Each run uses a
normal task and turn, with no special agent path.

## Configuration

`AppConfig` is a closed schema with optimistic concurrency. Model, effort, and
service tier update together; per-turn overrides do not change persisted
defaults.

Valid combinations are:

- `read-only` with `untrusted`;
- `workspace-write` with `on-request`;
- `danger-full-access` with `never`.

Rust and TypeScript reject every other combination.
