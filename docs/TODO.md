# TODO

- [ ] Diagnose the `timeline-expanded-100k` visual gate at 1920x1080: total frame
  work reached 11.20 ms at P99 against the 10 ms budget, blocking `pnpm verify`.
- [ ] Validate an authenticated usage-reset redemption with before/after provider
  limits and remaining reset credits. Local reset simulation covers refresh races
  and idempotency but does not establish a live provider-side reset.
- [ ] Record paired authenticated agent runs with the same model, effort,
  service tier, task, and network; compare time to first delta, completed task
  duration, confirmed cached-input tokens, and tool retries, including a
  multi-file refactor through Code Mode. Local benchmarks
  do not establish provider latency or billed-token savings.
- [ ] Run an authenticated 72-hour workload with network interruptions and
  compaction; exercise expanded-history scrolling and live message navigation;
  record retained memory, task correctness, recovery, and cancellation.
  Bounded synthetic soak coverage does not establish multi-day live parity.
- [ ] Configure the four signing secrets in `RELEASE.md` before the first stable
  release when the Authenticode certificate becomes available.
- [ ] Re-evaluate the stable Solid compiler pipeline when Solid 2 and its
  supported OXC-based Vite integration are stable; migrate only after a
  reproducible build benchmark and full compatibility verification.
