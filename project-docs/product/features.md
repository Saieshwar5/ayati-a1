# Features

Current product features:

- Persistent daemon runtime with OpenRouter, OpenAI, Anthropic, and Fireworks
  providers.
- Decision/action/reducer harness with tool-free `ENTRY` replies, run-scoped
  virtual-mode navigation, native whole-task validation, deterministic
  verification, and stable repair codes.
- One atomic run for every accepted user message, including
  valid zero-step direct replies.
- Autonomous durable-work discovery through compact candidates and
  `git_context_find_workstreams` / `git_context_read_workstream`, including
  exact read-only access to matching historical requests.
- Workstream routing through `git_context_create_workstream` and
  `git_context_activate_workstream`, including explicit continuation,
  amendment, queued activation, blocked resumption, request creation, and
  atomic defer-and-switch decisions.
- Explicit workstream stars, resource inspection, and resource binding.
- One shared context-only Git repository containing `W-*` directories with a
  distilled workstream card, bounded request files, an append-only progress
  ledger, and a portable resource projection.
- Five-state request lifecycle (`queued`, `active`, `blocked`, `done`,
  `dropped`) with at most one active request per workstream.
- A SQLite resource catalog covering files, directories, documents, media,
  datasets, databases, repositories, URLs, and external objects.
- Immutable content-addressed storage for admitted user attachments.
- Exact resource mutation scopes with before/after observations, deterministic
  verification, idempotency, and recovery journals.
- User-visible default outputs under `<AYATI_ROOT_DIR>/workspace/`; user-named
  resources remain at their real locations and are never copied into context
  Git.
- One finalization path that closes the conversation/run, discards a new
  resource-free provisional workstream, or persists verified resource effects,
  appends one progress entry, reduces retained workstream context, and creates
  exactly one commit for a retained bound run.
- Exact run-step evidence with bounded on-demand history search/read; read
  results are not copied into a second cross-run context lane.
- Filesystem metadata, batch reads and writes, focused processes, Python,
  structured SQLite operations, unified managed-file text/table extraction,
  generated artifacts, personal memory, timezone-aware current time, and
  bounded local machine health.
- Personal memory, managed uploads, directories, and restorable workstream
  attachments using one managed identity per file or directory.
- WebSocket terminal chat, a secure Electron desktop client with streaming
  replies, daemon reconnect, tray behavior, and native notifications,
  push-to-talk voice input with local Voxtype transcription and confirmation,
  and HTTP upload/artifact APIs.
- Passive, opt-in real-daemon evaluation with schema-versioned evidence,
  deterministic diagnostics, and per-turn/session Markdown and JSON reports.
- Preview-first nested-workstream migration, archive/reset, and context-catalog
  rebuild commands.

Intended future capabilities include more clients, stronger service
installation, finer permissions, additional external integrations, richer
proactive assistance, and domain-specific resource verification.

The durable-work contract and current boundaries are documented in
[Workstreams and Resources](../engineering/architecture/workstreams-and-resources.md).
