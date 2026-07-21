# Architecture Overview

Ayati is a TypeScript ESM pnpm monorepo.

```text
user channels -> persistent daemon -> agent stream + run context -> tools/providers -> actions/replies
```

`ayati-main` owns agent intelligence, the harness, provider access, tools,
personal/episodic memory, plugins, and event handling. `ayati-cli` is a client.
`ayati-context-engine` is an in-process daemon library and the only owner of
context SQLite and context-only Git writes. The daemon depends on its typed
`ContextEngineService` interface, not its SQLite implementation.

## Runtime Flow

1. A client sends a message or an integration produces a system event.
2. One `prepareAgentRun` transaction resolves the default agent stream,
   appends an immutable ingress message, creates a run with initial WorkState,
   and returns the authoritative agent-facing projection.
3. The projection separates slow stream continuity from fast run state. It
   includes a checkpoint plus exact message tail, recent work references,
   resources, reusable observations, routing candidates, and the current run.
4. The decision model may reply, inspect/search/read, load tools, or bind the
   existing run to one workstream/request.
5. The shared action executor runs calls. Deterministic verification and the
   progress reducer update WorkState. `recordRunStep` persists each ordered
   step, its calls, verification, and resulting WorkState, then returns the
   updated authoritative projection for the next decision.
6. If the whole decision candidate exceeds soft pressure, deterministic
   projection runs first. Remaining pressure may create one durable,
   source-anchored stream checkpoint; the current input and exact tail are
   never checkpointed away.
7. `finalizeRun` closes the run, appends the immutable assistant message,
   verifies resource effects, and optionally commits reduced workstream
   continuity.
8. Only after durable acknowledgement does the transport receive its terminal
   response envelope.

The harness remains:

```text
context pack -> decision -> action executor -> deterministic verification -> progress reducer
```

## Context Boundaries

```text
agent stream (slow growth, many runs)
  immutable user/system-event/assistant messages
  pressure checkpoint + exact tail
  recent work references
  stream resources
  reusable list/search/read observations

run context (fast growth, one accepted input)
  WorkState
  ordered steps and tool calls
  verification and audit evidence
  context-pressure state

personal memory (independent)
  stable facts, preferences, evolving and time-scoped facts
```

There is one default stream for the local agent: `agentId=local` and
`scopeKey=default`. Different clients and system events contribute to that
same continuity stream. A run is never used as a long-term conversation
container, and the stream is never used as an action log.

## Managed Filesystem Topology

```text
<AYATI_ROOT_DIR>/
  workspace/       default visible output
  workstreams/     context-only Git repositories
  .ayati/          V7 database and managed resources
```

Workstream Git never contains deliverables. The resource catalog points to
real files, directories, URLs, databases, repositories, and external objects.

Important entry points:

- `ayati-main/src/app/main.ts`
- `ayati-main/src/app/context-engine-runtime.ts`
- `ayati-context-engine/src/runtime.ts`
- `ayati-main/src/ivec/agent-runner/context-pack.ts`
- `ayati-main/src/ivec/agent-runner/decision-context-compiler.ts`
- `ayati-main/src/app/resource-scoped-tool-executor.ts`
- `ayati-context-engine/src/services/sqlite-context-engine-service.ts`
- `ayati-context-engine/src/services/agent-context-projection-service.ts`
- `ayati-context-engine/src/services/context-checkpoint-service.ts`
- `ayati-context-engine/src/services/agent-history-service.ts`

Default endpoints:

- WebSocket chat: `ws://localhost:8080`
- HTTP upload/artifact/Pulse API: `http://127.0.0.1:8081`
