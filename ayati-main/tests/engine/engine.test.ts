import { describe, it, expect, vi } from "vitest";
import { AgentEngine } from "../../src/engine/index.js";
import type { LlmProvider } from "../../src/core/contracts/provider.js";
import type { LlmTurnOutput } from "../../src/core/contracts/llm-protocol.js";
import type { ToolExecutor } from "../../src/skills/tool-executor.js";

function createMockProvider(overrides?: Partial<LlmProvider>): LlmProvider {
  return {
    name: "mock",
    version: "1.0.0",
    capabilities: { nativeToolCalling: true },
    start: vi.fn(),
    stop: vi.fn(),
    generateTurn: vi
      .fn<() => Promise<LlmTurnOutput>>()
      .mockResolvedValue({ type: "assistant", content: "mock reply" }),
    ...overrides,
  };
}

describe("AgentEngine", () => {
  it("should be constructible without options", () => {
    const engine = new AgentEngine();
    expect(engine).toBeInstanceOf(AgentEngine);
  });

  it("should start and stop without error when no provider is given", async () => {
    const engine = new AgentEngine();
    await engine.start();
    await engine.stop();
  });

  it("should echo when no provider is given", async () => {
    const onReply = vi.fn();
    const engine = new AgentEngine({ onReply });

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
    const engine = new AgentEngine({ onReply, provider });

    await engine.start();
    engine.handleMessage("c1", { type: "chat", content: "hello" });

    await vi.waitFor(() => {
      expect(provider.generateTurn).toHaveBeenCalledWith({
        messages: [{ role: "user", content: "hello" }],
      });
      expect(onReply).toHaveBeenCalledWith("c1", {
        type: "reply",
        content: "mock reply",
      });
    });
  });

  it("should pass context as system message", async () => {
    const provider = createMockProvider();
    const onReply = vi.fn();
    const engine = new AgentEngine({ onReply, provider, context: "System context" });

    await engine.start();
    engine.handleMessage("c1", { type: "chat", content: "hello" });

    await vi.waitFor(() => {
      expect(provider.generateTurn).toHaveBeenCalledWith({
        messages: [
          { role: "system", content: "System context" },
          { role: "user", content: "hello" },
        ],
      });
    });
  });

  it("should ignore non-chat messages", () => {
    const onReply = vi.fn();
    const engine = new AgentEngine({ onReply });

    engine.handleMessage("c1", { type: "ping" });
    engine.handleMessage("c1", { foo: "bar" });
    engine.handleMessage("c1", "raw string");

    expect(onReply).not.toHaveBeenCalled();
  });

  it("should execute a tool message when tool executor is configured", async () => {
    const onReply = vi.fn();
    const toolExecutor: ToolExecutor = {
      list: () => ["shell.exec"],
      definitions: () => [],
      execute: vi.fn().mockResolvedValue({ ok: true, output: "done" }),
    };
    const engine = new AgentEngine({ onReply, toolExecutor });

    engine.handleMessage("c1", { type: "tool", name: "shell.exec", input: { cmd: "echo ok" } });

    await vi.waitFor(() => {
      expect(onReply).toHaveBeenCalledWith("c1", {
        type: "tool_result",
        name: "shell.exec",
        result: { ok: true, output: "done" },
      });
    });
  });

  it("should autonomously execute native tool calls during chat flow", async () => {
    const onReply = vi.fn();
    const provider = createMockProvider({
      generateTurn: vi
        .fn<() => Promise<LlmTurnOutput>>()
        .mockResolvedValueOnce({
          type: "tool_calls",
          calls: [{ id: "t1", name: "shell.exec", input: { cmd: "echo hello" } }],
        })
        .mockResolvedValueOnce({
          type: "assistant",
          content: "Final verified answer",
        }),
    });
    const toolExecutor: ToolExecutor = {
      list: () => ["shell.exec"],
      definitions: () => [
        {
          name: "shell.exec",
          description: "Run shell",
          inputSchema: { type: "object", properties: { cmd: { type: "string" } } },
          execute: vi.fn().mockResolvedValue({ ok: true, output: "hello" }),
        },
      ],
      execute: vi.fn().mockResolvedValue({ ok: true, output: "hello" }),
    };

    const engine = new AgentEngine({ onReply, provider, toolExecutor, context: "ctx" });
    await engine.start();
    engine.handleMessage("c1", { type: "chat", content: "say hello" });

    await vi.waitFor(() => {
      expect(toolExecutor.execute).toHaveBeenCalledWith(
        "shell.exec",
        { cmd: "echo hello" },
        { clientId: "c1" },
      );
      expect(onReply).toHaveBeenCalledWith("c1", {
        type: "reply",
        content: "Final verified answer",
      });
    });
  });

  it("should return tool_result error when tool executor is missing", async () => {
    const onReply = vi.fn();
    const engine = new AgentEngine({ onReply });

    engine.handleMessage("c1", { type: "tool", name: "shell.exec", input: { cmd: "echo ok" } });

    await vi.waitFor(() => {
      expect(onReply).toHaveBeenCalledWith("c1", {
        type: "tool_result",
        name: "shell.exec",
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
    const engine = new AgentEngine({ onReply, provider });

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
