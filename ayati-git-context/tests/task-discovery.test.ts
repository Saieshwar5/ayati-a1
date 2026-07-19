import { afterEach, describe, expect, it } from "vitest";
import { ContextDatabase } from "../src/database/database.js";
import { TaskDiscoveryService } from "../src/services/task-discovery-service.js";

const databases: ContextDatabase[] = [];
const NOW = "2026-07-19T12:00:00.000Z";

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("autonomous task discovery", () => {
  it("ranks exact resource ownership ahead of activity signals", async () => {
    const fixture = await createFixture();
    fixture.database.prepare([
      "INSERT INTO task_preferences(task_id, starred, starred_at, updated_at)",
      "VALUES (?, 1, ?, ?)",
    ].join(" ")).run(fixture.researchTaskId, NOW, NOW);
    fixture.database.prepare([
      "INSERT INTO task_accesses(task_id, run_id, access_kind, accessed_at)",
      "VALUES (?, ?, 'bound', ?)",
    ].join(" ")).run(
      fixture.researchTaskId,
      fixture.previousRunId,
      "2026-07-19T11:59:00.000Z",
    );

    const found = fixture.discovery.find({
      paths: [fixture.codingPath + "/src/app.ts"],
      limit: 10,
    });

    expect(found.tasks[0]).toMatchObject({
      taskId: fixture.codingTaskId,
      discovery: {
        tier: "definite",
        reasons: expect.arrayContaining(["owned_path"]),
      },
    });
    expect(found.tasks.find((task) => task.taskId === fixture.researchTaskId))
      .toMatchObject({ starred: true, boundRunsLast30Days: 1 });
  });

  it("searches all indexed work and explains deterministic reasons", async () => {
    const fixture = await createFixture();

    const found = fixture.discovery.find({ query: "solar panel analysis", limit: 10 });

    expect(found.tasks).toHaveLength(1);
    expect(found.tasks[0]).toMatchObject({
      taskId: fixture.researchTaskId,
      discovery: {
        tier: "probable",
        reasons: expect.arrayContaining(["text_match", "matching_request"]),
      },
    });
  });

  it("treats referential continuation as strong but does not bind the new run", async () => {
    const fixture = await createFixture();

    const found = fixture.discovery.find({
      sessionId: fixture.sessionId,
      currentText: "Continue where we left off on that work.",
      limit: 20,
    });

    expect(found.tasks[0]).toMatchObject({
      taskId: fixture.codingTaskId,
      discovery: {
        tier: "definite",
        reasons: expect.arrayContaining(["direct_continuation"]),
      },
    });
    expect(fixture.database.prepare(
      "SELECT task_id FROM runs WHERE run_id = ?",
    ).get(fixture.activeRunId)).toEqual({ task_id: null });
  });

  it("recognizes an embedded exact identity and continuation across daily sessions", async () => {
    const fixture = await createFixture();
    fixture.database.prepare(
      "UPDATE sessions SET status = 'sealed', sealed_at = ? WHERE session_id = ?",
    ).run(NOW, fixture.sessionId);
    const nextSessionId = "S-20260720-local";
    fixture.database.prepare([
      "INSERT INTO sessions(session_id, date, timezone, agent_id, repository_path,",
      "head_sha, status, created_at) VALUES (?, '2026-07-20', 'UTC', 'local',",
      "'/session-next', NULL, 'open', ?)",
    ].join(" ")).run(nextSessionId, NOW);

    const byIdentity = fixture.discovery.find({
      currentText: `Please continue ${fixture.researchTaskId} today.`,
      sessionId: nextSessionId,
      limit: 10,
    });
    const byReference = fixture.discovery.find({
      currentText: "Continue where we left off.",
      sessionId: nextSessionId,
      limit: 10,
    });
    const byTitle = fixture.discovery.find({
      currentText: "Continue Home Solar Research.",
      sessionId: nextSessionId,
      limit: 10,
    });

    expect(byIdentity.tasks[0]).toMatchObject({
      taskId: fixture.researchTaskId,
      discovery: { tier: "definite", reasons: expect.arrayContaining(["exact_task_id"]) },
    });
    expect(byReference.tasks[0]).toMatchObject({
      taskId: fixture.codingTaskId,
      discovery: { tier: "definite", reasons: expect.arrayContaining(["direct_continuation"]) },
    });
    expect(byTitle.tasks[0]).toMatchObject({
      taskId: fixture.researchTaskId,
      discovery: { tier: "definite", reasons: expect.arrayContaining(["exact_title"]) },
    });
  });

  it("changes stars idempotently while search results never count as access", async () => {
    const fixture = await createFixture();
    const request = {
      requestId: "REQ-star-research",
      sessionId: fixture.sessionId,
      runId: fixture.activeRunId,
      taskId: fixture.researchTaskId,
      starred: true,
      at: NOW,
    } as const;

    const first = fixture.discovery.setStar(request);
    const replay = fixture.discovery.setStar(request);
    fixture.discovery.find({ view: "starred" });
    fixture.discovery.find({ query: "solar" });

    expect(replay).toEqual(first);
    expect(first).toEqual({
      taskId: fixture.researchTaskId,
      starred: true,
      starredAt: NOW,
    });
    expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM task_accesses").get())
      .toEqual({ count: 0 });
  });
});

async function createFixture(): Promise<{
  database: ContextDatabase;
  discovery: TaskDiscoveryService;
  sessionId: string;
  previousRunId: string;
  activeRunId: string;
  codingTaskId: string;
  researchTaskId: string;
  codingPath: string;
}> {
  const database = await ContextDatabase.open({ path: ":memory:", now: () => NOW });
  databases.push(database);
  const sessionId = "S-20260719-local";
  const previousRunId = "R-20260719-0001";
  const activeRunId = "R-20260719-0002";
  const codingTaskId = "T-20260719-0001";
  const researchTaskId = "T-20260719-0002";
  const codingPath = "/trusted/coffee-site";
  database.prepare([
    "INSERT INTO sessions(session_id, date, timezone, agent_id, repository_path,",
    "head_sha, status, created_at) VALUES (?, '2026-07-19', 'UTC', 'local',",
    "'/session', NULL, 'open', ?)",
  ].join(" ")).run(sessionId, NOW);
  insertTask(database, {
    taskId: codingTaskId,
    path: codingPath,
    title: "Coffee Website",
    objective: "Build and maintain the coffee shop website.",
    requestTitle: "Implement checkout",
    updatedAt: "2026-07-18T12:00:00.000Z",
    sessionId,
  });
  insertTask(database, {
    taskId: researchTaskId,
    path: "/trusted/solar-research",
    title: "Home Solar Research",
    objective: "Research solar panels and compare installation options.",
    requestTitle: "Solar panel analysis",
    updatedAt: "2026-07-19T10:00:00.000Z",
    sessionId,
  });
  database.prepare([
    "INSERT INTO conversation_segments(conversation_id, session_id, sequence, file_path,",
    "task_id, run_id, status, started_at, closed_at)",
    "VALUES ('C-1', ?, 1, 'c1.md', ?, ?, 'closed', ?, ?)",
  ].join(" ")).run(sessionId, codingTaskId, previousRunId, NOW, NOW);
  database.prepare([
    "INSERT INTO runs(run_id, session_id, conversation_id, task_id, task_request_id,",
    "task_bound_at, run_sequence, status, stop_reason, trigger, step_count, started_at, completed_at)",
    "VALUES (?, ?, 'C-1', ?, 'R-0001', ?, 1, 'done', 'completed', 'user', 0, ?, ?)",
  ].join(" ")).run(previousRunId, sessionId, codingTaskId, NOW, NOW, NOW);
  database.prepare([
    "INSERT INTO conversation_segments(conversation_id, session_id, sequence, file_path,",
    "task_id, run_id, status, started_at)",
    "VALUES ('C-2', ?, 2, 'c2.md', NULL, ?, 'active', ?)",
  ].join(" ")).run(sessionId, activeRunId, NOW);
  database.prepare([
    "INSERT INTO runs(run_id, session_id, conversation_id, run_sequence, status, trigger,",
    "step_count, started_at) VALUES (?, ?, 'C-2', 2, 'running', 'user', 0, ?)",
  ].join(" ")).run(activeRunId, sessionId, NOW);
  return {
    database,
    discovery: new TaskDiscoveryService(database, () => NOW),
    sessionId,
    previousRunId,
    activeRunId,
    codingTaskId,
    researchTaskId,
    codingPath,
  };
}

function insertTask(database: ContextDatabase, input: {
  taskId: string;
  path: string;
  title: string;
  objective: string;
  requestTitle: string;
  updatedAt: string;
  sessionId: string;
}): void {
  database.prepare([
    "INSERT INTO tasks(task_id, repository_path, branch, head_sha, title_cache,",
    "objective_cache, placement_mode, lifecycle_status, repository_health,",
    "current_request_id, current_request_title, current_request_status, status,",
    "created_session_id, created_at, updated_at)",
    "VALUES (?, ?, 'main', ?, ?, ?, 'managed', 'active', 'ready',",
    "'R-0001', ?, 'active', 'active', ?, ?, ?)",
  ].join(" ")).run(
    input.taskId,
    input.path,
    input.taskId.endsWith("0001") ? "a".repeat(40) : "b".repeat(40),
    input.title,
    input.objective,
    input.requestTitle,
    input.sessionId,
    input.updatedAt,
    input.updatedAt,
  );
  database.prepare([
    "INSERT INTO task_search(task_id, title, objective, current_request, repository_path)",
    "VALUES (?, ?, ?, ?, ?)",
  ].join(" ")).run(
    input.taskId,
    input.title,
    input.objective,
    input.requestTitle,
    input.path,
  );
}
