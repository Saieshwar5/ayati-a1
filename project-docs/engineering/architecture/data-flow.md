# Data Flow

Daemon communication flow:

1. A communication channel sends a user message or event into the daemon.
2. Current CLI path: `ayati-cli` sends `{ type: "chat", content, attachments? }` to `ws://localhost:8080`.
3. `WsServer` parses JSON and forwards payloads to `IVecEngine.handleMessage`.
4. The chat runtime records the user message in daily git context and prepares
   pending-turn ownership state.
5. Runtime auto-binds obvious same-task follow-ups. If task ownership is
   semantic or ambiguous, the agent can search/read git context and use
   turn-aware activate/create/clarify tools before normal task work runs.
6. The runner builds a structured context pack from daily git context and
   personal memory. Current-run attachments appear separately in the sparse
   state view only when present.
7. The decision model chooses a control tool (`decision_reply`,
   `decision_ask_user`, or `decision_load_tools`) or directly calls one
   selected executable tool.
8. If an executable tool is called, the action executor validates the selected
   tool input and dispatches through registered tool definitions.
9. Tool contracts/assertions turn results into verified facts and evidence.
10. The progress reducer updates sparse `workState`; verified local work can mark
   `workState.status` as `done`.
11. Completed tool work routes through a final decision-model reply so the user
   sees a natural answer while verification details stay internal.
12. Runtime finalization commits task state, run summaries, actions, evidence,
   assets, assistant response metadata, and git commit trailers exactly once for
   the task run when a run exists.
13. The engine replies through `onReply`; local replies go back through `WsServer.send`.

Client model:

1. Clients should be communication surfaces.
2. Clients should not own agent intelligence, memory, tool policy, provider selection, or long-running state.
3. New clients should send normalized messages/events to the daemon and render replies/notifications.

Git context and memory flow:

1. User interactions are recorded in the daily git session conversation on the
   main branch.
2. The context engine creates a pending turn. Obvious same-task follow-ups bind
   automatically; semantic ownership uses git-context read/search plus
   turn-aware activate/create/clarify tools.
3. While a pending turn is unbound or clarifying, normal task tools are blocked.
   No task branch receives the conversation and no run id is allocated until
   ownership is clear.
4. The agent loop receives `gitContext` with conversation tail, pending-turn
   state, focus, task state, task assets, recent runs, recent commits, recent
   evidence, facts, open work, and next step.
5. Every completed task run writes machine-readable state, run summary,
   actions, evidence manifests, final output, and task assets to the work
   branch.
6. Run commits include Ayati commit metadata so the branch history itself is a
   retrieval surface.
7. Attachment restore reads git task assets from tool execution context. It
   does not use Activity memory.
8. Session close can still enqueue personal-memory consolidation and episodic
   indexing when those services are enabled.
9. Personal memory stores stable facts and preferences for personalization.
10. Episodic memory indexes closed sessions for future recall when embeddings
   are available.
11. The context pack renders relevant git context and personal memory back into
    future agent runs as bounded JSON.

Tool/action flow:

1. The daemon keeps a hidden tool catalog, prepares a capped working set, and
   can load more tools through `decision_load_tools`.
2. The decision model sees native control tools plus the selected executable
   tool schemas for the current turn.
3. The model calls one selected executable tool directly only when tool work is
   needed for the current input or selected git task context.
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
6. Git task branches store restorable task asset references, not full file
   contents. Later follow-up runs resolve the work branch and call
   `attachment_restore`, which reads `context.taskAssets` and restores a path,
   file, directory, document, or dataset into the current run.

Workspace orchestration flow:

1. `ayati-cli` includes UI context for the current terminal window when available.
2. `WorkspaceOrchestrator` treats that terminal as the protected anchor for the current Omarchy/Hyprland workspace.
3. The orchestrator reads Hyprland clients with `hyprctl`, assigns role-based window records, and persists compact workspace state under `data/ui/workspace-orchestrator.json`.
4. Workspace tools let the agent read state, apply layout presets, focus windows, register roles, reuse or open role windows, close windows, and clean up unused windows.
5. The initial policy is single-workspace only, maximum five windows including the CLI, with automatic cleanup of least-useful unpinned non-CLI windows when capacity is exceeded.
6. Coding, browsing, previews, references, and scratch explanations should use this general workspace layer instead of adding one-off window-control logic.

System-event flow:

1. Plugins and Pulse normalize events.
2. `SystemIngressService` queues events in the inbound queue store.
3. `SystemEventWorker` feeds events to `IVecEngine.handleSystemEvent`.
4. `context/system-event-policy.json` controls event handling behavior.
5. The daemon may reply, notify, ask for approval, schedule follow-up work, or use tools depending on policy.
