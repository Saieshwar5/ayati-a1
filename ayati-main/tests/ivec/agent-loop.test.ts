import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { agentLoop } from "../../src/ivec/agent-loop.js";
import type { LlmProvider } from "../../src/core/contracts/provider.js";
import type { LlmTurnInput, LlmTurnOutput } from "../../src/core/contracts/llm-protocol.js";
import type { SessionMemory, MemoryRunHandle } from "../../src/memory/types.js";

function createMockSessionMemory(): SessionMemory {
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
      conversationTurns: [{ role: "user", content: "hello", timestamp: "", sessionPath: "" }],
      previousSessionSummary: "",
    }),
    setStaticTokenBudget: vi.fn(),
  };
}

describe("agentLoop", () => {
  let tmpDir: string;

  function makeTmpDir(): string {
    tmpDir = mkdtempSync(join(tmpdir(), "ayati-loop-"));
    return tmpDir;
  }

  function cleanup(): void {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  }

  it("returns immediately when controller says done on first call", async () => {
    const dataDir = makeTmpDir();
    try {
      const provider: LlmProvider = {
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
              summary: "Hello! How can I help?",
              status: "completed",
            }),
          }),
      };

      const sessionMemory = createMockSessionMemory();
      const result = await agentLoop({
        provider,
        toolDefinitions: [],
        sessionMemory,
        runHandle: { sessionId: "s1", runId: "r1" },
        clientId: "c1",
        dataDir,
      });

      expect(result.type).toBe("reply");
      expect(result.content).toBe("Hello! How can I help?");
      expect(result.status).toBe("completed");
      expect(result.totalIterations).toBe(1);
      expect(sessionMemory.recordRunLedger as ReturnType<typeof vi.fn>).toHaveBeenCalledWith("c1", expect.objectContaining({
        runId: "r1",
        state: "started",
      }));
    } finally {
      cleanup();
    }
  });

  it("handles multi-step execution", async () => {
    const dataDir = makeTmpDir();
    try {
      let callCount = 0;
      const provider: LlmProvider = {
        name: "mock",
        version: "1.0.0",
        capabilities: { nativeToolCalling: true },
        start: vi.fn(),
        stop: vi.fn(),
        generateTurn: vi.fn().mockImplementation(async () => {
          callCount++;
          // Call 1: controller → step directive
          if (callCount === 1) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                approach: "analyze then conclude",
                intent: "analyze request",
                type: "reasoning",
                tools_hint: [],
                success_criteria: "analysis complete",
                context: "",
              }),
            };
          }
          // Call 2: act (no tools, just text) — gate 2 catches no-tools+text as pass
          if (callCount === 2) {
            return { type: "assistant", content: "Analysis done" };
          }
          // Call 3: controller → done
          return {
            type: "assistant",
            content: JSON.stringify({
              done: true,
              summary: "Completed analysis",
              status: "completed",
            }),
          };
        }),
      };

      const result = await agentLoop({
        provider,
        toolDefinitions: [],
        sessionMemory: createMockSessionMemory(),
        runHandle: { sessionId: "s1", runId: "r1" },
        clientId: "c1",
        dataDir,
      });

      expect(result.status).toBe("completed");
      expect(result.totalIterations).toBe(2);
    } finally {
      cleanup();
    }
  });

  it("returns stuck when max iterations exhausted", async () => {
    const dataDir = makeTmpDir();
    try {
      let callCount = 0;
      const provider: LlmProvider = {
        name: "mock",
        version: "1.0.0",
        capabilities: { nativeToolCalling: true },
        start: vi.fn(),
        stop: vi.fn(),
        generateTurn: vi.fn().mockImplementation(async () => {
          callCount++;
          // Alternate controller (step) / act — never done
          if (callCount % 2 === 1) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                approach: "keep trying",
                intent: "try again",
                type: "reasoning",
                tools_hint: [],
                success_criteria: "succeed",
                context: "",
              }),
            };
          }
          return { type: "assistant", content: "still trying" };
        }),
      };

      const result = await agentLoop({
        provider,
        toolDefinitions: [],
        sessionMemory: createMockSessionMemory(),
        runHandle: { sessionId: "s1", runId: "r1" },
        clientId: "c1",
        dataDir,
        config: { maxIterations: 2 },
      });

      expect(result.status).toBe("stuck");
    } finally {
      cleanup();
    }
  });

  it("writes state file after each iteration", async () => {
    const dataDir = makeTmpDir();
    try {
      const provider: LlmProvider = {
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
              summary: "done",
              status: "completed",
            }),
          }),
      };

      const result = await agentLoop({
        provider,
        toolDefinitions: [],
        sessionMemory: createMockSessionMemory(),
        runHandle: { sessionId: "s1", runId: "r1" },
        clientId: "c1",
        dataDir,
      });

      expect(existsSync(join(result.runPath, "state.json"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("calls onProgress for each iteration", async () => {
    const dataDir = makeTmpDir();
    try {
      let callCount = 0;
      const provider: LlmProvider = {
        name: "mock",
        version: "1.0.0",
        capabilities: { nativeToolCalling: true },
        start: vi.fn(),
        stop: vi.fn(),
        generateTurn: vi.fn().mockImplementation(async () => {
          callCount++;
          if (callCount === 1) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                approach: "direct response",
                intent: "step 1",
                type: "reasoning",
                tools_hint: [],
                success_criteria: "ok",
                context: "",
              }),
            };
          }
          if (callCount === 2) {
            return { type: "assistant", content: "text response" };
          }
          return {
            type: "assistant",
            content: JSON.stringify({ done: true, summary: "done", status: "completed" }),
          };
        }),
      };

      const onProgress = vi.fn();
      await agentLoop({
        provider,
        toolDefinitions: [],
        sessionMemory: createMockSessionMemory(),
        runHandle: { sessionId: "s1", runId: "r1" },
        clientId: "c1",
        dataDir,
        onProgress,
      });

      expect(onProgress).toHaveBeenCalledTimes(1);
      expect(onProgress).toHaveBeenCalledWith(
        expect.stringContaining("Step 1"),
        expect.any(String),
      );
    } finally {
      cleanup();
    }
  });

  it("handles inspect re-query without consuming extra iteration", async () => {
    const dataDir = makeTmpDir();
    try {
      let callCount = 0;
      const provider: LlmProvider = {
        name: "mock",
        version: "1.0.0",
        capabilities: { nativeToolCalling: true },
        start: vi.fn(),
        stop: vi.fn(),
        generateTurn: vi.fn().mockImplementation(async () => {
          callCount++;
          if (callCount === 1) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                goal_update: "Understand user greeting and respond naturally",
                approach_update: "Respond directly and verify tone",
                approach: "respond directly",
                intent: "draft response",
                type: "reasoning",
                tools_hint: [],
                success_criteria: "response drafted",
                context: "",
              }),
            };
          }
          if (callCount === 2) {
            return { type: "assistant", content: "Drafted response" };
          }
          if (callCount === 3) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                inspect_steps: [1],
                inspect_reason: "Need to confirm step details",
              }),
            };
          }
          return {
            type: "assistant",
            content: JSON.stringify({
              done: true,
              summary: "Completed with inspection",
              status: "completed",
            }),
          };
        }),
      };

      const result = await agentLoop({
        provider,
        toolDefinitions: [],
        sessionMemory: createMockSessionMemory(),
        runHandle: { sessionId: "s1", runId: "r1" },
        clientId: "c1",
        dataDir,
      });

      expect(result.status).toBe("completed");
      expect(result.totalIterations).toBe(2);
    } finally {
      cleanup();
    }
  });
});
