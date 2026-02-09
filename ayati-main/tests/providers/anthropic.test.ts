import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@anthropic-ai/sdk", () => {
  const MockAnthropic = vi.fn();
  return { default: MockAnthropic };
});

import Anthropic from "@anthropic-ai/sdk";
import type { LlmProvider } from "../../src/core/contracts/provider.js";

async function getProvider(): Promise<LlmProvider> {
  const mod = await import("../../src/providers/anthropic/index.js");
  return mod.default;
}

function mockAnthropicConstructor(mockCreate: ReturnType<typeof vi.fn>): void {
  vi.mocked(Anthropic).mockImplementation(function (this: unknown) {
    return { messages: { create: mockCreate } } as unknown as Anthropic;
  } as never);
}

describe("Anthropic provider", () => {
  const originalEnv = { ...process.env };
  let provider: LlmProvider;

  beforeEach(async () => {
    vi.clearAllMocks();
    provider = await getProvider();
    provider.stop();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("should throw when ANTHROPIC_API_KEY is missing", () => {
    delete process.env["ANTHROPIC_API_KEY"];
    expect(() => provider.start()).toThrow("Missing ANTHROPIC_API_KEY environment variable.");
  });

  it("should initialize when API key is present", () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-test-key";
    expect(() => provider.start()).not.toThrow();
    expect(Anthropic).toHaveBeenCalledWith({ apiKey: "sk-ant-test-key" });
  });

  it("should call Anthropic API with canonical turn input", async () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-test-key";
    process.env["ANTHROPIC_MODEL"] = "claude-sonnet-4-5-20250929";

    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "Hello from Claude" }],
    });

    mockAnthropicConstructor(mockCreate);

    provider.start();
    const out = await provider.generateTurn({
      messages: [
        { role: "system", content: "System" },
        { role: "user", content: "Hi" },
      ],
    });

    expect(mockCreate).toHaveBeenCalledWith({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 1024,
      system: "System",
      messages: [{ role: "user", content: "Hi" }],
    });
    expect(out).toEqual({ type: "assistant", content: "Hello from Claude" });
  });

  it("should return tool calls when Anthropic responds with tool_use blocks", async () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-test-key";

    const mockCreate = vi.fn().mockResolvedValue({
      content: [
        { type: "text", text: "Running tool" },
        { type: "tool_use", id: "toolu_1", name: "shell.exec", input: { cmd: "pwd" } },
      ],
    });

    mockAnthropicConstructor(mockCreate);

    provider.start();
    const out = await provider.generateTurn({
      messages: [{ role: "user", content: "where am i" }],
      tools: [
        {
          name: "shell.exec",
          description: "Run shell",
          inputSchema: { type: "object", properties: { cmd: { type: "string" } } },
        },
      ],
    });

    expect(out).toEqual({
      type: "tool_calls",
      calls: [{ id: "toolu_1", name: "shell.exec", input: { cmd: "pwd" } }],
      assistantContent: "Running tool",
    });
  });

  it("should throw on empty response", async () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-test-key";

    const mockCreate = vi.fn().mockResolvedValue({
      content: [],
    });

    mockAnthropicConstructor(mockCreate);

    provider.start();
    await expect(
      provider.generateTurn({ messages: [{ role: "user", content: "Hi" }] }),
    ).rejects.toThrow("Empty response from Anthropic.");
  });

  it("should throw when calling generateTurn before start", async () => {
    await expect(
      provider.generateTurn({ messages: [{ role: "user", content: "Hi" }] }),
    ).rejects.toThrow("Anthropic provider not started.");
  });

  it("should clean up on stop", async () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-test-key";

    mockAnthropicConstructor(vi.fn());

    provider.start();
    provider.stop();
    await expect(
      provider.generateTurn({ messages: [{ role: "user", content: "Hi" }] }),
    ).rejects.toThrow("Anthropic provider not started.");
  });
});
