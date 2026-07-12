# Implementation And Migration Plan

## Migration Strategy

Use a staged cutover, not a big-bang rewrite.

The new Git Context Engine becomes the writer for new-layout sessions only
after its storage, recovery, routing, and context projection pass focused
tests. Historical sessions remain unchanged and readable through a legacy
adapter.

Do not maintain two active write models after cutover.

## Phase 0: Finalize Contracts

Define:

- Git Context Engine client interface.
- HTTP request and response schemas.
- Structured error codes.
- Idempotency behavior.
- Session and task repository paths.
- SQLite operational schema.
- Commit subjects and trailers.
- Conversation file format.
- Task descriptor format.
- Run file format.
- Pending transaction state machine.
- Active context response.

Required transaction phases:

    run_active
    task_commit_prepared
    task_commit_persisted
    session_commit_prepared
    session_commit_persisted
    completed
    recovery_required

Exit criteria:

- Contracts have deterministic validation.
- No contract depends on model-generated hidden fields.
- Source-of-truth ownership is explicit.

## Phase 1: Extract Repository Services

The current Git memory session store mixes repository orchestration, policy,
schema, rendering, state reduction, conversation persistence, and finalization.

Create focused modules:

    context-engine-server/
      server.ts
      client.ts
      api-contracts.ts
      context-service.ts

    git-memory/
      session-repository.ts
      task-repository-store.ts
      task-submodule-manager.ts
      task-commit-metadata.ts
      run-finalization-transaction.ts
      repository-recovery.ts
      task-catalog.ts
      context-projection.ts

    git-memory/legacy/
      legacy-session-reader.ts
      legacy-task-reader.ts

Keep orchestration, Git commands, SQLite persistence, schemas, and rendering
in separate owners.

Do not add more new behavior to the existing large session-store.ts.

Exit criteria:

- Existing behavior passes through extracted adapters.
- No user-visible storage change yet.

## Phase 2: Add SQLite Operational Store

Implement:

- Database initialization and schema migrations.
- WAL mode and foreign keys.
- Idempotency request records.
- Session/run/conversation journal.
- Pending transaction records.
- Task locks.
- Search and summary cache tables.
- Startup reconciliation entry point.

Durability requirements:

- Acknowledged conversation append survives process failure.
- Acknowledged run step survives process failure.
- Retried request IDs cannot duplicate events.
- One lifecycle writer serializes conflicting operations.

Exit criteria:

- Kill-and-restart tests recover active conversation and run state.
- Cache tables can be deleted and rebuilt.

## Phase 3: Run The Independent Service

Add the local server and typed client.

Preferred transport:

    HTTP/JSON over Unix domain socket

Development fallback:

    loopback HTTP with authentication token

The Ayati backend should call the typed client, not import storage
implementation classes directly.

Health endpoints should expose:

- Service availability.
- Active session.
- Database migration status.
- Pending recovery count.
- Repository root health.

Fail closed for mutations when the service is unavailable.

Exit criteria:

- The daemon can start, health-check, and stop the service.
- Client retries preserve idempotency.
- No model-facing MCP dependency exists yet.

## Phase 4: New Session Repository On Main

For new sessions:

- Create the daily Git repository.
- Write session/meta.json.
- Write conversations directly into the session working tree.
- Stop initializing session-store as a submodule.
- Keep exact per-message ordering.
- Preserve session-run allocation and run-first promotion behavior.

Old session repositories remain unchanged.

Exit criteria:

- New casual chat survives task switching.
- No session-store gitlink exists in a new-layout session.
- Legacy session context remains readable.

## Phase 5: Conversation Segments And Cache

Implement:

- Stable conversation IDs and sequence allocation.
- Pending Markdown working files.
- User, assistant, and system-event appends.
- SQLite message journal.
- Session-only and task-related final names.
- Content hashing.
- Pending-segment context compilation.
- Commit batching.
- Safety checkpoint threshold.

Context cache key:

    session HEAD
    pending conversation digest
    active run revision

Exit criteria:

- Multiple harmless turns can remain safely uncommitted.
- A later task-run commit includes prior pending session segments.
- Restart restores the exact active segment.

## Phase 6: Canonical Task Repository Store

Implement:

- Stable task ID allocation.
- Bare canonical task repository creation.
- Empty identity commit.
- Durable main branch.
- .ayati/task.md creation.
- Task catalog locator.
- Repository validation and doctor checks.

Do not create a repository for a draft target until mutation is actually
pending.

Exit criteria:

- A new task exists independently before its first mutation.
- Removing a session checkout cannot remove canonical history.

## Phase 7: Per-Task Session Submodules

Implement:

- Add existing task repository to the current session.
- Lazily initialize only selected tasks.
- Activate named durable task branch.
- Verify clean status and expected HEAD.
- Acquire and release mutation lock.
- Persist exact task gitlink in the session.
- Safely deinitialize closed-session checkouts.

One session may contain any number of task gitlinks.

Exit criteria:

- Twenty tasks can be touched sequentially.
- Final session commit points to all twenty final task commits.
- No untracked or ignored file crosses task boundaries.

## Phase 8: Task-Aware Mutation Boundary

Add ActiveTaskCheckout to execution context:

    taskId
    canonicalRepository
    checkoutPath
    durableBranch
    beforeCommit
    lockToken

Rules:

- Relative mutation resolves inside checkoutPath.
- External mutation requires explicit user authority.
- Symlinks are resolved to real paths.
- Read-only access does not establish ownership.
- Mutation is blocked if task activation or lock validation fails.
- Tool verification emits created, modified, deleted, renamed, or unchanged.

Exit criteria:

- An unrelated new app cannot mutate the active old task.
- Mutation never executes while routing remains unresolved.

## Phase 9: Task Checkpoint Commits

After deterministic verification:

- Stage exact changed paths.
- Build a purpose-rich commit.
- Commit one semantic mutation batch.
- Persist the commit to the canonical task repository.
- Update SQLite task HEAD cache.

Do not commit:

- Failed changes.
- Unverified changes.
- Dependencies and build output.
- Secrets.
- Unrelated dirty paths.

Exit criteria:

- Every successful mutation is recoverable from task Git history.
- Task commit messages include purpose, run, conversation, and verification.

## Phase 10: Task-Run Persistence And Finalization

Write task-run evidence in the session:

    runs/<runId>/run.json
    runs/<runId>/steps.jsonl

Implement:

- Bounded tool input and output persistence.
- Purpose retention.
- Mutation provenance.
- Explicit task-completion result.
- Task finalization commit.
- Session conversation rename.
- Exact session staging.
- Session gitlink commit.
- Cache refresh.

Exit criteria:

- Task commit succeeds before session commit.
- Session commit always points to the final persisted task commit.
- Retry cannot duplicate either commit.

## Phase 11: Recovery And Midnight Rollover

Implement deterministic reconciliation for every pending transaction phase.

Implement the midnight scheduler:

- Mark rollover pending at the timezone boundary.
- Stop assigning new runs to the old session.
- Allow its active run to finish.
- Queue post-midnight messages for the new session.
- Seal pending conversation and task pointers.
- Create the new session.
- Install previous-session carryover.

Exit criteria:

- Failure injection at every commit boundary recovers.
- No active task run is split across sessions.
- A day with no task mutations is still sealed durably.

## Phase 12: Derived Context And Summary

Replace persisted summary files with SQLite projections derived from Git and
pending conversation.

Replace task state projection with:

- Task identity from repository and creation commit.
- Compact description from .ayati/task.md.
- Current HEAD and top-level tree.
- Latest task-run finalization.
- Recent purpose-rich commits.
- Validation state.
- Important paths.
- Recent session usage.

Do not load every repository deeply.

Exit criteria:

- Deleting context caches loses no completed history.
- New-session carryover remains available until first new commit.

## Phase 13: Git-Native Routing And Search

Build candidate search from:

- Task IDs and repository names.
- Task descriptor text.
- Latest commit summaries and trailers.
- File-tree names.
- Path history.
- Session usage.
- Starred/custom collections.
- Recency and frequency.

Use semantic search only to rank unresolved candidates.

Mutation authorization follows exact ownership and explicit user selection,
not similarity score.

Exit criteria:

- Search across twenty tasks reads compact metadata first.
- Existing-task activation is deterministic after candidate selection.
- Ambiguous cross-task requests ask instead of mutating.

## Phase 14: Optional MCP Adapter

After the deterministic API is stable, expose safe MCP tools for model-facing
task discovery and routing intent.

The MCP adapter calls the same service API and owns no storage logic.

Exit criteria:

- Removing the MCP adapter does not break harness finalization.
- MCP cannot call low-level commits or recovery.

## Phase 15: Legacy Data Migration

Do not rewrite legacy repositories.

Create an idempotent migrator with dry-run mode.

For each legacy task branch:

1. Read task identity, objective, recent runs, assets, and commit provenance.
2. Treat state.json and asset metadata as migration hints, not truth.
3. Locate actual workspace resources.
4. Include only verified created or modified task resources.
5. Exclude read-only references, failed paths, and missing resources.
6. Detect unrelated resource roots and possible task contamination.
7. Create the canonical independent task repository.
8. Import verified files.
9. Write the small task descriptor.
10. Create a migration commit with source session, branch, and commit trailers.
11. Verify the new tree and validation health.
12. Register the task repository.
13. Leave the old session untouched.

Contaminated legacy tasks must produce a review report instead of silently
combining unrelated products.

Exit criteria:

- Migration can be rerun safely.
- Missing files produce warnings, not false success.
- Legacy sessions remain readable.

## Phase 16: Cutover

For all new writes:

- Session repository owns conversation.
- Task repository owns real task files.
- SQLite owns live operational state.
- New tasks are independent repositories.
- Existing tasks are mounted as submodules.
- No new parent task branches are created.
- No new state.json or task notes are generated.

Use storage layout detection only below the harness:

    new layout -> new service readers
    legacy layout -> read-only compatibility readers

Do not add a harness version switch.

## Phase 17: Remove Legacy Writers

After sustained acceptance:

- Remove new-write session-store submodule initialization.
- Remove parent task-branch creation.
- Remove canonical GitMemoryTaskStateFile writes.
- Remove task-state reducer and task notes generator.
- Remove task asset pointer duplication where real task files replace it.
- Remove active focus derived from parent task branch.
- Retain legacy readers until historical support is intentionally retired.

## Phase 18: Catalog And Virtual Views

Add durable collections and generated smart views after the repository
foundation is stable.

Do not block the core migration on embeddings, complex ranking, or a large
database search subsystem.

## Expected Code Areas

Existing areas likely to change:

    ayati-main/src/app/chat-turn-runtime.ts
    ayati-main/src/app/git-memory-chat-context-runtime.ts
    ayati-main/src/context-engine/contracts.ts
    ayati-main/src/context-engine/git-memory/git-driver.ts
    ayati-main/src/context-engine/git-memory/runtime.ts
    ayati-main/src/context-engine/git-memory/session-store.ts
    ayati-main/src/context-engine/git-memory/schema.ts
    ayati-main/src/context-engine/git-memory/context-pack.ts
    ayati-main/src/context-engine/git-memory/task-router.ts
    ayati-main/src/context-engine/git-memory/task-run-finalizer.ts
    ayati-main/src/ivec/agent-runner/runner.ts
    ayati-main/src/ivec/agent-runner/task-completion-policy.ts
    ayati-main/src/skills/builtins/git-context/

New service code should have its own package or clearly isolated backend
module. Decide package placement in the first implementation slice after
checking monorepo build and deployment consequences.

## Recommended Commit Sequence

1. document context service contracts
2. extract git repository operations
3. add sqlite context journal
4. start git context engine service
5. store new session context on main
6. add conversation segments
7. add canonical task repository store
8. mount task repositories as submodules
9. scope mutations to task checkouts
10. commit verified task checkpoints
11. finalize cross-repository task runs
12. recover interrupted finalization
13. add midnight session rollover
14. derive active context from git and sqlite
15. route tasks by repository ownership
16. add optional mcp adapter
17. migrate legacy task branches
18. cut over new context writes
19. remove legacy writers
20. add catalog and virtual views

