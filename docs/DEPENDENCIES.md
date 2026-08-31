# Dependencies

`package.json` and `src-tauri/Cargo.toml` are the sources of direct
dependencies. `pnpm-lock.yaml` and `src-tauri/Cargo.lock` lock their complete
resolution. This document records only purpose and maintenance exceptions.

## Frontend

| Dependency | Purpose |
| --- | --- |
| `solid-js` | Reactive state and rendering |
| `@tauri-apps/api` | Native-shell commands and events |
| `@tauri-apps/plugin-dialog` | Native file selection |
| `@tauri-apps/plugin-opener` | External links and validated directories |
| `marked` | Markdown parsing |
| `dompurify` | Sanitization before DOM insertion |

Vite, TypeScript, Biome, Vitest, and the Tauri CLI are development and build
dependencies only. Translation discovery uses Vite's native
`import.meta.glob`; it adds no runtime dependency.

## Backend

| Group | Dependencies | Purpose |
| --- | --- | --- |
| shell | `tauri`, plugins, `tauri-build` | Window, Windows integration, and bundle |
| Windows | `webview2-com`, `windows` | Child WebView2, COM, and Job Objects |
| async | `tokio`, `futures-util` | Tasks, concurrency, and SSE |
| sandbox | `v8` | Isolated Code Mode JavaScript runtime |
| HTTP | `reqwest`, `url` | rustls HTTPS, cookies, and validated URLs |
| storage | `rusqlite`, `r2d2`, `r2d2_sqlite` | SQLite WAL and pooling |
| secrets | `age`, `keyring-core`, `windows-native-keyring-store`, `zeroize`, `rand`, `sha2` | Vault, PKCE, and hashes |
| contracts | `serde`, `serde_json`, `base64`, `image` | IPC, envelopes, and images |
| domain | `chrono`, `uuid`, `thiserror`, `tempfile`, `parking_lot` | Time, IDs, errors, spooling, and locks |

`webview2-com` and `windows` are direct dependencies because the code names
and tests specific APIs. No COM object or generic CDP command crosses the agent
contract.

## Rust

Toolchain, MSRV, and CI use Rust 1.98.0. The project uses `edition = "2024"`
and `build.warnings = "deny"`; Clippy also treats local warnings as errors.

Sources:

- [Rust 1.98.0](https://blog.rust-lang.org/2026/08/20/Rust-1.98.0/);
- [release notes](https://doc.rust-lang.org/releases.html#version-1980-2026-08-20);
- [`build.warnings`](https://doc.rust-lang.org/cargo/reference/config.html#buildwarnings).

Adopt new APIs or lints only when they reduce real complexity or improve
correctness. Never use `allow` to hide regressions. The Rust 1.98 review kept
cross-platform floating-point behavior and simple existing APIs where newer
alternatives had no measured benefit. The `filter_map_bool_then` and
`obfuscated_if_else` diagnostics did simplify real multi-agent paths.

## Transitive exception

The lockfile has one known path to unmaintained `unic-*` crates:

```text
tauri-utils 2.9.3 -> urlpattern 0.3.0 -> unic-ucd-ident 0.9.0
```

It is transitive from stable Tauri. `pnpm verify:transitive` allows only this
path and these versions. Remove the exception when a stable Tauri release
updates `urlpattern`.

## Bundled ripgrep

`search_text` uses its own ripgrep 15.2.0, never a global installation or the
Codex CLI. `scripts/ripgrep-manifest.json` locks architecture, assets, and
hashes.

```powershell
pnpm tools:bootstrap
pnpm rg -- -n "text" src src-tauri/src
```

Bootstrap, build, and runtime validate the version and SHA-256. The executable
lives in `.tools/ripgrep`, is bundled as a sidecar, and is invoked by absolute
path without a shell. Global `PATH` is never modified.

## Update policy

1. Add or update only dependencies with confirmed use.
2. Review release notes, features, MSRV, licenses, and the transitive graph.
3. Keep exact versions and both lockfiles.
4. Remove unused features and dependencies.
5. Run `pnpm verify:transitive` and `pnpm verify`.

`.references` contains ignored study material only. Removing it must not affect
builds, runtime behavior, or tests.
