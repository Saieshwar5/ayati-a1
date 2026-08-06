# Integrations

Model providers live under `ayati-main/src/providers/`:

- OpenRouter.
- OpenAI.
- Anthropic.
- Fireworks.

Current communication integrations:

- CLI client over WebSocket.
- Electron desktop client over the same WebSocket contract, with a local tray
  lifecycle and native reply notifications.
- Daemon-owned voice input through Voxtype file transcription and a private
  local control socket.
Future communication channels can include:

- Browser/web client.
- Mobile client.
- Other chat apps or notification surfaces.

Integration rule:

- Communication channels should feed normalized user messages into
  `ayati-main`.
- Core intelligence, memory, tool access, and provider behavior should stay in
  the daemon.

See [Desktop Client](desktop-client.md) and [Voice Interface](voice-interface.md)
for their process, lifecycle, and ownership boundaries.
