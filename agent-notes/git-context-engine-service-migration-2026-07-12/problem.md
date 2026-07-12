# Problem And Product Direction

## Current Storage Direction

Ayati currently uses a daily parent Git repository with task branches and a
session-store submodule:

    daily parent repository
      main
      task/W-... branches
      session-store submodule
        session conversation
        session runs and summaries

Task branches currently store generated context files such as task state, run
summaries, evidence, assets, notes, and a gitlink to an exact session-store
snapshot. Actual task deliverables normally live outside the Git context
repository and are represented by paths and metadata.

This design has one meaningful strength: a task-run commit can natively point
to an exact session-store conversation commit.

It does not match the newer product principle:

    task = durable evolving work
    task files = first-class task resources
    Git commit = exact task state

## Problems To Correct

### Task state can disagree with real files

Task state describes workspace resources rather than owning them. File
existence, task metadata, asset pointers, validation, and summaries can drift
apart.

### Task context accumulates noise

Operation facts, evidence summaries, path attempts, stale resources, and latest
step summaries can be promoted into a large task snapshot. More stored data
does not necessarily produce better reusable context.

### Task routing lacks a hard ownership boundary

An unrelated mutation can attach to an active task when routing fails or when
semantic classification is uncertain. The budget-planner live test being
recorded under a weekend-planner task is the representative failure.

### Task branches do not contain the actual product

Exporting a task branch does not necessarily export the website, report,
application, document, or other deliverable. It exports metadata and pointers.

### Session and task lifetimes are inverted

Sessions are temporary daily execution containers. Tasks are the objects that
must survive and evolve across many sessions. The durable repository boundary
should follow the task.

### Context persistence is embedded in the application

Git lifecycle operations, session storage, task routing, run recording,
context projection, and recovery are tightly coupled inside the backend
process. This makes the persistence boundary harder to reason about and reuse.

## Desired Product Model

Ayati should behave like a user operating a filesystem and Git:

    open today's session
    find or create a task repository
    mount the task in the session
    inspect real files and history
    work and verify
    commit task state
    commit the session's pointer and conversation
    reopen the same task in another session later

The user should not need to understand submodules, task refs, run journals, or
commit ordering. Those are deterministic Git Context Engine responsibilities.

## Why An Independent Server

The Git Context Engine server creates one authority for:

- Session creation and sealing.
- Conversation persistence.
- Run allocation and journaling.
- Task repository creation and discovery.
- Submodule activation.
- Task and session commits.
- Git/SQLite reconciliation.
- Crash recovery.
- Search indexes and virtual folders.
- Context projection for the harness.

The backend agent no longer needs direct knowledge of Git storage details. It
uses a typed client and receives stable objects.

## Goals

- Make completed history inspectable and recoverable through Git.
- Make every task portable as an independent repository.
- Make task mutation ownership deterministic.
- Keep session conversation safe during task switching.
- Preserve run evidence without duplicating task files.
- Make context loading fast through SQLite caches and indexes.
- Keep daily rollover safe and deterministic.
- Allow tasks to evolve across any number of sessions.
- Allow the engine to be used by Ayati and potentially other agent clients.
- Preserve the current harness and verification model.

## Non-Goals

- Building a distributed multi-user Git hosting system.
- Supporting concurrent mutation of one task in the first migration.
- Replacing the agent harness with workflows inside the context server.
- Letting the model decide commit ordering.
- Storing all model prompt context permanently.
- Loading every task or file into every prompt.
- Making semantic embeddings canonical task identity.
- Committing dependencies, build output, secrets, caches, or arbitrary large
  generated artifacts.
- Rewriting all historical Git repositories in place.

## Main Design Tension

Git submodules provide a native pointer only from the session superproject to a
task commit:

    session commit -> task commit

The task commit cannot natively point back to a future session commit without
creating an impossible cycle. The solution is:

    session commit -> exact task gitlink
    task commit -> session ID, run ID, conversation ID, conversation hash

This produces a strong logical two-way relationship without requiring a
pre-task session commit for every task run.

## Reliability Principle

The migration should optimize for:

    simple ownership
    explicit state transitions
    deterministic writes
    recoverable partial completion
    small model context
    complete durable evidence

It should not optimize for having the fewest possible files or commits at the
cost of losing recovery information.

