import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { IVecEngine } from "../../src/ivec/index.js";
import type { LlmProvider } from "../../src/core/contracts/provider.js";
import type { LlmTurnInput, LlmTurnOutput } from "../../src/core/contracts/llm-protocol.js";
import type { SessionMemory } from "../../src/memory/types.js";

function createMockProvider(overrides?: Partial<LlmProvider>): LlmProvider {
  return {
    name: "mock",
    version: "1.0.0",
    capabilities: { nativeToolCalling: true },
    start: vi.fn(),
    stop: vi.fn(),
    generateTurn: vi
      .fn<(input: LlmTurnInput) => Promise<LlmTurnOutput>>()
      .mockResolvedValue({
        type: "assistant",
        content: JSON.stringify({
          done: true,
          summary: "mock reply",
          status: "completed",
        }),
      }),
    ...overrides,
  };
}

function createSessionMemory(): SessionMemory {
  return {
    initialize: vi.fn(),
    shutdown: vi.fn(),
    beginRun: vi.fn().mockReturnValue({ sessionId: "s1", runId: "r1" }),
    recordToolCall: vi.fn(),
    recordToolResult: vi.fn(),
    recordAssistantFinal: vi.fn(),
    recordRunFailure: vi.fn(),
    recordAgentStep: vi.fn(),
    recordRunLedger: vi.fn(),
    recordTaskSummary: vi.fn(),
    recordAssistantFeedback: vi.fn(),
    getPromptMemoryContext: vi.fn().mockReturnValue({
      conversationTurns: [],
      previousSessionSummary: "",
    }),
    setStaticTokenBudget: vi.fn(),
  };
}

describe("IVecEngine", () => {
  it("is constructible without options", () => {
    const engine = new IVecEngine();
    expect(engine).toBeInstanceOf(IVecEngine);
  });

  it("starts and stops without provider", async () => {
    const engine = new IVecEngine();
    await engine.start();
    await engine.stop();
  });

  it("echoes chat without provider", async () => {
    const onReply = vi.fn();
    const engine = new IVecEngine({ onReply });

    engine.handleMessage("c1", { type: "chat", content: "hello" });

    await vi.waitFor(() => {
      expect(onReply).toHaveBeenCalledWith("c1", {
        type: "reply",
        content: 'Received: "hello"',
      });
    });
  });

  it("calls provider.generateTurn and returns reply", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ayati-eng-"));
    try {
      const provider = createMockProvider();
      const onReply = vi.fn();
      const sessionMemory = createSessionMemory();
      const engine = new IVecEngine({ onReply, provider, sessionMemory, dataDir });

      await engine.start();
      engine.handleMessage("c1", { type: "chat", content: "hello" });

      await vi.waitFor(() => {
        expect(provider.generateTurn).toHaveBeenCalled();
        expect(onReply).toHaveBeenCalledWith("c1", {
          type: "reply",
          content: "mock reply",
        });
      });
      expect(sessionMemory.recordRunLedger as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        "c1",
        expect.objectContaining({ state: "completed", status: "completed" }),
      );
      expect(sessionMemory.recordTaskSummary as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        "c1",
        expect.objectContaining({ status: "completed", summary: "mock reply" }),
      );
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("ignores non-chat messages", () => {
    const onReply = vi.fn();
    const engine = new IVecEngine({ onReply });

    engine.handleMessage("c1", { type: "ping" });
    engine.handleMessage("c1", { foo: "bar" });
    engine.handleMessage("c1", "raw string");

    expect(onReply).not.toHaveBeenCalled();
  });

  it("sends error reply when provider throws", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ayati-eng-err-"));
    try {
      const provider = createMockProvider({
        generateTurn: vi.fn().mockRejectedValue(new Error("API down")),
      });
      const onReply = vi.fn();
      const engine = new IVecEngine({ onReply, provider, dataDir });

      await engine.start();
      engine.handleMessage("c1", { type: "chat", content: "hello" });

      await vi.waitFor(() => {
        expect(onReply).toHaveBeenCalledWith("c1", {
          type: "error",
          content: "Failed to generate a response.",
        });
      });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("passes static token budget to session memory on start", async () => {
    const provider = createMockProvider();
    const sessionMemory = createSessionMemory();

    const engine = new IVecEngine({ provider, sessionMemory });
    await engine.start();

    expect(sessionMemory.setStaticTokenBudget).toHaveBeenCalledWith(expect.any(Number));
    const budget = (sessionMemory.setStaticTokenBudget as ReturnType<typeof vi.fn>).mock.calls[0]![0] as number;
    expect(budget).toBe(0);

    await engine.stop();
  });
});
