# Data Flow

Daemon communication flow:

1. A communication channel sends a user message or event into the daemon.
2. Current CLI path: `ayati-cli` sends `{ type: "chat", content, attachments? }` to `ws://localhost:8080`.
3. `WsServer` parses JSON and forwards payloads to `IVecEngine.handleMessage`.
4. `IVecEngine` parses chat input, stores session turns, builds static decision context, and enters the agent runner.
5. The runner builds a structured context pack from session memory,
   same-session task-thread context, resolved activity continuity, personal
   memory, and learning context. Current-run attachments appear separately in
   the sparse state view only when present.
6. The decision model chooses a control tool (`decision_reply`,
   `decision_ask_user`, or `decision_load_tools`) or directly calls one
   selected executable tool.
7. If an executable tool is called, the action executor validates the selected
   tool input and dispatches through registered tool definitions.
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

Memory, task-thread, and activity flow:

1. User interactions are stored as session turns.
2. Every task run can produce an immutable TaskSummary describing run status,
   task status, open work, blockers, evidence, tools, and useful assets.
3. Open task summaries without explicit `activityId` update a same-session
   TaskThread first. This keeps unfinished work available to the next run
   without prematurely creating durable Activity memory.
4. The context pack exposes compact `taskThreadContext` with the active open
   task, suspended open tasks, recent continuation signals, and a suggested
   binding for the existing decision stage.
5. Done task summaries close the TaskThread and promote the whole thread
   aggregate to an Activity. Session close also promotes remaining open task
   threads so unfinished work is recoverable later.
6. Direct replies without durable assets, tools, or continuation state do not
   create task threads or activity threads.
7. Activity threads store compact summaries plus full continuation state:
   identities, assets, run refs, and resumable state.
8. `ContinuityResolver` resolves the current user message deterministically
   before decisions by exact identities, aliases/search terms, and recent
   follow-up wording.
9. The context pack exposes `continuity.mode` as `new`, `continue`, or
   `ambiguous`; the model does not receive shelves of unrelated work.
10. Activity tools can search, get, select, update, and archive activity
   threads.
11. Activity assets can restore user-attached documents, datasets, files, and
   directories into the current run through `attachment_restore` or
   `activity_restore_assets`.
12. Session close can enqueue memory consolidation and episodic indexing.
13. Personal memory stores stable facts and preferences for personalization.
14. Episodic memory indexes closed sessions for future recall when embeddings are available.
15. The context pack renders relevant memory back into future agent runs as bounded JSON.

Tool/action flow:

1. The daemon keeps a hidden tool catalog, prepares a capped working set, and
   can load more tools through `decision_load_tools`.
2. The decision model sees native control tools plus the selected executable
   tool schemas for the current turn.
3. The model calls one selected executable tool directly only when tool work is
   needed for the current input or resolved activity continuity.
4. The action executor adapts the native tool call into an internal action
   record, validates selected-tool membership and the executable input schema,
   and dispatches through the tool executor.
5. Results become artifacts, verified facts, evidence, and optional `workState`
   updates for continuation or final response.

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
6. Activity threads store restorable attachment assets, not full file contents.
   Later follow-up runs resolve the activity and call `attachment_restore` or
   `activity_restore_assets`, which touches the stored file or directory into
   the current run or restores prepared document/dataset metadata.

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
