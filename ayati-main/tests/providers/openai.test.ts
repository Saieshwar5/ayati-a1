import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("openai", () => {
  const MockOpenAI = vi.fn();
  return { default: MockOpenAI };
});

import OpenAI from "openai";
import type { LlmProvider } from "../../src/core/contracts/provider.js";

async function getProvider(): Promise<LlmProvider> {
  const mod = await import("../../src/providers/openai/index.js");
  return mod.default;
}

function mockOpenAIConstructor(mockCreate: ReturnType<typeof vi.fn>): void {
  vi.mocked(OpenAI).mockImplementation(function (this: unknown) {
    return { chat: { completions: { create: mockCreate } } } as unknown as OpenAI;
  } as never);
}

describe("OpenAI provider", () => {
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

  it("should throw when OPENAI_API_KEY is missing", () => {
    delete process.env["OPENAI_API_KEY"];
    expect(() => provider.start()).toThrow("Missing OPENAI_API_KEY environment variable.");
  });

  it("should initialize when API key is present", () => {
    process.env["OPENAI_API_KEY"] = "sk-test-key";
    expect(() => provider.start()).not.toThrow();
    expect(OpenAI).toHaveBeenCalledWith({ apiKey: "sk-test-key" });
  });

  it("should call OpenAI API with canonical turn input", async () => {
    process.env["OPENAI_API_KEY"] = "sk-test-key";
    process.env["OPENAI_MODEL"] = "gpt-4o";

    const mockCreate = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "Hello from AI" } }],
    });

    mockOpenAIConstructor(mockCreate);

    provider.start();
    const out = await provider.generateTurn({
      messages: [
        { role: "system", content: "System" },
        { role: "user", content: "Hi" },
      ],
    });

    expect(mockCreate).toHaveBeenCalledWith({
      model: "gpt-4o",
      messages: [
        { role: "system", content: "System" },
        { role: "user", content: "Hi" },
      ],
    });
    expect(out).toEqual({ type: "assistant", content: "Hello from AI" });
  });

  it("should return tool calls when OpenAI responds with tool_calls", async () => {
    process.env["OPENAI_API_KEY"] = "sk-test-key";

    const mockCreate = vi.fn().mockImplementation(async (req: any) => {
      const toolName = req?.tools?.[0]?.function?.name;
      return {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: toolName,
                    arguments: '{"cmd":"pwd"}',
                  },
                },
              ],
            },
          },
        ],
      };
    });

    mockOpenAIConstructor(mockCreate);

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

    const sentToolName = (mockCreate.mock.calls[0]?.[0] as any)?.tools?.[0]?.function?.name as string;
    expect(sentToolName).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(sentToolName).not.toContain(".");

    expect(out).toEqual({
      type: "tool_calls",
      calls: [{ id: "call_1", name: "shell.exec", input: { cmd: "pwd" } }],
    });
  });

  it("should throw on empty response", async () => {
    process.env["OPENAI_API_KEY"] = "sk-test-key";

    const mockCreate = vi.fn().mockResolvedValue({
      choices: [{ message: { content: null, tool_calls: [] } }],
    });

    mockOpenAIConstructor(mockCreate);

    provider.start();
    await expect(
      provider.generateTurn({ messages: [{ role: "user", content: "Hi" }] }),
    ).rejects.toThrow("Empty response from OpenAI.");
  });

  it("should throw when calling generateTurn before start", async () => {
    await expect(
      provider.generateTurn({ messages: [{ role: "user", content: "Hi" }] }),
    ).rejects.toThrow("OpenAI provider not started.");
  });

  it("should clean up on stop", async () => {
    process.env["OPENAI_API_KEY"] = "sk-test-key";

    mockOpenAIConstructor(vi.fn());

    provider.start();
    provider.stop();
    await expect(
      provider.generateTurn({ messages: [{ role: "user", content: "Hi" }] }),
    ).rejects.toThrow("OpenAI provider not started.");
  });
});
