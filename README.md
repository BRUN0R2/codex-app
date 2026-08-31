# Codex Desktop Next

A native, standalone Windows client for ChatGPT Chat, local ChatGPT Work, and a
Codex agent. The application uses a ChatGPT account but does not start, package,
or depend on the Codex CLI. The public `openai/codex` repository is used only as
a protocol and behavior reference.

## Features

- ChatGPT OAuth with PKCE, refresh, revocation, and cancellation;
- separate Chat and Codex catalogs, incremental WebSocket/SSE streaming, and
  isolated history;
- concurrent tasks, steering, interruption, compaction, forks, and archiving;
- a native agent with sandboxed V8 Code Mode, files, commands, plans, images,
  and browser tools;
- persistent, cancellable multi-agent v2 collaboration with ownership limits;
- explicit read-only, workspace-write, and full-access permission profiles;
- background processes with incremental output and deterministic tree cleanup;
- live reasoning summaries with stable, semantic progress headings;
- local SQLite WAL storage and credentials protected by Windows Credential
  Manager;
- bounded approvals and Tauri contracts validated on both sides of IPC;
- a SolidJS interface for tasks, models, usage, automations, and settings;
- automatically discovered JSON translations, system-language detection, and
  explicit language selection.

## Architecture

| Layer | Responsibility |
| --- | --- |
| Rust/Tauri | Authentication, providers, agent, tools, browser, and persistence |
| TypeScript/SolidJS | Decoded contracts, interface state, and presentation |
| SQLite | Tasks, events, settings, and non-secret metadata |
| Windows Credential Manager | Key material used to protect local credentials |

Manifests and lockfiles define the exact versions and dependency graph. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for module boundaries and
[docs/ENGINE.md](docs/ENGINE.md) for the agent contract.

## Requirements

- Windows 10 or 11 with WebView2;
- a ChatGPT account with access to the features in use;
- PowerShell 7 (`pwsh`);
- Node.js 26 or later and pnpm 11.22 or later;
- Rust 1.98.0 with the MSVC toolchain.

The Codex CLI is not required.

## Development

```powershell
pnpm install --frozen-lockfile
pnpm dev:launch
```

The first command installs the locked dependency graph. The second starts Vite
and the Tauri shell with an isolated development profile.

On Windows, `codex-app.bat` exposes the debug and release flows. Its preflight
requires pnpm on `PATH`, installs the locked graph when needed, and repairs
missing local package commands. PowerShell, Rust, and Tauri remain owned by the
respective scripts and toolchains.

To work on the interface only:

```powershell
pnpm dev
```

Open `http://127.0.0.1:1420/?preview=1`. The preview uses deterministic
contracts, rejects native operations, and is excluded from production bundles.

## Translations

The default language preference is **Auto-detect**, which selects the closest
catalog to the browser or operating-system languages. Users can override it in
Settings. English and Brazilian Portuguese are included.

To add a language, copy `src/i18n/locales/en.json`, translate every message, set
a canonical locale and native display name, then save it as
`src/i18n/locales/<locale>.json`. The Vite glob discovers it automatically. The
application rejects missing or extra keys, invalid metadata, duplicate locales,
and placeholder mismatches during startup; no registry edit is required.

Operational logs, diagnostics, and internal errors remain in English. Only
user-facing interface copy belongs in translation catalogs.

## Verification

```powershell
pnpm verify
```

This is the complete gate: encoding, lint, type checking, tests, regression
benchmarks, visual QA, production build, transitive dependencies, `cargo check`,
formatting, Clippy, and Rust tests.

Useful commands:

```powershell
pnpm smoke:browser   # real child-WebView2 flow without an account
pnpm measure:tokens  # context and compaction budgets
pnpm tauri build     # local NSIS bundle
```

Official releases follow [docs/RELEASE.md](docs/RELEASE.md).

## Repository layout

- `src/contracts`: boundary types and decoders;
- `src/i18n`: catalog discovery, validation, locale resolution, and context;
- `src/infrastructure`: Tauri commands and events;
- `src/state`: reactive ownership and deterministic transitions;
- `src/ui`: presentation without direct IPC access;
- `src-tauri/src/engine/native`: agent, authentication, providers, storage,
  Code Mode, multi-agent collaboration, and tools;
- `scripts`: gates, measurements, and local automation;
- `docs`: contract, architecture, reference, performance, and release guidance.

Read [docs/RULES.md](docs/RULES.md) before changing the project. The active
backlog is [docs/TODO.md](docs/TODO.md).
