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
  const mod = await import("../../src/providers/openrouter/index.js");
  return mod.default;
}

function mockOpenAIConstructor(mockCreate: ReturnType<typeof vi.fn>): void {
  vi.mocked(OpenAI).mockImplementation(function (this: unknown) {
    return {
      chat: { completions: { create: mockCreate } },
    } as unknown as OpenAI;
  } as never);
}

describe("OpenRouter provider", () => {
  const originalEnv = { ...process.env };
  let provider: LlmProvider;
  let runtimeConfig: ProviderRuntimeConfigHandle;

  beforeEach(async () => {
    vi.clearAllMocks();
    runtimeConfig = await setupProviderRuntimeConfig(
      "openrouter",
      "nvidia/nemotron-3-super-120b-a12b:free",
    );
    provider = await getProvider();
    provider.stop();
  });

  afterEach(async () => {
    await runtimeConfig.cleanup();
    process.env = { ...originalEnv };
  });

  it("should throw when OPENROUTER_API_KEY is missing", () => {
    delete process.env["OPENROUTER_API_KEY"];
    expect(() => provider.start()).toThrow("Missing OPENROUTER_API_KEY environment variable.");
  });

  it("should initialize when API key is present", () => {
    process.env["OPENROUTER_API_KEY"] = "or-test-key";
    expect(() => provider.start()).not.toThrow();
    expect(OpenAI).toHaveBeenCalledWith({
      apiKey: "or-test-key",
      baseURL: "https://openrouter.ai/api/v1",
    });
  });

  it("should include optional OpenRouter headers when configured", () => {
    process.env["OPENROUTER_API_KEY"] = "or-test-key";
    process.env["OPENROUTER_SITE_URL"] = "http://localhost:3000";
    process.env["OPENROUTER_APP_NAME"] = "Ayati";

    provider.start();

    expect(OpenAI).toHaveBeenCalledWith({
      apiKey: "or-test-key",
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders: {
        "HTTP-Referer": "http://localhost:3000",
        "X-Title": "Ayati",
      },
    });
  });

  it("should call OpenRouter with canonical turn input", async () => {
    process.env["OPENROUTER_API_KEY"] = "or-test-key";

    const mockCreate = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "Hello from OpenRouter" } }],
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
      model: "nvidia/nemotron-3-super-120b-a12b:free",
      messages: [
        { role: "system", content: "System" },
        { role: "user", content: "Hi" },
      ],
    });
    expect(out).toEqual({ type: "assistant", content: "Hello from OpenRouter" });
  });

  it("should estimate input tokens locally", async () => {
    process.env["OPENROUTER_API_KEY"] = "or-test-key";

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
      provider: "openrouter",
      model: "nvidia/nemotron-3-super-120b-a12b:free",
      inputTokens: estimateTurnInputTokens(input).totalTokens,
      exact: false,
    });
  });

  it("should return tool calls when OpenRouter responds with tool_calls", async () => {
    process.env["OPENROUTER_API_KEY"] = "or-test-key";

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
          name: "shell",
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
      calls: [{ id: "call_1", name: "shell", input: { cmd: "pwd" } }],
    });
  });

  it("should ignore structured output settings when native support is disabled", async () => {
    process.env["OPENROUTER_API_KEY"] = "or-test-key";

    const mockCreate = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "Hello from OpenRouter" } }],
    });

    mockOpenAIConstructor(mockCreate);

    provider.start();
    await provider.generateTurn({
      messages: [{ role: "user", content: "Hi" }],
      responseFormat: {
        type: "json_schema",
        name: "controller_direct_response",
        schema: { type: "object" },
      },
    });

    expect(mockCreate).toHaveBeenCalledWith({
      model: "nvidia/nemotron-3-super-120b-a12b:free",
      messages: [{ role: "user", content: "Hi" }],
    });
  });

  it("should throw on empty response", async () => {
    process.env["OPENROUTER_API_KEY"] = "or-test-key";

    const mockCreate = vi.fn().mockResolvedValue({
      choices: [{ message: { content: null, tool_calls: [] } }],
    });

    mockOpenAIConstructor(mockCreate);

    provider.start();
    await expect(
      provider.generateTurn({ messages: [{ role: "user", content: "Hi" }] }),
    ).rejects.toThrow("Empty response from OpenRouter.");
  });

  it("should throw when calling generateTurn before start", async () => {
    await expect(
      provider.generateTurn({ messages: [{ role: "user", content: "Hi" }] }),
    ).rejects.toThrow("OpenRouter provider not started.");
  });

  it("should throw when calling countInputTokens before start", async () => {
    await expect(
      provider.countInputTokens!({ messages: [{ role: "user", content: "Hi" }] }),
    ).rejects.toThrow("OpenRouter provider not started.");
  });

  it("should clean up on stop", async () => {
    process.env["OPENROUTER_API_KEY"] = "or-test-key";

    mockOpenAIConstructor(vi.fn());

    provider.start();
    provider.stop();
    await expect(
      provider.generateTurn({ messages: [{ role: "user", content: "Hi" }] }),
    ).rejects.toThrow("OpenRouter provider not started.");
  });
});
