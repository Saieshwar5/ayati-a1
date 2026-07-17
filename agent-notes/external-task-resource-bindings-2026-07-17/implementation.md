# Implementation Plan

## Branching And Delivery

Implement runtime behavior on a new behavior-changing branch, separate from
this documentation branch. Use small verified commits by slice. Do not merge a
later adapter before the common resource model and recovery journal are stable.

The Git Context Engine owns persistence and resource lifecycle services.
`ayati-main` owns model-facing routing, tool execution, harness context,
WorkState, and completion integration. Adapter-specific mutation truth stays
with the executing tool/adapter and is normalized before crossing into Git
Context Engine persistence.

## Slice 1: Contracts, Catalog, And Workspace Modes

### Git Context Engine

- Add workspace mode to task contracts, catalog rows, projections, request
  validators, server routes, client methods, and task context.
- Replace model-facing ambiguous placement with explicit owned/adopted/sidecar
  workspace intent while retaining internal compatibility for existing
  `managed` and `requested` requests.
- Add resource, binding, alias, observation, authority, receipt, and operation
  journal contracts.
- Add idempotent SQLite migrations, constraints, and repository modules.
- Represent every new task checkout with an implicit `task_checkout` resource
  and binding.
- Backfill existing tasks conservatively without rewriting their Git history.

### Task repository metadata

- Add deterministic engine-owned resource manifest rendering, validation, and
  reading under `.ayati/resources/`.
- Preserve `.ayati/task.md` as the human descriptor.
- Prevent general task mutation authority from targeting engine metadata.

### Acceptance

- Existing task creation, activation, mutation, and finalization remain
  behaviorally unchanged.
- New sidecar tasks can be created with no external mutation enabled yet.
- Task/resource catalogs survive restart and exact retries.

## Slice 2: Binding, Routing, Context, And Leases

- Add turn-aware initial-resource proposals to task creation and a deterministic
  resource-binding operation for active/selected tasks.
- Validate binding evidence from the current user message, clarification, or
  verified read context.
- Canonicalize filesystem/Git/remote identity through adapter resolvers before
  creating resource records.
- Add exact resource lookup to task candidate ranking before semantic matching.
- Handle multiple task bindings through clarification rather than recency.
- Project bounded, relevant resource context into the model prompt.
- Add identity-only bindings and short-lived exact-resource lease acquisition.
- Keep the existing checkout authority implementation and expose both checkout
  and external authority behind one application executor contract.

### Acceptance

- A binding never authorizes a later mutation without current-run user intent.
- Exact resource identity routes to the correct task across sessions.
- Conflicting write leases fail before tool execution.
- Binding and lease operations are idempotent and recoverable.

## Slice 3: External Files And Published Outputs

### Exact external file adapter

- Extend bounded filesystem execution to match an absolute target against an
  active external binding.
- Capture full baseline identity/hash and recheck immediately before mutation.
- Reuse base-hash replacement and small-patch behavior.
- Write atomically and verify the real destination.
- Persist observations and normalized receipts before returning success.
- Restrict directory bindings to declared files/subtrees; never treat a broad
  directory binding as unrestricted host access.

### Atomic publish adapter

- Generate/validate artifacts in the owned checkout or sidecar.
- Observe destination and require replacement intent when it exists.
- Use same-directory temporary output and atomic rename.
- Verify the final external destination and create a publication receipt.

### Acceptance

- Standalone user files are modified in place without copying them into task
  Git.
- Desktop/report publication does not create a Git repository at the
  destination.
- Stale baselines, symlink escapes, unbound paths, and destination races fail
  closed.

## Slice 4: WorkState, Completion, Evidence, And Recovery

- Add bounded run resource states to WorkState reduction and context.
- Extend task completion requests/evaluation/results with resource outcomes.
- Require current-run verified receipts for external completion.
- Add `resources.jsonl` to session run evidence and include external outcomes
  in `run.json` and session commit metadata.
- Update finalization records and validators compatibly; historical runs
  deserialize with empty resource outcomes.
- Add external operation journal replay at startup.
- Reconcile effect-observed/receipt-persisted operations without re-execution.
- Add external-resource-aware evidence redaction, including patch inputs.

### Acceptance

- External-only tasks finalize through a normal task-state commit and session
  commit without requiring a fake internal asset.
- A crash after mutation but before Git finalization does not repeat the effect.
- Partial and unknown outcomes prevent false completion.

## Slice 5: Existing User Git Repository Adapter

- Detect canonical repository/worktree identity without changing configuration.
- Capture HEAD, branch/detached state, origin fingerprint, index fingerprint,
  status, target hashes, and unrelated dirty paths.
- Permit bounded edits while proving unrelated state is unchanged.
- Store run-derived per-target patches and post-edit observations.
- Default to no user-repository commit.
- When the current user explicitly requests a commit, stage and commit only
  separable run-produced changes while preserving unrelated index state.
- Reject ambiguous target commits, concurrent HEAD changes, hooks requiring
  interaction, protected/detached states without explicit handling, and
  unsupported worktree/submodule cases with clear recovery guidance.

### Acceptance

- Dirty unrelated user files and staged changes remain byte/index identical.
- Ayati never replaces origin, resets, cleans, or silently switches branches.
- The receipt identifies edits and optional explicit commit independently of
  the sidecar task-state commit.

## Slice 6: External API And Remote Effect Adapter

- Add a generic resource/receipt interface for tools annotated
  `mutatesExternalWorld`.
- Require each participating tool to provide resource identity resolution,
  intent/capability mapping, idempotency support classification, normalized
  verification, redaction, and compensation metadata.
- Journal deterministic idempotency keys before dispatch.
- Persist provider operation IDs immediately when returned.
- Treat timeouts after dispatch as unknown until reconciled.
- Refuse generic shell-based external-system mutation through this path; use
  explicit adapters with structured contracts.

### Acceptance

- Known external operations cannot be repeated by finalization/startup retry.
- Credentials and raw secret-bearing payloads do not enter manifests, context,
  receipts, or Git evidence.
- Tools without adequate identity/verification remain unsupported for durable
  external task completion.

## Slice 7: Hardening, Migration, Documentation, And Live Tests

- Add failure injection at every journal phase and every task/session
  finalization boundary.
- Add migration/rebuild tooling for resource indexes and implicit checkout
  resources.
- Validate large catalogs, many task bindings, locator aliasing, and context
  compaction.
- Run real daemon conversations covering every acceptance scenario.
- Update stable `project-docs/` only after implemented behavior is verified.
- Update tool schema descriptions, error repair guidance, and benchmark/live
  feedback expectations.
- Remove compatibility code only after historical/current task coverage proves
  it is no longer needed.

## Cross-Cutting Rules

- Use strict TypeScript and explicit public data shapes.
- Keep orchestration, persistence, policy, schema, rendering, adapters, and
  tests in focused modules.
- Preserve canonical absolute model-facing filesystem paths.
- Use private repository-relative Git paths only after authorization.
- Keep all lifecycle persistence idempotent and recoverable.
- Never let tool output alone define whether a mutation occurred.
- Run the smallest relevant tests first, then package builds/tests, then the
  full monorepo suite for shared runtime changes.
- Do not add legacy harness stages or version switches.

## Suggested Module Ownership

Avoid concentrating this feature in the existing task executor or contract
files. Introduce focused owners for:

- resource contracts and manifest rendering;
- resource catalog repositories and migrations;
- resource identity resolution;
- resource binding policy;
- mutation lease/journal/receipt services;
- application-layer resource authority routing;
- filesystem publish and external Git adapters; and
- resource completion/evidence projection.

Check target file sizes before implementation and extract focused modules when
an existing file is already broad or above repository guidance.
