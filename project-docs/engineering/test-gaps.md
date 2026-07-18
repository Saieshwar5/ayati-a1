# Test Gaps To Watch

The V1 repository and request services have focused deterministic coverage.
The remaining risk is mostly at retry, restart, live model, and external-action
boundaries.

## Highest Priority

- Stable replay identity for model-facing `git_context_create_task` and
  activation calls. Fresh repeated calls currently generate new internal
  operation ids.
- Real daemon/provider acceptance across learning, website, analysis, and
  automation tasks, including reopen after process and day boundaries. Capture
  the V1 feedback lifecycle report for every turn so operator usability is
  evaluated alongside repository correctness.
- Catalog reconstruction or recovery tests when SQLite is missing or damaged.
- Standardized durable outcome/evidence behavior for browser, desktop, remote
  API, and other external computer-use work.

## Cross-Layer Outcomes

- App-level finalization for completed, failed, blocked, needs-user-input,
  run-limit, context-limit, and tool-failure outcomes.
- Crash windows between filesystem mutation, SQLite lifecycle updates,
  `.ayati/` reduction, Git commit, and response delivery.
- Duplicate/reordered client messages and daemon restart during routing or
  finalization.
- Attachment preservation while a turn is unbound, clarification is pending,
  or task selection fails.
- Symlink/path escape tests across every task-scoped mutation tool.
- Session rotation while an independent task remains active across later days.
- Protocol-version mismatch and managed-process restart behavior.

## Broader Runtime Areas

- IVec decision-action-reducer behavior and repair loops.
- Context-pressure compaction without losing task/request ownership.
- System-event parity with chat routing and permission failures.
- Personal memory consolidation and episodic indexing/retrieval.
- File upload/artifact access, WebSocket/CLI contracts, future multi-client
  behavior, plugin normalization, and provider response formatting.

When a change crosses packages, run more than one local test file and inspect
the resulting repository rather than judging success only from mocked return
values.
