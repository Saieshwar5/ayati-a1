# Modules

Backend package: `ayati-main`

- `src/app`: bootstrap and runtime wiring.
- `src/ivec`: `IVecEngine`, decision-action-reducer runner, state view, context pack, tool selection, progress reduction, session rotation, and system-event policy.
- `src/app/git-context-process.ts`: lifecycle owner for the independent local
  Git Context server.
- `src/app/git-context-runtime.ts`: typed client/runtime integration used by
  the daemon.
- `src/context-engine`: compatibility projection and prompt-facing Git Context
  shapes. It does not own Git or context-database writes.
- `src/context`: base prompt, soul, static context, and policy loading.
- `src/prompt`: static prompt section helpers and token estimation.
- `src/core`: provider/plugin contracts, registries, system ingress, inbound queue, and plugin loading.
- `src/providers`: provider adapters for OpenRouter, OpenAI, Anthropic, and Fireworks.
- `src/skills`: built-in/runtime tool definitions, tool executor, contracts, and optional skill activation support.
- `src/memory`: run/session recording, personal memory, episodic memory,
  embeddings, and recall support. Durable task continuation belongs to the
  Git Context server and each task repository.
- `src/documents`: legacy prepared document/dataset compatibility, extraction, indexing, and retrieval support.
- `src/files`: primary managed attachment substrate for files, directories, metadata, storage layout, and processors.
- `src/pulse`: reminders, scheduled tasks, parser, scheduler, and proposal reflection.
- `src/server`: WebSocket server, HTTP upload/artifact server, and upload storage.
- `src/plugins`: optional plugin integrations.

Git Context package: `ayati-git-context`

- `src/server-main.ts`: local Unix-socket process entry point.
- `src/server.ts`: request decoding and typed protocol dispatch.
- `src/services`: task/session/run orchestration and SQLite catalog ownership.
- `src/git`: session and task repository operations.
- `src/database` and `src/repositories`: context schema, catalog records,
  lifecycle records, and run journal.
- `src/contracts.ts`: protocol request and response types shared with clients.

This package is the only owner of Git Context SQLite and Git mutations. The
daemon calls it through the typed client instead of editing `.ayati/` or Git
metadata directly.

CLI package: `ayati-cli`

- `src/app/app.tsx`: Ink app composition and chat workflow.
- `src/app/components`: terminal UI components.
- `src/app/hooks`: WebSocket and terminal mouse behavior.
- `src/app/commands.ts`: slash command parsing for file attachment workflows.
