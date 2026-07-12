# Progress: Independent Git Context Engine Migration

Created: 2026-07-12

## Status

Current status: eighth implementation slice complete. The independent service
now persists bounded task-run evidence into the session repository without
changing current Ayati runtime behavior.

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
- [x] Mount task repositories as session submodules.
- [x] Add task checkout mutation boundary.
- [x] Add verified task checkpoint commits.
- [x] Persist task-run evidence in session repository.
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

    cross-repository task-run finalization
    -> close and hash the task conversation segment
    -> render final run outcome into run.json
    -> create the final task-run commit
    -> stage conversation, evidence and task gitlink
    -> commit the session exactly once
    -> seal the run and release finalization ownership

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

### 2026-07-12 Implementation Slice 5

- Advanced the typed service protocol to version 4.
- Added mount-task HTTP/client/service contracts with expected task HEAD.
- Added the SQLite session_task_mounts operational journal and recovery states.
- Added lazy submodule mounting at tasks/<task-id>.
- Added portable relative `.gitmodules` URLs targeting canonical sibling task
  repositories.
- Kept task checkouts attached to the durable main branch.
- Verified canonical origin, clean status, exact checkout HEAD, and exact
  160000 session-index gitlink before acknowledging a mount.
- Kept session HEAD unchanged during mounting so finalization retains commit
  ownership.
- Added restart recovery from SQLite-only mounts and missing working checkouts.
- Refused dirty, symlinked, unrelated, mismatched-origin, and mismatched-HEAD
  checkout states without destructive resets.
- Extracted task lifecycle orchestration from the broad SQLite service into a
  focused TaskLifecycleService.
- Added tests for contracts, HTTP round trips, lazy selection, idempotency,
  relative URLs, branch attachment, Git index pointers, cross-session reuse,
  crash recovery, missing checkout restoration, and dirty-checkout safety.
- Verification:
  - pnpm --filter ayati-git-context build
  - pnpm --filter ayati-git-context test (33 tests)
  - pnpm build
  - pnpm test (1,118 total workspace tests)
  - Unix-socket create/mount/retry smoke test across a process restart
  - Session HEAD, 160000 gitlink, attached branch, clean checkout, and relative
    `.gitmodules` inspection

### 2026-07-12 Implementation Slice 6

- Advanced the typed service protocol to version 5.
- Added acquire-mutation-authority and verify-mutation lifecycle contracts.
- Added the SQLite task_mutation_authorities lock and verification journal.
- Added atomic active-run promotion from session to task ownership.
- Added token-protected, idempotent, run- and task-scoped mutation authority.
- Added bounded file/directory targets with canonical absolute resolutions for
  the harness tool executor.
- Added portable path validation, checkout containment, and symlink resolution.
- Rejected checkout-root, `.git`, `.ayati`, absolute, traversal, broken-link,
  looping-link, and external-link mutation targets.
- Added Git-derived created, modified, deleted, exact-rename, untracked,
  ignored, and unexpected-path provenance.
- Added deterministic verified, released, and recovery-required authority
  transitions for successful, failed, partial, and no-change tools.
- Preserved verified locks for the next checkpoint-commit slice.
- Added tests for contracts, HTTP transport, run promotion, lock hashes,
  idempotent retries after mutation, competing owners, token misuse, path
  attacks, authorized and unexpected changes, failed partial work, checkout
  identity changes, rename detection, and ignored output.
- Verification:
  - pnpm --filter ayati-git-context build
  - pnpm --filter ayati-git-context test (45 tests)
  - pnpm build
  - pnpm test (1,130 total workspace tests)
  - Unix-socket acquire/mutate/verify/retry smoke test across process restart
  - Run promotion, token recovery, resolved target, persisted lock, and exact
    Git provenance inspection

### 2026-07-12 Implementation Slice 7

- Advanced the typed service protocol to version 6.
- Added checkpoint-mutation HTTP, client, service, and validation contracts.
- Added the task_checkpoint_transactions SQLite phase journal.
- Required a verified, token-owned mutation authority and the owning run's
  conversation identity before checkpointing.
- Re-read and matched live Git provenance immediately before the commit.
- Staged only the exact verified created, modified, deleted, and renamed paths.
- Rejected common secret, dependency, build-output, cache, and log paths before
  creating a task commit.
- Added purpose-rich task checkpoint commits with task, session, run,
  conversation, authority, verification, and event trailers.
- Pushed the checkpoint to the canonical bare task repository.
- Updated the task catalog HEAD and mounted checkout HEAD deterministically.
- Staged the new task gitlink in the session repository while intentionally
  leaving the session HEAD unchanged for later run finalization.
- Released the mutation authority only after all checkpoint phases completed.
- Added retry recovery when a task commit exists but its phase update was
  interrupted, using the authority trailer and exact parent commit.
- Added tests for contracts, HTTP transport, real task commits, canonical HEAD,
  session gitlink state, unchanged session HEAD, idempotent retries, commit
  trailers, task catalog updates, lock release, and secret refusal.
- Verification:
  - pnpm --filter ayati-git-context build
  - pnpm --filter ayati-git-context test (47 tests)

### 2026-07-12 Implementation Slice 8

- Advanced the typed service protocol to version 7.
- Added task-run evidence snapshot HTTP, client, service, and validation
  contracts.
- Added the run_evidence_snapshots SQLite recovery journal.
- Added deterministic full run and ordered step journal readers.
- Added bounded runs/<run-id>/run.json projection with:
  - session, task, run, and conversation identities,
  - trigger, status, and lifecycle timestamps,
  - task HEAD before and after verified checkpoints,
  - reserved final outcome, summary, and completion fields,
  - snapshot time and step count.
- Added bounded runs/<run-id>/steps.jsonl projection with:
  - step, tool, purpose, status, and timestamp,
  - bounded inputs and outputs,
  - output hashes,
  - deterministic verification and mutation provenance,
  - important WorkState snapshots.
- Replaced task-file content bodies with byte counts and SHA-256 identities so
  Git remains the canonical file-content store.
- Added deterministic depth, collection, string, and per-step size limits.
- Wrote both evidence files atomically and staged only their exact paths.
- Verified the session HEAD remains unchanged during evidence persistence.
- Refused snapshots for active, verified-but-uncommitted, or recovery-required
  mutation authorities.
- Kept direct replies and harmless session runs free of Git run directories.
- Added tests for contracts, HTTP transport, task-run ownership, exact staging,
  task HEAD ranges, purpose and verification retention, content omission,
  session HEAD stability, and idempotent retry.
- Verification:
  - pnpm --filter ayati-git-context build
  - pnpm --filter ayati-git-context test (49 tests)
