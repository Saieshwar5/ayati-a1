# Principles

## 1. The Task Is A Durable Workstream

A task is the long-lived place where related work accumulates. It can contain
many requests, runs, commits, files, lessons, experiments, and improvements.

The system should not require the agent to predict when the task will be
permanently finished.

## 2. Requests Are The Unit Of User Intent

A request captures one bounded feature, change, lesson, investigation,
automation improvement, or other desired outcome.

Requests provide acceptance criteria and status without splitting one coherent
workstream across multiple task repositories.

## 3. Runs Are Attempts, Not Durable Context Containers

A run is one execution of the harness. It may succeed, remain incomplete,
block, or fail. Its tool journal helps verification and recovery, but future
task continuation should not depend on replaying every run record.

The useful durable result of a mutating run is represented by the final task
tree, task card, request state, and Git commit.

## 4. Git Owns Completed Task Truth

For completed durable work, Git is canonical for:

- task identity files
- current task context
- request files
- task-owned deliverables
- task-owned notes and analysis
- change history
- run-to-commit identity
- validation and outcome metadata

SQLite may point to, index, cache, or protect Git state. It must not become a
second completed-task truth that cannot be rebuilt.

## 5. One Task, One Normal Repository

The task repository is a normal, non-bare Git repository with a working tree.
Its path under the configured task root is stable.

This deliberately removes the normal need for:

- a bare canonical mirror
- a separate stable clone
- a per-session submodule clone
- pushing locally merely to make a task state canonical

## 6. Read Widely, Mutate Narrowly

Ayati can inspect any task repository at any time. Read access does not imply
ownership, activation, focus, locking, or mutation permission.

Mutation requires:

- one resolved task
- one expected base commit
- one active run
- one exclusive task lock
- bounded mutation targets
- deterministic verification

## 7. Context Should Be Layered And Cheap

Normal continuation reads the smallest useful layers first:

```text
.ayati/task.md
-> current request
-> repository status and recent commits
-> important paths
-> deeper files and older history on demand
```

Do not load every request, commit, attachment, tool record, or repository file
into every prompt.

## 8. Current Snapshot And History Have Different Owners

`.ayati/task.md` answers "where are we now?"

Git history answers "how did we get here?"

Request files answer "what bounded outcomes have been requested and what is
their state?"

Do not duplicate full history into the current task card.

## 9. Only The Ayati Namespace Is Standardized

Learning, coding, computer use, analysis, and automation need different project
structures. Ayati standardizes `.ayati/` and leaves the rest of the repository
domain native.

No universal `src/`, `work/`, `outputs/`, `notes/`, or `data/` directory is
required.

## 10. Reserved Context Is Runtime-Owned

The Git Context Engine owns updates to:

- `.ayati/task.md`
- `.ayati/requests/` metadata and outcomes
- `.ayati/references.md`
- standard ignore rules for `.ayati/inbox/`

Normal executable tools work on task content and cannot alter `.git/` or the
reserved `.ayati/` context contract. This keeps model-generated file writes
from corrupting identity or lifecycle state.

## 11. Untracked Does Not Mean Durable

Raw inbox bytes may remain ignored for privacy, size, or user preference. The
task stores durable provenance, but the agent must check availability before
claiming that the bytes can be used or restored.

Critical inputs can be deliberately adopted into tracked task paths through an
explicit operation.

## 12. One Mutating Run, One Final Commit

Verified task changes accumulated during a run are committed together with the
updated task card and request state.

Avoid per-tool commits. Avoid a second empty "state" commit after the real work
commit. Avoid session commits merely to preserve task continuity.

Safety checkpoints, if later required for unusually long work, must be an
explicit exceptional policy and cannot masquerade as final run commits.

## 13. The User Does Not Manage Sessions

Sessions exist for transport, conversation, provider calls, and active-run
journaling. They are not the user's filing system.

The user thinks in terms of durable tasks and current requests. Closing or
restarting the daemon does not close or hide a task.

## 14. Reopening Is Normal

A task can move between `active`, `paused`, and `archived`. Reopening is a
normal status transition, not restoration of an old session or run.

Individual completed requests remain complete. New work receives a new
request unless the user explicitly reopens or corrects an earlier one.

## 15. Recovery Is Conservative

Ayati never automatically discards an unknown dirty working tree. It never
force-resets a task because a journal and repository disagree. Recovery uses
Git identity, verified step records, expected paths, and run trailers to prove
what happened.

Unproven state becomes `recovery_required` and blocks further mutation while
remaining readable.

## 16. Search Comes After Truth

Task discovery, indexes, recency views, resource catalogs, and semantic search
are projections over task repositories. They are useful only after the
repository contract is stable.

V1 may list task directories and read exact IDs. It does not need to solve the
entire retrieval problem.

## 17. Git Records External Work But Does Not Own External Systems

Computer-use tools may change browsers, applications, communication services,
calendars, databases, or other external systems. Those systems remain
authoritative for their own live state.

After deterministic verification, the task repository records the useful
outcome, stable identifiers, receipts/artifacts, and next context. Git history
explains what Ayati proved and recorded; reverting a Git commit does not claim
to undo the external action.
