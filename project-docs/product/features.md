# Features

Current product features:

- Runtime-selectable LLM providers: OpenRouter, OpenAI, Anthropic, and Fireworks.
- Decision-action-reducer IVec harness with direct assistant text for normal
  final replies, native `decision_load_tools` for tool working-set changes,
  task-only `ask_user_feedback` for blocking in-run feedback, and selected
  executable tools exposed directly through their own native schemas.
- Strict run-scoped tool loading from hidden tool catalog groups, exact tool
  names, or search queries, with tool-load and failure feedback fed back into
  the next decision.
- Stable repair-code feedback for deterministic protocol, tool-input,
  task-routing, provider-empty-response, verification, no-progress, and
  repeated-repair failures.
- Structured context pack with recent conversation, selected git task
  context, pending-turn state, task assets, hot evidence, personal memory, and
  current run state.
- Git-native task routing with automatic active-task continuation,
  turn-aware activate/create/clarify tools for semantic task ownership, and a
  deterministic guard that keeps normal work tools behind a real task run.
- Deterministic tool verification through tool contracts, assertions, verified facts, and progress reduction.
- Deterministic executable-tool input validation, action execution, and
  deny-by-default parallel execution for explicitly safe read-only local flows.
- Built-in skills for shell, filesystem, calculator, SQLite database work, Python execution, documents, datasets, files, memory, recall, UI workspace control, and Pulse.
- Default daily git context for ongoing projects, documents, automations,
  investigations, and debugging, backed by task branches, custom refs, run
  summaries, action records, evidence manifests, and commit trailers.
- Git task assets for restoring user-attached
  documents, datasets, files, and directories into later follow-up runs.
- Hot tool-output context with retention metadata and evidence tools for
  reading, searching, tailing, or chunking saved raw output without flooding
  every model decision.
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
  task continuation handled by default git context work branches and
  runtime-owned task-run finalization.
- General visual workbench control for coding, browsing, references, previews, scratch explanations, and other workspace-heavy tasks.
- Computer-access layer for useful work across files, shell, Python, SQLite, documents, datasets, and generated artifacts.
- Event-driven and proactive behavior through system events, plugins, and Pulse scheduling.
- Provider abstraction so model choice can change without rewriting the agent loop.

Intended future capabilities:

- Additional clients such as web, mobile, voice, and richer remote interfaces.
- Stronger background service installation and restart behavior.
- Safer permissioning around high-privilege computer actions.
- Richer proactive assistance based on user memory, time, events, and context.
- More external integrations for real-life workflows.
