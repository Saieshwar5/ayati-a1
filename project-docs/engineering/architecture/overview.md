# Architecture Overview

Ayati is a TypeScript ESM monorepo using pnpm workspaces.

Architecture mental model:

```text
user channels -> agent daemon -> memory/context/tools/providers -> actions/replies
```

`ayati-main` is the persistent agent daemon. It should own agent intelligence, memory, runtime state, provider access, tools, plugins, and background events. `ayati-cli` is one client that talks to the daemon. Future clients should connect to the daemon instead of duplicating agent logic.

Main runtime flow:

1. A user communicates through a client or an integration produces a system event.
2. `ayati-main` receives the message/event through WebSocket, HTTP/Pulse ingress, or plugin adapters.
3. The backend sends conversation and context lifecycle requests through the
   typed Git Context client to an independently managed local server over a
   Unix socket. The server alone owns context SQLite and Git writes.
4. The context server returns active session, explained durable-work
   candidates, optional selected task, and run context. New work uses a
   managed repository or a safely registered trusted directory. Selecting an
   existing V1 task requires an explicit request decision; no session-global
   active task silently owns a mutation.
5. `IVecEngine` builds static decision context and enters the decision-action-reducer runner.
6. The decision model returns direct assistant text for normal terminal
   replies, or chooses exactly one native tool call for tool loading,
   task-bound-run feedback, or selected executable work. Tool loading uses the
   taxonomy and working-set policy so file creation, process commands, reads,
   routing, and repair capabilities are prepared deterministically.
7. Executable tool calls run through the shared action executor and are verified
   through tool contracts, assertions, and local failure policy.
8. Verified facts update WorkState. Runtime-owned finalization closes the run;
   task-bound work commits the verified deliverable, request outcome, task
   card, and references at most once. SQLite retains the run journal.
9. Only after finalization is acknowledged are terminal replies, feedback, or
   notifications sent through the originating transport.

Current agent harness:

```text
context pack -> decision -> action executor -> deterministic verification -> progress reducer
```

Important entry points:

- `ayati-main/src/index.ts`
- `ayati-main/src/app/main.ts`
- `ayati-main/src/ivec/index.ts`
- `ayati-cli/src/index.tsx`
- `ayati-cli/src/app/app.tsx`
- `ayati-main/src/app/git-context-process.ts`
- `ayati-git-context/src/server-main.ts`

Default local ports:

- WebSocket chat: `ws://localhost:8080`
- HTTP upload/artifact/Pulse API: `http://127.0.0.1:8081`
