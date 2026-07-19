import type { GitContextService } from "ayati-git-context";
import { describe, expect, it, vi } from "vitest";
import { createGitContextSkill } from "../../src/skills/builtins/git-context/index.js";

describe("model-facing task routing", () => {
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
