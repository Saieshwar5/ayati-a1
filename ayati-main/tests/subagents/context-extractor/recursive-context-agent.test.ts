import { describe, it, expect, vi } from "vitest";
import type { LlmProvider } from "../../../src/core/contracts/provider.js";
import type { LlmTurnInput, LlmTurnOutput } from "../../../src/core/contracts/llm-protocol.js";
import { RecursiveContextAgent } from "../../../src/subagents/context-extractor/recursive-context-agent.js";
import type { ProcessedDocument } from "../../../src/documents/types.js";

function createMockProvider(): LlmProvider {
  return {
    name: "mock",
    version: "1.0.0",
    capabilities: { nativeToolCalling: true },
    start: vi.fn(),
    stop: vi.fn(),
    generateTurn: vi.fn(async (input: LlmTurnInput): Promise<LlmTurnOutput> => {
      const prompt = input.messages[0]?.role === "user" ? input.messages[0].content : "";
      if (prompt.includes("[SOURCE id=")) {
        const sourceIdMatch = prompt.match(/\[SOURCE id=([^\]]+)\]/);
        const sourceId = sourceIdMatch?.[1] ?? "unknown";
        return {
          type: "assistant",
          content: JSON.stringify({
            items: [
              {
                sourceId,
                fact: "The project mentions release planning.",
                quote: "release planning",
                relevance: 0.9,
                confidence: 0.85,
              },
            ],
            dropped_noise_count: 1,
            insufficient_evidence: false,
          }),
        };
      }

      return {
        type: "assistant",
        content: JSON.stringify({
          items: [],
          dropped_noise_count: 0,
          insufficient_evidence: true,
        }),
      };
    }),
  };
}

function createDocument(text: string): ProcessedDocument {
  return {
    id: "doc-1",
    name: "notes.txt",
    path: "/tmp/notes.txt",
    kind: "txt",
    sizeBytes: text.length,
    warnings: [],
    segments: [
      {
        id: "segment-1",
        location: "body",
        text,
      },
    ],
  };
}

describe("RecursiveContextAgent", () => {
  it("extracts grounded evidence from document chunks", async () => {
    const provider = createMockProvider();
    const agent = new RecursiveContextAgent({ provider, modelContextTokens: 8_000 });
    const result = await agent.extractContext({
      query: "What is mentioned about planning?",
      documents: [createDocument("This week includes release planning and sprint review.")],
    });

    expect(result.contextBundle.items).toHaveLength(1);
    expect(result.contextBundle.items[0]?.fact).toContain("release planning");
    expect(result.contextBundle.trace.llmCalls).toBeGreaterThan(0);
    expect(result.contextBundle.insufficientEvidence).toBe(false);
  });
});
