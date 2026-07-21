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
- `no_change`: a bound run reduced to the existing context state.
- `committed`: one acknowledged workstream-context commit was created.
- `failed`: finalization failed; no successful terminal acknowledgement may be
  inferred.

Text may stream before finalization, but `reply_done` is sent only after the
database, resource verification, and optional context commit
are acknowledged. The CLI then sends `reply_rendered` for the exact server turn
to distinguish dispatch from confirmed rendering.

## HTTP

Default URL: `http://127.0.0.1:8081`.

Current routes include uploads, artifacts, and Pulse ingress. Use
`AYATI_HTTP_API_TOKEN` where HTTP ingress needs token protection.

## Context Engine Service Contract

The daemon calls the in-process `ContextEngineService` interface directly.
`SqliteContextEngineService` is the default implementation. SQLite uses clean
schema version 7; no compatibility migration reader is provided for older
development state.

The service is the single serialization owner for context persistence. Harness
callers await service operations directly and do not add a second write queue.

The service owns:

- atomic agent-run preparation;
- agent streams and immutable messages;
- pressure checkpoints and bounded exact history access;
- resource-versioned reusable observations;
- one-run lifecycle and structured steps;
- workstream/request catalog, discovery, creation, activation, and stars;
- resource admission, metadata, bindings, inspection, and reverse discovery;
- exact resource mutation preparation and verification;
- context-only Git transactions;
- finalization and startup recovery.

Normal ingress uses one `prepareAgentRun` operation. There is no separate
run-start or direct assistant-message persistence API. Workstream creation and
activation require the existing run identity; they cannot allocate or switch
the run.

One `recordRunStep` operation stores an ordered structured action record,
updates WorkState and reusable observations in the same transaction, and
returns the updated authoritative agent projection from that serialized
operation. One `finalizeRun` operation loads binding from the run and returns
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
