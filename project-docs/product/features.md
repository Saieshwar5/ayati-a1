# Features

Current product features:

- Runtime-selectable LLM providers: OpenRouter, OpenAI, Anthropic, and Fireworks.
- Decision-action-reducer IVec harness with `reply`, `ask_user`, and `act` decisions.
- Structured context pack with recent conversation, resolved continuity,
  personal memory, and active learning context.
- Deterministic tool verification through tool contracts, assertions, verified facts, and progress reduction.
- Built-in skills for shell, filesystem, calculator, SQLite database work, Python execution, documents, datasets, files, memory, recall, identity, Pulse, and dynamic built-in skill activation.
- Activity threads and deterministic continuity resolution for ongoing projects, documents, learning, automations, investigations, and debugging.
- Activity assets for restoring user-attached documents, datasets, files, and directories into later follow-up runs.
- Personal memory for stable user facts, time-based facts, and evolving preferences.
- Episodic memory for semantic recall over closed sessions when embeddings are available.
- Managed file registration and upload processing.
- Document extraction, section reads, and optional vector retrieval.
- Structured data profiling and query workflows.
- Durable first-principles learning courses with one active course per user, structured course maps, learning indexes, lesson metadata, doubt tracking, and Tauri-rendered visual lessons.
- CLI-anchored Omarchy/Hyprland workspace orchestration with role-based windows, layout presets, protected CLI anchor, and max-five-window cleanup.
- Generated run artifacts served over HTTP.
- Terminal chat UI with attachment queue commands.
- Pulse scheduling and system-event processing.

Core product capabilities:

- Persistent daemon runtime that can keep agent state alive across user interactions.
- Multi-channel communication model where clients connect to the daemon.
- Long-term personalization and continuation through session memory, activity threads, personal memory, and episodic recall.
- Learning continuity through active-course context capsules, duplicate-aware lesson planning, and scoped search over the active course map, lesson metadata, notes, and doubts.
- General visual workbench control for learning, coding, browsing, references, previews, scratch explanations, and other workspace-heavy tasks.
- Computer-access layer for useful work across files, shell, Python, SQLite, documents, datasets, and generated artifacts.
- Event-driven and proactive behavior through system events, plugins, and Pulse scheduling.
- Provider abstraction so model choice can change without rewriting the agent loop.

Intended future capabilities:

- Additional clients such as web, mobile, voice, and richer remote interfaces.
- Stronger background service installation and restart behavior.
- Safer permissioning around high-privilege computer actions.
- Richer proactive assistance based on user memory, time, events, and context.
- More external integrations for real-life workflows.
