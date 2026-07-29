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
3. The projection separates slow stream continuity from fast run state. Its
   model-facing Core Capsule contains the exact current input and routing, up
   to five active-document navigation pointers, plus a strict-budget
   checkpoint and exact tail. The model-facing pack contains
   only Core Capsule, optional Hot Context, current capabilities, harness
   feedback, and current-run truth. Authoritative work and resources stay
   outside the prompt.
4. Before each primary decision, the runtime builds a structured prompt
   manifest. Core Capsule maintenance runs from its own continuity budget;
   whole-request preparation separately measures the complete serialized
   provider request. Disposable checkpoint or focus candidates may be
   prepared beside foreground model work; they are not agents or model-facing
   tools.
5. Every run starts at `ENTRY`. The decision model may reply directly for
   conversation or a focused clarification, briefly enter read-only
   `context.retrieve` to mount optional context, or enter a read-only
   observation mode. The runtime does not classify or reject an `ENTRY` reply
   from request wording alone; prompt policy tells the model to enter the graph
   whenever a response depends on unperformed observation or action.
   General discovery remains in the read-only observation modes. An unbound
   mutation instead enters the dedicated read-only `workstream.route` mode,
   whose surface contains only workstream search/read and resource-owner
   lookup. Direct `ENTRY -> resolve` is unavailable, and resolve controls
   appear only after one of those routing tools succeeds in the current run.
   A transition to `resolve` then requires mutation intent, a binding-required
   capability, that current-run routing observation, and one typed binding
   proposal. Existing activation names exact routed resource IDs; the runtime
   derives their paths, ownership, mutation scope, repository HEAD, and
   evidence. Creation carries typed workspace-relative targets whose absolute
   paths, evidence, and resource identities are also runtime-derived. The
   deterministic gate makes no model call, enters `execute` mechanically
   after binding, and mounts authoritative context before a fresh decision.
   Mode changes replace the exact capability surface.
6. The shared action executor runs calls and deterministically verifies each
   result. `recordRunStep` persists each ordered step, its calls, and
   verification without revising WorkState. The model creates a sparse
   WorkState checkpoint only for a material plan or context pressure; terminal
   finalization and exact-request continuation update it deterministically. A
   successful terminal update also promotes at most four selected passed
   validation outcomes into compact important-context receipts with exact
   proof references.
7. Context recovery removes duplicate/invalid projections, compacts
   recoverable outputs, and applies deterministic bounds first. Both Core
   Capsule maintenance and whole-prompt pressure prefer the same durable
   source-anchored stream checkpoint. Whole-prompt recovery may additionally
   use a temporary anchored run-focus overlay when durable recovery is
   insufficient. Durable candidates commit only when adopted, and the
   commit's fresh Context Engine projection replaces the loop projection
   before prompt rebuild.
8. `finalizeRun` closes the run, appends the immutable assistant message,
   verifies resource effects, appends one request-scoped progress entry for a
   bound run, and commits reduced workstream continuity.
9. Only after durable acknowledgement does the transport receive its terminal
   response envelope.

The harness remains:

```text
context pack -> decision -> action executor -> deterministic verification -> progress reducer
```

## Context Boundaries

```text
agent stream (slow growth, many runs)
  immutable user/system-event/assistant messages
  durable continuity checkpoint + exact tail
  recent-workstream metadata prepared for optional Hot Context
  recent material WorkState handoffs derived for optional Hot Context
  one 32-record recent-document registry derived from verified successful
    complete reads belonging to stable terminal runs
    newest five -> Core Capsule active-document pointers
    older 27 -> optional files.recent Hot Context
  stream resources

run context (fast growth, one accepted input)
  run-scoped virtual mode and revision
  WorkState
  ordered steps and tool calls
  verification and audit evidence
  context-pressure state
  disposable anchored focus overlay (runtime only)

personal memory (independent)
  stable facts, preferences, evolving and time-scoped facts
  compact snapshot exposed as optional personal.memory Hot Context
```

There is one default stream for the local agent: `agentId=local` and
`scopeKey=default`. Different clients and system events contribute to that
same continuity stream. A run is never used as a long-term conversation
container, and the stream is never used as an action log.

## Managed Filesystem Topology

```text
<AYATI_ROOT_DIR>/
  workspace/       default visible output
  workstreams/     one shared context-only Git repository
  .ayati/          V9 database and managed resources
```

Workstream Git never contains deliverables. The resource catalog points to
real files, directories, URLs, databases, repositories, and external objects.

Important entry points:

- `ayati-main/src/app/main.ts`
- `ayati-main/src/app/context-engine-runtime.ts`
- `ayati-context-engine/src/runtime.ts`
- `ayati-main/src/ivec/agent-runner/context-pack.ts`
- `ayati-main/src/ivec/agent-runner/decision-context-compiler.ts`
- `ayati-main/src/ivec/agent-runner/virtual-mode.ts`
- `ayati-main/src/ivec/agent-runner/virtual-mode-runtime.ts`
- `ayati-main/src/ivec/context-preparation/manager.ts`
- `ayati-main/src/ivec/context-preparation/main-admission.ts`
- `ayati-main/src/app/resource-scoped-tool-executor.ts`
- `ayati-context-engine/src/services/sqlite-context-engine-service.ts`
- `ayati-context-engine/src/services/agent-context-projection-service.ts`
- `ayati-context-engine/src/services/context-checkpoint-service.ts`
- `ayati-context-engine/src/services/agent-history-service.ts`

Default endpoints:

- WebSocket chat: `ws://localhost:8080`
- HTTP upload/artifact/Pulse API: `http://127.0.0.1:8081`
