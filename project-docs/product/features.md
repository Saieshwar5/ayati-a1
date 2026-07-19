# Features

Current product features:

- Runtime-selectable LLM providers: OpenRouter, OpenAI, Anthropic, and Fireworks.
- Decision-action-reducer IVec harness with direct assistant text for normal
  final replies, native `decision_load_tools` for tool working-set changes,
  task-only `ask_user_feedback` for blocking in-run feedback, and selected
  executable tools exposed directly through their own native schemas.
- Strict run-scoped tool loading from hidden tool catalog groups, exact tool
  names, or search queries, with small purpose-built groups, lifecycle-aware
  retention, deterministic follow-up loading, and repair feedback fed back into
  the next decision.
- Stable repair-code feedback for deterministic protocol, tool-input,
  task-routing, provider-empty-response, verification, no-progress, and
  repeated-repair failures.
- Structured context pack with recent conversation, selected git task
  context, pending-turn state, task assets, hot evidence, personal memory, and
  current run state.
- Git-native task routing through `git_context_create_task` and
  `git_context_activate_task`, with explicit continue-current-request or
  create-new-request decisions for existing V1 tasks.
- Deterministic tool verification through tool contracts, assertions, verified facts, and progress reduction.
- Deterministic executable-tool input validation, action execution, and
  deny-by-default parallel execution for explicitly safe read-only local flows.
- Built-in skills for focused process execution, filesystem work, calculator, SQLite database work, Python execution, documents, datasets, files, memory, recall, UI workspace control, and Pulse.
- One independent normal `T-*` Git repository for each durable task, with a
  compact task card, bounded requests, tracked reference provenance, verified
  outcomes, and semantic commit trailers.
- Git task assets for restoring user-attached
  documents, datasets, files, and directories into later follow-up runs.
- Hot tool-output context with retention metadata, compact previews, and raw
  output audit refs without flooding every model decision.
- Prompt-facing reusable context organized as inventory, discovery, evidence,
  and actions, backed by run evidence instead of durable task-state bloat and
  reset at successful task-commit boundaries.
- Filesystem metadata and batched-read tools, including `inspect_paths`,
  `read_files`, read advisories, and search/list tools for efficient code and
  document context gathering.
- Read-progress feedback for active task runs, so repeated read-only loops can
  be redirected toward writing/editing, clarification, or a useful blocked
  state.
- Personal memory for stable user facts, time-based facts, and evolving preferences.
- Episodic memory for semantic recall over closed sessions when embeddings are available.
- Managed file registration and upload processing.
- Document extraction, section reads, and optional vector retrieval.
- Structured data profiling and query workflows.
- CLI-anchored Omarchy/Hyprland workspace orchestration with role-based windows, layout presets, protected CLI anchor, and max-five-window cleanup.
- Generated run artifacts served over HTTP.
- Terminal chat UI with attachment queue commands.
- Pulse scheduling and system-event processing.

Core product capabilities:

- Persistent daemon runtime that can keep agent state alive across user interactions.
- Multi-channel communication model where clients connect to the daemon.
- Long-term personalization through personal memory and episodic recall, with
  task continuation handled by independent task repositories and
  runtime-owned task-run finalization.
- General visual workbench control for coding, browsing, references, previews, scratch explanations, and other workspace-heavy tasks.
- Computer-access layer for useful work across files, focused project processes, Python, SQLite, documents, datasets, and generated artifacts.
- Event-driven and proactive behavior through system events, plugins, and Pulse scheduling.
- Provider abstraction so model choice can change without rewriting the agent loop.

Intended future capabilities:

- Additional clients such as web, mobile, voice, and richer remote interfaces.
- Stronger background service installation and restart behavior.
- Safer permissioning around high-privilege computer actions.
- Richer proactive assistance based on user memory, time, events, and context.
- More external integrations for real-life workflows.

Current task-repository reliability gaps are documented in
[Task Repositories](../engineering/architecture/task-repositories.md); they are
not current product features.
