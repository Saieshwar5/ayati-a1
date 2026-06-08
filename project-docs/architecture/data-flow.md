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

Learning flow:

1. The agent detects a learning intent and uses personal memory plus direct questions to gather missing learner context such as purpose, background, level, and preferred style.
2. `CourseStore` keeps one active course per client and persists structured state under `data/learning/courses/<courseId>/`.
3. Course state is split into `course.json`, `context.json`, `course-map.json`, `learning-index.json`, `doubts.json`, and per-lesson HTML plus per-lesson JSON metadata.
4. The engine injects only a compact active-course context capsule into prompts. Full lesson HTML is not prompt context.
5. Before continuing a course, the learning planner reads the course map and learning index to avoid duplicate topics, respect prerequisites, and keep the course aligned with the learner's purpose.
6. Lesson generation writes visual HTML/CSS/JS for Tauri and a sidecar lesson JSON record for future agent reasoning.
7. User doubts are recorded against the active course/lesson, update weak concepts or open questions, and can be searched with the active-course context tools.

Workspace orchestration flow:

1. `ayati-cli` includes UI context for the current terminal window when available.
2. `WorkspaceOrchestrator` treats that terminal as the protected anchor for the current Omarchy/Hyprland workspace.
3. The orchestrator reads Hyprland clients with `hyprctl`, assigns role-based window records, and persists compact workspace state under `data/ui/workspace-orchestrator.json`.
4. Workspace tools let the agent read state, apply layout presets, focus windows, register roles, reuse or open role windows, close windows, and clean up unused windows.
5. The initial policy is single-workspace only, maximum five windows including the CLI, with automatic cleanup of least-useful unpinned non-CLI windows when capacity is exceeded.
6. Learning, coding, browsing, previews, references, and scratch explanations should use this general workspace layer instead of adding one-off window-control logic.

System-event flow:

1. Plugins, Pulse, Telegram, or external adapters normalize events.
2. `SystemIngressService` queues events in the inbound queue store.
3. `SystemEventWorker` feeds events to `IVecEngine.handleSystemEvent`.
4. `context/system-event-policy.json` controls event handling behavior.
5. The daemon may reply, notify, ask for approval, schedule follow-up work, or use tools depending on policy.
