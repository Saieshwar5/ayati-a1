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
      skillBlocks: [{ id: "skill-a", content: "Use A" }],
      toolDirectory: "",
    };

    const memoryContext: PromptMemoryContext = {
      conversationTurns: [{ role: "user", content: "hi", timestamp: "t1" }],
      previousSessionSummary: "summary",
      toolEvents: [
        {
          timestamp: "t2",
          toolName: "shell",
          status: "success",
          argsPreview: "{\"cmd\":\"pwd\"}",
          outputPreview: "/tmp",
        },
      ],
      recalledEvidence: [
        {
          sessionId: "s-1",
          turnRef: "turn-4",
          timestamp: "t0",
          snippet: "Earlier we picked option A",
          whyRelevant: "Matched terms: option, A",
          confidence: 0.8,
        },
      ],
      contextRecallStatus: {
        status: "found",
        reason: "Relevant evidence found",
        searchedSessions: 1,
        modelCalls: 3,
        triggerReason: "history-reference",
      },
    };

    const result = assemblePromptInput(staticContext, memoryContext);

    expect(result.basePrompt).toBe("Base prompt");
    expect(result.conversationTurns).toHaveLength(1);
    expect(result.previousSessionSummary).toBe("summary");
    expect(result.toolEvents).toHaveLength(1);
    expect(result.recalledEvidence).toHaveLength(1);
    expect(result.contextRecallStatus?.status).toBe("found");
    expect(result.skillBlocks).toEqual([{ id: "skill-a", content: "Use A" }]);
  });

  it("handles empty memory context", () => {
    const staticContext: StaticContext = {
      basePrompt: "Base",
      soul: emptySoulContext(),
      userProfile: emptyUserProfileContext(),
      skillBlocks: [],
      toolDirectory: "",
    };

    const memoryContext: PromptMemoryContext = {
      conversationTurns: [],
      previousSessionSummary: "",
      toolEvents: [],
    };

    const result = assemblePromptInput(staticContext, memoryContext);

    expect(result.conversationTurns).toEqual([]);
    expect(result.previousSessionSummary).toBe("");
    expect(result.toolEvents).toEqual([]);
    expect(result.recalledEvidence).toEqual([]);
    expect(result.contextRecallStatus).toBeUndefined();
  });
});
