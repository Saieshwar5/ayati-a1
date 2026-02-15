import { describe, it, expect, vi } from "vitest";
import { IVecEngine } from "../../src/ivec/index.js";
import type { LlmProvider } from "../../src/core/contracts/provider.js";
import type { LlmTurnInput, LlmTurnOutput } from "../../src/core/contracts/llm-protocol.js";
import type { SessionMemory } from "../../src/memory/types.js";

function createSessionMemory(): SessionMemory {
  return {
    initialize: vi.fn(),
    shutdown: vi.fn(),
    beginRun: vi.fn().mockReturnValue({ sessionId: "main-s1", runId: "main-r1" }),
    recordToolCall: vi.fn(),
    recordToolResult: vi.fn(),
    recordAssistantFinal: vi.fn(),
    recordRunFailure: vi.fn(),
    recordAgentStep: vi.fn(),
    recordAssistantFeedback: vi.fn(),
    getPromptMemoryContext: vi.fn().mockReturnValue({
      conversationTurns: [],
      previousSessionSummary: "",
      toolEvents: [],
    }),
    setStaticTokenBudget: vi.fn(),
    searchSessionSummaries: vi.fn().mockReturnValue([]),
    loadSessionTurns: vi.fn().mockReturnValue([]),
  };
}

function createProvider(): LlmProvider {
  let normalLoopSteps = 0;
  return {
    name: "mock",
    version: "1.0.0",
    capabilities: { nativeToolCalling: true },
    start: vi.fn(),
    stop: vi.fn(),
    generateTurn: vi.fn<(input: LlmTurnInput) => Promise<LlmTurnOutput>>().mockImplementation(async (input) => {
      const first = input.messages[0] as { role?: string; content?: string } | undefined;
      const system = first?.role === "system" ? first.content ?? "" : "";

      if (system.includes("execution plans for a maximum-mode autonomous sub-session")) {
        return {
          type: "assistant",
          content: JSON.stringify({
            goal: "Execute complex request",
            done_criteria: "All tasks complete",
            constraints: [],
            tasks: [
              {
                title: "Primary task",
                objective: "Complete the requested complex work",
                expected_output: "A clear final result",
              },
            ],
          }),
        };
      }

      if (system.includes("validate a task result against expected output")) {
        return {
          type: "assistant",
          content: JSON.stringify({
            pass: true,
            score: 0.9,
            gap: "",
            rationale: "Matches expected output",
          }),
        };
      }

      if (system.includes("Maximum mode sub-session is active.")) {
        return {
          type: "tool_calls",
          calls: [
            {
              id: "s-end-subtask",
              name: "agent_step",
              input: {
                phase: "end",
                thinking: "Completed",
                summary: "done",
                end_status: "solved",
                end_message: "Complex task completed.",
              },
            },
          ],
        };
      }

      normalLoopSteps++;
      if (normalLoopSteps === 1) {
        return {
          type: "tool_calls",
          calls: [
            {
              id: "s-act-1",
              name: "agent_step",
              input: {
                phase: "act",
                thinking: "Try first tool",
                summary: "Attempt shell",
                action: { tool_name: "shell", tool_input: { cmd: "echo hi" } },
              },
            },
          ],
        };
      }
      if (normalLoopSteps === 2) {
        return {
          type: "tool_calls",
          calls: [
            {
              id: "s-act-2",
              name: "agent_step",
              input: {
                phase: "act",
                thinking: "Try second tool type",
                summary: "Attempt calculator",
                action: { tool_name: "calculator", tool_input: { expression: "1+1" } },
              },
            },
          ],
        };
      }

      return {
        type: "tool_calls",
        calls: [
          {
            id: "s-end",
            name: "agent_step",
            input: {
              phase: "end",
              thinking: "Completed",
              summary: "done",
              end_status: "solved",
              end_message: "Complex task completed.",
            },
          },
        ],
      };
    }),
  };
}

describe("IVecEngine maximum mode integration", () => {
  it("routes complex requests through max-mode subsession orchestration", async () => {
    const onReply = vi.fn();
    const provider = createProvider();
    const sessionMemory = createSessionMemory();
    const engine = new IVecEngine({
      onReply,
      provider,
      sessionMemory,
      loopConfig: {
        escalation: {
          minToolCalls: 1,
          minDistinctTools: 2,
          minFailedToolCalls: 1,
          minReflectCycles: 0,
        },
      },
    });

    await engine.start();
    engine.handleMessage("c1", {
      type: "chat",
      content: "This is a complex multi-step architecture implementation. Use maximum mode.",
    });

    await vi.waitFor(() => {
      expect(onReply).toHaveBeenCalledWith(
        "c1",
        expect.objectContaining({
          type: "mode_decision",
          mode: "maximum",
        }),
      );
      expect(onReply).toHaveBeenCalledWith(
        "c1",
        expect.objectContaining({
          type: "subsession_plan",
        }),
      );
      expect(onReply).toHaveBeenCalledWith(
        "c1",
        expect.objectContaining({
          type: "reply",
        }),
      );
    });

    expect(sessionMemory.recordAssistantFinal).toHaveBeenCalledTimes(1);
  });
});
