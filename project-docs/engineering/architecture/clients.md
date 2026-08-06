# Client Overview

Ayati has two interactive client surfaces:

- `ayati-cli`: an Ink/React terminal client.
- `ayati-desktop`: a secure Electron/React desktop client.

The CLI executable also exposes local `voice` control commands for the
daemon-owned Voxtype integration. Those commands and both visual clients are
communication surfaces; they do not own agent state.

Important product rule:

- Clients render messages, collect input, manage local presentation behavior,
  and send normalized payloads.
- `ayati-main` owns agent intelligence, context, provider selection, tools,
  memory, durable work, background events, and finalization.
- Restarting or closing a client must not be treated as ending the daemon or
  closing durable work.

## Shared Chat Contract

Both clients connect to the local daemon WebSocket at
`ws://127.0.0.1:8080`. They announce a client kind and streaming capability,
send each chat message with a stable `messageId`, render queue/progress/reply
envelopes, and acknowledge a final streamed reply after it is rendered. The
daemon routes the response to the originating connection while retaining
`local` as the logical user identity.

## Terminal Client

Main files:

- `ayati-cli/src/app/app.tsx`
- `ayati-cli/src/app/components/`
- `ayati-cli/src/app/hooks/use-websocket.ts`
- `ayati-cli/src/app/commands.ts`
- `ayati-cli/src/voice/`

The terminal client owns terminal input, attachment queue UX, slash commands,
and Ink rendering.

## Electron Desktop Client

Main files:

- `ayati-desktop/src/main/main.ts`
- `ayati-desktop/src/main/daemon-client.ts`
- `ayati-desktop/src/main/window-manager.ts`
- `ayati-desktop/src/preload/index.cts`
- `ayati-desktop/src/renderer/app.tsx`
- `ayati-desktop/src/shared/contracts.ts`

The Electron main process owns the WebSocket, reconnect policy, message IDs,
application window, tray, and native notifications. The sandboxed renderer owns
only the current visual conversation and composer state. It reaches the main
process through four narrow preload operations and has no Node.js or direct
network access.

See [Desktop Client](desktop-client.md) for the process boundary, security
controls, runtime flow, and commands.

## Browser Status

There is no active browser app in the current product shape. A future browser
or remote client requires an authentication and authorization design before it
can safely reach the privileged daemon.

Clients do not inspect arbitrary desktop windows, send window-manager metadata,
emit workspace-attention events, or control desktop layout. Those capabilities
would require separate explicit contracts and policy.
