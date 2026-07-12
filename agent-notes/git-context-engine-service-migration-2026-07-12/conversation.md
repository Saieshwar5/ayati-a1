# Planning Conversation Record

This file preserves the direction and reasoning that led to the final plan. It
is a structured record rather than a verbatim transcript.

## Initial File-First Direction

The user first proposed:

- A default agent workspace when the user does not provide a path.
- One isolated directory per task, even for a single output file.
- Actual files should live outside Git context memory with pointers in task
  state.
- Created and modified files should be first-class task resources.
- Read-only files should not establish task ownership.

Review of the current engine showed:

- A global workspace root already exists.
- No authoritative task-owned workspace root exists.
- Task creation does not allocate a task directory.
- Task routing can fall through to an unrelated active task.
- Created and modified files are not always classified precisely.
- Task state accumulates metadata and evidence that can disagree with files.

## Git As End-To-End Memory

The user then simplified the principle:

    everything is in Git
    task is Git history
    every commit is task state
    every task file is context

The proposed daily design initially used:

- One temporary daily repository.
- Session task branches.
- Actual task files committed on those branches.
- Branches exported as independent task repositories at session close.

Discussion established:

- Branches created from another task inherit that task's files and history
  even without a merge.
- Independent tasks should not accidentally inherit unrelated task ancestry.
- A symlink records only its target path, not the target directory contents.
- Git worktrees or real repositories are needed when external contents must be
  versioned.

## Parent And Submodule Direction

The current engine stores session conversation in the submodule and task
branches in the parent repository.

The user proposed the inverse:

    main repository = session conversation and runs
    submodule repository = task branches and real task files

Submodule behavior was clarified:

- A parent commit stores an exact child commit SHA.
- Switching the parent can change the expected child checkout.
- Switching the child does not modify parent files; it makes the gitlink dirty.
- A gitlink does not contain child objects.
- Child commits must remain in a durable repository or named ref.

The proposed inverse felt more natural for a task-centric agent, but a single
task-store submodule could point to only one active task commit at a time.

## Independent Task Repository Decision

Cross-session continuity revealed a simpler final model:

    create every task as an independent repository immediately
    mount every task used in a session as its own submodule

This removes:

- End-of-day branch conversion.
- Two different paths for new and old tasks.
- One-gitlink-only-active-task limitation.
- Untracked-file leakage between task branches.
- Ignored build-directory contamination.

It also allows:

    Monday session -> task commit T2
    Tuesday session -> task commit T3
    Thursday session -> task commit T4

Every old session remains reproducible while the task continues evolving.

## Virtual Filesystem Direction

The user proposed agent-native directories such as:

    recent
    frequent
    starred
    favorites
    coding
    coding/ai-agents
    learning/active
    documents

The refined model treats these as views:

- Canonical task repository has one stable location.
- A task may appear in many collections.
- Durable collections represent user or agent organization.
- Recent, frequent, active, and blocked are generated smart views.
- View membership aids search but never authorizes mutation.
- Semantic search ranks candidates only after stronger Git evidence.

## Independent Service Direction

The user then proposed making Git Context Engine an independent server using
both Git and SQLite.

The agreed refinement:

- The harness uses a typed local API.
- MCP may expose safe model-facing task search/read/routing tools.
- The service is the sole Git and SQLite writer.
- Git stores completed durable history.
- SQLite journals live uncommitted conversation, active runs, pending
  transactions, locks, caches, and search indexes.
- Core lifecycle operations are typed server functions, not shell scripts.
- Maintenance commands may provide doctor, recovery, migration, indexing, and
  export operations.

## Conversation Direction

The user proposed multiple conversation files instead of one large file.

The refined lifecycle:

- One conversation segment per serialized run or turn.
- User, assistant, and system-event messages share ordered segments.
- Every append is immediately durable in SQLite and the working file.
- Session-only segments close without an immediate Git commit.
- Task segments are renamed with stable task identity and committed with the
  task-run session commit.
- Pending harmless segments are batched into the next task commit, safety
  checkpoint, or midnight seal.

## Session Summary And Carryover

The user decided not to store a canonical summary file.

The summary is:

- Derived from commits, conversation segments, and task-run outcomes.
- Cached in SQLite.
- Invalidated by session HEAD or pending-conversation changes.
- Available through the active-context API.

At midnight:

- Active work is allowed to finish and commit.
- Old session is sealed.
- New session is created.
- Previous-session summary remains prominent until the new session has its
  first commit.

## Run Direction

Session runs and task runs remain run-first:

- Every turn starts as a session run.
- Direct replies normally need no separate Git run files.
- Read-only tool context remains live in SQLite and can be retained briefly.
- Mutation promotes the same run to a task run.
- Task-run evidence is committed in the session repository.
- Actual task files and checkpoints are committed in the task repository.
- Explicit task completion determines the final run outcome.

## Task Descriptor Direction

The user suggested one small agent-oriented file in every task repository for
indexing and context.

The refinement uses:

    .ayati/task.md

instead of a mandatory root AGENTS.md, preventing conflicts with user-owned
agent instructions while keeping the task portable and easy to index.

