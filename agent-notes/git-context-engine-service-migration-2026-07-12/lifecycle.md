# Session, Conversation, Run, And Task Lifecycles

## Session Lifecycle

Session states:

    open
    -> rollover_pending
    -> finalizing
    -> sealed

The active session is selected by configured timezone, currently
Asia/Kolkata. A session is the daily execution and conversation container. A
task is not limited to one session.

## Conversation Segment Lifecycle

The session has no single ever-growing conversation file.

Every provider-handled turn or serialized run receives one conversation
segment:

    conversations/000004.pending.md

The file contains ordered user, assistant, and system-event messages.

Example:

    # Conversation 000004

    Conversation-Id: C-000004
    Started-At: 2026-07-12T10:15:00+05:30

    ## User

    Add a reservation form to the coffee-shop website.

    ## Assistant

    I will inspect the current task and add the form.

### Append behavior

Each append is:

1. Written to the SQLite message journal.
2. Written to the active Markdown working file.
3. Flushed before the harness receives acknowledgement.
4. Added to the active-context cache.

The message is durable before any Git commit.

### Direct session response

If no mutation occurs:

    000004.pending.md
    -> 000004-session.md

The segment is closed but may remain uncommitted until the next task
finalization, safety checkpoint, shutdown checkpoint, or midnight seal.

### Task run

If the run promotes to task W-0001:

    000004.pending.md
    -> 000004-task-W-0001.md

The final task-run session commit includes this file.

### Why one segment per run

Do not keep unrelated conversation in one active file until a later task
commit. One segment per run gives:

- Accurate task conversation retrieval.
- Simple message sequence ownership.
- Clear system-event ordering.
- Easy hash-based task/session linkage.
- Bounded context compilation.

Several already-closed session-only segments may be committed together by a
later task-run commit.

## Session Run Lifecycle

Every provider-handled turn begins:

    session_run_running

The Git Context Engine returns:

    runId
    sessionId
    conversationId
    runClass = session
    sessionHeadAtStart
    startedAt

SQLite immediately persists the handle.

### Direct reply without tools

    user message
    -> assistant response
    -> close conversation segment
    -> finalize operational run row
    -> no separate Git run file

The conversation is sufficient durable user-facing context.

### Read-only tools

Read-only tool inputs and outputs remain available in the live SQLite run
journal while the run is active.

After a direct response:

- Preserve compact diagnostic metadata according to retention policy.
- Do not create a task.
- Do not write a full Git run directory by default.
- Let the conversation preserve the useful result.
- Re-read external sources later if exact raw data is required.

### Promotion

The first authorized durable mutation transitions:

    session_run_running
    -> task_run_running

The same run ID and conversation ID survive promotion. Pre-promotion read
steps stay ordered in the task-run evidence.

Completed session runs are sealed and cannot be promoted later.

## Task Lifecycle

Task states are represented by Git rather than a canonical state file:

    repository exists
    durable branch HEAD
    current Git tree
    recent finalization commit

### Task creation

At first pending mutation:

1. Allocate a stable task ID.
2. Create the canonical repository.
3. Create an empty initial commit with task identity trailers.
4. Create the durable main branch.
5. Add the task to the catalog.
6. Mount it in the session as a submodule.
7. Acquire the mutation lock.
8. Promote the active run.
9. Execute the mutation.

Selecting a possible new-task target during read-only exploration does not
create a repository.

### Task activation

For an existing task:

1. Resolve the canonical task repository.
2. Verify the durable branch and commit.
3. Add or initialize the current session submodule lazily.
4. Verify the checkout is clean.
5. Acquire the task mutation lock.
6. Bind and promote the active run before mutation.

### Verified task checkpoint

After a verified semantic mutation batch:

    working tree changes
    -> deterministic tool verification
    -> explicit staging
    -> task checkpoint commit
    -> persist commit to canonical task repository

Failed tool operations do not create task commits.

Task commits should be small enough to explain one meaningful change, but a
single multi-file tool call may produce one atomic commit.

### Task finalization

The explicit task-completion system verifies:

- Correct active task authority.
- Declared asset existence and kind.
- Git mutation provenance for the current run.
- Tracked or intentionally handled output.
- Required syntax or domain validation.
- No unresolved failure that invalidates completion.
- Completion criteria.

Success creates a final task-run commit, which may be empty.

Rejection before the run limit returns deterministic missing work and allows
the agent to continue.

At the maximum step limit, task completion runs once and the current verified
state is finalized as done, incomplete, blocked, failed, or needs user input.
The same run is never reopened.

## Task Repository Commit Messages

### Creation

    task: create coffee-shop website

    Task-Id: W-20260712-0001
    Task-Title: Coffee-shop Website
    Created-Session: S-20260712-local
    Ayati-Event: task_created

### Mutation checkpoint

    feat: add reservation form

    Purpose: Let customers request a table.
    Task-Id: W-20260712-0001
    Session-Id: S-20260712-local
    Run: R-20260712-0012
    Conversation-Id: C-000004
    Conversation-Hash: sha256:...
    Verification: passed
    Ayati-Event: task_checkpoint

### Run finalization

    run: complete reservation update

    Task-Id: W-20260712-0001
    Session-Id: S-20260712-local
    Run: R-20260712-0012
    Conversation-Id: C-000004
    Conversation-Hash: sha256:...
    Outcome: done
    Validation: passed
    Summary: Added and validated the reservation form.
    Next: none
    Ayati-Event: task_run_finalized

## Task-Run Files In The Session

Durable task-run evidence belongs to the session repository:

    runs/R-20260712-0012/
      run.json
      steps.jsonl

run.json includes:

- Session, task, run, and conversation identities.
- Start and completion timestamps.
- Outcome.
- Task commit before and after.
- Summary.
- Completion result.

steps.jsonl includes:

- Step number.
- Tool.
- Purpose.
- Bounded input and output.
- Output hash or persisted evidence reference.
- Deterministic verification.
- Created, modified, deleted, and renamed paths.
- Failures and recovery attempts.
- Important WorkState snapshots.

Do not repeatedly store complete task file content in tool outputs. Git already
stores file versions.

## Cross-Repository Finalization

Normal task-run finalization:

1. Close and hash the conversation segment.
2. Write final task-run files in the session working tree.
3. Complete deterministic task validation.
4. Create the task finalization commit with conversation ID and hash.
5. Persist the task commit to the canonical task repository.
6. Update pending transaction phase in SQLite.
7. Rename the conversation segment to its final task name.
8. Append the final assistant response.
9. Stage exact session files and the task gitlink.
10. Commit the session.
11. Mark the transaction committed in SQLite.
12. Refresh session, task, and search caches.
13. Release the task lock.

Session commit:

    session: finalize task run R-20260712-0012

    Session-Id: S-20260712-local
    Conversation-Id: C-000004
    Task-Id: W-20260712-0001
    Task-Before: T5
    Task-After: T8
    Run: R-20260712-0012
    Outcome: done
    Ayati-Event: task_run_committed

The session commit natively points to T8 through the submodule gitlink.

## Session Commit Policy

Normal session commits are limited to:

### Task-run finalization

Commits pending conversation, run evidence, assistant response, and updated
task gitlink.

### Safety checkpoint

Used only when:

- Too much uncommitted conversation has accumulated.
- A graceful shutdown needs a durable boundary.
- A recovery operation needs a stable point.
- Configured maximum uncommitted age or size is exceeded.

### Session seal

Mandatory at midnight. Commits all remaining session-only conversation and
final task pointers.

Do not commit after every harmless response.

## Derived Session Summary

There is no canonical summary file.

Summary input:

    session HEAD
    committed conversation segments
    pending conversation digest
    session commit messages and trailers
    task-run outcomes

Cache identity:

    sessionId
    sessionHeadSha
    pendingConversationDigest
    summaryAlgorithmVersion

After every session commit:

1. Invalidate the old summary.
2. Build a deterministic summary immediately.
3. Optionally schedule a semantic improvement.
4. Store the projection in SQLite.
5. Expose it through the active-context API.

Exact conversation remains authoritative over summaries.

## Previous-Session Carryover

After sealing session S1 and opening S2:

    current session = S2
    carryover = final derived summary of S1 at sealed HEAD

Until S2 has its first commit, the harness receives the previous summary as
prominent continuity context.

After the first S2 commit:

- Build the S2 summary.
- Demote the S1 summary to lower-priority historical context.
- Stop injecting it automatically when current context is sufficient.

## Midnight Rollover

### No active run

    midnight
    -> commit pending conversation
    -> verify final task gitlinks
    -> seal session
    -> create new session
    -> install carryover summary

### Active run

    midnight
    -> mark rollover_pending
    -> stop assigning new runs to old session
    -> allow active run to finish
    -> complete task and session finalization
    -> seal old session
    -> create new session

Messages arriving after midnight while a run is active are queued for the new
session. They must not join the old run.

The run belongs to the session in which it started.

## Multi-Session Task Continuity

Task repository history:

    T1 -- T2 -- T3 -- T4

Session pointers:

    Monday session -> T2
    Tuesday session -> T3
    Thursday session -> T4

Old sessions remain reproducible. New sessions advance the canonical task
repository. Closing a session does not convert, move, or duplicate the task.

After session seal:

1. Verify every task checkout is clean.
2. Verify every final task commit exists in the canonical repository.
3. Verify session gitlinks match those commits.
4. Deinitialize populated task checkouts when desired.
5. Retain gitlinks and .gitmodules in session history.

## Recovery

### Conversation written, process crashes

Recover from SQLite WAL and the working Markdown segment. Reconcile by
conversation ID and content hash.

### Task commit exists, session commit missing

    task HEAD = T8
    session gitlink = T5

Recovery:

1. Read the pending transaction.
2. Verify T8 exists on the durable task branch.
3. Verify run and conversation trailers.
4. Verify the conversation content hash.
5. Finish task-run files and the session commit.
6. Mark the run recovered and committed.

### Session commit exists, SQLite is stale

Git wins for completed history. Read session trailers and gitlinks, then repair
SQLite caches and transaction state.

### Dirty task checkout without a checkpoint

Inspect:

- Awaited step journal.
- Tool verification.
- Git diff.
- Mutation provenance.

Commit only verified mutations. Otherwise preserve the isolated checkout and
finalize the run as interrupted or incomplete.

### Missing task commit

Attempt canonical fetch, durable branch resolution, and local reflog recovery.
If unavailable, report durable corruption. The session gitlink SHA alone does
not contain the task objects.

