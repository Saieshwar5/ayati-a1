# Frontend Overview

The current frontend is a terminal UI in `ayati-cli`, built with Ink and React.

There is no active browser app in the current documented product shape. Treat `frontend/` as CLI/UI context unless a web client is reintroduced.

Important product rule:

- The frontend is a client surface for the daemon.
- It should render messages, collect input, manage local UI behavior, and send normalized payloads.
- It should not own core agent intelligence, long-term memory, provider selection, tool policy, or background event processing.

Main files:

- `ayati-cli/src/app/app.tsx`
- `ayati-cli/src/app/components/header.tsx`
- `ayati-cli/src/app/components/message-list.tsx`
- `ayati-cli/src/app/components/chat-input.tsx`
- `ayati-cli/src/app/components/status-bar.tsx`
- `ayati-cli/src/app/hooks/use-websocket.ts`
- `ayati-cli/src/app/commands.ts`

The CLI connects to `ws://localhost:8080`.

The client sends chat, attachments, capability negotiation, and reply-rendered
acknowledgements. It does not inspect desktop windows, send window-manager
metadata, emit workspace-attention events, or control desktop layout. Desktop
integration can be reconsidered later as a separate optional client feature.
