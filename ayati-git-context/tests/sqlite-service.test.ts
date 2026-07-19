import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextDatabase } from "../src/database/database.js";
import { beginRecoverableIdempotent } from "../src/database/idempotency.js";
import { appendConversationMessage } from "../src/repositories/conversation-records.js";
import { insertSession } from "../src/repositories/session-records.js";
import { SqliteGitContextService } from "../src/services/sqlite-git-context-service.js";

const execFileAsync = promisify(execFile);

const temporaryDirectories: string[] = [];
const services: SqliteGitContextService[] = [];
const testNow = () => "2026-07-12T09:00:00+05:30";

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
    expect(database.prepare([
      "SELECT name FROM sqlite_schema",
      "WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      "ORDER BY name",
    ].join(" ")).all()).toEqual([
      "conversation_segments",
      "file_sync_operations",
      "idempotency_requests",
      "messages",
      "run_steps",
      "run_work_state",
      "runs",
      "schema_metadata",
      "session_attachments",
      "session_run_finalizations",
      "sessions",
      "simple_task_finalizations",
      "task_attachment_bindings",
      "task_mutation_authorities",
      "task_request_route_plans",
      "tasks",
    ].map((name) => ({ name })));
  });

  it("rejects an unsupported database without changing its schema", async () => {
    const directory = await createTemporaryDirectory();
    const databasePath = join(directory, "context.db");
    const unsupported = new DatabaseSync(databasePath);
    unsupported.exec([
      "CREATE TABLE unsupported_schema (version INTEGER PRIMARY KEY, created_at TEXT NOT NULL);",
      "INSERT INTO unsupported_schema(version, created_at) VALUES (17, '2026-07-18T00:00:00Z');",
      "CREATE TABLE unsupported_table (id TEXT PRIMARY KEY);",
    ].join("\n"));
    unsupported.close();

    await expect(ContextDatabase.open({ path: databasePath })).rejects.toThrow(
      `Git Context database reset required. The configured database uses a pre-V1 or unsupported schema and was not modified. Back up or move the database explicitly, then restart Ayati to create the V1 baseline. Database: ${databasePath}`,
    );
    const inspected = new DatabaseSync(databasePath, { readOnly: true });
    expect(inspected.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
    ).all()).toEqual([
      { name: "unsupported_schema" },
      { name: "unsupported_table" },
    ]);
    inspected.close();
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

  it("creates a main-branch session repository with one identity commit", async () => {
    const { service } = await createService();
    const result = await ensureSession(service);
    const repositoryPath = result.session.repositoryPath;
    const metadata = JSON.parse(
      await readFile(join(repositoryPath, "session", "meta.json"), "utf8"),
    ) as Record<string, unknown>;

    expect(result.session.head).toMatch(/^[a-f0-9]{40}$/);
    expect(metadata).toMatchObject({
      sessionId: result.session.sessionId,
      date: "2026-07-12",
      timezone: "Asia/Kolkata",
      agentId: "local",
    });
    expect(await git(repositoryPath, ["branch", "--show-current"])).toBe("main");
    expect(await git(repositoryPath, ["rev-list", "--count", "HEAD"])).toBe("1");
    expect(await git(repositoryPath, ["log", "-1", "--pretty=%s"])).toBe(
      "session: initialize " + result.session.sessionId,
    );
  });

  it("resumes a repository interrupted after git initialization", async () => {
    const directory = await createTemporaryDirectory();
    const database = await ContextDatabase.open({ path: join(directory, "context.db") });
    const repositoryPath = join(directory, "sessions", "S-20260712-local");
    insertSession(database, {
      sessionId: "S-20260712-local",
      date: "2026-07-12",
      timezone: "Asia/Kolkata",
      agentId: "local",
      repositoryPath,
      createdAt: "2026-07-12T09:00:00+05:30",
    });
    await mkdir(repositoryPath, { recursive: true });
    await git(repositoryPath, ["init", "--initial-branch=main"]);
    const service = new SqliteGitContextService({ database, dataRoot: directory, now: testNow });
    services.push(service);

    const context = await service.getActiveContext({ sessionId: "S-20260712-local" });

    expect(context.session?.session.head).toMatch(/^[a-f0-9]{40}$/);
    expect(await git(repositoryPath, ["rev-list", "--count", "HEAD"])).toBe("1");
    expect(JSON.parse(
      await readFile(join(repositoryPath, "session", "meta.json"), "utf8"),
    )).toMatchObject({ sessionId: "S-20260712-local" });
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
    expect(firstUser.message).toMatchObject({
      messageId: session.session.sessionId + "-M-000001",
      sessionSequence: 1,
      segmentSequence: 1,
    });
    expect(assistant.message).toMatchObject({
      messageId: session.session.sessionId + "-M-000002",
      sessionSequence: 2,
      segmentSequence: 2,
    });
    expect(secondUser.message).toMatchObject({
      messageId: session.session.sessionId + "-M-000003",
      sessionSequence: 3,
      segmentSequence: 1,
    });
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
        filePath: "conversations/000001-session.md",
        status: "closed",
      },
      secondUser.conversation,
    ]);
    expect(context.session?.pendingConversationContext).toMatchObject([
      {
        messages: [
          { segmentSequence: 1, sessionSequence: 1, role: "user", content: "hello" },
          { segmentSequence: 2, sessionSequence: 2, role: "assistant", content: "hello back" },
        ],
      },
      {
        messages: [{ segmentSequence: 1, sessionSequence: 3, role: "user", content: "new turn" }],
      },
    ]);
    expect(context.session?.pendingDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(await service.getActiveContext({
      sessionId: session.session.sessionId,
    })).toBe(context);

    const repositoryPath = session.session.repositoryPath;
    await expect(readFile(
      join(repositoryPath, "conversations", "000001-session.md"),
      "utf8",
    )).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(
      join(repositoryPath, "conversations", "000001.pending.md"),
      "utf8",
    )).rejects.toMatchObject({ code: "ENOENT" });
    expect(await git(repositoryPath, ["rev-list", "--count", "HEAD"])).toBe("1");
    expect(await git(repositoryPath, ["status", "--short"])).toBe("");
  });

  it("advances the authoritative context revision at every durable boundary", async () => {
    const { service } = await createService();
    const session = await ensureSession(service);
    const initial = await service.getActiveContext({ sessionId: session.session.sessionId });
    expect(initial.contextRevision).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(await service.getActiveContext({ sessionId: session.session.sessionId })).toBe(initial);

    const conversation = await service.appendConversation({
      requestId: "REQ-revision-message",
      sessionId: session.session.sessionId,
      role: "user",
      content: "Inspect the current implementation.",
      at: "2026-07-12T09:03:00+05:30",
    });
    const afterConversation = await service.getActiveContext({
      sessionId: session.session.sessionId,
    });
    expect(afterConversation.contextRevision).not.toBe(initial.contextRevision);

    const run = await service.startRun({
      requestId: "REQ-revision-run",
      sessionId: session.session.sessionId,
      conversationId: conversation.conversation.conversationId,
      trigger: "user",
      workState: emptyRunWorkState(),
      at: "2026-07-12T09:03:01+05:30",
    });
    const afterRun = await service.getActiveContext({ sessionId: session.session.sessionId });
    expect(afterRun.contextRevision).not.toBe(afterConversation.contextRevision);

    await service.recordRunStep({
      requestId: "REQ-revision-step",
      sessionId: session.session.sessionId,
      runId: run.run.runId,
      step: 1,
      tool: "read_files",
      toolEffect: "read_only",
      purpose: "Read source context.",
      status: "completed",
      output: { files: [] },
      verification: { passed: true },
      workState: { ...emptyRunWorkState(), summary: "Source context inspected." },
      at: "2026-07-12T09:03:02+05:30",
    });
    const afterStep = await service.getActiveContext({ sessionId: session.session.sessionId });
    expect(afterStep.contextRevision).not.toBe(afterRun.contextRevision);
    expect(afterStep.run?.workState.revision).toBe(1);
  });

  it("recovers a journaled conversation append without duplicating it", async () => {
    const directory = await createTemporaryDirectory();
    const databasePath = join(directory, "context.db");
    const firstDatabase = await ContextDatabase.open({ path: databasePath });
    const firstService = new SqliteGitContextService({
      database: firstDatabase,
      dataRoot: directory,
      now: testNow,
    });
    const session = await ensureSession(firstService);
    const input = {
      requestId: "REQ-crash-message",
      sessionId: session.session.sessionId,
      role: "user" as const,
      content: "survive the crash boundary",
      at: "2026-07-12T09:01:00+05:30",
    };
    beginRecoverableIdempotent({
      database: firstDatabase,
      requestId: input.requestId,
      operation: "append_conversation",
      payload: input,
      now: input.at,
      execute: () => appendConversationMessage(firstDatabase, input),
    });
    await firstService.close();

    const secondDatabase = await ContextDatabase.open({ path: databasePath });
    const secondService = new SqliteGitContextService({
      database: secondDatabase,
      dataRoot: directory,
      now: testNow,
    });
    services.push(secondService);
    const restored = await secondService.getActiveContext({
      sessionId: session.session.sessionId,
    });

    expect(restored.session?.pendingConversationContext[0]?.messages).toHaveLength(1);
    await expect(readFile(join(
      session.session.repositoryPath,
      "conversations",
      "000001.pending.md",
    ), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(secondService.appendConversation(input)).resolves.toMatchObject({
      conversation: { sequence: 1 },
      message: {
        messageId: session.session.sessionId + "-M-000001",
        sessionSequence: 1,
        segmentSequence: 1,
      },
    });
    expect(secondDatabase.prepare(
      "SELECT COUNT(*) AS count FROM messages WHERE session_id = ?",
    ).get(session.session.sessionId)).toMatchObject({ count: 1 });
    expect(secondDatabase.prepare([
      "SELECT status FROM idempotency_requests WHERE request_id = ?",
    ].join(" ")).get(input.requestId)).toMatchObject({ status: "completed" });
    expect(secondDatabase.prepare(
      "SELECT COUNT(*) AS count FROM file_sync_operations",
    ).get()).toMatchObject({ count: 0 });
  });

  it("updates cached uncommitted context for system events without creating files", async () => {
    const { service } = await createService();
    const session = await ensureSession(service);
    const event = await service.appendConversation({
      requestId: "REQ-system-event",
      sessionId: session.session.sessionId,
      role: "system_event",
      content: "A scheduled local event was received.",
      at: "2026-07-12T09:03:00+05:30",
    });

    const context = await service.getActiveContext({ sessionId: session.session.sessionId });

    expect(context.session?.pendingConversationContext).toMatchObject([{
      conversation: { conversationId: event.conversation.conversationId },
      messages: [{ role: "system_event", content: "A scheduled local event was received." }],
    }]);
    await expect(readFile(
      join(session.session.repositoryPath, event.conversation.filePath),
      "utf8",
    )).rejects.toMatchObject({ code: "ENOENT" });
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
      workState: emptyRunWorkState(),
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
      toolEffect: "read_only",
      purpose: "Inspect the current implementation.",
      status: "completed",
      input: { paths: ["src/index.ts"] },
      output: { filesRead: 1 },
      verification: { ok: true },
      workState: {
        ...emptyRunWorkState(),
        summary: "Inspected the current implementation.",
        nextStep: "Respond with the findings.",
      },
      at: "2026-07-12T09:01:02+05:30",
    });
    expect(step.toolCall.purpose).toBe("Inspect the current implementation.");
    await expect(service.recordRunStep({
      requestId: "REQ-step",
      sessionId: session.session.sessionId,
      runId: started.run.runId,
      step: 1,
      tool: "read_files",
      toolEffect: "read_only",
      purpose: "Inspect something different.",
      status: "completed",
      workState: emptyRunWorkState(),
      at: "2026-07-12T09:01:02+05:30",
    })).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });
    await expect(service.recordRunStep({
      requestId: "REQ-mutating-session-step",
      sessionId: session.session.sessionId,
      runId: started.run.runId,
      step: 2,
      tool: "write_files",
      toolEffect: "mutating",
      purpose: "Attempt an invalid session mutation.",
      status: "completed",
      workState: emptyRunWorkState(),
      at: "2026-07-12T09:01:03+05:30",
    })).rejects.toMatchObject({ code: "MUTATION_REQUIRES_TASK" });

    await expect(service.startRun({
      ...input,
      requestId: "REQ-run-2",
    })).rejects.toMatchObject({
      code: "RUN_ALREADY_ACTIVE",
    });

    const context = await service.getActiveContext({
      sessionId: session.session.sessionId,
    });
    expect(context.run?.run).toMatchObject(started.run);
    expect(context.run?.steps).toMatchObject([{
      ...step.toolCall,
      input: { paths: ["src/index.ts"] },
      output: { filesRead: 1 },
      verification: { ok: true },
    }]);
    expect(context.run?.workState).toEqual(step.workState);
  });

  it("restores the active session, conversation, and run after restart", async () => {
    const directory = await createTemporaryDirectory();
    const databasePath = join(directory, "context.db");
    const firstDatabase = await ContextDatabase.open({ path: databasePath });
    const firstService = new SqliteGitContextService({
      database: firstDatabase,
      dataRoot: directory,
      now: testNow,
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
      workState: emptyRunWorkState(),
      at: "2026-07-12T09:01:01+05:30",
    });
    const step = await firstService.recordRunStep({
      requestId: "REQ-step",
      sessionId: session.session.sessionId,
      runId: run.run.runId,
      step: 1,
      tool: "read_files",
      toolEffect: "read_only",
      purpose: "Preserve restart context.",
      status: "completed",
      input: { paths: ["src/index.ts"] },
      output: { content: "complete source text" },
      verification: { passed: true },
      workState: {
        ...emptyRunWorkState(),
        summary: "Restart context is durable.",
      },
      at: "2026-07-12T09:01:02+05:30",
    });
    await firstService.close();

    const secondDatabase = await ContextDatabase.open({ path: databasePath });
    const secondService = new SqliteGitContextService({
      database: secondDatabase,
      dataRoot: directory,
      now: testNow,
    });
    services.push(secondService);
    const restored = await secondService.getActiveContext({});

    expect(restored.session?.session.sessionId).toBe(session.session.sessionId);
    expect(restored.session?.pendingConversation).toEqual([
      conversation.conversation,
    ]);
    expect(restored.run?.run).toMatchObject(run.run);
    expect(restored.run?.steps).toMatchObject([{
      ...step.toolCall,
      input: { paths: ["src/index.ts"] },
      output: { content: "complete source text" },
      verification: { passed: true },
    }]);
    expect(restored.run?.workState).toEqual(step.workState);
    expect(restored.readContext).toMatchObject({
      evidence: [{
        runId: run.run.runId,
        step: 1,
        tool: "read_files",
        resources: ["src/index.ts"],
        output: { content: "complete source text" },
      }],
    });
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

  it("finalizes a read-only session run into complete raw run files", async () => {
    const { service, database } = await createService();
    const session = await ensureSession(service);
    const conversation = await service.appendConversation({
      requestId: "REQ-session-run-message",
      sessionId: session.session.sessionId,
      role: "user",
      content: "Inspect the source and explain it.",
      at: "2026-07-12T09:10:00+05:30",
    });
    const run = await service.startRun({
      requestId: "REQ-session-run-start",
      sessionId: session.session.sessionId,
      conversationId: conversation.conversation.conversationId,
      trigger: "user",
      workState: emptyRunWorkState(),
      at: "2026-07-12T09:10:01+05:30",
    });
    const completeText = "source-line\n".repeat(600);
    const step = await service.recordRunStep({
      requestId: "REQ-session-run-step",
      sessionId: session.session.sessionId,
      runId: run.run.runId,
      step: 1,
      tool: "read_files",
      toolSchemaVersion: 3,
      toolEffect: "read_only",
      purpose: "Read the complete source before explaining it.",
      status: "completed",
      input: { files: [{ path: "src/index.ts", lineEnd: "EOF" }] },
      output: { files: [{ path: "src/index.ts", content: completeText }] },
      verification: { passed: true, filesRead: 1 },
      workState: {
        ...emptyRunWorkState(),
        summary: "The complete source was read successfully.",
        facts: ["src/index.ts exists."],
        evidence: ["The read_files verification passed."],
        nextStep: "Explain the implementation to the user.",
      },
      at: "2026-07-12T09:10:02+05:30",
    });
    expect(database.prepare([
      "SELECT revision, after_step, summary, facts_json FROM run_work_state WHERE run_id = ?",
    ].join(" ")).get(run.run.runId)).toEqual({
      revision: 1,
      after_step: 1,
      summary: "The complete source was read successfully.",
      facts_json: JSON.stringify(["src/index.ts exists."]),
    });
    const hotContext = await service.getActiveContext({
      sessionId: session.session.sessionId,
    });
    expect(hotContext.run?.steps[0]?.output).toEqual({
      files: [{ path: "src/index.ts", content: completeText }],
    });
    expect(hotContext.run?.workState.summary).toBe(
      "The complete source was read successfully.",
    );

    const finalWorkState = {
      ...emptyRunWorkState(),
      status: "done" as const,
      summary: "Explained the inspected implementation to the user.",
    };
    const finalizationInput = {
      requestId: "REQ-session-run-finalize",
      sessionId: session.session.sessionId,
      runId: run.run.runId,
      assistantResponse: "The implementation reads configuration and starts the server.",
      workState: finalWorkState,
      at: "2026-07-12T09:10:03+05:30",
    };
    const finalized = await service.finalizeSessionRun(finalizationInput);
    await expect(service.finalizeSessionRun(finalizationInput)).resolves.toEqual(finalized);
    expect(database.prepare([
      "SELECT COUNT(*) AS count FROM messages",
      "WHERE conversation_id = ? AND role = 'assistant'",
    ].join(" ")).get(conversation.conversation.conversationId)).toEqual({ count: 1 });

    const runFile = JSON.parse(await readFile(
      join(session.session.repositoryPath, finalized.runFile),
      "utf8",
    )) as Record<string, unknown>;
    const stepFile = JSON.parse((await readFile(
      join(session.session.repositoryPath, finalized.stepsFile),
      "utf8",
    )).trim()) as Record<string, unknown>;
    expect(runFile).toMatchObject({
      runId: run.run.runId,
      runClass: "session",
      status: "completed",
      stepCount: 1,
      workState: {
        revision: 2,
        afterStep: 1,
        status: "done",
        summary: finalWorkState.summary,
      },
    });
    expect(stepFile).toEqual({
      step: 1,
      tool: "read_files",
      toolSchemaVersion: 3,
      toolEffect: "read_only",
      purpose: "Read the complete source before explaining it.",
      status: "completed",
      input: { files: [{ path: "src/index.ts", lineEnd: "EOF" }] },
      output: { files: [{ path: "src/index.ts", content: completeText }] },
      verification: { passed: true, filesRead: 1 },
      createdAt: "2026-07-12T09:10:02+05:30",
    });
    expect(await git(session.session.repositoryPath, ["rev-list", "--count", "HEAD"]))
      .toBe("1");
    expect(await git(session.session.repositoryPath, ["diff", "--cached", "--name-only"]))
      .toBe("");
    const completedContext = await service.getActiveContext({
      sessionId: session.session.sessionId,
    });
    expect(completedContext.run).toBeUndefined();
    expect(completedContext.readContext).toMatchObject({
      evidence: [{
        runId: run.run.runId,
        step: 1,
        runClass: "session",
        tool: "read_files",
        resources: ["src/index.ts"],
        output: { files: [{ path: "src/index.ts", content: completeText }] },
      }],
    });
    expect(step.workState.revision).toBe(1);
  });

  it("does not finalize a session run that recorded no read-only tool", async () => {
    const { service } = await createService();
    const session = await ensureSession(service);
    const conversation = await service.appendConversation({
      requestId: "REQ-empty-run-message",
      sessionId: session.session.sessionId,
      role: "user",
      content: "Answer directly without tools.",
      at: "2026-07-12T09:20:00+05:30",
    });
    const run = await service.startRun({
      requestId: "REQ-empty-run-start",
      sessionId: session.session.sessionId,
      conversationId: conversation.conversation.conversationId,
      trigger: "user",
      workState: emptyRunWorkState(),
      at: "2026-07-12T09:20:01+05:30",
    });

    await expect(service.finalizeSessionRun({
      requestId: "REQ-empty-run-finalize",
      sessionId: session.session.sessionId,
      runId: run.run.runId,
      assistantResponse: "This should have been a direct response.",
      workState: {
        ...emptyRunWorkState(),
        status: "done",
      },
      at: "2026-07-12T09:20:02+05:30",
    })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("creates, selects, runs, and finalizes a mount-free V1 task", async () => {
    const { service, database } = await createService();
    const session = await ensureSession(service);
    const systemEventContent = "system event context line\n".repeat(1_000)
      + "END-OF-SYSTEM-EVENT";
    const userContent = "user requirement line\n".repeat(1_100)
      + "END-OF-USER-MESSAGE";
    const assistantContent = "assistant result line\n".repeat(1_200)
      + "END-OF-ASSISTANT-MESSAGE";
    await service.appendConversation({
      requestId: "REQ-task-run-system-event",
      sessionId: session.session.sessionId,
      role: "system_event",
      content: systemEventContent,
      at: "2026-07-12T09:29:59+05:30",
    });
    const conversation = await service.appendConversation({
      requestId: "REQ-task-run-message",
      sessionId: session.session.sessionId,
      role: "user",
      content: userContent,
      at: "2026-07-12T09:30:00+05:30",
    });

    const selected = await service.createTaskRun({
      requestId: "REQ-task-run-create",
      sessionId: session.session.sessionId,
      conversationId: conversation.conversation.conversationId,
      trigger: "user",
      workState: emptyRunWorkState(),
      title: "Small Research Task",
      objective: "Keep a durable research note.",
      placement: { mode: "managed" },
      at: "2026-07-12T09:30:01+05:30",
    });
    const retried = await service.createTaskRun({
      requestId: "REQ-task-run-create",
      sessionId: session.session.sessionId,
      conversationId: conversation.conversation.conversationId,
      trigger: "user",
      workState: emptyRunWorkState(),
      title: "Small Research Task",
      objective: "Keep a durable research note.",
      placement: { mode: "managed" },
      at: "2026-07-12T09:30:01+05:30",
    });

    expect(selected).toMatchObject({
      taskCreated: true,
      sessionRunBound: false,
      run: { runClass: "task", taskId: "T-20260712-0001", taskRequestId: "R-0001" },
      context: {
        title: "Small Research Task",
        objective: "Keep a durable research note.",
      },
    });
    expect(selected.task.workingPath).toContain("tasks/T-20260712-0001");
    expect(retried).toEqual(selected);
    expect((await service.getActiveContext({ sessionId: session.session.sessionId })).activeTask)
      .toMatchObject({ task: { taskId: selected.task.taskId } });

    await service.recordRunStep({
      requestId: "REQ-task-run-read",
      sessionId: session.session.sessionId,
      runId: selected.run.runId,
      step: 1,
      tool: "read_files",
      toolEffect: "read_only",
      purpose: "Read the task descriptor before finalization.",
      status: "completed",
      input: { files: [{ path: ".ayati/task.md", mode: "full" }] },
      output: { files: [{ path: ".ayati/task.md", content: "Task descriptor" }] },
      verification: { passed: true, artifacts: [".ayati/task.md"] },
      workState: { ...emptyRunWorkState(), summary: "The research task is ready for future work." },
      at: "2026-07-12T09:30:01.500+05:30",
    });
    expect((await service.getActiveContext({ sessionId: session.session.sessionId }))
      .readContext?.evidence).toEqual([
      expect.objectContaining({
        runId: selected.run.runId,
        runClass: "task",
        tool: "read_files",
        resources: [".ayati/task.md"],
      }),
    ]);

    const authority = await service.acquireMutationAuthority({
      requestId: "REQ-task-run-context-authority",
      sessionId: session.session.sessionId,
      runId: selected.run.runId,
      taskId: selected.task.taskId,
      taskRequestId: "R-0001",
      expectedTaskHead: selected.task.head,
      targets: [],
      at: "2026-07-12T09:30:01.750+05:30",
    });
    await service.verifyMutation({
      requestId: "REQ-task-run-context-verify",
      authorityId: authority.authority.authorityId,
      lockToken: authority.authority.lockToken,
      toolStatus: "completed",
      at: "2026-07-12T09:30:01.800+05:30",
    });
    const finalized = await service.finalizeTaskRun({
      requestId: "REQ-task-run-finalize",
      sessionId: session.session.sessionId,
      runId: selected.run.runId,
      taskId: selected.task.taskId,
      outcome: "done",
      conversationSummary: "Created the durable research task.",
      summary: "The research task is ready for future work.",
      validation: "passed",
      completion: {
        accepted: true,
        assets: [],
        missing: [],
        failures: [],
        criteria: [{ criterion: "Task repository exists", passed: true }],
      },
      assistantResponse: assistantContent,
      at: "2026-07-12T09:30:02+05:30",
    });
    const conversationMessages = database.prepare([
      "SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY segment_sequence",
    ].join(" ")).all(conversation.conversation.conversationId) as unknown as Array<{ role: string; content: string }>;
    const active = await service.getActiveContext({ sessionId: session.session.sessionId });
    const finalWorkState = database.prepare([
      "SELECT status, summary, open_work_json, blockers_json, next_step",
      "FROM run_work_state WHERE run_id = ?",
    ].join(" ")).get(selected.run.runId) as {
      status: string;
      summary: string;
      open_work_json: string;
      blockers_json: string;
      next_step: string | null;
    };

    expect(finalized.taskHeadBefore).not.toBe(finalized.taskHeadAfter);
    expect(conversationMessages).toEqual([
      { role: "user", content: userContent },
      { role: "assistant", content: assistantContent },
    ]);
    expect(finalWorkState).toEqual({
      status: "done",
      summary: "The research task is ready for future work.",
      open_work_json: "[]",
      blockers_json: "[]",
      next_step: null,
    });
    expect(await git(selected.task.repositoryPath, ["rev-list", "--count", "main"])).toBe("2");
    expect(active.run).toBeUndefined();
    expect(active.activeTask).toBeUndefined();
    expect(active.readContext).toMatchObject({
      afterTaskRunId: selected.run.runId,
      inventory: [],
      discovery: [],
      evidence: [],
      actions: [],
    });
    expect(active.taskCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: selected.task.taskId, title: "Small Research Task" }),
    ]));

    const continuationConversation = await service.appendConversation({
      requestId: "REQ-task-run-continuation-message",
      sessionId: session.session.sessionId,
      role: "user",
      content: "Continue the research task.",
      at: "2026-07-12T09:30:03+05:30",
    });
    const continuation = await service.activateTaskRun({
      requestId: "REQ-task-run-continuation",
      sessionId: session.session.sessionId,
      conversationId: continuationConversation.conversation.conversationId,
      trigger: "user",
      workState: emptyRunWorkState(),
      taskId: selected.task.taskId,
      expectedTaskHead: finalized.taskHeadAfter,
      route: {
        kind: "create_active_request",
        reason: "The initial request is done and the user asked for more work in the same task.",
        title: "Continue the research",
        request: "Continue the research task with a new bounded outcome.",
        acceptance: ["The next research outcome is verified."],
        constraints: [],
      },
      at: "2026-07-12T09:30:04+05:30",
    });
    expect(continuation.context).toMatchObject({
      title: "Small Research Task",
      summary: "The research task is ready for future work.",
      currentRequest: { id: "R-0002", status: "active" },
      latestOutcome: "completed",
      validation: "passed",
      recentCommits: expect.arrayContaining([expect.objectContaining({
        outcome: "completed",
        runId: selected.run.runId,
      })]),
    });
  });

  it("replaces repeated reads and invalidates only resources changed before commit", async () => {
    const { service } = await createService();
    const session = await ensureSession(service);
    const conversation = await service.appendConversation({
      requestId: "REQ-read-window-message",
      sessionId: session.session.sessionId,
      role: "user",
      content: "Inspect and update the task files.",
      at: "2026-07-12T09:45:00+05:30",
    });
    const selected = await service.createTaskRun({
      requestId: "REQ-read-window-task",
      sessionId: session.session.sessionId,
      conversationId: conversation.conversation.conversationId,
      trigger: "user",
      workState: emptyRunWorkState(),
      title: "Read Window Test",
      objective: "Exercise deterministic read context lifecycle.",
      placement: { mode: "managed" },
      at: "2026-07-12T09:45:01+05:30",
    });
    const record = async (input: {
      requestId: string;
      step: number;
      toolEffect: "read_only" | "mutating";
      purpose: string;
      input: unknown;
      output: unknown;
      verification: unknown;
    }) => await service.recordRunStep({
      ...input,
      sessionId: session.session.sessionId,
      runId: selected.run.runId,
      tool: input.toolEffect === "read_only" ? "read_files" : "write_files",
      status: "completed",
      workState: emptyRunWorkState(),
      at: `2026-07-12T09:45:0${input.step + 1}+05:30`,
    });

    await record({
      requestId: "REQ-read-window-1",
      step: 1,
      toolEffect: "read_only",
      purpose: "Read requirements.",
      input: { files: [{ path: "requirements.md" }] },
      output: { files: [{ path: "requirements.md", content: "version one" }] },
      verification: { passed: true, artifacts: ["requirements.md"] },
    });
    await record({
      requestId: "REQ-read-window-2",
      step: 2,
      toolEffect: "read_only",
      purpose: "Read current source.",
      input: { files: [{ path: "src/index.ts" }] },
      output: { files: [{ path: "src/index.ts", content: "old source" }] },
      verification: { passed: true, artifacts: ["src/index.ts"] },
    });
    await record({
      requestId: "REQ-read-window-3",
      step: 3,
      toolEffect: "read_only",
      purpose: "Refresh requirements.",
      input: { files: [{ path: "requirements.md" }] },
      output: { files: [{ path: "requirements.md", content: "version two" }] },
      verification: { passed: true, artifacts: ["requirements.md"] },
    });
    expect((await service.getActiveContext({ sessionId: session.session.sessionId }))
      .readContext?.evidence).toEqual([
      expect.objectContaining({
        step: 3,
        resources: ["requirements.md"],
        output: { files: [{ path: "requirements.md", content: "version two" }] },
      }),
      expect.objectContaining({ step: 2, resources: ["src/index.ts"] }),
    ]);

    await service.recordRunStep({
      requestId: "REQ-read-window-buckets",
      sessionId: session.session.sessionId,
      runId: selected.run.runId,
      step: 4,
      tool: "list_directory, search_in_files",
      toolEffect: "read_only",
      purpose: "List and search documentation.",
      status: "completed",
      input: {
        toolCalls: [{
          callId: "call-list",
          tool: "list_directory",
          purpose: "List documentation.",
          input: { path: "docs" },
        }, {
          callId: "call-search",
          tool: "search_in_files",
          purpose: "Find lifecycle notes.",
          input: { root: "docs", query: "lifecycle" },
        }],
      },
      output: {
        toolCalls: [{
          callId: "call-list",
          tool: "list_directory",
          output: { entries: ["context.md"] },
        }, {
          callId: "call-search",
          tool: "search_in_files",
          output: { matches: [{ path: "docs/context.md", line: 4 }] },
        }],
      },
      verification: { passed: true },
      workState: emptyRunWorkState(),
      at: "2026-07-12T09:45:05+05:30",
    });
    const bucketed = (await service.getActiveContext({
      sessionId: session.session.sessionId,
    })).readContext;
    expect(bucketed?.inventory).toEqual([
      expect.objectContaining({ callId: "call-list", tool: "list_directory" }),
    ]);
    expect(bucketed?.discovery).toEqual([
      expect.objectContaining({ callId: "call-search", tool: "search_in_files" }),
    ]);

    await record({
      requestId: "REQ-read-window-5",
      step: 5,
      toolEffect: "mutating",
      purpose: "Update current source.",
      input: { files: [{ path: "src/index.ts", content: "new source" }] },
      output: { files: [{ path: "src/index.ts" }] },
      verification: { passed: true, artifacts: ["src/index.ts"] },
    });
    expect((await service.getActiveContext({ sessionId: session.session.sessionId }))
      .readContext?.evidence).toEqual([
      expect.objectContaining({ step: 3, resources: ["requirements.md"] }),
    ]);
    expect((await service.getActiveContext({ sessionId: session.session.sessionId }))
      .readContext?.actions).toEqual([
      expect.objectContaining({ step: 5, tool: "write_files", resources: ["src/index.ts"] }),
    ]);
  });

  it("rolls a clean daily session without creating a closing commit", async () => {
    const { service, database } = await createService();
    const first = await ensureSession(service);
    const headBefore = first.session.head;
    const commitCountBefore = await git(first.session.repositoryPath, ["rev-list", "--count", "HEAD"]);

    const next = await service.ensureActiveSession({
      requestId: "REQ-next-day",
      date: "2026-07-13",
      timezone: "Asia/Kolkata",
      agentId: "local",
      at: "2026-07-13T00:00:01+05:30",
      expectedHead: first.session.head ?? undefined,
    });

    expect(next).toMatchObject({
      created: true,
      session: { sessionId: "S-20260713-local", status: "open" },
    });
    expect(database.prepare([
      "SELECT status, sealed_at, head_sha FROM sessions WHERE session_id = ?",
    ].join(" ")).get(first.session.sessionId)).toEqual({
      status: "sealed",
      sealed_at: "2026-07-13T00:00:01+05:30",
      head_sha: headBefore,
    });
    expect(await git(first.session.repositoryPath, ["rev-list", "--count", "HEAD"]))
      .toBe(commitCountBefore);
  });

  it("rejects a conflicting ensure-session retry before changing rollover state", async () => {
    const { service, database } = await createService();
    const first = await ensureSession(service);

    await expect(service.ensureActiveSession({
      requestId: "REQ-session",
      date: "2026-07-13",
      timezone: "Asia/Kolkata",
      agentId: "local",
      at: "2026-07-13T00:00:01+05:30",
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    expect(database.prepare(
      "SELECT status FROM sessions WHERE session_id = ?",
    ).get(first.session.sessionId)).toEqual({ status: "open" });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM sessions",
    ).get()).toEqual({ count: 1 });
  });

  it("keeps a dirty daily session writable without creating a rollover commit", async () => {
    const { service } = await createService();
    const first = await ensureSession(service);
    await service.appendConversation({
      requestId: "REQ-before-midnight",
      sessionId: first.session.sessionId,
      role: "user",
      content: "Keep this conversation pending across midnight.",
      at: "2026-07-12T23:59:00+05:30",
    });
    const commitCountBefore = await git(first.session.repositoryPath, ["rev-list", "--count", "HEAD"]);

    const pending = await service.ensureActiveSession({
      requestId: "REQ-dirty-next-day",
      date: "2026-07-13",
      timezone: "Asia/Kolkata",
      agentId: "local",
      at: "2026-07-13T00:00:01+05:30",
    });
    const afterMidnight = await service.appendConversation({
      requestId: "REQ-after-midnight",
      sessionId: first.session.sessionId,
      role: "user",
      content: "This still belongs to the old session until a task commit.",
      at: "2026-07-13T00:01:00+05:30",
    });

    expect(pending).toMatchObject({
      created: false,
      session: { sessionId: first.session.sessionId, status: "rollover_pending" },
    });
    expect(afterMidnight.message.sessionSequence).toBe(2);
    expect(await git(first.session.repositoryPath, ["rev-list", "--count", "HEAD"]))
      .toBe(commitCountBefore);
    expect((await service.getActiveContext({})).session?.session).toMatchObject({
      sessionId: first.session.sessionId,
      status: "rollover_pending",
    });
  });

  it("keeps rollover pending while unrelated session work remains after V1 finalization", async () => {
    const { service, database } = await createService();
    const first = await ensureSession(service);
    const systemEvent = await service.appendConversation({
      requestId: "REQ-rollover-system-event",
      sessionId: first.session.sessionId,
      role: "system_event",
      content: "A system event is pending before the midnight task.",
      at: "2026-07-12T23:57:00+05:30",
    });
    const conversation = await service.appendConversation({
      requestId: "REQ-rollover-task-message",
      sessionId: first.session.sessionId,
      role: "user",
      content: "Create a task that finishes after midnight.",
      at: "2026-07-12T23:58:00+05:30",
    });
    const selected = await service.createTaskRun({
      requestId: "REQ-rollover-task-create",
      sessionId: first.session.sessionId,
      conversationId: conversation.conversation.conversationId,
      trigger: "user",
      workState: emptyRunWorkState(),
      title: "Midnight Task",
      objective: "Finish normally and then roll the daily session.",
      placement: { mode: "managed" },
      at: "2026-07-12T23:58:30+05:30",
    });
    const commitCountBefore = await git(first.session.repositoryPath, ["rev-list", "--count", "HEAD"]);
    const pending = await service.ensureActiveSession({
      requestId: "REQ-rollover-task-next-day",
      date: "2026-07-13",
      timezone: "Asia/Kolkata",
      agentId: "local",
      at: "2026-07-13T00:00:01+05:30",
    });

    const authority = await service.acquireMutationAuthority({
      requestId: "REQ-rollover-task-context-authority",
      sessionId: first.session.sessionId,
      runId: selected.run.runId,
      taskId: selected.task.taskId,
      taskRequestId: "R-0001",
      expectedTaskHead: selected.task.head,
      targets: [],
      at: "2026-07-13T00:01:00+05:30",
    });
    await service.verifyMutation({
      requestId: "REQ-rollover-task-context-verify",
      authorityId: authority.authority.authorityId,
      lockToken: authority.authority.lockToken,
      toolStatus: "completed",
      at: "2026-07-13T00:01:01+05:30",
    });

    const finalizationInput = {
      requestId: "REQ-rollover-task-finalize",
      sessionId: first.session.sessionId,
      runId: selected.run.runId,
      taskId: selected.task.taskId,
      outcome: "done",
      conversationSummary: "The midnight task finished.",
      summary: "The task is complete.",
      validation: "passed",
      completion: {
        accepted: true,
        assets: [],
        missing: [],
        failures: [],
        criteria: [{ criterion: "Task finalized", passed: true }],
      },
      assistantResponse: "The midnight task is complete.",
      at: "2026-07-13T00:02:00+05:30",
    } as const;
    const finalized = await service.finalizeTaskRun(finalizationInput);
    const active = await service.getActiveContext({});
    const conversationMessages = database.prepare([
      "SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY segment_sequence",
    ].join(" ")).all(conversation.conversation.conversationId) as unknown as Array<{ role: string; content: string }>;

    expect(pending.session.status).toBe("rollover_pending");
    expect(await git(first.session.repositoryPath, ["rev-list", "--count", "HEAD"]))
      .toBe(commitCountBefore);
    expect(finalized.sessionCommit).toBeUndefined();
    expect(conversationMessages).toEqual([
      { role: "user", content: conversation.message.content },
      { role: "assistant", content: "The midnight task is complete." },
    ]);
    expect(database.prepare([
      "SELECT status, head_sha FROM sessions WHERE session_id = ?",
    ].join(" ")).get(first.session.sessionId)).toEqual({
      status: "rollover_pending",
      head_sha: first.session.head,
    });
    expect(active.session?.session).toMatchObject({
      sessionId: first.session.sessionId,
      status: "rollover_pending",
    });
    expect(active.session?.pendingConversation.length).toBeGreaterThan(0);
    await expect(service.finalizeTaskRun(finalizationInput)).resolves.toEqual(finalized);
  });

  it("catches up a clean stale session during startup recovery", async () => {
    const directory = await createTemporaryDirectory();
    const databasePath = join(directory, "context.db");
    const firstDatabase = await ContextDatabase.open({ path: databasePath });
    const firstService = new SqliteGitContextService({
      database: firstDatabase,
      dataRoot: directory,
      now: testNow,
    });
    const first = await ensureSession(firstService);
    await firstService.close();

    const secondDatabase = await ContextDatabase.open({ path: databasePath });
    const secondService = new SqliteGitContextService({
      database: secondDatabase,
      dataRoot: directory,
      now: () => "2026-07-13T00:00:01+05:30",
    });
    services.push(secondService);

    const active = await secondService.getActiveContext({});

    expect(active.session?.session).toMatchObject({
      sessionId: "S-20260713-local",
      status: "open",
    });
    expect(secondDatabase.prepare(
      "SELECT status FROM sessions WHERE session_id = ?",
    ).get(first.session.sessionId)).toEqual({ status: "sealed" });
    expect(await git(first.session.repositoryPath, ["rev-list", "--count", "HEAD"])).toBe("1");
  });

  it("restores a dirty rollover-pending session as writable after restart", async () => {
    const directory = await createTemporaryDirectory();
    const databasePath = join(directory, "context.db");
    const firstDatabase = await ContextDatabase.open({ path: databasePath });
    const firstService = new SqliteGitContextService({
      database: firstDatabase,
      dataRoot: directory,
      now: testNow,
    });
    const first = await ensureSession(firstService);
    await firstService.appendConversation({
      requestId: "REQ-restart-rollover-before-midnight",
      sessionId: first.session.sessionId,
      role: "user",
      content: "Keep this pending until a later task commit.",
      at: "2026-07-12T23:59:00+05:30",
    });
    await firstService.ensureActiveSession({
      requestId: "REQ-restart-rollover-request",
      date: "2026-07-13",
      timezone: "Asia/Kolkata",
      agentId: "local",
      at: "2026-07-13T00:00:01+05:30",
    });
    await firstService.close();

    const secondDatabase = await ContextDatabase.open({ path: databasePath });
    const secondService = new SqliteGitContextService({
      database: secondDatabase,
      dataRoot: directory,
      now: () => "2026-07-13T00:02:00+05:30",
    });
    services.push(secondService);
    const restored = await secondService.getActiveContext({});
    const appended = await secondService.appendConversation({
      requestId: "REQ-restart-rollover-after-midnight",
      sessionId: first.session.sessionId,
      role: "user",
      content: "Continue in the old session after restart.",
      at: "2026-07-13T00:03:00+05:30",
    });

    expect(restored.session?.session).toMatchObject({
      sessionId: first.session.sessionId,
      status: "rollover_pending",
    });
    expect(appended.message.sessionSequence).toBe(2);
    expect(secondDatabase.prepare(
      "SELECT COUNT(*) AS count FROM sessions WHERE status IN ('open', 'rollover_pending')",
    ).get()).toEqual({ count: 1 });
  });

  it("checks for clean midnight rollover while the service remains running", async () => {
    let currentTime = "2026-07-12T23:59:59+05:30";
    const { service } = await createService({
      now: () => currentTime,
      rolloverCheckIntervalMs: 5,
    });
    const first = await ensureSession(service);
    currentTime = "2026-07-13T00:00:01+05:30";

    await vi.waitFor(async () => {
      const active = await service.getActiveContext({});
      expect(active.session?.session.sessionId).toBe("S-20260713-local");
    }, { timeout: 2_000, interval: 10 });

    expect(await git(first.session.repositoryPath, ["rev-list", "--count", "HEAD"])).toBe("1");
  });
});

async function createService(options: {
  now?: () => string;
  rolloverCheckIntervalMs?: number;
} = {}): Promise<{
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
    now: options.now ?? testNow,
    ...(options.rolloverCheckIntervalMs !== undefined
      ? { rolloverCheckIntervalMs: options.rolloverCheckIntervalMs }
      : {}),
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

async function git(repositoryPath: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd: repositoryPath,
    encoding: "utf8",
  });
  return result.stdout.trim();
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
