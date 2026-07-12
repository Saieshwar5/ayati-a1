# Progress: Independent Git Context Engine Migration

Created: 2026-07-12

## Status

Current status: fourth implementation slice complete. The independent service
also creates, catalogs, verifies, reads, and recovers canonical task
repositories without changing current Ayati runtime behavior.

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

- [x] Read required project documentation and this plan fully.
- [x] Confirm service package/module placement.
- [x] Define API contracts and structured errors.
- [ ] Extract repository operations from the current session store.
- [x] Add SQLite operational journal.
- [x] Start independent local service foundation.
- [x] Add typed Git Context Engine client.
- [x] Store new session context directly on main.
- [x] Add conversation segments and active cache.
- [x] Add canonical task repository store.
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

    per-task session submodules
    -> lazy task checkout mounting
    -> exact session gitlinks
    -> clean durable-branch verification
    -> reopen existing task in a later session

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

### 2026-07-12 Implementation Slice 2

- Added a file-backed ContextDatabase using built-in node:sqlite.
- Added idempotent schema migrations.
- Enabled WAL, foreign keys, busy timeout, and full synchronous durability.
- Added the serialized service write queue.
- Added atomic idempotency records with canonical request hashing.
- Added durable tables for:
  - sessions,
  - conversation segments,
  - messages,
  - runs,
  - run steps,
  - pending finalization transactions.
- Implemented active session creation and deterministic identity.
- Implemented conversation segment ordering and assistant append behavior.
- Implemented one active session run per session.
- Implemented purpose-bearing durable run-step records.
- Implemented active-context reconstruction from SQLite.
- Replaced the contract-only executable with the SQLite-backed service.
- Preserved the contract-only service for transport/error tests.
- Added tests for:
  - database migrations and PRAGMA settings,
  - idempotent retries,
  - conflicting request-ID reuse,
  - conversation ordering,
  - active-run enforcement,
  - run-step context,
  - rollover gating,
  - full process-level restart restoration.
- Verification:
  - pnpm --filter ayati-git-context build
  - pnpm --filter ayati-git-context test
  - Unix-socket persistence and restart smoke test
  - pnpm install --frozen-lockfile --offline
  - pnpm build

### 2026-07-12 Implementation Slice 3

- Added deterministic daily session repository initialization on branch main.
- Added the small committed session/meta.json identity file and initialization
  commit trailers.
- Persisted the real session repository HEAD back into SQLite.
- Added recoverable idempotency states for operations crossing SQLite and the
  filesystem boundary.
- Added the file_sync_operations outbox and replay behavior.
- Added full-segment Markdown rendering for user, assistant, and system-event
  messages.
- Added atomic temp-write, file fsync, rename, and directory fsync behavior.
- Renamed closed harmless segments from NNNNNN.pending.md to
  NNNNNN-session.md without creating a Git commit per reply.
- Added pending conversation messages and content hashes to ActiveContext.
- Added an active-context cache keyed by session HEAD, pending digest, active
  run identity, and recent tool-step revision.
- Added recovery for process interruption after SQLite append and after Git
  repository initialization.
- Added tests for repository identity, main branch, commit count, Markdown
  content, segment rename, pending context, no noisy commits, idempotent replay,
  and partial-repository recovery.
- Verification:
  - pnpm --filter ayati-git-context build
  - pnpm --filter ayati-git-context test (20 tests)
  - pnpm build
  - pnpm test
  - pnpm --filter ayati-main exec vitest run --reporter=dot (1,047 tests)
  - Unix-socket process restart with Git and Markdown inspection

### 2026-07-12 Implementation Slice 4

- Advanced the typed service protocol to version 3.
- Added create-task and get-task HTTP/client/service contracts.
- Added the SQLite tasks catalog with initializing, active, and archived states.
- Added stable daily task ID allocation and filesystem-safe repository slugs.
- Chose bare canonical repositories under dataRoot/tasks as permanent task
  authorities.
- Added deterministic temporary real-checkout bootstrapping and cleanup.
- Added the initial `.ayati/task.md` portable descriptor.
- Added task identity commits with Task-Id, Task-Title, Created-Session, and
  Ayati-Event trailers.
- Added durable main branch and exact catalog-to-repository HEAD verification.
- Added stable descriptor identity verification while allowing later snapshots
  and important paths to evolve.
- Added idempotent retry and startup recovery for interrupted task creation.
- Added tests for contracts, HTTP round trips, catalog records, Git tree and
  trailers, daily sequences, safe slugs, partial bare-repository recovery,
  staging cleanup, evolved descriptors, and HEAD disagreement.
- Verification:
  - pnpm --filter ayati-git-context build
  - pnpm --filter ayati-git-context test (26 tests)
  - pnpm build
  - pnpm test (1,111 total workspace tests)
  - Unix-socket task create/read/retry smoke test across a process restart
  - Bare repository history and descriptor inspection
