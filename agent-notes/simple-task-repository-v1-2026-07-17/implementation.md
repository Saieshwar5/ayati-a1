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

The original slices established the V1 happy path. Before declaring the plan
complete, execute the reliability-closure slices and gates below. They
supersede any earlier progress checkbox that described a mocked, pure-policy,
or typed-service test as a complete live capability.

## Reliability Closure

Status: accepted next implementation design.

The task system is complete only when it is safe to replay, restart, rebuild,
migrate, and continue through every normal lifecycle. This section owns that
remaining work. It does not change the V1 repository contract or reintroduce
session submodules.

### Completion Invariants

1. A repeated model tool call cannot create a second task, request, migration,
   external action, or final commit.
2. Every valid request state has a live runtime transition: create, queue,
   activate, block, resume, complete, drop, and explicit same-intention reopen.
3. Every valid task state has a live runtime transition: active, paused,
   archived, and explicit reopen.
4. Losing rebuildable catalog rows does not make valid managed task
   repositories undiscoverable.
5. A migration interruption never exposes both writers and never silently
   leaves a partially migrated task writable.
6. External actions are represented by typed, verified, non-secret outcomes;
   Git records the outcome but does not claim to own or undo it.
7. Acceptance includes actual service restart and real agent routing, not only
   pure planners, mocked tools, or direct service calls.

### Closure Slice 1: Replay-Safe Model Routing

Use one stable operation identity derived from the durable model tool-call
record. Pass that identity through `ToolExecutionContext` and derive namespaced
Git Context request IDs for task creation, request planning, attachment binding,
and related routing writes.

Rules:

- Never generate a new idempotency identity merely because the same tool call
  is being recovered.
- The same operation identity plus the same payload returns the original
  result.
- The same operation identity plus a different payload fails closed.
- Recovery after task creation but before route acknowledgement returns the
  original task; it does not allocate another repository.
- External tools need their own provider/action idempotency key when supported.

Required tests:

- replay create-task before and after response persistence
- replay create-request activation
- crash after task identity commit but before route-plan acknowledgement
- payload mismatch for a reused operation identity
- no orphan repository or duplicate request after retry

### Closure Slice 2: Live Lifecycle Management

Keep pure transition validation in the existing lifecycle modules, but expose a
single runtime-owned lifecycle service. It validates committed state, plans the
transition, acquires exclusive authority, renders reserved files, creates one
context commit, and acknowledges the new HEAD.

Required request operations:

```text
create queued or active
activate queued
block active
resume blocked
complete active
drop queued, active, or blocked
reopen done only with explicit same-intention confirmation
```

Required task operations:

```text
pause active task only when no request is active
archive active or paused task explicitly
reopen paused or archived task explicitly
```

Model-facing routing should remain small. Normal activation may continue the
active request, create a separate request, activate a queued request, resume a
blocked request, or request the required task reopen. The service, not the
model, owns all `.ayati/` writes.

Required tests include the concrete broken path:

```text
active request -> blocked run -> current_request cleared -> service restart
-> resume the same request -> continue work -> one final commit
```

### Closure Slice 3: Catalog Rebuild

Add a bounded rebuild operation that scans only direct children of the managed
task root. For every candidate it must:

1. reject symlinks, nesting, path escapes, and non-repositories
2. validate Git top level, branch, HEAD, task card, requests, and task identity
3. classify duplicates and conflicts without choosing silently
4. reconstruct the catalog projection from committed Git truth
5. preserve live journals and locks rather than guessing their ownership
6. produce a dry-run report before applying database changes

Task ID allocation must consider both catalog rows and validated repository
identities on disk so a rebuilt or partially lost catalog cannot reuse an
existing ID.

### Closure Slice 4: Migration Recovery

Extend migration into a phase-journaled recoverable transaction:

```text
inventoried -> locked -> context_written -> commit_created
-> catalog_switched -> completed
```

Startup recovery inspects every non-terminal migration. It recognizes the
migration commit by parent and trailers, completes a safe catalog switch when
proof is sufficient, and otherwise leaves the task read-only with an exact
recovery report.

Additional requirements:

- `blocked` partial migrations remain writer-locked until explicitly
  reconciled or safely rolled back before a migration commit exists.
- Cohort E restores a missing checkout from the validated bare repository under
  the managed root.
- External-path tasks require explicit user direction.
- Inventory includes working/bare/catalog heads, dirty paths, schema errors,
  active authorities/finalizations, historical mount/gitlink heads, proposed
  path, cohort, and blockers.
- Historical session gitlinks must be resolved in tests after migration.
- Migrations run one task at a time or in a bounded batch with independent
  locks and reports.

### Closure Slice 5: Typed External Outcomes

Do not use filesystem download as the representative external mutation. Add a
shared contract for real external tools such as browser submission, email,
calendar, application updates, and automation services.

Minimum outcome shape:

```text
task ID, request ID, run ID, tool-call/action idempotency key
provider and action kind
non-secret target identity
started/completed timestamps
operation status and verification status
stable provider confirmation ID when available
safe receipt reference when appropriate
bounded verified summary
reversibility and follow-up guidance
```

Raw page dumps, screenshots, tokens, credentials, and secret-bearing URLs stay
in the protected run journal unless deliberately sanitized and adopted. An
external action can mark a request done only when its tool contract supplies
the required verification facts or the user explicitly accepts the outcome.

Approval happens before execution. If execution may have succeeded but
acknowledgement failed, recovery checks the provider using the action
idempotency key or confirmation identity before any retry.

### Closure Slice 6: Acceptance And Documentation

Run the scenarios in `testing.md` through the real agent routing surface:

- multi-day learning continuation
- website improvement in the same task
- attached-data analysis with restart availability
- blocked automation resumed later
- approved computer-use action with verified external confirmation

Every continuation scenario must close the original service/database handles,
start a new service instance, rediscover the task, and continue from committed
Git context. Inspect task files, Git status/log/trailers, SQLite before/after
identities, and absence of V1 mounts.

Only after these gates pass should `progress.md` mark the plan complete and
stable project documentation describe all of these capabilities without a
qualification.

### Still Deferred

The following remain outside reliability closure:

- embedding or semantic discovery
- smart folders, starring, and rich task views
- remote Git synchronization
- attachment-byte backup beyond explicit adoption
- multi-agent concurrent mutation and merge
- automatic capture of unrelated external dirty changes

They must not delay completing the basic create, close, reopen, continue, and
recover experience.

## Project Docs Update Plan

Status: proposed documentation work to execute in controlled slices. This plan
does not update `project-docs/` by itself.

### Documentation Principle

`project-docs/` is the stable description of what Ayati currently is and how it
currently works. It must not advertise a target capability as implemented only
because that capability is designed here.

Use this truth order while editing:

1. current source and executable contracts
2. deterministic tests and verified live behavior
3. current stable documentation
4. `agent-notes/` for accepted but unfinished direction

When the current implementation and the accepted target differ, stable docs
must state the current boundary and known limitation. The future design stays
in `agent-notes/` until its implementation and acceptance gate pass.

### Problems To Correct

The current stable docs mix at least three task models:

- old work branches inside daily Git context
- turn-aware `*_for_turn` task-routing tools
- the current independent mount-free `T-*` repository model

Specific contradictions to remove include:

- product docs calling task branches the default continuation store
- architecture docs naming `GitMemoryRuntime` and `src/context-engine` as the
  current task-repository owner instead of the independent Git Context service
- context, harness, and data-flow docs naming obsolete
  `git_context_activate_task_for_turn`, `git_context_create_task_for_turn`, and
  clarification tools as the current surface
- current-state documentation both describing model-facing V1 create/activate
  and forbidding those same tool names
- broad claims that migration, external computer-use outcomes, restart
  continuation, or catalog rebuild are complete when only a narrower path is
  verified

Historical decision and per-commit records remain historical evidence. Do not
rewrite them merely because the current architecture changed.

### Docs Slice 1: Establish One Canonical Task Architecture Page

Add `project-docs/engineering/architecture/task-repositories.md` as the stable
owner of the current task design. Keep it compact and link to source modules
rather than duplicating implementation details everywhere.

It should explain:

```text
task = durable workstream
request = bounded user intention inside the task
run = one attempt to advance a request
commit = verified durable outcome of a mutating run
session = temporary conversation/runtime container
```

Document the current repository layout:

```text
<managed-task-root>/T-YYYYMMDD-NNNN-<slug>/
  .git/
  .ayati/task.md
  .ayati/requests/
  .ayati/references.md
  .ayati/inbox/       ignored local input bytes
  task-owned content
```

Also document:

- one normal repository is both canonical history and stable working directory
- read-any-time access without a mount or task mutation
- explicit request selection before V1 mutation
- expected HEAD, exclusive authority, deterministic verification, and one
  final task commit
- task-relative Git paths versus absolute model-facing host paths
- ignored inbox versus tracked provenance and explicit adoption
- SQLite as live journal/catalog/lock state, with catalog rebuild still an open
  reliability-closure item until implemented
- legacy `W-*` layout dispatch and retained bare/session-gitlink compatibility
- current limitations for blocked/queued/task lifecycle transitions, migration
  recovery, and real external actions

Update reading-order links in:

- `project-docs/README.md`
- `project-docs/engineering/README.md`
- `project-docs/engineering/context-priority.md`

### Docs Slice 2: Reconcile Product Language

Update:

- `project-docs/product/overview.md`
- `project-docs/product/features.md`
- `project-docs/product/non-goals.md`

Replace task-branch language with long-lived independent task repositories and
bounded requests. Explain the user experience: create durable work once,
return later, read or continue it, and add new features/lessons as requests in
the same task.

Keep implemented and intended capabilities separate:

- current: `T-*` creation, mount-free selection, read, verified mutation,
  finalization, attachment provenance, and continue-or-create request routing
- incomplete: full lifecycle management, replay-safe model routing, catalog
  rebuild, hardened migration recovery, real external outcome tracking, and
  restart/live acceptance
- deferred: semantic discovery, remote synchronization, attachment-byte backup,
  and concurrent multi-agent mutation

### Docs Slice 3: Reconcile Runtime Architecture And Data Flow

Update the following as one architecture slice because they currently repeat
the old ownership model:

- `project-docs/engineering/architecture/overview.md`
- `project-docs/engineering/architecture/modules.md`
- `project-docs/engineering/architecture/backend-services.md`
- `project-docs/engineering/architecture/data-flow.md`
- `project-docs/engineering/architecture/context-and-memory.md`
- `project-docs/engineering/architecture/agent-harness.md`

Required changes:

- name `ayati-git-context` as the independent owner of task catalog, Git writes,
  locks, request plans, migration journal, and task finalization
- describe `ayati-main/src/app/git-context-runtime.ts` and the typed client as
  the daemon integration boundary
- remove obsolete work-branch creation, switching, and task-file descriptions
  from the current path
- preserve session-store documentation only for conversation/session
  persistence; do not imply it owns V1 task continuity
- describe the actual model-facing V1 create/activate surface and explicit
  continue-or-create request decision
- keep runtime ownership of `.ayati/` lifecycle writes, authority, staging,
  commits, and recovery
- separate legacy `W-*` adapters into an explicitly labeled compatibility
  subsection
- link to the canonical task-repository page instead of copying the full
  repository contract into the large context-and-memory and harness docs

`context-and-memory.md` and `agent-harness.md` are already large. Prefer
deleting obsolete duplicated task sections and linking to the canonical page
instead of adding another full description.

### Docs Slice 4: Contracts, Persistence, Security, And Operations

Update:

- `project-docs/engineering/architecture/api-contracts.md`
- `project-docs/engineering/architecture/database.md`
- `project-docs/engineering/architecture/runtime-data.md`
- `project-docs/engineering/architecture/tool-contracts.md`
- `project-docs/engineering/architecture/auth-and-trust.md`
- `project-docs/engineering/security.md`

Document the current boundary precisely:

- Git Context protocol/client/server ownership and mount-free V1 selection
- layout-dispatched legacy compatibility APIs
- operation idempotency and the current model-tool replay limitation
- SQLite canonical live journals versus Git canonical completed task context
- managed task root, normal repositories, ignored inboxes, retained legacy
  storage, and runtime databases
- task-scoped absolute-path authorization and private task-relative Git staging
- zero-file external authority as current infrastructure, while typed real
  external outcomes remain unfinished
- secrets, screenshots, page dumps, tokens, and unsafe receipts must not enter
  task Git
- Git revert never represents reversal of external state

After replay-safe routing, catalog rebuild, migration recovery, or typed
external outcomes are implemented, update these pages in the same code slice;
do not pre-document the target as current behavior.

### Docs Slice 5: Agent Guidance And Engineering Workflow

Update:

- `project-docs/engineering/ai-agent-instructions.md`
- `project-docs/engineering/common-mistakes.md`
- `project-docs/engineering/add-feature-workflow.md`
- `project-docs/engineering/code-review.md`

Future coding agents should be told to:

- start with the canonical task-repository page for task changes
- preserve task/request/run separation
- avoid task branches, task submodules, bare mirrors, and session gitlinks in
  normal V1 work
- keep request/task lifecycle changes runtime-owned
- preserve stable operation identity across retries
- treat the task catalog as rebuildable projection, not completed task truth
- never claim external state is reverted by Git
- update stable docs only for behavior proven by code and tests

Remove instructions that direct new work toward obsolete turn tools or task
branches.

### Docs Slice 6: Testing, Known Gaps, And Current State

Update:

- `project-docs/engineering/testing.md`
- `project-docs/engineering/test-gaps.md`
- `project-docs/engineering/headless-chat-scenarios.md`
- `project-docs/engineering/history/progress/current-state.md`

The testing docs should require:

- core Git Context contract/service tests
- daemon model-tool and agent-loop tests
- stable operation replay and payload-mismatch tests
- blocked request resume and paused/archived reopen tests
- service restart between continuation runs
- catalog rebuild dry-run/apply/conflict tests
- failure injection at every migration boundary
- historical session gitlink resolution after migration
- real external action verification, approval, receipt-safety, and uncertain
  acknowledgement recovery
- manual inspection of the five V1 example domains

Rewrite `current-state.md` as an honest implemented/remaining boundary. Remove
obsolete tool names and priorities, preserve genuinely current harness work,
and make the Reliability Closure items the leading task-context priorities.

### Docs Slice 7: Contradiction And Link Audit

After the content updates:

1. Search all non-history stable docs for old task-branch and `*_for_turn` tool
   language.
2. Classify every remaining occurrence as current, legacy compatibility, or
   historical context.
3. Verify every named source path, command, tool, API, and environment variable
   against the repository.
4. Verify the core reading order reaches the canonical task-repository page.
5. Run Markdown formatting/link checks if available and `git diff --check`.
6. Review the final diff for duplicated or contradictory architecture claims.

Suggested searches:

```bash
rg -n "task branch|work branch|task submodule|bare canonical|GitMemoryRuntime" project-docs --glob '*.md'
rg -n "git_context_.*_for_turn|git_context_create_task|git_context_activate_task" project-docs --glob '*.md'
rg -n "external outcome|catalog rebuild|migration recovery|idempot" project-docs --glob '*.md'
```

Occurrences inside `project-docs/engineering/history/decisions/` and
`project-docs/engineering/history/progress/commits/` may remain when they
accurately describe their historical point in time. Current-facing docs must
not link to those historical descriptions as the active architecture.

### Documentation Exit Gate

The project-docs update is complete when:

- one canonical stable page explains the current V1 task architecture
- product, architecture, data-flow, agent-guidance, testing, and current-state
  pages agree with it
- current behavior and accepted-but-unimplemented reliability work are clearly
  separated
- no current-facing page directs agents toward obsolete task branches,
  submodules, bare mirrors, or old routing tools
- historical records remain intact
- all source paths and tool/API names are verified
- `git diff --check` and available documentation checks pass

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
