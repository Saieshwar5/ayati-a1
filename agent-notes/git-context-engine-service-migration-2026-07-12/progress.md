# Progress: Independent Git Context Engine Migration

Created: 2026-07-12

## Status

Current status: first implementation slice complete. The independent package
and transport contracts exist without changing current Ayati runtime behavior.

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
- [x] Confirm service package/module placement.
- [x] Define API contracts and structured errors.
- [ ] Extract repository operations from the current session store.
- [ ] Add SQLite operational journal.
- [x] Start independent local service foundation.
- [x] Add typed Git Context Engine client.
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

Completed:

1. Created the top-level ayati-git-context workspace package.
2. Defined typed identity, session, conversation, run, context, and health
   contracts.
3. Defined structured errors and required idempotency request envelopes.
4. Added the transport-neutral GitContextService interface.
5. Added dependency-free HTTP/JSON server support for Unix sockets and TCP.
6. Added the typed GitContextClient.
7. Added a contract-only executable that reports degraded readiness.
8. Added contract and transport tests.
9. Kept current Ayati context-engine and harness behavior unchanged.

Next slice:

    SQLite operational journal
    -> durable active session identity
    -> idempotency records
    -> conversation and run journal foundation

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

### 2026-07-12 Implementation Slice 1

- Added ayati-git-context as a pnpm workspace package.
- Added root development and start scripts.
- Added public contract types and request validators.
- Added structured Git Context Engine errors.
- Added the injected service interface.
- Added Unix-socket and TCP HTTP server transport.
- Added a typed client using the same service interface.
- Added a contract-only executable with honest degraded health.
- Added tests for:
  - request validation,
  - structured errors,
  - TCP round trips,
  - Unix-socket round trips,
  - invalid transport input,
  - service-not-ready errors,
  - socket cleanup.
- Verification:
  - pnpm --filter ayati-git-context build
  - pnpm --filter ayati-git-context test
  - executable Unix-socket health smoke test
  - pnpm build
