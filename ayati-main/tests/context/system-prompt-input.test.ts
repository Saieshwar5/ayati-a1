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
      conversationTurns: [{ role: "user", content: "hi", timestamp: "t1", sessionPath: "s/p" }],
      previousSessionSummary: "summary",
    };

    const result = assemblePromptInput(staticContext, memoryContext);

    expect(result.basePrompt).toBe("Base prompt");
    expect(result.conversationTurns).toHaveLength(1);
    expect(result.previousSessionSummary).toBe("summary");
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
    };

    const result = assemblePromptInput(staticContext, memoryContext);

    expect(result.conversationTurns).toEqual([]);
    expect(result.previousSessionSummary).toBe("");
  });
});
