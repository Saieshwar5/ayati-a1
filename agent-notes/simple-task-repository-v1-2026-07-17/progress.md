# Progress

Last updated: 2026-07-17

Current status: repository contracts, read-only context, isolated creation,
request planning, direct mutation, single-commit finalization, and durable
attachments/references are implemented. The Phase 8 state-aware routing policy
is implemented; candidate/request projection, applying request plans, and
default V1 routing remain intentionally disabled.

## Planning

- [x] Inspect current repository state and branch.
- [x] Read stable product, architecture, harness, context, and testing docs.
- [x] Review earlier git-native, run-first, task lifecycle, migration, and task
  discovery plans.
- [x] Inspect current task repository, working checkout, submodule, task-state,
  read-context, mutation, and finalization implementation.
- [x] Identify task as durable workstream rather than finite run outcome.
- [x] Introduce bounded request as a separate durable concept.
- [x] Define one normal managed task repository as canonical and working state.
- [x] Remove mandatory session submodules from the target V1 lifecycle.
- [x] Define task card, requests, references manifest, and ignored inbox.
- [x] Define read, mutation, finalization, reopening, attachment, and recovery
  lifecycles.
- [x] Define migration cohorts and non-destructive cutover.
- [x] Define deterministic test and failure-injection coverage.
- [x] Record accepted decisions and planning conversation.
- [x] Add the plan to `agent-notes/README.md`.

## Implementation Gate

Before implementation begins:

- [x] User approves the first implementation slice.
- [x] Create `refactor/simple-task-repository-v1` or another agreed behavior
  branch from the correct integration point.
- [x] Confirm clean worktree and test baseline.
- [x] Read every file in this plan directory.
- [x] Reconcile any implementation completed after this plan's inspection.
- [x] Show expected files, migration impact, and focused tests for Slice 1.

## Phase 0: Contracts And Fixtures

- [x] Add learning, coding, computer-use, analysis, and automation repository
  fixtures.
- [x] Add invalid/malformed/legacy fixtures.
- [x] Define stable error codes.
- [x] Record baseline package and workspace tests.

Exit gate:

- [x] Typed fixtures express the repository contract without changing live
  behavior.

## Phase 1: Repository Schemas

- [x] Implement task layout module.
- [x] Implement task card parser, validator, and renderer.
- [x] Implement request parser, validator, and renderer.
- [x] Implement references manifest parser, validator, and renderer.
- [x] Implement task/request transition validation.
- [x] Implement commit metadata parser and renderer.
- [x] Implement V1 repository validator.
- [x] Add schema and security tests.

Exit gate:

- [x] All schemas round-trip deterministically and reject malformed state.

## Phase 2: Read-Only V1 Context

- [x] Add catalog layout/version dispatch.
- [x] Implement V1 task read projection from committed Git state.
- [x] Read only the current request by default.
- [x] Parse bounded semantic commit history.
- [x] Use curated important paths.
- [x] Report repository health separately.
- [x] Prove no read-side mount/lock/write behavior.

Exit gate:

- [x] Valid V1 tasks can be read at any time without activation.

## Phase 3: V1 Task Creation

- [x] Allocate `T-*` IDs and managed paths.
- [x] Create normal non-bare repository directly under task root.
- [x] Write full standard scaffold.
- [x] Create deterministic identity commit.
- [x] Add idempotent creation/recovery.
- [x] Remove bare/clone creation from the V1 path.

Exit gate:

- [x] A new task has exactly one canonical repository directory.

## Phase 4: Request Lifecycle

- [x] Create and queue requests.
- [x] Activate at most one request.
- [x] Block/resume, complete, drop, and explicitly reopen requests.
- [x] Keep task card current request consistent.
- [x] Integrate request routing rules.

Exit gate:

- [x] Multiple features/lessons remain naturally inside one task.

## Phase 5: Direct Mutation Authority

- [x] Bind authority to one task repository path and base HEAD.
- [x] Add exclusive task lock.
- [x] Remove V1 mount/canonical-repository duplication from authority.
- [x] Preserve bounded targets, symlink safety, Git provenance, and
  verification.
- [x] Block unjournaled dirty state conservatively.

Exit gate:

- [x] Exactly one run can mutate a task safely without a session submodule.

## Phase 6: Single-Commit Finalization

- [x] Add deterministic task-card/request reducer.
- [x] Stage only verified task paths and rendered context paths.
- [x] Create one final run commit with required trailers.
- [x] Persist before/after identity in the run/session journal.
- [x] Add acknowledgement recovery from matching commit trailer.
- [x] Remove V1 push/gitlink/session commit finalization steps.

Exit gate:

- [x] One mutating run creates at most one task commit and is fully continuable
  from Git.

## Phase 7: Attachments And References

- [x] Retain attachments durably before routing.
- [x] Place resolved task inputs atomically in ignored inbox.
- [x] Write checksum/provenance reference entries.
- [x] Detect missing/changed inputs on reuse.
- [x] Add explicit verified adoption into tracked task paths.
- [x] Cover shared attachment relationships.

Exit gate:

- [x] Input provenance is durable without falsely claiming ignored bytes are
  recoverable from Git.

## Phase 7A: External Computer-Use Outcomes

- [ ] Bind external mutation to one task, request, and run.
- [ ] Preserve existing approval and irreversible-action policies.
- [ ] Verify external outcomes deterministically where possible.
- [ ] Extract stable non-secret identifiers or safe receipts.
- [ ] Create context-only task commits when no normal file is appropriate.
- [ ] Keep raw page/screenshot/tool evidence outside task Git by default.
- [ ] Never describe Git revert as undoing external state.

Exit gate:

- [ ] Verified computer-use work can continue from task Git without pretending
  Git owns the external system.

## Phase 8: Routing And Status Semantics

Slice progress:

- [x] Resolve explicit routing decisions against durable task/request state.
- [x] Make exact task/resource ownership outrank weak candidate similarity.
- [x] Distinguish continuation, active/queued request creation, task selection,
  task creation, read-only access, clarification, and lifecycle transition.
- [x] Add task/request/run semantics to stable harness routing guidance.
- [ ] Project compact lifecycle/current-request state for V1 task candidates.
- [ ] Persist and apply resolved request plans through the live V1 run path.
- [ ] Switch default live routing from legacy task activation to V1.

- [ ] Update routing around task/request/run separation.
- [ ] Preserve read-first session runs.
- [ ] Ensure request completion does not archive task.
- [ ] Support active task with no current request.
- [ ] Require lifecycle transition before archived/paused mutation.
- [ ] Cover learning, website, computer-use, analysis, and automation flows.

Exit gate:

- [ ] The agent consistently chooses continue request, create request, choose
  another task, create task, read only, or clarify.

## Phase 9: Migration

- [ ] Add dry-run inventory and cohort classification.
- [ ] Add per-task quiescence/migration lock.
- [ ] Migrate clean managed tasks with one V1 migration commit.
- [ ] Preserve `W-*` IDs and ancestry.
- [ ] Preserve old bare repositories read-only.
- [ ] Preserve historical session gitlinks.
- [ ] Block dirty, diverged, invalid, and external-path cohorts safely.
- [ ] Prove only one writer per task.

Exit gate:

- [ ] Migrated tasks continue through V1 without rewriting or losing legacy
  history.

## Phase 10: Cutover And Cleanup

- [ ] Make V1 default for new managed tasks.
- [ ] Stop new session mounts for V1 tasks.
- [ ] Stop old finalization services from writing V1 tasks.
- [ ] Remove normal bare repository creation.
- [ ] Remove normal task push and gitlink staging.
- [ ] Remove obsolete mount writes and recovery paths.
- [ ] Keep only necessary read-only legacy adapters.
- [ ] Update package and stable architecture docs.
- [ ] Remove contradictory old current-path docs.

Exit gate:

- [ ] No normal V1 task mutation depends on submodules or a bare local mirror.

## Verification

- [x] Focused schema tests pass.
- [x] Focused repository lifecycle tests pass.
- [ ] Crash/failure-injection matrix passes.
- [ ] Migration cohort tests pass.
- [x] `pnpm --filter ayati-git-context test` passes.
- [x] `pnpm --filter ayati-git-context build` passes.
- [x] Relevant `ayati-main` app/harness tests pass.
- [x] `pnpm --filter ayati-main test` passes.
- [x] `pnpm --filter ayati-main build` passes.
- [x] `pnpm test` passes.
- [x] `pnpm build` passes.
- [ ] Five live acceptance scenarios pass and are manually inspected.

## Deferred After V1

- [ ] Rich task discovery and navigation.
- [ ] Resource ownership catalog integration.
- [ ] Smart views, starring, frequency, and categories.
- [ ] Semantic/embedding search if later justified.
- [ ] Content-addressed attachment backup.
- [ ] Remote Git synchronization and collaboration.
- [ ] Multi-agent mutation/merge workflow.
- [ ] Optional measured safety checkpoints.
- [ ] Explicit external-change capture workflow.

## Implementation Log

Add dated entries here after each verified implementation slice. Include:

- branch and commit
- behavior changed
- paths changed
- tests run and results
- migration/recovery evidence
- remaining blockers or decisions

### 2026-07-17: V1 contracts and fixtures

- Branch: `refactor/simple-task-repository-v1`
- Commit: the implementation commit containing this entry.
- Added pure V1 task-card, request, references, layout, commit-metadata, and
  repository-validation contracts. No live creation, routing, mutation,
  submodule, finalization, or migration path uses them yet.
- Added five domain fixtures plus malformed, legacy-identity, dirty-tree,
  tracked-inbox, request-consistency, reference-consistency, symlink, and
  nested-repository coverage.
- Focused result: 2 test files and 20 tests passed.
- Package result: 12 test files and 101 tests passed; package build passed.
- Workspace result: CLI 38 tests, Git Context 101 tests, and backend 844 tests
  passed; full workspace build passed.
- Migration evidence: the validator accepts legacy `W-*` identity without
  rewriting it. Actual repository migration and recovery remain later phases.
- Next slice: Phase 2 read-only V1 context and catalog layout dispatch.

### 2026-07-17: Read-only V1 context and layout dispatch

- Branch: `refactor/simple-task-repository-v1`
- Commit: the implementation commit containing this entry.
- Added schema migration 12 with explicit `legacy_independent_v0` and
  `simple_repository_v1` catalog ownership. Existing and newly created legacy
  rows default explicitly to the legacy reader/writer.
- Split task context reading into a layout dispatcher, an unchanged legacy
  reader, and a V1 reader. V1 context comes from committed `HEAD`, reads only
  the current request body, caps recent history at 12 commits, uses task-card
  important paths, and reports working-tree health separately.
- V1 `getTask` responses now include durable context without activation,
  mounts, locks, catalog writes, or repository writes. V1 mount and mutation
  entry points fail closed until their dedicated implementation slices.
- Replaced full committed-tree enumeration in V1 validation with `.ayati`-only
  enumeration and targeted `git cat-file` existence checks.
- Focused result: 3 files and 25 tests passed. Package result: 13 files and 106
  tests passed; package build passed.
- Workspace result: CLI 38 tests, Git Context 106 tests, and backend 844 tests
  passed (988 total); full workspace build passed.
- Migration evidence: an omitted layout column resolves to
  `legacy_independent_v0`; V1 dispatch is catalog-driven and never inferred
  from filesystem shape.
- Next slice: Phase 3 V1 task creation, with normal repositories under the
  configured task root and idempotent initialization recovery.

### 2026-07-17: Isolated V1 task creation and recovery

- Branch: `refactor/simple-task-repository-v1`
- Commit: the implementation commit containing this entry.
- Added deterministic `T-YYYYMMDD-NNNN` allocation and one normal repository
  at `workspace/tasks/<task-id>-<slug>/`, with repository and working paths
  intentionally identical.
- Added atomic creation of `.gitignore`, the task card, initial `R-0001`
  request, empty references manifest, and inbox `.gitkeep`, followed by one
  deterministic V1 identity commit and committed-repository validation.
- Added idempotent recovery from allocation, directory creation, Git init,
  scaffold writing, identity commit, repository validation, and catalog
  activation boundaries. Startup recovery can finish initializing V1 rows.
- Added a short-lived task-specific ownership marker. Recovery accepts only
  that marker, an exact generated scaffold, or a valid identity commit; empty
  pre-existing and otherwise ambiguous directories remain untouched and
  blocked across retries.
- The creator is deliberately staged on `TaskLifecycleService.createSimpleTask`.
  Existing `createTask` and task-run promotion remain legacy until direct V1
  mutation and finalization are implemented, preventing a half-working
  create-then-mount flow.
- Focused result: 1 creation test file and 13 tests passed. Package result: 14
  files and 119 tests passed; package build passed.
- Workspace result: CLI 38 tests, Git Context 119 tests, and backend 844 tests
  passed (1,001 total); full workspace build passed.
- No bare repository, clone, remote, session mount, or gitlink is created by
  the V1 path.
- Next slice: Phase 4 request lifecycle, beginning with deterministic request
  creation/queueing and the one-active-request invariant.

### 2026-07-17: Deterministic request lifecycle planning

- Branch: `refactor/simple-task-repository-v1`
- Commit: the implementation commit containing this entry.
- Added a pure request lifecycle planner for create, activate, block, resume,
  complete, drop, explicit reopen, read, and list operations.
- Plans bind to an expected Git HEAD and contain exact rendered task-card and
  request writes, changed request state, completion evidence, and an explicit
  empty delete set. The planner performs no Git, filesystem, SQLite, mount,
  lock, or commit operation.
- Enforced monotonic request IDs, at most one active request, task-card pointer
  consistency, terminal dropped state, explicit same-intention reopen, and
  verified or user-accepted completion.
- Resolved the blocked-request wording conflict: blocking clears
  `task.md.current_request` and records a request-named task blocker; resuming
  restores the pointer only when no other request is active.
- Added the explicit routing decision vocabulary for continuing, creating an
  active or queued request, selecting another task, creating a task, read-only
  work, and clarification. No keyword routing heuristic was introduced.
- Focused result: 1 lifecycle test file and 14 tests passed. Package result: 15
  files and 133 tests passed; package build passed.
- Workspace result: CLI 38 tests, Git Context 133 tests, and backend 844 tests
  passed (1,015 total); full workspace build passed.
- A real committed V1 fixture proves planning leaves repository HEAD, status,
  task card, and request files unchanged.
- Next slice: Phase 5 direct V1 mutation authority, binding one run and request
  to the single repository path without mounts, clones, pushes, or gitlinks.

### 2026-07-17: Direct V1 mutation authority

- Branch: `refactor/simple-task-repository-v1`
- Commit: the implementation commit containing this entry.
- Added layout-aware mutation authority persistence with one direct repository
  path, base HEAD, active task-request identity, run/session ownership, bounded
  targets, hashed lease token, expiry, verification, and recovery state.
- V1 acquisition validates the normal repository, committed task identity,
  durable branch, expected HEAD, current active request, clean working tree,
  and canonical targets. It acquires the exclusive task lease, rechecks the
  filesystem state and targets, then promotes the same session run to the task
  and request without creating a mount or session submodule.
- Preserved the legacy mount/bare-repository authority path. Compatibility
  columns remain in SQLite for existing rows, but V1 responses and behavior
  expose and use only `repositoryPath`; legacy checkout and canonical fields
  are omitted from V1 authority responses.
- Preserved portable bounded targets, root/`.git`/`.ayati` rejection, symlink
  containment, token verification, Git-derived create/modify/delete/rename
  provenance, unexpected-path recovery, failed-tool handling, and idempotency.
- V1 provenance compares directly with the base HEAD. Ignored inbox bytes are
  excluded from normal mutation provenance while the tracked inbox `.gitkeep`
  remains protected engine-owned state.
- Added deterministic expired-lease conversion to `recovery_required` and
  conservative rejection of unjournaled dirt without reset, checkout, clean,
  stash, deletion, or automatic baseline capture.
- V1 verified changes remain in the direct working repository. The legacy
  checkpoint service rejects V1 authorities so Phase 5 cannot accidentally
  stage them through the old mount/push/gitlink lifecycle; Phase 6 owns the
  single final task commit.
- Package result: 16 files and 143 tests passed; package build passed.
- Workspace result: CLI 38 tests, Git Context 143 tests, and backend 844 tests
  passed (1,025 total); full workspace build passed.
- Next slice: Phase 6 single-commit V1 finalization, including deterministic
  task/request reduction, exact staging, one task commit, journal
  acknowledgement, and safe lease release.

### 2026-07-17: Single-commit V1 finalization

- Branch: `refactor/simple-task-repository-v1`
- Commit: the implementation commit containing this entry.
- Added a separate V1 finalization path and durable finalization journal. The
  journal records the authority, base HEAD, exact reduction plan, verified
  file-state fingerprint, context before-hashes, expected staged paths, commit
  identity, and acknowledgement phase before filesystem mutation begins.
- Added a deterministic task/request reducer for done, incomplete, blocked,
  needs-user, and failed outcomes. The reducer keeps the long-lived task
  active, advances request state and current-request identity consistently,
  and records only verified completion assets as important task paths.
- Engine-owned task and request context is rendered separately from tool-owned
  changes. Finalization checks the planned before-hashes so it never silently
  overwrites context edited after the journal was created.
- V1 finalization stages only the exact verified tool paths and rendered
  context paths, rejects any additional dirty or staged path, and rechecks
  verified content and file modes before staging, after staging, and in the
  committed tree.
- A successful mutating run creates exactly one direct task-repository commit
  whose parent is the authority base HEAD and whose message and changed paths
  match the journal. No clone, push, session mount, gitlink update, or session
  repository commit participates in the V1 path.
- Context-only successful outcomes can create the one final commit. A failed
  run with no verified changes leaves task context and HEAD unchanged while
  still closing the run safely.
- Startup recovery recognizes an exact committed-but-unacknowledged result by
  parent, message, path set, and content fingerprint, then acknowledges it
  without creating a duplicate commit. A semantically identical retry may use
  a new transport request ID; changed retry payloads are rejected.
- Completion asset normalization now uses the direct V1 working directory
  when no legacy checkout path exists. Legacy finalization behavior remains
  available and unchanged.
- The V1 creator is still staged behind `createSimpleTask`; default task
  creation remains on the legacy route until a later intentional cutover.
- Package result: 17 files and 153 tests passed; package build passed.
- Workspace result: CLI 38 tests, Git Context 153 tests, and backend 844 tests
  passed (1,035 total); full workspace build passed.
- Next slice: Phase 7 attachments and references, beginning with durable input
  retention, atomic inbox placement, and checksum/provenance records.

### 2026-07-17: Durable attachments and task references

- Branch: `refactor/simple-task-repository-v1`
- Commit: the implementation commit containing this entry.
- Added protocol 21 attachment operations for pre-routing session retention,
  post-routing V1 task binding, and explicit adoption under mutation authority.
  The main chat runtime now registers and records inputs before task routing,
  so clarification or ambiguous routing cannot discard them.
- Added SQLite migration 15 for session attachment occurrences and durable
  task/reference binding journals. One retained asset may be related to more
  than one task; no attachment identity grants exclusive task ownership.
- Resolved V1 task inputs are copied atomically into unique `REF-NNNN-*` paths
  beneath the ignored `public/inbox/`. Copies are checksum-verified, fsynced,
  no-overwrite, symlink-safe, restart-idempotent, and never staged as task
  content.
- Task finalization merges journaled references into
  `.ayati/references.md` in the same single task commit as the run. Recovery
  verifies the committed context bytes before acknowledging the journal, and
  failed finalization marks uncommitted bindings as recovery-required.
- Task reads dynamically classify referenced inputs as available, missing, or
  changed from their current bytes. Git clones therefore cannot falsely claim
  that ignored inbox inputs are present.
- Added explicit reference adoption into a bounded tracked destination. It
  requires an active, unexpired V1 mutation authority, preserves the original
  inbox bytes, verifies the checksum, and lets ordinary provenance/finalization
  commit the adopted file.
- Attachment contents remain outside normal automatic prompt scanning. The
  existing managed document/file preparation path remains responsible for
  bounded content access.
- Focused result: Git Context attachment, contract, and HTTP coverage passed;
  daemon engine and upload integration coverage passed.
- Workspace result: CLI 38 tests, Git Context 159 tests, and backend 844 tests
  passed (1,041 total); the full workspace build passed.
- Migration/recovery evidence: retained attachment identity survives a service
  restart; collision retries reuse only checksum-identical destinations;
  commit acknowledgement verifies exact `.ayati/references.md` content; missing
  and changed ignored inputs are detected without dirtying Git.
- Next slice: Phase 7A external computer-use outcomes, beginning with typed
  task/request/run binding and deterministic safe-receipt capture for verified
  external mutations.

### 2026-07-17: State-aware task/request routing policy

- Branch: `refactor/simple-task-repository-v1`
- Commit: the implementation commit containing this entry.
- Phase 7A external computer-use durability was explicitly deprioritized so
  the core task lifecycle can become usable first.
- Extended the Phase 4 routing vocabulary into a pure state-aware resolver.
  It validates explicit decisions against whole task/request state without
  using keyword heuristics or performing Git, filesystem, SQLite, mount, lock,
  task creation, or request mutation side effects.
- The resolver distinguishes continuing the exact active request, planning a
  new active or queued request in the same task, selecting another task,
  creating a distinct task, read-only access, clarification, and required
  paused/archived lifecycle transitions.
- Exact user-supplied task identity and proven resource ownership are strong
  evidence. Conflicting or multiple strong owners produce clarification rather
  than silently choosing a recent or textually similar task.
- Read-only routing may name active, paused, or archived tasks without
  reopening them. Mutation-oriented routing for paused or archived tasks
  produces an explicit lifecycle-transition requirement.
- Updated stable harness and Git Context skill guidance with the durable model:
  task is a long-lived workstream, request is one bounded outcome, and run is
  one attempt. Request completion does not archive its task.
- Focused result: 2 Git Context routing/lifecycle files and 25 tests passed;
  4 harness routing/decision/schema files and 65 tests passed.
- Workspace result: CLI 38 tests, Git Context 170 tests, and backend 844 tests
  passed (1,052 total); the full workspace build passed.
- No protocol, database, repository, or default live-routing behavior changed
  in this policy slice.
- Next slice: project compact V1 task lifecycle/current-request state into
  routing candidates, then persist and apply a resolved request plan when the
  same session run is promoted for its first mutation.
