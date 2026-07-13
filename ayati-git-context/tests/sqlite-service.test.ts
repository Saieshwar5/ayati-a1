import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ContextDatabase } from "../src/database/database.js";
import { beginRecoverableIdempotent } from "../src/database/idempotency.js";
import { appendConversationMessage } from "../src/repositories/conversation-records.js";
import { insertSession } from "../src/repositories/session-records.js";
import {
  allocateTask,
  readTaskInitialization,
} from "../src/repositories/task-records.js";
import { SqliteGitContextService } from "../src/services/sqlite-git-context-service.js";

const execFileAsync = promisify(execFile);

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
    const service = new SqliteGitContextService({ database, dataRoot: directory });
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

  it("creates an independent canonical task repository and catalog entry", async () => {
    const { service, database } = await createService();
    const session = await ensureSession(service);
    const input = {
      requestId: "REQ-task-1",
      sessionId: session.session.sessionId,
      expectedHead: session.session.head ?? undefined,
      title: "Coffee Shop Website",
      objective: "Build a responsive coffee-shop website with a menu and reservations.",
      at: "2026-07-12T09:05:00+05:30",
    };

    const created = await service.createTask(input);
    const retried = await service.createTask(input);

    expect(retried).toEqual(created);
    expect(created).toMatchObject({
      created: true,
      task: {
        taskId: "W-20260712-0001",
        branch: "main",
        title: "Coffee Shop Website",
        status: "active",
        createdSessionId: session.session.sessionId,
      },
    });
    const repositoryPath = created.task.repositoryPath;
    expect(repositoryPath).toMatch(/W-20260712-0001-coffee-shop-website\.git$/);
    expect(await git(repositoryPath, ["rev-parse", "--is-bare-repository"])).toBe("true");
    expect(await git(repositoryPath, ["rev-parse", "refs/heads/main"])).toBe(
      created.task.head,
    );
    expect(await git(repositoryPath, ["rev-list", "--count", "main"])).toBe("1");
    const commit = await git(repositoryPath, ["log", "-1", "--pretty=%B"]);
    expect(commit).toContain("task: create coffee shop website");
    expect(commit).toContain("Task-Id: W-20260712-0001");
    expect(commit).toContain("Created-Session: " + session.session.sessionId);
    expect(commit).toContain("Ayati-Event: task_created");
    const descriptor = await git(repositoryPath, ["show", "main:.ayati/task.md"]);
    expect(descriptor).toContain("# Coffee Shop Website");
    expect(descriptor).toContain("Task: W-20260712-0001");
    expect(descriptor).toContain(input.objective);
    expect(await service.getTask({ taskId: "W-20260712-0001" })).toEqual({
      task: created.task,
    });
    expect(database.prepare([
      "SELECT status, head_sha FROM tasks WHERE task_id = ?",
    ].join(" ")).get("W-20260712-0001")).toMatchObject({
      status: "active",
      head_sha: created.task.head,
    });
  });

  it("allocates stable daily task sequences and safe repository slugs", async () => {
    const { service } = await createService();
    const session = await ensureSession(service);
    const first = await service.createTask({
      requestId: "REQ-task-1",
      sessionId: session.session.sessionId,
      title: "Coffee Shop Website",
      objective: "Build the coffee-shop website.",
      at: "2026-07-12T09:05:00+05:30",
    });
    const second = await service.createTask({
      requestId: "REQ-task-2",
      sessionId: session.session.sessionId,
      title: "AI Notes / Research",
      objective: "Maintain research about AI agent memory.",
      at: "2026-07-12T09:06:00+05:30",
    });

    expect(first.task.taskId).toBe("W-20260712-0001");
    expect(second.task.taskId).toBe("W-20260712-0002");
    expect(second.task.repositoryPath).toMatch(
      /W-20260712-0002-ai-notes-research\.git$/,
    );
  });

  it("recovers task creation interrupted after SQLite allocation", async () => {
    const directory = await createTemporaryDirectory();
    const databasePath = join(directory, "context.db");
    const firstDatabase = await ContextDatabase.open({ path: databasePath });
    const firstService = new SqliteGitContextService({
      database: firstDatabase,
      dataRoot: directory,
    });
    const session = await ensureSession(firstService);
    const input = {
      requestId: "REQ-crash-task",
      sessionId: session.session.sessionId,
      title: "Crash Recovery Task",
      objective: "Prove task creation resumes after process interruption.",
      at: "2026-07-12T09:07:00+05:30",
    };
    beginRecoverableIdempotent({
      database: firstDatabase,
      requestId: input.requestId,
      operation: "create_task",
      payload: input,
      now: input.at,
      execute: () => {
        const task = allocateTask(firstDatabase, directory, input, {
          title: input.title,
          objective: input.objective,
        });
        return { taskId: task.taskId, created: true };
      },
    });
    const initializing = readTaskInitialization(firstDatabase, "W-20260712-0001");
    if (!initializing) {
      throw new Error("Expected initializing task record.");
    }
    await mkdir(initializing.repositoryPath, { recursive: true });
    await git(initializing.repositoryPath, ["init", "--bare", "--initial-branch=main"]);
    await firstService.close();

    const secondDatabase = await ContextDatabase.open({ path: databasePath });
    const secondService = new SqliteGitContextService({
      database: secondDatabase,
      dataRoot: directory,
    });
    services.push(secondService);
    await secondService.getActiveContext({ sessionId: session.session.sessionId });
    const recovered = await secondService.getTask({ taskId: "W-20260712-0001" });
    const retried = await secondService.createTask(input);

    expect(recovered.task.status).toBe("active");
    expect(retried.task).toEqual(recovered.task);
    expect(await git(recovered.task.repositoryPath, [
      "rev-list",
      "--count",
      "main",
    ])).toBe("1");
    expect(secondDatabase.prepare(
      "SELECT COUNT(*) AS count FROM tasks",
    ).get()).toMatchObject({ count: 1 });
    expect(await readdir(join(directory, "staging"))).toEqual([]);
  });

  it("accepts an evolved task descriptor when its stable identity is preserved", async () => {
    const { service, database } = await createService();
    const session = await ensureSession(service);
    const created = await service.createTask({
      requestId: "REQ-evolving-task",
      sessionId: session.session.sessionId,
      title: "Evolving Task",
      objective: "Keep durable task context current across runs.",
      at: "2026-07-12T09:08:00+05:30",
    });
    const checkoutRoot = await createTemporaryDirectory();
    await git(checkoutRoot, ["clone", created.task.repositoryPath, "checkout"]);
    const checkout = join(checkoutRoot, "checkout");
    await git(checkout, ["config", "user.name", "Ayati Test"]);
    await git(checkout, ["config", "user.email", "test@ayati.local"]);
    await writeFile(join(checkout, ".ayati", "task.md"), [
      "# Evolving Task",
      "",
      "Task: " + created.task.taskId,
      "",
      "Keep durable task context current across runs.",
      "",
      "## Current Snapshot",
      "",
      "The first task run is complete.",
      "",
    ].join("\n"), "utf8");
    await git(checkout, ["add", "--", ".ayati/task.md"]);
    await git(checkout, ["commit", "-m", "task: update portable descriptor"]);
    await git(checkout, ["push", "origin", "main"]);
    const evolvedHead = await git(checkout, ["rev-parse", "HEAD"]);
    database.prepare(
      "UPDATE tasks SET head_sha = ?, updated_at = ? WHERE task_id = ?",
    ).run(evolvedHead, "2026-07-12T09:09:00+05:30", created.task.taskId);

    await expect(service.getTask({ taskId: created.task.taskId })).resolves.toMatchObject({
      task: {
        taskId: created.task.taskId,
        head: evolvedHead,
        status: "active",
      },
    });
  });

  it("rejects catalog and canonical task HEAD disagreement", async () => {
    const { service, database } = await createService();
    const session = await ensureSession(service);
    const created = await service.createTask({
      requestId: "REQ-task",
      sessionId: session.session.sessionId,
      title: "Head Verification",
      objective: "Verify catalog and repository identity agree.",
      at: "2026-07-12T09:08:00+05:30",
    });
    database.prepare(
      "UPDATE tasks SET head_sha = ? WHERE task_id = ?",
    ).run("0".repeat(40), created.task.taskId);

    await expect(service.getTask({
      taskId: created.task.taskId,
    })).rejects.toMatchObject({ code: "TASK_HEAD_MISMATCH" });
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
        filePath: "conversations/000001-session.md",
        status: "closed",
      },
      secondUser.conversation,
    ]);
    expect(context.session?.pendingConversationContext).toMatchObject([
      {
        messages: [
          { sequence: 1, role: "user", content: "hello" },
          { sequence: 2, role: "assistant", content: "hello back" },
        ],
      },
      {
        messages: [{ sequence: 1, role: "user", content: "new turn" }],
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

  it("recovers a journaled conversation append without duplicating it", async () => {
    const directory = await createTemporaryDirectory();
    const databasePath = join(directory, "context.db");
    const firstDatabase = await ContextDatabase.open({ path: databasePath });
    const firstService = new SqliteGitContextService({
      database: firstDatabase,
      dataRoot: directory,
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
      execute: () => ({
        conversation: appendConversationMessage(firstDatabase, input),
      }),
    });
    await firstService.close();

    const secondDatabase = await ContextDatabase.open({ path: databasePath });
    const secondService = new SqliteGitContextService({
      database: secondDatabase,
      dataRoot: directory,
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
    expect((await service.getActiveContext({ sessionId: session.session.sessionId })).run)
      .toBeUndefined();
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
