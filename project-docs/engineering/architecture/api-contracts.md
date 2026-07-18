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

After committing the canonical `reply_done` content and making the newest
message visible, the CLI acknowledges the exact server-issued turn:

```json
{
  "type": "reply_rendered",
  "turnId": "server-issued-turn-id",
  "renderedAt": "2026-07-18T08:30:00.000Z"
}
```

The WebSocket server accepts this acknowledgement only when the same client
previously received `reply_done` for that `turnId`. This provides transport
telemetry that distinguishes reply dispatch from confirmed client rendering.

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

## Git Context Protocol

Git Context is an internal local service, not a user-facing remote API.
`ManagedGitContextProcess` starts it and the typed client connects over the Unix
socket configured by `AYATI_GIT_CONTEXT_SOCKET`. Client and server must agree on
`GIT_CONTEXT_PROTOCOL_VERSION` (currently `32`). The selection result makes the
request decision (`initial`, `continue`, or `create`) explicit and records
whether that selection created a request. These
fields feed both model routing and live-test feedback.

The protocol covers health, sessions, conversation records, task catalog reads,
task creation/selection, request routing, mutation authority, attachments,
context projection, run lifecycle, and finalization. The server alone owns its
SQLite database and Git mutations.

V1 guarantees:

- new durable tasks are normal independent `T-*` repositories;
- task selection returns a stable working directory;
- selecting an existing task requires an explicit request decision;
- task finalization updates `.ayati/` and creates the task commit; and
- protocol errors use typed codes rather than guessed filesystem recovery.

The raw `POST /tasks` transport is lower-level than the
model-facing `git_context_create_task` workflow; callers should use the typed
service workflow that creates the initial V1 request.

See [Task Repositories](task-repositories.md) for the repository contract.
