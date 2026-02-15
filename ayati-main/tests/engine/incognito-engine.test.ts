import { describe, it, expect, vi } from "vitest";
import { IVecEngine } from "../../src/ivec/index.js";
import type { LlmProvider } from "../../src/core/contracts/provider.js";
import type { LlmTurnInput, LlmTurnOutput } from "../../src/core/contracts/llm-protocol.js";
import type { SessionMemory } from "../../src/memory/types.js";
import { AGENT_STEP_TOOL_NAME } from "../../src/ivec/agent-step-tool.js";

function createMockProvider(overrides?: Partial<LlmProvider>): LlmProvider {
  return {
    name: "mock",
    version: "1.0.0",
    capabilities: { nativeToolCalling: true },
    start: vi.fn(),
    stop: vi.fn(),
    generateTurn: vi
      .fn<(input: LlmTurnInput) => Promise<LlmTurnOutput>>()
      .mockResolvedValue({ type: "assistant", content: "incognito reply" }),
    ...overrides,
  };
}

function createMockSessionMemory(): SessionMemory {
  return {
    initialize: vi.fn(),
    shutdown: vi.fn(),
    beginRun: vi.fn().mockReturnValue({ sessionId: "normal-s1", runId: "normal-r1" }),
    recordToolCall: vi.fn(),
    recordToolResult: vi.fn(),
    recordAssistantFinal: vi.fn(),
    recordRunFailure: vi.fn(),
    recordAgentStep: vi.fn(),
    recordAssistantFeedback: vi.fn(),
    getPromptMemoryContext: vi.fn().mockReturnValue({
      conversationTurns: [
        { role: "user", content: "prior message", timestamp: "2026-01-01T00:00:00Z" },
      ],
      previousSessionSummary: "old summary",
      toolEvents: [],
    }),
    setStaticTokenBudget: vi.fn(),
    searchSessionSummaries: vi.fn().mockReturnValue([]),
    loadSessionTurns: vi.fn().mockReturnValue([]),
  };
}

describe("IVecEngine — runIncognitoTask", () => {
  it("runs incognito task and sends reply via onReply", async () => {
    const onReply = vi.fn();
    const provider = createMockProvider();
    const engine = new IVecEngine({ onReply, provider });

    await engine.start();
    await engine.runIncognitoTask("c1", "build adapter for playwright-cli");

    expect(onReply).toHaveBeenCalledWith("c1", {
      type: "reply",
      content: "incognito reply",
    });
  });

  it("does not use normal session memory during incognito task", async () => {
    const onReply = vi.fn();
    const provider = createMockProvider();
    const sessionMemory = createMockSessionMemory();
    const engine = new IVecEngine({ onReply, provider, sessionMemory });

    await engine.start();
    await engine.runIncognitoTask("c1", "incognito task");

    // Normal session memory should NOT have beginRun called for the incognito task
    expect(sessionMemory.beginRun).not.toHaveBeenCalledWith("c1", "incognito task");
  });

  it("restores normal session memory after incognito task completes", async () => {
    const onReply = vi.fn();
    const provider = createMockProvider();
    const sessionMemory = createMockSessionMemory();
    const engine = new IVecEngine({ onReply, provider, sessionMemory });

    await engine.start();
    await engine.runIncognitoTask("c1", "incognito task");

    // After incognito, normal chat should use the original session memory
    engine.handleMessage("c1", { type: "chat", content: "normal chat" });

    await vi.waitFor(() => {
      expect(sessionMemory.beginRun).toHaveBeenCalledWith("c1", "normal chat");
    });
  });

  it("restores normal session memory even if processChat throws", async () => {
    const onReply = vi.fn();
    const provider = createMockProvider({
      generateTurn: vi.fn().mockRejectedValue(new Error("API error")),
    });
    const sessionMemory = createMockSessionMemory();
    const engine = new IVecEngine({ onReply, provider, sessionMemory });

    await engine.start();
    await engine.runIncognitoTask("c1", "failing task");

    // Error should be sent
    expect(onReply).toHaveBeenCalledWith("c1", {
      type: "error",
      content: "Failed to generate a response.",
    });

    // Normal session memory should be restored
    engine.handleMessage("c1", { type: "chat", content: "after error" });
    await vi.waitFor(() => {
      expect(sessionMemory.beginRun).toHaveBeenCalledWith("c1", "after error");
    });
  });

  it("echoes in incognito when no provider is given", async () => {
    const onReply = vi.fn();
    const engine = new IVecEngine({ onReply });

    await engine.runIncognitoTask("c1", "hello incognito");

    expect(onReply).toHaveBeenCalledWith("c1", {
      type: "reply",
      content: 'Received: "hello incognito"',
    });
  });

  it("handles incognito_task message type via handleMessage", async () => {
    const onReply = vi.fn();
    const provider = createMockProvider();
    const engine = new IVecEngine({ onReply, provider });

    await engine.start();
    engine.handleMessage("c1", { type: "incognito_task", content: "task via ws" });

    await vi.waitFor(() => {
      expect(onReply).toHaveBeenCalledWith("c1", {
        type: "reply",
        content: "incognito reply",
      });
    });
  });

  it("disables max mode during incognito", async () => {
    let stepCount = 0;
    const onReply = vi.fn();
    const provider = createMockProvider({
      generateTurn: vi.fn().mockImplementation(async () => {
        stepCount++;
        // First two steps: tool calls with two distinct tools (triggers escalation with low thresholds)
        if (stepCount === 1) {
          return {
            type: "tool_calls",
            calls: [{
              id: "s1",
              name: AGENT_STEP_TOOL_NAME,
              input: {
                phase: "act",
                thinking: "Try shell",
                summary: "Run shell",
                action: { tool_name: "shell", tool_input: { cmd: "echo hi" } },
              },
            }],
          };
        }
        if (stepCount === 2) {
          return {
            type: "tool_calls",
            calls: [{
              id: "s2",
              name: AGENT_STEP_TOOL_NAME,
              input: {
                phase: "act",
                thinking: "Try calculator",
                summary: "Run calculator",
                action: { tool_name: "calculator", tool_input: { expr: "1+1" } },
              },
            }],
          };
        }
        // Fallback (shouldn't reach here — escalation should fire first)
        return {
          type: "tool_calls",
          calls: [{
            id: "s-end",
            name: AGENT_STEP_TOOL_NAME,
            input: { phase: "end", thinking: "Done", summary: "Done", end_status: "solved", end_message: "done" },
          }],
        };
      }),
    });

    const toolExecutor: import("../../src/skills/tool-executor.js").ToolExecutor = {
      list: () => ["shell", "calculator"],
      definitions: () => [
        {
          name: "shell",
          description: "Run shell",
          inputSchema: { type: "object", properties: { cmd: { type: "string" } } },
          execute: vi.fn().mockResolvedValue({ ok: false, error: "failed" }),
        },
        {
          name: "calculator",
          description: "Calculate",
          inputSchema: { type: "object", properties: { expr: { type: "string" } } },
          execute: vi.fn().mockResolvedValue({ ok: false, error: "failed" }),
        },
      ],
      execute: vi.fn().mockResolvedValue({ ok: false, error: "failed" }),
      validate: vi.fn().mockReturnValue({ valid: true }),
    };

    const engine = new IVecEngine({
      onReply,
      provider,
      toolExecutor,
      loopConfig: {
        escalation: {
          enabled: true,
          minToolCalls: 1,
          minDistinctTools: 2,
          minFailedToolCalls: 1,
          minReflectCycles: 0,
        },
      },
    });
    await engine.start();
    await engine.runIncognitoTask("c1", "complex task");

    // Should get a reply about max mode being disabled, not a mode_decision
    const calls = onReply.mock.calls as Array<[string, Record<string, unknown>]>;
    const modeDecision = calls.find(([, data]) => data["type"] === "mode_decision");
    expect(modeDecision).toBeUndefined();

    const reply = calls.find(([, data]) => data["type"] === "reply");
    expect(reply).toBeDefined();
    const replyContent = reply?.[1]?.["content"] as string;
    expect(replyContent).toContain("Maximum mode is currently disabled");
  });
});
