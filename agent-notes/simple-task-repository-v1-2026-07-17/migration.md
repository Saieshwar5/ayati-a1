# Migration Plan

## Goal

Move current tasks from:

```text
bare canonical repository
+ stable working checkout
+ per-session submodule checkout/gitlink
```

to:

```text
one normal canonical task repository under the managed task root
```

without rewriting task history, invalidating historical session commits,
silently moving user data, or allowing two writers for one task.

## Migration Principles

- Inventory before mutation.
- Dry-run every task first.
- Stop new writes to a task while it migrates.
- Preserve all commit identities where possible.
- Add V1 context through a new normal commit; do not amend old commits.
- Preserve legacy `W-*` task IDs.
- Do not rewrite old session repositories or gitlinks.
- Do not delete bare repositories during initial migration.
- Never move an external user directory automatically.
- Every task has an explicit layout version and one writer.
- Failure leaves the task on its old readable layout or in a clearly blocked
  recovery state; it must not create an ambiguous hybrid writer.

## Current Cohorts

Classify every task before migration.

### Cohort A: managed clean working checkout

- Working checkout is under the configured managed task root.
- Working tree and index are clean.
- Working HEAD equals catalog task HEAD.
- Bare durable branch equals the same HEAD.

This is the simplest migration candidate. The working checkout becomes the V1
canonical repository.

### Cohort B: managed checkout with current legacy task state

Same as Cohort A, but `.ayati/task.md` is the initial descriptor and current
state exists mainly in the latest task-state commit trailers.

Migration renders the V1 task card and initial request from validated Git
history, then adds one migration commit.

### Cohort C: requested working directory outside task root

Do not move it automatically.

Options requiring explicit user direction:

- keep it on the legacy writer temporarily
- clone/import it into a new managed task directory while retaining the
  original as a reference
- designate it as an exceptional externally managed task in a future contract

V1 implementation must not weaken the one-root invariant silently to make this
cohort easier.

### Cohort D: dirty or interrupted checkout

Do not migrate until current recovery proves ownership of every change. Never
stash or reset it automatically.

### Cohort E: bare repository available but stable checkout missing

Create a new normal checkout under the managed root only after validating task
identity and branch HEAD. This is restoration, not history rewriting.

### Cohort F: diverged heads or invalid identity

Block automatic migration. Produce a report containing catalog HEAD, bare HEAD,
working HEAD, session gitlinks, dirty paths, and schema errors. Require focused
reconciliation.

## Inventory Record

The dry run records per task:

```text
task ID
catalog layout/version
title/objective cache
bare repository path and HEAD
working path and HEAD
working-tree/index status
durable branch
current .ayati/task.md identity
latest valid task-state commit
session mounts and gitlink heads
active locks/runs/finalizations
proposed cohort
proposed V1 path
blocking reasons
```

The report contains paths and hashes but not file contents or secrets.

## Quiescence Gate

Before migrating one task:

1. Block new mutation acquisition for that task.
2. Allow current readers to finish.
3. Require no active run or mutation authority.
4. Complete or reconcile pending finalization.
5. Re-read all HEADs and working status.
6. Persist a migration intent record idempotently.

Other tasks can remain available.

## V1 Context Synthesis

For a legacy task, derive:

- ID and title from validated descriptor/catalog.
- Purpose from the original objective.
- Current snapshot from the newest valid task-state commit plus important
  verified repository state.
- Current focus and blockers from latest status/next metadata.
- Important paths from existing curated metadata when valid; otherwise choose a
  conservative bounded set, not the entire tree.
- Working agreements from explicit durable user constraints only.

Create `R-0001` as the migration request when no request model exists.

Mapping:

```text
legacy task in_progress
-> task active
-> R-0001 active

legacy task blocked
-> task active
-> R-0001 blocked

legacy task done
-> task paused
-> R-0001 done
```

The request explains that it represents the pre-V1 objective and current
outcome. It must not invent acceptance criteria that were never established.

Initialize an empty references manifest and ignored inbox unless validated
legacy task asset/input data can be converted without moving bytes.

## Cohort A/B Migration Transaction

1. Acquire migration lock.
2. Validate clean working checkout and equal expected heads.
3. Record original catalog and repository paths.
4. Render V1 `.ayati/task.md`.
5. Create `.ayati/requests/R-0001-<slug>.md`.
6. Create `.ayati/references.md` and `.ayati/inbox/.gitkeep`.
7. Add/preserve `.gitignore` inbox rules.
8. Validate V1 repository contract.
9. Stage only migration scaffold changes.
10. Commit with deterministic metadata:

```text
migrate task context to repository v1

Task: W-20260712-0001
Request: R-0001
Outcome: migrated
Ayati-Schema: task/v1
Ayati-Event: task_repository_migrated
```

11. Update catalog layout, canonical repository path, working path, and HEAD in
    one SQLite transaction.
12. Mark the old bare repository retained/read-only in migration metadata.
13. Release lock and rebuild projections.

The normal task repository does not need to push the migration commit back to
the old bare repository. Doing so would advance a repository retained to serve
historical submodule relationships and could confuse old/new authority. The
migration record provides the boundary from old HEAD to new V1 HEAD.

## Historical Sessions And Submodules

Old session commits remain immutable. Their gitlinks continue to point at old
task commits in retained bare repositories.

Rules:

- Never rewrite `.gitmodules` in historical commits.
- Never force-update old task branches to make old sessions point at V1 HEAD.
- Keep old bare repositories available read-only for the defined legacy
  retention period.
- Legacy session readers can follow existing gitlinks as before.
- New V1 task runs record task ID and before/after commit in the session/run
  journal without adding a new submodule.

The same task identity therefore has a recorded migration boundary:

```text
legacy history through old HEAD
-> migration base mapping
-> V1 migration commit and later history in normal repository
```

Because the normal working checkout already contains legacy history, ancestry
remains continuous for Cohorts A and B.

## Catalog Schema Changes

Add or derive fields such as:

```text
layout_version
canonical_path
legacy_bare_path nullable
migrated_from_head nullable
migration_commit nullable
migration_status
repository_health
```

Do not overload task domain status with migration or health state.

Suggested migration status:

```text
not_required
pending
in_progress
completed
blocked
```

## New Task Cutover

After V1 creation and mutation tests pass:

1. Make new managed task creation use V1.
2. Keep legacy task dispatch based on catalog layout.
3. Prevent new session mounts for V1 tasks.
4. Prevent old finalization services from accepting V1 tasks.
5. Migrate legacy tasks in bounded batches.
6. Compare context projections and Git ancestry after each batch.

No task can switch writers based only on directory contents; catalog layout and
validated migration state control dispatch.

## Rollback

Before the migration commit/catalog switch, rollback means clearing the
migration intent after proving the repository is unchanged.

After the V1 migration commit is created but before any later V1 run:

- Do not reset or delete the commit automatically.
- Repair the catalog to the correct writer after validating state.
- If the V1 writer must be disabled, keep the task read-only and report the
  migration boundary.

After later V1 commits, there is no automatic rollback to the old writer.
Forward repair is required.

## Retiring Legacy Storage

Only after all of these are true may old bare repositories be considered for
archive/removal:

- every task is migrated or deliberately retained as legacy
- historical session restoration no longer requires local bare URLs, or a
  verified archival substitute exists
- retention policy is approved
- complete backups are verified
- a dry-run removal report identifies exact targets

Removal is a separate explicitly approved destructive operation. It is not part
of normal V1 implementation.

## Migration Acceptance

- No commit history was rewritten.
- No dirty external content was lost or silently committed.
- Every migrated task passes V1 validation.
- Every migrated task can continue without its old session submodule.
- Old sessions remain readable.
- New runs create one V1 task commit and no session gitlink update.
- Failed migrations remain safely readable and non-mutating.
