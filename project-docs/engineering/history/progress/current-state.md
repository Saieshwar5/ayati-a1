# Current State

Last updated: 2026-07-19

Ayati uses one-run execution with context-only workstreams and a shared resource
catalog.

```text
session conversation + one run
+ workstream/request context Git
+ real resources and exact mutation journals
+ personal/episodic memory
-> bounded context projection
```

The harness remains:

```text
context pack -> decision -> action executor -> deterministic verification -> progress reducer
```

## Implemented

- Protocol 36 and clean SQLite schema V5.
- One atomic preparation operation for session, conversation, message, run,
  WorkState, and idempotency receipt.
- One immutable optional workstream/request binding on the existing run.
- Structured `recordRunStep` persistence with ordered tool calls,
  verification, WorkState, and rebuilt reusable read context.
- One truthful finalization operation with separate materialization, verified
  resource effects, and optional workstream-context commit results.
- Managed `W-*` context repositories containing only `workstream.md`, request
  files, and `resources.json`.
- A SQLite resource catalog with descriptions, aliases, locators, versions,
  availability, session/workstream relationships, and reverse discovery.
- Immutable content-addressed uploaded resources.
- Deterministic discovery using exact identity/resource ownership,
  continuation, text, unfinished, star, recency, and frequency signals.
- Native create, activate, find, read, inspect, star, and resource-binding
  controls.
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
