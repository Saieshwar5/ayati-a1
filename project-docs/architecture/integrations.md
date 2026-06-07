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
- Telegram transport in `ayati-main/src/server/telegram-server.ts`.
- AgentMail plugin under `ayati-main/src/plugins/agentmail`.
- Nylas Mail plugin under `ayati-main/src/plugins/nylas-mail`.
- Pulse reminders and scheduled work under `ayati-main/src/pulse`.

Future communication channels can include:

- Browser/web client.
- Mobile client.
- Voice interface.
- Email-first workflows.
- Other chat apps or notification surfaces.

External skills:

- Runtime skill manifests are discovered from `ayati-main/data/skills`.
- Catalog cache path: `ayati-main/data/skills/catalog.json`.
- Secret mapping: `ayati-main/context/skill-secrets.json`.
- Policy file: `ayati-main/context/skill-policy.json`.

Integration rule:

- Communication channels should feed normalized messages/events into `ayati-main`.
- Core intelligence, memory, tool access, event policy, and provider behavior should stay in the daemon.
