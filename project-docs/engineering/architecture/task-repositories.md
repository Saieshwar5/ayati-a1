# Task Repositories

Ayati stores durable work in independent Git repositories. This page is the
canonical stable description of the current task model.

## Mental Model

```text
task = long-lived workstream
request = bounded user intention inside a task
run = one compute, audit, and recovery boundary for one accepted event
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

Ayati can also register a user-requested existing directory in place. A
registered directory remains at its canonical path and keeps its existing Git
history. Its Ayati inbox ignore rules live in `.ayati/.gitignore`, so an
existing root `.gitignore` is never replaced.

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

The model-facing discovery and routing tools are:

- `git_context_find_tasks`: query the whole catalog by identity, text, path, or
  an unfinished, starred, recent, or frequent view.
- `git_context_read_task`: deliberately open committed context without binding
  the run.
- `git_context_set_task_star`: change the user's explicit star preference.
- `git_context_inspect_task_location`: classify an existing trusted directory
  before registration without changing user files.
- `git_context_create_task`: create a managed task or register an inspected
  directory, then create its initial request.
- `git_context_activate_task`: select an existing task.

Activating a `T-*` task requires an explicit request decision:

- continue the exact unfinished active request; or
- create a new active request for a materially separate outcome in the same
  workstream.

Ayati resolves ownership autonomously when deterministic evidence is clear.
Exact task identity, canonical resource ownership, and explicit continuation
are strongest. A unique text/request match can be probable. Stars, recency,
frequency, and unfinished state organize discovery but never authorize
mutation. The resolver uses explained tiers and reason codes rather than an
opaque weighted score, embedding search, or a separate routing controller.

Ambiguous ownership is resolved by opening the small candidate set or asking
one focused question. Ayati must not silently mutate the most recent unrelated
task.

Selection returns the canonical absolute `workingDirectory`. Routing,
inspection, preference, and open operations derive stable replay identity from
the run and native tool-call identity.

## Existing Directory Registration

Requested directories must be normal directories below the configured
workspace or an `AYATI_GIT_CONTEXT_TRUSTED_ROOTS` entry. Symlinks, overlapping
task roots, nested Git working directories, bare repositories, and detached
HEADs are rejected.

- An empty directory is initialized and registered automatically.
- A clean Git root receives one Ayati identity commit whose parent is the
  previously inspected HEAD. Existing files, branch, history, and root
  `.gitignore` remain intact.
- A dirty Git root is never adopted; the user must reconcile its changes.
- A non-empty non-Git directory is inventoried with file-count and byte caps.
  Cache/build directories, symlinks, and likely secrets are excluded. The
  proposed baseline requires explicit user approval, and the short-lived
  receipt is valid only in the next run after a truthful
  `needs_user_input` finalization. Changed content invalidates the receipt.

Registration stages only the approved baseline and Ayati scaffold. Excluded
paths remain on disk and are placed in the repository-local Git exclude file;
they are not committed or deleted.

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

Task discovery uses the SQLite catalog and FTS index; committed repository
state remains authoritative when a task is opened. The operator can preserve
task repositories during a clean reset and reconstruct an empty catalog with
`pnpm context:catalog-rebuild`. The command validates every discovered
repository, previews by default, refuses a live daemon or non-empty catalog,
and writes only with `--confirm`. Stars and access-frequency history are
operational preferences and are not reconstructible from task Git.

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

The repository happy path, deterministic discovery, requested-directory
registration, and empty-catalog rebuild are implemented. These capabilities
remain open:

- live queued-request activation, blocked-request resume, and task
  pause/archive/reopen operations
- typed real external-action outcomes and uncertain-result recovery
- restart and manually inspected live acceptance across the example domains

These are current limitations, not alternate task architectures. New work must
preserve the V1 topology while closing them.

## Primary Source Paths

- `ayati-git-context/src/contracts.ts`
- `ayati-git-context/src/tasks/`
- `ayati-git-context/src/services/task-lifecycle-service.ts`
- `ayati-git-context/src/services/task-discovery-service.ts`
- `ayati-git-context/src/services/task-location-service.ts`
- `ayati-git-context/src/services/task-catalog-rebuild-service.ts`
- `ayati-git-context/src/services/task-binding-service.ts`
- `ayati-git-context/src/services/task-request-routing-service.ts`
- `ayati-git-context/src/services/mutation-boundary-service.ts`
- `ayati-git-context/src/services/run-finalization-service.ts`
- `ayati-git-context/src/services/task-bound-finalization-service.ts`
- `ayati-main/src/app/git-context-runtime.ts`
- `ayati-main/src/app/task-scoped-tool-executor.ts`
- `ayati-main/src/skills/builtins/git-context/index.ts`
