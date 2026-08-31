# Project rules

This document is the repository's highest-level contract. No implementation,
refactor, dependency, or shortcut may contradict it.

When requirements conflict, prioritize project rules, architectural integrity,
maintainability, predictability, security, performance, and finally delivery
speed. Report the conflict before proceeding.

## Principles

- Fix causes, never only symptoms.
- Use the least complexity that solves the complete problem.
- Prefer explicit, cohesive, predictable, modular, production-ready code.
- Prefer composition, narrow contracts, and deterministic flows.
- Avoid premature abstraction, deep layers, hidden state, and silent fallbacks.
- Remove dead, duplicated, obsolete, and unused compatibility code.
- A refactor must reduce total complexity, not merely move it.
- Inputs, outputs, effects, ownership, transitions, and failures must be visible.

## Product and stack

- The operational target is Windows with Tauri 2, Rust edition 2024, strict
  TypeScript, and Vite.
- Rust uses the stable toolchain pinned in `rust-toolchain.toml`.
- `NativeEngine` owns agent composition.
- ChatGPT OAuth, providers, tools, configuration, secrets, and persistence
  belong to this application's Rust backend.
- The Codex CLI may be studied as a reference but must never become a build,
  runtime, configuration, storage, or credential dependency.
- The interface must never receive tokens or reinterpret credentials.
- Do not create aliases, adapters, or general paths for external formats or
  obsolete protocols.
- Every new technology requires a demonstrated benefit, an isolated boundary,
  and proportionate maintenance cost.

## Architecture

- Organize the system into small, cohesive modules with one clear owner.
- Keep business rules in their owning domain; do not duplicate them across the
  backend, infrastructure, and UI.
- Use domain types for states and values with distinct semantics.
- Keep APIs minimal; never expose internals for convenience.
- Global mutable state requires explicit ownership and justification.
- Concurrent resources require defined lifecycle, cancellation, and shutdown.
- Operational errors must be structured, observable, predictable, and written
  in English.
- Do not hide initialization failures or simulate resilience with implicit
  recovery.

Internal migrations are allowed only for this application's data. Every
migration must have an explicit version and scope, validate identity and schema,
run atomically, preserve data or fail visibly, and test success, failure, and
integrity. Never use migrations to import Codex CLI formats.

## Rust

- Use idiomatic Rust, explicit ownership, and structured errors.
- Use `Result` for recoverable failures; never discard operational errors.
- Avoid `panic!`, `unwrap`, and `expect` outside demonstrably unrecoverable
  initialization.
- Avoid `unsafe`. When unavoidable, isolate it, document invariants, and
  validate preconditions.
- Prefer enums, newtypes, and validated structures over loose strings or maps.
- Release operating-system resources deterministically.

## TypeScript and interface

- Keep `strict` enabled and do not bypass the compiler with broad types.
- Decode every Tauri response and event before mutating state.
- Keep TypeScript and Rust contracts synchronized.
- UI components must not access IPC directly; infrastructure and state own that
  boundary.
- Keep the interface direct, accessible, and free of nonfunctional controls.
- Loading, error, empty, approval, and cancellation states must be explicit.
- Visual density and animation require practical value and stable behavior.
- All owned user-interface copy must come from the validated translation
  catalog. Dynamic provider or user content remains unchanged.
- Translation catalogs must be auto-discovered, exact, bounded, and placeholder
  compatible. Never fill missing keys with a silent fallback.

## Code

- Use descriptive names and each language's native conventions.
- Avoid non-universal abbreviations, magic numbers, and stale comments.
- Constants require semantic names, appropriate types, and clear context.
- Apply single responsibility and remove real duplication; do not force DRY
  across merely similar concepts.
- Do not use God classes, service locators, hidden globals, cycles, deep
  inheritance, indiscriminate reflection, or implicit ownership.
- Logs must be operationally useful, in English, structured when needed, and
  free of private data.

## Security and persistence

- Never commit secrets, credentials, tokens, or private data.
- Secrets belong in this application's vault and private directory.
- SQLite stores only domain-appropriate data and uses transactions for compound
  changes.
- Validate size, format, identity, and destination for every external input.
- File and configuration changes require validated targets, explicit effects,
  and reversibility where practical.
- Permissions are closed by default and cannot expand implicitly.
- Memory, output, file, process, stream, and concurrency limits must be explicit
  and tested.

## Tests and validation

- Validate every external boundary and environment-dependent invariant at
  runtime.
- Add focused regression coverage for every corrected defect at the violated
  contract.
- Test success, failure, cancellation, and concurrency when relevant.
- Avoid duplicated, brittle, or behavior-free tests.
- `pnpm verify` is the complete gate before completion or publication.
- Never weaken lint, typing, Clippy, tests, or measurements to pass the gate.

## Performance

- Measure before and after meaningful optimization with a reproducible scenario.
- Protect critical regressions with stable limits or benchmarks.
- Prefer predictable latency and memory over complex micro-optimizations.
- Avoid unnecessary copies, allocations, serialization, and main-thread work.
- An optimization may trade clarity or maintainability only for a measured and
  documented benefit.
- Do not suppress performance diagnostics or narrow inputs when the measured
  work remains unchanged.

## Dependencies

- Every direct dependency must justify its cost and remain locked in the
  manifest and lockfile.
- Prefer a local implementation when it is small, safe, and easier to maintain.
- Isolate external integrations and update dependencies regularly.
- Transitive exceptions require justification, exact versions, and a regression
  gate.
- Do not retain unused assets, tools, or packages.

## Git and documentation

- Preserve user changes and never rewrite history without authorization.
- Create one commit for each completed logical change.
- Commit messages are short English imperatives that describe the actual change.
- Keep `docs/TODO.md` short, current, and actionable.
- Document durable contracts and decisions; details expressed more accurately by
  code belong in code and tests.
- Update measured numbers, versions, and capabilities with the change that
  affects them. State documents must not accumulate history.
- Keep repository documentation concise and in English.

## Change process

Before implementation:

1. read these rules and identify the behavior owner;
2. confirm reality in code, tests, and manifests;
3. choose the solution with the least coupling and fewest moving parts.

Before completion:

1. review duplication, dead code, ambiguity, ownership, and failures;
2. add the required regression coverage;
3. update affected documentation and TODO items;
4. run `pnpm verify` and review the complete diff.

Do not invent APIs or behaviors, ship partial solutions, or trade long-term
integrity for speed.
