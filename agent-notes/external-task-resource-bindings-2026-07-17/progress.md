# Progress: External Task Resource Bindings

Created: 2026-07-17

## Status

Current status: planning complete; implementation not started.

Planning branch:

```text
docs/external-resource-plan
```

Runtime implementation must use a separate behavior-changing branch.

## Planning Checklist

- [x] Define the current single-root problem.
- [x] Preserve one task/run lifecycle.
- [x] Define owned, adopted, and sidecar workspace modes.
- [x] Define internal/external/mixed as derived labels.
- [x] Define task/resource/binding separation.
- [x] Define intent-based directory adoption.
- [x] Define existing user Git repository policy.
- [x] Define identity-only persistent bindings and per-run leases.
- [x] Define `.ayati/task.md` plus resource manifests.
- [x] Define storage ownership across task Git, session Git, SQLite, and
  external locations.
- [x] Define observation, receipt, completion, and WorkState models.
- [x] Define concurrency, privacy, partial failure, and recovery behavior.
- [x] Define staged implementation and testing plans.

## Implementation Checklist

### Slice 1: Contracts and persistence

- [ ] Create runtime implementation branch.
- [ ] Read required stable docs and every file in this plan.
- [ ] Add workspace mode contracts and task catalog migration.
- [ ] Add resource/binding/observation/authority/receipt contracts.
- [ ] Add SQLite tables, indexes, constraints, and repositories.
- [ ] Add implicit checkout resources and compatibility projection.
- [ ] Add deterministic engine-owned resource manifests.
- [ ] Preserve all existing task behavior and tests.

### Slice 2: Binding and authority

- [ ] Add initial resource proposals and turn-aware binding operation.
- [ ] Validate current user/clarification/verified-read binding evidence.
- [ ] Add exact resource routing and ambiguity handling.
- [ ] Add bounded task resource context.
- [ ] Add resource leases and operation journals.
- [ ] Integrate external authority with the task-scoped executor.

### Slice 3: Filesystem resources

- [ ] Add exact external-file observation and mutation.
- [ ] Add bounded external-directory targeting.
- [ ] Add atomic published-output adapter.
- [ ] Add baseline race and symlink containment enforcement.
- [ ] Add normalized filesystem receipts.

### Slice 4: Harness, evidence, and recovery

- [ ] Extend WorkState with bounded resource outcomes.
- [ ] Extend completion with verified external resource results.
- [ ] Add session `resources.jsonl` evidence.
- [ ] Add external evidence redaction.
- [ ] Add startup operation-journal replay.
- [ ] Prove post-effect/pre-finalization recovery is idempotent.

### Slice 5: Existing Git repositories

- [ ] Add repository identity and baseline observation.
- [ ] Preserve unrelated dirty/index state during edits.
- [ ] Default to no user-repository commit.
- [ ] Add safe explicit commit behavior.
- [ ] Add Git edge-case and conflict coverage.

### Slice 6: Remote/API effects

- [ ] Define adapter participation contract.
- [ ] Add provider identity and idempotency handling.
- [ ] Add normalized remote receipts and verification.
- [ ] Add unknown-outcome reconciliation.
- [ ] Add credential and payload redaction coverage.

### Slice 7: hardening and rollout

- [ ] Run phase-by-phase failure injection.
- [ ] Add catalog rebuild/rebind behavior.
- [ ] Run focused and full monorepo verification.
- [ ] Run isolated live daemon acceptance scenarios.
- [ ] Review feedback, SQLite state, Git history, and external state.
- [ ] Update stable `project-docs/` to match verified behavior.
- [ ] Merge only after compatibility and recovery acceptance pass.

## Progress Log

### 2026-07-17

- User identified existing files, external locations, existing projects, and
  API-operated systems as the boundary of the current task checkout model.
- Agreed that every durable task still receives an Ayati-owned Git control
  repository.
- Agreed to keep one task lifecycle and separate task identity from resource
  ownership/location.
- Chose intent-based adoption for existing non-Git project roots.
- Chose explicit commits for existing user-owned Git repositories.
- Chose `.ayati/task.md` plus structured resource manifests.
- Chose identity-only bindings with current-run mutation intent and short-lived
  leases.
- Completed the decision, architecture, resource model, lifecycle, storage,
  recovery, implementation, and testing plan.
