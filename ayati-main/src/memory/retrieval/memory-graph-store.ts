import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type {
  MemoryEdgeRecord,
  MemoryGraphExpansion,
  MemoryJobRecord,
  MemoryNodeRecord,
  RecallRelatedNode,
} from "./types.js";

const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(thisDir, "..", "..", "..");
const DEFAULT_RETRIEVAL_DIR = resolve(projectRoot, "data", "memory", "retrieval");
const DEFAULT_SESSION_DIR = resolve(projectRoot, "data", "memory");

export interface MemoryGraphStoreOptions {
  dataDir?: string;
  dbPath?: string;
  sessionDataDir?: string;
}

export class MemoryGraphStore {
  private readonly dbPath: string;
  private readonly sessionDataDir: string;
  private db: DatabaseSync | null = null;

  constructor(options?: MemoryGraphStoreOptions) {
    const dataDir = options?.dataDir ?? DEFAULT_RETRIEVAL_DIR;
    this.dbPath = options?.dbPath ?? resolve(dataDir, "recall.sqlite");
    this.sessionDataDir = options?.sessionDataDir ?? DEFAULT_SESSION_DIR;
  }

  start(): void {
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec("PRAGMA synchronous=NORMAL;");
    this.createSchema();
    this.db.prepare(`
      UPDATE memory_jobs
      SET status = 'pending', updated_at = ?
      WHERE status = 'running'
    `).run(new Date().toISOString());
  }

  stop(): void {
    this.db?.close();
    this.db = null;
  }

  resolveSessionFilePath(sessionPath: string): string {
    return resolve(this.sessionDataDir, sessionPath.replace(/\\/g, "/"));
  }

  enqueueJob(jobType: MemoryJobRecord["jobType"], clientId: string, payload: unknown, createdAt: string): string {
    const db = this.requireDb();
    const jobId = randomUUID();
    db.prepare(`
      INSERT INTO memory_jobs (
        job_id,
        job_type,
        client_id,
        payload_json,
        status,
        attempts,
        created_at,
        updated_at,
        last_error
      ) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, NULL)
    `).run(jobId, jobType, clientId, JSON.stringify(payload), createdAt, createdAt);
    return jobId;
  }

  claimNextJob(): MemoryJobRecord | null {
    const db = this.requireDb();
    db.exec("BEGIN IMMEDIATE");
    try {
      const row = db.prepare(`
        SELECT job_id, job_type, client_id, payload_json, status, attempts, created_at, updated_at, last_error
        FROM memory_jobs
        WHERE status = 'pending'
        ORDER BY created_at ASC
        LIMIT 1
      `).get() as Record<string, unknown> | undefined;

      if (!row) {
        db.exec("COMMIT");
        return null;
      }

      const updatedAt = new Date().toISOString();
      db.prepare(`
        UPDATE memory_jobs
        SET status = 'running', attempts = attempts + 1, updated_at = ?
        WHERE job_id = ?
      `).run(updatedAt, String(row["job_id"]));
      db.exec("COMMIT");

      return normalizeJobRow({ ...row, status: "running", updated_at: updatedAt, attempts: Number(row["attempts"] ?? 0) + 1 });
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  hasPendingJobs(): boolean {
    const db = this.requireDb();
    const row = db.prepare(`
      SELECT 1 AS has_pending
      FROM memory_jobs
      WHERE status = 'pending'
      LIMIT 1
    `).get() as { has_pending?: number } | undefined;
    return Number(row?.has_pending ?? 0) === 1;
  }

  markJobDone(jobId: string): void {
    const db = this.requireDb();
    db.prepare(`
      UPDATE memory_jobs
      SET status = 'done', updated_at = ?, last_error = NULL
      WHERE job_id = ?
    `).run(new Date().toISOString(), jobId);
  }

  markJobFailed(jobId: string, errorMessage: string): void {
    const db = this.requireDb();
    const attemptsRow = db.prepare(`SELECT attempts FROM memory_jobs WHERE job_id = ?`).get(jobId) as { attempts?: number } | undefined;
    const attempts = Number(attemptsRow?.attempts ?? 0);
    const nextStatus = attempts >= 3 ? "failed" : "pending";
    db.prepare(`
      UPDATE memory_jobs
      SET status = ?, updated_at = ?, last_error = ?
      WHERE job_id = ?
    `).run(nextStatus, new Date().toISOString(), errorMessage.slice(0, 500), jobId);
  }

  upsertNode(node: MemoryNodeRecord): void {
    const db = this.requireDb();
    db.prepare(`
      INSERT INTO memory_nodes (
        node_id,
        client_id,
        node_type,
        source_type,
        session_id,
        session_path,
        session_file_path,
        run_id,
        run_path,
        run_state_path,
        created_at,
        status,
        summary_text,
        retrieval_text,
        user_message,
        assistant_response,
        metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(node_id) DO UPDATE SET
        client_id = excluded.client_id,
        node_type = excluded.node_type,
        source_type = excluded.source_type,
        session_id = excluded.session_id,
        session_path = excluded.session_path,
        session_file_path = excluded.session_file_path,
        run_id = excluded.run_id,
        run_path = excluded.run_path,
        run_state_path = excluded.run_state_path,
        created_at = excluded.created_at,
        status = excluded.status,
        summary_text = excluded.summary_text,
        retrieval_text = excluded.retrieval_text,
        user_message = excluded.user_message,
        assistant_response = excluded.assistant_response,
        metadata_json = excluded.metadata_json
    `).run(
      node.nodeId,
      node.clientId,
      node.nodeType,
      node.sourceType ?? null,
      node.sessionId ?? null,
      node.sessionPath ?? null,
      node.sessionFilePath ?? null,
      node.runId ?? null,
      node.runPath ?? null,
      node.runStatePath ?? null,
      node.createdAt,
      node.status ?? null,
      node.summaryText,
      node.retrievalText ?? null,
      node.userMessage ?? null,
      node.assistantResponse ?? null,
      node.metadataJson ?? null,
    );
  }

  upsertEdges(edges: MemoryEdgeRecord[]): void {
    if (edges.length === 0) {
      return;
    }
    const db = this.requireDb();
    const insert = db.prepare(`
      INSERT INTO memory_edges (
        edge_id,
        client_id,
        from_node_id,
        edge_type,
        to_node_id,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(edge_id) DO UPDATE SET
        client_id = excluded.client_id,
        from_node_id = excluded.from_node_id,
        edge_type = excluded.edge_type,
        to_node_id = excluded.to_node_id,
        created_at = excluded.created_at
    `);

    db.exec("BEGIN IMMEDIATE");
    try {
      for (const edge of edges) {
        insert.run(edge.edgeId, edge.clientId, edge.fromNodeId, edge.edgeType, edge.toNodeId, edge.createdAt);
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  getSessionNodeId(sessionId: string): string {
    return `session:${sessionId}`;
  }

  getLatestRunNode(sessionId: string, beforeCreatedAt?: string, excludeNodeId?: string): MemoryNodeRecord | null {
    const db = this.requireDb();
    const clauses = ["node_type = 'run'", "session_id = ?"];
    const params: Array<string | null> = [sessionId];
    if (beforeCreatedAt) {
      clauses.push("created_at < ?");
      params.push(beforeCreatedAt);
    }
    if (excludeNodeId) {
      clauses.push("node_id <> ?");
      params.push(excludeNodeId);
    }

    const row = db.prepare(`
      SELECT *
      FROM memory_nodes
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT 1
    `).get(...params) as Record<string, unknown> | undefined;
    return normalizeNodeRow(row);
  }

  expand(nodeIds: string[], clientId: string, limitPerNode = 4): MemoryGraphExpansion {
    const db = this.requireDb();
    const stmt = db.prepare(`
      SELECT
        e.edge_type,
        e.from_node_id,
        e.to_node_id,
        n.node_id,
        n.node_type,
        n.source_type,
        n.session_id,
        n.session_path,
        n.session_file_path,
        n.run_id,
        n.run_path,
        n.run_state_path,
        n.created_at,
        n.status,
        n.summary_text
      FROM memory_edges e
      JOIN memory_nodes n
        ON n.node_id = CASE WHEN e.from_node_id = ? THEN e.to_node_id ELSE e.from_node_id END
      WHERE e.client_id = ?
        AND (e.from_node_id = ? OR e.to_node_id = ?)
      ORDER BY n.created_at DESC
      LIMIT ?
    `);

    const expansion: MemoryGraphExpansion = {};
    for (const nodeId of nodeIds) {
      const rows = stmt.all(nodeId, clientId, nodeId, nodeId, limitPerNode) as Record<string, unknown>[];
      expansion[nodeId] = rows
        .map((row) => normalizeRelatedNodeRow(row))
        .filter((row): row is RecallRelatedNode => row !== null);
    }
    return expansion;
  }

  private createSchema(): void {
    const db = this.requireDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_jobs (
        job_id TEXT PRIMARY KEY,
        job_type TEXT NOT NULL,
        client_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_error TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_memory_jobs_status_created
        ON memory_jobs(status, created_at);

      CREATE TABLE IF NOT EXISTS memory_nodes (
        node_id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        node_type TEXT NOT NULL,
        source_type TEXT,
        session_id TEXT,
        session_path TEXT,
        session_file_path TEXT,
        run_id TEXT,
        run_path TEXT,
        run_state_path TEXT,
        created_at TEXT NOT NULL,
        status TEXT,
        summary_text TEXT NOT NULL,
        retrieval_text TEXT,
        user_message TEXT,
        assistant_response TEXT,
        metadata_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_memory_nodes_client_created
        ON memory_nodes(client_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_nodes_session_created
        ON memory_nodes(session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_nodes_run
        ON memory_nodes(run_id);

      CREATE TABLE IF NOT EXISTS memory_edges (
        edge_id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        from_node_id TEXT NOT NULL,
        edge_type TEXT NOT NULL,
        to_node_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memory_edges_from
        ON memory_edges(from_node_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_edges_to
        ON memory_edges(to_node_id, created_at DESC);
    `);
  }

  private requireDb(): DatabaseSync {
    if (!this.db) {
      throw new Error("MemoryGraphStore has not been started.");
    }
    return this.db;
  }
}

function normalizeJobRow(row: Record<string, unknown> | undefined): MemoryJobRecord | null {
  if (!row) {
    return null;
  }

  return {
    jobId: String(row["job_id"] ?? ""),
    jobType: row["job_type"] === "index_handoff" ? "index_handoff" : "index_run",
    clientId: String(row["client_id"] ?? ""),
    payloadJson: String(row["payload_json"] ?? "{}"),
    status: normalizeJobStatus(row["status"]),
    attempts: Number(row["attempts"] ?? 0),
    createdAt: String(row["created_at"] ?? ""),
    updatedAt: String(row["updated_at"] ?? ""),
    lastError: typeof row["last_error"] === "string" ? row["last_error"] : null,
  };
}

function normalizeJobStatus(value: unknown): MemoryJobRecord["status"] {
  if (value === "running" || value === "done" || value === "failed") {
    return value;
  }
  return "pending";
}

function normalizeNodeRow(row: Record<string, unknown> | undefined): MemoryNodeRecord | null {
  if (!row) {
    return null;
  }

  return {
    nodeId: String(row["node_id"] ?? ""),
    clientId: String(row["client_id"] ?? ""),
    nodeType: normalizeNodeType(row["node_type"]),
    sourceType: normalizeSourceType(row["source_type"]),
    sessionId: nullableString(row["session_id"]),
    sessionPath: nullableString(row["session_path"]),
    sessionFilePath: nullableString(row["session_file_path"]),
    runId: nullableString(row["run_id"]),
    runPath: nullableString(row["run_path"]),
    runStatePath: nullableString(row["run_state_path"]),
    createdAt: String(row["created_at"] ?? ""),
    status: normalizeRunStatus(row["status"]),
    summaryText: String(row["summary_text"] ?? ""),
    retrievalText: nullableString(row["retrieval_text"]),
    userMessage: nullableString(row["user_message"]),
    assistantResponse: nullableString(row["assistant_response"]),
    metadataJson: nullableString(row["metadata_json"]),
  };
}

function normalizeRelatedNodeRow(row: Record<string, unknown>): RecallRelatedNode | null {
  const node = normalizeNodeRow({
    node_id: row["node_id"],
    client_id: "",
    node_type: row["node_type"],
    source_type: row["source_type"],
    session_id: row["session_id"],
    session_path: row["session_path"],
    session_file_path: row["session_file_path"],
    run_id: row["run_id"],
    run_path: row["run_path"],
    run_state_path: row["run_state_path"],
    created_at: row["created_at"],
    status: row["status"],
    summary_text: row["summary_text"],
    retrieval_text: null,
    user_message: null,
    assistant_response: null,
    metadata_json: null,
  });

  if (!node) {
    return null;
  }

  return {
    nodeId: node.nodeId,
    nodeType: node.nodeType,
    relation: normalizeEdgeType(row["edge_type"]),
    sourceType: node.sourceType,
    sessionId: node.sessionId,
    sessionPath: node.sessionPath,
    sessionFilePath: node.sessionFilePath,
    runId: node.runId,
    runPath: node.runPath,
    runStatePath: node.runStatePath,
    createdAt: node.createdAt,
    status: node.status,
    summaryText: node.summaryText,
  };
}

function normalizeNodeType(value: unknown): MemoryNodeRecord["nodeType"] {
  if (value === "run" || value === "handoff") {
    return value;
  }
  return "session";
}

function normalizeSourceType(value: unknown): MemoryNodeRecord["sourceType"] {
  if (value === "run" || value === "handoff") {
    return value;
  }
  return undefined;
}

function normalizeRunStatus(value: unknown): MemoryNodeRecord["status"] {
  if (value === "completed" || value === "failed" || value === "stuck") {
    return value;
  }
  return undefined;
}

function normalizeEdgeType(value: unknown): RecallRelatedNode["relation"] {
  switch (value) {
    case "session_contains_run":
    case "session_has_handoff":
    case "session_rotates_to_session":
    case "run_followed_by_run":
    case "run_precedes_handoff":
    case "handoff_opens_session":
      return value;
    default:
      return "session_contains_run";
  }
}

function nullableString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
