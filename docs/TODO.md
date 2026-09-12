# TODO

- [ ] Validate both native notification lanes during rapid minimize/restore,
  background/foreground, and tray hide/show on a Windows desktop with multiple
  monitors, including a newly available reset while the app remains open.
  Regressions cover monitor IPC and timed account notifications; they do not
  exercise live provider changes or the Windows window manager.
- [ ] Add native Responses API authentication and provider selection for the
  requested [Burn API setup](https://docs.google.com/document/d/1lA0QNNTEmw_bYmqhqSH5JHEFZaoBNkgiH53Y53E_lzE/edit?tab=t.6dyc7xfd1fu),
  using `https://burnapi.burnapi-ai.workers.dev/v1` and the application's vault.
  Resolve the live generation blocker before activation: on 2026-09-11, one
  supplied key listed models but both Astra and Sol generation returned HTTP 503;
  the other keys returned `INVALID_API_KEY` and `API_KEY_QUOTA_EXHAUSTED`.
  Confirm a successful Responses tool round trip and explicit model capabilities;
  `/models` lists identifiers without the Codex capability metadata required by
  the current engine. Do not import `.codex` configuration or credentials.
- [ ] Validate an authenticated usage-reset redemption with before/after provider
  limits and remaining reset credits, including a delayed post-reset read with no
  intervening task turn. Local reset simulation covers the authoritative success
  transition, refresh races, failures, and idempotency but cannot spend a live
  provider-side reset credit.
- [ ] Record paired authenticated Sol, Luna, and Astra agent runs with the same
  effort, service tier, task, and network; compare time to first delta, completed
  task duration, confirmed cached-input tokens (visible in the context-window
  popover cache line), compaction points, and tool retries, including a
  multi-file refactor through Code Mode. Local benchmarks and persisted usage
  snapshots do not establish provider latency or billed-token savings across
  models.
- [ ] Run an authenticated 72-hour workload with network interruptions and
  compaction; exercise expanded-history scrolling and live message navigation;
  include focus changes and typing, pasting, and clearing drafts while following
  the final message and while reading older messages;
  record retained memory, task correctness, recovery, and cancellation.
  Bounded synthetic soak coverage does not establish multi-day live parity.
- [ ] Configure the four signing secrets in `RELEASE.md` before the first stable
  release when the Authenticode certificate becomes available.
- [ ] Re-evaluate the stable Solid compiler pipeline when Solid 2 and its
  supported OXC-based Vite integration are stable; migrate only after a
  reproducible build benchmark and full compatibility verification.
