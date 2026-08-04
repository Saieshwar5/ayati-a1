import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContextDatabase } from "../src/database/database.js";
import { latestSchemaVersion } from "../src/database/schema.js";
import { SqliteContextEngineService } from "../src/services/sqlite-context-engine-service.js";

const roots: string[] = [];
const services: SqliteContextEngineService[] = [];
const AT = "2026-07-20T13:00:00+05:30";

afterEach(async () => {
  await Promise.all(services.splice(0).map(async (service) => await service.close()));
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

describe("SQLite Context Engine V12 baseline", () => {
  it("rejects relative database paths instead of anchoring them to process.cwd()", async () => {
    await expect(ContextDatabase.open({ path: "context.sqlite" }))
      .rejects.toThrow("database path must be an absolute filesystem path");
  });

  it("creates the clean V12 stream/run/checkpoint schema without retired resolution storage", async () => {
    const fixture = await createFixture();

    expect(latestSchemaVersion()).toBe(12);
    expect(fixture.database.prepare(
      "SELECT version FROM schema_metadata WHERE singleton = 1",
    ).get()).toEqual({ version: 12 });
    const streamColumns = new Set((fixture.database.prepare(
      "PRAGMA table_info(agent_streams)",
    ).all() as Array<{ name: string }>).map((column) => column.name));
    expect(streamColumns.has("focused_workstream_id")).toBe(true);
    expect(streamColumns.has("focused_request_id")).toBe(true);
    const tables = new Set((fixture.database.prepare([
      "SELECT name FROM sqlite_schema",
      "WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    ].join(" ")).all() as Array<{ name: string }>).map((row) => row.name));
    for (const table of [
      "agent_streams",
      "messages",
      "message_response_metadata",
      "runs",
      "run_steps",
      "run_work_state",
      "context_checkpoints",
      "workstreams",
      "resources",
    ]) {
      expect(tables.has(table), table).toBe(true);
    }
    expect(tables.has("sessions")).toBe(false);
    expect(tables.has("conversation_segments")).toBe(false);
    expect(tables.has("reusable_observations")).toBe(false);
    expect(tables.has("observation_resources")).toBe(false);
    expect(tables.has("workstream_resolution_activities")).toBe(false);
    expect(tables.has("workstream_resolution_steps")).toBe(false);
    expect(fixture.database.prepare("PRAGMA journal_mode").all())
      .toEqual([{ journal_mode: "wal" }]);
    expect(fixture.database.prepare("PRAGMA foreign_keys").all())
      .toEqual([{ foreign_keys: 1 }]);
  });

  it("opens an existing V12 database with retired observation tables without using them", async () => {
    const fixture = await createFixture();
    await closeTracked(fixture.service);
    const legacy = new DatabaseSync(fixture.databasePath);
    legacy.exec("CREATE TABLE reusable_observations (legacy INTEGER)");
    legacy.exec("CREATE TABLE observation_resources (legacy INTEGER)");
    legacy.close();

    const reopened = await ContextDatabase.open({ path: fixture.databasePath });

    expect(reopened.schemaVersion()).toBe(12);
    reopened.close();
  });

  it("migrates V10 through V11 to V12 while narrowing the immutable binding exception", async () => {
    const fixture = await createFixture();
    const prepared = await fixture.service.prepareAgentRun(
      prepareRequest("REQ-v10-preserved", "Preserve this V10 stream.", AT),
    );
    fixture.database.exec("DROP TRIGGER runs_workstream_binding_immutable");
    installRetiredResolutionTables(fixture.database);
    fixture.database.exec([
      "CREATE TRIGGER runs_workstream_binding_immutable",
      "BEFORE UPDATE OF workstream_id, bound_request_id, workstream_bound_at ON runs",
      "WHEN OLD.workstream_id IS NOT NULL",
      "BEGIN SELECT RAISE(ABORT, 'run workstream binding is immutable'); END;",
    ].join(" "));
    fixture.database.prepare(
      "UPDATE schema_metadata SET version = 10 WHERE singleton = 1",
    ).run();
    const databasePath = fixture.databasePath;
    await closeTracked(fixture.service);

    const migrated = await ContextDatabase.open({ path: databasePath });

    expect(migrated.schemaVersion()).toBe(12);
    expect(migrated.prepare(
      "SELECT stream_id FROM runs WHERE run_id = ?",
    ).get(prepared.run.runId)).toEqual({ stream_id: prepared.stream.streamId });
    const trigger = migrated.prepare([
      "SELECT sql FROM sqlite_schema WHERE type = 'trigger'",
      "AND name = 'runs_workstream_binding_immutable'",
    ].join(" ")).get() as { sql: string };
    expect(trigger.sql).toContain("workstream_resources");
    expect(trigger.sql).toContain("workstream_request_route_plans");
    migrated.close();
  });

  it("migrates a supported V9 catalog through V10 and V11 to V12 without replacing its records", async () => {
    const fixture = await createFixture();
    const prepared = await fixture.service.prepareAgentRun(
      prepareRequest("REQ-v9-preserved", "Preserve this stream.", AT),
    );
    installRetiredResolutionTables(fixture.database);
    fixture.database.prepare(
      "UPDATE schema_metadata SET version = 9 WHERE singleton = 1",
    ).run();
    const databasePath = fixture.databasePath;
    await closeTracked(fixture.service);

    const migrated = await ContextDatabase.open({ path: databasePath });

    expect(migrated.schemaVersion()).toBe(12);
    expect(migrated.prepare([
      "SELECT agent_id, scope_key, focused_workstream_id, focused_request_id",
      "FROM agent_streams WHERE stream_id = ?",
    ].join(" ")).get(prepared.stream.streamId)).toEqual({
      agent_id: "local",
      scope_key: "default",
      focused_workstream_id: null,
      focused_request_id: null,
    });
    migrated.close();
  });

  it("migrates V11 by removing only retired resolution tables", async () => {
    const fixture = await createFixture();
    const prepared = await fixture.service.prepareAgentRun(
      prepareRequest("REQ-v11-preserved", "Preserve this V11 stream.", AT),
    );
    installRetiredResolutionTables(fixture.database);
    fixture.database.prepare(
      "INSERT INTO workstream_resolution_activities(activity_id) VALUES (?)",
    ).run("WR-OLD");
    fixture.database.prepare(
      "UPDATE schema_metadata SET version = 11 WHERE singleton = 1",
    ).run();
    const databasePath = fixture.databasePath;
    await closeTracked(fixture.service);

    const migrated = await ContextDatabase.open({ path: databasePath });

    expect(migrated.schemaVersion()).toBe(12);
    expect(migrated.prepare(
      "SELECT stream_id FROM runs WHERE run_id = ?",
    ).get(prepared.run.runId)).toEqual({ stream_id: prepared.stream.streamId });
    const tables = new Set((migrated.prepare([
      "SELECT name FROM sqlite_schema",
      "WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    ].join(" ")).all() as Array<{ name: string }>).map((row) => row.name));
    expect(tables.has("workstream_resolution_activities")).toBe(false);
    expect(tables.has("workstream_resolution_steps")).toBe(false);
    migrated.close();
  });

  it("refuses pre-V9 or unknown state without modifying it", async () => {
    const root = await mkdtemp(join(tmpdir(), "ayati-old-context-schema-"));
    roots.push(root);
    const databasePath = join(root, "context.sqlite");
    const old = new DatabaseSync(databasePath);
    old.exec("CREATE TABLE schema_metadata (singleton INTEGER PRIMARY KEY, version INTEGER, created_at TEXT)");
    old.exec("INSERT INTO schema_metadata VALUES (1, 5, '2026-07-19T00:00:00Z')");
    old.close();

    await expect(ContextDatabase.open({ path: databasePath })).rejects.toThrow(
      "The configured database uses a pre-V9 or unsupported schema and was not modified.",
    );
    const unchanged = new DatabaseSync(databasePath);
    expect(unchanged.prepare("SELECT version FROM schema_metadata").get()).toEqual({ version: 5 });
    unchanged.close();
  });

  it("prepares one immutable message and run in the default stream idempotently", async () => {
    const fixture = await createFixture();
    const request = {
      requestId: "REQ-v7-prepare",
      timezone: "Asia/Kolkata",
      agentId: "local",
      scopeKey: "default",
      role: "system_event" as const,
      content: "Check the scheduled work.",
      at: AT,
    };
    const prepared = await fixture.service.prepareAgentRun(request);
    const replayed = await fixture.service.prepareAgentRun(request);

    expect(replayed).toEqual(prepared);
    expect(prepared).toMatchObject({
      streamCreated: true,
      stream: { agentId: "local", scopeKey: "default", lastMessageSequence: 1, lastRunSequence: 1 },
      message: { sequence: 1, role: "system_event", content: request.content },
      run: { runId: expect.any(String), streamId: expect.any(String) },
      context: {
        stream: { recentMessages: [{ sequence: 1, role: "system_event" }] },
        run: {
          run: { status: "running", trigger: "system_event", stepCount: 0 },
          workState: { revision: 0, afterStep: 0, status: "in_progress" },
          steps: [],
        },
      },
    });
    expect(() => fixture.database.prepare(
      "UPDATE messages SET content = 'changed' WHERE message_id = ?",
    ).run(prepared.message.messageId)).toThrow("messages are immutable");
    expect(() => fixture.database.prepare(
      "DELETE FROM messages WHERE message_id = ?",
    ).run(prepared.message.messageId)).toThrow("messages are immutable");
  });

  it("continues the same stream across runs and keeps run sequences separate", async () => {
    const fixture = await createFixture();
    const first = await fixture.service.prepareAgentRun(prepareRequest("REQ-first", "First message", AT));
    await fixture.service.finalizeRun({
      requestId: "REQ-first-finalize",
      runId: first.run.runId,
      outcome: "done",
      stopReason: "completed",
      assistantResponse: "First response",
      streamSummary: "First exchange completed.",
      summary: "Replied directly.",
      validation: "not_applicable",
      workState: workState("First exchange completed."),
      at: "2026-07-20T13:01:00+05:30",
    });
    const second = await fixture.service.prepareAgentRun(prepareRequest(
      "REQ-second",
      "Second message",
      "2026-07-20T13:02:00+05:30",
    ));

    expect(second.stream.streamId).toBe(first.stream.streamId);
    expect(second.streamCreated).toBe(false);
    expect(second.message.sequence).toBe(3);
    expect(second.run.runId).not.toBe(first.run.runId);
    expect(second.context.stream?.recentMessages.map((message) => message.role))
      .toEqual(["user", "assistant", "user"]);
  });

  it("rebuilds assistant feedback semantics from durable messages after restart", async () => {
    const fixture = await createFixture();
    const prepared = await fixture.service.prepareAgentRun(
      prepareRequest("REQ-feedback", "Should we continue?", AT),
    );
    await fixture.service.finalizeRun({
      requestId: "REQ-feedback-finalize",
      runId: prepared.run.runId,
      outcome: "needs_user_input",
      stopReason: "needs_user_input",
      assistantResponse: "Should I continue with the migration?",
      assistantResponseKind: "feedback",
      assistantFeedbackKind: "confirmation",
      streamSummary: "Waiting for confirmation.",
      summary: "The next action requires confirmation.",
      validation: "not_applicable",
      workState: {
        ...workState("Waiting for confirmation."),
        status: "needs_user_input",
        nextAction: "Continue after the user confirms.",
      },
      at: "2026-07-20T13:01:00+05:30",
    });
    const databasePath = fixture.databasePath;
    const root = fixture.root;
    await closeTracked(fixture.service);

    const database = await ContextDatabase.open({ path: databasePath });
    const restarted = new SqliteContextEngineService({
      database,
      rootDirectory: root,
      now: () => "2026-07-20T13:02:00+05:30",
    });
    services.push(restarted);

    const context = await restarted.getAgentContext({ streamId: prepared.stream.streamId });
    expect(context.stream?.recentMessages.at(-1)).toMatchObject({
      role: "assistant",
      responseKind: "feedback",
      feedbackKind: "confirmation",
      content: "Should I continue with the migration?",
    });
  });

  it("recovers an orphaned running run as incomplete/interrupted", async () => {
    const fixture = await createFixture();
    const prepared = await fixture.service.prepareAgentRun(
      prepareRequest("REQ-interrupted", "This run will be interrupted.", AT),
    );
    await fixture.service.recordRunStep({
      requestId: "REQ-interrupted-step",
      runId: prepared.run.runId,
      record: {
        version: 1,
        step: 1,
        status: "completed",
        summary: "Read durable diagnostic evidence.",
        toolCalls: [{
          callId: "read-diagnostic",
          tool: "workspace_get_state",
          purpose: "Read the current workspace state.",
          toolPurpose: "read",
          toolEffect: "read_only",
          status: "success",
          input: {},
          output: { windows: ["editor"] },
        }],
        verification: { passed: true },
        createdAt: "2026-07-20T13:00:01+05:30",
      },
    });
    const databasePath = fixture.databasePath;
    const root = fixture.root;
    await closeTracked(fixture.service);

    const database = await ContextDatabase.open({ path: databasePath });
    const restarted = new SqliteContextEngineService({
      database,
      rootDirectory: root,
      now: () => "2026-07-20T13:05:00+05:30",
    });
    services.push(restarted);
    const context = await restarted.getAgentContext({ streamId: prepared.stream.streamId });

    expect(context.run).toBeUndefined();
    expect(database.prepare([
      "SELECT status, stop_reason, completed_at FROM runs WHERE run_id = ?",
    ].join(" ")).get(prepared.run.runId)).toEqual({
      status: "incomplete",
      stop_reason: "interrupted",
      completed_at: "2026-07-20T13:05:00+05:30",
    });
    expect(context.stream?.recentMessages).toHaveLength(1);
    expect("observations" in context).toBe(false);
    expect(database.prepare([
      "SELECT COUNT(*) AS count FROM sqlite_schema",
      "WHERE type = 'table' AND name = 'reusable_observations'",
    ].join(" ")).get())
      .toEqual({ count: 0 });
  });
});

function prepareRequest(requestId: string, content: string, at: string) {
  return {
    requestId,
    timezone: "Asia/Kolkata",
    agentId: "local",
    scopeKey: "default",
    role: "user" as const,
    content,
    at,
  };
}

function workState(summary: string) {
  return {
    status: "done" as const,
    summary,
    plan: [],
    importantContext: [],
    nextAction: null,
  };
}

function installRetiredResolutionTables(database: ContextDatabase): void {
  database.exec([
    "CREATE TABLE workstream_resolution_activities (",
    "  activity_id TEXT PRIMARY KEY",
    ");",
    "CREATE TABLE workstream_resolution_steps (",
    "  activity_id TEXT NOT NULL,",
    "  step INTEGER NOT NULL DEFAULT 1",
    ");",
  ].join("\n"));
}

async function createFixture(): Promise<{
  root: string;
  databasePath: string;
  database: ContextDatabase;
  service: SqliteContextEngineService;
}> {
  const root = await mkdtemp(join(tmpdir(), "ayati-sqlite-v12-"));
  roots.push(root);
  const databasePath = join(root, "context.sqlite");
  const database = await ContextDatabase.open({ path: databasePath });
  const service = new SqliteContextEngineService({
    database,
    rootDirectory: root,
    now: () => AT,
  });
  services.push(service);
  return { root, databasePath, database, service };
}

async function closeTracked(service: SqliteContextEngineService): Promise<void> {
  const index = services.indexOf(service);
  if (index >= 0) services.splice(index, 1);
  await service.close();
}
