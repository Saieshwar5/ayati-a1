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

## Git Context Database

Git Context has a separate SQLite database, normally at
`ayati-main/data/context-engine/context.sqlite`. It is owned exclusively by the
`ayati-git-context` server and is not the database targeted by ordinary agent
SQLite tools.

It stores operational indexes and lifecycle state such as sessions, task
catalog entries, request plans, run records, mutation authority, attachment
records, finalization records, and idempotency data. The typed protocol is the
only supported write path.

Storage responsibilities are intentionally split:

- task/session Git repositories: portable, inspectable durable context;
- Git Context SQLite: catalog, coordination, idempotency, and detailed run
  journal;
- feedback traces: operator diagnostics;
- personal/episodic stores: cross-task user memory and semantic recall.

Do not place raw run transcripts in task Git merely because they exist in
SQLite. Conversely, do not treat the catalog as a replacement for repository
history. Catalog reconstruction from repositories is still incomplete, so
backups currently need both Git Context SQLite and the repositories.
