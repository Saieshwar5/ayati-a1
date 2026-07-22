# Current State

Last updated: 2026-07-22

Ayati uses one-run execution with context-only workstreams and a shared resource
catalog.

```text
slow agent stream continuity + fast one-input run context
+ workstream/request context Git
+ real resources and exact mutation journals
+ independent personal/episodic memory
-> bounded agent-facing lanes
```

The harness remains:

```text
context pack -> decision -> action executor -> deterministic verification -> progress reducer
```

## Implemented

- Protocol 37 and clean SQLite schema V7 with no compatibility reader for
  older schema versions.
- One atomic preparation operation for agent stream, immutable ingress message,
  run, WorkState, and idempotency receipt.
- One default `local/default` stream across clients and system events.
- One immutable optional workstream/request binding on the existing run.
- Structured `recordRunStep` persistence with ordered tool calls,
  verification, WorkState, and resource-versioned list/search/read observations.
- Pressure-only durable checkpoints with exact anchors, deterministic
  projection, one repair, and atomic active-pointer update.
- Bounded exact history search/read over messages, runs, and evidence.
- Checkpoint-range personal-memory extraction and an independent prompt lane.
- One truthful finalization operation with immutable assistant-message append,
  verified resource effects, and optional workstream-context commit results.
- Managed `W-*` context repositories containing only `workstream.md`, request
  files, and `resources.json`.
- A SQLite resource catalog with descriptions, aliases, locators, versions,
  availability, stream/workstream relationships, and reverse discovery.
- Immutable content-addressed uploaded resources.
- Deterministic discovery using exact identity/resource ownership,
  continuation, text, unfinished, star, recency, and frequency signals.
- Same-loop read-only workstream and resource-routing observation followed by
  one deterministic activate-or-create binding gate. The gate makes no model
  request and enters execution mechanically after binding succeeds.
- Exact resource-scoped execution with pre/post mutation observations,
  verification, idempotency, and recovery.
- One `AYATI_ROOT_DIR` topology with visible default outputs under
  `workspace/`, context under `workstreams/`, and state under `.ayati/`.
- Unified chat/system-event coordination and terminal acknowledgement after
  finalization.
- Workstream-aware feedback summaries, deterministic triage, and markdown live
  report.
- Preview-first archive/reset and validated catalog rebuild.

## Boundaries

- Workstream Git is continuity data, never a project working tree.
- Output remains at resource locators and does not trigger automatic Git
  initialization.
- Binding does not itself authorize mutation.
- Recent or starred workstreams do not silently own a run.
- General tools cannot write workstream context files.
- Failed or uncertain finalization cannot produce a successful terminal commit
  state.
- Stream continuity does not contain action logs; run state owns steps and tool
  calls.

## Remaining Priorities

1. Repeated live provider acceptance across multi-day learning, website,
   research, automation, and several simultaneously active workstreams.
2. Manual interruption/recovery inspection at every mutation and finalization
   journal boundary.
3. Typed verification for real browser, desktop, communication, and remote API
   resources.
4. Richer pause/archive/resume and queued-request operations when product use
   demonstrates the need.
5. Further feedback-driven routing and context-efficiency tuning without
   weakening deterministic ownership.

The canonical contract is
[Workstreams and Resources](../../architecture/workstreams-and-resources.md).
