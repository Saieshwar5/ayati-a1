# Integrations

Model providers live under `ayati-main/src/providers/`:

- OpenRouter.
- OpenAI.
- Anthropic.
- Fireworks.

Embedding providers live under `ayati-main/src/embeddings/`.

Image generation providers live under `ayati-main/src/image-generation/`.

Current and optional communication/event integrations:

- CLI client over WebSocket.
- Pulse reminders and scheduled work under `ayati-main/src/pulse`.

Future communication channels can include:

- Browser/web client.
- Mobile client.
- Voice interface.
- Other chat apps or notification surfaces.

Integration rule:

- Communication channels should feed normalized messages/events into `ayati-main`.
- Core intelligence, memory, tool access, event policy, and provider behavior should stay in the daemon.
