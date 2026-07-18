# Current State

Last updated: 2026-07-18

Ayati's durable task model is Simple Task Repository V1. It is the only active
task repository architecture.

Current harness:

```text
context pack -> decision -> action executor -> deterministic verification -> progress reducer
```

Current continuity model:

```text
normal session Git repository + independent task Git repositories
                              + Git Context SQLite run/catalog state
                              + personal/episodic memory
                              -> bounded context projection
```

The model prompt receives a deduplicated grouped projection such as:

```text
context.timeline + context.git + context.tools + context.harness + context.run + context.personal
```

## Implemented

### V1 Repositories and Requests

- Every newly created durable task uses one normal managed `T-*` repository
  with a stable working directory.
- The universal engine-owned contract is `.ayati/task.md`, request files,
  reference metadata, and an ignored inbox; the real task content lives beside
  `.ayati/`.
- The model-facing routing surface is `git_context_create_task` and
  `git_context_activate_task`.
- V1 activation requires an explicit choice to continue the exact active
  request or create a new active request in the same task.
- V1 create/select/mutate/finalize paths operate directly on the task
  repository.
- Read paths can inspect cataloged repositories without selecting them for
  mutation. Dirty/locked health is reported separately from committed truth.
- Mutation authority validates expected HEAD, repository health, canonical
  paths, symlink containment, reserved paths, and exclusive ownership.
- Runtime finalization reduces task/request context, stages verified and
  engine-owned changes, and creates at most one task commit per run.
- Attachments can be retained before routing, placed in ignored inbox staging,
  and represented by tracked reference metadata.
- Focused suites cover repository creation/validation, request routing,
  mutation authority, attachments, finalization, and service-level V1 flows.

### Sessions and Runtime

- A daily session is a normal Git repository with `session/meta.json` and
  conversation records under `conversations/`.
- Every provider-handled turn begins as a session run. Read-only work can finish
  without creating or selecting a task.
- Pending-turn projections retain `unbound`, `bound`, and `clarifying` states,
  while mutation requires explicit task/request selection.
- The independent `ayati-git-context` server owns context SQLite and Git writes
  and communicates with `ayati-main` through a versioned local Unix-socket
  protocol.
- `ManagedGitContextProcess` owns server process lifecycle;
  `GitContextRuntime` adapts service operations for the daemon.
- The prompt uses bounded conversation, task/request, tool, harness, run, and
  personal-memory projections rather than loading every repository or raw
  output.
- Tool contracts, deterministic verification, sparse WorkState reduction,
  feedback traces, context-pressure measurement/compaction, and task-scoped
  absolute path enforcement remain part of the current harness.
- Protocol 32 selection results and feedback traces expose one compact V1
  lifecycle across repository identity, explicit request decision, run
  binding, finalization outcome, and commit/HEAD identity. The live report
  treats contradictory request and commit behavior as deterministic failures.

## Runtime Boundary

The model may read/search context and call:

- `git_context_create_task`
- `git_context_activate_task`

The Git Context runtime owns task/request identity allocation, mutation
authority, `.ayati/` lifecycle writes, task reduction, finalization, and Git
commits. General tools must not edit `.git/` or engine-owned lifecycle files.

The model-facing tools currently create fresh internal operation identities,
so independently repeated fresh calls do not yet have a stable replay key.

## Remaining Priorities

1. Carry stable replay identity through model-facing create/activate retries.
2. Run and manually inspect real restart/reopen acceptance flows for learning,
   websites, analysis, and automation/computer-use tasks.
3. Rebuild catalog records from validated managed repositories when SQLite is
   lost or incomplete.
4. Add live queued-request activation, blocked-request resume, and explicit
   task pause/archive/reopen lifecycle operations.
5. Define typed external-action outcomes and uncertain-result recovery for
   browser, desktop, email, calendar, forms, and other remote mutations.

These are reliability and lifecycle gaps within V1, not reasons to introduce a
second task architecture. The canonical stable contract is
[Task Repositories](../../architecture/task-repositories.md).
