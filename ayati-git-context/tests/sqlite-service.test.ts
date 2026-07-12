import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContextDatabase } from "../src/database/database.js";
import { SqliteGitContextService } from "../src/services/sqlite-git-context-service.js";

const temporaryDirectories: string[] = [];
const services: SqliteGitContextService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map(async (service) => {
    await service.close();
  }));
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => {
    await rm(path, { recursive: true, force: true });
  }));
});

describe("SQLite Git Context service", () => {
  it("initializes the database with durable SQLite settings", async () => {
    const { database } = await createService();

    expect(database.schemaVersion()).toBe(database.expectedSchemaVersion());
    expect(database.prepare("PRAGMA foreign_keys").get()).toMatchObject({
      foreign_keys: 1,
    });
    expect(database.prepare("PRAGMA journal_mode").get()).toMatchObject({
      journal_mode: "wal",
    });
  });

  it("creates one active session and handles idempotent retries", async () => {
    const { service } = await createService();
    const input = {
      requestId: "REQ-session-1",
      date: "2026-07-12",
      timezone: "Asia/Kolkata",
      agentId: "Local Agent",
      at: "2026-07-12T09:00:00+05:30",
    } as const;

    const first = await service.ensureActiveSession(input);
    const retried = await service.ensureActiveSession(input);
    const independentlyEnsured = await service.ensureActiveSession({
      ...input,
      requestId: "REQ-session-2",
    });

    expect(first).toEqual(retried);
    expect(first).toMatchObject({
      created: true,
      session: {
        sessionId: "S-20260712-local-agent",
        status: "open",
      },
    });
    expect(independentlyEnsured.created).toBe(false);
    expect(independentlyEnsured.session.sessionId).toBe(first.session.sessionId);
  });

  it("rejects conflicting reuse of an idempotency request id", async () => {
    const { service } = await createService();
    await service.ensureActiveSession({
      requestId: "REQ-shared",
      date: "2026-07-12",
      timezone: "Asia/Kolkata",
      agentId: "local",
    });

    await expect(service.ensureActiveSession({
      requestId: "REQ-shared",
      date: "2026-07-13",
      timezone: "Asia/Kolkata",
      agentId: "local",
    })).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });
  });

  it("orders conversation segments and appends assistant messages", async () => {
    const { service } = await createService();
    const session = await ensureSession(service);

    const firstUser = await service.appendConversation({
      requestId: "REQ-message-1",
      sessionId: session.session.sessionId,
      role: "user",
      content: "hello",
      at: "2026-07-12T09:01:00+05:30",
    });
    const assistant = await service.appendConversation({
      requestId: "REQ-message-2",
      sessionId: session.session.sessionId,
      role: "assistant",
      content: "hello back",
      at: "2026-07-12T09:01:01+05:30",
    });
    const secondUser = await service.appendConversation({
      requestId: "REQ-message-3",
      sessionId: session.session.sessionId,
      role: "user",
      content: "new turn",
      at: "2026-07-12T09:02:00+05:30",
    });

    expect(assistant.conversation.conversationId).toBe(
      firstUser.conversation.conversationId,
    );
    expect(secondUser.conversation).toMatchObject({
      sequence: 2,
      status: "active",
    });

    const context = await service.getActiveContext({
      sessionId: session.session.sessionId,
    });
    expect(context.session?.pendingConversation).toEqual([
      {
        ...firstUser.conversation,
        status: "closed",
      },
      secondUser.conversation,
    ]);
  });

  it("starts one session run and exposes it through active context", async () => {
    const { service } = await createService();
    const session = await ensureSession(service);
    const conversation = await service.appendConversation({
      requestId: "REQ-message",
      sessionId: session.session.sessionId,
      role: "user",
      content: "inspect the project",
      at: "2026-07-12T09:01:00+05:30",
    });
    const input = {
      requestId: "REQ-run",
      sessionId: session.session.sessionId,
      conversationId: conversation.conversation.conversationId,
      trigger: "user",
      at: "2026-07-12T09:01:01+05:30",
    } as const;

    const started = await service.startRun(input);
    const retried = await service.startRun(input);
    expect(retried).toEqual(started);
    expect(started.run).toMatchObject({
      runId: "R-20260712-0001",
      runClass: "session",
    });
    const step = await service.recordRunStep({
      requestId: "REQ-step",
      sessionId: session.session.sessionId,
      runId: started.run.runId,
      step: 1,
      tool: "read_files",
      purpose: "Inspect the current implementation.",
      status: "completed",
      boundedInput: { paths: ["src/index.ts"] },
      boundedOutput: { filesRead: 1 },
      verification: { ok: true },
      workState: { status: "not_done" },
      at: "2026-07-12T09:01:02+05:30",
    });
    expect(step.toolCall.purpose).toBe("Inspect the current implementation.");
    await expect(service.recordRunStep({
      requestId: "REQ-step",
      sessionId: session.session.sessionId,
      runId: started.run.runId,
      step: 1,
      tool: "read_files",
      purpose: "Inspect something different.",
      status: "completed",
      at: "2026-07-12T09:01:02+05:30",
    })).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });

    await expect(service.startRun({
      ...input,
      requestId: "REQ-run-2",
    })).rejects.toMatchObject({
      code: "RUN_ALREADY_ACTIVE",
    });

    const context = await service.getActiveContext({
      sessionId: session.session.sessionId,
    });
    expect(context.run?.run).toEqual(started.run);
    expect(context.run?.recentToolCalls).toEqual([step.toolCall]);
  });

  it("restores the active session, conversation, and run after restart", async () => {
    const directory = await createTemporaryDirectory();
    const databasePath = join(directory, "context.db");
    const firstDatabase = await ContextDatabase.open({ path: databasePath });
    const firstService = new SqliteGitContextService({
      database: firstDatabase,
      dataRoot: directory,
    });

    const session = await ensureSession(firstService);
    const conversation = await firstService.appendConversation({
      requestId: "REQ-message",
      sessionId: session.session.sessionId,
      role: "user",
      content: "durable message",
      at: "2026-07-12T09:01:00+05:30",
    });
    const run = await firstService.startRun({
      requestId: "REQ-run",
      sessionId: session.session.sessionId,
      conversationId: conversation.conversation.conversationId,
      trigger: "user",
      at: "2026-07-12T09:01:01+05:30",
    });
    const step = await firstService.recordRunStep({
      requestId: "REQ-step",
      sessionId: session.session.sessionId,
      runId: run.run.runId,
      step: 1,
      tool: "read_files",
      purpose: "Preserve restart context.",
      status: "completed",
      at: "2026-07-12T09:01:02+05:30",
    });
    await firstService.close();

    const secondDatabase = await ContextDatabase.open({ path: databasePath });
    const secondService = new SqliteGitContextService({
      database: secondDatabase,
      dataRoot: directory,
    });
    services.push(secondService);
    const restored = await secondService.getActiveContext({});

    expect(restored.session?.session.sessionId).toBe(session.session.sessionId);
    expect(restored.session?.pendingConversation).toEqual([
      conversation.conversation,
    ]);
    expect(restored.run?.run).toEqual(run.run);
    expect(restored.run?.recentToolCalls).toEqual([step.toolCall]);
    expect(secondDatabase.prepare([
      "SELECT content FROM messages WHERE conversation_id = ?",
    ].join(" ")).get(conversation.conversation.conversationId)).toMatchObject({
      content: "durable message",
    });
    await expect(secondService.ensureActiveSession({
      requestId: "REQ-session",
      date: "2026-07-12",
      timezone: "Asia/Kolkata",
      agentId: "local",
      at: "2026-07-12T09:00:00+05:30",
    })).resolves.toEqual(session);
  });

  it("requires rollover before creating a different daily session", async () => {
    const { service } = await createService();
    await ensureSession(service);

    await expect(service.ensureActiveSession({
      requestId: "REQ-next-day",
      date: "2026-07-13",
      timezone: "Asia/Kolkata",
      agentId: "local",
    })).rejects.toMatchObject({
      code: "SESSION_ROLLOVER_PENDING",
      retryable: true,
    });
  });
});

async function createService(): Promise<{
  database: ContextDatabase;
  service: SqliteGitContextService;
}> {
  const directory = await createTemporaryDirectory();
  const database = await ContextDatabase.open({
    path: join(directory, "context.db"),
  });
  const service = new SqliteGitContextService({
    database,
    dataRoot: directory,
    now: () => "2026-07-12T09:00:00+05:30",
  });
  services.push(service);
  return { database, service };
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ayati-context-sqlite-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function ensureSession(service: SqliteGitContextService) {
  return await service.ensureActiveSession({
    requestId: "REQ-session",
    date: "2026-07-12",
    timezone: "Asia/Kolkata",
    agentId: "local",
    at: "2026-07-12T09:00:00+05:30",
  });
}
