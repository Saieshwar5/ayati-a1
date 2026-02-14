import { describe, it, expect, vi } from "vitest";
import { IVecEngine } from "../../src/ivec/index.js";
import type { LlmProvider } from "../../src/core/contracts/provider.js";
import type { LlmTurnInput, LlmTurnOutput } from "../../src/core/contracts/llm-protocol.js";
import type { SessionMemory } from "../../src/memory/types.js";
import type { StaticContext } from "../../src/context/static-context-cache.js";
import { emptySoulContext, emptyUserProfileContext } from "../../src/context/types.js";
import type { ToolExecutor } from "../../src/skills/tool-executor.js";
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
      .mockResolvedValue({ type: "assistant", content: "mock reply" }),
    ...overrides,
  };
}

describe("IVecEngine", () => {
  const staticContext: StaticContext = {
    basePrompt: "Base prompt",
    soul: emptySoulContext(),
    userProfile: emptyUserProfileContext(),
    skillBlocks: [],
    toolDirectory: "",
  };

  it("should be constructible without options", () => {
    const engine = new IVecEngine();
    expect(engine).toBeInstanceOf(IVecEngine);
  });

  it("should start and stop without error when no provider is given", async () => {
    const engine = new IVecEngine();
    await engine.start();
    await engine.stop();
  });

  it("should echo when no provider is given", async () => {
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

  it("should call provider.generateTurn when provider is given", async () => {
    const provider = createMockProvider();
    const onReply = vi.fn();
    const engine = new IVecEngine({ onReply, provider });

    await engine.start();
    engine.handleMessage("c1", { type: "chat", content: "hello" });

    await vi.waitFor(() => {
      expect(provider.generateTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [{ role: "user", content: "hello" }],
          tools: expect.arrayContaining([
            expect.objectContaining({ name: AGENT_STEP_TOOL_NAME }),
          ]),
        }),
      );
      expect(onReply).toHaveBeenCalledWith("c1", {
        type: "reply",
        content: "mock reply",
      });
    });
  });

  it("sends agent_step and native tool schemas in tools array", async () => {
    const provider = createMockProvider();
    const onReply = vi.fn();
    const toolExecutor: ToolExecutor = {
      list: () => ["shell"],
      definitions: () => [
        {
          name: "shell",
          description: "Run shell",
          inputSchema: { type: "object", properties: { cmd: { type: "string" } } },
          execute: vi.fn().mockResolvedValue({ ok: true, output: "hello" }),
        },
      ],
      execute: vi.fn().mockResolvedValue({ ok: true, output: "hello" }),
      validate: vi.fn().mockReturnValue({ valid: true }),
    };

    const engine = new IVecEngine({ onReply, provider, toolExecutor });
    await engine.start();
    engine.handleMessage("c1", { type: "chat", content: "hello" });

    await vi.waitFor(() => {
      expect(provider.generateTurn).toHaveBeenCalled();
      const call = (provider.generateTurn as ReturnType<typeof vi.fn>).mock.calls[0]![0] as LlmTurnInput;
      expect(call.tools?.[0]!.name).toBe(AGENT_STEP_TOOL_NAME);
      const names = (call.tools ?? []).map((tool) => tool.name);
      expect(names).toContain("shell");
      expect(names).toContain("context_recall_agent");
    });
  });

  it("emits local context token estimate before sending the model request", async () => {
    const provider = createMockProvider();
    const onReply = vi.fn();
    const engine = new IVecEngine({ onReply, provider });

    await engine.start();
    engine.handleMessage("c1", { type: "chat", content: "hello" });

    await vi.waitFor(() => {
      expect(provider.generateTurn).toHaveBeenCalledTimes(1);
      expect(onReply).toHaveBeenCalledWith(
        "c1",
        expect.objectContaining({
          type: "context_size",
          mode: "local_estimate",
          step: 1,
          provider: "mock",
          model: "unknown",
        }),
      );
    });
  });

  it("should ignore non-chat messages", () => {
    const onReply = vi.fn();
    const engine = new IVecEngine({ onReply });

    engine.handleMessage("c1", { type: "ping" });
    engine.handleMessage("c1", { foo: "bar" });
    engine.handleMessage("c1", "raw string");

    expect(onReply).not.toHaveBeenCalled();
  });

  it("should execute a tool message when tool executor is configured", async () => {
    const onReply = vi.fn();
    const toolExecutor: ToolExecutor = {
      list: () => ["shell"],
      definitions: () => [],
      execute: vi.fn().mockResolvedValue({ ok: true, output: "done" }),
      validate: vi.fn().mockReturnValue({ valid: true }),
    };
    const engine = new IVecEngine({ onReply, toolExecutor });

    engine.handleMessage("c1", { type: "tool", name: "shell", input: { cmd: "echo ok" } });

    await vi.waitFor(() => {
      expect(onReply).toHaveBeenCalledWith("c1", {
        type: "tool_result",
        name: "shell",
        result: { ok: true, output: "done" },
      });
    });
  });

  it("should execute tools via agent_step act phase", async () => {
    let callCount = 0;
    const onReply = vi.fn();
    const provider = createMockProvider({
      generateTurn: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            type: "tool_calls",
            calls: [{
              id: "s1",
              name: AGENT_STEP_TOOL_NAME,
              input: {
                phase: "act",
                thinking: "Running shell",
                summary: "Execute",
                action: { tool_name: "shell", tool_input: { cmd: "echo hello" } },
              },
            }],
          };
        }
        return {
          type: "tool_calls",
          calls: [{
            id: "s2",
            name: AGENT_STEP_TOOL_NAME,
            input: { phase: "end", thinking: "Done", summary: "Complete", end_status: "solved", end_message: "Final verified answer" },
          }],
        };
      }),
    });
    const toolExecutor: ToolExecutor = {
      list: () => ["shell"],
      definitions: () => [
        {
          name: "shell",
          description: "Run shell",
          inputSchema: { type: "object", properties: { cmd: { type: "string" } } },
          execute: vi.fn().mockResolvedValue({ ok: true, output: "hello" }),
        },
      ],
      execute: vi.fn().mockResolvedValue({ ok: true, output: "hello" }),
      validate: vi.fn().mockReturnValue({ valid: true }),
    };

    const engine = new IVecEngine({ onReply, provider, toolExecutor });
    await engine.start();
    engine.handleMessage("c1", { type: "chat", content: "say hello" });

    await vi.waitFor(() => {
      expect(toolExecutor.execute).toHaveBeenCalledWith(
        "shell",
        { cmd: "echo hello" },
        { clientId: "c1" },
      );
      expect(onReply).toHaveBeenCalledWith("c1", {
        type: "reply",
        content: "Final verified answer",
      });
    });
  });

  it("records run and tool events to session memory", async () => {
    let callCount = 0;
    const onReply = vi.fn();
    const provider = createMockProvider({
      generateTurn: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            type: "tool_calls",
            calls: [{
              id: "s1",
              name: AGENT_STEP_TOOL_NAME,
              input: {
                phase: "act",
                thinking: "t",
                summary: "Execute",
                action: { tool_name: "shell", tool_input: { cmd: "echo hello" } },
              },
            }],
          };
        }
        return {
          type: "tool_calls",
          calls: [{
            id: "s2",
            name: AGENT_STEP_TOOL_NAME,
            input: { phase: "end", thinking: "Done", summary: "Done", end_status: "solved", end_message: "done" },
          }],
        };
      }),
    });
    const toolExecutor: ToolExecutor = {
      list: () => ["shell"],
      definitions: () => [
        {
          name: "shell",
          description: "Run shell",
          inputSchema: { type: "object", properties: { cmd: { type: "string" } } },
          execute: vi.fn().mockResolvedValue({ ok: true, output: "hello" }),
        },
      ],
      execute: vi.fn().mockResolvedValue({ ok: true, output: "hello" }),
      validate: vi.fn().mockReturnValue({ valid: true }),
    };
    const sessionMemory: SessionMemory = {
      initialize: vi.fn(),
      shutdown: vi.fn(),
      beginRun: vi.fn().mockReturnValue({ sessionId: "s1", runId: "r1" }),
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

    const engine = new IVecEngine({
      onReply,
      provider,
      toolExecutor,
      sessionMemory,
    });

    await engine.start();
    engine.handleMessage("c1", { type: "chat", content: "do tool" });

    await vi.waitFor(() => {
      expect(sessionMemory.beginRun).toHaveBeenCalledWith("c1", "do tool");
      expect(sessionMemory.recordToolCall).toHaveBeenCalledTimes(1);
      expect(sessionMemory.recordToolResult).toHaveBeenCalledTimes(1);
      expect(sessionMemory.recordAssistantFinal).toHaveBeenCalledWith(
        "c1",
        "r1",
        "s1",
        "done",
      );
    });
  });

  it("passes static token budget to session memory on start", async () => {
    const provider = createMockProvider();
    const sessionMemory: SessionMemory = {
      initialize: vi.fn(),
      shutdown: vi.fn(),
      beginRun: vi.fn().mockReturnValue({ sessionId: "s1", runId: "r1" }),
      recordToolCall: vi.fn(),
      recordToolResult: vi.fn(),
      recordAssistantFinal: vi.fn(),
      recordRunFailure: vi.fn(),
      getPromptMemoryContext: vi.fn().mockReturnValue({
        conversationTurns: [],
        previousSessionSummary: "",
        toolEvents: [],
      }),
      setStaticTokenBudget: vi.fn(),
      searchSessionSummaries: vi.fn().mockReturnValue([]),
      loadSessionTurns: vi.fn().mockReturnValue([]),
    };

    const engine = new IVecEngine({ provider, sessionMemory });
    await engine.start();

    expect(sessionMemory.setStaticTokenBudget).toHaveBeenCalledWith(expect.any(Number));
    const budget = (sessionMemory.setStaticTokenBudget as ReturnType<typeof vi.fn>).mock.calls[0]![0] as number;
    expect(budget).toBe(0);

    await engine.stop();
  });

  it("should return tool_result error when tool executor is missing", async () => {
    const onReply = vi.fn();
    const engine = new IVecEngine({ onReply });

    engine.handleMessage("c1", { type: "tool", name: "shell", input: { cmd: "echo ok" } });

    await vi.waitFor(() => {
      expect(onReply).toHaveBeenCalledWith("c1", {
        type: "tool_result",
        name: "shell",
        result: {
          ok: false,
          error: "Tool execution is not configured.",
        },
      });
    });
  });

  it("should send error reply when provider throws", async () => {
    const provider = createMockProvider({
      generateTurn: vi.fn().mockRejectedValue(new Error("API down")),
    });
    const onReply = vi.fn();
    const engine = new IVecEngine({ onReply, provider });

    await engine.start();
    engine.handleMessage("c1", { type: "chat", content: "hello" });

    await vi.waitFor(() => {
      expect(onReply).toHaveBeenCalledWith("c1", {
        type: "error",
        content: "Failed to generate a response.",
      });
    });
  });

  it("invokes context_recall_agent via agent_step act phase", async () => {
    let callCount = 0;
    const provider = createMockProvider({
      generateTurn: vi
        .fn<(input: LlmTurnInput) => Promise<LlmTurnOutput>>()
        .mockImplementation(async (input) => {
          const first = input.messages[0] as { role?: string; content?: string } | undefined;
          const systemText = first?.role === "system" ? first.content ?? "" : "";
          if (systemText.includes("MODE=EXTRACT_EVIDENCE")) {
            return {
              type: "assistant",
              content: JSON.stringify({
                evidence: [
                  {
                    turn_ref: "turn-1",
                    snippet: "We deployed the API to staging with a blue-green switch.",
                    why_relevant: "Contains prior deployment decision",
                    confidence: 0.92,
                  },
                ],
              }),
            };
          }

          callCount++;
          if (callCount === 1) {
            return {
              type: "tool_calls",
              calls: [{
                id: "s1",
                name: AGENT_STEP_TOOL_NAME,
                input: {
                  phase: "act",
                  thinking: "Need to recall",
                  summary: "Recall context",
                  action: {
                    tool_name: "context_recall_agent",
                    tool_input: {
                      query: "what did we discuss about deployment?",
                      searchQuery: "deployment staging",
                    },
                  },
                },
              }],
            };
          }
          return {
            type: "tool_calls",
            calls: [{
              id: "s2",
              name: AGENT_STEP_TOOL_NAME,
              input: { phase: "end", thinking: "Done", summary: "Done", end_status: "solved", end_message: "mock reply" },
            }],
          };
        }),
    });
    const onReply = vi.fn();
    const sessionMemory: SessionMemory = {
      initialize: vi.fn(),
      shutdown: vi.fn(),
      beginRun: vi.fn().mockReturnValue({ sessionId: "active-session", runId: "r1" }),
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
      searchSessionSummaries: vi.fn().mockReturnValue([
        {
          sessionId: "s-old",
          summaryText: "Deployment and staging rollout discussion",
          keywords: ["deployment", "staging"],
          closedAt: "2026-02-01T09:00:00.000Z",
          closeReason: "token_limit",
          score: 3,
        },
      ]),
      loadSessionTurns: vi.fn().mockReturnValue([
        {
          role: "assistant",
          content: "We deployed the API to staging with a blue-green switch.",
          timestamp: "2026-02-01T09:10:00.000Z",
        },
      ]),
    };

    const engine = new IVecEngine({
      onReply,
      provider,
      sessionMemory,
      staticContext,
    });

    await engine.start();
    engine.handleMessage("c1", {
      type: "chat",
      content: "what did we discuss last time about deployment?",
    });

    await vi.waitFor(() => {
      expect(onReply).toHaveBeenCalledWith("c1", {
        type: "reply",
        content: "mock reply",
      });
    });

    expect(sessionMemory.searchSessionSummaries).toHaveBeenCalledWith(
      "deployment staging",
      expect.any(Number),
    );
    expect(sessionMemory.loadSessionTurns).toHaveBeenCalledWith("s-old");
  });

  it("does not run context recall when the model does not call context_recall_agent", async () => {
    const provider = createMockProvider();
    const onReply = vi.fn();
    const sessionMemory: SessionMemory = {
      initialize: vi.fn(),
      shutdown: vi.fn(),
      beginRun: vi.fn().mockReturnValue({ sessionId: "active-session", runId: "r1" }),
      recordToolCall: vi.fn(),
      recordToolResult: vi.fn(),
      recordAssistantFinal: vi.fn(),
      recordRunFailure: vi.fn(),
      getPromptMemoryContext: vi.fn().mockReturnValue({
        conversationTurns: [],
        previousSessionSummary: "",
        toolEvents: [],
      }),
      setStaticTokenBudget: vi.fn(),
      searchSessionSummaries: vi.fn().mockReturnValue([]),
      loadSessionTurns: vi.fn().mockReturnValue([]),
    };

    const engine = new IVecEngine({
      onReply,
      provider,
      sessionMemory,
      staticContext,
    });

    await engine.start();
    engine.handleMessage("c1", { type: "chat", content: "hello" });

    await vi.waitFor(() => {
      expect(provider.generateTurn).toHaveBeenCalledTimes(1);
    });

    expect(sessionMemory.searchSessionSummaries).not.toHaveBeenCalled();
    expect(sessionMemory.loadSessionTurns).not.toHaveBeenCalled();
  });

  it("returns not_found payload through context_recall_agent tool output", async () => {
    let callCount = 0;
    const provider = createMockProvider({
      generateTurn: vi
        .fn<(input: LlmTurnInput) => Promise<LlmTurnOutput>>()
        .mockImplementation(async () => {
          callCount++;
          if (callCount === 1) {
            return {
              type: "tool_calls",
              calls: [{
                id: "s1",
                name: AGENT_STEP_TOOL_NAME,
                input: {
                  phase: "act",
                  thinking: "Need recall",
                  summary: "Recall",
                  action: {
                    tool_name: "context_recall_agent",
                    tool_input: {
                      query: "what did we decide in our last session?",
                      searchQuery: "old release decision",
                    },
                  },
                },
              }],
            };
          }
          return {
            type: "tool_calls",
            calls: [{
              id: "s2",
              name: AGENT_STEP_TOOL_NAME,
              input: { phase: "end", thinking: "Done", summary: "Done", end_status: "solved", end_message: "done" },
            }],
          };
        }),
    });
    const onReply = vi.fn();
    const sessionMemory: SessionMemory = {
      initialize: vi.fn(),
      shutdown: vi.fn(),
      beginRun: vi.fn().mockReturnValue({ sessionId: "active-session", runId: "r1" }),
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

    const engine = new IVecEngine({
      onReply,
      provider,
      sessionMemory,
      staticContext,
    });

    await engine.start();
    engine.handleMessage("c1", {
      type: "chat",
      content: "what did we decide in our last session?",
    });

    await vi.waitFor(() => {
      expect(onReply).toHaveBeenCalledWith("c1", {
        type: "reply",
        content: "done",
      });
    });

    expect(sessionMemory.searchSessionSummaries).toHaveBeenCalledWith(
      "old release decision",
      expect.any(Number),
    );
    const toolResultCall = (sessionMemory.recordToolResult as ReturnType<typeof vi.fn>).mock.calls
      .find((entry) => (entry?.[1] as { toolName?: string })?.toolName === "context_recall_agent");
    const toolOutput = (toolResultCall?.[1] as { output?: string } | undefined)?.output ?? "";
    expect(toolOutput).toContain("\"status\": \"not_found\"");
    expect(toolOutput).toContain("\"foundUsefulData\": false");
  });
});
