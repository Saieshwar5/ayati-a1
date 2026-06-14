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
3. The backend loads static decision rules, session state, memory, tools, dynamic built-in skill cards, document/file context, and provider configuration.
4. `IVecEngine` builds static decision context and enters the decision-action-reducer runner.
5. The decision model chooses exactly one outcome: `reply`, `ask_user`, or `act`.
6. Actions run through the shared tool executor and are verified through tool contracts, assertions, and local failure policy.
7. Verified facts update progress state; run records, memory, files, uploads, documents, and artifacts are stored under `ayati-main/data/`.
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
