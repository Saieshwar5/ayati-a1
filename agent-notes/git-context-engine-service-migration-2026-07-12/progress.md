# Progress: Independent Git Context Engine Migration

Created: 2026-07-12

## Status

Current status: MVP runtime and process cutover complete. Ayati now uses the
independent Git Context Engine over HTTP/JSON on a Unix socket for new session,
conversation, session-run, task selection, task-run, mutation checkpoint, and
finalization behavior. The service is a daemon-managed child process and the
legacy embedded Git-memory writer and task-state reducers have been removed.

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
- [x] Stage verified task mutations and commit once at task-run finalization.
- [x] Persist task-run evidence in session repository.
- [x] Add cross-repository finalization.
- [x] Add process crash detection and bounded restart.
- [ ] Add cross-repository transaction replay and deeper crash recovery.
- [ ] Add midnight rollover and previous-session carryover.
- [ ] Derive context and summaries from Git plus live SQLite.
- [x] Replace task-state routing with repository ownership routing.
- [ ] Add optional MCP adapter.
- [ ] Add legacy migration tool and read-only adapter.
- [x] Cut over all new writes.
- [x] Remove legacy writers and task-state reducers.
- [ ] Add durable collections and smart views.
- [ ] Run deterministic, integration, failure-injection, and live tests.
- [x] Update stable project-docs for the independent process boundary.

## MVP Cutover Boundary

Completed in the current slice:

- Ayati main starts one Git Context Engine child, waits for compatible
  readiness, and injects its typed socket client into chat, system-event,
  skill, and tool-execution paths.
- The model-facing task API is exactly two tools: create a new task repository
  or activate an existing task repository.
- Task candidates and Git-derived task context are supplied in the context
  pack; no session-global active task authorizes mutation.
- Direct mutation is deferred without creating a session run. A read-only run
  is created only when a read-only tool actually executes and is promoted in
  place if task work follows.
- Relative task tool paths are scoped to the selected task checkout.
- Mutations acquire authority, run deterministic verification, and create a
  verified task checkpoint before the agent continues.
- Full step input, output, verification, purpose, and WorkState are recorded in
  SQLite and exposed through active run context.
- Task completion finalizes the independent task repository first, then writes
  task conversation and run evidence and commits the session gitlink.
- The old embedded git-memory directory, adapters, legacy task tools, task
  state files, reducers, writers, and compatibility tests are deleted.

Still outside the MVP:

- crash/failure-injection recovery coverage for every cross-repository phase;
- midnight rollover and previous-session carryover;
- richer Git-native task ranking and virtual collections;
- optional MCP adapter and remote/loopback deployment (normal Ayati startup now
  uses the local HTTP client over a Unix socket);
- stable project documentation and live daemon acceptance testing.

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

    crash recovery and startup replay
    -> scan unfinished checkpoint, evidence and finalization journals
    -> resume from the last durable Git/SQLite phase
    -> classify irreconcilable state as recovery_required
    -> prove every injected failure converges without duplicate commits

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

### 2026-07-12 Implementation Slice 9

- Advanced the typed service protocol to version 8.
- Added task-run finalization HTTP, client, service, and validation contracts.
- Added a precise deterministic completion record containing accepted status,
  verified assets, missing work, failures, and completion criteria.
- Enforced that done requires accepted completion evidence and passed
  validation; every other outcome requires rejected completion evidence.
- Added the task_run_finalizations SQLite phase journal with prepared,
  conversation, task, session, and completed durability phases.
- Appended the final assistant response, closed the owning conversation, renamed
  it to its task-qualified path, rendered it atomically, and persisted its hash.
- Created an empty task-run finalization commit with task, session, run,
  conversation, outcome, validation, summary, next-action, and event trailers.
- Pushed the finalization commit to the canonical bare task repository.
- Updated the task catalog, mounted checkout, and staged session gitlink to the
  exact final task commit.
- Re-rendered run.json with terminal outcome, validation, completion evidence,
  summary, next action, completion time, and final task HEAD.
- Staged only owned conversation, run evidence, .gitmodules, and selected task
  gitlink paths; rejected unrelated staged session files.
- Created one purpose-rich session commit that natively records the final task
  gitlink together with its conversation and run evidence.
- Updated SQLite run, conversation, session HEAD, and transaction state only
  after the task and session commits were durable.
- Mapped done and incomplete to a completed compute run while preserving their
  distinct task outcomes; failed, blocked, and needs-user-input remain explicit
  terminal run statuses.
- Added commit-trailer/parent based retry recovery for interruptions after task
  or session commit creation, plus completed-transaction retry recovery.
- Added tests for contracts, HTTP transport, exact Git histories, canonical task
  persistence, final conversation content/hash, terminal run evidence, session
  commit ownership, SQLite terminal state, and idempotent retry.
- Verification:
  - pnpm --filter ayati-git-context build
  - pnpm --filter ayati-git-context test (50 tests)

### 2026-07-12 Implementation Slice 10

- Added a complete internal SessionRecord containing stable identity,
  operational status, previous-session identity, timestamps, repository path,
  and current Git HEAD.
- Added SessionRegistryCache with session-ID and live-agent indexes.
- Hydrated live session records synchronously from SQLite when the service
  process starts.
- Added cache-on-miss for explicitly requested historical sessions.
- Changed active-session and open-session resolution to use the registry cache
  instead of querying SQLite on every operation.
- Limited repository/meta.json verification and external-state reconciliation
  to one successful startup pass per service process.
- Kept mutation and finalization boundary verification unchanged.
- Updated the registry only after session repository initialization, SQLite HEAD
  persistence, or completed task-run finalization succeeds.
- Added HEAD, status, removal, and clear cache operations for later rollover
  integration.
- Included session status in ActiveContext cache revisioning so lifecycle
  transitions cannot reuse a stale prepared context.
- Kept SQLite and Git as the durable restart sources; no missing-SQLite recovery
  or disk-backed cache was added.
- Changed interrupted mount recovery tests to restart the service, matching the
  new startup-recovery boundary.
- Added tests proving:
  - live sessions hydrate from SQLite,
  - repeated reads return the cached record,
  - a fresh cache sees durable HEAD changes,
  - HEAD/status updates change the registry correctly,
  - sealed sessions leave the live-agent index,
  - normal context reads do not repeatedly read immutable Git metadata,
  - task-run finalization refreshes the cached session HEAD.
- Verification:
  - pnpm --filter ayati-git-context build
  - pnpm --filter ayati-git-context test (53 tests)

### 2026-07-12 Implementation Slice 11

- Added ConversationHotCache for active and closed-but-uncommitted conversation
  segments only.
- Hydrated the hot cache from SQLite when the service starts and on explicit
  cache misses.
- Changed user, assistant, and system-event append flow to:
  - persist the segment/message transaction in SQLite,
  - refresh the uncommitted conversation cache,
  - invalidate prepared ActiveContext,
  - return without writing a conversation file.
- Removed new per-message file_sync_operations and repeated Markdown rendering.
- Kept the old file-sync table and one-time startup replay only for compatibility
  with journal entries created by earlier migration slices.
- Added a live message-content hash in the cache so pending context revisions
  change before a Markdown file exists.
- Changed getActiveContext to source pending conversation messages and refs from
  the hot cache before checking the prepared ActiveContext cache.
- Added explicit task-finalization materialization that renders one complete
  task conversation Markdown file, writes it atomically, and stores its final
  rendered SHA-256 hash.
- Changed task-run session commits to include only the owning task conversation,
  run evidence, .gitmodules, and task gitlink.
- Changed committed-state reduction to mark and evict only the finalized task
  conversation; unrelated harmless conversations remain uncommitted and hot.
- Refreshed the conversation cache in a finally boundary when task finalization
  closes conversation state, including failed finalization attempts.
- Added tests proving:
  - user and assistant context is served from uncommitted state,
  - system events update the same cache path,
  - no pending or session Markdown file is created per message,
  - restart rebuilds uncommitted context from SQLite,
  - new appends create no file-sync journal records,
  - the task conversation file does not exist before finalization,
  - finalization materializes and commits it once,
  - committed task conversation leaves the hot cache.
- Verification:
  - pnpm --filter ayati-git-context build
  - pnpm --filter ayati-git-context test (54 tests)

### 2026-07-12 Implementation Slice 12

- Advanced the typed service protocol to version 9.
- Added a required bounded conversationSummary to task-run finalization while
  retaining summary as the verified task-work summary.
- Persisted conversationSummary in the recoverable task-run finalization
  journal, with backward fallback for older rows.
- Changed task conversation materialization from one segment to the complete
  active/closed uncommitted conversation window since the previous session
  commit.
- Added a task conversation window header containing task, run, previous
  session HEAD, and conversation sequence range, followed by every original
  conversation with roles, IDs, ordering, content, and timestamps preserved.
- Continued to create only one Markdown file at task-run finalization.
- Marked all closed conversations in the committed window with the same session
  commit SHA and removed them together from ConversationHotCache.
- Redesigned task-run session commit messages with:
  - a work-derived subject,
  - a Conversation section,
  - a Task work section,
  - verified asset paths and descriptions,
  - outcome and validation,
  - session, conversation, task, run, and task-HEAD trailers.
- Added SessionSummaryHotCache derived exclusively from session Git log.
- Excluded session initialization commits from work history.
- Kept the five newest task-run session commits as detailed parsed records,
  including the exact raw commit message.
- Compacted every older session commit into a one-line work/outcome summary.
- Hydrated the summary cache at startup/new-session repository verification and
  refreshed it after every successful task-run session commit.
- Invalidated the derived cache rather than failing durable finalization if a
  post-commit cache refresh fails.
- Filled ActiveContext session.summary and recentCommits from the new cache.
- Extracted session validation, agent-ID normalization, and expected-HEAD policy
  into a focused module to keep the SQLite service below 600 lines.
- Added tests proving:
  - multiple conversations become one task conversation commit window,
  - all committed-window conversations receive the session commit SHA,
  - conversation/work/asset commit context is durable in Git,
  - committed conversations clear from the hot cache,
  - the newest five commits retain detailed raw data,
  - older commits become compact summaries,
  - a fresh cache rebuilds the same summary from Git after restart.
- Verification:
  - pnpm --filter ayati-git-context build
  - pnpm --filter ayati-git-context test (55 tests)

### 2026-07-13 Implementation Slice 13

- Advanced the typed service protocol to version 10.
- Made session runs harness-requested and initialized them with an explicit
  reducer-owned WorkState.
- Added the run_work_state table with explicit revision, step boundary, status,
  summary, open work, blockers, facts, evidence, artifacts, next step, and
  required user-input fields.
- Changed run-step persistence to store complete structured tool inputs,
  outputs, output hashes, and verification payloads without summarization.
- Added tool schema version and read-only/mutating effect metadata to every
  durable step.
- Enforced that unpromoted session runs accept only read-only tool steps.
- Updated each step, its current WorkState, and run step count atomically in the
  same SQLite/idempotency transaction.
- Added RunContextHotCache, hydrated from SQLite after restart and refreshed
  after every step, containing the full active run, WorkState, and ordered raw
  step history for the next agent decision.
- Reworked ActiveContext run projection to return that complete cached context
  instead of only eight compact tool-call headers.
- Added session-run finalization HTTP/client/service contracts and a recoverable
  SQLite phase journal.
- Required final session WorkState to be done and required at least one
  read-only tool step before session-run completion.
- Appended the final assistant response and closed its session conversation
  deterministically during finalization.
- Wrote uncommitted runs/<run-id>/run.json and steps.jsonl files atomically with
  the complete WorkState and raw tool evidence, without creating a Git commit.
- Marked the run completed only after both files were durable and removed it
  from the hot cache afterward.
- Kept task-run file projection compatibility while making shared SQLite step
  storage complete.
- Raised configurable HTTP default body/response guards to 16 MiB so normal
  full-context run payloads are not prematurely bounded.
- Added tests proving exact WorkState columns, atomic revisions, full large tool
  output retention, hot-context projection, restart reconstruction, read-only
  enforcement, session-run files, no extra Git commit, transport round trips,
  and idempotent finalization.
- Verification:
  - pnpm --filter ayati-git-context build
  - pnpm --filter ayati-git-context test (58 tests)

### 2026-07-13 MVP Runtime Cutover

- Advanced the service protocol to version 11.
- Added high-level create-task-run and activate-task-run operations that mount
  one task repository and either start a task run directly or promote the
  current read-only session run without changing its run ID.
- Added Git-derived task context and compact task candidates to ActiveContext.
- Connected Ayati chat and system-event persistence to the new service.
- Replaced the legacy model-facing Git context skill with only create-task and
  activate-task tools using precise schemas and purpose-bearing reasons.
- Added task-scoped execution with mutation authority, deterministic mutation
  verification, and verified checkpoint commits.
- Removed silent active-task auto-binding and session-run allocation for a
  deferred direct mutation.
- Removed the embedded legacy git-memory implementation and its tests.
- Added high-level selection/finalization integration tests and task-scoped
  executor coverage.

### 2026-07-13 Independent Process Cutover

- Replaced direct `ContextDatabase` and `SqliteGitContextService` construction
  in the Ayati daemon with the typed `GitContextClient` service boundary.
- Added a daemon-owned process supervisor that starts the server, waits for
  health and exact protocol compatibility, and stops it with Ayati.
- Kept externally supervised operation available with managed mode disabled.
- Added a single-writer database lock with stale-owner recovery.
- Refused to delete a Unix socket while another live server owns it.
- Added parent-process monitoring so an orphaned context server shuts down.
- Added one bounded restart after an observed child crash. The original typed
  operation and request ID are repeated once, preserving idempotent writes.
- Added configurable database, Git data-root, socket, managed-mode, readiness,
  shutdown, and request-timeout settings.
- Added tests for socket readiness, writer exclusion, cleanup, managed
  start/stop, external ownership, and abrupt-child restart.
- Updated stable environment and architecture documentation.

### 2026-07-13 Two-level Context Cache

- Advanced the service protocol to version 12 with an explicit deterministic
  `ActiveContext.contextRevision`.
- Included session HEAD/status, pending-conversation hashes, active run and
  WorkState revisions, and task catalog HEADs in cache coherence.
- Kept the Git Context Engine cache authoritative and continued updating its
  focused session, conversation, run, summary, and aggregate caches only after
  durable operations.
- Added a daemon-owned per-session harness context mirror created at startup.
- Warmed the harness mirror from the latest live context during daemon startup.
- Reused unchanged model-ready projections without repeated socket calls.
- Marked mirrors dirty immediately at conversation, run, tool-step, routing,
  and finalization boundaries instead of serving possibly stale context.
- Required dirty refreshes to drain queued step persistence before fetching
  and atomically replacing the authoritative snapshot.
- Added tests for revision changes, unchanged aggregate reuse, harness mirror
  reuse, dirty-state refusal, and write-before-refresh ordering.

### 2026-07-13 Live-test Observability

- Added a versioned, redacted structured observability contract shared by the
  Git Context Engine, HTTP transport, daemon supervisor, and harness runtime.
- Propagated a trace id across every typed HTTP request and kept session, run,
  task, conversation, sequence, and step identifiers on relevant events.
- Instrumented process readiness, writer-lock recovery, startup recovery,
  shutdown, unexpected exit, bounded restart, and request retry.
- Instrumented authoritative cache hits/misses/builds/invalidations and harness
  cache creation, warming, hits/misses, revisions, refreshes, and failures.
- Instrumented task repository creation/validation/mounting, session-to-task
  promotion, mutation authority and verification, checkpoint commits, run-step
  persistence, WorkState revisions, and both session/task finalization.
- Forwarded child-process JSON events and harness events into the existing live
  feedback ledger without copying raw tool/file payloads into observability.
- Extended feedback summaries and triage with cache health, context revisions,
  run class, promotion, last persisted step, WorkState revision, refresh
  failures, and persistence failures.
- Added `pnpm feedback:git-context` to render a correlated timeline, aggregate
  counts, and deterministic missing-pair/failure findings from the latest or a
  selected feedback JSONL file.
- Added observability, redaction, lifecycle, restart, and cache-stat tests.

### 2026-07-14 Verified Read Context Window

- Advanced the Git Context Engine protocol to version 13.
- Added a separate `readContext` section to authoritative ActiveContext and the
  harness projection without copying raw reads into WorkState.
- Derived the working set deterministically from verified filesystem read
  steps after the latest completed task-run commit.
- Preserved reads across completed session runs and session-to-task promotion.
- Replaced repeated observations of the same tool/resources and invalidated
  observations affected by later verified mutations.
- Reset the active working set after successful task finalization while
  retaining complete raw run history in SQLite and run evidence files.
- Reconstructed the same window from run sequence and task-finalization state
  after process restart, without adding another authoritative table.
- Avoided duplicating active-run read output in both `readContext` and
  `context.run.toolCalls`.
- Added cache-build and task-finalization observability for read-context count,
  revision, boundary, and reset.
- Added focused tests for completed session reuse, restart reconstruction,
  promotion continuity, replacement, mutation invalidation, commit reset,
  harness caching, and prompt deduplication.
- Made run-step recording await durable service acknowledgement and an
  authoritative harness-context refresh before the next model decision.
- Kept complete reusable read output only in the model-facing `readContext`;
  matching active-run tool calls now retain compact purpose/status/source and
  `readContextKeys` references instead of duplicating full output.

### 2026-07-14 Task Resource Root Correction

- Added a trusted runtime-only task resource scope sourced from the selected
  task checkout.
- Made filesystem reads/writes/search, shell cwd resolution, and managed Python
  cwd/path resolution use the trusted task root during task runs.
- Removed model-provided `allowExternalPath` at the task boundary and reject
  task mutation paths outside the selected checkout before authority is
  requested.
- Added a read-only validation path for `node --check` so JavaScript syntax can
  be verified in the task checkout without invalid repository-wide mutation
  authority.
- Made task completion resolve declared assets against the same active task
  checkout used for execution.
- Kept checkout paths available to trusted runtime code while projecting task
  assets as durable task-relative paths to the model.
- Changed finalization asset flags so an incomplete/rejected task run does not
  label generated assets as completion-verified.
- A durable user-workspace resource-binding mechanism remains separate work;
  this correction makes task-owned execution internally consistent without
  copying task files into a second source of truth.

### 2026-07-14 Commit-Based Task State

- Advanced the Git Context Engine protocol to version 14.
- Kept the task bootstrap identity commit required for a mountable repository.
- Replaced per-tool task checkpoint commits with verified Git-index staging.
- Kept task checkout HEAD, canonical HEAD, catalog HEAD, and session gitlink
  unchanged throughout an active task run.
- Made task-run finalization reject unstaged or untracked task changes and
  create the run's single durable task commit from all verified staged paths.
- Added a compact versioned task-state commit contract containing cumulative
  state, task status, validation, next action, and run/session/conversation
  identity.
- Made later task activation reconstruct its current state from the newest
  valid task-state commit, with legacy commit parsing retained for reads.
- Added integration coverage proving that two verified mutating steps create
  no intermediate task commit and become one final commit.

### 2026-07-14 Session Commit Prompt Continuity

- Advanced the Git Context Engine protocol to version 15.
- Confirmed the service cache already retained the newest five complete session
  commits and deterministically summarized older commits.
- Parsed asset paths and descriptions from session commit messages so the
  cache reconstructs them after restart without SQLite dependence.
- Preserved conversation summary, work summary, assets, outcome, validation,
  task identity, and run identity through the harness projection.
- Added `context.git.session.recentCommits` to the normal provider-facing
  prompt instead of silently dropping the latest committed context.
- Updated decision guidance to use recent commits for follow-up answers before
  repeating tools or claiming recent work is unknown.
- Updated prompt-only session shedding to retain the newest session commit while
  removing the older four under context pressure.
- Added provider-facing regression coverage proving a committed file list is
  visible when the next user asks a follow-up question.

### 2026-07-15 Stable Task Working Directories

- Advanced the Git Context Engine protocol to version 16.
- Added one durable working directory identity to every task and session mount.
- Made an explicitly requested directory the real task Git checkout; relative
  `workspace/` and `work_space/` prefixes resolve from the configured workspace.
- Added an isolated `workspace/tasks/<task-id>-<slug>` default when the user
  does not choose a directory.
- Kept the session submodule checkout solely as a native gitlink pointer and
  made tool execution, mutation authority, validation, and task completion use
  the stable working directory.
- Made finalization commit and push from the working directory, then
  fast-forward the session pointer checkout before committing the session.
- Added the working directory to task candidates, active task context, routing
  results, and session commit trailers without exposing the internal pointer
  checkout as a model-facing path.
- Added focused integration coverage proving a requested workspace directory
  remains the task checkout across mutation and finalization.
