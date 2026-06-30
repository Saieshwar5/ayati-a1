import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createGitMemoryRuntime,
  GIT_MEMORY_MAIN_REF,
  GitMemoryDailySessionStore,
  GitMemoryWorktreeGitDriver,
  gitMemoryTaskAssetsPath,
  renderGitMemoryCommitMessage,
} from "../../src/context-engine/git-memory/index.js";
import { createGitContextSkill } from "../../src/skills/builtins/git-context/index.js";
import {
  GIT_CONTEXT_READ_ONLY_TOOL_NAMES,
  GIT_CONTEXT_TURN_ROUTING_TOOL_NAMES,
} from "../../src/skills/builtins/git-context/tool-policy.js";

describe("git-context skill", () => {
  it("lists known sessions without mutating git-memory repos", async () => {
    const prepared = await prepareGitContextSession();
    const driver = new GitMemoryWorktreeGitDriver(prepared.session.repoPath);
    const mainLogBefore = await driver.log(GIT_MEMORY_MAIN_REF, 5);
    const taskLogBefore = await driver.log(prepared.task.ref, 5);

    const skill = createGitContextSkill({ contextStoreDir: prepared.contextStoreDir });
    const tool = requiredTool(skill, "git_context_list_sessions");

    expect(tool.annotations).toMatchObject({
      domain: "git_context",
      readOnly: true,
      mutatesWorkspace: false,
      mutatesExternalWorld: false,
      idempotent: true,
      retrySafe: true,
    });

    const result = await tool.execute({ limit: 10 });

    expect(result.ok).toBe(true);
    expect(result.v2?.structuredContent).toMatchObject({
      sessions: [{
        sessionId: "S-20260628-local",
        date: "2026-06-28",
        timezone: "Asia/Kolkata",
        agentId: "local",
        taskCount: 1,
        activeTaskId: "W-20260628-0001",
        activeBranch: "task/W-20260628-0001-fix-upload-handling",
      }],
    });
    expect(await driver.log(GIT_MEMORY_MAIN_REF, 5)).toEqual(mainLogBefore);
    expect(await driver.log(prepared.task.ref, 5)).toEqual(taskLogBefore);
  });

  it("reads active git context using the current tool context session id", async () => {
    const prepared = await prepareGitContextSession();
    const skill = createGitContextSkill({ contextStoreDir: prepared.contextStoreDir });
    const tool = requiredTool(skill, "git_context_active");

    const result = await tool.execute({
      limits: {
        conversationTailLimit: 2,
        activityTailLimit: 5,
        runLimit: 2,
        evidenceLimit: 1,
        commitLogLimit: 2,
        conversationMarkdownCharLimit: 200,
      },
    }, { sessionId: prepared.session.sessionId });

    expect(result.ok).toBe(true);
    expect(result.v2?.structuredContent).toMatchObject({
      session: {
        sessionId: "S-20260628-local",
        conversationTail: [
          { seq: 1, role: "user", text: "Fix upload handling" },
        ],
        conversationMarkdownTail: expect.stringContaining("Fix upload handling"),
        taskCount: 1,
      },
      focus: {
        status: "active",
        taskId: "W-20260628-0001",
        branch: "task/W-20260628-0001-fix-upload-handling",
      },
      task: {
        taskId: "W-20260628-0001",
        title: "Fix upload handling",
        status: "in_progress",
        facts: [
          "Upload route validates MIME type.",
          "Upload validation handles multipart MIME metadata.",
        ],
        next: "Verify upload validation patch.",
        recentEvidence: [{
          runId: "R-20260628-0002",
          taskId: "W-20260628-0001",
          tool: "edit_file",
          summary: "Patched upload validation branch.",
          evidenceRef: "evidence/ACT-20260628-000101.txt",
        }],
      },
    });
    const sessionRecentCommits = (result.v2?.structuredContent as {
      session?: { recentCommits?: Array<Record<string, unknown>> };
    }).session?.recentCommits ?? [];
    expect(sessionRecentCommits[0]).toMatchObject({
      subject: "ayati: record user message",
      event: "conversation_appended",
    });
    expect(sessionRecentCommits[0]).not.toHaveProperty("trailers");
    expect(sessionRecentCommits[0]).not.toHaveProperty("conversationSeq");
  });

  it("lists task routing snapshots for a session", async () => {
    const prepared = await prepareGitContextSession();
    const skill = createGitContextSkill({ contextStoreDir: prepared.contextStoreDir });
    const tool = requiredTool(skill, "git_context_list_tasks");

    const result = await tool.execute({ sessionId: prepared.session.sessionId });

    expect(result.ok).toBe(true);
    expect(result.v2?.structuredContent).toMatchObject({
      sessionId: "S-20260628-local",
      focus: {
        activeTaskId: "W-20260628-0001",
        activeBranch: "task/W-20260628-0001-fix-upload-handling",
      },
      tasks: [{
        taskId: "W-20260628-0001",
        branch: "task/W-20260628-0001-fix-upload-handling",
        title: "Fix upload handling",
        status: "in_progress",
        summary: "Patched upload validation handling.",
        next: "Verify upload validation patch.",
      }],
    });
  });

  it("searches task branches by title, summary, facts, and next step", async () => {
    const prepared = await prepareMultiTaskGitContextSession();
    const driver = new GitMemoryWorktreeGitDriver(prepared.session.repoPath);
    const mainLogBefore = await driver.log(GIT_MEMORY_MAIN_REF, 10);
    const uploadLogBefore = await driver.log(prepared.uploadTask.ref, 10);
    const reminderLogBefore = await driver.log(prepared.reminderTask.ref, 10);
    const skill = createGitContextSkill({ contextStoreDir: prepared.contextStoreDir });
    const tool = requiredTool(skill, "git_context_search_tasks");

    const result = await tool.execute({
      sessionId: prepared.session.sessionId,
      query: "multipart validation patch",
      limit: 5,
    });

    expect(result.ok).toBe(true);
    expect(result.v2?.structuredContent).toMatchObject({
      sessionId: "S-20260628-local",
      query: "multipart validation patch",
    });
    const matches = (result.v2?.structuredContent as { matches?: Array<{ taskId: string; score: number; matchReasons: string[] }> }).matches ?? [];
    expect(matches[0]?.taskId).toBe(prepared.uploadTask.taskId);
    expect(matches[0]).toMatchObject({
      branch: prepared.uploadTask.branch,
      title: "Fix upload handling",
      status: "in_progress",
    });
    expect(matches[0]?.score).toBeGreaterThan(0);
    expect(matches[0]?.matchReasons).toEqual(expect.arrayContaining(["summary", "facts", "next"]));
    expect(await driver.log(GIT_MEMORY_MAIN_REF, 10)).toEqual(mainLogBefore);
    expect(await driver.log(prepared.uploadTask.ref, 10)).toEqual(uploadLogBefore);
    expect(await driver.log(prepared.reminderTask.ref, 10)).toEqual(reminderLogBefore);
  });

  it("ranks stronger search matches first and respects limits", async () => {
    const prepared = await prepareMultiTaskGitContextSession();
    const skill = createGitContextSkill({ contextStoreDir: prepared.contextStoreDir });
    const tool = requiredTool(skill, "git_context_search_tasks");

    const result = await tool.execute({
      sessionId: prepared.session.sessionId,
      query: "upload",
      limit: 1,
    });

    expect(result.ok).toBe(true);
    const matches = (result.v2?.structuredContent as { matches?: Array<{ taskId: string }> }).matches ?? [];
    expect(matches).toHaveLength(1);
    expect(matches[0]?.taskId).toBe(prepared.uploadTask.taskId);
  });

  it("filters search results by task status", async () => {
    const prepared = await prepareMultiTaskGitContextSession();
    const skill = createGitContextSkill({ contextStoreDir: prepared.contextStoreDir });
    const tool = requiredTool(skill, "git_context_search_tasks");

    const result = await tool.execute({
      sessionId: prepared.session.sessionId,
      query: "reminder",
      status: "blocked",
      limit: 5,
    });

    expect(result.ok).toBe(true);
    expect(result.v2?.structuredContent).toMatchObject({
      status: "blocked",
      matches: [{
        taskId: prepared.reminderTask.taskId,
        status: "blocked",
      }],
    });
  });

  it("does not expose low-level branch mutation tools to the agent", async () => {
    const prepared = await prepareMultiTaskGitContextSession();
    const skill = createGitContextSkill({ contextStoreDir: prepared.contextStoreDir });
    const toolNames = skill.tools.map((tool) => tool.name);

    expect(toolNames).toEqual([
      ...GIT_CONTEXT_READ_ONLY_TOOL_NAMES,
      ...GIT_CONTEXT_TURN_ROUTING_TOOL_NAMES,
    ]);
    expect(toolNames).not.toContain("git_context_create_task");
    expect(toolNames).not.toContain("git_context_switch_task");
  });

  it("activates an existing task for the current pending turn through the runtime", async () => {
    const prepared = await prepareMultiTaskGitContextSession();
    const runtime = createGitMemoryRuntime({
      contextStoreDir: prepared.contextStoreDir,
      timezone: "Asia/Kolkata",
      agentId: "local",
      store: prepared.store,
    });
    const pending = await runtime.prepareUserTurn({
      userMessage: "continue upload UI redesign",
      at: "2026-06-28T11:00:00+05:30",
    });
    const skill = createGitContextSkill({
      contextStoreDir: prepared.contextStoreDir,
      gitMemoryRuntime: runtime,
    });
    const tool = requiredTool(skill, "git_context_activate_task_for_turn");

    expect(tool.annotations).toMatchObject({
      domain: "git_context",
      readOnly: false,
      mutatesWorkspace: true,
      mutatesExternalWorld: false,
      destructive: false,
      idempotent: false,
      retrySafe: false,
    });

    const result = await tool.execute({
      sessionId: prepared.session.sessionId,
      taskId: prepared.uploadTask.taskId,
      reason: "User is asking to continue previous upload UI work.",
    });

    expect(result.ok).toBe(true);
    expect(result.v2?.structuredContent).toMatchObject({
      status: "ready",
      mode: "switch_to_existing_task",
      sessionId: prepared.session.sessionId,
      taskId: prepared.uploadTask.taskId,
      branch: prepared.uploadTask.branch,
      runId: "R-20260628-0003",
      conversationRefs: [{ fromSeq: pending.userMessage.seq, toSeq: pending.userMessage.seq }],
      reason: "User is asking to continue previous upload UI work.",
      memoryState: {
        focus: {
          status: "active",
          taskId: prepared.uploadTask.taskId,
        },
        pendingTurn: {
          text: "continue upload UI redesign",
          routingStatus: "bound",
          taskId: prepared.uploadTask.taskId,
          runId: "R-20260628-0003",
        },
      },
    });

    const driver = new GitMemoryWorktreeGitDriver(prepared.session.repoPath);
    const taskConversation = await driver.readFile(
      prepared.uploadTask.ref,
      "session/conversation.md",
    ) ?? "";
    expect(taskConversation).toContain("continue upload UI redesign");
    expect(taskConversation).toContain("Run: R-20260628-0003");
  });

  it("creates a new task for the current pending turn through the runtime", async () => {
    const prepared = await prepareMultiTaskGitContextSession();
    const runtime = createGitMemoryRuntime({
      contextStoreDir: prepared.contextStoreDir,
      timezone: "Asia/Kolkata",
      agentId: "local",
      store: prepared.store,
    });
    const pending = await runtime.prepareUserTurn({
      userMessage: "start notification digest investigation",
      at: "2026-06-28T11:15:00+05:30",
    });
    const skill = createGitContextSkill({
      contextStoreDir: prepared.contextStoreDir,
      gitMemoryRuntime: runtime,
    });
    const tool = requiredTool(skill, "git_context_create_task_for_turn");

    const result = await tool.execute({
      sessionId: prepared.session.sessionId,
      title: "Fix notification digest",
      objective: "Investigate missing notification digest delivery.",
      reason: "User started a different durable notification task.",
    });

    expect(result.ok).toBe(true);
    expect(result.v2?.structuredContent).toMatchObject({
      status: "ready",
      mode: "create_new_task",
      sessionId: prepared.session.sessionId,
      taskId: "W-20260628-0003",
      branch: "task/W-20260628-0003-fix-notification-digest",
      runId: "R-20260628-0003",
      conversationRefs: [{ fromSeq: pending.userMessage.seq, toSeq: pending.userMessage.seq }],
      reason: "User started a different durable notification task.",
      createdTask: {
        title: "Fix notification digest",
        objective: "Investigate missing notification digest delivery.",
      },
      memoryState: {
        focus: {
          status: "active",
          taskId: "W-20260628-0003",
        },
        pendingTurn: {
          text: "start notification digest investigation",
          routingStatus: "bound",
          taskId: "W-20260628-0003",
          runId: "R-20260628-0003",
        },
      },
    });

    const created = result.v2?.structuredContent as { ref: string };
    const driver = new GitMemoryWorktreeGitDriver(prepared.session.repoPath);
    const taskConversation = await driver.readFile(created.ref, "session/conversation.md") ?? "";
    expect(taskConversation).toContain("start notification digest investigation");
    expect(taskConversation).toContain("Run: R-20260628-0003");
  });

  it("marks a pending turn as clarifying without allocating a run id", async () => {
    const prepared = await prepareMultiTaskGitContextSession();
    const runtime = createGitMemoryRuntime({
      contextStoreDir: prepared.contextStoreDir,
      timezone: "Asia/Kolkata",
      agentId: "local",
      store: prepared.store,
    });
    const pending = await runtime.prepareUserTurn({
      userMessage: "upload",
      at: "2026-06-28T11:30:00+05:30",
    });
    const allocateRunId = vi.spyOn(prepared.store, "allocateTaskRunId");
    const skill = createGitContextSkill({
      contextStoreDir: prepared.contextStoreDir,
      gitMemoryRuntime: runtime,
    });
    const tool = requiredTool(skill, "git_context_ask_clarification_for_turn");

    const result = await tool.execute({
      sessionId: prepared.session.sessionId,
      reason: "Multiple existing tasks could own the short upload request.",
      candidateTaskIds: [prepared.uploadTask.taskId, prepared.reminderTask.taskId],
    });

    expect(result.ok).toBe(true);
    expect(allocateRunId).not.toHaveBeenCalled();
    expect(result.v2?.structuredContent).toMatchObject({
      status: "ambiguous",
      sessionId: prepared.session.sessionId,
      reason: "Multiple existing tasks could own the short upload request.",
      candidates: [
        { taskId: prepared.uploadTask.taskId },
        { taskId: prepared.reminderTask.taskId },
      ],
      memoryState: {
        pendingTurn: {
          fromSeq: pending.userMessage.seq,
          toSeq: pending.userMessage.seq,
          text: "upload",
          routingStatus: "clarifying",
        },
      },
    });
    expect(result.v2?.structuredContent).not.toHaveProperty("runId");
    expect(runtime.getSessionWrites(prepared.session.sessionId)).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "task_routed",
      }),
    ]));
  });

  it("rejects invalid turn-aware task activation requests", async () => {
    const prepared = await prepareMultiTaskGitContextSession();
    const runtime = createGitMemoryRuntime({
      contextStoreDir: prepared.contextStoreDir,
      timezone: "Asia/Kolkata",
      agentId: "local",
    });
    await runtime.prepareUserTurn({
      userMessage: "continue upload work",
      at: "2026-06-28T11:40:00+05:30",
    });
    const skill = createGitContextSkill({
      contextStoreDir: prepared.contextStoreDir,
      gitMemoryRuntime: runtime,
    });
    const tool = requiredTool(skill, "git_context_activate_task_for_turn");

    await expect(tool.execute({
      sessionId: prepared.session.sessionId,
      taskId: prepared.uploadTask.taskId,
    })).resolves.toMatchObject({
      ok: false,
      v2: {
        code: "GIT_CONTEXT_INVALID_INPUT",
      },
    });

    await expect(tool.execute({
      sessionId: prepared.session.sessionId,
      taskId: "W-20260628-missing",
      reason: "Try missing task.",
    })).resolves.toMatchObject({
      ok: false,
      v2: {
        code: "GIT_CONTEXT_MUTATION_FAILED",
      },
    });
  });

  it("rejects empty task search queries", async () => {
    const prepared = await prepareGitContextSession();
    const skill = createGitContextSkill({ contextStoreDir: prepared.contextStoreDir });
    const tool = requiredTool(skill, "git_context_search_tasks");

    const result = await tool.execute({
      sessionId: prepared.session.sessionId,
      query: "   ",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("query must be a non-empty string");
    expect(result.v2?.error).toMatchObject({
      category: "validation",
      retryable: true,
    });
  });

  it("reads one task deeply with bounded runs, actions, assets, commits, evidence, and conversation", async () => {
    const prepared = await prepareGitContextSession();
    const driver = new GitMemoryWorktreeGitDriver(prepared.session.repoPath);
    const mainLogBefore = await driver.log(GIT_MEMORY_MAIN_REF, 10);
    const taskLogBefore = await driver.log(prepared.task.ref, 10);
    const skill = createGitContextSkill({ contextStoreDir: prepared.contextStoreDir });
    const tool = requiredTool(skill, "git_context_read_task");

    const result = await tool.execute({
      sessionId: prepared.session.sessionId,
      taskId: prepared.task.taskId,
      include: ["task", "state", "runs", "markdown", "actions", "assets", "commits", "evidence", "conversation"],
      limits: {
        runLimit: 1,
        actionRunLimit: 1,
        actionLimit: 1,
        commitLogLimit: 2,
        evidenceLimit: 1,
        conversationMarkdownCharLimit: 200,
        taskMarkdownCharLimit: 2_000,
        runMarkdownCharLimit: 2_000,
      },
    });

    expect(result.ok).toBe(true);
    expect(result.v2?.structuredContent).toMatchObject({
      sessionId: "S-20260628-local",
      taskId: "W-20260628-0001",
      branch: "task/W-20260628-0001-fix-upload-handling",
      task: {
        title: "Fix upload handling",
        objective: "Find and fix upload handling failures.",
      },
      state: {
        status: "in_progress",
        next: "Verify upload validation patch.",
      },
      assets: [{
        assetId: "asset-upload-log",
        role: "reference",
        kind: "file",
        name: "upload.log",
      }],
      recentRuns: [{
        runId: "R-20260628-0002",
        summary: "Patched upload validation handling.",
      }],
      taskMarkdown: expect.stringContaining("# Fix upload handling"),
      recentRunMarkdown: [{
        runId: "R-20260628-0002",
        path: "tasks/W-20260628-0001/runs/R-20260628-0002.md",
        markdown: expect.stringContaining("Patched upload validation handling."),
      }],
      recentActions: [{
        runId: "R-20260628-0002",
        actions: [{
          tool: "edit_file",
          summary: "Patched upload validation branch.",
        }],
      }],
      recentEvidence: [{
        runId: "R-20260628-0002",
        taskId: "W-20260628-0001",
        actionId: "ACT-20260628-000101",
        tool: "edit_file",
        summary: "Patched upload validation branch.",
        evidenceRef: "evidence/ACT-20260628-000101.txt",
      }],
      conversationMarkdownTail: expect.stringContaining("Fix upload handling"),
    });
    expect((result.v2?.structuredContent as { recentRuns?: unknown[] }).recentRuns).toHaveLength(1);
    expect((result.v2?.structuredContent as { recentActions?: unknown[] }).recentActions).toHaveLength(1);
    expect((result.v2?.structuredContent as { recentEvidence?: unknown[] }).recentEvidence).toHaveLength(1);
    const commits = (result.v2?.structuredContent as { recentCommits?: Array<{ subject?: string }> }).recentCommits ?? [];
    expect(commits).toHaveLength(2);
    expect(commits[0]).toMatchObject({ subject: "ayati: attach upload log" });
    expect(await driver.log(GIT_MEMORY_MAIN_REF, 10)).toEqual(mainLogBefore);
    expect(await driver.log(prepared.task.ref, 10)).toEqual(taskLogBefore);
  });

  it("ignores legacy jsonl task assets when assets json is missing", async () => {
    const prepared = await prepareGitContextSession();
    const driver = new GitMemoryWorktreeGitDriver(prepared.session.repoPath);
    await driver.commitSyntheticFiles({
      ref: prepared.task.ref,
      files: {
        [gitMemoryTaskAssetsPath(prepared.task.taskId)]: "",
        [`tasks/${prepared.task.taskId}/assets.jsonl`]: `${JSON.stringify({
          assetId: "asset-legacy-log",
          role: "reference",
          kind: "file",
          name: "legacy.log",
        })}\n`,
      },
      message: renderGitMemoryCommitMessage({
        subject: "ayati: attach legacy asset log",
        summary: "Register legacy asset jsonl fixture.",
        trailers: {
          sessionId: prepared.session.sessionId,
          taskId: prepared.task.taskId,
          event: "asset_registered",
          at: "2026-06-28T09:17:00+05:30",
          schemaVersion: 1,
        },
      }),
    });
    const skill = createGitContextSkill({ contextStoreDir: prepared.contextStoreDir });
    const tool = requiredTool(skill, "git_context_read_task");

    const result = await tool.execute({
      sessionId: prepared.session.sessionId,
      taskId: prepared.task.taskId,
      include: ["assets"],
    });

    expect(result.ok).toBe(true);
    expect(result.v2?.structuredContent).toMatchObject({ assets: [] });
  });

  it("reads compact evidence for a task run without mutating git-memory repos", async () => {
    const prepared = await prepareGitContextSession();
    const driver = new GitMemoryWorktreeGitDriver(prepared.session.repoPath);
    const mainLogBefore = await driver.log(GIT_MEMORY_MAIN_REF, 10);
    const taskLogBefore = await driver.log(prepared.task.ref, 10);
    const skill = createGitContextSkill({ contextStoreDir: prepared.contextStoreDir });
    const tool = requiredTool(skill, "git_context_read_evidence");

    const result = await tool.execute({
      sessionId: prepared.session.sessionId,
      taskId: prepared.task.taskId,
      runId: "R-20260628-0002",
      limit: 5,
    });

    expect(result.ok).toBe(true);
    expect(result.v2?.structuredContent).toMatchObject({
      sessionId: "S-20260628-local",
      taskId: "W-20260628-0001",
      branch: "task/W-20260628-0001-fix-upload-handling",
      runId: "R-20260628-0002",
      evidence: [{
        runId: "R-20260628-0002",
        taskId: "W-20260628-0001",
        actionId: "ACT-20260628-000101",
        tool: "edit_file",
        summary: "Patched upload validation branch.",
        artifacts: ["ayati-main/src/server/upload-server.ts"],
        facts: ["Upload validation handles multipart MIME metadata."],
      }],
    });
    expect(await driver.log(GIT_MEMORY_MAIN_REF, 10)).toEqual(mainLogBefore);
    expect(await driver.log(prepared.task.ref, 10)).toEqual(taskLogBefore);
  });

  it("searches compact evidence across task branches and respects scoped limits", async () => {
    const prepared = await prepareMultiTaskGitContextSession();
    const driver = new GitMemoryWorktreeGitDriver(prepared.session.repoPath);
    const mainLogBefore = await driver.log(GIT_MEMORY_MAIN_REF, 10);
    const uploadLogBefore = await driver.log(prepared.uploadTask.ref, 10);
    const reminderLogBefore = await driver.log(prepared.reminderTask.ref, 10);
    const skill = createGitContextSkill({ contextStoreDir: prepared.contextStoreDir });
    const tool = requiredTool(skill, "git_context_search_evidence");

    const result = await tool.execute({
      sessionId: prepared.session.sessionId,
      query: "multipart metadata",
      limit: 10,
    });
    const scoped = await tool.execute({
      sessionId: prepared.session.sessionId,
      branch: prepared.uploadTask.branch,
      query: "upload-server.ts",
      limit: 1,
    });

    expect(result.ok).toBe(true);
    const matches = (result.v2?.structuredContent as {
      matches?: Array<{ taskId: string; evidence: { runId: string; summary: string }; matchReasons: string[] }>;
    }).matches ?? [];
    expect(matches[0]).toMatchObject({
      taskId: prepared.uploadTask.taskId,
      evidence: {
        runId: "R-20260628-0002",
        summary: "Patched upload validation branch.",
      },
    });
    expect(matches[0]?.matchReasons).toEqual(expect.arrayContaining(["facts"]));

    expect(scoped.ok).toBe(true);
    expect((scoped.v2?.structuredContent as { matches?: unknown[] }).matches).toHaveLength(1);
    expect(scoped.v2?.structuredContent).toMatchObject({
      branch: prepared.uploadTask.branch,
      matches: [{
        taskId: prepared.uploadTask.taskId,
        evidence: {
          artifacts: ["ayati-main/src/server/upload-server.ts"],
        },
      }],
    });
    expect(await driver.log(GIT_MEMORY_MAIN_REF, 10)).toEqual(mainLogBefore);
    expect(await driver.log(prepared.uploadTask.ref, 10)).toEqual(uploadLogBefore);
    expect(await driver.log(prepared.reminderTask.ref, 10)).toEqual(reminderLogBefore);
  });

  it("rejects invalid evidence queries and missing run manifests clearly", async () => {
    const prepared = await prepareGitContextSession();
    const skill = createGitContextSkill({ contextStoreDir: prepared.contextStoreDir });
    const searchTool = requiredTool(skill, "git_context_search_evidence");
    const readTool = requiredTool(skill, "git_context_read_evidence");

    const emptySearch = await searchTool.execute({
      sessionId: prepared.session.sessionId,
      query: "   ",
    });
    const ambiguousSearch = await searchTool.execute({
      sessionId: prepared.session.sessionId,
      query: "upload",
      taskId: prepared.task.taskId,
      branch: prepared.task.branch,
    });
    const missingRun = await readTool.execute({
      sessionId: prepared.session.sessionId,
      taskId: prepared.task.taskId,
      runId: "R-20260628-9999",
    });

    expect(emptySearch.ok).toBe(false);
    expect(emptySearch.error).toContain("query must be a non-empty string");
    expect(ambiguousSearch.ok).toBe(false);
    expect(ambiguousSearch.error).toContain("at most one evidence search scope");
    expect(missingRun.ok).toBe(false);
    expect(missingRun.error).toContain("evidence manifest not found");
  });

  it("reads compact main and task logs", async () => {
    const prepared = await prepareGitContextSession();
    const skill = createGitContextSkill({ contextStoreDir: prepared.contextStoreDir });
    const tool = requiredTool(skill, "git_context_log");

    const mainResult = await tool.execute({
      sessionId: prepared.session.sessionId,
      target: "main",
      limit: 5,
    });
    const taskResult = await tool.execute({
      sessionId: prepared.session.sessionId,
      target: "task",
      branch: prepared.task.branch,
      limit: 2,
    });

    expect(mainResult.ok).toBe(true);
    expect(mainResult.v2?.structuredContent).toMatchObject({
      sessionId: "S-20260628-local",
      target: "main",
      ref: GIT_MEMORY_MAIN_REF,
    });
    const mainCommits = (mainResult.v2?.structuredContent as { commits?: Array<{ subject?: string; trailers?: unknown }> }).commits ?? [];
    expect(mainCommits[0]).toMatchObject({
      subject: "ayati: record user message",
      trailers: {
        sessionId: "S-20260628-local",
        event: "conversation_appended",
      },
    });
    expect(taskResult.ok).toBe(true);
    expect(taskResult.v2?.structuredContent).toMatchObject({
      sessionId: "S-20260628-local",
      target: "task",
      taskId: "W-20260628-0001",
      branch: "task/W-20260628-0001-fix-upload-handling",
    });
    const taskCommits = (taskResult.v2?.structuredContent as { commits?: Array<{ subject?: string; trailers?: unknown }> }).commits ?? [];
    expect(taskCommits).toHaveLength(2);
    expect(taskCommits[0]).toMatchObject({
      subject: "ayati: attach upload log",
      trailers: {
        taskId: "W-20260628-0001",
        event: "asset_registered",
      },
    });
  });

  it("rejects ambiguous task selectors for deep task reads", async () => {
    const prepared = await prepareGitContextSession();
    const skill = createGitContextSkill({ contextStoreDir: prepared.contextStoreDir });
    const tool = requiredTool(skill, "git_context_read_task");

    const result = await tool.execute({
      sessionId: prepared.session.sessionId,
      taskId: prepared.task.taskId,
      branch: prepared.task.branch,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("exactly one task selector");
    expect(result.v2?.error).toMatchObject({
      category: "validation",
      retryable: true,
    });
  });

  it("returns a clear error for a missing task", async () => {
    const prepared = await prepareGitContextSession();
    const skill = createGitContextSkill({ contextStoreDir: prepared.contextStoreDir });
    const tool = requiredTool(skill, "git_context_read_task");

    const result = await tool.execute({
      sessionId: prepared.session.sessionId,
      taskId: "W-20260628-9999",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Git memory task not found");
    expect(result.v2?.error).toMatchObject({
      category: "semantic",
      retryable: true,
    });
  });

  it("does not create a repo when reading a missing session", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-context-skill-"));
    const skill = createGitContextSkill({ contextStoreDir });
    const tool = requiredTool(skill, "git_context_read_task");
    const sessionId = "S-20260628-local";

    const result = await tool.execute({
      sessionId,
      taskId: "W-20260628-0001",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Git memory session not found");
    await expect(access(join(contextStoreDir, "sessions", sessionId, ".git"))).rejects.toThrow();
  });

  it("returns a clear validation error when session id is missing", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-context-skill-"));
    const skill = createGitContextSkill({ contextStoreDir });
    const tool = requiredTool(skill, "git_context_active");

    const result = await tool.execute({});

    expect(result.ok).toBe(false);
    expect(result.error).toContain("sessionId is required");
    expect(result.v2?.error).toMatchObject({
      category: "validation",
      retryable: true,
    });
  });
});

async function prepareGitContextSession(): Promise<{
  contextStoreDir: string;
  store: GitMemoryDailySessionStore;
  session: Awaited<ReturnType<GitMemoryDailySessionStore["openOrCreateDailySession"]>>;
  task: Awaited<ReturnType<GitMemoryDailySessionStore["createTaskBranch"]>>;
}> {
  const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-context-skill-"));
  const store = new GitMemoryDailySessionStore({ contextStoreDir });
  const session = await store.openOrCreateDailySession({
    date: "2026-06-28",
    timezone: "Asia/Kolkata",
    agentId: "local",
    createdAt: "2026-06-28T00:00:00+05:30",
  });
  const user = await store.appendConversationMessage({
    sessionId: session.sessionId,
    role: "user",
    text: "Fix upload handling",
    at: "2026-06-28T09:00:00+05:30",
  });
  const task = await store.createTaskBranch({
    sessionId: session.sessionId,
    title: "Fix upload handling",
    objective: "Find and fix upload handling failures.",
    fromSeq: user.seq,
    toSeq: user.seq,
    at: "2026-06-28T09:01:00+05:30",
  });
  await store.commitTaskRun({
    sessionId: session.sessionId,
    taskId: task.taskId,
    status: "completed",
    startedAt: "2026-06-28T09:02:00+05:30",
    completedAt: "2026-06-28T09:10:00+05:30",
    conversationRefs: [{ fromSeq: user.seq, toSeq: user.seq }],
    summary: "Inspected upload handling.",
    actions: [{
      actionId: "ACT-20260628-000001",
      tool: "read_file",
      status: "completed",
      summary: "Read upload server implementation.",
      evidenceRef: "evidence/ACT-20260628-000001.txt",
    }],
    newFacts: ["Upload route validates MIME type."],
    next: "Patch upload validation handling.",
    state: {
      status: "in_progress",
      completed: ["Inspected upload server"],
      open: ["Patch upload validation handling."],
      next: "Patch upload validation handling.",
    },
  });
  await store.commitTaskRun({
    sessionId: session.sessionId,
    taskId: task.taskId,
    status: "completed",
    startedAt: "2026-06-28T09:12:00+05:30",
    completedAt: "2026-06-28T09:20:00+05:30",
    conversationRefs: [{ fromSeq: user.seq, toSeq: user.seq }],
    summary: "Patched upload validation handling.",
    actions: [{
      actionId: "ACT-20260628-000101",
      tool: "edit_file",
      status: "completed",
      summary: "Patched upload validation branch.",
      evidenceRef: "evidence/ACT-20260628-000101.txt",
    }],
    evidence: [{
      step: 2,
      actionId: "ACT-20260628-000101",
      tool: "edit_file",
      status: "completed",
      summary: "Patched upload validation branch.",
      evidenceRef: "evidence/ACT-20260628-000101.txt",
      artifacts: ["ayati-main/src/server/upload-server.ts"],
      facts: ["Upload validation handles multipart MIME metadata."],
      accessModes: ["summary"],
      source: { kind: "test-fixture" },
    }],
    newFacts: ["Upload validation handles multipart MIME metadata."],
    next: "Verify upload validation patch.",
    state: {
      status: "in_progress",
      completed: ["Inspected upload server", "Patched upload validation handling"],
      open: ["Verify upload validation patch."],
      next: "Verify upload validation patch.",
    },
  });
  const driver = new GitMemoryWorktreeGitDriver(session.repoPath);
  await driver.commitSyntheticFiles({
    ref: task.ref,
    files: {
      [gitMemoryTaskAssetsPath(task.taskId)]: `${JSON.stringify({
        schemaVersion: 1,
        assets: [{
          assetId: "asset-upload-log",
          role: "reference",
          kind: "file",
          name: "upload.log",
          path: "/tmp/upload.log",
        }],
      })}\n`,
    },
    message: renderGitMemoryCommitMessage({
      subject: "ayati: attach upload log",
      summary: "Register upload log as task reference evidence.",
      trailers: {
        sessionId: session.sessionId,
        taskId: task.taskId,
        event: "asset_registered",
        at: "2026-06-28T09:21:00+05:30",
        branch: task.branch,
        schemaVersion: 1,
      },
    }),
  });
  return { contextStoreDir, store, session, task };
}

async function prepareMultiTaskGitContextSession(): Promise<{
  contextStoreDir: string;
  store: GitMemoryDailySessionStore;
  session: Awaited<ReturnType<GitMemoryDailySessionStore["openOrCreateDailySession"]>>;
  uploadTask: Awaited<ReturnType<GitMemoryDailySessionStore["createTaskBranch"]>>;
  reminderTask: Awaited<ReturnType<GitMemoryDailySessionStore["createTaskBranch"]>>;
}> {
  const prepared = await prepareGitContextSession();
  const reminderUser = await prepared.store.appendConversationMessage({
    sessionId: prepared.session.sessionId,
    role: "user",
    text: "Fix reminder scheduling drift",
    at: "2026-06-28T10:00:00+05:30",
  });
  const reminderTask = await prepared.store.createTaskBranch({
    sessionId: prepared.session.sessionId,
    title: "Fix reminder scheduling",
    objective: "Investigate reminder scheduling drift before daily notifications.",
    fromSeq: reminderUser.seq,
    toSeq: reminderUser.seq,
    at: "2026-06-28T10:01:00+05:30",
    state: {
      status: "blocked",
      summary: "Reminder scheduling drifts when timezone data is missing.",
      open: ["Collect timezone fixture before patching reminder scheduling."],
      blockers: ["Need timezone fixture for reminder scheduler."],
      facts: ["Reminder drift appears around daily notifications."],
      next: "Ask user for expected reminder timezone behavior.",
    },
  });

  return {
    contextStoreDir: prepared.contextStoreDir,
    store: prepared.store,
    session: prepared.session,
    uploadTask: prepared.task,
    reminderTask,
  };
}

function requiredTool(skill: ReturnType<typeof createGitContextSkill>, name: string) {
  const tool = skill.tools.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`Missing tool: ${name}`);
  }
  return tool;
}
