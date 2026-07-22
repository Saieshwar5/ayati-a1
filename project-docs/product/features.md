# Features

Current product features:

- Persistent daemon runtime with OpenRouter, OpenAI, Anthropic, and Fireworks
  providers.
- Decision/action/reducer harness with tool-free `ENTRY` replies, run-scoped
  virtual-mode navigation, native whole-task validation, deterministic
  verification, and stable repair codes.
- One atomic run for every accepted user message or system event, including
  valid zero-step direct replies.
- Autonomous durable-work discovery through compact candidates and
  `git_context_find_workstreams` / `git_context_read_workstream`.
- Workstream routing through `git_context_create_workstream` and
  `git_context_activate_workstream`, including explicit continue-or-create
  request decisions for existing workstreams.
- Explicit workstream stars, resource inspection, and resource binding.
- Context-only independent `W-*` Git repositories containing a workstream card,
  bounded request files, and a portable resource ledger.
- A SQLite resource catalog covering files, directories, documents, media,
  datasets, databases, repositories, URLs, and external objects.
- Immutable content-addressed storage for admitted user attachments.
- Exact resource mutation scopes with before/after observations, deterministic
  verification, idempotency, and recovery journals.
- User-visible default outputs under `<AYATI_ROOT_DIR>/workspace/`; user-named
  resources remain at their real locations and are never copied into context
  Git.
- One finalization path that closes the conversation/run, persists verified
  resource effects, reduces workstream context, and creates at most one context
  commit.
- Reusable read context organized as inventory, discovery, evidence, and
  actions, reset only after a newly created workstream-context commit.
- Filesystem metadata, batch reads and writes, focused processes, Python,
  SQLite, document extraction, dataset analysis, generated artifacts, memory,
  recall, UI workspace control, and Pulse tools.
- Personal memory, episodic recall, managed uploads, and session attachments.
- WebSocket terminal chat, HTTP upload/artifact/Pulse APIs, and system-event
  processing.
- Passive, opt-in real-daemon evaluation with schema-versioned evidence,
  deterministic diagnostics, and per-turn/session Markdown and JSON reports.
- Preview-first archive/reset and context-catalog rebuild commands.

Intended future capabilities include more clients, stronger service
installation, finer permissions, additional external integrations, richer
proactive assistance, and domain-specific resource verification.

The durable-work contract and current boundaries are documented in
[Workstreams and Resources](../engineering/architecture/workstreams-and-resources.md).
