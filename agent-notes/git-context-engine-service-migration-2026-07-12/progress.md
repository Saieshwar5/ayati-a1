# Progress: Independent Git Context Engine Migration

Created: 2026-07-12

## Status

Current status: architecture and migration plan captured. No runtime
implementation has started from this plan.

Implementation branch:

    refactor/git-context-repository-migration

## Planning Checklist

- [x] Define independent Git Context Engine direction.
- [x] Define Git and SQLite ownership.
- [x] Define session repository layout.
- [x] Define independent task repository layout.
- [x] Define one-submodule-per-task session model.
- [x] Define conversation segment lifecycle.
- [x] Define session-run and task-run persistence.
- [x] Define task and session commit contracts.
- [x] Define previous-session carryover.
- [x] Define midnight rollover.
- [x] Define cross-repository recovery.
- [x] Define task descriptor direction.
- [x] Define routing and virtual-view direction.
- [x] Define staged legacy migration.
- [x] Define testing and acceptance plan.

## Implementation Checklist

- [ ] Read required project documentation and this plan fully.
- [ ] Confirm service package/module placement.
- [ ] Define API contracts and structured errors.
- [ ] Extract repository operations from the current session store.
- [ ] Add SQLite operational journal.
- [ ] Start independent local service.
- [ ] Add typed Ayati client.
- [ ] Store new session context directly on main.
- [ ] Add conversation segments and active cache.
- [ ] Add canonical task repository store.
- [ ] Mount task repositories as session submodules.
- [ ] Add task checkout mutation boundary.
- [ ] Add verified task checkpoint commits.
- [ ] Persist task-run evidence in session repository.
- [ ] Add cross-repository finalization.
- [ ] Add crash recovery.
- [ ] Add midnight rollover and previous-session carryover.
- [ ] Derive context and summaries from Git plus live SQLite.
- [ ] Replace task-state routing with repository ownership routing.
- [ ] Add optional MCP adapter.
- [ ] Add legacy migration tool and read-only adapter.
- [ ] Cut over all new writes.
- [ ] Remove legacy writers and task-state reducers.
- [ ] Add durable collections and smart views.
- [ ] Run deterministic, integration, failure-injection, and live tests.
- [ ] Update stable project-docs after behavior is implemented and stable.

## First Implementation Slice

Before editing runtime behavior, the first slice should:

1. Decide whether the service is a new pnpm package or isolated backend
   process.
2. Define typed API contracts.
3. Define structured error codes and idempotency.
4. Define repository and SQLite interfaces.
5. Add contract tests.
6. Keep current context-engine behavior unchanged.

Expected first-slice files should be stated to the user before implementation.

## Progress Log

### 2026-07-12

- User chose a task-centric Git model.
- User chose an independent Git Context Engine using Git and SQLite.
- Agreed the harness should not change its core execution model.
- Agreed sessions are daily and seal at midnight after active work finishes.
- Agreed new sessions receive previous-session carryover until their first
  commit.
- Agreed conversation uses multiple segments and derived cached summaries.
- Agreed tasks are independent repositories mounted as per-session submodules.
- Agreed tasks can evolve across any number of sessions.
- Agreed detailed task-run evidence belongs to the session repository while
  actual task files belong to the task repository.
- Captured the complete architecture, lifecycle, migration, testing, and
  recovery plan in this directory.

