import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContextDatabase } from "../src/database/database.js";
import { beginRecoverableIdempotent } from "../src/database/idempotency.js";
import {
  GitContextObserver,
  type GitContextObservabilityEvent,
} from "../src/observability.js";
import { appendConversationMessage } from "../src/repositories/conversation-records.js";
import { createRun } from "../src/repositories/run-records.js";
import { SqliteGitContextService } from "../src/services/sqlite-git-context-service.js";

const temporaryDirectories: string[] = [];
const services: SqliteGitContextService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map(async (service) => await service.close()));
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => {
    await rm(path, { recursive: true, force: true });
  }));
});

describe("prepare context turn", () => {
  it("creates the session, persists the message, and returns authoritative context once", async () => {
    const { database, events, service } = await createService();
    const input = {
      requestId: "REQ-prepare-turn-1",
      date: "2026-07-18",
      timezone: "Asia/Kolkata",
      agentId: "local",
      role: "user" as const,
      content: "What is Newton's first law?",
      at: "2026-07-18T10:00:00+05:30",
    };

    const prepared = await service.prepareContextTurn(input);
    const retried = await service.prepareContextTurn(input);

    expect(retried).toEqual(prepared);
    expect(prepared).toMatchObject({
      sessionCreated: true,
      session: {
        sessionId: "S-20260718-local",
        status: "open",
      },
      conversation: {
        sequence: 1,
        status: "active",
      },
      message: {
        sessionSequence: 1,
        role: "user",
        content: input.content,
      },
      persistence: {
        database: "saved",
        materialization: "not_requested",
        git: "not_committed",
        plannedPath: "conversations/000001.pending.md",
      },
      context: {
        session: {
          pendingConversationContext: [{
            messages: [{ content: input.content }],
          }],
        },
      },
    });
    expect(prepared.context.session?.session).toEqual(prepared.session);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM messages WHERE session_id = ?",
    ).get(prepared.session.sessionId)).toEqual({ count: 1 });
    const idempotency = database.prepare([
      "SELECT operation, status, response_json FROM idempotency_requests",
      "WHERE request_id = ?",
    ].join(" ")).get(input.requestId) as {
      operation: string;
      status: string;
      response_json: string;
    };
    expect(idempotency).toMatchObject({
      operation: "prepare_context_turn",
      status: "completed",
    });
    expect(JSON.parse(idempotency.response_json)).toEqual({
      v: 2,
      kind: "prepared_context_turn",
      sessionId: prepared.session.sessionId,
      sessionCreated: true,
      conversationId: prepared.conversation.conversationId,
      messageId: prepared.message.messageId,
      runId: prepared.run.runId,
      contextRevision: prepared.context.contextRevision,
    });
    expect(Buffer.byteLength(idempotency.response_json)).toBeLessThan(512);
    expect(idempotency.response_json).not.toContain(input.content);
    expect(idempotency.response_json).not.toContain("pendingConversationContext");
    expect(events.find((event) => event.event === "conversation_persisted")?.data)
      .toMatchObject({ conversationPersistence: prepared.persistence });
    expect(events.find((event) => event.event === "context_turn_replayed")?.data)
      .toMatchObject({ conversationPersistence: prepared.persistence });
  });

  it("rejects conflicting reuse of a preparation request id", async () => {
    const { service } = await createService();
    const input = {
      requestId: "REQ-prepare-conflict",
      date: "2026-07-18",
      timezone: "Asia/Kolkata",
      agentId: "local",
      role: "user" as const,
      content: "Who was Einstein?",
      at: "2026-07-18T10:00:00+05:30",
    };
    await service.prepareContextTurn(input);

    await expect(service.prepareContextTurn({
      ...input,
      content: "What was Einstein famous for?",
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("rolls back the entire competing turn while another run is active", async () => {
    const { database, service } = await createService();
    const first = await service.prepareContextTurn({
      requestId: "REQ-active-first",
      date: "2026-07-18",
      timezone: "Asia/Kolkata",
      agentId: "local",
      role: "user",
      content: "Keep this run active.",
      at: "2026-07-18T10:00:00+05:30",
    });

    await expect(service.prepareContextTurn({
      requestId: "REQ-active-competing",
      date: "2026-07-18",
      timezone: "Asia/Kolkata",
      agentId: "local",
      role: "user",
      content: "This message must roll back.",
      at: "2026-07-18T10:01:00+05:30",
    })).rejects.toMatchObject({ code: "RUN_ALREADY_ACTIVE" });

    expect(database.prepare("SELECT COUNT(*) AS count FROM conversation_segments").get())
      .toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM messages").get())
      .toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM runs").get())
      .toEqual({ count: 1 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM idempotency_requests WHERE request_id = ?",
    ).get("REQ-active-competing")).toEqual({ count: 0 });
    expect(first.run.runId).toBe("R-20260718-0001");
  });

  it("rolls back daily-session changes with a competing cross-date turn", async () => {
    const { database, service } = await createService();
    const first = await service.prepareContextTurn({
      requestId: "REQ-cross-date-first",
      date: "2026-07-18",
      timezone: "Asia/Kolkata",
      agentId: "local",
      role: "user",
      content: "Keep the current daily session active.",
      at: "2026-07-18T23:59:00+05:30",
    });

    await expect(service.prepareContextTurn({
      requestId: "REQ-cross-date-competing",
      date: "2026-07-19",
      timezone: "Asia/Kolkata",
      agentId: "local",
      role: "system_event",
      content: "This next-day event must roll back with its run.",
      at: "2026-07-19T00:01:00+05:30",
    })).rejects.toMatchObject({ code: "RUN_ALREADY_ACTIVE" });

    expect(database.prepare([
      "SELECT session_id, date, status FROM sessions ORDER BY created_at",
    ].join(" ")).all()).toEqual([{
      session_id: first.session.sessionId,
      date: "2026-07-18",
      status: "open",
    }]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM messages").get())
      .toEqual({ count: 1 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM idempotency_requests WHERE request_id = ?",
    ).get("REQ-cross-date-competing")).toEqual({ count: 0 });
  });

  it("recovers a journaled preparation without duplicating the user message", async () => {
    const { database, service } = await createService();
    const ensured = await service.ensureActiveSession({
      requestId: "REQ-recovery-session",
      date: "2026-07-18",
      timezone: "Asia/Kolkata",
      agentId: "local",
      at: "2026-07-18T10:00:00+05:30",
    });
    const input = {
      requestId: "REQ-prepare-recovery",
      date: "2026-07-18",
      timezone: "Asia/Kolkata",
      agentId: "local",
      role: "user" as const,
      content: "Explain the first law of thermodynamics.",
      at: "2026-07-18T10:01:00+05:30",
    };
    beginRecoverableIdempotent({
      database,
      requestId: input.requestId,
      operation: "prepare_context_turn",
      payload: input,
      now: input.at,
      execute: () => {
        const appended = appendConversationMessage(database, {
          sessionId: ensured.session.sessionId,
          role: input.role,
          content: input.content,
          at: input.at,
        });
        const run = createRun(database, {
          sessionId: ensured.session.sessionId,
          conversationId: appended.conversation.conversationId,
          trigger: "user",
          workState: initialWorkState(),
          at: input.at,
        });
        return {
          v: 2 as const,
          kind: "prepared_context_turn" as const,
          sessionId: ensured.session.sessionId,
          sessionCreated: false,
          conversationId: appended.conversation.conversationId,
          messageId: appended.message.messageId,
          runId: run.runId,
        };
      },
    });

    const recovered = await service.prepareContextTurn(input);

    expect(recovered.context.session?.pendingConversationContext[0]?.messages).toHaveLength(1);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM messages WHERE session_id = ?",
    ).get(ensured.session.sessionId)).toEqual({ count: 1 });
    expect(database.prepare(
      "SELECT status FROM idempotency_requests WHERE request_id = ?",
    ).get(input.requestId)).toEqual({ status: "completed" });
  });

  it("rebuilds current context from a completed compact receipt", async () => {
    const { database, service } = await createService();
    const input = {
      requestId: "REQ-prepare-current-context",
      date: "2026-07-18",
      timezone: "Asia/Kolkata",
      agentId: "local",
      role: "user" as const,
      content: "What is Newton's first law?",
      at: "2026-07-18T10:00:00+05:30",
    };
    const first = await service.prepareContextTurn(input);
    await service.finalizeRun({
      requestId: "REQ-prepare-current-context-finalize",
      sessionId: first.session.sessionId,
      runId: first.run.runId,
      outcome: "done",
      stopReason: "completed",
      assistantResponse: "An object remains at rest or in uniform motion unless acted on by a force.",
      conversationSummary: "The user asked about Newton's first law.",
      summary: "Answered the question directly.",
      validation: "not_applicable",
      workState: { ...initialWorkState(), status: "done", summary: "Answered directly." },
      at: "2026-07-18T10:00:01+05:30",
    });

    const replayed = await service.prepareContextTurn(input);

    expect(replayed.message).toEqual(first.message);
    expect(replayed.context.contextRevision).not.toBe(first.context.contextRevision);
    expect(replayed.conversation.status).toBe("closed");
    expect(replayed.run.runId).toBe(first.run.runId);
    const row = database.prepare(
      "SELECT response_json FROM idempotency_requests WHERE request_id = ?",
    ).get(input.requestId) as { response_json: string };
    expect(row.response_json).not.toContain(input.content);
    expect(JSON.parse(row.response_json)).toMatchObject({
      messageId: first.message.messageId,
      contextRevision: first.context.contextRevision,
    });
  });

  it("reconstructs a completed preparation after the service restarts", async () => {
    const fixture = await createService();
    const input = {
      requestId: "REQ-prepare-restart",
      date: "2026-07-18",
      timezone: "Asia/Kolkata",
      agentId: "local",
      role: "user" as const,
      content: "Who was Einstein?",
      at: "2026-07-18T10:00:00+05:30",
    };
    const first = await fixture.service.prepareContextTurn(input);
    await fixture.service.close();
    services.splice(services.indexOf(fixture.service), 1);

    const reopenedDatabase = await ContextDatabase.open({ path: fixture.databasePath });
    const reopenedService = new SqliteGitContextService({
      database: reopenedDatabase,
      dataRoot: fixture.directory,
      now: () => "2026-07-18T10:01:00+05:30",
    });
    services.push(reopenedService);

    const replayed = await reopenedService.prepareContextTurn(input);

    expect(replayed.message).toEqual(first.message);
    expect(replayed.context.session?.pendingConversationContext[0]?.messages).toEqual([
      first.message,
    ]);
    expect(reopenedDatabase.prepare(
      "SELECT COUNT(*) AS count FROM messages WHERE session_id = ?",
    ).get(first.session.sessionId)).toEqual({ count: 1 });
  });
});

async function createService(): Promise<{
  database: ContextDatabase;
  databasePath: string;
  directory: string;
  events: GitContextObservabilityEvent[];
  service: SqliteGitContextService;
}> {
  const directory = await mkdtemp(join(tmpdir(), "ayati-prepare-turn-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "context.db");
  const database = await ContextDatabase.open({ path: databasePath });
  const events: GitContextObservabilityEvent[] = [];
  const service = new SqliteGitContextService({
    database,
    dataRoot: directory,
    now: () => "2026-07-18T10:00:00+05:30",
    observer: new GitContextObserver("git-context-engine", (event) => events.push(event)),
  });
  services.push(service);
  return { database, databasePath, directory, events, service };
}

function initialWorkState() {
  return {
    status: "not_done" as const,
    summary: "Run started.",
    openWork: [],
    blockers: [],
    facts: [],
    evidence: [],
    artifacts: [],
    nextStep: null,
    userInputNeeded: [],
  };
}
