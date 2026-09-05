# TODO

- [ ] Record paired authenticated agent runs with the same model, effort,
  service tier, task, and network; compare time to first delta, completed task
  duration, confirmed cached-input tokens, and tool retries, including a
  multi-file refactor through Code Mode. Local benchmarks
  do not establish provider latency or billed-token savings.
- [ ] Configure the four signing secrets in `RELEASE.md` before the first stable
  release when the Authenticode certificate becomes available.
- [ ] Re-evaluate the stable Solid compiler pipeline when Solid 2 and its
  supported OXC-based Vite integration are stable; migrate only after a
  reproducible build benchmark and full compatibility verification.
