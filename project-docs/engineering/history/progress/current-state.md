# Current State

Last updated: 2026-08-01

Ayati uses one-run execution, long-lived workstreams, bounded requests, a
shared context notebook, and a searchable resource catalog.

```text
slow agent stream continuity + fast one-input run context
+ workstream -> request -> run -> WorkState
+ one shared context Git repository and immutable progress
+ real resources and exact mutation journals
+ independent personal/episodic memory
-> bounded agent-facing lanes
```

The harness remains:

```text
context pack -> decision -> action executor -> deterministic verification -> progress reducer
```

## Implemented

- Protocol 37 and SQLite schema V9 with explicit migration/reset for older
  state.
- One atomic preparation operation for agent stream, immutable ingress
  message, run, fresh WorkState, and idempotency receipt.
- One default `local/default` stream across clients and system events.
- One immutable optional workstream/request binding on the existing run.
- A five-state request lifecycle: queued, active, blocked, done, and dropped,
  with terminal done/dropped states and at most one active request per
  workstream.
- Typed request routing for continuation, amendment, queued activation,
  blocked resumption, new queued/active requests, and atomic defer-and-switch.
- Separate run outcomes and request lifecycle effects, so incomplete and
  failed runs do not rewrite the request contract and completion cannot omit
  any acceptance criterion from the bound request.
- Structured `recordRunStep` persistence with ordered tool calls,
  verification, WorkState, and resource-versioned observations.
- Runtime-owned `context.maintain` conversation checkpoints with an exact
  current/recent tail, explicit retention priority, exact anchors, one repair,
  and atomic active-pointer update.
- Runtime-triggered `run.maintain` for whole-request pressure: one bounded
  WorkState-and-retention decision, deterministic per-tool projection policy,
  recoverable exact journal references, unknown-tool fail-safe retention, and
  exact task-mode restoration. A disposable current-run focus overlay remains
  only a later forced-recovery fallback.
- Bounded exact history search/read over messages, runs, and evidence.
- Checkpoint-range personal-memory extraction and independent Hot Context.
- One truthful finalization operation with immutable assistant-message append,
  verified resource effects, one progress entry, and one shared-repository
  commit for every finalized bound run.
- One context-only Git repository at `workstreams/.git`; each `W-*` directory
  contains `workstream.md`, `progress.md`, request files, and generated
  `resources.json`.
- Global shared-repository HEAD plus path-specific last commit per workstream,
  so another workstream's commit does not make it stale.
- A SQLite request/progress/resource catalog with request and workstream FTS,
  aliases, snapshots, focus, blockers, outcomes, locators, versions, and
  reverse discovery. Terminal request matches identify their owning
  workstream and support exact read-only contract/outcome/progress loading.
- Immutable content-addressed uploaded resources.
- Deterministic discovery using exact identity/resource ownership,
  continuation, request contracts, text, unfinished, star, recency, and
  frequency signals.
- Same-loop read-only workstream and resource-routing observation followed by
  one deterministic binding gate. The gate makes no model request and enters
  execution mechanically after binding succeeds.
- Activation context containing the selected request, distilled workstream,
  relevant resources, and at most five recent progress entries for that
  request.
- Exact resource-scoped execution with pre/post mutation observations,
  verification, idempotency, and recovery.
- Journaled crash recovery before and after the Git commit, using run trailers
  to prevent duplicate progress or commits.
- Preview-first migration from clean nested v2/v3 repositories into the shared
  repository, with an empty progress baseline for pre-ledger workstreams,
  archive preservation, and V9 catalog rebuild.
- One `AYATI_ROOT_DIR` topology with visible default outputs under
  `workspace/`, context under `workstreams/`, and state under `.ayati/`.
- Unified chat/system-event coordination and terminal acknowledgement after
  durable finalization.

## Boundaries

- Context Git is continuity data, never a project working tree.
- Output remains at resource locators and does not trigger automatic Git
  initialization.
- Binding does not itself authorize mutation.
- Recent, starred, or merely unfinished work never silently owns a run.
- General tools cannot write workstream context files.
- Failed or uncertain finalization cannot produce a successful terminal
  acknowledgement.
- Stream continuity does not contain action logs; run state owns steps and
  tool calls.
- Done and dropped requests are never reopened; later repairs are new
  requests.

## Remaining priorities

1. Repeated live-provider acceptance across multi-day learning, website,
   research, automation, and several active workstreams.
2. Operator rehearsal of migration and manual interruption recovery against
   representative retained runtime backups.
3. Typed verification for real browser, desktop, communication, and remote API
   resources.
4. Further feedback-driven routing and context-efficiency tuning without
   weakening deterministic ownership.

The canonical contract is
[Workstreams, Requests, Runs, and Resources](../../architecture/workstreams-and-resources.md).
