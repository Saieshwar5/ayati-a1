import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { agentLoop } from "../../src/ivec/agent-loop.js";
import type { LlmProvider } from "../../src/core/contracts/provider.js";
import type { LlmTurnInput, LlmTurnOutput } from "../../src/core/contracts/llm-protocol.js";
import type { SessionMemory, MemoryRunHandle } from "../../src/memory/types.js";

function goalContract(objective: string): Record<string, unknown> {
  return {
    objective,
    done_when: [`${objective} is complete`],
    required_evidence: [],
    ask_user_when: [],
    stop_when_no_progress: [],
  };
}

function taskVerifyResponse(taskStatusAfter = "not_done", taskReason = "more work remains"): string {
  return JSON.stringify({
    taskStatusAfter,
    taskReason,
    taskEvidence: [],
  });
}

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
      recentRunLedgers: [],
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

  it("returns immediately when understand stage says done (simple message)", async () => {
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
      expect(result.totalIterations).toBe(0);
      expect(provider.generateTurn).toHaveBeenCalledTimes(1);
      expect(sessionMemory.recordRunLedger as ReturnType<typeof vi.fn>).toHaveBeenCalledWith("c1", expect.objectContaining({
        runId: "r1",
        state: "started",
      }));
    } finally {
      cleanup();
    }
  });

  it("handles understand + direct multi-step execution", async () => {
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
          // Call 1: understand stage → complex task
          if (callCount === 1) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                understand: true,
                goal: goalContract("analyze request"),
                approach: "analyze then conclude",
                constraints: [],
              }),
            };
          }
          // Call 2: direct stage → step directive
          if (callCount === 2) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                execution_mode: "dependent",
                intent: "analyze request",
                tools_hint: [],
                success_criteria: "analysis complete",
                context: "",
              }),
            };
          }
          // Call 3: act (no tools, just text)
          if (callCount === 3) {
            return { type: "assistant", content: "Analysis done" };
          }
          // Call 4: task verification
          if (callCount === 4) {
            return { type: "assistant", content: taskVerifyResponse("not_done") };
          }
          // Call 5: direct stage → done
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
          // Call 1: understand → complex task
          if (callCount === 1) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                understand: true,
                goal: goalContract("keep trying"),
                approach: "keep trying",
                constraints: [],
              }),
            };
          }
          if (callCount === 2 || callCount === 5) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                execution_mode: "dependent",
                intent: "try again",
                tools_hint: [],
                success_criteria: "succeed",
                context: "",
              }),
            };
          }
          if (callCount === 3 || callCount === 6) {
            return { type: "assistant", content: "still trying" };
          }
          return { type: "assistant", content: taskVerifyResponse("not_done") };
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
      const state = JSON.parse(readFileSync(join(result.runPath, "state.json"), "utf-8")) as {
        finalOutput?: string;
        goal?: { objective?: string };
        taskStatus?: string;
        sessionHistory?: unknown;
        recentRunLedgers?: unknown;
      };
      expect(state.finalOutput).toBe("done");
      expect(state.goal?.objective).toBe("");
      expect(state.taskStatus).toBe("not_done");
      expect(state).not.toHaveProperty("sessionHistory");
      expect(state).not.toHaveProperty("recentRunLedgers");
    } finally {
      cleanup();
    }
  });

  it("calls onProgress for each step iteration", async () => {
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
          // Call 1: understand
          if (callCount === 1) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                understand: true,
                goal: goalContract("respond"),
                approach: "direct response",
                constraints: [],
              }),
            };
          }
          // Call 2: direct → step
          if (callCount === 2) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                execution_mode: "dependent",
                intent: "step 1",
                tools_hint: [],
                success_criteria: "ok",
                context: "",
              }),
            };
          }
          // Call 3: act
          if (callCount === 3) {
            return { type: "assistant", content: "text response" };
          }
          // Call 4: task verification
          if (callCount === 4) {
            return { type: "assistant", content: taskVerifyResponse("not_done") };
          }
          // Call 5: direct → done
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

  it("handles context_search directive by calling scout and re-calling direct", async () => {
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
          // Call 1: understand
          if (callCount === 1) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                understand: true,
                goal: goalContract("respond"),
                approach: "respond directly",
                constraints: [],
              }),
            };
          }
          // Call 2: direct → step
          if (callCount === 2) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                execution_mode: "dependent",
                intent: "draft response",
                tools_hint: [],
                success_criteria: "response drafted",
                context: "",
              }),
            };
          }
          // Call 3: act
          if (callCount === 3) {
            return { type: "assistant", content: "Drafted response" };
          }
          // Call 4: task verification
          if (callCount === 4) {
            return { type: "assistant", content: taskVerifyResponse("not_done") };
          }
          // Call 5: direct → context_search
          if (callCount === 5) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                context_search: true,
                query: "What happened in step 1?",
                scope: "run_artifacts",
              }),
            };
          }
          // Call 6: scout LLM response (immediate text → no tool calls)
          if (callCount === 6) {
            return {
              type: "assistant",
              content: JSON.stringify({
                summary: "Step 1 drafted a response",
                sources: ["steps/001-act.md"],
                confidence: 0.8,
              }),
            };
          }
          // Call 7: direct → done (after scout results injected)
          return {
            type: "assistant",
            content: JSON.stringify({
              done: true,
              summary: "Completed with context search",
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

  it("understand stage stores goal, approach, and constraints on state", async () => {
    const dataDir = makeTmpDir();
    try {
      let callCount = 0;
      const provider: LlmProvider = {
        name: "mock",
        version: "1.0.0",
        capabilities: { nativeToolCalling: true },
        start: vi.fn(),
        stop: vi.fn(),
        generateTurn: vi.fn().mockImplementation(async (input: LlmTurnInput) => {
          callCount++;
          // Call 1: understand → complex task with rich state
          if (callCount === 1) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                understand: true,
                goal: {
                  objective: "find all config files",
                  done_when: ["config file paths are returned"],
                  required_evidence: ["at least one config file path"],
                  ask_user_when: ["the search root is ambiguous"],
                  stop_when_no_progress: ["two search attempts fail"],
                },
                approach: "use shell to search",
                constraints: ["stay in home dir", "skip hidden files"],
              }),
            };
          }
          // Call 2: direct → verify state was populated (check prompt includes goal/approach)
          if (callCount === 2) {
            const messages = (input as { messages: Array<{ role: string; content: string }> }).messages;
            const prompt = messages.find((message) => message.role === "user")?.content ?? "";
            // The direct prompt should include the understand output
            if (!prompt.includes("find all config files")) {
              throw new Error("Direct prompt missing goal from understand stage");
            }
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                execution_mode: "dependent",
                intent: "search config files",
                tools_hint: [],
                success_criteria: "config file paths are returned",
                context: "",
              }),
            };
          }
          if (callCount === 3) {
            return { type: "assistant", content: "Found config files in the project" };
          }
          if (callCount === 4) {
            return { type: "assistant", content: taskVerifyResponse("done", "goal satisfied") };
          }
          return {
            type: "assistant",
            content: JSON.stringify({
              done: true,
              summary: "Found config files",
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
        systemContext: "system context with personality",
      });

      expect(result.status).toBe("completed");
      expect(result.content).toBe("Found config files");

      // Verify understand and direct both include system context
      const calls = (provider.generateTurn as ReturnType<typeof vi.fn>).mock.calls;
      // Call 1: understand — has system message
      const understandInput = calls[0]![0] as { messages: Array<{ role: string }> };
      expect(understandInput.messages[0]!.role).toBe("system");
      // Call 2: direct — also has system message
      const directInput = calls[1]![0] as { messages: Array<{ role: string }> };
      expect(directInput.messages[0]!.role).toBe("system");
      expect(directInput.messages[1]!.role).toBe("user");

      const persisted = JSON.parse(readFileSync(join(result.runPath, "state.json"), "utf-8")) as {
        goal?: { objective?: string; done_when?: string[] };
        taskStatus?: string;
      };
      expect(persisted.goal?.objective).toBe("find all config files");
      expect(persisted.goal?.done_when).toEqual(["config file paths are returned"]);
      expect(persisted.taskStatus).toBe("done");
    } finally {
      cleanup();
    }
  });

  it("fails when context search requests exceed per-iteration limit", async () => {
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
          // Call 1: understand
          if (callCount === 1) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                understand: true,
                goal: goalContract("respond"),
                approach: "respond directly",
                constraints: [],
              }),
            };
          }
          // Call 2: direct → step
          if (callCount === 2) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                execution_mode: "dependent",
                intent: "draft response",
                tools_hint: [],
                success_criteria: "response drafted",
                context: "",
              }),
            };
          }
          // Call 3: act
          if (callCount === 3) {
            return { type: "assistant", content: "Drafted response" };
          }
          // Call 4: task verification
          if (callCount === 4) {
            return { type: "assistant", content: taskVerifyResponse("not_done") };
          }
          // Call 5+: always context_search (and scout returns immediately)
          // Odd calls (5, 7, ...): context_search from direct
          // Even calls (6, 8, ...): scout immediate text response
          if (callCount % 2 === 1) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                context_search: true,
                query: "Need more details",
                scope: "run_artifacts",
              }),
            };
          }
          return {
            type: "assistant",
            content: JSON.stringify({
              summary: "Some context",
              sources: [],
              confidence: 0.5,
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
        config: {
          maxScoutCallsPerIteration: 1,
        },
      });

      expect(result.status).toBe("failed");
      expect(result.content).toContain("context search requests exceeded");
      expect(result.totalIterations).toBe(2);
    } finally {
      cleanup();
    }
  });
});
