import { describe, expect, it } from "vitest";
import { buildAgentStateView } from "../../src/ivec/agent-runner/state-view.js";
import type { ContextEngineMachineContext } from "../../src/context-engine/index.js";
import type { HarnessContext } from "../../src/ivec/harness-context.js";
import type { LoopState } from "../../src/ivec/types.js";

function createHarnessContext(overrides: Partial<HarnessContext> = {}): HarnessContext {
  return {
    personalMemorySnapshot: "",
    ...overrides,
  };
}

function createGitContext(overrides: Partial<ContextEngineMachineContext> = {}): ContextEngineMachineContext {
  return {
    session: {
      sessionId: "2026-06-27",
      conversationTail: [],
      activityTail: [],
      recentCommits: [{
        commit: "abc123",
        subject: "ayati: checkpoint session",
        event: "session_checkpointed",
      }],
      assetCount: 0,
    },
    focus: {
      status: "active",
      ref: "refs/heads/work/W-20260627-0001-analyze-invoice",
      workId: "W-20260627-0001",
    },
    task: {
      ref: "refs/heads/work/W-20260627-0001-analyze-invoice",
      workId: "W-20260627-0001",
      title: "Analyze invoice",
      objective: "Analyze invoice",
      status: "active",
      completed: ["Read invoice"],
      open: ["Summarize invoice"],
      blockers: [],
      facts: [{ text: "Invoice has three line items.", source: "ev-001" }],
      next: "Summarize invoice",
      assets: [{
        assetId: "A-20260627-0001",
        role: "input",
        kind: "document",
        name: "invoice.pdf",
        path: "uploads/invoice.pdf",
      }],
      recentRuns: [{
        schemaVersion: 1,
        runId: "R-20260627-0001",
        workId: "W-20260627-0001",
        status: "completed",
        summary: "Read invoice.",
        completed: ["Read invoice"],
        open: ["Summarize invoice"],
        actions: ["action-0001"],
        createdAt: "2026-06-27T10:00:00.000Z",
      }],
      recentCommits: [],
      recentEvidence: [],
    },
    ...overrides,
  };
}

function createLoopState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    runId: "run-current",
    currentSeq: 1,
    runClass: "task",
    userMessage: "continue invoice",
    workState: {
      status: "not_done",
      openWork: [],
      blockers: [],
      summary: "",
      verifiedFacts: [],
      evidence: [],
    },
    status: "running",
    finalOutput: "",
    iteration: 0,
    maxIterations: 15,
    consecutiveFailures: 0,
    completedSteps: [],
    runPath: "/tmp/ayati/run-current",
    failureHistory: [],
    harnessContext: createHarnessContext(),
    ...overrides,
  };
}

describe("buildAgentStateView", () => {
  it("exposes git context as the durable task source", () => {
    const state = createLoopState({
      harnessContext: createHarnessContext({
        contextEngine: createGitContext(),
      }),
    });

    const context = buildAgentStateView(state).context;
    expect(context.gitContext?.task).toMatchObject({
      workId: "W-20260627-0001",
      open: ["Summarize invoice"],
      facts: [{ text: "Invoice has three line items.", source: "ev-001" }],
    });
    expect(context.git?.current.task).toMatchObject({
      workId: "W-20260627-0001",
      open: ["Summarize invoice"],
    });
    expect(context.git?.session).toMatchObject({
      meta: {
        sessionId: "2026-06-27",
        assetCount: 0,
      },
      activity: {
        recent: [],
      },
    });
    expect(context.git?.session).not.toHaveProperty("recentCommits");
    expect(context.git?.session).not.toHaveProperty("conversationTail");
    expect(context.git?.session).not.toHaveProperty("conversationMarkdownTail");
    expect(context.git?.current).not.toHaveProperty("session");
    expect(context.git?.current.task).not.toHaveProperty("conversationMarkdownTail");
    expect(context.gitContext?.session.recentCommits).toHaveLength(1);
    expect(context).not.toHaveProperty("continuity");
    expect(context).not.toHaveProperty("taskThreadContext");
    expect(context).not.toHaveProperty("sessionWork");
  });

  it("adds routing feedback for an unbound pending turn", () => {
    const state = createLoopState({
      harnessContext: createHarnessContext({
        contextEngine: createGitContext({
          pendingTurn: {
            fromSeq: 4,
            toSeq: 4,
            text: "add another story",
            at: "2026-06-27T10:02:00.000Z",
            routingStatus: "unbound",
          },
        }),
      }),
    });

    expect(buildAgentStateView(state).workingFeedback?.latest[0]).toMatchObject({
      severity: "warning",
      source: "tool_validation",
      message: expect.stringContaining("pending turn is unbound"),
      retryHint: expect.stringContaining("git_context_activate_task_for_turn"),
    });
  });

  it("adds ask-user feedback for a clarifying pending turn", () => {
    const state = createLoopState({
      harnessContext: createHarnessContext({
        contextEngine: createGitContext({
          pendingTurn: {
            fromSeq: 4,
            toSeq: 4,
            text: "build it",
            at: "2026-06-27T10:02:00.000Z",
            routingStatus: "clarifying",
          },
        }),
      }),
    });

    expect(buildAgentStateView(state).workingFeedback?.latest[0]).toMatchObject({
      severity: "warning",
      source: "tool_validation",
      message: expect.stringContaining("pending turn is clarifying"),
      retryHint: expect.stringContaining("decision_ask_user"),
    });
  });

  it("builds timeline from git conversation tail", () => {
    const state = createLoopState({
      currentSeq: 3,
      userMessage: "yes",
      harnessContext: createHarnessContext({
        contextEngine: createGitContext({
          session: {
            sessionId: "2026-06-27",
            activityTail: [],
            assetCount: 0,
            conversationTail: [
              {
                seq: 1,
                role: "assistant",
                at: "2026-06-27T10:00:00.000Z",
                text: "Should I summarize the invoice now?",
              },
              {
                seq: 3,
                role: "user",
                at: "2026-06-27T10:01:00.000Z",
                text: "yes",
              },
            ],
          },
        }),
      }),
    });

    expect(buildAgentStateView(state).context.timeline).toEqual([
      {
        kind: "assistant",
        seq: 1,
        timestamp: "2026-06-27T10:00:00.000Z",
        content: "Should I summarize the invoice now?",
        expectsUserResponse: true,
      },
      {
        kind: "user",
        seq: 3,
        timestamp: "2026-06-27T10:01:00.000Z",
        content: "yes",
        current: true,
      },
    ]);
    const context = buildAgentStateView(state).context;
    expect(context.gitContext?.session.conversationTail).toHaveLength(2);
    expect(context.git?.session).not.toHaveProperty("conversationTail");
  });

  it("falls back to the current input when git conversation is unavailable", () => {
    const state = createLoopState({
      currentSeq: 7,
      userMessage: "start a new task",
    });

    expect(buildAgentStateView(state).context.timeline).toEqual([{
      kind: "user",
      seq: 7,
      timestamp: "1970-01-01T00:00:00.000Z",
      content: "start a new task",
      current: true,
    }]);
  });

  it("keeps personal memory but omits old session state", () => {
    const state = createLoopState({
      harnessContext: createHarnessContext({
        personalMemorySnapshot: "Prefer exact schema contracts.",
        contextEngine: createGitContext(),
      }),
    });

    const stateView = buildAgentStateView(state);
    expect(stateView.context.personalMemorySnapshot).toBe("Prefer exact schema contracts.");
    expect(stateView.context.personal).toEqual({
      memorySnapshot: "Prefer exact schema contracts.",
    });
    expect(Object.keys(stateView.context).sort()).toEqual([
      "git",
      "gitContext",
      "personal",
      "personalMemorySnapshot",
      "timeline",
    ]);
  });

  it("keeps progress, observations, and trace independent from context source", () => {
    const state = createLoopState({
      workState: {
        status: "needs_user_input",
        summary: "Need approval before editing.",
        openWork: ["Patch prompt"],
        blockers: ["Approval required"],
        verifiedFacts: ["State view uses git context."],
        evidence: ["state-view.ts"],
        userInputNeeded: "Can I edit the prompt?",
      },
      toolContext: {
        recent: [{
          id: "obs-1",
          step: 1,
          callId: "call-1",
          tool: "read_file",
          status: "success",
          mode: "summary",
          retention: "while_relevant",
          content: "Read state-view.ts.",
          hasMore: false,
        }],
      },
      completedSteps: [{
        step: 1,
        outcome: "success",
        summary: "Inspected state view.",
        newFacts: ["State view uses git context."],
        artifacts: [],
        toolsUsed: ["read_file"],
        toolSuccessCount: 1,
        toolFailureCount: 0,
      }],
      failureHistory: [{
        step: 2,
        failureType: "permission",
        reason: "Approval required before editing.",
        blockedTargets: ["prompt"],
      }],
    });

    const stateView = buildAgentStateView(state);
    expect(stateView.progress).toMatchObject({
      status: "needs_user_input",
      summary: "Need approval before editing.",
      userInputNeeded: "Can I edit the prompt?",
    });
    expect(stateView.context.scratch?.progress).toMatchObject({
      status: "needs_user_input",
      summary: "Need approval before editing.",
      userInputNeeded: "Can I edit the prompt?",
    });
    expect(stateView.observations?.latest).toHaveLength(1);
    expect((stateView.context.scratch?.observations as { latest?: unknown[] } | undefined)?.latest).toHaveLength(1);
    expect(stateView.observations?.latest[0]?.retention).toBe("while_relevant");
    expect(stateView.trace?.recentSteps?.map((step) => step.step)).toEqual([1]);
    expect((stateView.context.scratch?.trace as { recentSteps?: Array<{ step: number }> } | undefined)?.recentSteps?.map((step) => step.step)).toEqual([1]);
    expect(stateView.workingFeedback?.latest[0]).toMatchObject({
      source: "tool_execution",
      message: "Approval required before editing.",
    });
    expect((stateView.context.scratch?.feedback as { latest?: Array<{ source: string }> } | undefined)?.latest?.[0])
      .toMatchObject({ source: "tool_execution" });
  });
});
