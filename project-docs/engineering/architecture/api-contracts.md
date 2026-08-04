# Transport Contracts

Ayati clients are communication surfaces. The daemon owns intelligence,
context, tools, providers, and event processing.

## WebSocket

Default URL: `ws://localhost:8080`.

A client sends normalized chat with optional attachments. Streaming-capable
clients announce `replyStreaming`; they receive `reply_started`, zero or more
`reply_delta` events, and one terminal `reply_done`. Other clients receive the
equivalent final `reply`, `feedback`, `notification`, or `error` envelope.

Terminal envelopes include the run id and workstream context-commit state:

- `not_required`: no context commit was needed.
- `no_change`: retained as a transport-compatible acknowledged state for a
  journal that requires no new commit; normal V12 retained bound-run finalization does
  not use it because `progress.md` always changes.
- `committed`: one acknowledged workstream-context commit was created.
- `failed`: finalization failed; no successful terminal acknowledgement may be
  inferred.

Text may stream before finalization, but `reply_done` is sent only after the
database, resource verification, and any required context commit are
acknowledged. A retained bound run requires its progress commit. An empty
initializing workstream is discarded and returns `not_required` while keeping
the finalized run journal. The CLI then sends `reply_rendered` for the exact
server turn to distinguish dispatch from confirmed rendering.

## HTTP

Default URL: `http://127.0.0.1:8081`.

Current routes include uploads, artifacts, and Pulse ingress. Use
`AYATI_HTTP_API_TOKEN` where HTTP ingress needs token protection.

## Context Engine Service Contract

The daemon calls the in-process `ContextEngineService` interface directly.
`SqliteContextEngineService` is the default implementation. SQLite uses schema
version 12. A V9 catalog is upgraded through V10 and V11 to V12. The V12
migration removes only the retired persistent workstream-resolution tables.
Older nested-workstream
state is converted only through the
explicit preview-first migration command; daemon startup does not mutate it
through an implicit compatibility reader.

The service is the single serialization owner for context persistence. Harness
callers await service operations directly and do not add a second write queue.

The service owns:

- atomic agent-run preparation;
- agent streams and immutable messages;
- conversation-continuity checkpoints and bounded exact history access;
- one-run lifecycle and structured steps;
- workstream/request catalog, full request lifecycle, typed routing,
  discovery, creation, activation, and stars;
- resource admission, metadata, bindings, inspection, and reverse discovery;
- exact resource mutation preparation and verification;
- exact-path transactions in the one shared context-only Git repository;
- finalization and startup recovery.

Normal ingress uses one `prepareAgentRun` operation. There is no separate
run-start or direct assistant-message persistence API. Workstream creation and
request routing require the existing run identity; they cannot allocate or
switch the run. Routing supports exact continuation, queued activation,
blocked resumption, contract amendment, request creation, and atomic
deferral/switching while preserving at most one active request.
Discovery searches terminal as well as unfinished request contracts. A
read-only workstream open may include `workstreamRequestId`; that returns the
exact historical request, final outcome, and five newest progress projections
without changing request state or binding the run.

One `recordRunStep` operation stores an ordered structured action record and
returns the authoritative agent projection without changing WorkState. A
separate optimistic `checkpointRunWorkState` operation owns sparse `plan` and
`context_pressure` handoffs. One `finalizeRun` operation loads binding from
the run, writes the terminal WorkState—including bounded validation receipts
already derived by the main runtime—separates run outcome from request
lifecycle effect, appends one progress entry for a bound run, and returns
distinct facts:

```text
run + immutable assistant message
resourceEffects
workstreamContextCommit
```

`planContextCheckpoint` selects a pressure-eligible exact prefix.
`commitContextCheckpoint` validates anchored structured output and atomically
updates the active pointer. `searchAgentHistory` and `readAgentHistory` expose
bounded exact recovery without expanding every prompt.

Stable idempotency identities derive from the logical preparation id, run and
tool-call id for routing/mutation, run and step number for persistence, and run
id for finalization.

Service errors use typed codes. Old schema versions are refused, never deleted
automatically. Use the archive/reset command deliberately before starting a
new catalog.

See [Workstreams and Resources](workstreams-and-resources.md).
