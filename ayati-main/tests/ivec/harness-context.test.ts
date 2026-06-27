import { describe, expect, it } from "vitest";
import { noopSessionMemory } from "../../src/memory/provider.js";
import {
  applyHarnessContextToState,
  buildHarnessContextFromSources,
  createInitialHarnessContext,
} from "../../src/ivec/harness-context.js";
import type { HarnessContextTarget } from "../../src/ivec/harness-context.js";

describe("harness context", () => {
  it("creates initial context from explicit harness input", () => {
    const contextEngine = contextEngineFixture();

    const context = createInitialHarnessContext({
      activeLearningContext: "Prefer concise implementation notes.",
      contextEngine,
    });

    expect(context).toMatchObject({
      activeLearningContext: "Prefer concise implementation notes.",
      personalMemorySnapshot: "",
      continuity: { mode: "new", reasons: ["initial state"] },
      recentExchanges: [],
      activeContextStartSeq: 1,
      contextEngine,
    });
  });

  it("builds harness context from session memory and context-engine input", () => {
    const contextEngine = contextEngineFixture();
    const sessionMemory = {
      ...noopSessionMemory,
      getPromptMemoryContext: () => ({
        recentExchanges: [],
        sessionEvents: [{
          type: "user_message" as const,
          seq: 7,
          timestamp: "2026-06-27T10:00:00.000Z",
          content: "continue invoice",
        }],
        activeContextStartSeq: 7,
        sessionWork: {
          activeContextStartSeq: 7,
          recentActivities: [],
        },
        taskThreadContext: {
          suspendedTasks: [],
          recentSignals: {
            latestUserMessage: "continue invoice",
            previousAssistantExpectedAnswer: false,
            hasFollowUpSignal: true,
            hasExplicitNewTaskSignal: false,
            mentionedAssetNames: [],
            mentionedAssetPaths: [],
          },
          suggestedBinding: {
            mode: "continue_task" as const,
            taskThreadId: "task-thread-1",
            confidence: 0.9,
            reason: "follow-up signal",
          },
        },
        conversationTurns: [],
        recentSystemEvents: [],
        personalMemorySnapshot: "- Likes short plans.",
      }),
    };

    const context = buildHarnessContextFromSources({
      sessionMemory,
      clientId: "local",
      sessionId: "s1",
      userMessage: "continue invoice",
      currentAssetRefs: [],
      input: {
        activeLearningContext: "Use focused tests first.",
        contextEngine,
      },
    });

    expect(context.personalMemorySnapshot).toBe("- Likes short plans.");
    expect(context.sessionEvents).toHaveLength(1);
    expect(context.activeContextStartSeq).toBe(7);
    expect(context.sessionWork.activeContextStartSeq).toBe(7);
    expect(context.taskThreadContext?.suggestedBinding).toMatchObject({
      mode: "continue_task",
      taskThreadId: "task-thread-1",
    });
    expect(context.continuity).toMatchObject({
      mode: "new",
      reasons: ["activity store is not configured"],
    });
    expect(context.activeLearningContext).toBe("Use focused tests first.");
    expect(context.contextEngine).toBe(contextEngine);
  });

  it("applies harness context to runner state", () => {
    const target: HarnessContextTarget = {
      harnessContext: createInitialHarnessContext(),
    };
    const context = createInitialHarnessContext({
      activeLearningContext: "Keep it direct.",
      contextEngine: contextEngineFixture(),
    });

    applyHarnessContextToState(target, context);

    expect(target.harnessContext).toBe(context);
  });
});

function contextEngineFixture() {
  return {
    session: {
      sessionId: "2026-06-27",
      conversationTail: [],
      eventTail: [],
      assetCount: 0,
    },
    focus: {
      status: "active" as const,
      ref: "refs/heads/work/W-20260627-0001-analyze-invoice",
      workId: "W-20260627-0001",
    },
    task: {
      ref: "refs/heads/work/W-20260627-0001-analyze-invoice",
      workId: "W-20260627-0001",
      title: "Analyze invoice",
      objective: "Analyze invoice",
      status: "active",
      completed: [],
      open: ["Summarize invoice"],
      blockers: [],
      facts: [],
      assets: [],
      recentRuns: [],
      recentCommits: [],
    },
  };
}
