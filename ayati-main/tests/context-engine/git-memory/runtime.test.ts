import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  type AppendGitMemoryConversationInput,
  type AppendGitMemoryConversationRecordInput,
  buildGitMemoryContextPackFromMemoryState,
  createGitMemoryRuntime,
  GIT_MEMORY_MAIN_REF,
  GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH,
  GIT_MEMORY_SESSION_STORE_DIR,
  GitMemoryDailySessionStore,
  GitMemoryWorktreeGitDriver,
  gitMemorySessionStoreSummaryMarkdownPath,
  gitMemorySessionStoreSummaryMetaPath,
  gitMemoryTaskRunPath,
  gitMemoryTaskStatePath,
  type GitMemoryWriteBatchRequest,
  type GitMemoryWriteBatchSnapshot,
  type GitMemoryWriteQueueRunner,
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
    await waitForCommittedWrites(runtime, prepared.sessionId, 2);

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
    expect(context.session.summary).toMatchObject({
      text: expect.stringContaining("Assistant: I will inspect upload handling."),
      updatedAt: "2026-06-28T09:00:05+05:30",
      coveredUntilSeq: 2,
    });
    expect(context.session.summary?.text).toContain("## Current Focus");
    expect(context.session.summary?.text).toContain("- Fix upload handling");
    expect(context.session.summary?.text).toContain("## Recent Decisions");
    expect(context.session.summary?.text).toContain("## Open Questions");
    expect(context.session.summary?.text).toContain("## Recent Messages");

    const driver = new GitMemoryWorktreeGitDriver(prepared.repoPath);
    expect(await driver.readWorkingFile("session/conversation.jsonl")).toBeNull();
    expect(await driver.log(GIT_MEMORY_MAIN_REF, 5)).toHaveLength(3);
    const messageStore = await driver.openSubmoduleRepo(GIT_MEMORY_SESSION_STORE_DIR);
    const summaryMarkdown = await messageStore.readFile(
      GIT_MEMORY_MAIN_REF,
      gitMemorySessionStoreSummaryMarkdownPath(prepared.sessionId),
    );
    expect(summaryMarkdown).toContain("## Current Focus");
    expect(summaryMarkdown).toContain("User: Fix upload handling");
    expect(JSON.parse(await messageStore.readFile(
      GIT_MEMORY_MAIN_REF,
      gitMemorySessionStoreSummaryMetaPath(prepared.sessionId),
    ) ?? "{}")).toMatchObject({
      formatVersion: 1,
      strategy: "deterministic",
      sessionId: prepared.sessionId,
      coveredUntilSeq: 2,
      messageCount: 2,
      sourceFromSeq: 1,
      sourceToSeq: 2,
    });
  });

  it("builds a structured deterministic session summary from recent conversation", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-runtime-"));
    const runtime = createGitMemoryRuntime({
      contextStoreDir,
      timezone: "Asia/Kolkata",
      agentId: "local",
    });

    const first = await runtime.prepareUserTurn({
      userMessage: "Approved. We should keep deterministic summaries for now.",
      at: "2026-06-28T09:00:00+05:30",
    });
    await runtime.recordAssistantMessage({
      sessionId: first.sessionId,
      text: "Implemented the deterministic summary writer.",
      at: "2026-06-28T09:00:05+05:30",
    });
    await waitForCommittedWrites(runtime, first.sessionId, 2);

    await runtime.prepareUserTurn({
      userMessage: "Should we update the prompt next?",
      at: "2026-06-28T09:01:00+05:30",
    });
    await runtime.recordAssistantMessage({
      sessionId: first.sessionId,
      text: "We will review the prompt context after this summary slice.",
      at: "2026-06-28T09:01:05+05:30",
    });
    await waitForCommittedWrites(runtime, first.sessionId, 4);

    const context = await runtime.buildActiveContext(first.sessionId);
    expect(context.session.summary?.text).toContain("## Current Focus");
    expect(context.session.summary?.text).toContain("- Should we update the prompt next?");
    expect(context.session.summary?.text).toContain("## Recent Decisions");
    expect(context.session.summary?.text).toContain("User: Approved. We should keep deterministic summaries for now.");
    expect(context.session.summary?.text).toContain("Assistant: Implemented the deterministic summary writer.");
    expect(context.session.summary?.text).toContain("Assistant: We will review the prompt context after this summary slice.");
    expect(context.session.summary?.text).toContain("## Open Questions");
    expect(context.session.summary?.text).toContain("User: Should we update the prompt next?");
    expect(context.session.summary?.text).toContain("## Recent Messages");
    expect(context.session.summary).toMatchObject({
      updatedAt: "2026-06-28T09:01:05+05:30",
      coveredUntilSeq: 4,
    });
    const driver = new GitMemoryWorktreeGitDriver(first.repoPath);
    const messageStore = await driver.openSubmoduleRepo(GIT_MEMORY_SESSION_STORE_DIR);
    expect(JSON.parse(await messageStore.readFile(
      GIT_MEMORY_MAIN_REF,
      gitMemorySessionStoreSummaryMetaPath(first.sessionId),
    ) ?? "{}")).toMatchObject({
      strategy: "deterministic",
      coveredUntilSeq: 4,
      messageCount: 4,
      sourceFromSeq: 1,
      sourceToSeq: 4,
      previousCoveredUntilSeq: 2,
    });
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

  it("keeps prepared user messages session-only before explicit task routing", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-runtime-"));
    const runtime = createGitMemoryRuntime({
      contextStoreDir,
      timezone: "Asia/Kolkata",
      agentId: "local",
    });

    const prepared = await runtime.prepareUserTurn({
      userMessage: "Continue upload UI redesign",
      at: "2026-06-28T09:00:00+05:30",
    });
    const memoryState = await runtime.buildMemoryState(prepared.sessionId);
    const context = await runtime.buildActiveContext(prepared.sessionId);

    expect(prepared.memoryState.pendingTurn).toBeUndefined();
    expect(prepared.context.pendingTurn).toBeUndefined();
    expect(memoryState.pendingTurn).toBeUndefined();
    expect(context.pendingTurn).toBeUndefined();
    expect(prepared.memoryState.session.conversationTail).toMatchObject([
      { seq: 1, role: "user", text: "Continue upload UI redesign" },
    ]);
  });

  it("keeps greetings session-only without pending task routing", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-runtime-"));
    const runtime = createGitMemoryRuntime({
      contextStoreDir,
      timezone: "Asia/Kolkata",
      agentId: "local",
    });

    const prepared = await runtime.prepareUserTurn({
      userMessage: "hii",
      at: "2026-06-28T09:00:00+05:30",
    });
    const memoryState = await runtime.buildMemoryState(prepared.sessionId);
    const context = await runtime.buildActiveContext(prepared.sessionId);

    expect(prepared.memoryState.pendingTurn).toBeUndefined();
    expect(prepared.context.pendingTurn).toBeUndefined();
    expect(memoryState.pendingTurn).toBeUndefined();
    expect(context.pendingTurn).toBeUndefined();
    expect(prepared.memoryState.session.conversationTail).toMatchObject([
      { seq: 1, role: "user", text: "hii" },
    ]);
  });

  it("creates deterministic global conversation records before persistence", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-runtime-"));
    const store = new TrackingConversationStore({ contextStoreDir });
    const runtime = createGitMemoryRuntime({
      contextStoreDir,
      timezone: "Asia/Kolkata",
      agentId: "local",
      store,
    });

    const prepared = await runtime.prepareUserTurn({
      userMessage: "Fix upload handling",
      at: "2026-06-28T09:00:00+05:30",
    });
    await runtime.prepareSystemTurn({
      systemMessage: "System noted upload handling context.",
      at: "2026-06-28T09:00:05+05:30",
    });
    const assistant = await runtime.recordAssistantMessage({
      sessionId: prepared.sessionId,
      text: "I will inspect upload handling.",
      at: "2026-06-28T09:00:10+05:30",
    });
    await waitForCommittedWrites(runtime, prepared.sessionId, 3);

    expect(store.generatedMessageCalls).toBe(0);
    expect(store.prebuiltRecords).toMatchObject([
      {
        seq: 1,
        role: "user",
        at: "2026-06-28T09:00:00+05:30",
        text: "Fix upload handling",
      },
      {
        seq: 2,
        role: "system",
        at: "2026-06-28T09:00:05+05:30",
        text: "System noted upload handling context.",
      },
      {
        seq: 3,
        role: "assistant",
        at: "2026-06-28T09:00:10+05:30",
        text: "I will inspect upload handling.",
      },
    ]);
    expect(assistant).toMatchObject({
      seq: 3,
      role: "assistant",
      text: "I will inspect upload handling.",
    });
  });

  it("returns prepared user turns before global conversation persistence resolves", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-runtime-"));
    const gate = deferred<void>();
    const store = new BlockingConversationStore({ contextStoreDir }, gate.promise);
    const runtime = createGitMemoryRuntime({
      contextStoreDir,
      timezone: "Asia/Kolkata",
      agentId: "local",
      store,
    });

    const prepared = await runtime.prepareUserTurn({
      userMessage: "Fix upload handling",
      at: "2026-06-28T09:00:00+05:30",
    });

    expect(prepared.userMessage).toMatchObject({
      seq: 1,
      role: "user",
      text: "Fix upload handling",
    });
    expect(prepared.context.session.conversationTail).toMatchObject([{
      seq: 1,
      role: "user",
      text: "Fix upload handling",
    }]);
    expect(prepared.context.pendingWrites).toMatchObject([{
      type: "main_conversation_appended",
      label: "prepare_user_turn",
    }]);

    gate.resolve();
    await waitForCommittedWrites(runtime, prepared.sessionId, 1);
    expect((await runtime.buildActiveContext(prepared.sessionId)).pendingWrites).toBeUndefined();
  });

  it("keeps memory updated when async global conversation persistence fails", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-runtime-"));
    const store = new FailingConversationStore({ contextStoreDir });
    const runtime = createGitMemoryRuntime({
      contextStoreDir,
      timezone: "Asia/Kolkata",
      agentId: "local",
      store,
    });

    const prepared = await runtime.prepareUserTurn({
      userMessage: "Fix upload handling",
      at: "2026-06-28T09:00:00+05:30",
    });
    await waitForFailedWrites(runtime, prepared.sessionId, 1);
    const context = await runtime.buildActiveContext(prepared.sessionId);

    expect(context.session.conversationTail).toMatchObject([{
      seq: 1,
      role: "user",
      text: "Fix upload handling",
    }]);
    expect(context.pendingWrites).toMatchObject([{
      type: "main_conversation_appended",
      label: "prepare_user_turn",
      status: "failed",
      error: "async persistence failed",
    }]);
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
    await waitForCommittedWrites(runtime, prepared.sessionId, 1);

    const [context, memoryState] = await Promise.all([
      runtime.buildActiveContext(prepared.sessionId),
      runtime.buildMemoryState(prepared.sessionId),
    ]);

    expect(context).toEqual(buildGitMemoryContextPackFromMemoryState(memoryState));
    expect(memoryState.pendingWrites).toEqual([]);
    expect(context.pendingWrites).toBeUndefined();
  });

  it("serves prepared session conversation from the runtime memory cache", async () => {
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
    await writeFile(
      join(prepared.repoPath, GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH),
      "# Conversation\n",
    );

    const memoryState = await runtime.buildMemoryState(prepared.sessionId);
    const context = await runtime.buildActiveContext(prepared.sessionId);

    expect(memoryState.session.conversationTail).toMatchObject([{
      seq: 1,
      role: "user",
      text: "Fix upload handling",
    }]);
    expect(context.session.conversationTail).toMatchObject([{
      seq: 1,
      role: "user",
      text: "Fix upload handling",
    }]);
  });

  it("updates cached session conversation for system turns", async () => {
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

    const system = await runtime.prepareSystemTurn({
      systemMessage: "System noted upload handling context.",
      at: "2026-06-28T09:00:05+05:30",
    });

    expect(system.sessionId).toBe(prepared.sessionId);
    expect(system.memoryState.session.conversationTail).toMatchObject([
      {
        seq: 1,
        role: "user",
        text: "Fix upload handling",
      },
      {
        seq: 2,
        role: "system",
        text: "System noted upload handling context.",
      },
    ]);
  });

  it("updates cached session conversation for global assistant messages", async () => {
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
    await writeFile(
      join(prepared.repoPath, GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH),
      "# Conversation\n",
    );
    const memoryState = await runtime.buildMemoryState(prepared.sessionId);

    expect(memoryState.session.conversationTail).toMatchObject([
      {
        seq: 1,
        role: "user",
        text: "Fix upload handling",
      },
      {
        seq: 2,
        role: "assistant",
        text: "I will inspect upload handling.",
      },
    ]);
  });

  it("keeps task-linked assistant messages in the active task cache", async () => {
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
    await runtime.buildMemoryState(prepared.sessionId);

    await runtime.recordAssistantMessage({
      sessionId: prepared.sessionId,
      taskId: task.taskId,
      runId: run.runId,
      text: "Finished upload handling inspection.",
      at: "2026-06-28T09:10:05+05:30",
    });
    await writeFile(
      join(prepared.repoPath, GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH),
      "# Conversation\n",
    );
    const memoryState = await runtime.buildMemoryState(prepared.sessionId);

    expect(memoryState.session.conversationTail).toMatchObject([
      { seq: 1, role: "user", text: "Fix upload handling" },
      {
        seq: 2,
        role: "assistant",
        text: "Finished upload handling inspection.",
        taskId: task.taskId,
        runId: run.runId,
      },
    ]);
    expect(memoryState.activeTask?.conversationMarkdownTail)
      .toContain("Finished upload handling inspection.");
  });

  it("invalidates cached session memory after task creation", async () => {
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
    const memoryState = await runtime.buildMemoryState(prepared.sessionId);

    expect(memoryState.session.taskCount).toBe(1);
    expect(memoryState.focus).toMatchObject({
      status: "active",
      taskId: task.taskId,
    });
    expect(memoryState.activeTask).toMatchObject({
      taskId: task.taskId,
      title: "Fix upload handling",
    });
  });

  it("serves created active task context from the runtime memory cache", async () => {
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
    const driver = new GitMemoryWorktreeGitDriver(prepared.repoPath);
    await driver.commitSyntheticFiles({
      ref: task.ref,
      files: {
        [gitMemoryTaskStatePath(task.taskId)]: "{ invalid json",
      },
      message: "damage task state",
    });
    const memoryState = await runtime.buildMemoryState(prepared.sessionId);

    expect(memoryState.focus).toMatchObject({
      status: "active",
      taskId: task.taskId,
    });
    expect(memoryState.activeTask).toMatchObject({
      taskId: task.taskId,
      title: "Fix upload handling",
      summary: "Find and fix upload handling failures.",
      open: ["Find and fix upload handling failures."],
    });
  });

  it("serves route-created active task context from the runtime memory cache", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-runtime-"));
    const store = new GitMemoryDailySessionStore({ contextStoreDir });
    const runtime = createGitMemoryRuntime({
      contextStoreDir,
      timezone: "Asia/Kolkata",
      agentId: "local",
      store,
    });
    const prepared = await runtime.prepareUserTurn({
      userMessage: "Fix upload handling",
      at: "2026-06-28T09:00:00+05:30",
    });
    const readSnapshot = vi.spyOn(store, "readTaskRoutingSnapshot");

    const route = await runtime.routeUserTurn({
      sessionId: prepared.sessionId,
      userMessage: "Fix upload handling",
      fromSeq: prepared.userMessage.seq,
      toSeq: prepared.userMessage.seq,
      at: "2026-06-28T09:00:01+05:30",
    });
    if (route.status !== "ready") {
      throw new Error(`Expected ready task route, got ${route.status}.`);
    }

    expect(readSnapshot).toHaveBeenCalledTimes(1);
    const driver = new GitMemoryWorktreeGitDriver(prepared.repoPath);
    await driver.commitSyntheticFiles({
      ref: route.ref,
      files: {
        [gitMemoryTaskStatePath(route.taskId)]: "{ invalid json",
      },
      message: "damage task state",
    });
    const memoryState = await runtime.buildMemoryState(prepared.sessionId);

    expect(readSnapshot).toHaveBeenCalledTimes(1);
    expect(memoryState.focus).toMatchObject({
      status: "active",
      taskId: route.taskId,
    });
    expect(memoryState.activeTask).toMatchObject({
      taskId: route.taskId,
      title: "Fix upload handling",
      summary: "Fix upload handling",
      open: ["Fix upload handling"],
    });
  });

  it("marks pending turns bound after ready task routing", async () => {
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

    const route = await runtime.routeUserTurn({
      sessionId: prepared.sessionId,
      userMessage: "Fix upload handling",
      fromSeq: prepared.userMessage.seq,
      toSeq: prepared.userMessage.seq,
      at: "2026-06-28T09:00:01+05:30",
    });
    if (route.status !== "ready") {
      throw new Error(`Expected ready task route, got ${route.status}.`);
    }

    expect(route.memoryState.pendingTurn).toMatchObject({
      fromSeq: prepared.userMessage.seq,
      toSeq: prepared.userMessage.seq,
      text: "Fix upload handling",
      routingStatus: "bound",
      taskId: route.taskId,
      branch: route.branch,
      runId: route.runId,
    });
    expect(route.context.pendingTurn).toEqual(route.memoryState.pendingTurn);
  });

  it("updates cached active task state after task run commits", async () => {
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
      runId: "R-20260628-0001",
      status: "completed",
      startedAt: "2026-06-28T09:02:00+05:30",
      completedAt: "2026-06-28T09:10:00+05:30",
      conversationRefs: [{ fromSeq: prepared.userMessage.seq, toSeq: prepared.userMessage.seq }],
      summary: "Inspected upload handling.",
      newFacts: ["Upload route validates MIME type."],
      next: "Patch upload validation handling.",
      state: {
        status: "in_progress",
        completed: ["Inspected upload server"],
        open: ["Patch upload validation handling."],
        next: "Patch upload validation handling.",
      },
    });
    const driver = new GitMemoryWorktreeGitDriver(prepared.repoPath);
    await driver.commitSyntheticFiles({
      ref: task.ref,
      files: {
        [gitMemoryTaskStatePath(task.taskId)]: "{ invalid json",
      },
      message: "damage task state",
    });
    const memoryState = await runtime.buildMemoryState(prepared.sessionId);

    expect(run.runId).toBe("R-20260628-0001");
    expect(memoryState.activeTask).toMatchObject({
      taskId: task.taskId,
      status: "in_progress",
      summary: "Inspected upload handling.",
      completed: ["Inspected upload server"],
      open: ["Patch upload validation handling."],
      facts: ["Upload route validates MIME type."],
      next: "Patch upload validation handling.",
      recentRuns: [{
        runId: "R-20260628-0001",
        status: "completed",
        summary: "Inspected upload handling.",
      }],
    });
  });

  it("clears bound pending turns after their task run commits", async () => {
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
    const route = await runtime.routeUserTurn({
      sessionId: prepared.sessionId,
      userMessage: "Fix upload handling",
      fromSeq: prepared.userMessage.seq,
      toSeq: prepared.userMessage.seq,
      at: "2026-06-28T09:00:01+05:30",
    });
    if (route.status !== "ready") {
      throw new Error(`Expected ready task route, got ${route.status}.`);
    }

    await runtime.commitTaskRun({
      sessionId: prepared.sessionId,
      taskId: route.taskId,
      runId: route.runId,
      status: "completed",
      startedAt: "2026-06-28T09:02:00+05:30",
      completedAt: "2026-06-28T09:10:00+05:30",
      conversationRefs: [{ fromSeq: prepared.userMessage.seq, toSeq: prepared.userMessage.seq }],
      summary: "Inspected upload handling.",
    });

    expect((await runtime.buildMemoryState(prepared.sessionId)).pendingTurn).toBeUndefined();
    expect((await runtime.buildActiveContext(prepared.sessionId)).pendingTurn).toBeUndefined();
  });

  it("updates cached active task conversation for task-linked assistant messages", async () => {
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

    await runtime.recordAssistantMessage({
      sessionId: prepared.sessionId,
      taskId: task.taskId,
      text: "I will patch upload validation.",
      at: "2026-06-28T09:02:00+05:30",
    });
    const driver = new GitMemoryWorktreeGitDriver(prepared.repoPath);
    await driver.commitSyntheticFiles({
      ref: task.ref,
      files: {
        [gitMemoryTaskStatePath(task.taskId)]: "{ invalid json",
      },
      message: "damage task state",
    });
    const memoryState = await runtime.buildMemoryState(prepared.sessionId);

    expect(memoryState.session.conversationTail).toMatchObject([
      { seq: 1, role: "user", text: "Fix upload handling" },
      { seq: 2, role: "assistant", text: "I will patch upload validation." },
    ]);
    expect(memoryState.activeTask?.conversationMarkdownTail).toContain("I will patch upload validation.");
  });

  it("surfaces unresolved git-memory writes in memory and active context", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-runtime-"));
    const writes: GitMemoryWriteBatchSnapshot[] = [{
      id: "GMW-000001",
      sessionId: "S-20260628-local",
      type: "main_conversation_appended",
      label: "committed-write",
      createdAt: "2026-06-28T09:00:00+05:30",
      status: "committed",
      completedAt: "2026-06-28T09:00:01+05:30",
    }, {
      id: "GMW-000002",
      sessionId: "S-20260628-local",
      type: "task_routed",
      label: "pending-route",
      createdAt: "2026-06-28T09:00:02+05:30",
      status: "pending",
    }, {
      id: "GMW-000003",
      sessionId: "S-20260628-local",
      type: "task_run_committed",
      label: "failed-run",
      createdAt: "2026-06-28T09:00:03+05:30",
      startedAt: "2026-06-28T09:00:04+05:30",
      failedAt: "2026-06-28T09:00:05+05:30",
      status: "failed",
      error: "git commit failed",
    }];
    const writeQueue: GitMemoryWriteQueueRunner = {
      async enqueue<T>(_batch: GitMemoryWriteBatchRequest, run: () => Promise<T>): Promise<T> {
        return await run();
      },
      getSessionWrites(sessionId: string) {
        return sessionId === "S-20260628-local" ? writes : [];
      },
    };
    const runtime = createGitMemoryRuntime({
      contextStoreDir,
      timezone: "Asia/Kolkata",
      agentId: "local",
      writeQueue,
    });

    const prepared = await runtime.prepareUserTurn({
      userMessage: "Fix upload handling",
      at: "2026-06-28T09:00:00+05:30",
    });
    const memoryState = await runtime.buildMemoryState(prepared.sessionId);
    const context = await runtime.buildActiveContext(prepared.sessionId);

    expect(memoryState.pendingWrites).toMatchObject([
      {
        id: "GMW-000002",
        type: "task_routed",
        label: "pending-route",
        status: "pending",
      },
      {
        id: "GMW-000003",
        type: "task_run_committed",
        label: "failed-run",
        status: "failed",
        error: "git commit failed",
      },
    ]);
    expect(memoryState.pendingWrites).toHaveLength(2);
    expect(context.pendingWrites).toEqual(memoryState.pendingWrites);
  });

  it("routes git-mutating runtime operations through the write queue", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-runtime-"));
    const queued: GitMemoryWriteBatchRequest[] = [];
    let tail = Promise.resolve();
    const writeQueue: GitMemoryWriteQueueRunner = {
      async enqueue<T>(batch: GitMemoryWriteBatchRequest, run: () => Promise<T>): Promise<T> {
        queued.push(batch);
        const current = tail.then(run);
        tail = current.then(
          () => undefined,
          () => undefined,
        );
        return await current;
      },
      getSessionWrites() {
        return [];
      },
    };
    const runtime = createGitMemoryRuntime({
      contextStoreDir,
      timezone: "Asia/Kolkata",
      agentId: "local",
      writeQueue,
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
    await runtime.checkpointSession({
      sessionId: prepared.sessionId,
      summary: "Checkpoint after assistant response.",
      at: "2026-06-28T09:01:00+05:30",
    });

    expect(queued).toMatchObject([
      {
        sessionId: "S-20260628-local",
        type: "main_conversation_appended",
        label: "prepare_user_turn",
      },
      {
        sessionId: "S-20260628-local",
        type: "assistant_message_recorded",
        label: "record_assistant_message",
      },
      {
        sessionId: "S-20260628-local",
        type: "session_checkpointed",
        label: "checkpoint_session",
      },
    ]);
  });

  it("exposes git-memory write batches through the runtime facade", async () => {
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
    await waitForCommittedWrites(runtime, prepared.sessionId, 2);

    expect(runtime.getSessionWrites(prepared.sessionId)).toMatchObject([
      {
        sessionId: "S-20260628-local",
        type: "main_conversation_appended",
        label: "prepare_user_turn",
        status: "committed",
      },
      {
        sessionId: "S-20260628-local",
        type: "assistant_message_recorded",
        label: "record_assistant_message",
        status: "committed",
      },
    ]);
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

  it("finalizes task runs once and records assistant output after the run commit", async () => {
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
    const routed = await runtime.routeUserTurn({
      sessionId: prepared.sessionId,
      userMessage: "Fix upload handling",
      fromSeq: prepared.userMessage.seq,
      toSeq: prepared.userMessage.seq,
      title: "Fix upload handling",
      objective: "Find and fix upload handling failures.",
      at: "2026-06-28T09:01:00+05:30",
    });
    if (routed.status !== "ready") {
      throw new Error(`Expected ready route, got ${routed.status}.`);
    }

    const result = {
      type: "reply" as const,
      status: "completed" as const,
      content: "Finished upload handling inspection.",
      totalIterations: 1,
      totalToolCalls: 0,
      runPath: "data/runs/r1",
      workRunId: routed.runId,
      completedSteps: [],
    };
    const first = await runtime.finalizeTaskRun({
      sessionId: prepared.sessionId,
      taskId: routed.taskId,
      runId: routed.runId,
      result,
      conversationRefs: routed.conversationRefs,
      at: "2026-06-28T09:10:00+05:30",
      assistantMessage: result.content,
      assistantAt: "2026-06-28T09:10:05+05:30",
    });
    const second = await runtime.finalizeTaskRun({
      sessionId: prepared.sessionId,
      taskId: routed.taskId,
      runId: routed.runId,
      result,
      conversationRefs: routed.conversationRefs,
      at: "2026-06-28T09:11:00+05:30",
      assistantMessage: result.content,
      assistantAt: "2026-06-28T09:11:05+05:30",
    });

    expect(first).toMatchObject({
      runId: routed.runId,
      alreadyFinalized: false,
      assistantMessage: {
        role: "assistant",
        taskId: routed.taskId,
        runId: routed.runId,
      },
    });
    expect(second).toMatchObject({
      runId: routed.runId,
      taskCommit: first.taskCommit,
      sessionStoreCommit: first.sessionStoreCommit,
      alreadyFinalized: true,
    });
    expect(second.assistantMessage).toBeUndefined();

    const context = await runtime.buildActiveContext(prepared.sessionId);
    expect(context.session.conversationTail).toMatchObject([
      { seq: 1, role: "user", text: "Fix upload handling" },
      { seq: 2, role: "assistant", taskId: routed.taskId, runId: routed.runId },
    ]);
    expect(context.session.summary).toMatchObject({
      text: expect.stringContaining("Assistant: Finished upload handling inspection."),
      updatedAt: "2026-06-28T09:10:05+05:30",
      coveredUntilSeq: 2,
    });
    expect(context.task?.recentRuns).toMatchObject([
      { runId: routed.runId, status: "completed" },
    ]);

    const driver = new GitMemoryWorktreeGitDriver(prepared.repoPath);
    const taskLog = await driver.log(routed.ref, 10);
    expect(taskLog.filter((entry) => {
      const trailers = parseGitMemoryCommitTrailers(entry.message);
      return trailers.runId === routed.runId && trailers.event === "run_completed";
    })).toHaveLength(1);
    expect(first.sessionStoreCommit).toEqual(expect.any(String));
    expect(await driver.listTreePaths(routed.ref, "session-store")).toEqual(["session-store"]);
    const messageStore = await driver.openSubmoduleRepo(GIT_MEMORY_SESSION_STORE_DIR);
    expect(await messageStore.readFile(
      first.sessionStoreCommit!,
      gitMemorySessionStoreSummaryMarkdownPath(prepared.sessionId),
    )).toContain("Assistant: Finished upload handling inspection.");
    expect(JSON.parse(await messageStore.readFile(
      first.sessionStoreCommit!,
      gitMemorySessionStoreSummaryMetaPath(prepared.sessionId),
    ) ?? "{}")).toMatchObject({
      formatVersion: 1,
      strategy: "deterministic",
      sessionId: prepared.sessionId,
      coveredUntilSeq: 2,
      messageCount: 2,
      sourceFromSeq: 1,
      sourceToSeq: 2,
    });
    expect(JSON.parse(await driver.readFile(routed.ref, gitMemoryTaskRunPath(routed.taskId, routed.runId)) ?? "{}"))
      .toMatchObject({
        conversationRefs: [{ fromSeq: 1, toSeq: 2 }],
        sessionStoreCommit: first.sessionStoreCommit,
      });
    expect((await driver.log(GIT_MEMORY_MAIN_REF, 10)).some((entry) => {
      const trailers = parseGitMemoryCommitTrailers(entry.message);
      return trailers.event === "session_checkpointed";
    })).toBe(true);
  });

  it.each([
    {
      label: "failed",
      resultStatus: "failed" as const,
      resultType: "reply" as const,
      expectedRunStatus: "failed",
    },
    {
      label: "blocked",
      resultStatus: "stuck" as const,
      resultType: "reply" as const,
      expectedRunStatus: "blocked",
    },
    {
      label: "needs user input",
      resultStatus: "completed" as const,
      resultType: "feedback" as const,
      expectedRunStatus: "needs_user_input",
    },
  ])("finalizes $label terminal runs with durable status", async (fixture) => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-runtime-"));
    const runtime = createGitMemoryRuntime({
      contextStoreDir,
      timezone: "Asia/Kolkata",
      agentId: "local",
    });
    const prepared = await runtime.prepareUserTurn({
      userMessage: `Handle ${fixture.label} upload run`,
      at: "2026-06-28T09:00:00+05:30",
    });
    const routed = await runtime.routeUserTurn({
      sessionId: prepared.sessionId,
      userMessage: `Handle ${fixture.label} upload run`,
      fromSeq: prepared.userMessage.seq,
      toSeq: prepared.userMessage.seq,
      title: `Handle ${fixture.label} upload run`,
      objective: "Exercise terminal run finalization.",
      at: "2026-06-28T09:01:00+05:30",
    });
    if (routed.status !== "ready") {
      throw new Error(`Expected ready route, got ${routed.status}.`);
    }

    const finalized = await runtime.finalizeTaskRun({
      sessionId: prepared.sessionId,
      taskId: routed.taskId,
      runId: routed.runId,
      result: {
        type: fixture.resultType,
        status: fixture.resultStatus,
        content: `${fixture.label} terminal response.`,
        totalIterations: 1,
        totalToolCalls: 0,
        runPath: "data/runs/terminal",
        workRunId: routed.runId,
        workState: {
          status: fixture.expectedRunStatus === "needs_user_input" ? "needs_user_input" : "blocked",
          summary: `${fixture.label} terminal summary.`,
          openWork: [`Resolve ${fixture.label} terminal state.`],
          blockers: fixture.expectedRunStatus === "needs_user_input" ? [] : [`${fixture.label} terminal blocker.`],
          verifiedFacts: [],
          evidence: [],
          userInputNeeded: fixture.expectedRunStatus === "needs_user_input"
            ? "Choose the next terminal action."
            : undefined,
          nextStep: `Resolve ${fixture.label} terminal state.`,
        },
        completedSteps: [],
      },
      conversationRefs: routed.conversationRefs,
      at: "2026-06-28T09:10:00+05:30",
    });

    expect(finalized).toMatchObject({
      runId: routed.runId,
      alreadyFinalized: false,
    });
    const driver = new GitMemoryWorktreeGitDriver(prepared.repoPath);
    expect(JSON.parse(await driver.readFile(routed.ref, gitMemoryTaskRunPath(routed.taskId, routed.runId)) ?? "{}"))
      .toMatchObject({
        runId: routed.runId,
        status: fixture.expectedRunStatus,
      });
  });

  it("does not append routed follow-up messages to the selected task branch before run finalization", async () => {
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
    expect(markdown).not.toContain("finish it");
    const taskLog = await driver.log(continued.ref, 5);
    expect(parseGitMemoryCommitTrailers(taskLog[0]?.message ?? "")).toMatchObject({
      event: "task_created",
    });
  });

  it("continues obvious active-task follow-ups without reading the task routing snapshot", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-runtime-"));
    const store = new GitMemoryDailySessionStore({ contextStoreDir });
    const runtime = createGitMemoryRuntime({
      contextStoreDir,
      timezone: "Asia/Kolkata",
      agentId: "local",
      store,
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
      userMessage: "implement it",
      at: "2026-06-28T09:05:00+05:30",
    });
    const readSnapshot = vi.spyOn(store, "readTaskRoutingSnapshot");

    const continued = await runtime.continueActiveTurn({
      sessionId: second.sessionId,
      userMessage: "implement it",
      fromSeq: second.userMessage.seq,
      toSeq: second.userMessage.seq,
      at: "2026-06-28T09:05:01+05:30",
    });

    expect(readSnapshot).not.toHaveBeenCalled();
    expect(continued).toMatchObject({
      status: "ready",
      mode: "continue_active_task",
      taskId: created.taskId,
      runId: "R-20260628-0002",
      conversationRefs: [{ fromSeq: second.userMessage.seq, toSeq: second.userMessage.seq }],
      memoryState: {
        pendingTurn: {
          fromSeq: second.userMessage.seq,
          toSeq: second.userMessage.seq,
          text: "implement it",
          routingStatus: "bound",
          taskId: created.taskId,
          runId: "R-20260628-0002",
        },
      },
    });
    expect(continued?.memoryState.activeTask?.conversationMarkdownTail).toContain("implement it");
    expect(continued?.memoryState.activeTask?.conversationMarkdownTail).toContain("Run: R-20260628-0002");
  });

  it("does not auto-bind follow-up messages when no active task exists", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-runtime-"));
    const store = new GitMemoryDailySessionStore({ contextStoreDir });
    const runtime = createGitMemoryRuntime({
      contextStoreDir,
      timezone: "Asia/Kolkata",
      agentId: "local",
      store,
    });
    const prepared = await runtime.prepareUserTurn({
      userMessage: "go on",
      at: "2026-06-28T09:00:00+05:30",
    });
    const allocateRunId = vi.spyOn(store, "allocateTaskRunId");

    const continued = await runtime.continueActiveTurn({
      sessionId: prepared.sessionId,
      userMessage: "go on",
      fromSeq: prepared.userMessage.seq,
      toSeq: prepared.userMessage.seq,
      at: "2026-06-28T09:00:01+05:30",
    });

    expect(continued).toBeNull();
    expect(allocateRunId).not.toHaveBeenCalled();
  });

  it("serves routed follow-up active task context from the runtime memory cache", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-runtime-"));
    const store = new GitMemoryDailySessionStore({ contextStoreDir });
    const runtime = createGitMemoryRuntime({
      contextStoreDir,
      timezone: "Asia/Kolkata",
      agentId: "local",
      store,
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
    const readSnapshot = vi.spyOn(store, "readTaskRoutingSnapshot");

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

    expect(readSnapshot).toHaveBeenCalledTimes(1);
    const driver = new GitMemoryWorktreeGitDriver(second.repoPath);
    await driver.commitSyntheticFiles({
      ref: continued.ref,
      files: {
        [gitMemoryTaskStatePath(continued.taskId)]: "{ invalid json",
      },
      message: "damage task state",
    });
    const memoryState = await runtime.buildMemoryState(second.sessionId);

    expect(readSnapshot).toHaveBeenCalledTimes(1);
    expect(memoryState.focus).toMatchObject({
      status: "active",
      taskId: continued.taskId,
    });
    expect(memoryState.activeTask?.conversationMarkdownTail).toContain("finish it");
    expect(memoryState.activeTask?.conversationMarkdownTail).toContain(`Run: ${continued.runId}`);
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
    await waitForCommittedWrites(runtime, second.sessionId, 3);
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

  it("keeps task-owned assistant messages in session conversation before run finalization", async () => {
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
    expect(secondTaskConversation).not.toContain("I reviewed the contract risk and found one blocker.");
    expect(secondTaskConversation).not.toContain(`Run: ${secondRoute.runId}`);
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
    await waitForCommittedWrites(runtime, prepared.sessionId, 3);

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
    expect(ambiguousRoute.memoryState.pendingTurn).toMatchObject({
      fromSeq: ambiguous.userMessage.seq,
      toSeq: ambiguous.userMessage.seq,
      text: "upload",
      routingStatus: "clarifying",
    });
    expect(ambiguousRoute.memoryState.pendingTurn).not.toHaveProperty("taskId");
    expect(ambiguousRoute.memoryState.pendingTurn).not.toHaveProperty("runId");
  });
});

class TrackingConversationStore extends GitMemoryDailySessionStore {
  readonly prebuiltRecords: Array<AppendGitMemoryConversationRecordInput["record"]> = [];
  generatedMessageCalls = 0;

  override async appendMainConversationMessage(
    input: AppendGitMemoryConversationInput,
  ): Promise<AppendGitMemoryConversationRecordInput["record"]> {
    this.generatedMessageCalls += 1;
    return await super.appendMainConversationMessage(input);
  }

  override async appendConversationMessage(
    input: AppendGitMemoryConversationInput,
  ): Promise<AppendGitMemoryConversationRecordInput["record"]> {
    this.generatedMessageCalls += 1;
    return await super.appendConversationMessage(input);
  }

  override async appendMainConversationRecord(
    input: AppendGitMemoryConversationRecordInput,
  ): Promise<AppendGitMemoryConversationRecordInput["record"]> {
    this.prebuiltRecords.push(input.record);
    return await super.appendMainConversationRecord(input);
  }
}

class BlockingConversationStore extends TrackingConversationStore {
  constructor(
    options: ConstructorParameters<typeof GitMemoryDailySessionStore>[0],
    private readonly gate: Promise<void>,
  ) {
    super(options);
  }

  override async appendMainConversationRecord(
    input: AppendGitMemoryConversationRecordInput,
  ): Promise<AppendGitMemoryConversationRecordInput["record"]> {
    this.prebuiltRecords.push(input.record);
    await this.gate;
    return await GitMemoryDailySessionStore.prototype.appendMainConversationRecord.call(this, input);
  }
}

class FailingConversationStore extends TrackingConversationStore {
  override async appendMainConversationRecord(
    input: AppendGitMemoryConversationRecordInput,
  ): Promise<AppendGitMemoryConversationRecordInput["record"]> {
    this.prebuiltRecords.push(input.record);
    throw new Error("async persistence failed");
  }
}

async function waitForCommittedWrites(
  runtime: { getSessionWrites(sessionId: string): GitMemoryWriteBatchSnapshot[] },
  sessionId: string,
  count: number,
): Promise<void> {
  await waitForWrites(runtime, sessionId, (writes) => (
    writes.length >= count && writes.slice(0, count).every((write) => write.status === "committed")
  ));
}

async function waitForFailedWrites(
  runtime: { getSessionWrites(sessionId: string): GitMemoryWriteBatchSnapshot[] },
  sessionId: string,
  count: number,
): Promise<void> {
  await waitForWrites(runtime, sessionId, (writes) => (
    writes.filter((write) => write.status === "failed").length >= count
  ));
}

async function waitForWrites(
  runtime: { getSessionWrites(sessionId: string): GitMemoryWriteBatchSnapshot[] },
  sessionId: string,
  predicate: (writes: GitMemoryWriteBatchSnapshot[]) => boolean,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate(runtime.getSessionWrites(sessionId))) {
      return;
    }
    await delay(10);
  }
  throw new Error(`Timed out waiting for git memory writes: ${JSON.stringify(runtime.getSessionWrites(sessionId))}`);
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
