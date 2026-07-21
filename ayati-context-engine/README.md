# Ayati Context Engine

In-process SQLite-and-Git context engine for the Ayati daemon.

The package owns:

- agent streams, immutable messages, runs, steps, and WorkState;
- durable context checkpoints and bounded history retrieval;
- reusable observations, workstreams, requests, and resources;
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

Build and test:

```sh
pnpm --filter ayati-context-engine build
pnpm --filter ayati-context-engine test
```
