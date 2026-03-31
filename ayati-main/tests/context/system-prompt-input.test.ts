import { describe, expect, it } from "vitest";
import { assemblePromptInput } from "../../src/context/load-system-prompt-input.js";
import { emptySoulContext, emptyUserProfileContext } from "../../src/context/types.js";
import type { StaticContext } from "../../src/context/static-context-cache.js";
import type { PromptMemoryContext } from "../../src/memory/types.js";

describe("assemblePromptInput", () => {
  it("maps static context and memory context to PromptBuildInput", () => {
    const staticContext: StaticContext = {
      basePrompt: "Base prompt",
      soul: emptySoulContext(),
      userProfile: emptyUserProfileContext(),
      controllerPrompts: {
        understand: "",
        direct: "",
        reeval: "",
        systemEvent: "",
      },
      skillBlocks: [{ id: "skill-a", content: "Use A" }],
      toolDirectory: "",
    };

    const memoryContext: PromptMemoryContext = {
      conversationTurns: [{ role: "user", content: "hi", timestamp: "t1", sessionPath: "s/p" }],
      previousSessionSummary: "summary",
      activeSessionPath: "sessions/s1.md",
      recentRunLedgers: [
        {
          timestamp: "t2",
          runId: "r1",
          runPath: "data/runs/r1",
          state: "completed",
          status: "completed",
          summary: "done",
        },
      ],
      openFeedbacks: [
        {
          feedbackId: "fb-1",
          status: "open",
          kind: "approval",
          shortLabel: "send report",
          message: "Should I send the report?",
          actionType: "send_email",
          sourceRunId: "r1",
          entityHints: ["report"],
          createdAt: "t0",
          expiresAt: "t1",
        },
      ],
      recentSystemActivity: [
        {
          timestamp: "t3",
          source: "pulse",
          event: "reminder_due",
          eventId: "evt-1",
          summary: "checked health",
          userVisible: true,
          responseKind: "notification",
        },
      ],
    };

    const result = assemblePromptInput(staticContext, memoryContext);

    expect(result.basePrompt).toBe("Base prompt");
    expect(result.conversationTurns).toHaveLength(1);
    expect(result.previousSessionSummary).toBe("summary");
    expect(result.activeSessionPath).toBe("sessions/s1.md");
    expect(result.recentRunLedgers).toHaveLength(1);
    expect(result.openFeedbacks).toHaveLength(1);
    expect(result.recentSystemActivity).toHaveLength(1);
    expect(result.skillBlocks).toEqual([{ id: "skill-a", content: "Use A" }]);
  });

  it("handles empty memory context", () => {
    const staticContext: StaticContext = {
      basePrompt: "Base",
      soul: emptySoulContext(),
      userProfile: emptyUserProfileContext(),
      controllerPrompts: {
        understand: "",
        direct: "",
        reeval: "",
        systemEvent: "",
      },
      skillBlocks: [],
      toolDirectory: "",
    };

    const memoryContext: PromptMemoryContext = {
      conversationTurns: [],
      previousSessionSummary: "",
      activeSessionPath: "",
      recentRunLedgers: [],
      openFeedbacks: [],
      recentSystemActivity: [],
    };

    const result = assemblePromptInput(staticContext, memoryContext);

    expect(result.conversationTurns).toEqual([]);
    expect(result.previousSessionSummary).toBe("");
    expect(result.recentRunLedgers).toEqual([]);
    expect(result.openFeedbacks).toEqual([]);
    expect(result.recentSystemActivity).toEqual([]);
  });
});
