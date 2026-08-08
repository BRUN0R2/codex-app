# Task Plan: Codex-style dynamic context compaction

## Goal
Understand the repository and produce an approved, project-native design for automatic dynamic context compaction, without legacy code or backward-compatibility constraints.

## Next Step
Inspect the official bundled ripgrep binary, current native search implementation, packaging, and licensing before designing its replacement.

## Current Phase
Phase 6

## Phases

### Phase 1: Project discovery
- [x] Read repository instructions and architecture documentation
- [x] Map the message, model request, persistence, and error flows
- [x] Identify current context-limit behavior and relevant tests
- [x] Record findings in findings.md
- **Status:** complete

### Phase 2: Requirements clarification
- [x] Summarize discovered constraints and ambiguity
- [x] Ask one focused question about desired product behavior
- [x] Confirm success criteria and scope
- **Status:** complete

### Phase 3: Architecture options
- [x] Propose two or three project-native approaches
- [x] Compare trade-offs and recommend one approach
- [x] Obtain user direction
- **Status:** complete

### Phase 4: Design specification
- [x] Present architecture, data flow, state model, failures, observability, and tests
- [x] Obtain user approval section by section
- [x] Write and self-review the approved design spec
- [x] Commit the approved design spec
- **Status:** complete

### Phase 5: Implementation planning
- [x] Apply the user's autonomous authorization as approval to continue
- [x] Invoke writing-plans
- [x] Produce a detailed TDD implementation plan
- [x] Commit the reviewed implementation plan
- **Status:** complete

### Phase 6: Implementation
- [x] Create an isolated feature branch in the current workspace
- [x] Implement the approved design in small TDD increments
- [x] Update architecture and reference documentation
- [x] Commit each completed logical change
- **Status:** complete

### Phase 7: Verification and delivery
- [x] Run targeted Rust tests
- [x] Run the repository-wide verification command
- [x] Check whether an authenticated provider session is available for live validation
- [x] Audit for regressions, unnecessary caps, duplicate legacy paths, and avoidable large-history latency
- [x] Use focused `rg` searches to confirm the old context-limit path is fully removed
- [x] Review the context diff and worktree state
- **Status:** complete

### Phase 8: Native repository search
- [ ] Inspect the bundled `rg.exe` in the pinned Codex reference and its licensing/version metadata
- [ ] Map the current native tool registry and command-execution safety boundaries
- [ ] Write and self-review a separate focused design and TDD plan
- [ ] Implement typed workspace-confined ripgrep search without shell interpolation or silent fallback
- [ ] Verify cancellation, output bounds, ignore behavior, errors, packaging, and large-repository latency
- **Status:** in_progress

### Phase 9: Selective code intelligence
- [ ] Study Serena and Semble from their primary repositories and verify their actual architecture, costs, and licenses
- [ ] Design one small native retrieval surface that discovers compact results before expanding selected code
- [ ] Evaluate literal, structural, lexical, and semantic routing with measured latency, token delivery, and result usefulness
- [ ] Integrate only proven deterministic components into Rust; keep optional indexing isolated from the core turn path
- [ ] Verify index freshness, cancellation, memory use, language coverage, observability, and quality regressions
- **Status:** pending

## Key Questions
1. Where is the effective conversation context assembled and sent to the model?
2. Which layer knows model context limits and token usage?
3. How are threads, messages, turns, tool events, and errors persisted and rendered?
4. Does the backend/API support native compaction, or must the app summarize locally through a model call?
5. What must remain lossless across compaction: system/developer instructions, tool state, attachments, plans, and recent turns?

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| Analyze and design before implementation | The brainstorming workflow requires explicit design approval before code changes. |
| Use an isolated `.planning` directory | Prevents collisions with other repository work and preserves context across compaction. |
| Avoid changing global Git configuration | The ownership warning can be handled safely per command. |
| Match the official next-submission overflow recovery | The user explicitly chose the Codex App flow; unexpected overflow remains visible, marks usage full, and guarantees pre-turn compaction on the next submission. |
| Use the existing streamed Remote Compaction V2 protocol | It is the stable default in the studied reference and avoids an unnecessary endpoint or dependency. |
| Modularize context policy and compaction | `agent.rs` is already large; focused modules preserve explicit ownership and testability. |
| Do not add a persisted context-ledger table | Existing provider history plus persisted usage markers can reproduce the official accounting with fewer moving parts. |
| Build retrieval in cost order | Native ripgrep is the cheap deterministic base; structural intelligence follows, while semantic indexing is admitted only after measured value. |
| Use discover-then-expand retrieval | Small ranked metadata results reduce prompt cost; source bodies enter context only after explicit selection. |

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|
| Git rejected repository access due to dubious ownership | 1 | Use `git -c safe.directory=<absolute-repo-path>` for read-only Git commands. |
| Targeted Rust command detached during first build | 1 | Track the original verified process and poll completion instead of starting another build. |
| Duplicate Rust test could not be interrupted through unified stdin | 1 | Verified process tree and stopped only the duplicate PowerShell/Cargo process IDs. |
| Planning phase update patch contained a finding-table line from the wrong file | 1 | Re-read the planning files and applied a smaller path-specific patch. |
| Git commit had no configured author identity | 1 | Reused the previous repository commit's author identity via command-scoped `-c` options without modifying Git configuration. |

## Notes
- The user explicitly approved autonomous continuation through design and implementation.
- Preserve unrelated user changes in the worktree.
- Follow repository-local instructions over generic assumptions.
