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
import { SqliteGitContextService } from "../src/services/sqlite-git-context-service.js";

const temporaryDirectories: string[] = [];
const services: SqliteGitContextService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map(async (service) => await service.close()));
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => {
    await rm(path, { recursive: true, force: true });
  }));
});

describe("complete context turn", () => {
  it("durably completes a direct reply with a compact receipt and incremental context", async () => {
    const { database, events, service } = await createService();
    const prepared = await prepareTurn(service, "REQ-complete-prepare");
    const input = completionInput(prepared, "REQ-complete-direct");

    const completed = await service.completeContextTurn(input);
    const active = await service.getActiveContext({ sessionId: prepared.session.sessionId });

    expect(completed).toMatchObject({
      conversation: { conversationId: prepared.conversation.conversationId },
      message: {
        role: "assistant",
        content: input.assistantContent,
        sessionSequence: 2,
      },
      persistence: {
        database: "saved",
        materialization: "not_requested",
        git: "not_committed",
        plannedPath: "conversations/000001.pending.md",
      },
    });
    expect(active.contextRevision).toBe(completed.contextRevision);
    expect(active.session?.pendingConversationContext[0]?.messages).toEqual([
      prepared.message,
      completed.message,
    ]);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM messages WHERE session_id = ?",
    ).get(prepared.session.sessionId)).toEqual({ count: 2 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM runs WHERE session_id = ?",
    ).get(prepared.session.sessionId)).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM tasks",
    ).get()).toEqual({ count: 0 });

    const row = database.prepare([
      "SELECT operation, status, response_json FROM idempotency_requests",
      "WHERE request_id = ?",
    ].join(" ")).get(input.requestId) as {
      operation: string;
      status: string;
      response_json: string;
    };
    expect(row).toMatchObject({ operation: "complete_context_turn", status: "completed" });
    expect(JSON.parse(row.response_json)).toEqual({
      v: 1,
      kind: "completed_context_turn",
      sessionId: prepared.session.sessionId,
      conversationId: prepared.conversation.conversationId,
      userMessageId: prepared.message.messageId,
      assistantMessageId: completed.message.messageId,
      contextRevision: completed.contextRevision,
      pendingDigest: completed.pendingDigest,
    });
    expect(Buffer.byteLength(row.response_json)).toBeLessThan(512);
    expect(row.response_json).not.toContain(input.assistantContent);
    expect(row.response_json).not.toContain("pendingConversationContext");
    expect(events.find((event) =>
      event.event === "conversation_persisted"
      && event.data?.["sourceOperation"] === "complete_context_turn"
    )?.data).toMatchObject({ conversationPersistence: completed.persistence });
  });

  it("retries completion without duplicating the assistant message", async () => {
    const { database, events, service } = await createService();
    const prepared = await prepareTurn(service, "REQ-complete-retry-prepare");
    const input = completionInput(prepared, "REQ-complete-retry");

    const first = await service.completeContextTurn(input);
    const replayed = await service.completeContextTurn(input);

    expect(replayed).toEqual(first);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM messages WHERE session_id = ?",
    ).get(prepared.session.sessionId)).toEqual({ count: 2 });
    expect(events.find((event) => event.event === "context_turn_completion_replayed")?.data)
      .toMatchObject({ conversationPersistence: replayed.persistence });
  });

  it("rejects a second completion request for an already answered user message", async () => {
    const { database, service } = await createService();
    const prepared = await prepareTurn(service, "REQ-complete-second-prepare");
    await service.completeContextTurn(completionInput(prepared, "REQ-complete-first-answer"));

    await expect(service.completeContextTurn(
      completionInput(prepared, "REQ-complete-second-answer"),
    )).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM messages WHERE session_id = ?",
    ).get(prepared.session.sessionId)).toEqual({ count: 2 });
  });

  it("recovers an interrupted compact completion without duplicating its message", async () => {
    const { database, service } = await createService();
    const prepared = await prepareTurn(service, "REQ-complete-recovery-prepare");
    const input = completionInput(prepared, "REQ-complete-recovery");
    beginRecoverableIdempotent({
      database,
      requestId: input.requestId,
      operation: "complete_context_turn",
      payload: input,
      now: input.at,
      execute: () => {
        const appended = appendConversationMessage(database, {
          requestId: input.requestId,
          sessionId: input.sessionId,
          role: "assistant",
          content: input.assistantContent,
          at: input.at,
        });
        return {
          v: 1 as const,
          kind: "completed_context_turn" as const,
          sessionId: input.sessionId,
          conversationId: input.conversationId,
          userMessageId: input.userMessageId,
          assistantMessageId: appended.message.messageId,
        };
      },
    });

    const recovered = await service.completeContextTurn(input);

    expect(recovered.message.role).toBe("assistant");
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM messages WHERE session_id = ?",
    ).get(prepared.session.sessionId)).toEqual({ count: 2 });
    expect(database.prepare(
      "SELECT status FROM idempotency_requests WHERE request_id = ?",
    ).get(input.requestId)).toEqual({ status: "completed" });
  });

  it("rejects the direct fast path while a run is active", async () => {
    const { database, service } = await createService();
    const prepared = await prepareTurn(service, "REQ-complete-run-prepare");
    await service.startRun({
      requestId: "REQ-complete-active-run",
      sessionId: prepared.session.sessionId,
      conversationId: prepared.conversation.conversationId,
      trigger: "user",
      workState: emptyRunWorkState(),
      at: "2026-07-18T10:00:01+05:30",
    });

    await expect(service.completeContextTurn(
      completionInput(prepared, "REQ-complete-run-rejected"),
    )).rejects.toMatchObject({ code: "RUN_ALREADY_ACTIVE" });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM messages WHERE session_id = ?",
    ).get(prepared.session.sessionId)).toEqual({ count: 1 });
  });

  it("reconstructs a completed direct reply after service restart", async () => {
    const fixture = await createService();
    const prepared = await prepareTurn(fixture.service, "REQ-complete-restart-prepare");
    const input = completionInput(prepared, "REQ-complete-restart");
    const first = await fixture.service.completeContextTurn(input);
    await fixture.service.close();
    services.splice(services.indexOf(fixture.service), 1);

    const reopenedDatabase = await ContextDatabase.open({ path: fixture.databasePath });
    const reopenedService = new SqliteGitContextService({
      database: reopenedDatabase,
      dataRoot: fixture.directory,
      now: () => "2026-07-18T10:01:00+05:30",
    });
    services.push(reopenedService);

    const replayed = await reopenedService.completeContextTurn(input);

    expect(replayed.message).toEqual(first.message);
    expect(reopenedDatabase.prepare(
      "SELECT COUNT(*) AS count FROM messages WHERE session_id = ?",
    ).get(prepared.session.sessionId)).toEqual({ count: 2 });
  });
});

type PreparedTurn = Awaited<ReturnType<SqliteGitContextService["prepareContextTurn"]>>;

function completionInput(prepared: PreparedTurn, requestId: string) {
  return {
    requestId,
    sessionId: prepared.session.sessionId,
    conversationId: prepared.conversation.conversationId,
    userMessageId: prepared.message.messageId,
    assistantContent: "An object remains at rest unless acted upon by an external force.",
    at: "2026-07-18T10:00:02+05:30",
  };
}

async function prepareTurn(
  service: SqliteGitContextService,
  requestId: string,
): Promise<PreparedTurn> {
  return await service.prepareContextTurn({
    requestId,
    date: "2026-07-18",
    timezone: "Asia/Kolkata",
    agentId: "local",
    role: "user",
    content: "What is Newton's first law?",
    at: "2026-07-18T10:00:00+05:30",
  });
}

async function createService(): Promise<{
  database: ContextDatabase;
  databasePath: string;
  directory: string;
  events: GitContextObservabilityEvent[];
  service: SqliteGitContextService;
}> {
  const directory = await mkdtemp(join(tmpdir(), "ayati-complete-turn-"));
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

function emptyRunWorkState() {
  return {
    status: "not_done" as const,
    summary: "",
    openWork: [],
    blockers: [],
    facts: [],
    evidence: [],
    artifacts: [],
    nextStep: null,
    userInputNeeded: [],
  };
}
