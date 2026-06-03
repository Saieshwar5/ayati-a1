# Data Flow

Daemon communication flow:

1. A communication channel sends a user message or event into the daemon.
2. Current CLI path: `ayati-cli` sends `{ type: "chat", content, attachments? }` to `ws://localhost:8080`.
3. `WsServer` parses JSON and forwards payloads to `IVecEngine.handleMessage`.
4. `IVecEngine` parses chat input, stores session turns, builds dynamic prompt context, and enters the agent loop.
5. The engine retrieves relevant session, personal, episodic, document, file, tool, skill, runtime, and system-event context.
6. The loop asks the provider for the next action.
7. If tool calls are requested, `createToolExecutor` validates and dispatches to registered tool definitions.
8. Tool results are fed back into the loop for continuation or final answer.
9. The engine replies through `onReply`; local replies go back through `WsServer.send`.

Client model:

1. Clients should be communication surfaces.
2. Clients should not own agent intelligence, memory, tool policy, provider selection, or long-running state.
3. New clients should send normalized messages/events to the daemon and render replies/notifications.

Memory flow:

1. User interactions are stored as session turns.
2. Session close can enqueue memory consolidation and episodic indexing.
3. Personal memory stores stable facts and preferences for personalization.
4. Episodic memory indexes closed sessions for future recall when embeddings are available.
5. Prompt sections render relevant memory back into future agent runs.

Tool/action flow:

1. The daemon exposes tools through built-in skills and external skill brokering.
2. The agent loop selects tool calls only when needed for the user goal.
3. The tool executor validates and executes requests.
4. Results become evidence for the next loop step or final response.

Attachment flow:

1. CLI slash commands queue local file attachments.
2. Chat payloads can include attachment metadata.
3. The daemon prepares attachments through document/file services.
4. Structured data can be profiled or queried.
5. Text documents can be read by section or queried through retrieval when vector indexing is available.

System-event flow:

1. Plugins, Pulse, Telegram, or external adapters normalize events.
2. `SystemIngressService` queues events in the inbound queue store.
3. `SystemEventWorker` feeds events to `IVecEngine.handleSystemEvent`.
4. `context/system-event-policy.json` controls event handling behavior.
5. The daemon may reply, notify, ask for approval, schedule follow-up work, or use tools depending on policy.
