# Backend Overview

The backend package is `ayati-main`.

`ayati-main` is the agent daemon. It is intended to run continuously in the background and own the durable agent state. Clients such as `ayati-cli` communicate with it; they should not duplicate the agent runtime.

Core responsibilities:

- Bootstrap the runtime.
- Load provider configuration.
- Load static prompt context and skill prompt blocks.
- Start WebSocket chat transport.
- Start HTTP upload/artifact/Pulse API.
- Start plugins and system-event worker.
- Open and close the in-process Context Engine host and consume its typed
  agent-stream, workstream, request, run, checkpoint, history, and
  context-projection operations.
- Manage personal memory stores and episodic recall services.
- Register a hidden tool catalog and expose only a capped run-scoped working set of tool schemas.
- Execute the IVec decision-action-reducer agent loop.
- Preserve daemon-owned runtime state under `ayati-main/data/`.
- Provide replies, feedback, notifications, and background event handling to client transports.

Primary bootstrap file:

- `ayati-main/src/app/main.ts`

Primary engine file:

- `ayati-main/src/ivec/index.ts`
