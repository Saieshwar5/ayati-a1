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
   to five active-document navigation pointers, plus a bounded continuity
   checkpoint and exact tail. The model-facing pack contains
   only Core Capsule, optional Hot Context, current capabilities, harness
   feedback, and current-run truth. Authoritative work and resources stay
   outside the prompt.
4. Before each primary decision, the runtime builds a structured prompt
   manifest. When the Core Capsule continuity budget is exceeded, the runtime
   deterministically enters the tool-free `context.maintain` mode, summarizes
   the previous checkpoint plus the eligible older complete turns, commits one
   validated replacement checkpoint, and restores the exact preceding task
   mode. The current input and newest completed turn remain exact. Whole-
   request preparation separately measures the complete serialized provider
   request. At soft pressure with reducible current-run tool material, the
   runtime suspends task work in control-only `run.maintain`. One bounded model
   decision updates the in-progress WorkState and identifies exceptional calls
   to keep exact, compact, or release to journal references. Deterministic code
   validates and applies the projection, then restores the exact preceding
   task mode. A disposable run-focus candidate remains a forced-recovery
   fallback, not a second durable summary.
5. Every run starts at `ENTRY`. The decision model may reply directly for
   conversation or a focused clarification, briefly enter read-only
   `context.retrieve` to mount optional context, or enter a read-only
   observation mode. The runtime does not classify or reject an `ENTRY` reply
   from request wording alone; prompt policy tells the model to enter the graph
   whenever a response depends on unperformed observation or action.
   General discovery and durable-owner lookup remain in the read-only
   observation modes. Workstream search and resource-owner lookup use
   `observe.locate`; exact workstream reads use `observe.investigate`. A
   successful current-run ownership observation unlocks the control-only
   `workstream.route` stage. It mounts no executable tools and may lead to
   `resolve` or return to observation for more evidence. Direct
   `ENTRY -> workstream.route` and `ENTRY -> resolve` are unavailable. A
   transition to `resolve` requires a binding-required capability, that
   current-run routing observation, and one typed binding proposal. The model
   owns semantic intent; the gate does not classify user-message wording.
   Existing activation names exact routed resource IDs; the runtime uses them
   to ground activation, then derives ownership, repository HEAD, evidence,
   and only those selected mutable roots from the authoritative activated
   bindings. Creation carries typed workspace-relative targets whose absolute
   paths, evidence, and resource identities are also runtime-derived. The
   deterministic gate makes no model call, enters `execute` mechanically
   after binding, and mounts authoritative context before a fresh decision.
   Mode changes replace the exact capability surface.
6. The shared action executor runs calls and deterministically verifies each
   result. Narrow `create_directory`, `write_files`, `patch_files`, `copy`,
   `move`, `delete`, and `set_permissions` calls use the absolute destination
   root selected in execute mode and target-local effect verification; they do
   not require a resource row, mutation lease, or whole-project snapshot before
   execution. `recordRunStep`
   persists each ordered step, its calls, and
   verification without revising WorkState. The model creates a sparse
   WorkState checkpoint only for a material plan or through `run.maintain` at
   context pressure; terminal
   finalization and exact-request continuation update it deterministically. A
   successful terminal update also promotes at most four selected passed
   validation outcomes into compact important-context receipts with exact
   proof references.
7. Context recovery removes duplicate/invalid projections, compacts
   recoverable outputs, and applies deterministic bounds first. Conversation
   continuity has one durable summary owner: `context.maintain`. Whole-prompt
   pressure does not create a second conversation checkpoint. `run.maintain`
   creates one prompt-only typed projection over the exact run journal; a
   temporary anchored run-focus overlay is only a later forced-recovery
   fallback over eligible older current-run tool material.
   A durable checkpoint commits only after source validation, and the commit's
   fresh Context Engine projection replaces the loop projection before prompt
   rebuild.
8. `finalizeRun` closes the run, appends the immutable assistant message,
   records verified filesystem and resource-scoped effects, appends one
   request-scoped progress entry for a bound run, registers verified outputs,
   and commits reduced workstream continuity.
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
  transient runtime-only context.maintain mode with exact return state
  transient control-only run.maintain mode with exact return state
  WorkState
  ordered steps and tool calls
  verification and audit evidence
  context-pressure state
  typed tool-call projection overlay (runtime only; exact journal unchanged)
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
A new workstream may initially have no resources; successful validation and
finalization add the files actually produced.

The agent receives the exact shared `workstreams/` path as read-only navigation
context. Bounded Context Engine log/show/diff tools can inspect its committed
history for ambiguous continuation, but they cannot write Git or grant
workstream/resource authority.

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
