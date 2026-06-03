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
