import { describe, expect, it, vi } from "vitest";
import type { LlmProvider } from "../../src/core/contracts/provider.js";
import type { LlmTurnInput, LlmTurnOutput } from "../../src/core/contracts/llm-protocol.js";
import type { PromptMemoryContext } from "../../src/memory/types.js";
import {
  appendPulseProposalQuestion,
  parsePulseProposalReflection,
  PulseProposalReflectionService,
  shouldRunReflection,
  type PulseProposalReflectionInput,
} from "../../src/pulse/proposal-reflection.js";
import type { ToolDefinition } from "../../src/skills/types.js";

function createMockProvider(response: string): LlmProvider {
  return {
    name: "mock",
    version: "1.0.0",
    capabilities: {
      nativeToolCalling: true,
      structuredOutput: {
        jsonObject: true,
        jsonSchema: true,
      },
    },
    start: vi.fn(),
    stop: vi.fn(),
    generateTurn: vi.fn<(input: LlmTurnInput) => Promise<LlmTurnOutput>>().mockResolvedValue({
      type: "assistant",
      content: response,
    }),
  };
}

const pulseTool: ToolDefinition = {
  name: "pulse",
  description: "Schedule Pulse work",
  inputSchema: { type: "object" },
  execute: vi.fn().mockResolvedValue({ ok: true, output: "{}" }),
};

const shellTool: ToolDefinition = {
  name: "shell",
  description: "Run shell commands",
  inputSchema: { type: "object" },
  execute: vi.fn().mockResolvedValue({ ok: true, output: "done" }),
};

const memoryContext: PromptMemoryContext = {
  conversationTurns: [
    {
      role: "user",
      content: "check AI news",
      timestamp: "2026-04-27T10:00:00.000Z",
      sessionPath: "session.md",
    },
  ],
  previousSessionSummary: "",
  personalMemorySnapshot: "User is building Ayati and cares about agent autonomy.",
  recentTaskSummaries: [],
};

function createInput(provider: LlmProvider, overrides?: Partial<PulseProposalReflectionInput>): PulseProposalReflectionInput {
  return {
    provider,
    currentUserMessage: "Check AI news today",
    assistantResponse: "Here are the important AI news updates from today.",
    taskSummary: {
      status: "completed",
      taskStatus: "done",
      objective: "Check AI news and summarize important updates.",
      summary: "Checked current AI news and summarized important updates.",
    },
    memoryContext,
    toolDefinitions: [pulseTool],
    now: new Date("2026-04-27T10:10:00.000Z"),
    ...overrides,
  };
}

describe("PulseProposalReflectionService", () => {
  it("asks only when the model returns a confident useful Pulse proposal", async () => {
    const provider = createMockProvider(JSON.stringify({
      action: "ask_user",
      question: "Want me to check AI news every morning and tell you what changed?",
      confidence: 0.86,
      reason: "The user is repeatedly building around AI updates and this information changes daily.",
    }));
    const service = new PulseProposalReflectionService();

    const result = await service.reflect(createInput(provider));

    expect(result.action).toBe("ask_user");
    if (result.action === "ask_user") {
      expect(result.question).toBe("Want me to check AI news every morning and tell you what changed?");
      expect(result.confidence).toBe(0.86);
    }
    expect(provider.generateTurn).toHaveBeenCalledTimes(1);
    const call = vi.mocked(provider.generateTurn).mock.calls[0]?.[0];
    expect(call?.responseFormat).toEqual({ type: "json_object" });
    expect(typeof call?.messages[1]?.content === "string" ? call.messages[1].content : "").toContain("no pending proposal will be stored");
  });

  it("fails closed when confidence is below the ask threshold", () => {
    const result = parsePulseProposalReflection(JSON.stringify({
      action: "ask_user",
      question: "Want me to do this daily?",
      confidence: 0.6,
      reason: "Maybe useful.",
    }));

    expect(result.action).toBe("none");
    expect(result.confidence).toBe(0.6);
  });

  it("skips reflection when Pulse is unavailable or the current message is already a proposal reply", () => {
    const provider = createMockProvider(JSON.stringify({ action: "none", confidence: 0.1, reason: "skip" }));

    expect(shouldRunReflection(createInput(provider, { toolDefinitions: [shellTool] }))).toBe(false);
    expect(shouldRunReflection(createInput(provider, { currentUserMessage: "yes, weekdays at 8 PM" }))).toBe(false);
  });

  it("appends the proposal as a natural second paragraph", () => {
    expect(appendPulseProposalQuestion("Done.", "Want me to check this every morning")).toBe(
      "Done.\n\nWant me to check this every morning?",
    );
  });
});
