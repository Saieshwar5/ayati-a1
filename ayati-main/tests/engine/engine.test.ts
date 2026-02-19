import { describe, it, expect, vi } from "vitest";
import { IVecEngine } from "../../src/ivec/index.js";
import type { LlmProvider } from "../../src/core/contracts/provider.js";
import type { LlmTurnInput, LlmTurnOutput } from "../../src/core/contracts/llm-protocol.js";
import type { SessionMemory } from "../../src/memory/types.js";
import type { StaticContext } from "../../src/context/static-context-cache.js";
import { emptySoulContext, emptyUserProfileContext } from "../../src/context/types.js";
import type { ToolExecutor } from "../../src/skills/tool-executor.js";
import { AGENT_STEP_TOOL_NAME } from "../../src/ivec/agent-step-tool.js";
import { CREATE_SESSION_TOOL_NAME } from "../../src/ivec/tool-helpers.js";

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
    recordAssistantFeedback: vi.fn(),
    getPromptMemoryContext: vi.fn().mockReturnValue({
      conversationTurns: [],
      previousSessionSummary: "",
      toolEvents: [],
    }),
    setStaticTokenBudget: vi.fn(),
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

  it("calls provider.generateTurn when provider exists", async () => {
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

  it("includes create_session in tool schemas", async () => {
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
      const calls = (provider.generateTurn as ReturnType<typeof vi.fn>).mock.calls
        .map((args) => args[0] as LlmTurnInput);
      const loopInput = calls.find((input) =>
        (input.tools ?? []).some((tool) => tool.name === AGENT_STEP_TOOL_NAME));
      expect(loopInput).toBeDefined();
      const names = (loopInput!.tools ?? []).map((tool) => tool.name);
      // real tools are not sent as separate native tools — they are embedded in agent_step description
      expect(names).not.toContain("shell");
      expect(names).toContain(CREATE_SESSION_TOOL_NAME);
      // shell must appear inside the enriched agent_step description
      const agentStep = (loopInput!.tools ?? []).find((t) => t.name === AGENT_STEP_TOOL_NAME);
      expect(agentStep?.description).toContain("shell");
    });
  });

  it("emits local context-size estimate before model call", async () => {
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

  it("ignores non-chat messages", () => {
    const onReply = vi.fn();
    const engine = new IVecEngine({ onReply });

    engine.handleMessage("c1", { type: "ping" });
    engine.handleMessage("c1", { foo: "bar" });
    engine.handleMessage("c1", "raw string");

    expect(onReply).not.toHaveBeenCalled();
  });

  it("executes tool message when tool executor is configured", async () => {
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

  it("executes tools via agent_step act phase", async () => {
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
    const sessionMemory = createSessionMemory();

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
    const sessionMemory = createSessionMemory();

    const engine = new IVecEngine({ provider, sessionMemory });
    await engine.start();

    expect(sessionMemory.setStaticTokenBudget).toHaveBeenCalledWith(expect.any(Number));
    const budget = (sessionMemory.setStaticTokenBudget as ReturnType<typeof vi.fn>).mock.calls[0]![0] as number;
    expect(budget).toBe(0);

    await engine.stop();
  });

  it("returns tool_result error when tool executor is missing", async () => {
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

  it("sends error reply when provider throws", async () => {
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

});
