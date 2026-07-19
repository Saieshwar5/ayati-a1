import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContextDatabase } from "../src/database/database.js";
import { insertSession } from "../src/repositories/session-records.js";
import { TaskDiscoveryService } from "../src/services/task-discovery-service.js";
import { rebuildTaskCatalog } from "../src/services/task-catalog-rebuild-service.js";
import { createSimpleTaskFixture } from "./simple-task-repository-fixtures.js";

const roots: string[] = [];
const databases: ContextDatabase[] = [];
const NOW = "2026-07-19T12:00:00.000Z";

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

describe("task catalog rebuild", () => {
  it("previews and reconstructs an empty catalog from validated Git repositories", async () => {
    const root = await mkdtemp(join(tmpdir(), "ayati-catalog-rebuild-"));
    roots.push(root);
    const workspaceRoot = join(root, "workspace");
    const taskRoot = join(workspaceRoot, "tasks");
    const fixture = await createSimpleTaskFixture({
      taskRoot,
      taskId: "T-20260719-0001",
      title: "Solar Research",
      domain: "analysis",
    });
    const database = await ContextDatabase.open({ path: join(root, "context.sqlite") });
    databases.push(database);
    insertSession(database, {
      sessionId: "S-20260719-local",
      date: "2026-07-19",
      timezone: "UTC",
      agentId: "local",
      repositoryPath: join(root, "session-data", "S-20260719-local"),
      createdAt: NOW,
    });

    const preview = await rebuildTaskCatalog({
      taskRoot,
      trustedRoots: [],
      now: NOW,
      confirm: false,
    });

    expect(preview).toMatchObject({
      repositories: [{
        taskId: fixture.taskId,
        repositoryPath: fixture.repositoryPath,
        placement: "managed",
        repositoryHealth: "ready",
      }],
      failures: [],
      applied: false,
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM tasks").get()).toEqual({ count: 0 });

    const rebuilt = await rebuildTaskCatalog({
      taskRoot,
      trustedRoots: [],
      now: NOW,
      database,
      confirm: true,
    });

    expect(rebuilt.applied).toBe(true);
    expect(database.prepare([
      "SELECT task_id, repository_path, placement_mode, lifecycle_status, repository_health",
      "FROM tasks",
    ].join(" ")).get()).toEqual({
      task_id: fixture.taskId,
      repository_path: fixture.repositoryPath,
      placement_mode: "managed",
      lifecycle_status: "active",
      repository_health: "ready",
    });
    expect(new TaskDiscoveryService(database, () => NOW).find({ query: "analysis" }).tasks[0])
      .toMatchObject({ taskId: fixture.taskId, discovery: { reasons: expect.arrayContaining(["text_match"]) } });
  });

  it("refuses to merge a rebuild into a non-empty catalog", async () => {
    const root = await mkdtemp(join(tmpdir(), "ayati-catalog-rebuild-existing-"));
    roots.push(root);
    const taskRoot = join(root, "workspace", "tasks");
    await createSimpleTaskFixture({
      taskRoot,
      taskId: "T-20260719-0001",
      title: "Existing Work",
      domain: "coding",
    });
    const database = await ContextDatabase.open({ path: join(root, "context.sqlite") });
    databases.push(database);
    insertSession(database, {
      sessionId: "S-20260719-local",
      date: "2026-07-19",
      timezone: "UTC",
      agentId: "local",
      repositoryPath: join(root, "session"),
      createdAt: NOW,
    });
    database.prepare([
      "INSERT INTO tasks(task_id, repository_path, branch, head_sha, title_cache, objective_cache,",
      "status, created_session_id, created_at, updated_at)",
      "VALUES ('T-20260719-9999', ?, 'main', 'deadbeef', 'Existing', 'Existing',",
      "'active', 'S-20260719-local', ?, ?)",
    ].join(" ")).run(join(root, "elsewhere"), NOW, NOW);

    await expect(rebuildTaskCatalog({
      taskRoot,
      trustedRoots: [],
      now: NOW,
      database,
      confirm: true,
    })).rejects.toThrow("empty task catalog");
  });
});
