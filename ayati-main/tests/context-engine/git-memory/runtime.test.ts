import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildGitMemoryContextPackFromMemoryState,
  createGitMemoryRuntime,
  GIT_MEMORY_MAIN_REF,
  GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH,
  GitMemoryDailySessionStore,
  GitMemoryWorktreeGitDriver,
  parseGitMemoryCommitTrailers,
  sessionDateForAt,
} from "../../../src/context-engine/git-memory/index.js";

describe("GitMemoryRuntime", () => {
  it("opens the daily session repo before any user message", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-runtime-"));
    const runtime = createGitMemoryRuntime({
      contextStoreDir,
      timezone: "Asia/Kolkata",
      agentId: "local",
    });

    const first = await runtime.openDailySession({
      at: "2026-06-28T00:00:00+05:30",
    });
    const second = await runtime.openDailySession({
      at: "2026-06-28T00:01:00+05:30",
    });

    expect(first).toMatchObject({
      sessionId: "S-20260628-local",
      initialized: true,
    });
    expect(second).toMatchObject({
      sessionId: "S-20260628-local",
      repoPath: first.repoPath,
      initialized: false,
    });
    expect(await new GitMemoryWorktreeGitDriver(first.repoPath).log(GIT_MEMORY_MAIN_REF, 5))
      .toHaveLength(1);
  });

  it("prepares a user turn and records assistant output in the same canonical conversation", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-runtime-"));
    const runtime = createGitMemoryRuntime({
      contextStoreDir,
      timezone: "Asia/Kolkata",
      agentId: "local",
    });

    const prepared = await runtime.prepareUserTurn({
      userMessage: "Fix upload handling",
      at: "2026-06-28T09:00:00+05:30",
    });
    await runtime.recordAssistantMessage({
      sessionId: prepared.sessionId,
      text: "I will inspect upload handling.",
      at: "2026-06-28T09:00:05+05:30",
    });

    expect(prepared).toMatchObject({
      status: "ready",
      sessionId: "S-20260628-local",
      userMessage: {
        seq: 1,
        role: "user",
      },
      context: {
        session: {
          conversationTail: [{
            seq: 1,
            role: "user",
            text: "Fix upload handling",
          }],
        },
        focus: { status: "none" },
      },
      memoryState: {
        session: {
          conversationTail: [{
            seq: 1,
            role: "user",
            text: "Fix upload handling",
          }],
          taskCount: 0,
        },
        focus: { status: "none" },
        knownTasks: [],
      },
    });
    expect(prepared.memoryState.activeTask).toBeUndefined();

    const context = await runtime.buildActiveContext(prepared.sessionId);
    expect(context.session.conversationTail).toMatchObject([
      { seq: 1, role: "user", text: "Fix upload handling" },
      { seq: 2, role: "assistant", text: "I will inspect upload handling." },
    ]);

    const driver = new GitMemoryWorktreeGitDriver(prepared.repoPath);
    expect(await driver.readWorkingFile("session/conversation.jsonl")).toBeNull();
    expect(await driver.log(GIT_MEMORY_MAIN_REF, 5)).toHaveLength(3);
  });

  it("derives prepared turn context from memory state", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-runtime-"));
    const runtime = createGitMemoryRuntime({
      contextStoreDir,
      timezone: "Asia/Kolkata",
      agentId: "local",
    });

    const prepared = await runtime.prepareUserTurn({
      userMessage: "Fix upload handling",
      at: "2026-06-28T09:00:00+05:30",
    });

    expect(prepared.context).toEqual(buildGitMemoryContextPackFromMemoryState(prepared.memoryState));
  });

  it("derives explicit active context reads from memory state", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-runtime-"));
    const runtime = createGitMemoryRuntime({
      contextStoreDir,
      timezone: "Asia/Kolkata",
      agentId: "local",
    });
    const prepared = await runtime.prepareUserTurn({
      userMessage: "Fix upload handling",
      at: "2026-06-28T09:00:00+05:30",
    });

    const [context, memoryState] = await Promise.all([
      runtime.buildActiveContext(prepared.sessionId),
      runtime.buildMemoryState(prepared.sessionId),
    ]);

    expect(context).toEqual(buildGitMemoryContextPackFromMemoryState(memoryState));
  });

  it("uses timezone-aware dates when choosing the daily session repo", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-runtime-"));
    const runtime = createGitMemoryRuntime({
      contextStoreDir,
      timezone: "Asia/Kolkata",
      agentId: "local",
    });

    expect(sessionDateForAt("2026-06-27T20:00:00.000Z", "Asia/Kolkata")).toBe("2026-06-28");

    const prepared = await runtime.prepareUserTurn({
      userMessage: "This belongs to the India-local next day.",
      at: "2026-06-27T20:00:00.000Z",
    });

    expect(prepared.sessionId).toBe("S-20260628-local");
  });

  it("runs task creation and task-run commits through the runtime facade", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-runtime-"));
    const runtime = createGitMemoryRuntime({
      contextStoreDir,
      timezone: "Asia/Kolkata",
      agentId: "local",
    });
    const prepared = await runtime.prepareUserTurn({
      userMessage: "Fix upload handling",
      at: "2026-06-28T09:00:00+05:30",
    });
    const task = await runtime.createTaskBranch({
      sessionId: prepared.sessionId,
      title: "Fix upload handling",
      objective: "Find and fix upload handling failures.",
      fromSeq: prepared.userMessage.seq,
      toSeq: prepared.userMessage.seq,
      at: "2026-06-28T09:01:00+05:30",
    });
    const run = await runtime.commitTaskRun({
      sessionId: prepared.sessionId,
      taskId: task.taskId,
      status: "completed",
      completedAt: "2026-06-28T09:10:00+05:30",
      conversationRefs: [{ fromSeq: prepared.userMessage.seq, toSeq: prepared.userMessage.seq }],
      summary: "Finished upload handling inspection.",
      state: {
        status: "done",
        completed: ["Finished upload handling inspection"],
        open: [],
        next: "No next step.",
      },
    });
    await runtime.recordAssistantMessage({
      sessionId: prepared.sessionId,
      taskId: task.taskId,
      runId: run.runId,
      text: "Finished upload handling inspection.",
      at: "2026-06-28T09:10:05+05:30",
    });

    const context = await runtime.buildActiveContext(prepared.sessionId);
    expect(context.focus).toMatchObject({
      status: "active",
      taskId: "W-20260628-0001",
    });
    expect(context.task).toMatchObject({
      taskId: "W-20260628-0001",
      status: "done",
      completed: ["Finished upload handling inspection"],
      recentRuns: [{
        runId: "R-20260628-0001",
        status: "completed",
        summary: "Finished upload handling inspection.",
      }],
    });
    expect(context.session.conversationTail).toMatchObject([
      { seq: 1, role: "user", text: "Fix upload handling" },
      {
        seq: 2,
        role: "assistant",
        taskId: "W-20260628-0001",
        runId: "R-20260628-0001",
      },
    ]);

    const memoryState = await runtime.buildMemoryState(prepared.sessionId);
    expect(memoryState).toMatchObject({
      focus: {
        status: "active",
        taskId: "W-20260628-0001",
      },
      activeTask: {
        taskId: "W-20260628-0001",
        status: "done",
        completed: ["Finished upload handling inspection"],
      },
      knownTasks: [{
        taskId: "W-20260628-0001",
        status: "done",
      }],
    });

    await runtime.checkpointSession({
      sessionId: prepared.sessionId,
      summary: "Checkpoint runtime facade lifecycle.",
      at: "2026-06-28T09:11:00+05:30",
    });

    const driver = new GitMemoryWorktreeGitDriver(prepared.repoPath);
    expect(await driver.log(GIT_MEMORY_MAIN_REF, 5)).toHaveLength(3);
  });

  it("appends routed follow-up messages to the selected task branch before run start", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-runtime-"));
    const runtime = createGitMemoryRuntime({
      contextStoreDir,
      timezone: "Asia/Kolkata",
      agentId: "local",
    });
    const first = await runtime.prepareUserTurn({
      userMessage: "Fix upload handling",
      at: "2026-06-28T09:00:00+05:30",
    });
    const created = await runtime.routeUserTurn({
      sessionId: first.sessionId,
      userMessage: "Fix upload handling",
      fromSeq: first.userMessage.seq,
      toSeq: first.userMessage.seq,
      at: "2026-06-28T09:00:01+05:30",
    });
    if (created.status !== "ready") {
      throw new Error(`Expected ready task route, got ${created.status}.`);
    }
    const second = await runtime.prepareUserTurn({
      userMessage: "finish it",
      at: "2026-06-28T09:05:00+05:30",
    });
    const continued = await runtime.routeUserTurn({
      sessionId: second.sessionId,
      userMessage: "finish it",
      fromSeq: second.userMessage.seq,
      toSeq: second.userMessage.seq,
      at: "2026-06-28T09:05:01+05:30",
    });
    if (continued.status !== "ready") {
      throw new Error(`Expected ready task route, got ${continued.status}.`);
    }

    const driver = new GitMemoryWorktreeGitDriver(second.repoPath);
    const markdown = await driver.readFile(continued.ref, GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH) ?? "";
    expect(markdown).toContain("finish it");
    expect(markdown.match(/finish it/g)).toHaveLength(1);
    const taskLog = await driver.log(continued.ref, 5);
    expect(parseGitMemoryCommitTrailers(taskLog[0]?.message ?? "")).toMatchObject({
      event: "conversation_appended",
      runId: continued.runId,
      conversationSeq: { fromSeq: second.userMessage.seq, toSeq: second.userMessage.seq },
    });
  });

  it("keeps inbound user messages on main until routing selects the task branch", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-runtime-"));
    const runtime = createGitMemoryRuntime({
      contextStoreDir,
      timezone: "Asia/Kolkata",
      agentId: "local",
    });
    const first = await runtime.prepareUserTurn({
      userMessage: "Fix upload bug",
      at: "2026-06-28T09:00:00+05:30",
    });
    const firstRoute = await runtime.routeUserTurn({
      sessionId: first.sessionId,
      userMessage: "Fix upload bug",
      fromSeq: first.userMessage.seq,
      toSeq: first.userMessage.seq,
      at: "2026-06-28T09:00:01+05:30",
    });
    if (firstRoute.status !== "ready") {
      throw new Error(`Expected ready task route, got ${firstRoute.status}.`);
    }

    const second = await runtime.prepareUserTurn({
      userMessage: "Analyze contract risk",
      at: "2026-06-28T09:05:00+05:30",
    });
    const driver = new GitMemoryWorktreeGitDriver(second.repoPath);
    const firstTaskBeforeRouting = await driver.readFile(
      firstRoute.ref,
      GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH,
    ) ?? "";
    const mainBeforeRouting = await driver.readFile(
      GIT_MEMORY_MAIN_REF,
      GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH,
    ) ?? "";

    expect(mainBeforeRouting).toContain("Analyze contract risk");
    expect(firstTaskBeforeRouting).not.toContain("Analyze contract risk");

    const secondRoute = await runtime.routeUserTurn({
      sessionId: second.sessionId,
      userMessage: "Analyze contract risk",
      fromSeq: second.userMessage.seq,
      toSeq: second.userMessage.seq,
      at: "2026-06-28T09:05:01+05:30",
    });
    if (secondRoute.status !== "ready") {
      throw new Error(`Expected ready task route, got ${secondRoute.status}.`);
    }

    const firstTaskAfterRouting = await driver.readFile(
      firstRoute.ref,
      GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH,
    ) ?? "";
    const secondTaskAfterRouting = await driver.readFile(
      secondRoute.ref,
      GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH,
    ) ?? "";
    expect(secondRoute.taskId).not.toBe(firstRoute.taskId);
    expect(firstTaskAfterRouting).not.toContain("Analyze contract risk");
    expect(secondTaskAfterRouting).toContain("Analyze contract risk");
  });

  it("syncs task-owned assistant messages to the selected task branch conversation", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-runtime-"));
    const runtime = createGitMemoryRuntime({
      contextStoreDir,
      timezone: "Asia/Kolkata",
      agentId: "local",
    });
    const first = await runtime.prepareUserTurn({
      userMessage: "Fix upload bug",
      at: "2026-06-28T09:00:00+05:30",
    });
    const firstRoute = await runtime.routeUserTurn({
      sessionId: first.sessionId,
      userMessage: "Fix upload bug",
      fromSeq: first.userMessage.seq,
      toSeq: first.userMessage.seq,
      at: "2026-06-28T09:00:01+05:30",
    });
    if (firstRoute.status !== "ready") {
      throw new Error(`Expected ready task route, got ${firstRoute.status}.`);
    }
    const second = await runtime.prepareUserTurn({
      userMessage: "Analyze contract risk",
      at: "2026-06-28T09:05:00+05:30",
    });
    const secondRoute = await runtime.routeUserTurn({
      sessionId: second.sessionId,
      userMessage: "Analyze contract risk",
      fromSeq: second.userMessage.seq,
      toSeq: second.userMessage.seq,
      at: "2026-06-28T09:05:01+05:30",
    });
    if (secondRoute.status !== "ready") {
      throw new Error(`Expected ready task route, got ${secondRoute.status}.`);
    }

    await runtime.recordAssistantMessage({
      sessionId: second.sessionId,
      taskId: secondRoute.taskId,
      runId: secondRoute.runId,
      text: "I reviewed the contract risk and found one blocker.",
      at: "2026-06-28T09:06:00+05:30",
    });

    const driver = new GitMemoryWorktreeGitDriver(second.repoPath);
    const mainConversation = await driver.readFile(
      GIT_MEMORY_MAIN_REF,
      GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH,
    ) ?? "";
    const firstTaskConversation = await driver.readFile(
      firstRoute.ref,
      GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH,
    ) ?? "";
    const secondTaskConversation = await driver.readFile(
      secondRoute.ref,
      GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH,
    ) ?? "";

    expect(mainConversation).toContain("I reviewed the contract risk and found one blocker.");
    expect(secondTaskConversation).toContain("I reviewed the contract risk and found one blocker.");
    expect(secondTaskConversation).toContain(`Run: ${secondRoute.runId}`);
    expect(firstTaskConversation).not.toContain("I reviewed the contract risk and found one blocker.");
  });

  it("keeps assistant messages without task ownership only in the main conversation", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-runtime-"));
    const runtime = createGitMemoryRuntime({
      contextStoreDir,
      timezone: "Asia/Kolkata",
      agentId: "local",
    });
    const prepared = await runtime.prepareUserTurn({
      userMessage: "Fix upload bug",
      at: "2026-06-28T09:00:00+05:30",
    });
    const route = await runtime.routeUserTurn({
      sessionId: prepared.sessionId,
      userMessage: "Fix upload bug",
      fromSeq: prepared.userMessage.seq,
      toSeq: prepared.userMessage.seq,
      at: "2026-06-28T09:00:01+05:30",
    });
    if (route.status !== "ready") {
      throw new Error(`Expected ready task route, got ${route.status}.`);
    }

    await runtime.recordAssistantMessage({
      sessionId: prepared.sessionId,
      text: "This is a global assistant note.",
      at: "2026-06-28T09:02:00+05:30",
    });

    const driver = new GitMemoryWorktreeGitDriver(prepared.repoPath);
    const mainConversation = await driver.readFile(
      GIT_MEMORY_MAIN_REF,
      GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH,
    ) ?? "";
    const taskConversation = await driver.readFile(
      route.ref,
      GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH,
    ) ?? "";

    expect(mainConversation).toContain("This is a global assistant note.");
    expect(taskConversation).not.toContain("This is a global assistant note.");
  });

  it("does not allocate a task run id when routing is ambiguous", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-runtime-"));
    const store = new GitMemoryDailySessionStore({ contextStoreDir });
    const runtime = createGitMemoryRuntime({
      contextStoreDir,
      timezone: "Asia/Kolkata",
      agentId: "local",
      store,
    });
    const first = await runtime.prepareUserTurn({
      userMessage: "Fix upload bug",
      at: "2026-06-28T09:00:00+05:30",
    });
    const firstRoute = await runtime.routeUserTurn({
      sessionId: first.sessionId,
      userMessage: "Fix upload bug",
      fromSeq: first.userMessage.seq,
      toSeq: first.userMessage.seq,
      at: "2026-06-28T09:00:01+05:30",
    });
    if (firstRoute.status !== "ready") {
      throw new Error(`Expected ready task route, got ${firstRoute.status}.`);
    }
    const second = await runtime.prepareUserTurn({
      userMessage: "Upload UI redesign",
      at: "2026-06-28T09:05:00+05:30",
    });
    const secondRoute = await runtime.routeUserTurn({
      sessionId: second.sessionId,
      userMessage: "Upload UI redesign",
      fromSeq: second.userMessage.seq,
      toSeq: second.userMessage.seq,
      at: "2026-06-28T09:05:01+05:30",
    });
    if (secondRoute.status !== "ready") {
      throw new Error(`Expected ready task route, got ${secondRoute.status}.`);
    }
    const allocateRunId = vi.spyOn(store, "allocateTaskRunId");

    const ambiguous = await runtime.prepareUserTurn({
      userMessage: "upload",
      at: "2026-06-28T09:10:00+05:30",
    });
    const ambiguousRoute = await runtime.routeUserTurn({
      sessionId: ambiguous.sessionId,
      userMessage: "upload",
      fromSeq: ambiguous.userMessage.seq,
      toSeq: ambiguous.userMessage.seq,
      at: "2026-06-28T09:10:01+05:30",
    });

    expect(ambiguousRoute.status).toBe("ambiguous");
    expect(allocateRunId).not.toHaveBeenCalled();
  });
});
