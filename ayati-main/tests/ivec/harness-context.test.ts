import { describe, expect, it } from "vitest";
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
      contextEngine,
    });

    expect(context).toMatchObject({
      personalMemorySnapshot: "",
      contextEngine,
    });
    expect(context).not.toHaveProperty("continuity");
    expect(context).not.toHaveProperty("sessionWork");
    expect(context).not.toHaveProperty("taskThreadContext");
  });

  it("builds harness context from explicit personal memory and context-engine input", () => {
    const contextEngine = contextEngineFixture();

    const context = buildHarnessContextFromSources({
      input: {
        personalMemorySnapshot: "- Likes short plans.",
        contextEngine,
      },
    });

    expect(context.personalMemorySnapshot).toBe("- Likes short plans.");
    expect(context.contextEngine).toBe(contextEngine);
    expect(context).not.toHaveProperty("sessionEvents");
    expect(context).not.toHaveProperty("sessionWork");
    expect(context).not.toHaveProperty("taskThreadContext");
    expect(context).not.toHaveProperty("continuity");
  });

  it("applies harness context to runner state", () => {
    const target: HarnessContextTarget = {
      harnessContext: createInitialHarnessContext(),
    };
    const context = createInitialHarnessContext({
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
      activityTail: [],
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
      recentEvidence: [],
    },
  };
}
