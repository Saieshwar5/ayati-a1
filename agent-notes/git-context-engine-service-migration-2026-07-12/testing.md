# Testing And Acceptance Plan

## Testing Principle

Test the smallest deterministic component first, then repository integration,
then harness integration, then live daemon scenarios.

Do not use provider calls for deterministic storage tests.

## Service Contract Tests

- Validate every API request and response.
- Reject missing idempotency keys.
- Return the same result for repeated request IDs.
- Reject stale expected HEAD values.
- Return structured errors for locks, missing repositories, dirty worktrees,
  invalid transitions, and unavailable commits.
- Verify MCP adapter cannot reach forbidden lifecycle operations.

## SQLite Tests

- Initialize a fresh database.
- Migrate schema idempotently.
- Persist active conversation before acknowledgement.
- Persist run and step journal.
- Recover WAL after simulated process exit.
- Enforce one task mutation lock.
- Rebuild summary and search caches.
- Reconcile stale cache rows against Git.

## Session Repository Tests

- Create session metadata on main.
- Append ordered user, assistant, and system-event messages.
- Close session-only conversation segments.
- Keep harmless conversation uncommitted but durable.
- Batch pending segments into a later task-run commit.
- Create a safety checkpoint.
- Seal a session with no task mutations.
- Preserve exact history after deinitializing task submodules.

## Task Repository Tests

- Create a canonical bare repository.
- Create task identity commit and durable branch.
- Mount it as a session submodule.
- Modify and verify real files.
- Commit a semantic checkpoint.
- Persist the commit to the canonical repository.
- Remove the working checkout and restore it.
- Reject detached HEAD mutation.
- Reject forced history rewrite.
- Preserve a user-owned AGENTS.md.
- Update only the Ayati-owned descriptor.

## Run Lifecycle Tests

- Direct reply creates no Git run directory.
- Read-only session tools stay session-scoped.
- First mutation promotes the same run ID.
- Pre-promotion steps remain ordered.
- Task run writes run.json and steps.jsonl in the session.
- Purpose is preserved for every persisted tool step.
- Bounded output does not duplicate complete task files.
- Completion success creates final task and session commits.
- Completion rejection allows continuation.
- Maximum steps forces completion verification and finalization.
- Needs-user-input and blocked runs finalize without reopening the run.

## Routing Tests

- Explicit task ID activates exactly that repository.
- Exact canonical resource ownership activates its task.
- Same-task file update continues the active task.
- Unrelated new deliverable creates a new task repository.
- Previously created task in another session is found and mounted.
- Two plausible task owners cause clarification.
- Failed routing never falls through to active-task mutation.
- Read-only reference files never establish ownership.
- Semantic similarity can rank but cannot authorize mutation.

## Twenty-Task Session Scenario

Create twenty independent task repositories and use them sequentially in one
session.

Verify:

- Session main branch never switches.
- Every task receives a separate submodule path.
- Only the selected task is mutated.
- Untracked and ignored files do not cross tasks.
- Final session commit records twenty exact gitlinks.
- Search lists compact metadata without loading twenty full histories.
- Reopening any task in a later session preserves full history.

## Cross-Session Scenario

Session A:

    create task
    commit T1 and T2
    session points to T2
    seal

Session B:

    find same task
    mount repository
    start from T2
    commit T3
    session points to T3

Verify:

- Session A still resolves T2.
- Session B resolves T3.
- Task history contains T1, T2, and T3.
- Removing either session checkout cannot remove canonical task history.

## Midnight Tests

- No active run at midnight seals immediately.
- Active session run finishes before rollover.
- Active task run finishes and commits before rollover.
- Post-midnight message is queued for new session.
- Old run remains associated with old session.
- New session receives previous-session carryover.
- Carryover remains prominent until the first new-session commit.
- First new-session commit refreshes and demotes carryover.
- A day containing only harmless conversation is committed at seal.

## Failure Injection

Inject failure after:

1. SQLite conversation append.
2. Markdown conversation write.
3. Task checkout mutation.
4. Verified task mutation staging.
5. Task-run state commit.
6. Canonical task persistence.
7. Run file write.
8. Conversation rename.
9. Session gitlink staging.
10. Session commit.
11. SQLite completion update.
12. Session seal.

For every boundary verify:

- No acknowledged conversation is lost.
- No verified task mutation is lost.
- Retry does not duplicate events or commits.
- Git and SQLite converge after recovery.
- The run ends in one deterministic terminal state.

## Legacy Migration Tests

- Valid legacy task with real files.
- Missing workspace file.
- Read-only attachment reference.
- Generated output.
- Renamed and deleted resource.
- Invalid JavaScript output.
- Contaminated task with unrelated project roots.
- Duplicate migration invocation.
- Interrupted migration.
- Legacy session remains byte-for-byte unchanged.
- New task repository records source provenance.

## Security Tests

- Symlink escaping task checkout.
- Broken symlink.
- Symlink loop.
- Absolute external path without authority.
- Secret file before commit.
- Dependency and build-output exclusion.
- Malicious task ID or repository name.
- Git option injection through paths.
- Unauthorized HTTP client.
- Concurrent mutation lock violation.

## Performance Targets

Initial qualitative targets:

- Active-context cache hit should not invoke deep Git scans.
- Searching twenty tasks should inspect compact index data first.
- Activating one task should not initialize all task submodules.
- Session summary rebuild should be keyed to source HEAD and pending digest.
- SQLite cache deletion and rebuild should complete without modifying Git.

Do not introduce embeddings until lexical and Git-native search is measured.

## Focused Test Commands

Expected test domains:

    pnpm --filter ayati-main exec vitest run tests/context-engine
    pnpm --filter ayati-main exec vitest run tests/ivec
    pnpm --filter ayati-main exec vitest run tests/app
    pnpm --filter ayati-main build

If the service becomes a separate package, add package-specific build and test
commands before broader workspace verification.

## Final Live Evaluation

Run a real daemon scenario:

1. Harmless conversation.
2. Create a coding task.
3. Update it over several turns.
4. Create an unrelated task.
5. Switch back by name and file history.
6. Cross midnight with an active run.
7. Seal and start the next session.
8. Reopen the first task.
9. Verify files, commits, session pointers, run evidence, summary carryover,
   and final responses.

Do not fix discovered runtime bugs during the evaluation itself. Capture them
as evidence first.
