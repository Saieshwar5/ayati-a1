# Target Architecture

## System Mental Model

```text
user/client
  -> Ayati daemon and existing agent harness
  -> typed Git Context Engine client
  -> Git Context Engine service
       -> normal task repositories under one task root
       -> SQLite active-operation journal and rebuildable catalog
       -> optional conversation/session persistence outside task truth
```

The existing harness remains unchanged in principle:

```text
context pack
-> decision
-> action executor
-> deterministic verification
-> progress reducer
```

This plan changes durable task context and repository orchestration. It does
not reintroduce controller stages, model-authored commits, or a new harness.

## Filesystem Topology

Recommended configured roots:

```text
data/git-context/
  context.db
  engine.sock
  runtime-journal/

workspace/tasks/
  T-20260717-0001-learn-machine-learning/
  T-20260717-0002-coffee-website/
  T-20260718-0001-sales-analysis/
```

The exact top-level paths remain configurable, but all managed tasks belonging
to one Ayati installation live directly under one task root.

Each child is a normal independent Git repository:

```text
workspace/tasks/T-20260717-0002-coffee-website/
  .git/
  .gitignore
  .ayati/
  package.json
  src/
  tests/
```

There is no normal V1 topology containing a bare copy plus a stable clone plus
a session submodule clone.

## Responsibility Split

### Agent harness

- Starts every provider-handled turn as a session run.
- Builds context and makes decisions.
- Uses read-only tools without task mutation ownership.
- Expresses a task target when durable mutation is needed.
- Maintains run-local WorkState.
- Sends executable actions through deterministic verification.
- Requests task completion/finalization through runtime APIs.

### Git Context Engine

- Allocates task IDs and directories.
- Initializes and validates task repositories.
- Owns `.ayati/` schemas and updates.
- Lists and reads tasks through Git-aware APIs.
- Resolves expected task HEAD.
- Acquires and releases exclusive task mutation locks.
- Journals active mutation transactions.
- Validates repository cleanliness and path authority.
- Stages verified paths.
- Updates the task card and request state deterministically.
- Creates the single final task commit.
- Reconciles interrupted operations.
- Maintains rebuildable task and resource indexes.

### General executable tools

- Read any authorized filesystem resource.
- Mutate only paths authorized for the active task run.
- Never write `.git/`.
- Never write engine-owned `.ayati/` contract files.
- Report tool results; they do not define Git mutation truth.

### SQLite

SQLite is authoritative only for unfinished operational state:

- active sessions and runs
- task locks and leases
- mutation transaction phases
- step journal and deterministic verification evidence
- idempotency records
- crash-recovery state
- inbox availability and active upload operations

SQLite is a rebuildable projection for:

- task catalog rows
- task title and status indexes
- current request index
- recent and frequent task views
- file/resource ownership index
- reference and attachment lookup
- context projection cache

Deleting rebuildable tables must not destroy completed task state.

### Git

Git is canonical for completed durable task state:

- `.ayati/task.md`
- `.ayati/requests/*.md`
- `.ayati/references.md`
- `.gitignore`
- task deliverables and domain-native files
- task commit history
- final run outcome metadata
- before/after ancestry

### External systems

External applications remain authoritative for their own state. Git cannot
contain or roll back an email send, browser submission, calendar update, cloud
record, or other computer-use action.

For verified external work, the task repository records only useful durable
context such as:

- the bounded request and its outcome
- verified external object identifiers
- non-secret URLs or record references
- user-facing receipts or exported artifacts when appropriate
- the current snapshot and next step

Raw external-tool evidence remains in the run journal. A context-only task
commit may record a proven external outcome even when no ordinary deliverable
file changed. The commit is an audit/context record, not a rollback mechanism
for the external system.

## Task Identity

V1 task IDs use:

```text
T-YYYYMMDD-NNNN
```

The directory name adds a human-readable slug:

```text
T-20260717-0001-learn-machine-learning
```

The stable identity is the `id` in `.ayati/task.md`, not the directory slug.
Renaming a directory is not part of normal V1 behavior. If supported later,
the catalog updates the path without changing the task ID or history.

Legacy `W-*` identities remain valid during migration and are not rewritten
merely to match the new prefix.

## Context Compilation

Task context is assembled progressively.

### Level 0: catalog candidate

Used for listing or exact selection:

```text
task ID
title
task status
current request ID/title/status
repository path
HEAD
last commit time
```

This can come from a rebuildable catalog, validated against Git before
mutation.

### Level 1: continuation context

Normal task continuation reads:

1. `.ayati/task.md` at `HEAD`.
2. The request named by `current_request`, if any.
3. `git status --porcelain` for repository health.
4. The newest five to ten semantic commits.
5. Important paths named in the task card.

### Level 2: on-demand task detail

Only when needed:

- other request files
- references manifest
- file tree
- older commits
- diffs for specific runs or requests
- domain files selected by the agent

### Level 3: operational evidence

Active-run raw tool records and verification live in the run journal and enter
the prompt only through bounded current-run context. They do not become normal
future task context.

## Read Path

```text
agent requests task read
-> resolve exact task ID/path or read candidate
-> validate directory containment under task root
-> inspect Git identity and HEAD
-> read committed files using Git where possible
-> report dirty/recovery status separately
-> return bounded task projection
```

Reading does not:

- change the active task
- acquire a mutation lock
- create a session submodule
- write SQLite task state beyond disposable cache/telemetry
- modify the repository

Committed context should normally use `git show HEAD:<path>` so an unrelated
dirty working file cannot silently alter the durable projection. Repository
health is reported alongside that projection.

## Mutation Path

```text
active session run
-> resolve one task and current request
-> validate repository identity
-> compare expected HEAD
-> require safe working-tree state
-> acquire exclusive task lock
-> bind/promote the run to the task
-> authorize bounded target paths
-> execute one tool at a time
-> derive changes from Git
-> verify tool result and paths
-> retain verified changes for finalization
-> update .ayati task/request state through the context engine
-> stage exactly verified and engine-owned context paths
-> create one final task commit
-> update journal/catalog
-> release lock
```

The model never supplies a raw commit message or runs lifecycle Git commands.
The runtime constructs commit metadata from verified WorkState and known
identities.

External mutating tools use the same task/run/request binding and deterministic
verification boundary. Their mutation targets are typed external resources
rather than filesystem paths, and successful finalization still updates the
task repository once with the verified outcome.

## Session Relationship

A session may persist conversation and read-only run data according to Ayati's
runtime needs, but task continuity does not depend on a daily session
repository.

When a task run finishes, the session journal needs only an immutable link:

```json
{
  "sessionId": "S-20260717-local",
  "runId": "RUN-20260717-0042",
  "taskId": "T-20260717-0002",
  "requestId": "R-0002",
  "before": "abc123...",
  "after": "def456...",
  "outcome": "completed"
}
```

The `after` commit already identifies the exact task tree. A native session
gitlink is unnecessary for normal continuation and can be removed from the
required finalization transaction.

## Repository Health States

Operational health is distinct from task status:

```text
ready
locked
dirty_external
recovery_required
missing
invalid
```

- `ready`: valid repository, expected HEAD, no unsafe changes.
- `locked`: another active run owns mutation; reads remain allowed.
- `dirty_external`: unjournaled changes exist and need user-aware handling.
- `recovery_required`: an interrupted Ayati mutation cannot yet be resolved.
- `missing`: catalog points to an absent directory.
- `invalid`: identity, Git root, or schema validation failed.

Do not encode these as `.ayati/task.md` task statuses.

## Trust Boundaries

- Task-root containment is validated using canonical absolute paths.
- Task directory entries must be normal directories, not symlink aliases.
- The Git top-level path must exactly equal the task directory.
- `.git/` is never a general mutation target.
- `.ayati/` context files are updated only by the context engine.
- Symlink targets for deliverable mutation are canonicalized and must remain
  inside the task root.
- External mentioned paths are references, not owned mutation targets.
- Inbox attachment bytes are inputs, not automatically task-owned output.
- Repository HEAD and lock identity are rechecked immediately before mutation
  and finalization.

## Concurrency

V1 supports many concurrent readers and at most one mutating run per task.

The lock record binds:

```text
task ID
repository canonical path
base HEAD
run ID
session ID
acquired time
lease/recovery state
```

A second mutating run receives a deterministic task-busy response. It must not
work in an alternate checkout or automatically create a new task.

Multi-agent branches and merge orchestration are deferred.

## Context And Personal Memory

Task repositories contain work-specific truth. Personal memory contains facts
and preferences about the user that apply across tasks. Session conversation
contains immediate dialogue. These remain separate inputs to the context pack.

Do not copy personal memory into task cards or use task history as a general
personal profile.
