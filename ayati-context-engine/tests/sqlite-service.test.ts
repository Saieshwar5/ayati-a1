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

describe("SQLite Context Engine V7 baseline", () => {
  it("creates the clean V7 stream/run/checkpoint/observation/resolution schema", async () => {
    const fixture = await createFixture();

    expect(latestSchemaVersion()).toBe(7);
    expect(fixture.database.prepare(
      "SELECT version FROM schema_metadata WHERE singleton = 1",
    ).get()).toEqual({ version: 7 });
    const tables = new Set((fixture.database.prepare([
      "SELECT name FROM sqlite_schema",
      "WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    ].join(" ")).all() as Array<{ name: string }>).map((row) => row.name));
    for (const table of [
      "agent_streams",
      "messages",
      "runs",
      "run_steps",
      "run_work_state",
      "context_checkpoints",
      "reusable_observations",
      "observation_resources",
      "workstreams",
      "workstream_resolution_activities",
      "workstream_resolution_steps",
      "resources",
    ]) {
      expect(tables.has(table), table).toBe(true);
    }
    expect(tables.has("sessions")).toBe(false);
    expect(tables.has("conversation_segments")).toBe(false);
    expect(fixture.database.prepare("PRAGMA journal_mode").all())
      .toEqual([{ journal_mode: "wal" }]);
    expect(fixture.database.prepare("PRAGMA foreign_keys").all())
      .toEqual([{ foreign_keys: 1 }]);
  });

  it("refuses pre-V7 or unknown state without modifying it", async () => {
    const root = await mkdtemp(join(tmpdir(), "ayati-old-context-schema-"));
    roots.push(root);
    const databasePath = join(root, "context.sqlite");
    const old = new DatabaseSync(databasePath);
    old.exec("CREATE TABLE schema_metadata (singleton INTEGER PRIMARY KEY, version INTEGER, created_at TEXT)");
    old.exec("INSERT INTO schema_metadata VALUES (1, 5, '2026-07-19T00:00:00Z')");
    old.close();

    await expect(ContextDatabase.open({ path: databasePath })).rejects.toThrow(
      "The configured database uses a pre-V7 or unsupported schema and was not modified.",
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
          workState: { revision: 0, afterStep: 0, status: "not_done" },
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

  it("recovers an orphaned running run as incomplete/interrupted", async () => {
    const fixture = await createFixture();
    const prepared = await fixture.service.prepareAgentRun(
      prepareRequest("REQ-interrupted", "This run will be interrupted.", AT),
    );
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
    openWork: [],
    blockers: [],
    facts: [],
    evidence: [],
    artifacts: [],
    nextStep: null,
    userInputNeeded: [],
  };
}

async function createFixture(): Promise<{
  root: string;
  databasePath: string;
  database: ContextDatabase;
  service: SqliteContextEngineService;
}> {
  const root = await mkdtemp(join(tmpdir(), "ayati-sqlite-v7-"));
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
