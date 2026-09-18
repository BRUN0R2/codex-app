# Dependencies

`package.json` and `src-tauri/Cargo.toml` are the sources of direct
dependencies. `pnpm-lock.yaml` and `src-tauri/Cargo.lock` lock their complete
resolution. This document records only purpose and maintenance exceptions.

The JavaScript package manager is pnpm 12.4.1. Node.js 26 and Rust 1.98.0 are
the supported toolchain baselines used by CI and local verification.

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

Vitest remains on 4.1.11 while Vite is on 8.3.0. Vitest 5.0.0 is newer, but
its published declarations do not type-check against that Vite 8 graph; the
project keeps the newest compatible Vitest line until that upstream contract is
fixed. No local declaration patch or compatibility shim is used.

## Backend

| Group | Dependencies | Purpose |
| --- | --- | --- |
| shell | `tauri`, plugins, `tauri-build` | Window, Windows integration, and bundle |
| Windows | `webview2-com`, `windows` | Child WebView2, COM, and Job Objects |
| async | `tokio`, `futures-util` | Tasks, concurrency, and streaming |
| sandbox | `v8` | Isolated Code Mode JavaScript runtime |
| transport | `reqwest`, `tokio-tungstenite`, `url` | rustls HTTPS, cookies, system proxy, WebSocket framing, and validated URLs |
| storage | `rusqlite`, `r2d2`, `r2d2_sqlite` | SQLite WAL and pooling |
| secrets | `age`, `keyring-core`, `windows-native-keyring-store`, `zeroize`, `rand`, `sha2` | Vault, PKCE, and hashes |
| contracts | `serde`, `serde_json`, `base64`, `image` | IPC, envelopes, and images |
| domain | `chrono`, `uuid`, `thiserror`, `tempfile`, `parking_lot` | Time, IDs, errors, spooling, and locks |

`webview2-com` and `windows` are direct dependencies because the code names
and tests specific APIs. No COM object or generic CDP command crosses the agent
contract.

`tauri-plugin-dialog` and `tauri-plugin-opener` are kept at the current releases
in both manifests. The Rust `webview2-com` 0.38.2 and `windows` 0.61.3 pins are
intentional: Tauri 2.11.5 still exposes those versions in its Windows runtime
graph, while newer direct versions produce incompatible COM and Windows API
types. They must be revisited together with a Tauri release that updates that
graph.

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

## Sandboxed V8 source build

The application enables V8's sandbox with `v8` 152.2.0, so the Windows build
uses the crate's source path instead of an unchecked prebuilt library. The
bootstrap script obtains the exact Chromium Rust vendor archive required by that
crate and copies the locked ICU data from `deno_core_icudata` 0.78.0. Both
archives and the installed files are SHA-256 validated before the compiler can
use them.

The source build requires a real Python 3 interpreter and the Windows `tar`
command. `scripts/native-build.ps1` puts Cargo's target directory on the same
volume as `CARGO_HOME`, removes whitespace from the compiler path, and sets a
bounded `CARGO_BUILD_JOBS` value. The default is eight jobs; a caller may set
`CODEX_NATIVE_BUILD_JOBS` explicitly, but conflicting project and Cargo values
are rejected. Native commands should be invoked through `pnpm native:cargo` or
`pnpm tauri` so this policy is applied consistently.

The V8 source uses Chromium Rust commit
`afbc96607d0e659715d803cc099607dd1737fc41`; the downloaded archive hash is
`369d588b75b4f4e5d9321e80d782b30637e52bbecf92778a71c54d2469d3d2b1`.

## Update policy

1. Add or update only dependencies with confirmed use.
2. Review release notes, features, MSRV, licenses, and the transitive graph.
3. Keep exact versions and both lockfiles.
4. Remove unused features and dependencies.
5. Run `pnpm verify:transitive` and `pnpm verify`.

`.references` contains ignored study material only. Removing it must not affect
builds, runtime behavior, or tests.
