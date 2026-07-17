# Decisions And Deferred Choices

## Accepted Decisions

### Task means durable workstream

A task is a long-lived container such as a website, learning journey, analysis,
or automation. It is not assumed to end after one requested outcome.

### Request means bounded user intent

Features, lessons, suggestions, changes, investigations, and improvements are
standardized request files inside the task.

### Run means one execution attempt

Runs are sealed attempts. Future continuation uses task state and Git history,
not reopening an old run.

### One managed task root

All new managed V1 task repositories live under one configured directory.

### One normal repository per task

The normal non-bare repository is both canonical history and stable working
directory.

### No mandatory task submodules

Session submodules are not required for creation, continuation, reading,
mutation, or finalization. A session journal stores task and before/after commit
identity instead.

### No canonical bare mirror for V1

V1 does not create a local bare repository plus a clone. Historical bare
repositories are retained read-only during migration.

### `.ayati/` is the only universal task structure

Domain content remains natural to learning, coding, computer use, analysis, or
automation.

### Living task card

`.ayati/task.md` is a compact current snapshot, not merely an initial identity
descriptor and not a full history.

### Standard request directory

`.ayati/requests/` stores durable request files with a small explicit status
machine. At most one request is active in V1.

### Private local input inbox

Raw user inputs live in ignored `.ayati/inbox/`, not root `public/`. This avoids
deployment conflicts and makes ownership clear.

### Tracked provenance manifest

`.ayati/references.md` records identity, source, checksum, availability,
request relationships, and adoption without pretending ignored bytes are Git
durable.

### Explicit input adoption

An ignored/external input becomes tracked task content only through an explicit
verified adoption operation.

### Layered task context

Normal reads start with task card, current request, health, recent commits, and
important paths. Deeper history and files are retrieved on demand.

### Read-any-time behavior

Reading any task requires no activation, lock, submodule, or mutation state.

### Narrow mutation behavior

Mutation requires exact task resolution, expected HEAD, exclusive lock,
bounded paths, Git-derived provenance, and deterministic verification.

### One final commit per mutating run

A normal mutating run produces at most one final task commit. Read-only runs
produce no task commit.

### Runtime-owned context and commits

The Git Context Engine renders reserved context files, stages verified paths,
creates commit metadata, and owns recovery. The model cannot directly commit or
edit `.ayati/` lifecycle state.

### Separate statuses

Task status, request status, run outcome, and repository health remain distinct.

### Reopening is ordinary

Paused or archived tasks can be reactivated. Completed requests remain history;
new improvements normally receive new request IDs.

### Conservative crash recovery

Unknown dirty state is preserved and blocks mutation. Ayati never silently
stashes, resets, discards, or commits it.

### SQLite boundary

SQLite owns live journals, locks, idempotency, recovery, and rebuildable
indexes. Git owns completed task truth.

### External systems keep their own authority

For computer-use work, Git records the verified outcome and useful references,
but the external application remains canonical. Reverting task history does not
claim to undo an external action, and task binding does not bypass action
approval policy.

### Preserve the harness

The existing context-pack/decision/action/verification/reducer model remains.

### Defer discovery complexity

First make tasks excellent to create, continue, reopen, and update. Task
search, activation, virtual views, and richer retrieval come later.

## Important Qualifications

### Ignored inbox is not backup

The tracked manifest preserves provenance, not bytes. A later content-addressed
store or explicit tracked adoption may improve durability.

### A task may have no active request

This is valid after completing current work. The task can remain active for
future requests or be paused.

### State-only commits are allowed but not empty acknowledgements

A proven durable blocker/status transition may justify a commit that changes
only reserved context. Harmless conversation does not.

### Existing external working directories need explicit migration decisions

The one-root rule means Ayati cannot silently preserve arbitrary external paths
as V1 canonical repositories. It must ask before import/move/adoption or keep
them legacy.

### Existing user commits become Git truth

Clean externally created commits can be accepted after validation. Dirty
external changes are not silently absorbed into an Ayati run.

### Old sessions remain immutable

Removing submodules from new task work does not authorize rewriting historical
session repositories or deleting their task sources.

## Deferred Implementation Choices

These choices must be resolved in their focused implementation slice without
changing the accepted direction.

### Exact configured roots

Choose final defaults for the task root, runtime data root, socket, and test
roots. The task root must remain explicit and bounded.

### Durable branch name

Use `main` unless migration evidence requires preserving a different existing
durable branch.

### External dirty-change interaction

Choose whether V1 only instructs the user to commit/clean external changes or
also offers an explicit reviewed `capture_external_changes` operation.

### Inbox retention

Define when ignored attachment bytes expire, how users pin them, and whether a
global content-addressed store is introduced later.

### Frontmatter parser implementation

Prefer a minimal deterministic parser. A dependency is acceptable only if it
meaningfully reduces correctness risk without enabling unbounded YAML features.

### Task card reducer fallback

Define the deterministic fallback when semantic reduction fails or exceeds
limits. It must preserve the previous valid card plus proven minimal changes,
not invent state.

### Explicit task-management commands

Creation, pause, archive, reopen, and request management may be CLI commands,
model-facing tools, or both. Runtime lifecycle remains authoritative.

### Optional safety checkpoints

Do not add them in initial V1. Revisit only if measured long-running work shows
that a single final commit creates unacceptable recovery cost.

### Session conversation persistence

Conversation may remain in current session storage during migration. This plan
only removes session ownership from task continuity and task commit
finalization.

### Remote synchronization

Adding remotes, backup, or collaboration is later work. V1 must not assume a
remote exists.

## Explicit Rejections

Do not implement these as V1 shortcuts:

- one repository per small feature or lesson
- a root `public/` directory for private inputs
- generated `state.json` as canonical task state
- full tool logs inside task Git
- every task file listed as an important path
- per-tool commits
- automatic task completion/archive from run completion
- automatic task creation during harmless read-only work
- automatic stash/reset of dirty repositories
- mutation through session submodule checkouts
- two simultaneous normal writers for old and new layouts
- rewriting legacy commits to insert new schemas
- deleting old bare repositories during migration
- treating Git revert as rollback of an external computer-use action
