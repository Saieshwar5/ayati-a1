# External Task Resource Bindings

Created: 2026-07-17

Status: planning complete; implementation not started.

## Purpose

This plan extends Ayati's durable task model beyond the current assumption that
every mutable resource must live inside one task checkout. It keeps one task
lifecycle while allowing a task to own files, adopt an existing non-Git
project, modify an external file or repository in place, publish an artifact,
or perform a verified operation through an API.

The core model is:

```text
task = durable user goal
workspace = Ayati-owned Git control repository
resource = file, directory, repository, destination, or remote object
run = one attempt or continuation
receipt = verified record of an external mutation
```

This plan preserves the harness:

```text
context pack
-> decision
-> action executor
-> deterministic verification
-> progress reducer
```

Resource binding extends routing, authority, verification, persistence, and
completion. It does not add a model-controlled controller stage.

## Files In This Plan

- `problem.md`: current limitation, motivating scenarios, goals, and non-goals.
- `decisions.md`: locked architecture and product decisions.
- `architecture.md`: unified task architecture, repository topology, routing,
  authority, verification, and completion boundaries.
- `resource-model.md`: workspace, resource, binding, observation, receipt,
  context, completion, manifest, and SQLite data contracts.
- `lifecycle.md`: owned, adopted, sidecar, filesystem, publish, Git, API,
  mixed-task, concurrency, failure, and recall lifecycles.
- `storage-and-recovery.md`: durable ownership, privacy, journals, leases,
  partial failure, crash recovery, and rebuilding operational state.
- `implementation.md`: staged implementation sequence and compatibility rules.
- `testing.md`: deterministic, integration, failure-injection, and live-test
  acceptance coverage.
- `conversation.md`: user direction and reasoning that produced this plan.
- `progress.md`: implementation checklist and append-only progress log.

## Primary Invariants

- Every durable mutation belongs to exactly one task run.
- Every task has an Ayati-owned Git control repository.
- A task has one workspace mode: `owned_checkout`, `adopted_checkout`, or
  `managed_sidecar`.
- Internal, external, and mixed are derived display labels, not separate task
  lifecycles.
- Task-owned resources are canonical in task Git.
- External resources remain canonical at their external locations.
- A resource binding remembers identity and policy; it is never permanent
  mutation authority.
- Every mutation requires current-run user intent, bounded authority,
  before/after provenance, and deterministic verification.
- Filesystem tool addresses remain canonical absolute paths. Git-relative
  paths remain private adapter details.
- Existing user Git repositories retain their remotes, branches, index, and
  unrelated changes.
- Ayati commits to a user-owned Git repository only when the user explicitly
  requests that commit.
- `.ayati/task.md` is the human task descriptor. Ayati never overwrites or
  repurposes a root `AGENTS.md`.
- External effects are journaled and identified idempotently before execution
  whenever the adapter supports it.
- Credentials, tokens, and secret file contents never belong in task manifests
  or Git history.
- The Git Context Engine remains the only owner of task/session Git and its
  operational SQLite state.

## Required Reading Before Implementation

Read, in order:

1. `project-docs/README.md`
2. `project-docs/product/overview.md`
3. `project-docs/engineering/README.md`
4. `project-docs/engineering/architecture/overview.md`
5. `project-docs/engineering/architecture/agent-harness.md`
6. `project-docs/engineering/architecture/context-and-memory.md`
7. `project-docs/engineering/architecture/tool-contracts.md`
8. `project-docs/engineering/testing.md`
9. Every file in this plan directory.

Relevant earlier notes:

- `agent-notes/git-context-engine-service-migration-2026-07-12/`
- `agent-notes/run-first-task-promotion-2026-07-07/`
- `agent-notes/conversation-task-run-lifecycle-2026-07-05/`
- `agent-notes/run-context-workstate-compaction-2026-07-06/`
- `agent-notes/plans/canonical-absolute-path-contract-plan.md`

When an older note assumes that every mutable resource must be inside the task
checkout, this plan controls future external-resource work. Implemented runtime
behavior remains authoritative until the corresponding implementation slice is
completed and verified.

## Recommended Implementation Order

1. Contracts, workspace modes, resource catalog, manifests, and migrations.
2. Resource routing, context projection, identity-only bindings, and leases.
3. Exact external-file mutation and atomic published outputs.
4. Resource-aware WorkState, completion, receipts, evidence, and recovery.
5. Existing user Git repository adapter with explicit commit policy.
6. Generic external-system receipt adapter for API tools.
7. Privacy hardening, failure injection, migration validation, and live tests.

## Do Not Do

- Do not implement separate internal-task and external-task run lifecycles.
- Do not grant unrestricted external filesystem access.
- Do not treat a saved binding as blanket future write permission.
- Do not copy editable external sources into a sidecar and create two
  authorities.
- Do not initialize Git in a broad destination such as Desktop merely to
  publish one file.
- Do not silently adopt an existing directory when the user only named one
  file inside it.
- Do not adopt an existing user Git repository into Ayati's canonical bare
  repository model.
- Do not replace a user repository's origin, reset its state, clean untracked
  files, or commit unrelated changes.
- Do not store API credentials in resource manifests or receipts.
- Do not claim atomicity across unrelated external resources.
- Do not rely on model-written evidence as mutation truth.
- Do not introduce a harness version switch or old controller stages.

## Success Definition

The architecture is complete when Ayati can safely route, mutate, verify,
remember, and continue tasks involving owned, adopted, external, and mixed
resources; completed task and session Git history remain compact and durable;
external resources remain in their original locations; and crash recovery does
not repeat an already-applied external effect.
