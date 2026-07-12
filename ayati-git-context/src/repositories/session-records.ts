import type { ContextDatabase } from "../database/database.js";
import type { SessionRef } from "../contracts.js";

interface SessionRow {
  session_id: string;
  repository_path: string;
  head_sha: string | null;
  date: string;
  timezone: string;
  status: SessionRef["status"];
  agent_id: string;
  previous_session_id: string | null;
  created_at: string;
  sealed_at: string | null;
}

export function readSession(database: ContextDatabase, sessionId: string): SessionRef | undefined {
  const row = database.prepare([
    "SELECT session_id, repository_path, head_sha, date, timezone, status,",
    "agent_id, previous_session_id, created_at, sealed_at",
    "FROM sessions WHERE session_id = ?",
  ].join(" ")).get(sessionId) as SessionRow | undefined;
  return row ? sessionRef(row) : undefined;
}

export function readLiveSessionForAgent(
  database: ContextDatabase,
  agentId: string,
): SessionRef | undefined {
  const row = database.prepare([
    "SELECT session_id, repository_path, head_sha, date, timezone, status,",
    "agent_id, previous_session_id, created_at, sealed_at",
    "FROM sessions",
    "WHERE agent_id = ? AND status IN ('open', 'rollover_pending', 'finalizing')",
    "ORDER BY created_at DESC LIMIT 1",
  ].join(" ")).get(agentId) as SessionRow | undefined;
  return row ? sessionRef(row) : undefined;
}

export function readLatestLiveSession(database: ContextDatabase): SessionRef | undefined {
  const row = database.prepare([
    "SELECT session_id, repository_path, head_sha, date, timezone, status,",
    "agent_id, previous_session_id, created_at, sealed_at",
    "FROM sessions",
    "WHERE status IN ('open', 'rollover_pending', 'finalizing')",
    "ORDER BY created_at DESC LIMIT 1",
  ].join(" ")).get() as SessionRow | undefined;
  return row ? sessionRef(row) : undefined;
}

export function readLatestSealedSessionId(
  database: ContextDatabase,
  agentId: string,
): string | undefined {
  const row = database.prepare([
    "SELECT session_id FROM sessions",
    "WHERE agent_id = ? AND status = 'sealed'",
    "ORDER BY sealed_at DESC, created_at DESC LIMIT 1",
  ].join(" ")).get(agentId) as { session_id: string } | undefined;
  return row?.session_id;
}

export function insertSession(database: ContextDatabase, input: {
  sessionId: string;
  date: string;
  timezone: string;
  agentId: string;
  repositoryPath: string;
  previousSessionId?: string;
  createdAt: string;
}): SessionRef {
  database.prepare([
    "INSERT INTO sessions(",
    "session_id, date, timezone, agent_id, repository_path, head_sha, status,",
    "previous_session_id, created_at, sealed_at",
    ") VALUES (?, ?, ?, ?, ?, NULL, 'open', ?, ?, NULL)",
  ].join(" ")).run(
    input.sessionId,
    input.date,
    input.timezone,
    input.agentId,
    input.repositoryPath,
    input.previousSessionId ?? null,
    input.createdAt,
  );
  const session = readSession(database, input.sessionId);
  if (!session) {
    throw new Error("Inserted session could not be read: " + input.sessionId);
  }
  return session;
}

function sessionRef(row: SessionRow): SessionRef {
  return {
    sessionId: row.session_id,
    repositoryPath: row.repository_path,
    head: row.head_sha,
    date: row.date,
    timezone: row.timezone,
    status: row.status,
  };
}
