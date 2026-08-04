# Database Overview

Ayati uses SQLite for agent-accessible database tooling and runtime stores where appropriate.

The built-in SQLite tool runtime is implemented in:

- `ayati-main/src/database/sqlite-runtime.ts`
- `ayati-main/src/skills/builtins/database/index.ts`

Default database path for the database tool:

- `ayati-main/data/sqlite/agent.sqlite`

Supported database tool operations include:

- List tables.
- Describe table schema, indexes, foreign keys, and sample rows.
- Create, rename, and drop tables.
- Add columns.
- Insert, update, and delete rows.
- Query tables.
- Execute SQL.

Runtime memory, documents, files, vectors, queues, runs, and plugin state are also stored under `ayati-main/data/`, but they are runtime state rather than source-controlled database schema.

## Context Engine Database

Context Engine has a separate SQLite database, normally at
`<AYATI_ROOT_DIR>/.ayati/context.db`. It is owned exclusively by the in-process
`ayati-context-engine` host and is not the database targeted by ordinary agent
SQLite tools.

It stores operational indexes and lifecycle state such as agent streams,
immutable messages, runs and steps, WorkState, conversation-continuity
checkpoints,
workstreams, every request, compact progress projections, shared-repository
state, resource mutation authority, finalization records, and idempotency
data. The current harness binds through atomic workstream/request lifecycle
operations and does not create a private resolver journal. The typed service
interface is the only supported write path.

Storage responsibilities are intentionally split:

- one shared workstream Git repository: portable, inspectable durable work
  context and append-only progress;
- Context Engine SQLite: catalog, coordination, idempotency, and detailed run
  journal;
- live evaluation evidence: operator diagnostics;
- personal/episodic stores: cross-task user memory and semantic recall.

Do not place raw run transcripts in context Git merely because they exist in
SQLite. Conversely, do not treat the catalog as a replacement for repository
history. Workstream, request, progress, resource, and search projections are
rebuildable from the validated repository, but exact messages, run/tool
journals, preferences, and pending recovery state exist only in SQLite.
Backups therefore need both SQLite and the shared repository.
