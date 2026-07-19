# Task Repositories

Ayati stores durable work in independent Git repositories. This page is the
canonical stable description of the current task model.

## Mental Model

```text
task = long-lived workstream
request = bounded user intention inside a task
run = one attempt to advance a request
commit = verified durable result of a mutating run
session = temporary conversation and runtime container
```

A website, learning journey, recurring analysis, or maintained automation is
normally one task. Later features, lessons, investigations, and improvements
become requests inside that task rather than new repositories.

## V1 Repository Contract

Every newly created managed task uses one normal non-bare repository:

```text
<workspace-root>/tasks/T-YYYYMMDD-NNNN-<slug>/
  .git/
  .gitignore
  .ayati/
    task.md
    requests/
      R-NNNN-<slug>.md
    references.md
    inbox/
      .gitkeep
  task-owned files and directories
```

The repository directory is both canonical task history and the stable working
directory. Ayati does not create a second working repository for the task.

Only `.ayati/` has a universal engine-owned layout. Task content remains
natural for its domain.

- `.ayati/task.md` is the compact current task card.
- `.ayati/requests/` stores durable bounded requests. At most one is active.
- `.ayati/references.md` stores attachment/reference provenance.
- `.ayati/inbox/` stores ignored local input bytes. Its manifest is durable;
  the ignored bytes are not Git backup.

General tools cannot edit `.git/` or engine-owned `.ayati/` lifecycle files.
The Git Context service renders and commits reserved context.

## Creation And Selection

The model-facing routing tools are:

- `git_context_create_task`: create one managed V1 task and its initial request.
- `git_context_activate_task`: select an existing task.

Activating a `T-*` task requires an explicit request decision:

- continue the exact unfinished active request; or
- create a new active request for a materially separate outcome in the same
  workstream.

Ambiguous ownership is resolved by reading task candidates or asking the user
directly. Ayati must not silently mutate the most recent unrelated task.

Selection returns the canonical absolute `workingDirectory`. The current routing tools use fresh internal operation request
IDs, so stable model-tool replay identity remains an open reliability item.

## Read Path

Ayati may read any cataloged task without activating, mounting, or locking it.
The V1 projection reads committed Git state:

- task card
- current request only by default
- bounded semantic commit history
- curated important paths
- repository health reported separately from committed truth

Reading a dirty or locked repository remains possible, but dirty content is not
presented as committed task truth.

Task listing and candidate discovery currently depend on the SQLite catalog.
Rebuilding lost catalog rows from repositories is designed but not yet
implemented.

## Mutation And Finalization

Before a mutating tool executes, runtime must have:

1. one resolved task and active request
2. the expected task HEAD
3. a clean, validated repository
4. exclusive task mutation authority
5. explicit bounded targets for filesystem mutation

Model-facing host paths are canonical absolute paths below the selected task
working directory. Git stores private task-relative paths only after runtime
authorization. Repository-wide `.` authority, path escapes, unsafe symlinks,
`.git/`, and reserved `.ayati/` targets are rejected.

Tool output alone is not mutation truth. Git-derived provenance and
deterministic tool verification decide which paths are eligible for staging.
Finalization renders the task/request context, stages only verified and
engine-owned paths, and creates at most one task commit for the run. SQLite
records run, authority, verification, and before/after commit identity.

A read-only run creates no task commit. A proven blocker or verified external
outcome may create a context-only commit when there is useful durable state but
no ordinary task file.

## Attachments And References

Attachments are retained before routing. When bound to a task, local bytes are
placed under the ignored inbox and a tracked reference records identity,
source, checksum, availability, and request relationships.

Ignored inbox bytes are not recoverable from cloning the task. Important input
must be explicitly adopted into a tracked task path through a verified
operation when Git durability is required.

## Sessions And Continuation

Every accepted provider-handled turn begins as an unbound run. Read-only work
may finish without selecting a task. Before task mutation, the same run id is
bound immutably to exactly one task and request. A completed run is sealed; a
later continuation allocates a new run and reads committed task context.

Sessions store conversation and run journals, but they do not own V1 task
continuity. Closing the CLI, daemon, or a conversation does not close the task.

## External Systems

Git can record that an external action was verified, but the external service
remains canonical and Git revert does not undo that action. Raw screenshots,
page dumps, tokens, credentials, and unsafe receipts must stay outside task
Git.

V1 currently supports zero-file task authority and context-only finalization.
A typed outcome contract integrated with real email, calendar, browser, form,
or application mutation tools is not yet implemented.

## Current Reliability Gaps

The repository happy path is implemented, but these capabilities remain open:

- stable replay identity for model-facing create/activate operations
- live queued-request activation, blocked-request resume, and task
  pause/archive/reopen operations
- catalog rebuild from validated managed repositories
- typed real external-action outcomes and uncertain-result recovery
- restart and manually inspected live acceptance across the example domains

These are current limitations, not alternate task architectures. New work must
preserve the V1 topology while closing them.

## Primary Source Paths

- `ayati-git-context/src/contracts.ts`
- `ayati-git-context/src/tasks/`
- `ayati-git-context/src/services/task-lifecycle-service.ts`
- `ayati-git-context/src/services/task-binding-service.ts`
- `ayati-git-context/src/services/task-request-routing-service.ts`
- `ayati-git-context/src/services/mutation-boundary-service.ts`
- `ayati-git-context/src/services/run-finalization-service.ts`
- `ayati-git-context/src/services/task-bound-finalization-service.ts`
- `ayati-main/src/app/git-context-runtime.ts`
- `ayati-main/src/app/task-scoped-tool-executor.ts`
- `ayati-main/src/skills/builtins/git-context/index.ts`
