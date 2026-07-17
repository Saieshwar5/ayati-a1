# Implementation Plan

## Strategy

Implement this architecture as verified slices. Start with pure contracts and
readers, then create new-layout repositories, then move mutation/finalization,
then migrate legacy tasks, and only then delete obsolete write paths.

Do not change task discovery broadly during this plan. Exact ID/path listing is
enough to prove the repository lifecycle.

## Phase 0: Baseline And Contract Approval

Before editing runtime code:

1. Confirm the current branch and clean status.
2. Run focused existing Git Context Engine tests and record the baseline.
3. Read this whole plan and the stable architecture documents.
4. Inventory all current task creation, mounting, mutation, checkpoint,
   finalization, context-read, and attachment call paths.
5. Confirm the initial implementation slice with the user.

Create executable fixtures representing:

- learning
- coding
- computer use
- data analysis
- automation
- malformed task card
- missing current request
- ignored inbox bytes
- legacy `W-*` task

Exit criteria:

- Repository and file contracts are represented in typed tests.
- No live behavior has changed.
- Existing baseline failures, if any, are documented separately.

## Phase 1: Typed Repository Schemas

Add focused modules rather than expanding broad lifecycle files:

```text
ayati-git-context/src/tasks/task-repository-layout.ts
ayati-git-context/src/tasks/task-card.ts
ayati-git-context/src/tasks/task-request.ts
ayati-git-context/src/tasks/task-references.ts
ayati-git-context/src/tasks/task-repository-validator.ts
ayati-git-context/src/tasks/task-commit-metadata.ts
```

Exact names may follow local organization, but responsibilities must remain
separate.

Implement:

- task ID and request ID validation
- directory slug generation
- bounded frontmatter parser/renderer
- task card validation
- request file validation
- references manifest parser/renderer
- task/request state transition validation
- commit trailer parser/renderer
- repository layout validation
- canonical path and task-root containment

Do not use a broad YAML parser unless the small supported format genuinely
requires it. Prefer deterministic, explicitly validated scalar fields and
sections.

Schema errors must include stable codes and useful details such as task ID,
relative path, field, and expected values without exposing file content.

Suggested error classes:

```text
TASK_SCHEMA_UNSUPPORTED
TASK_CARD_INVALID
TASK_ID_MISMATCH
TASK_REQUEST_INVALID
TASK_REQUEST_STATE_INVALID
TASK_CURRENT_REQUEST_INVALID
TASK_REFERENCES_INVALID
TASK_REPOSITORY_INVALID
TASK_REPOSITORY_DIRTY
TASK_RECOVERY_REQUIRED
TASK_BUSY
```

Exit criteria:

- Round-trip rendering is deterministic.
- Malformed or oversized context is rejected safely.
- Unknown fields can be handled according to an explicit forward-compatibility
  rule; they are never silently reinterpreted.
- Fixtures pass without Git/SQLite side effects beyond temporary test repos.

## Phase 2: Read-Only V1 Task Reader

Implement the V1 reader before V1 creation becomes live.

The reader should:

1. Resolve the managed task path from trusted catalog identity.
2. Validate direct containment beneath the configured task root.
3. Verify the normal directory and exact Git top level.
4. Read `HEAD` and durable branch.
5. Read `.ayati/task.md` from `HEAD`.
6. Read the current request from `HEAD`.
7. Read recent semantic commits.
8. Report working-tree health separately.
9. Read important paths or other files only on demand.

Adapt or replace the current `task-context-reader.ts` so `importantPaths` comes
from the curated task card rather than every tracked file.

Add task context contract fields for:

```text
schema version
task status
current request summary
repository health
HEAD
recent commits
important paths
references summary when explicitly requested
```

Keep model-facing context compact. Internal absolute repository paths may be
used for authorization, but user/model-facing paths should be clear and stable.

Exit criteria:

- Any valid task can be read without a session mount or active-task mutation.
- Locked and archived tasks remain readable.
- Dirty working content does not replace committed context silently.
- Catalog caches can be stale without authorizing a mutation.

## Phase 3: V1 Task Creation

Change new managed task allocation to create one normal repository directly at:

```text
<task-root>/<task-id>-<slug>/
```

Creation transaction:

1. Allocate task ID idempotently in SQLite.
2. Validate the exact unused target path.
3. Create the directory.
4. `git init` the durable branch.
5. Configure the local Ayati commit identity.
6. Write `.gitignore`, task card, initial request, references manifest, and
   inbox `.gitkeep` atomically.
7. Validate the complete scaffold.
8. Stage the known scaffold paths.
9. Create the identity commit.
10. Record repository path and HEAD in the catalog.

Do not create a bare remote or clone the repository.

Creation must not occur merely because the model predicts that a new task may
be useful. Preserve run-first promotion: allocate the repository immediately
before the first durable mutation, except for an explicit task-management
command initiated by the user.

Exit criteria:

- A new task has exactly one repository directory.
- Retrying the creation request cannot create duplicates.
- Interrupted creation is recovered without deleting ambiguous data.
- The repository is independently understandable without SQLite.

## Phase 4: Request Service

Add an engine-owned request lifecycle service:

```text
createRequest
activateRequest
blockRequest
completeRequest
dropRequest
reopenRequest
listRequests
readRequest
```

These are internal lifecycle operations, not necessarily individual
model-facing tools.

Routing policy determines whether a user message:

- continues the active request
- creates a new request in the current task
- belongs to a different task
- creates a new task
- is read-only and creates no request
- needs clarification

Request creation and transition changes are staged with the run's final task
commit. Do not make a preliminary commit just to activate a request unless an
explicit user task-management action itself is the entire durable operation.

Exit criteria:

- At most one active request is enforced.
- Task-card `current_request` remains consistent.
- Completed requests remain immutable history except for explicit reopen.
- Request files are never silently deleted.

## Phase 5: Direct Task Mutation Authority

Adapt the existing mutation-boundary service from separate canonical and
working paths to one repository path.

New authority identity:

```text
authority ID
task ID
repository path
base HEAD
run ID
session ID
request ID
bounded targets
lock lease/recovery state
```

Remove normal dependencies on:

- canonical bare repository path
- mount checkout path
- mounted HEAD
- session task mount row

Preserve:

- expected-HEAD validation
- canonical path authorization
- symlink escape protection
- target declaration
- Git-derived mutation provenance
- unexpected-path rejection
- deterministic verification
- idempotency

General mutation continues to reject the repository root, `.git/`, and
engine-owned `.ayati/` paths. The context engine uses a separate internal path
to render reserved context during finalization.

Exit criteria:

- First mutation binds/promotes the session run to exactly one task.
- A second run cannot mutate the locked task.
- Reads do not need a lock.
- Unexpected dirty paths produce recovery state, not an automatic reset.

## Phase 6: Single-Commit Task Finalization

Replace checkpoint-push-finalization-gitlink-session orchestration with one
task-repository commit transaction.

Introduce focused owners if needed:

```text
task-finalization-service.ts
task-context-reducer.ts
task-repository-transaction.ts
task-recovery-service.ts
```

Finalization should:

1. Validate active run, task, request, lock, base HEAD, and ancestry.
2. Ensure no mutation authority remains in an unverified phase.
3. Derive all current changes from Git.
4. Match every non-context changed path to verified provenance.
5. Reduce WorkState into task-card and request updates.
6. Render reserved files through the engine.
7. Stage exactly verified paths and rendered context paths.
8. Reject empty staged state unless the operation is a real durable context
   transition.
9. Create one deterministic final commit.
10. Validate the new commit parent, tree, schemas, and trailers.
11. Persist the run's before/after identity and mark journal complete.
12. Release the lock.

Remove the need to:

- push to a local bare repository
- fast-forward a pointer checkout
- stage a session gitlink
- commit the session repository as part of task durability

Keep task conversation references in the run/session journal if useful. They
are optional task commit trailers, not required task files.

Exit criteria:

- One mutating run creates at most one normal final task commit.
- A purely read-only run creates none.
- The task is fully continuable from its Git repository.
- Interrupted acknowledgement is idempotently recovered from commit trailers.

## Phase 7: Attachments And References

Integrate the existing attachment preparation flow with task routing.

Implement:

- durable pre-routing attachment retention
- checksum and stable reference identity
- atomic task-inbox placement after task resolution
- tracked reference manifest update during task finalization
- availability validation on reuse
- explicit input adoption into tracked task files
- no automatic exclusive task ownership from shared attachment identity

Attachment content must never enter model prompts by scanning the inbox
automatically. Existing document preparation and bounded content extraction
remain the access path.

Exit criteria:

- Attachments survive routing and restart.
- Inbox contents remain ignored.
- Manifest entries remain portable enough to explain missing inputs.
- Critical input adoption is explicit and verified.

## Phase 7A: External Computer-Use Outcomes

Adapt external mutating tools to bind to one task and request without pretending
their targets are repository paths.

Implement:

- typed external resource/action authority
- existing approval and irreversible-action safety checks
- deterministic external result verification
- stable non-secret identifier/receipt extraction
- task-card/request reduction after verified external work
- context-only final task commits when no normal task file should change
- explicit messaging that Git revert does not undo the external system action

Raw browser/page/tool evidence remains in the run journal unless a safe artifact
is deliberately adopted into the task.

Exit criteria:

- Verified computer-use work is continuable from the task repository.
- Inconclusive external actions are not marked done.
- Task binding never bypasses external-action approval policy.
- No Git operation is described as rollback of external state.

## Phase 8: Routing And Continuation Semantics

Update task-routing projections and rules to use the new meanings:

```text
task = durable workstream
request = bounded intent
run = current attempt
```

Preserve:

- run-first read-only behavior
- conservative task resolution before mutation
- exact resource/task identity outranking weak similarity
- no silent fallback to an unrelated active task
- clarification when ownership is ambiguous

Update completion logic so:

- run completion can complete the current request
- request completion does not imply task archival
- an active task with no current request is valid
- a paused task can be read without reopening
- mutation of a paused/archived task requires an explicit lifecycle transition

Exit criteria:

- Website improvements become requests in the website task.
- Learning topics become requests in the learning task.
- Unrelated durable work creates a new task.
- Read-only enquiries create neither task nor request.

## Phase 9: Migration And Cutover

Execute `migration.md` using a read-only inventory and dry run first.

During the compatibility window, task rows need an explicit layout/version:

```text
legacy_independent_v0
simple_repository_v1
```

Dispatch readers by version. Only one writer is allowed for a given task. New
tasks use V1 after the creation cutover. Legacy tasks remain on their old
writer until individually migrated.

Do not introduce a model-facing harness version switch. Layout dispatch is an
internal persistence migration boundary.

Exit criteria:

- New V1 task writes are default.
- Every migrated task has one canonical V1 repository.
- Historical sessions and bare repositories remain readable.
- No task is writable through both old and new models.

## Phase 10: Remove Obsolete Write Paths

After migration acceptance:

- remove new-task bare-repository creation
- remove session task mounting from normal routing
- remove session gitlink staging from finalization
- remove local push-to-canonical steps
- remove unused mount database writes and recovery flows
- simplify contracts that expose repository/mount duplication
- delete obsolete tests only after equivalent V1 coverage exists
- update package README and stable architecture docs
- remove legacy `state.json`, task-branch, and other obsolete current-path
  descriptions from stable docs

Keep a narrow read-only legacy adapter as long as retained historical sessions
require it.

Exit criteria:

- No normal task mutation code depends on submodules.
- No stable documentation describes the removed model as current.
- Focused and full workspace tests pass.

## Suggested Commit Slices

1. `define simple task repository schemas`
2. `add v1 task repository reader`
3. `create normal managed task repositories`
4. `add durable task request lifecycle`
5. `bind mutation authority to task repositories`
6. `finalize task runs with one commit`
7. `link task inbox references`
8. `update task continuation semantics`
9. `migrate legacy task repositories`
10. `remove session task submodule writes`
11. `update git context architecture docs`

Each slice should be independently reviewable and tested.

## Performance Expectations

V1 should comfortably support hundreds or low thousands of local tasks without
scanning every repository for every turn.

- Exact task read: direct path plus bounded Git operations.
- Catalog listing: SQLite projection, with validation at selection/mutation.
- Task continuation: task card, one request, bounded log, curated paths.
- Full repository search: explicit on-demand operation.

Do not optimize task discovery by complicating repository truth.

## Observability

Add bounded structured lifecycle events for:

```text
task_v1.created
task_v1.read
task_v1.lock_acquired
task_v1.mutation_verified
task_v1.context_reduced
task_v1.commit_created
task_v1.finalized
task_v1.recovery_required
task_v1.recovered
task_v1.migrated
```

Record IDs, phases, HEADs, counts, statuses, durations, and error codes. Do not
record raw attachment contents, secret-bearing tool inputs, full task cards, or
full diffs in normal logs.
