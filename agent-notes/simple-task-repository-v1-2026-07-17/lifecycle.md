# Lifecycles

## Concept Separation

Three state machines must remain separate.

### Task

```text
active <-> paused
active|paused -> archived
archived -> active only through explicit reopen
```

### Request

```text
queued -> active -> done
queued -> dropped
active -> blocked -> active
active|blocked -> dropped
done -> active only through explicit reopen of the same intention
```

### Run

```text
session/read-first
-> task-bound before first mutation
-> running
-> completed | incomplete | blocked | failed
-> sealed
```

A task can be active while its current request is blocked. A run can fail while
the request remains active. Completing a request does not archive the task.

## Task Creation

Normal creation begins when the user requests new durable work and mutation is
actually needed.

```text
session run starts
-> read/clarify as needed
-> determine that work is a new durable workstream
-> record a non-durable target
-> immediately before first mutation, allocate task identity
-> create task directory and initialize Git
-> write standard scaffold and initial request
-> create identity commit
-> acquire task mutation lock for the same run
-> perform requested work
```

The identity commit is separate from the first work commit because it
establishes a valid task even if the first work run blocks or crashes.

Creation is idempotent. A retried request ID must return the same task identity
or complete recovery; it must not allocate a second task.

### Creation failure

- Failure before repository initialization removes only an empty engine-owned
  allocation after exact-path validation.
- Failure after a Git identity commit leaves a valid task and marks operational
  recovery state.
- Never recursively delete an ambiguous non-empty directory.

## Receiving A New Request

A new durable feature, lesson, suggestion, implementation, analysis question,
or automation change normally becomes a request in an existing task.

```text
identify task
-> decide whether input is durable work
-> allocate next request ID
-> write normalized request and acceptance criteria
-> queue or activate it
-> update task card current focus when activated
-> include request creation in the run's one final commit
```

Casual questions, explanations that should not become durable task work, and
read-only inspection do not automatically create request files.

### Same request versus new request

Continue the existing request when:

- the user is clarifying its acceptance criteria
- the previous run was incomplete or blocked
- the user asks for the next unfinished step of the same outcome
- a correction is necessary to satisfy the original criteria

Create a new request when:

- the earlier outcome was accepted and a new feature is requested
- the user changes scope materially
- the new work can be scheduled, completed, or dropped independently
- a completed learning topic advances to a new topic

When ambiguous, read first and ask one concise clarification before mutation.

## Read-Only Task Access

```text
resolve task candidate
-> validate path and Git identity read-only
-> read committed task card
-> read current request
-> read recent commits
-> inspect named paths if required
-> answer or decide whether mutation is necessary
```

Read-only access works for active, paused, and archived tasks. Archived status
affects default discovery views, not read permission.

Reading a dirty or locked task is allowed, but the context projection clearly
separates committed truth from working-tree health. It must not present dirty
content as committed durable context unless the user explicitly asked to
inspect those changes.

## Starting A Mutating Run

Every provider-handled turn can still begin as a session run.

Immediately before the first mutating action:

1. Resolve exactly one task.
2. Resolve or create the bounded request.
3. Read and retain the expected task HEAD.
4. Validate repository identity and schema.
5. Check operational health.
6. Acquire the exclusive task lock.
7. Recheck HEAD and working tree after the lock is acquired.
8. Promote/bind the same run ID to the task and request.
9. Authorize explicit task-relative targets.

If any check fails, no executable mutation runs.

## Working Tree Preconditions

Normal mutation requires a clean task repository except for:

- ignored `.ayati/inbox/` bytes
- changes already journaled and verified for the same active run
- engine-owned context changes created during the current finalization phase

Unjournaled changes are classified as external or recovery state. Ayati never
silently combines them with a new run.

Possible user-visible actions are:

- inspect the changes read-only
- ask the user whether they should become a baseline commit
- continue the interrupted run if provenance proves ownership
- wait for the user to clean/commit them

Automatic stash, reset, checkout, or cleanup is forbidden.

## Mutating Tool Step

For each mutating action:

```text
validate lock and expected HEAD
-> canonicalize declared targets
-> reject .git, engine-owned .ayati, escapes, and unsafe symlinks
-> snapshot pre-step Git status for authorized scope
-> execute tool
-> derive post-step changes using Git
-> reject unexpected paths
-> apply deterministic verification
-> journal step, provenance, and verification
-> retain verified changes for finalization
```

Tool output is evidence, not mutation truth. Git-derived paths and deterministic
assertions decide what changed and whether it is eligible to commit.

## Task Card And Request Reduction

Before final commit, the runtime reduces verified WorkState into bounded durable
context.

The reducer proposes:

- current snapshot changes
- current focus
- blockers
- important path additions/removals
- current request status and outcome
- next request activation, if already authorized by user intent

The Git Context Engine validates the proposed update against facts:

- completed claims require completion evidence
- validation claims match actual validation
- paths exist at the staged tree when claimed
- blockers and next steps are concise
- task and request state-machine transitions are valid
- the task card remains within size limits

The engine renders the final files. The model does not write reserved context
files directly.

## External Computer-Use Mutation

Computer-use work follows the same ownership lifecycle even when it does not
change ordinary task files:

```text
resolve task and request
-> acquire task lock and bind run
-> authorize typed external target/action
-> execute external tool
-> deterministically verify external result
-> record bounded identifiers/receipts in WorkState
-> update task card and request outcome
-> commit the durable context transition in the task repository
```

Examples include sending a specific message, updating a calendar event,
submitting a form, organizing records in an application, or changing an
automation service.

Rules:

- The external service remains canonical for its live state.
- Git records only verified useful context and appropriate non-secret
  references.
- Raw screenshots, tokens, page dumps, and tool traces remain external run
  evidence unless deliberately adopted as safe task artifacts.
- A Git revert does not claim to undo an external action.
- Irreversible or high-impact external actions retain their existing approval
  and safety policies; task binding is not authorization by itself.
- If verification is inconclusive, do not mark the request done.

## Finalization

Normal finalization is one repository transaction:

```text
run reaches terminal outcome
-> require no active mutating step
-> verify lock, base ancestry, and current HEAD
-> reject unverified or unexpected changes
-> render task/request/reference updates
-> stage verified task paths plus engine-owned context paths
-> inspect staged diff
-> create one final commit with deterministic metadata
-> verify commit tree and trailers
-> update SQLite run/task projections
-> mark transaction completed
-> release lock
```

There is no local push to a bare canonical repository and no session gitlink
update in V1.

### No durable change

If a run remained read-only, or a failed attempt produced neither verified task
changes nor a useful durable context transition:

- do not create a task commit
- finalize the run journal outside task Git
- leave task and request state unchanged

If a useful proven blocker or task transition must be remembered, the engine
may create a state-only task commit containing the task/request update. This is
not an empty commit.

A verified external computer-use action may also produce a context-only commit
that records its outcome and stable identifiers. The external action itself is
not represented as a Git file mutation.

## Commit Outcomes

### Completed

- Acceptance criteria are satisfied or explicitly accepted.
- Request becomes `done`.
- `current_request` becomes another already-authorized active request or
  `none`.
- Task normally remains `active` or may become `paused` when no work remains.

### Incomplete

- Verified partial work is committed.
- Request remains `active`.
- Task card records concise completed state, remaining focus, and next step.

### Blocked

- Verified work and useful blocker context are committed.
- Request becomes `blocked`.
- Task remains `active` or becomes `paused` only through policy/user intent.
- The exact condition needed to resume is recorded.

### Failed

- Verified useful changes may be committed if safe and accurately described.
- Unverified or ambiguous partial changes are never committed normally.
- Request normally remains `active` unless a durable blocker is established.
- Operational recovery may be required before another mutation.

## Pausing, Archiving, And Reopening

### Pause

Pausing is appropriate when the task should be retained but no current work is
scheduled. The task card status becomes `paused`; an active request should first
become blocked, queued, done, or dropped.

### Archive

Archiving is explicit. It changes the task card to `archived` in a normal
engine-owned commit. Files and history remain unchanged and readable.

### Reopen

```text
read archived/paused task context
-> confirm it is the intended workstream
-> set task status active
-> create or reactivate an appropriate request
-> commit the transition with the first mutating run
```

Do not reopen old sessions or runs. They remain sealed history.

## Attachment Lifecycle

### New upload before task selection

```text
receive bytes
-> persist in session/global temporary attachment storage
-> calculate identity/checksum
-> route the user turn
-> once a task is selected, copy/link bytes into its ignored inbox
-> add tracked reference entry in the final task commit
```

The pre-routing attachment must survive until routing completes. Failure to
route must not orphan or silently delete it.

### Mentioned external path

```text
validate path read-only
-> record external reference only when useful for durable task continuity
-> never grant task mutation ownership from mention alone
```

### Missing or changed attachment

Before use, compare availability/checksum. Update the manifest through a normal
task context transition only when the change matters durably. Ask the user to
reattach when bytes are required.

## Crash Recovery

The mutation journal records phases such as:

```text
lock_acquired
step_running
step_verified
context_rendered
changes_staged
commit_created
completed
recovery_required
```

Startup reconciliation examines journal, lock, HEAD, Git status, index, and
commit trailers.

### Case 1: clean repository at base HEAD

No durable mutation occurred. Mark the interrupted run failed/incomplete,
release the stale lock, and preserve its journal.

### Case 2: clean repository at a new commit with matching run trailer

The commit succeeded but acknowledgement failed. Validate parent/base,
trailers, task/request schema, and staged-tree expectations. Complete the
journal idempotently without creating another commit.

### Case 3: dirty repository with only verified journaled paths

Reconstruct the last acknowledged verified state. If every path and content
identity is provable, resume finalization or present a deterministic recovery
operation. Do not automatically finalize if required context reduction or
validation is missing.

### Case 4: dirty repository with unexpected or unverified paths

Mark `recovery_required`, preserve all files, allow read-only inspection, and
block further mutation. Require user-approved or explicitly implemented
reconciliation.

### Case 5: HEAD advanced externally

Do not reset or overwrite it. Release only locks proven stale, mark the old run
superseded/recovery-required as appropriate, rebuild task context from the new
HEAD, and require a fresh mutation decision.

### Case 6: task directory missing or invalid

Keep the catalog record as degraded evidence. Do not recreate a repository at
the same path unless identity and restoration source are proven.

## External User Edits

Users may edit task repositories outside Ayati. On the next mutation Ayati
detects dirty state or new commits.

- New clean commits become current Git truth after schema validation.
- Dirty edits are not automatically attributed to Ayati.
- A future explicit `capture_external_changes` operation may commit them with
  clear provenance after user approval and verification.
- V1 may instead require the user to commit or clean them manually.

The implementation must choose one safe V1 interaction before enabling broad
external editing; it must never silently absorb changes.
