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
3. The backend loads static decision rules, session state, memory, daily git task context, document/file context, the hidden tool catalog, and provider configuration.
4. `IVecEngine` builds static decision context and enters the decision-action-reducer runner.
5. The decision model chooses exactly one native tool call: a control tool
   (`decision_reply`, `decision_ask_user`, or `decision_load_tools`) or one
   selected executable tool.
6. Executable tool calls run through the shared action executor and are verified
   through tool contracts, assertions, and local failure policy.
7. Verified facts update progress state; run records, memory, files, uploads, documents, artifacts, and daily git context are stored under `ayati-main/data/`.
8. Replies, feedback, notifications, or actions are sent back through the appropriate transport.

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
