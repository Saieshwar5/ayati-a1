import { describe, expect, it } from "vitest";
import type { ActiveContext } from "ayati-git-context";
import { buildContextEngineProjection } from "../../src/context-engine/index.js";
import {
  projectAgentPromptContext,
  projectAgentStateViewForPrompt,
} from "../../src/ivec/agent-runner/prompt-context.js";

describe("context engine projection", () => {
  it("keeps runtime checkout authority separate while exposing the user-facing working directory", () => {
    const checkoutPath = "/workspace/aurora-coffee-site";
    const projection = buildContextEngineProjection(activeTaskContext(checkoutPath));

    expect(projection.task?.checkoutPath).toBe(checkoutPath);

    const promptContext = projectAgentPromptContext({
      context: { timeline: [], gitContext: projection },
    });
    const prompt = projectAgentStateViewForPrompt({ context: promptContext });
    expect(prompt.context.git?.current.task).toBeDefined();
    expect(prompt.context.git?.current.task).not.toHaveProperty("checkoutPath");
    expect(prompt.context.git?.current.task?.identity.workingDirectory).toBe(checkoutPath);
    expect(prompt.context.git?.current.task?.assets).toEqual([
      expect.objectContaining({ path: "/workspace/aurora-coffee-site/index.html" }),
    ]);
  });

  it("preserves recent session commits in the provider-facing prompt", () => {
    const active = activeTaskContext("/internal/session/tasks/W-20260714-0001");
    if (!active.session) throw new Error("Expected a session fixture.");
    active.session.recentCommits = [{
      commit: "d".repeat(40),
      subject: "session: created aurora coffee website",
      committedAt: "2026-07-14T10:30:00.000Z",
      conversationSummary: "The user requested an Aurora Coffee website.",
      workSummary: "Created and validated the responsive website.",
      assets: [
        { path: "aurora-coffee-site/index.html", description: "Main website page" },
        { path: "aurora-coffee-site/styles.css", description: "Responsive styling" },
      ],
      outcome: "done",
      validation: "passed",
      taskId: "W-20260714-0001",
      runId: "R-20260714-0004",
    }];

    const projection = buildContextEngineProjection(active);
    const promptContext = projectAgentPromptContext({
      context: { timeline: [], gitContext: projection },
    });
    const prompt = projectAgentStateViewForPrompt({ context: promptContext });

    expect(prompt.context.git?.session.recentCommits).toEqual([{
      commit: "d".repeat(40),
      subject: "session: created aurora coffee website",
      conversationSummary: "The user requested an Aurora Coffee website.",
      workSummary: "Created and validated the responsive website.",
      assets: [
        { path: "/internal/session/tasks/W-20260714-0001/aurora-coffee-site/index.html", description: "Main website page" },
        { path: "/internal/session/tasks/W-20260714-0001/aurora-coffee-site/styles.css", description: "Responsive styling" },
      ],
      outcome: "done",
      validation: "passed",
      at: "2026-07-14T10:30:00.000Z",
      workId: "W-20260714-0001",
      runId: "R-20260714-0004",
    }]);
  });
});

function activeTaskContext(checkoutPath: string): ActiveContext {
  return {
    contextRevision: "revision-1",
    session: {
      session: {
        sessionId: "S-20260714-local",
        repositoryPath: "/session",
        head: "a".repeat(40),
        date: "2026-07-14",
        timezone: "UTC",
        status: "open",
      },
      summary: "",
      pendingConversation: [{
        conversationId: "C-1",
        sessionId: "S-20260714-local",
        sequence: 1,
        filePath: "conversations/000001.pending.md",
        status: "active",
      }],
      pendingConversationContext: [{
        conversation: {
          conversationId: "C-1",
          sessionId: "S-20260714-local",
          sequence: 1,
          filePath: "conversations/000001.pending.md",
          status: "active",
        },
        messages: [],
        contentHash: "sha256:" + "b".repeat(64),
      }],
      pendingDigest: "digest",
      recentCommits: [],
    },
    activeTask: {
      task: {
        taskId: "W-20260714-0001",
        repositoryPath: "/tasks/W-20260714-0001.git",
        workingPath: checkoutPath,
        branch: "main",
        head: "c".repeat(40),
      },
      checkoutPath,
      workingDirectory: checkoutPath,
      title: "Aurora Coffee website",
      objective: "Build the website.",
      summary: "Task started.",
      importantPaths: ["index.html"],
      recentCommits: [],
    },
    run: {
      run: {
        runId: "R-1",
        sessionId: "S-20260714-local",
        conversationId: "C-1",
        runClass: "task",
        taskId: "W-20260714-0001",
        status: "running",
        trigger: "user",
        startedAt: "2026-07-14T10:00:00.000Z",
        stepCount: 0,
      },
      workState: {
        runId: "R-1",
        revision: 0,
        afterStep: 0,
        status: "not_done",
        summary: "Task started.",
        openWork: [],
        blockers: [],
        facts: [],
        evidence: [],
        artifacts: [],
        nextStep: null,
        userInputNeeded: [],
        updatedAt: "2026-07-14T10:00:00.000Z",
      },
      steps: [],
    },
    warnings: [],
  };
}
