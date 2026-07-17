# Simple Task Repository V1

Created: 2026-07-17

Status: accepted master plan. Planning documents are being prepared; runtime
implementation has not started.

Implementation branch: create a new behavior-changing branch when the first
implementation slice is approved. Do not implement runtime changes directly
from this documentation branch.

## Purpose

This plan simplifies Ayati around one durable context primitive:

```text
task repository = durable workstream and current context
request = bounded unit of desired work inside a task
run = one agent execution that attempts to advance a request
commit = verified durable result of a mutating run
session = temporary conversation and runtime container
```

A task is not assumed to finish in one run or one day. It may represent a
website that receives improvements for years, a machine-learning journey, a
recurring analysis, or a maintained automation. Completion primarily belongs
to requests and runs. The task remains available until the user pauses or
archives it.

The user should be able to close Ayati, return later, select a task, and
continue without understanding sessions, context windows, branches, run files,
or memory internals.

## Accepted Direction

The user accepted every design decision captured in this plan. Future
implementation work should treat the following as the default direction:

```text
All managed tasks live under one configured task root.
Every task is a normal independent non-bare Git repository.
The task directory is both the canonical repository and working directory.
Only .ayati/ has a standard Ayati-owned structure.
.ayati/task.md is the compact current task card.
.ayati/requests/ stores durable bounded requests.
.ayati/references.md tracks attachment and external-reference provenance.
.ayati/inbox/ stores ignored local attachment bytes.
Git commits are the durable run history.
Read-only access never requires task activation, mounting, or locking.
Mutation requires one resolved task, expected HEAD, an exclusive lock,
deterministic verification, and one final task commit.
Sessions do not own task continuity.
Session submodules are not part of the V1 task lifecycle.
SQLite owns live journals, locks, recovery, and rebuildable indexes only.
```

## Files In This Plan

- `problem.md`: the product and engineering problems being corrected.
- `principles.md`: the durable mental model, boundaries, and simplification
  rules.
- `architecture.md`: target topology, component responsibilities, context
  flow, and source-of-truth ownership.
- `repository-contract.md`: exact task layout, file contracts, schemas,
  templates, naming, ownership, and validation.
- `lifecycle.md`: task, request, run, read, mutation, commit, reopen, archive,
  attachment, and recovery lifecycles.
- `examples.md`: complete example task repositories for learning, coding,
  computer use, data analysis, and automation.
- `implementation.md`: staged technical implementation plan and likely code
  ownership.
- `migration.md`: cutover from the current bare-repository, stable-checkout,
  and session-submodule model.
- `testing.md`: deterministic, integration, recovery, migration, and live
  acceptance coverage.
- `decisions.md`: accepted decisions, qualifications, and deliberately
  deferred choices.
- `conversation.md`: chronological record of the user direction and accepted
  design that produced this plan.
- `progress.md`: implementation checklist, gates, and future work log.

## Primary Invariants

Implementation agents must preserve these invariants:

1. A managed task has exactly one canonical normal Git repository.
2. The canonical task repository is located under the configured task root.
3. The repository root is the task's stable working directory.
4. No bare mirror, session checkout, or hidden second working copy is required
   for normal task work.
5. The task Git tree and history are sufficient to recover completed durable
   task context.
6. `.ayati/task.md` contains a compact current snapshot, not a transcript or
   database dump.
7. Durable user work is represented as requests inside the long-lived task.
8. Read-only tools may inspect any task without activating or locking it.
9. A mutating run owns exactly one task.
10. No mutation executes until task identity and expected HEAD are resolved.
11. Only verified changes enter a normal final task commit.
12. One mutating run produces at most one normal final task commit.
13. The context engine, not the model, owns task-card updates, staging,
    commits, locks, and recovery transitions.
14. General work tools cannot mutate `.git/` or engine-owned `.ayati/` files.
15. Ignored inbox bytes are never mistaken for Git-durable content.
16. SQLite may accelerate or protect the lifecycle but cannot become a second
    canonical completed-task state store.
17. Sessions may record task ID and before/after commit identities, but they do
    not need a task submodule.
18. Task discovery and semantic search are later layers over this contract;
    they must not complicate V1 creation, reading, continuation, or mutation.
19. The existing harness remains:

```text
context pack -> decision -> action executor -> deterministic verification
-> progress reducer
```

20. Personal memory remains separate from task/work continuity.

## Required Reading Before Implementation

Read the stable project context first:

```text
project-docs/README.md
project-docs/product/overview.md
project-docs/engineering/README.md
project-docs/engineering/architecture/overview.md
project-docs/engineering/architecture/agent-harness.md
project-docs/engineering/architecture/context-and-memory.md
project-docs/engineering/testing.md
```

Then read every file in this plan directory.

Inspect the current independent Git Context Engine implementation, especially:

```text
ayati-git-context/src/tasks/task-descriptor.ts
ayati-git-context/src/tasks/task-context-reader.ts
ayati-git-context/src/tasks/task-state-commit.ts
ayati-git-context/src/git/task-repository.ts
ayati-git-context/src/git/task-working-directory.ts
ayati-git-context/src/git/task-submodule.ts
ayati-git-context/src/git/task-finalization.ts
ayati-git-context/src/services/task-lifecycle-service.ts
ayati-git-context/src/services/task-run-finalization-service.ts
ayati-main/src/app/task-scoped-tool-executor.ts
ayati-main/src/ivec/agent-runner/runner.ts
```

Older plans remain historical evidence. When they conflict with this plan on
task repository topology, session submodules, task status, or canonical task
files, this plan controls new implementation.

## Branch And Commit Guidance

This plan requires behavior-changing storage and lifecycle work. Before the
first code change:

1. Confirm the current migration/integration branch and its test state.
2. Create a dedicated implementation branch, for example:

```bash
git switch -c refactor/simple-task-repository-v1
```

3. Show the user the exact first slice, expected files, migration impact, and
   focused tests.
4. Commit only after the slice's focused tests pass.
5. Use small imperative commit subjects.

Recommended commit slices are documented in `implementation.md`.

Do not commit `.env`, secrets, runtime databases, inbox contents, logs,
generated feedback, temporary repositories, or build output.

## Implementation Discipline

- Do not perform a big-bang rewrite.
- Establish executable repository contracts and fixtures before changing live
  routing or finalization.
- Keep old repositories readable during migration.
- Do not operate two normal task write models after cutover.
- Never delete or rewrite old task history automatically.
- Add deterministic recovery before enabling new writes by default.
- Update stable `project-docs/` only after behavior is implemented and tested.
- Remove obsolete documentation and compatibility paths after the cutover is
  verified; do not leave two current architectures described as active.
- Stop and report any implementation choice that weakens a primary invariant.

## Non-Goals For V1

V1 does not need:

- semantic or embedding-based task search
- smart folders, starred views, or rich navigation
- remote Git hosting or synchronization
- multi-agent concurrent mutation of one task
- automatic merging of divergent task histories
- Git LFS
- automatic movement of existing user repositories
- mandatory session Git repositories
- task submodules
- per-tool Git commits
- generated `state.json`, `notes.md`, task run Markdown, or task evidence files
- a universal deliverable directory structure
- a final answer to long-term attachment backup

These can be considered only after the basic task contract is reliable.

## Success Criteria

The plan is implemented successfully when all of these are true:

- Creating a task creates one normal Git repository under the task root.
- The repository contains a valid task card, request directory, references
  manifest, ignored inbox, and initial identity commit.
- Ayati can read any task without changing session or task state.
- A new durable request is represented inside the existing task instead of
  creating an unnecessary repository.
- A read-only question produces no task commit.
- A mutating run resolves one task, verifies its base HEAD, locks it, performs
  and verifies work, updates context files, and produces one final commit.
- Restart after a crash never silently loses, commits, or discards an
  unverified working tree.
- A paused or archived task can be reopened with its full useful context.
- The same contract works naturally for learning, coding, computer use,
  analysis, and automation examples.
- Removing SQLite rebuildable index tables does not destroy completed task
  history or current task context.
- No session submodule is required for any of the acceptance flows.
