# Modules

Backend package: `ayati-main`

- `src/app`: bootstrap and runtime wiring.
- `src/ivec`: `IVecEngine`, decision-action-reducer runner, state view, context pack, tool selection, progress reduction, session rotation, and system-event policy.
- `src/context-engine`: daily git context engine for conversation, focus,
  work branches, task files, run commits, and machine context packs.
- `src/context`: base prompt, soul, static context, and policy loading.
- `src/prompt`: static prompt section helpers and token estimation.
- `src/core`: provider/plugin contracts, registries, system ingress, inbound queue, and plugin loading.
- `src/providers`: provider adapters for OpenRouter, OpenAI, Anthropic, and Fireworks.
- `src/skills`: built-in/runtime tool definitions, tool executor, contracts, and optional skill activation support.
- `src/memory`: run/session recording, personal memory, episodic memory,
  embeddings, and recall support. Task continuation belongs to
  `src/context-engine`.
- `src/documents`: legacy prepared document/dataset compatibility, extraction, indexing, and retrieval support.
- `src/files`: primary managed attachment substrate for files, directories, metadata, storage layout, and processors.
- `src/pulse`: reminders, scheduled tasks, parser, scheduler, and proposal reflection.
- `src/server`: WebSocket server, HTTP upload/artifact server, and upload storage.
- `src/plugins`: optional plugin integrations.

CLI package: `ayati-cli`

- `src/app/app.tsx`: Ink app composition and chat workflow.
- `src/app/components`: terminal UI components.
- `src/app/hooks`: WebSocket and terminal mouse behavior.
- `src/app/commands.ts`: slash command parsing for file attachment workflows.
