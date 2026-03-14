import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { estimateTurnInputTokens } from "../../src/prompt/token-estimator.js";

vi.mock("openai", () => {
  const MockOpenAI = vi.fn();
  return { default: MockOpenAI };
});

import OpenAI from "openai";
import type { LlmProvider } from "../../src/core/contracts/provider.js";
import {
  type ProviderRuntimeConfigHandle,
  setupProviderRuntimeConfig,
} from "./runtime-config-test-helpers.js";

async function getProvider(): Promise<LlmProvider> {
  const mod = await import("../../src/providers/fireworks/index.js");
  return mod.default;
}

function mockOpenAIConstructor(mockCreate: ReturnType<typeof vi.fn>): void {
  vi.mocked(OpenAI).mockImplementation(function (this: unknown) {
    return {
      chat: { completions: { create: mockCreate } },
    } as unknown as OpenAI;
  } as never);
}

describe("Fireworks provider", () => {
  const originalEnv = { ...process.env };
  let provider: LlmProvider;
  let runtimeConfig: ProviderRuntimeConfigHandle;

  beforeEach(async () => {
    vi.clearAllMocks();
    runtimeConfig = await setupProviderRuntimeConfig("fireworks", "fireworks/minimax-m2p5");
    provider = await getProvider();
    provider.stop();
  });

  afterEach(async () => {
    await runtimeConfig.cleanup();
    process.env = { ...originalEnv };
  });

  it("should throw when FIREWORKS_API_KEY is missing", () => {
    delete process.env["FIREWORKS_API_KEY"];
    expect(() => provider.start()).toThrow("Missing FIREWORKS_API_KEY environment variable.");
  });

  it("should initialize when API key is present", () => {
    process.env["FIREWORKS_API_KEY"] = "fw-test-key";

    provider.start();

    expect(OpenAI).toHaveBeenCalledWith({
      apiKey: "fw-test-key",
      baseURL: "https://api.fireworks.ai/inference/v1",
    });
  });

  it("should call Fireworks with canonical turn input and MiniMax reasoning effort", async () => {
    process.env["FIREWORKS_API_KEY"] = "fw-test-key";
    process.env["FIREWORKS_REASONING_EFFORT"] = "high";

    const mockCreate = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "Hello from Fireworks" } }],
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
      model: "fireworks/minimax-m2p5",
      reasoning_effort: "high",
      messages: [
        { role: "system", content: "System" },
        { role: "user", content: "Hi" },
      ],
    });
    expect(out).toEqual({ type: "assistant", content: "Hello from Fireworks" });
  });

  it("should estimate input tokens locally", async () => {
    process.env["FIREWORKS_API_KEY"] = "fw-test-key";

    mockOpenAIConstructor(vi.fn());

    provider.start();
    const input = {
      messages: [
        { role: "system" as const, content: "System" },
        { role: "user" as const, content: "Hi" },
      ],
    };
    const count = await provider.countInputTokens!(input);

    expect(count).toEqual({
      provider: "fireworks",
      model: "fireworks/minimax-m2p5",
      inputTokens: estimateTurnInputTokens(input).totalTokens,
      exact: false,
    });
  });

  it("should return tool calls when Fireworks responds with tool_calls", async () => {
    process.env["FIREWORKS_API_KEY"] = "fw-test-key";

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
                    arguments: "{\"cmd\":\"pwd\"}",
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
          name: "shell.tool",
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
      calls: [{ id: "call_1", name: "shell.tool", input: { cmd: "pwd" } }],
    });
  });

  it("should pass structured output settings when requested", async () => {
    process.env["FIREWORKS_API_KEY"] = "fw-test-key";
    process.env["FIREWORKS_REASONING_EFFORT"] = "medium";

    const mockCreate = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "{\"done\":true,\"summary\":\"ok\",\"status\":\"completed\"}" } }],
    });

    mockOpenAIConstructor(mockCreate);

    provider.start();
    await provider.generateTurn({
      messages: [{ role: "user", content: "Hi" }],
      responseFormat: {
        type: "json_schema",
        name: "controller_direct_response",
        strict: true,
        schema: {
          type: "object",
        },
      },
    });

    expect(mockCreate).toHaveBeenCalledWith({
      model: "fireworks/minimax-m2p5",
      reasoning_effort: "medium",
      messages: [{ role: "user", content: "Hi" }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "controller_direct_response",
          schema: {
            type: "object",
          },
          strict: true,
        },
      },
    });
  });

  it("should throw for invalid MiniMax reasoning effort", async () => {
    process.env["FIREWORKS_API_KEY"] = "fw-test-key";
    process.env["FIREWORKS_REASONING_EFFORT"] = "max";

    mockOpenAIConstructor(vi.fn());

    provider.start();

    await expect(
      provider.generateTurn({ messages: [{ role: "user", content: "Hi" }] }),
    ).rejects.toThrow(
      'Invalid FIREWORKS_REASONING_EFFORT "max". Expected one of: low, medium, high.',
    );
  });

  it("should throw on empty response", async () => {
    process.env["FIREWORKS_API_KEY"] = "fw-test-key";

    const mockCreate = vi.fn().mockResolvedValue({
      choices: [{ message: { content: null, tool_calls: [] } }],
    });

    mockOpenAIConstructor(mockCreate);

    provider.start();
    await expect(
      provider.generateTurn({ messages: [{ role: "user", content: "Hi" }] }),
    ).rejects.toThrow("Empty response from Fireworks.");
  });

  it("should throw when calling generateTurn before start", async () => {
    await expect(
      provider.generateTurn({ messages: [{ role: "user", content: "Hi" }] }),
    ).rejects.toThrow("Fireworks provider not started.");
  });

  it("should throw when calling countInputTokens before start", async () => {
    await expect(
      provider.countInputTokens!({ messages: [{ role: "user", content: "Hi" }] }),
    ).rejects.toThrow("Fireworks provider not started.");
  });

  it("should clean up on stop", async () => {
    process.env["FIREWORKS_API_KEY"] = "fw-test-key";

    mockOpenAIConstructor(vi.fn());

    provider.start();
    provider.stop();
    await expect(
      provider.generateTurn({ messages: [{ role: "user", content: "Hi" }] }),
    ).rejects.toThrow("Fireworks provider not started.");
  });
});
