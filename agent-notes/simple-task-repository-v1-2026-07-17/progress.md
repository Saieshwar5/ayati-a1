# Progress

Last updated: 2026-07-17

Current status: repository contracts, read-only context, and the isolated V1
creation/recovery engine are implemented. Default routing and V1 mutation
remain intentionally disabled.

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

- [ ] Create and queue requests.
- [ ] Activate at most one request.
- [ ] Block/resume, complete, drop, and explicitly reopen requests.
- [ ] Keep task card current request consistent.
- [ ] Integrate request routing rules.

Exit gate:

- [ ] Multiple features/lessons remain naturally inside one task.

## Phase 5: Direct Mutation Authority

- [ ] Bind authority to one task repository path and base HEAD.
- [ ] Add exclusive task lock.
- [ ] Remove V1 mount/canonical-repository duplication from authority.
- [ ] Preserve bounded targets, symlink safety, Git provenance, and
  verification.
- [ ] Block unjournaled dirty state conservatively.

Exit gate:

- [ ] Exactly one run can mutate a task safely without a session submodule.

## Phase 6: Single-Commit Finalization

- [ ] Add deterministic task-card/request reducer.
- [ ] Stage only verified task paths and rendered context paths.
- [ ] Create one final run commit with required trailers.
- [ ] Persist before/after identity in the run/session journal.
- [ ] Add acknowledgement recovery from matching commit trailer.
- [ ] Remove V1 push/gitlink/session commit finalization steps.

Exit gate:

- [ ] One mutating run creates at most one task commit and is fully continuable
  from Git.

## Phase 7: Attachments And References

- [ ] Retain attachments durably before routing.
- [ ] Place resolved task inputs atomically in ignored inbox.
- [ ] Write checksum/provenance reference entries.
- [ ] Detect missing/changed inputs on reuse.
- [ ] Add explicit verified adoption into tracked task paths.
- [ ] Cover shared attachment relationships.

Exit gate:

- [ ] Input provenance is durable without falsely claiming ignored bytes are
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
