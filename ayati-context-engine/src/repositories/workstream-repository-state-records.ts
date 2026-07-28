import type { ContextDatabase } from "../database/database.js";

export type SharedWorkstreamRepositoryHealth =
  | "ready"
  | "dirty_external"
  | "recovery_required"
  | "unavailable";

export interface SharedWorkstreamRepositoryState {
  repositoryPath: string;
  branch: "main";
  head: string;
  health: SharedWorkstreamRepositoryHealth;
  updatedAt: string;
}

interface Row {
  repository_path: string;
  branch: "main";
  head_sha: string;
  repository_health: SharedWorkstreamRepositoryHealth;
  updated_at: string;
}

export function readSharedWorkstreamRepositoryState(
  database: ContextDatabase,
): SharedWorkstreamRepositoryState | undefined {
  const row = database.prepare([
    "SELECT repository_path, branch, head_sha, repository_health, updated_at",
    "FROM workstream_repository_state WHERE singleton_id = 1",
  ].join(" ")).get() as Row | undefined;
  return row ? fromRow(row) : undefined;
}

export function initializeSharedWorkstreamRepositoryState(
  database: ContextDatabase,
  input: SharedWorkstreamRepositoryState,
): SharedWorkstreamRepositoryState {
  database.prepare([
    "INSERT INTO workstream_repository_state(",
    "singleton_id, repository_path, branch, head_sha, repository_health, updated_at",
    ") VALUES (1, ?, ?, ?, ?, ?)",
    "ON CONFLICT(singleton_id) DO NOTHING",
  ].join(" ")).run(
    input.repositoryPath,
    input.branch,
    input.head,
    input.health,
    input.updatedAt,
  );
  const state = readSharedWorkstreamRepositoryState(database);
  if (!state) throw new Error("Shared workstream repository state was not initialized.");
  return state;
}

export function updateSharedWorkstreamRepositoryState(
  database: ContextDatabase,
  input: {
    expectedHead?: string;
    head: string;
    health: SharedWorkstreamRepositoryHealth;
    at: string;
  },
): SharedWorkstreamRepositoryState {
  const result = input.expectedHead
    ? database.prepare([
        "UPDATE workstream_repository_state",
        "SET head_sha = ?, repository_health = ?, updated_at = ?",
        "WHERE singleton_id = 1 AND head_sha = ?",
      ].join(" ")).run(input.head, input.health, input.at, input.expectedHead)
    : database.prepare([
        "UPDATE workstream_repository_state",
        "SET head_sha = ?, repository_health = ?, updated_at = ?",
        "WHERE singleton_id = 1",
      ].join(" ")).run(input.head, input.health, input.at);
  if (Number(result.changes) !== 1) {
    throw new Error("Shared workstream repository HEAD changed while acknowledging state.");
  }
  const state = readSharedWorkstreamRepositoryState(database);
  if (!state) throw new Error("Shared workstream repository state is unavailable.");
  return state;
}

export function markSharedWorkstreamRepositoryHealth(
  database: ContextDatabase,
  health: SharedWorkstreamRepositoryHealth,
  at: string,
): void {
  database.prepare([
    "UPDATE workstream_repository_state SET repository_health = ?, updated_at = ?",
    "WHERE singleton_id = 1",
  ].join(" ")).run(health, at);
}

function fromRow(row: Row): SharedWorkstreamRepositoryState {
  return {
    repositoryPath: row.repository_path,
    branch: "main",
    head: row.head_sha,
    health: row.repository_health,
    updatedAt: row.updated_at,
  };
}
