import type { GitContextService } from "ayati-git-context";
import { describe, expect, it, vi } from "vitest";
import { createGitContextSkill } from "../../src/skills/builtins/git-context/index.js";

describe("model-facing task routing", () => {
  it("creates approved in-place work with stable run-scoped operation time", async () => {
    const registered = {
      ...task(),
      repositoryPath: "/workspace/existing-notes",
      workingPath: "/workspace/existing-notes",
      placement: "requested" as const,
      trustedRoot: "/workspace",
    };
    const selectedContext = activeContext(true);
    selectedContext.activeTask = {
      ...(selectedContext.activeTask as Record<string, unknown>),
      task: registered,
      workingDirectory: registered.workingPath,
    };
    const createTaskForRun = vi.fn(async () => ({
      task: registered,
      run: {
        runId: "RUN-1",
        sessionId: "S-1",
        conversationId: "C-1",
        taskBinding: {
          taskId: registered.taskId,
          taskRequestId: "R-0001",
          boundAt: "2026-07-17T20:00:01+05:30",
        },
      },
      context: { currentRequest: { status: "active" } } as never,
      taskCreated: true,
      taskRequestDecision: "initial" as const,
      taskRequestStatus: "active" as const,
      taskRequestCreated: true,
      headBeforeSelection: registered.head,
    }));
    const service = {
      getActiveContext: vi.fn()
        .mockResolvedValueOnce(activeContext(false))
        .mockResolvedValueOnce(selectedContext),
      createTaskForRun,
      bindTaskAttachments: vi.fn(async () => ({
        taskId: registered.taskId,
        runId: "RUN-1",
        references: [],
      })),
    } as unknown as GitContextService;
    const tool = createGitContextSkill({ service }).tools
      .find((candidate) => candidate.name === "git_context_create_task")!;

    const result = await tool.execute({
      title: "Durable research notes",
      objective: "Continue the approved notes across sessions.",
      reason: "The notes are a new long-lived workstream.",
      workingDirectory: registered.workingPath,
      registrationApprovalId: "I-approved-baseline",
    }, { sessionId: "S-1", runId: "RUN-1", callId: "create-task" });

    expect(result.ok).toBe(true);
    expect(result.v2?.structuredContent).toMatchObject({
      mode: "created",
      workingDirectory: registered.workingPath,
    });
    expect(createTaskForRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: "RUN-1",
      at: "2026-07-17T20:00:00+05:30",
      placement: {
        mode: "requested",
        workingDirectory: registered.workingPath,
        registrationApprovalId: "I-approved-baseline",
      },
    }));
  });

  it("submits the explicit create-request decision and binds attachments", async () => {
    const activateTaskForRun = vi.fn(async (input) => ({
      task: task(),
      run: {
        runId: "RUN-1",
        sessionId: "S-1",
        conversationId: "C-1",
        taskBinding: {
          taskId: task().taskId,
          taskRequestId: "R-0002",
          boundAt: "2026-07-17T20:00:01+05:30",
        },
      },
      context: {
        currentRequest: { status: "active" },
      } as never,
      taskCreated: false,
      taskRequestDecision: "create" as const,
      taskRequestStatus: "active" as const,
      taskRequestCreated: true,
      headBeforeSelection: task().head,
    }));
    const bindTaskAttachments = vi.fn(async () => ({
      taskId: task().taskId,
      runId: "RUN-1",
      references: [],
    }));
    const service = {
      getActiveContext: vi.fn()
        .mockResolvedValueOnce(activeContext(false))
        .mockResolvedValueOnce(activeContext(true)),
      activateTaskForRun,
      bindTaskAttachments,
    } as unknown as GitContextService;
    const tool = createGitContextSkill({ service }).tools
      .find((candidate) => candidate.name === "git_context_activate_task")!;

    const result = await tool.execute({
      taskId: task().taskId,
      reason: "This is the next feature in the same website.",
      requestDecision: {
        kind: "create",
        title: "Add menu",
        request: "Add the menu page.",
        acceptance: ["The menu page is verified."],
        constraints: ["Keep the existing design."],
      },
    }, { sessionId: "S-1", runId: "RUN-1", callId: "activate-task" });

    expect(result.ok).toBe(true);
    expect(result.v2?.structuredContent).toMatchObject({
      workingDirectory: task().workingPath,
      requestDecision: "create",
      taskRequestId: "R-0002",
      taskRequestCreated: true,
    });
    expect(activateTaskForRun).toHaveBeenCalledWith(expect.objectContaining({
      taskId: task().taskId,
      runId: "RUN-1",
      route: {
        kind: "create_active_request",
        reason: "This is the next feature in the same website.",
        title: "Add menu",
        request: "Add the menu page.",
        acceptance: ["The menu page is verified."],
        constraints: ["Keep the existing design."],
      },
    }));
    expect(bindTaskAttachments).toHaveBeenCalledWith(expect.objectContaining({
      runId: "RUN-1",
      taskId: task().taskId,
    }));
  });

  it("finds and opens durable work without binding the run", async () => {
    const candidate = {
      taskId: task().taskId,
      title: task().title,
      objective: task().objective,
      status: "active" as const,
      lifecycleStatus: "active" as const,
      repositoryHealth: "ready" as const,
      currentRequest: { id: "R-0001", title: "Build site", status: "active" as const },
      head: task().head,
      workingDirectory: task().workingPath,
      updatedAt: task().updatedAt,
      discovery: { tier: "probable" as const, reasons: ["text_match" as const] },
      starred: false,
      boundRunsLast30Days: 2,
    };
    const findTasks = vi.fn(async () => ({ tasks: [candidate] }));
    const readTask = vi.fn(async () => ({
      task: task(),
      context: {
        task: task(),
        workingDirectory: task().workingPath,
        title: task().title,
        objective: task().objective,
        summary: "Continue the website.",
        importantPaths: [],
        recentCommits: [],
      },
      opened: true as const,
    }));
    const service = { findTasks, readTask } as unknown as GitContextService;
    const tools = createGitContextSkill({ service }).tools;

    const found = await tools.find((tool) => tool.name === "git_context_find_tasks")!
      .execute({ query: "website" }, { sessionId: "S-1", runId: "RUN-1", callId: "find" });
    const opened = await tools.find((tool) => tool.name === "git_context_read_task")!
      .execute({ taskId: task().taskId }, { sessionId: "S-1", runId: "RUN-1", callId: "open" });

    expect(found.ok).toBe(true);
    expect(found.v2?.structuredContent).toMatchObject({ count: 1, tasks: [candidate] });
    expect(opened.ok).toBe(true);
    expect(findTasks).toHaveBeenCalledWith(expect.objectContaining({
      query: "website",
      sessionId: "S-1",
    }));
    expect(readTask).toHaveBeenCalledWith(expect.objectContaining({
      taskId: task().taskId,
      sessionId: "S-1",
      runId: "RUN-1",
    }));
  });

  it("inspects an existing location without selecting a task", async () => {
    const inspectTaskLocation = vi.fn(async () => ({
      canonicalPath: "/workspace/existing-project",
      kind: "clean_git_repository" as const,
      trustedRoot: "/workspace",
      branch: "main",
      head: "c".repeat(40),
      entryCount: 4,
      totalBytes: 0,
      proposedPaths: [],
      excludedPaths: [],
      warnings: [],
    }));
    const service = {
      getActiveContext: vi.fn(async () => activeContext(false)),
      inspectTaskLocation,
    } as unknown as GitContextService;
    const tool = createGitContextSkill({ service }).tools
      .find((candidate) => candidate.name === "git_context_inspect_task_location")!;

    const result = await tool.execute({
      workingDirectory: "/workspace/existing-project",
    }, { sessionId: "S-1", runId: "RUN-1", callId: "inspect-location" });

    expect(result.ok).toBe(true);
    expect(inspectTaskLocation).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "S-1",
      conversationId: "C-1",
      runId: "RUN-1",
      workingDirectory: "/workspace/existing-project",
    }));
  });

  it("changes a star only through the explicit preference tool", async () => {
    const setTaskStar = vi.fn(async () => ({ taskId: task().taskId, starred: true }));
    const context = activeContext(false);
    context.session.pendingConversationContext[0]!.messages[0]!.content = "Star this workstream.";
    const service = {
      getActiveContext: vi.fn(async () => context),
      setTaskStar,
    } as unknown as GitContextService;
    const tool = createGitContextSkill({ service }).tools
      .find((candidate) => candidate.name === "git_context_set_task_star")!;

    const result = await tool.execute({
      taskId: task().taskId,
      starred: true,
      reason: "The user explicitly asked to star this workstream.",
    }, { sessionId: "S-1", runId: "RUN-1", callId: "star" });

    expect(result.ok).toBe(true);
    expect(setTaskStar).toHaveBeenCalledWith(expect.objectContaining({
      taskId: task().taskId,
      starred: true,
      sessionId: "S-1",
      runId: "RUN-1",
    }));
  });

  it("refuses an autonomous star when the current user did not request it", async () => {
    const setTaskStar = vi.fn();
    const service = {
      getActiveContext: vi.fn(async () => activeContext(false)),
      setTaskStar,
    } as unknown as GitContextService;
    const tool = createGitContextSkill({ service }).tools
      .find((candidate) => candidate.name === "git_context_set_task_star")!;

    const result = await tool.execute({
      taskId: task().taskId,
      starred: true,
      reason: "This task looks important.",
    }, { sessionId: "S-1", runId: "RUN-1", callId: "star" });

    expect(result.ok).toBe(false);
    expect(setTaskStar).not.toHaveBeenCalled();
  });
});

function task() {
  return {
    taskId: "T-20260717-0001",
    repositoryPath: "/workspace/tasks/T-20260717-0001-site",
    workingPath: "/workspace/tasks/T-20260717-0001-site",
    branch: "main",
    head: "a".repeat(40),
    title: "Website",
    objective: "Build and improve the website.",
    status: "active" as const,
    placement: "managed" as const,
    createdSessionId: "S-1",
    createdAt: "2026-07-17T20:00:00+05:30",
    updatedAt: "2026-07-17T20:00:00+05:30",
  };
}

function activeContext(selected: boolean) {
  const value = {
    contextRevision: "sha256:test",
    session: {
      session: {
        sessionId: "S-1",
        repositoryPath: "/session",
        head: "b".repeat(40),
        date: "2026-07-17",
        timezone: "Asia/Kolkata",
        status: "open",
      },
      summary: "",
      pendingConversation: [{
        conversationId: "C-1",
        sessionId: "S-1",
        sequence: 1,
        filePath: "conversation.md",
        status: "active",
      }],
      pendingConversationContext: [{
        conversation: {
          conversationId: "C-1",
          sessionId: "S-1",
          sequence: 1,
          filePath: "conversation.md",
          status: "active",
        },
        messages: [{
          messageId: "M-1",
          conversationId: "C-1",
          sessionSequence: 1,
          segmentSequence: 1,
          sequence: 1,
          role: "user",
          content: "Add the menu.",
          at: "2026-07-17T20:00:00+05:30",
        }],
        contentHash: "sha256:test",
      }],
      pendingDigest: "",
      recentCommits: [],
    },
    run: {
      run: {
        runId: "RUN-1",
        sessionId: "S-1",
        conversationId: "C-1",
        status: "running",
        trigger: "user",
        startedAt: "2026-07-17T20:00:00+05:30",
        stepCount: 0,
        ...(selected ? {
          taskBinding: {
            taskId: task().taskId,
            taskRequestId: "R-0002",
            boundAt: "2026-07-17T20:00:01+05:30",
          },
        } : {}),
      },
      workState: undefined,
      steps: [],
    },
    taskCandidates: [],
    warnings: [],
  } as Record<string, unknown>;
  if (selected) {
    value["activeTask"] = {
      task: task(),
      workingDirectory: task().workingPath,
      title: task().title,
      objective: task().objective,
      summary: "Add the menu.",
      importantPaths: [],
      recentCommits: [],
    };
  }
  return value;
}
