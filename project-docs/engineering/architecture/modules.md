# Modules

Backend package: `ayati-main`

- `src/app`: bootstrap, chat/system-event coordination, Context Engine
  integration, finalization, and exact resource-scoped execution.
- `src/ivec`: engine, decision/action/reducer runner, state projection,
  capability policy, verification, feedback, and context pressure.
- `src/context-engine`: prompt-facing projection of authoritative Context Engine
  records; it owns no database or Git writes.
- `src/skills`: built-in tools, taxonomy, contracts, executor, and skill
  activation.
- `src/memory`: personal and episodic memory. Durable workstream continuation
  belongs to Context Engine.
- `src/files`, `src/documents`: attachment preparation, metadata, extraction,
  indexing, and retrieval.
- `src/pulse`, `src/core`, `src/plugins`: scheduling, system ingress, provider
  and plugin contracts.
- `src/server`: WebSocket and HTTP APIs.

Context Engine package: `ayati-context-engine`

- `src/runtime.ts`: in-process lifecycle, writer-lock ownership, startup, and
  shutdown.
- `src/service.ts`: typed boundary consumed by the daemon.
- `src/services`: atomic preparation, workstream/resource lifecycle, step
  persistence, finalization, discovery, and recovery.
- `src/workstreams`: context-only repository layout, readers, reducers, and
  request records.
- `src/resources`: locator observation and resource identity helpers.
- `src/database`, `src/repositories`: schema and authoritative SQLite records.
- `src/git`: context-only Git transactions.
- `src/contracts.ts`: service request/response contracts.

This package is the only owner of Context Engine SQLite and context Git writes.

CLI package: `ayati-cli`

- `src/app/app.tsx`: Ink composition and chat workflow.
- `src/app/components`, `src/app/hooks`: terminal rendering and WebSocket UX.
- `src/app/commands.ts`: slash commands and attachment queue handling.
