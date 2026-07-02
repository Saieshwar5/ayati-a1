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
3. The backend records the turn in daily git context, prepares pending-turn
   ownership state, loads static decision rules, personal memory, document/file
   context, the hidden tool catalog, and provider configuration.
4. Runtime auto-binds obvious same-task follow-ups. If task ownership is
   semantic, ambiguous, or new durable work, the agent can search/read git
   context and route the pending turn through turn-aware activate/create/clarify
   tools before task work runs. Normal work tools require a real task run.
5. `IVecEngine` builds static decision context and enters the decision-action-reducer runner.
6. The decision model returns direct assistant text for normal terminal
   replies, or chooses exactly one native tool call for tool loading,
   task-run feedback, or selected executable work.
7. Executable tool calls run through the shared action executor and are verified
   through tool contracts, assertions, and local failure policy.
8. Verified facts update progress state. Runtime-owned finalization writes task
   state, run summaries, action records, evidence manifests, assets, assistant
   responses, and git commit metadata exactly once for each task run.
9. Replies, feedback, notifications, or actions are sent back through the appropriate transport.

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

Default local ports:

- WebSocket chat: `ws://localhost:8080`
- HTTP upload/artifact/Pulse API: `http://127.0.0.1:8081`
