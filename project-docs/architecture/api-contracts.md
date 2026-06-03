# Transport Contracts

Ayati transports are communication channels into the agent daemon. The daemon owns intelligence, memory, tools, providers, and event processing.

WebSocket chat server:

- Default URL: `ws://localhost:8080`
- Implemented by `ayati-main/src/server/ws-server.ts`
- CLI client hook: `ayati-cli/src/app/hooks/use-websocket.ts`

Typical client chat payload:

```json
{
  "type": "chat",
  "content": "User message",
  "attachments": []
}
```

Server response types handled by the CLI:

- `reply`
- `feedback`
- `notification`
- `error`

Future clients should preserve the same principle even if they use a different transport:

- Send normalized user messages, attachments, events, or approvals to the daemon.
- Render replies, feedback, notifications, and errors from the daemon.
- Keep channel-specific UI behavior outside the core runtime.

HTTP API server:

- Default URL: `http://127.0.0.1:8081`
- Implemented by `ayati-main/src/server/upload-server.ts`

Known HTTP paths:

- `POST /api/uploads`
- `GET /api/artifacts/<artifact-path>`
- `POST /api/pulse`

Use `AYATI_HTTP_API_TOKEN` when Pulse API access needs token protection.
