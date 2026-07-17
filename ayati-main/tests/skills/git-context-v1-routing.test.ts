import type { GitContextService } from "ayati-git-context";
import { describe, expect, it, vi } from "vitest";
import { createGitContextSkill } from "../../src/skills/builtins/git-context/index.js";

describe("model-facing V1 task routing", () => {
  it("submits the explicit create-request decision and binds attachments", async () => {
    const activateTaskRun = vi.fn(async (input) => ({
      task: task(),
      repositoryLayout: "simple_repository_v1" as const,
      run: {
        runId: "RUN-1",
        sessionId: "S-1",
        conversationId: "C-1",
        runClass: "task" as const,
        taskId: task().taskId,
        taskRequestId: "R-0002",
      },
      context: {} as never,
      taskCreated: false,
      mountCreated: false,
      runPromoted: true,
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
      activateTaskRun,
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
    }, { sessionId: "S-1", runId: "RUN-1" });

    expect(result.ok).toBe(true);
    expect(activateTaskRun).toHaveBeenCalledWith(expect.objectContaining({
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
    layoutVersion: "simple_repository_v1" as const,
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
        runClass: selected ? "task" : "session",
        ...(selected ? { taskId: task().taskId, taskRequestId: "R-0002" } : {}),
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
