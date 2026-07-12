import type { DatabaseSync } from "node:sqlite";

interface Migration {
  version: number;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: [
      "CREATE TABLE schema_migrations (",
      "  version INTEGER PRIMARY KEY,",
      "  applied_at TEXT NOT NULL",
      ");",
      "",
      "CREATE TABLE idempotency_requests (",
      "  request_id TEXT PRIMARY KEY,",
      "  operation TEXT NOT NULL,",
      "  request_hash TEXT NOT NULL,",
      "  status TEXT NOT NULL CHECK (status IN ('completed')),",
      "  response_json TEXT NOT NULL,",
      "  created_at TEXT NOT NULL,",
      "  completed_at TEXT NOT NULL",
      ");",
      "",
      "CREATE TABLE sessions (",
      "  session_id TEXT PRIMARY KEY,",
      "  date TEXT NOT NULL,",
      "  timezone TEXT NOT NULL,",
      "  agent_id TEXT NOT NULL,",
      "  repository_path TEXT NOT NULL,",
      "  head_sha TEXT,",
      "  status TEXT NOT NULL CHECK (status IN ('open', 'rollover_pending', 'finalizing', 'sealed')),",
      "  previous_session_id TEXT REFERENCES sessions(session_id),",
      "  created_at TEXT NOT NULL,",
      "  sealed_at TEXT",
      ");",
      "",
      "CREATE UNIQUE INDEX sessions_one_live_per_agent",
      "ON sessions(agent_id)",
      "WHERE status IN ('open', 'rollover_pending', 'finalizing');",
      "",
      "CREATE TABLE conversation_segments (",
      "  conversation_id TEXT PRIMARY KEY,",
      "  session_id TEXT NOT NULL REFERENCES sessions(session_id),",
      "  sequence INTEGER NOT NULL,",
      "  file_path TEXT NOT NULL,",
      "  task_id TEXT,",
      "  run_id TEXT,",
      "  status TEXT NOT NULL CHECK (status IN ('active', 'closed', 'committed')),",
      "  content_hash TEXT,",
      "  committed_sha TEXT,",
      "  started_at TEXT NOT NULL,",
      "  closed_at TEXT,",
      "  UNIQUE(session_id, sequence)",
      ");",
      "",
      "CREATE TABLE messages (",
      "  message_id TEXT PRIMARY KEY,",
      "  conversation_id TEXT NOT NULL REFERENCES conversation_segments(conversation_id),",
      "  session_id TEXT NOT NULL REFERENCES sessions(session_id),",
      "  session_sequence INTEGER NOT NULL,",
      "  segment_sequence INTEGER NOT NULL,",
      "  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system_event')),",
      "  content TEXT NOT NULL,",
      "  created_at TEXT NOT NULL,",
      "  UNIQUE(session_id, session_sequence),",
      "  UNIQUE(conversation_id, segment_sequence)",
      ");",
      "",
      "CREATE TABLE runs (",
      "  run_id TEXT PRIMARY KEY,",
      "  session_id TEXT NOT NULL REFERENCES sessions(session_id),",
      "  conversation_id TEXT NOT NULL REFERENCES conversation_segments(conversation_id),",
      "  task_id TEXT,",
      "  run_sequence INTEGER NOT NULL,",
      "  run_class TEXT NOT NULL CHECK (run_class IN ('session', 'task')),",
      "  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'blocked', 'needs_user_input')),",
      "  trigger TEXT NOT NULL CHECK (trigger IN ('user', 'system_event', 'internal')),",
      "  started_at TEXT NOT NULL,",
      "  completed_at TEXT,",
      "  UNIQUE(session_id, run_sequence)",
      ");",
      "",
      "CREATE UNIQUE INDEX runs_one_active_per_session",
      "ON runs(session_id)",
      "WHERE status = 'running';",
      "",
      "CREATE TABLE run_steps (",
      "  run_id TEXT NOT NULL REFERENCES runs(run_id),",
      "  step INTEGER NOT NULL,",
      "  tool TEXT NOT NULL,",
      "  purpose TEXT NOT NULL,",
      "  status TEXT NOT NULL CHECK (status IN ('completed', 'failed', 'blocked')),",
      "  bounded_input TEXT,",
      "  bounded_output TEXT,",
      "  output_hash TEXT,",
      "  verification TEXT,",
      "  work_state TEXT,",
      "  created_at TEXT NOT NULL,",
      "  PRIMARY KEY(run_id, step)",
      ");",
      "",
      "CREATE TABLE pending_transactions (",
      "  transaction_id TEXT PRIMARY KEY,",
      "  run_id TEXT NOT NULL REFERENCES runs(run_id),",
      "  phase TEXT NOT NULL,",
      "  session_head_before TEXT,",
      "  task_head_before TEXT,",
      "  task_head_after TEXT,",
      "  conversation_id TEXT NOT NULL REFERENCES conversation_segments(conversation_id),",
      "  conversation_hash TEXT,",
      "  updated_at TEXT NOT NULL",
      ");",
    ].join("\n"),
  },
  {
    version: 2,
    sql: [
      "ALTER TABLE idempotency_requests RENAME TO idempotency_requests_v1;",
      "",
      "CREATE TABLE idempotency_requests (",
      "  request_id TEXT PRIMARY KEY,",
      "  operation TEXT NOT NULL,",
      "  request_hash TEXT NOT NULL,",
      "  status TEXT NOT NULL CHECK (status IN ('in_progress', 'completed', 'recovery_required')),",
      "  response_json TEXT NOT NULL,",
      "  created_at TEXT NOT NULL,",
      "  completed_at TEXT",
      ");",
      "",
      "INSERT INTO idempotency_requests(",
      "  request_id, operation, request_hash, status, response_json, created_at, completed_at",
      ") SELECT request_id, operation, request_hash, status, response_json, created_at, completed_at",
      "FROM idempotency_requests_v1;",
      "",
      "DROP TABLE idempotency_requests_v1;",
      "",
      "CREATE TABLE file_sync_operations (",
      "  operation_id TEXT PRIMARY KEY,",
      "  request_id TEXT NOT NULL REFERENCES idempotency_requests(request_id) ON DELETE CASCADE,",
      "  session_id TEXT NOT NULL REFERENCES sessions(session_id),",
      "  conversation_id TEXT NOT NULL REFERENCES conversation_segments(conversation_id),",
      "  source_path TEXT,",
      "  target_path TEXT NOT NULL,",
      "  expected_content_hash TEXT,",
      "  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),",
      "  created_at TEXT NOT NULL,",
      "  completed_at TEXT,",
      "  last_error TEXT",
      ");",
      "",
      "CREATE INDEX file_sync_operations_pending",
      "ON file_sync_operations(status, created_at);",
    ].join("\n"),
  },
  {
    version: 3,
    sql: [
      "CREATE TABLE tasks (",
      "  task_id TEXT PRIMARY KEY,",
      "  repository_path TEXT NOT NULL UNIQUE,",
      "  durable_branch TEXT NOT NULL,",
      "  head_sha TEXT,",
      "  title_cache TEXT NOT NULL,",
      "  objective_cache TEXT NOT NULL,",
      "  status TEXT NOT NULL CHECK (status IN ('initializing', 'active', 'archived')),",
      "  created_session_id TEXT NOT NULL REFERENCES sessions(session_id),",
      "  created_at TEXT NOT NULL,",
      "  updated_at TEXT NOT NULL",
      ");",
      "",
      "CREATE INDEX tasks_updated_at ON tasks(updated_at DESC);",
      "CREATE INDEX tasks_status ON tasks(status, updated_at DESC);",
    ].join("\n"),
  },
];

export function applyMigrations(database: DatabaseSync, now: () => string): void {
  database.exec([
    "CREATE TABLE IF NOT EXISTS schema_migrations (",
    "  version INTEGER PRIMARY KEY,",
    "  applied_at TEXT NOT NULL",
    ");",
  ].join("\n"));

  const appliedRows = database.prepare(
    "SELECT version FROM schema_migrations ORDER BY version",
  ).all() as Array<{ version: number }>;
  const applied = new Set(appliedRows.map((row) => Number(row.version)));

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) {
      continue;
    }
    database.exec("BEGIN IMMEDIATE");
    try {
      if (migration.version === 1) {
        database.exec("DROP TABLE schema_migrations");
      }
      database.exec(migration.sql);
      database.prepare(
        "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
      ).run(migration.version, now());
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
}

export function latestSchemaVersion(): number {
  return MIGRATIONS.at(-1)?.version ?? 0;
}
