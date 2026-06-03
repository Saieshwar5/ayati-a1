# Features

Current product features:

- Runtime-selectable LLM providers: OpenRouter, OpenAI, Anthropic, and Fireworks.
- Staged IVec agent loop with `understand`, `direct`, `reeval`, and `system_event` stages.
- Layered prompt context from static prompts, controller prompts, soul, memory, session state, tools, skills, and runtime activity.
- Built-in skills for shell, filesystem, calculator, SQLite database work, Python execution, documents, datasets, files, memory, recall, identity, Pulse, and external skill brokering.
- Personal memory for stable user facts, time-based facts, and evolving preferences.
- Episodic memory for semantic recall over closed sessions when embeddings are available.
- Managed file registration and upload processing.
- Document extraction, section reads, and optional vector retrieval.
- Structured data profiling and query workflows.
- Generated run artifacts served over HTTP.
- Terminal chat UI with attachment queue commands.
- Optional Telegram transport and event/plugin integrations.

Core product capabilities:

- Persistent daemon runtime that can keep agent state alive across user interactions.
- Multi-channel communication model where clients connect to the daemon.
- Long-term personalization through personal memory, session memory, and episodic recall.
- Computer-access layer for useful work across files, shell, Python, SQLite, documents, datasets, and generated artifacts.
- Event-driven and proactive behavior through system events, plugins, and Pulse scheduling.
- Provider abstraction so model choice can change without rewriting the agent loop.

Intended future capabilities:

- Additional clients such as web, mobile, voice, and richer remote interfaces.
- Stronger background service installation and restart behavior.
- Safer permissioning around high-privilege computer actions.
- Richer proactive assistance based on user memory, time, events, and context.
- More external integrations for real-life workflows.
