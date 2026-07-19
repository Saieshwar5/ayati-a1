# Agent Notes

This directory is for user ideas, plans, decisions, and next-action notes that
should guide what the AI agent works on next.

Use this directory for working direction, not stable project documentation.
Agents should read relevant notes here before starting major work when the task
depends on user intent, pending plans, or decisions that are not yet part of the
project's stable docs.

Recommended structure:

- `inbox/`: raw ideas and rough notes from the user.
- `plans/`: planned work the agent can pick up and execute.
- `future-plans/`: deferred problems and improvements to revisit later.
- `decisions/`: user decisions that should guide future implementation work.
- `next-actions/`: direct instructions for what the agent should do next.

Current plans:

- `simple-task-repository-v1-2026-07-17/README.md`: accepted master plan for
  simplifying task continuity around one normal independent Git repository per
  durable workstream, standardized task/request/reference context under
  `.ayati/`, read-any-time access, one verified commit per mutating run, and
  migration away from mandatory bare mirrors and session task submodules. When
  older task-repository topology plans conflict with it, this plan controls new
  implementation. Its main repository path is implemented; read the Reliability
  Closure section in `implementation.md` for the remaining work before V1 can
  be considered complete.
- `git-context-engine-service-migration-2026-07-12/README.md`: master
  migration plan for making Git Context Engine an independent Git-and-SQLite
  service, storing daily conversation and task-run evidence on session main,
  creating every task as an independent repository mounted as a per-session
  submodule, deriving summaries and task context from Git, handling midnight
  rollover, and migrating legacy task branches without rewriting historical
  sessions.
- `run-context-workstate-compaction-2026-07-06/README.md`: master plan for
  making `context.run` carry deterministic reducer-built work state, recent
  raw or near-raw tool input/output, tool-type-specific compacted step context,
  and refs to full persisted step records.
- `conversation-task-run-lifecycle-2026-07-05/README.md`: master plan for
  defining conversation/enquiry, task, and run lifecycles, sharpening read-only
  enquiry versus durable task work, correcting active done-task follow-up
  routing, and making task-run git finalization deterministic.
- `read-routing-workrun-lifecycle-2026-07-03/README.md`: next plan for
  separating safe pre-run reading, short task routing, and real work-run
  execution so active-task follow-up work can bind correctly without overusing
  prompts.
- `decisions/dynamic-context-routing-and-git-history.md`: current decision for
  dynamic agent context, pending turn ownership, turn-aware activation tools,
  runtime-owned mutation, custom refs/tags, and rich run history. Prefer this
  file when older notes conflict with it.
- `context-engine-git-native-plan/PLAN.md`: original git-native context engine
  simplification plan.
- `context-engine-git-native-plan/HARNESS_CONTEXT_REWORK_PLAN.md`: harness
  integration plan for hot git context, dynamic task routing, and runtime
  finalization.
- `plans/git-context-reader-tool-plan.md`: git-context read/search tool plan.
- `plans/harness-tool-output-context-emission-plan.md`: tool output, raw
  evidence, and durable evidence manifest plan.
- `plans/search-read-context-first-slice.md`: small active plan to distinguish
  `search_in_files` discovery from `read_files` inspected evidence without a
  new context system or persistence changes.
- `future-plans/artifact-match-precision.md`: deferred plan for making
  git-context task search return precise `matchedArtifacts` instead of every
  artifact that shares broad task-subject terms.

Current implementation snapshot, 2026-06-30:

- Implemented: pending turn envelope, automatic same-task binding,
  turn-aware activate/create/clarify tools, pending-routing tool gate, active
  context refresh after routing, custom refs for active/latest pointers,
  runtime-owned deterministic run finalization, richer run memory, git-context
  tool policy hardening, compact model-facing git context, hot evidence
  retention labels, evidence-only large-output handling, agent-driven
  clarification flow coverage, and context-engine feedback observability for
  pending-turn routing/finalization/commit debugging.
- Still pending in priority order: clarification follow-up resolution, full
  engine-level create-new-task live flow coverage, attachments during
  pending-turn routing, app-level terminal finalization coverage for every
  outcome, system-event parity for pending routing, legacy cleanup, stable
  milestone tags, and only then deeper raw-context lifecycle improvements.

Keep `project-docs/` for what the project is and how it works. Keep
`agent-notes/` for what the user wants the agent to think about, continue, or do
next.
