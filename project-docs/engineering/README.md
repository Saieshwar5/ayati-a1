# Engineering Docs

Engineering docs contain all implementation, architecture, workflow, testing,
operations, and project-history context for Ayati.

Important paths:

- `architecture/`: daemon architecture, agent harness, context/memory, tool contracts, APIs, runtime data, clients, integrations, and trust boundaries.
- `architecture/workstreams-and-resources.md`: canonical durable-work,
  resource, request, run, and context-repository design.
- `history/`: architecture decisions, progress notes, and external references.
- `history/progress/current-state.md`: current implementation state, runtime
  boundaries, and remaining priorities.
- `ai-agent-instructions.md`: operating rules for AI coding agents working in this repository.
- `context-priority.md`: what to read first for different task types.
- `commands.md`: common development commands.
- `env-vars.md`: runtime configuration flags and environment defaults.
- `testing.md`: test strategy and commands.
- `headless-chat-scenarios.md`: how another coding agent can test Ayati through the same multi-turn WebSocket chat path as a human user.
- `live-agent-evaluation.md`: passive real-daemon evaluation capture, evidence reports, comparison, and safe pruning.
- `runtime-performance-benchmarking.md`: non-LLM runtime performance benchmark design, commands, report interpretation, and subsystem improvement signals.
- `conventions.md`: code organization and style.
- `security.md`: safety and secret-handling rules.

Current backend mental model:

```text
IVecEngine -> runAgentLoop -> state view/context pack -> decision -> action executor -> verification -> progress reducer
```

Keep architecture docs under `engineering/architecture/`; do not recreate a
top-level `project-docs/architecture/` directory.
