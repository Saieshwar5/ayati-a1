# Data Flow

Daemon communication flow:

1. A communication channel sends a user message or event into the daemon.
2. Current CLI path: `ayati-cli` sends `{ type: "chat", content, attachments? }` to `ws://localhost:8080`.
3. `WsServer` parses JSON and forwards payloads to `IVecEngine.handleMessage`.
4. `IVecEngine` parses chat input, stores session turns, builds static decision context, and enters the agent runner.
5. The runner builds a structured context pack from session memory, active focus
   cards, session focus cards, attention shelf, active attachments, personal
   memory, and learning context.
6. The decision model chooses `reply`, `ask_user`, or `act`.
7. If tool calls are requested, the action executor validates the plan and dispatches through registered tool definitions.
8. Tool contracts/assertions turn results into verified facts and evidence.
9. The progress reducer updates sparse `workState`; verified local work can mark
   `workState.status` as `done`.
10. Completed tool work routes through a final decision-model reply so the user
   sees a natural answer while verification details stay internal.
11. The engine replies through `onReply`; local replies go back through `WsServer.send`.

Client model:

1. Clients should be communication surfaces.
2. Clients should not own agent intelligence, memory, tool policy, provider selection, or long-running state.
3. New clients should send normalized messages/events to the daemon and render replies/notifications.

Memory and focus flow:

1. User interactions are stored as session turns.
2. Task summaries with tools, focus assets, attachments, or an explicit
   continuation `focusId` create or update focus cards in `memory.sqlite`.
3. Direct replies without durable assets or continuation state do not create
   focus cards.
4. Focus cards store compact summaries plus full continuation state: assets,
   run refs, and current resumable state.
5. Focus tools can search, get, activate, deactivate, update, and list focus
   cards.
6. Activated cards appear in `activeFocus` for the current session and can be
   loaded as full cards for continuation.
7. Focus-card assets can restore user-attached documents, datasets, files, and
   directories into the current run through `attachment_restore`.
8. Session close promotes durable session focus cards into global attention
   shelf cards.
9. The attention shelf selects compact, high-relevance global focus summaries
   for future decisions.
10. Session close can enqueue memory consolidation and episodic indexing.
11. Personal memory stores stable facts and preferences for personalization.
12. Episodic memory indexes closed sessions for future recall when embeddings are available.
13. The context pack renders relevant memory back into future agent runs as bounded JSON.

Tool/action flow:

1. The daemon exposes kernel tools by default and can dynamically activate additional built-in skills.
2. The decision model selects tool calls only when needed for the current input or active focus.
3. The action executor validates plan shape, selected tools, dependencies, and unsafe parallel filesystem overlap.
4. The tool executor validates and executes requests.
5. Results become artifacts, verified facts, evidence, and optional `workState` updates for continuation or final response.

Attachment flow:

1. Communication clients send attachments with the user message. CLI clients
   normally send path metadata; HTTP/API clients can send uploaded bytes or
   directory uploads.
2. The daemon normalizes every input into a managed attachment record. Uploaded
   files are copied under `data/files/<fileId>/original/`; CLI file paths are
   copied into the same storage when registered; CLI directories are scanned
   into `data/directories/<directoryId>/metadata.json` with include/exclude
   rules instead of copying the whole tree.
3. The run state carries compact attachment summaries: managed files, managed
   directories, and compatibility prepared document/dataset records.
4. The agent should prefer the unified attachment tools:
   `attachment_list`, `attachment_inspect`, `attachment_read`,
   `attachment_query`, `attachment_query_table`, `directory_search`, and
   `attachment_restore`.
5. Text-capable files are extracted and chunked lazily when read or queried.
   CSV/XLSX files are staged lazily into a run-scoped SQLite table when queried.
   Directories are searched by manifest/path and optionally by UTF-8 file
   contents; individual files can be registered/queryable when deeper parsing is
   needed.
6. Focus cards store restorable attachment assets, not full file contents. Later
   follow-up runs activate the card and call `attachment_restore`, which touches
   the stored file or directory into the current run or restores prepared
   document/dataset metadata.

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

1. Plugins and Pulse normalize events.
2. `SystemIngressService` queues events in the inbound queue store.
3. `SystemEventWorker` feeds events to `IVecEngine.handleSystemEvent`.
4. `context/system-event-policy.json` controls event handling behavior.
5. The daemon may reply, notify, ask for approval, schedule follow-up work, or use tools depending on policy.
