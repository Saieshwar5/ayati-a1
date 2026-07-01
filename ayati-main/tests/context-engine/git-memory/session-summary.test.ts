import { describe, expect, it, vi } from "vitest";
import type { LlmProvider } from "../../../src/core/contracts/provider.js";
import type { LlmTurnInput, LlmTurnOutput } from "../../../src/core/contracts/llm-protocol.js";
import {
  DeterministicGitMemorySessionSummaryUpdater,
  LlmGitMemorySessionSummaryUpdater,
} from "../../../src/context-engine/git-memory/index.js";

describe("git memory session summary updater", () => {
  it("builds an LLM session summary update from provider JSON", async () => {
    const generateTurn = vi.fn(async (_input: LlmTurnInput): Promise<LlmTurnOutput> => ({
      type: "assistant",
      content: JSON.stringify({
        summaryMarkdown: [
          "# Session Summary",
          "",
          "## Current Focus",
          "- Improve session summary quality.",
          "",
          "## Recent Decisions",
          "- Keep deterministic fallback.",
        ].join("\n"),
      }),
    }));
    const updater = new LlmGitMemorySessionSummaryUpdater({
      provider: createProvider(generateTurn),
    });

    const result = await updater.buildUpdate({
      previousSummary: {
        text: "Previous summary.",
        coveredUntilSeq: 2,
      },
      records: [
        {
          seq: 3,
          role: "user",
          at: "2026-06-28T09:00:00+05:30",
          text: "Improve session summary quality",
        },
        {
          seq: 4,
          role: "assistant",
          at: "2026-06-28T09:00:05+05:30",
          text: "I will keep deterministic fallback.",
        },
      ],
    });

    expect(result).toMatchObject({
      text: expect.stringContaining("Improve session summary quality."),
      strategy: "llm",
      coveredUntilSeq: 4,
      messageCount: 2,
      sourceFromSeq: 3,
      sourceToSeq: 4,
      previousCoveredUntilSeq: 2,
    });
    expect(generateTurn).toHaveBeenCalledOnce();
    const prompt = generateTurn.mock.calls[0]?.[0];
    expect(prompt?.responseFormat).toEqual({ type: "json_object" });
    expect(prompt?.messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("Do not invent facts."),
    });
    expect(String(prompt?.messages[1]?.content)).toContain("Previous summary.");
    expect(String(prompt?.messages[1]?.content)).toContain("Improve session summary quality");
  });

  it("falls back to deterministic summary when provider output is invalid", async () => {
    const fallback = new DeterministicGitMemorySessionSummaryUpdater();
    const updater = new LlmGitMemorySessionSummaryUpdater({
      provider: createProvider(vi.fn(async () => ({
        type: "assistant",
        content: JSON.stringify({ summaryMarkdown: "" }),
      }))),
      fallback,
    });

    const result = await updater.buildUpdate({
      records: [{
        seq: 1,
        role: "user",
        at: "2026-06-28T09:00:00+05:30",
        text: "Should we keep fallback?",
      }],
    });

    expect(result).toMatchObject({
      strategy: "deterministic",
      text: expect.stringContaining("## Open Questions"),
      coveredUntilSeq: 1,
      messageCount: 1,
    });
  });

  it("falls back to deterministic summary when provider throws", async () => {
    const updater = new LlmGitMemorySessionSummaryUpdater({
      provider: createProvider(vi.fn(async () => {
        throw new Error("provider failed");
      })),
    });

    const result = await updater.buildUpdate({
      records: [
        {
          seq: 1,
          role: "user",
          at: "2026-06-28T09:00:00+05:30",
          text: "Approved deterministic fallback.",
        },
        {
          seq: 2,
          role: "assistant",
          at: "2026-06-28T09:00:05+05:30",
          text: "Fallback remains available.",
        },
      ],
    });

    expect(result).toMatchObject({
      strategy: "deterministic",
      text: expect.stringContaining("Approved deterministic fallback."),
      coveredUntilSeq: 2,
      messageCount: 2,
    });
  });
});

function createProvider(generateTurn: (input: LlmTurnInput) => Promise<LlmTurnOutput>): LlmProvider {
  return {
    name: "fake-provider",
    version: "test-model",
    capabilities: {
      nativeToolCalling: false,
      structuredOutput: {
        jsonObject: true,
        jsonSchema: false,
      },
    },
    start() {},
    stop() {},
    generateTurn,
  };
}
