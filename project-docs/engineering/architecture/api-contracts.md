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

Streaming-capable clients may announce support after connecting:

```json
{
  "type": "client_hello",
  "capabilities": {
    "replyStreaming": true
  }
}
```

Server response types handled by the CLI:

- `reply`
- `feedback`
- `notification`
- `error`
- `progress`
- `reply_started`
- `reply_delta`
- `reply_done`

For clients that do not send `client_hello.capabilities.replyStreaming=true`,
the daemon keeps sending final `reply`, `feedback`, and `notification` events.
For streaming-capable clients, final user-visible responses may be delivered as
`reply_started` followed by one or more `reply_delta` events and a final
`reply_done`. The `reply_done.content` field is the assembled canonical
assistant response and includes a `commitStatus` value:

- `committed`: a task run was finalized and committed.
- `skipped`: no task-run commit was needed for this response. This includes
  read-only session-run replies that are persisted by the context engine but do
  not create or finalize a task run.
- `failed`: task-run finalization failed after the response was assembled.

Provider-native token streaming is used only for response-only final text after
the harness has reached a user-visible reply or feedback path. Normal
decision/tool-selection calls are not streamed to clients. Native final-response
streaming is currently implemented for OpenAI and Fireworks providers; other
providers use the same transport events with daemon-chunked final text.

Future clients should preserve the same principle even if they use a different transport:

- Send normalized user messages, attachments, events, or approvals to the daemon.
- Render replies, feedback, notifications, and errors from the daemon.
- Keep channel-specific UI behavior outside the core runtime.

HTTP API server:

- Default URL: `http://127.0.0.1:8081`
- Implemented by `ayati-main/src/server/upload-server.ts`

Known HTTP paths:

- `POST /api/uploads`
- `POST /api/pulse`

Use `AYATI_HTTP_API_TOKEN` when Pulse API access needs token protection.
