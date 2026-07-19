import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContextDatabase } from "../src/database/database.js";
import { latestSchemaVersion } from "../src/database/schema.js";
import { SqliteGitContextService } from "../src/services/sqlite-git-context-service.js";

const roots: string[] = [];
const services: SqliteGitContextService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map(async (service) => await service.close()));
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

describe("SQLite Git Context version-5 baseline", () => {
  it("creates only the clean version-5 schema with durable SQLite settings", async () => {
    const fixture = await createFixture();

    expect(latestSchemaVersion()).toBe(5);
    expect(fixture.database.prepare(
      "SELECT version FROM schema_metadata WHERE singleton = 1",
    ).get()).toEqual({ version: 5 });
    expect((fixture.database.prepare([
      "SELECT name FROM sqlite_schema",
      "WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      "ORDER BY name",
    ].join(" ")).all() as Array<{ name: string }>).map((row) => row.name)).toEqual([
      "conversation_segments",
      "idempotency_requests",
      "message_resources",
      "messages",
      "request_resources",
      "resource_accesses",
      "resource_events",
      "resource_mutation_leases",
      "resource_mutation_locks",
      "resource_mutation_operations",
      "resource_search",
      "resource_search_config",
      "resource_search_content",
      "resource_search_data",
      "resource_search_docsize",
      "resource_search_idx",
      "resources",
      "run_steps",
      "run_work_state",
      "runs",
      "schema_metadata",
      "sessions",
      "unbound_run_finalizations",
      "workstream_accesses",
      "workstream_finalizations",
      "workstream_preferences",
      "workstream_request_route_plans",
      "workstream_resources",
      "workstream_search",
      "workstream_search_config",
      "workstream_search_content",
      "workstream_search_data",
      "workstream_search_docsize",
      "workstream_search_idx",
      "workstreams",
    ]);
    expect(fixture.database.prepare("PRAGMA journal_mode").all())
      .toEqual([{ journal_mode: "wal" }]);
    expect(fixture.database.prepare("PRAGMA foreign_keys").all())
      .toEqual([{ foreign_keys: 1 }]);
    expect((fixture.database.prepare("PRAGMA table_info(workstream_resources)").all() as Array<{
      name: string;
      pk: number;
    }>).filter((column) => column.pk > 0).map((column) => ({
      name: column.name,
      pk: column.pk,
    }))).toEqual([
      { name: "workstream_id", pk: 1 },
      { name: "resource_id", pk: 2 },
    ]);
  });

  it("refuses an old or unknown schema without modifying it", async () => {
    const root = await mkdtemp(join(tmpdir(), "ayati-old-context-schema-"));
    roots.push(root);
    const databasePath = join(root, "context.sqlite");
    const old = new DatabaseSync(databasePath);
    old.exec("CREATE TABLE legacy_runs (id TEXT PRIMARY KEY)");
    old.close();

    await expect(ContextDatabase.open({ path: databasePath })).rejects.toThrow(
      "The configured database uses a pre-V5 or unsupported schema and was not modified.",
    );
    const unchanged = new DatabaseSync(databasePath);
    expect(unchanged.prepare([
      "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
    ].join(" ")).all()).toEqual([{ name: "legacy_runs" }]);
    unchanged.close();
  });

  it("projects the atomically prepared message, run, and initial WorkState", async () => {
    const fixture = await createFixture();
    const prepared = await fixture.service.prepareContextTurn({
      requestId: "REQ-sqlite-prepare",
      date: "2026-07-19",
      timezone: "Asia/Kolkata",
      agentId: "local",
      role: "system_event",
      content: "Check the scheduled work.",
      at: "2026-07-19T13:00:00+05:30",
    });

    expect(prepared).toMatchObject({
      sessionCreated: true,
      conversation: { status: "active" },
      message: { role: "system_event", content: "Check the scheduled work." },
      run: {
        runId: "R-20260719-0001",
        sessionId: prepared.session.sessionId,
        conversationId: prepared.conversation.conversationId,
      },
      context: {
        run: {
          run: { runId: "R-20260719-0001", status: "running", stepCount: 0 },
          workState: { revision: 0, afterStep: 0, status: "not_done" },
          steps: [],
        },
      },
    });
    expect(fixture.database.prepare([
      "SELECT run_id, status, workstream_id, bound_request_id, step_count",
      "FROM runs WHERE run_id = ?",
    ].join(" ")).get(prepared.run.runId)).toEqual({
      run_id: prepared.run.runId,
      status: "running",
      workstream_id: null,
      bound_request_id: null,
      step_count: 0,
    });
    expect(fixture.database.prepare(
      "SELECT run_id FROM conversation_segments WHERE conversation_id = ?",
    ).get(prepared.conversation.conversationId)).toEqual({ run_id: prepared.run.runId });
  });

  it("enforces all-or-none immutable workstream binding in SQLite", async () => {
    const fixture = await createFixture();
    const prepared = await fixture.service.prepareContextTurn({
      requestId: "REQ-sqlite-binding",
      date: "2026-07-19",
      timezone: "Asia/Kolkata",
      agentId: "local",
      role: "user",
      content: "Create a durable workstream.",
      at: "2026-07-19T13:00:00+05:30",
    });
    const selected = await fixture.service.createWorkstreamForRun({
      requestId: "REQ-sqlite-create-workstream",
      sessionId: prepared.session.sessionId,
      conversationId: prepared.conversation.conversationId,
      runId: prepared.run.runId,
      title: "Binding invariant",
      objective: "Prove immutable all-or-none workstream binding.",
      at: "2026-07-19T13:00:01+05:30",
    });

    expect(() => fixture.database.prepare([
      "UPDATE runs SET bound_request_id = ? WHERE run_id = ?",
    ].join(" ")).run("R-9999", prepared.run.runId)).toThrow("run workstream binding is immutable");
    expect(() => fixture.database.prepare([
      "UPDATE runs SET workstream_id = NULL, bound_request_id = NULL, workstream_bound_at = NULL",
      "WHERE run_id = ?",
    ].join(" ")).run(prepared.run.runId)).toThrow("run workstream binding is immutable");
    expect(fixture.database.prepare([
      "SELECT workstream_id, bound_request_id FROM runs WHERE run_id = ?",
    ].join(" ")).get(prepared.run.runId)).toEqual({
      workstream_id: selected.workstream.workstreamId,
      bound_request_id: "R-0001",
    });
  });

  it("recovers an orphaned running run as incomplete/interrupted after restart", async () => {
    const fixture = await createFixture();
    const prepared = await fixture.service.prepareContextTurn({
      requestId: "REQ-sqlite-interrupted",
      date: "2026-07-19",
      timezone: "Asia/Kolkata",
      agentId: "local",
      role: "user",
      content: "This provider turn will be interrupted.",
      at: "2026-07-19T13:00:00+05:30",
    });
    const databasePath = fixture.databasePath;
    const root = fixture.root;
    await closeTracked(fixture.service);

    const database = await ContextDatabase.open({ path: databasePath });
    const restarted = new SqliteGitContextService({
      database,
      rootDirectory: root,
      now: () => "2026-07-19T13:05:00+05:30",
    });
    services.push(restarted);
    const context = await restarted.getActiveContext({ sessionId: prepared.session.sessionId });

    expect(context.run).toBeUndefined();
    expect(database.prepare([
      "SELECT status, stop_reason, completed_at FROM runs WHERE run_id = ?",
    ].join(" ")).get(prepared.run.runId)).toEqual({
      status: "incomplete",
      stop_reason: "interrupted",
      completed_at: "2026-07-19T13:05:00+05:30",
    });
    expect(database.prepare(
      "SELECT status FROM conversation_segments WHERE conversation_id = ?",
    ).get(prepared.conversation.conversationId)).toEqual({ status: "closed" });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?",
    ).get(prepared.conversation.conversationId)).toEqual({ count: 1 });
  });
});

async function createFixture(): Promise<{
  root: string;
  databasePath: string;
  database: ContextDatabase;
  service: SqliteGitContextService;
}> {
  const root = await mkdtemp(join(tmpdir(), "ayati-sqlite-v4-"));
  roots.push(root);
  const databasePath = join(root, "context.sqlite");
  const database = await ContextDatabase.open({ path: databasePath });
  const service = new SqliteGitContextService({
    database,
    rootDirectory: root,
    now: () => "2026-07-19T13:00:00+05:30",
  });
  services.push(service);
  return { root, databasePath, database, service };
}

async function closeTracked(service: SqliteGitContextService): Promise<void> {
  const index = services.indexOf(service);
  if (index >= 0) services.splice(index, 1);
  await service.close();
}
