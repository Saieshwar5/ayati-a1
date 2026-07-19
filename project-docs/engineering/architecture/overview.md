# Architecture Overview

Ayati is a TypeScript ESM pnpm monorepo.

```text
user channels -> persistent daemon -> context/memory/tools/providers -> actions/replies
```

`ayati-main` owns agent intelligence, the harness, provider access, tools,
plugins, and event handling. `ayati-cli` is a client. `ayati-git-context` is an
independent local service and the only owner of context SQLite and context Git
writes.

Main runtime flow:

1. A client sends a message or an integration produces a system event.
2. The daemon sends one atomic preparation request to Git Context. The service
   ensures the daily session, creates a conversation segment and message,
   creates one run with initial WorkState, and returns active context.
3. Active context contains explained workstream candidates, ingress resources,
   optional bound workstream context, reusable read context, and current-run
   state.
4. The decision model may reply directly, inspect/read/search, load tools, or
   bind the existing run using a workstream routing control.
5. After binding, the daemon refreshes context and asks for a fresh decision.
   Mutation tools receive only exact mutable resources; no call is deferred or
   replayed.
6. The shared action executor runs calls. Deterministic verification and the
   progress reducer update WorkState. One structured run-step record persists
   the ordered tool calls and verification result.
7. One finalization request closes the run and conversation, verifies resource
   effects, and optionally commits reduced context in the `W-*` repository.
8. Only after durable acknowledgement does the originating transport receive
   the terminal response envelope.

The harness remains:

```text
context pack -> decision -> action executor -> deterministic verification -> progress reducer
```

Managed filesystem topology:

```text
<AYATI_ROOT_DIR>/
  workspace/       default visible output
  workstreams/     context-only Git repositories
  .ayati/          database, sessions, managed resources, socket
```

Workstream Git never contains deliverables. The resource catalog points to real
files, directories, URLs, databases, repositories, and external objects. A
resource may live inside the default workspace or anywhere explicitly selected
by the user.

Important entry points:

- `ayati-main/src/index.ts`
- `ayati-main/src/app/main.ts`
- `ayati-main/src/ivec/index.ts`
- `ayati-main/src/app/git-context-runtime.ts`
- `ayati-main/src/app/resource-scoped-tool-executor.ts`
- `ayati-git-context/src/server-main.ts`
- `ayati-git-context/src/services/sqlite-git-context-service.ts`
- `ayati-cli/src/index.tsx`

Default endpoints:

- WebSocket chat: `ws://localhost:8080`
- HTTP upload/artifact/Pulse API: `http://127.0.0.1:8081`
