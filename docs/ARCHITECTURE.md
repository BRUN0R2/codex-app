# Architecture

The application separates presentation, state, IPC, and the native domain. The
Rust backend owns authentication, agents, tools, browser processes, and
persistence. The frontend renders contracts only after validation.

```text
SolidJS UI
    ↓ actions / ↑ state
State controllers
    ↓ typed contracts
Tauri infrastructure
    ↓ commands / ↑ events
Rust NativeEngine
    ├─ authentication and providers
    ├─ agent loop, Code Mode, and multi-agent collaboration
    ├─ tools and isolated V8 runtime
    ├─ child WebView2 and process ownership
    └─ SQLite and credential vault
```

## Boundaries

| Layer | Owns | Must not |
| --- | --- | --- |
| `src/ui` | Rendering and interaction | Access IPC or decide domain policy |
| `src/state` | Reactive ownership and transitions | Accept undecoded external payloads |
| `src/infrastructure` | Commands, events, and Tauri adaptation | Retain business rules |
| `src/contracts` | Boundary types and strict decoders | Infer or repair invalid payloads |
| `src/i18n` | Catalog discovery, validation, locale resolution, and formatting | Translate operational diagnostics or accept incomplete catalogs |
| `src-tauri/src/engine/native` | Agent, auth, providers, storage, and tools | Depend on the frontend or Codex CLI |
| `src-tauri/src/browser` | Child-WebView2 lifecycle and automation | Expose unrestricted webview access |
| `src-tauri/src/process` | Child-process ownership | Leave orphaned process trees |

Invalid contracts fail at their boundary. Components never call native commands
directly, and approximate payload formats are never accepted as fallbacks.

## Initialization

1. The shell creates native state and registers commands and events.
2. The frontend requests the engine snapshot.
3. Rust validates configuration, storage, and credentials.
4. `src/contracts` decodes the response.
5. The controller publishes either ready state or an explicit, repeatable error.

Failures do not expose partially initialized state. A retry executes the owning
boundary again. Shell discovery, Code Mode initialization, and the first
credential load are warmed in tracked background tasks; they do not delay the
ready transition.

## Codex task flow

1. The UI sends a validated turn to the controller.
2. The engine persists intent and concurrently assembles one transactional
   history/usage snapshot, model context, instructions, Code Mode state,
   transport, and a capability-compatible tool catalog.
3. For models that support reasoning summaries, the Desktop product preference
   explicitly requests `auto`; the provider then streams typed Responses items
   over a persistent WebSocket. A verified response chain sends only new input;
   any mismatch returns to the complete canonical request. HTTP/SSE is used only
   after an explicit 426 capability response.
4. Provider control events are decoded before output projection;
   `codex.response.metadata` updates the response-local model catalog and safety
   treatment, while `codex.rate_limits` becomes a validated sparse account
   update during normal turns, prewarm, and compaction.
5. The loop projects deltas, persists complete items, and executes authorized
   tools.
6. Outputs are bounded and compacted before re-entering model context.
7. Completion, failure, interruption, and recovery close the turn explicitly.

Independent tasks can progress concurrently. Shared resources have explicit
owners, limits, cancellation, and shutdown behavior.

Task creation, resume, restore, and fork schedule a non-blocking
`generate:false` transport warmup. Session leases are generation-tagged: an
active turn can supersede warmup atomically, and stale work cannot reinsert a
socket after logout, archive, deletion, eviction, or shutdown. Raw WebSocket
frames have both count and byte budgets, while decoded events remain bounded.

## Internationalization

`src/i18n/catalog.ts` discovers `src/i18n/locales/*.json` at build time. The
English catalog is the canonical compile-time message schema. Every catalog is
also decoded at runtime with exact keys, bounded strings, canonical locale
metadata, direction, and identical placeholder sets. Catalogs are immutable and
ordered deterministically.

`src/i18n/messages.ts` contains the schema type and strict formatter without a
runtime catalog dependency. Presentation logic and Node benchmarks can reuse
that pure core without evaluating Vite-only discovery.

The persisted preference is either `auto` or a discovered locale. Auto mode
tries exact locale matches, then language-family matches, then English. Changing
the preference updates SolidJS consumers and the document `lang` and `dir`
attributes. Desktop builds also apply the same validated catalog to the native
application and tray menus through a closed Tauri command. Storage failures are
visible in Settings; native synchronization failures enter the application
diagnostic path. Internal errors and logs are deliberately English and are not
translation keys.

## Code Mode and collaboration

Code Mode evaluates JavaScript in a dedicated V8 isolate. The model sees only a
typed manifest of permitted tools. Calls cross a bounded, cancellable Rust
bridge with no implicit Node.js, filesystem, network, or process access. Reads
may overlap; mutations establish a barrier and invalidate the cell read cache.

Multi-agent v2 persists identity, tree, mailbox, and state in SQLite. Spawn,
message, follow-up, interrupt, list, and wait are direct agent operations and do
not recurse through Code Mode. A tree has four active-agent slots, including the
root, and a lifetime limit of 64 tasks.

## Tools and commands

The backend builds the tool catalog from the permission profile, platform, and
model capabilities. Tools never choose or elevate their own permissions.

- reads, listings, and searches validate the workspace and enforce limits;
- writes and patches normalize targets and use transactions for multi-file work;
- commands use bounded sessions, incremental output, and Windows Job Objects;
- long-running processes yield and are read incrementally by cursor;
- large results are compacted or stored for targeted reads.

See [ENGINE.md](ENGINE.md) for the complete contract.

## Images and browser

The backend inspects attachments. `view_image` validates a local image, stores a
managed snapshot of the exact bytes sent to the provider, and publishes a
timeline activity. The interface renders the thumbnail and native viewer;
opening a browser is unrelated to this flow.

Browser Use runs in a visible child WebView2 separate from the main interface.
The backend owns tabs, navigation, viewport, snapshots, screenshots, pointer,
keyboard, waits, and metrics. Sensitive navigation and actions respect origin
approval and the permission profile. The agent receives structured results or
images, never arbitrary access to the application DOM.

## Persistence and secrets

- SQLite WAL stores tasks, events, agents, mailboxes, settings, and metadata;
- compound changes use transactions and optimistic concurrency where needed;
- incomplete call/output pairs are repaired by explicit rules;
- credentials use an application-private encrypted envelope;
- the envelope key lives in Windows Credential Manager;
- the decrypted record is loaded once per process-local credential state and
  updated only after successful vault mutations;
- tokens never cross IPC or enter SQLite.

Schemas are versioned and migrations are tested. A database or vault with an
incompatible identity is rejected instead of reinterpreted.

## Rendering

Controllers own account, project, task, browser, automation, and preference
state. Expensive projections are memoized and large lists are virtualized.
Markdown, syntax highlighting, diffs, and large outputs use incremental work to
avoid blocking the main thread.

Events may arrive while another task is visible. Every reduction carries task
and turn identity to prevent state leaking between sessions.

## Invariants

- Rust is authoritative for the native domain; the UI owns presentation.
- Every external boundary validates schema, size, and identity.
- Tokens and secrets never enter Tauri contracts.
- No tool expands configured permission.
- No child process survives its owner.
- Unbounded output never enters memory, IPC, or model context.
- Compound persistence is atomic or fails visibly.
- Preview fixtures do not affect production behavior.
- The application never reads Codex CLI configuration, data, or credentials.

Tests should enforce each invariant at its nearest boundary, with `pnpm verify`
as the repository-wide gate.
