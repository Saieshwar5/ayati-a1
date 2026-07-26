# Ayati Context Engine

In-process SQLite-and-Git context engine for the Ayati daemon.

The package owns:

- agent streams, immutable messages, runs, steps, and WorkState;
- durable context checkpoints and bounded history retrieval;
- workstreams, requests, and resources;
- exact mutation journals, finalization, and restart recovery;
- context-only workstream Git repositories.

The daemon opens one engine host and consumes only the typed
`ContextEngineService` interface:

```text
Ayati harness
  -> ContextEngineRuntime
  -> ContextEngineService
  -> SqliteContextEngineService
  -> SQLite + context-only workstream Git
```

`startContextEngineHost` acquires the durable writer lock, opens SQLite,
completes startup recovery, and exposes the service directly. The service owns
operation serialization, and mutation responses return authoritative
projections for harness continuation. There is no child process, HTTP
transport, Unix socket, or standalone server.

`recordRunStep` owns immutable ordered tool and verification history.
`checkpointRunWorkState` separately persists a small optimistic handoff for a
material plan or context pressure. Finalization writes the terminal handoff,
and continuing the same active workstream request can restore it into the next
run. Routine tool steps never revise WorkState. The main runtime may include a
few compact receipts derived from passed final-validation checks in that
terminal handoff; raw verifier records remain in the run journal.
Agent-context projection also derives at most five material terminal WorkState
handoffs for optional `workstates.recent` Hot Context. This view is rebuilt
from the existing run and WorkState rows and is not a second persistence path.
It also rebuilds one deduplicated recent-document registry of at most 32 paths
from verified complete historical `read_files` steps. The daemon projects the
newest five as lightweight active pointers and exposes only the older records
through optional `files.recent`; no document-cache table is created.

Build and test:

```sh
pnpm --filter ayati-context-engine build
pnpm --filter ayati-context-engine test
```
