import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("@anthropic-ai/sdk", () => {
  const MockAnthropic = vi.fn();
  return { default: MockAnthropic };
});

import Anthropic from "@anthropic-ai/sdk";
import type { LlmProvider } from "../../src/core/contracts/provider.js";
import {
  type ProviderRuntimeConfigHandle,
  setupProviderRuntimeConfig,
} from "./runtime-config-test-helpers.js";

async function getProvider(): Promise<LlmProvider> {
  const mod = await import("../../src/providers/anthropic/index.js");
  return mod.default;
}

function mockAnthropicConstructor(
  mockCreate: ReturnType<typeof vi.fn>,
  mockCountTokens?: ReturnType<typeof vi.fn>,
): void {
  const countTokens = mockCountTokens ?? vi.fn().mockResolvedValue({ input_tokens: 0 });
  vi.mocked(Anthropic).mockImplementation(function (this: unknown) {
    return { messages: { create: mockCreate, countTokens } } as unknown as Anthropic;
  } as never);
}

function makeImageFixture(): { imagePath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "ayati-anthropic-image-"));
  const imagePath = join(dir, "sample.png");
  writeFileSync(imagePath, Buffer.from("fake-image-bytes"));
  return {
    imagePath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("Anthropic provider", () => {
  const originalEnv = { ...process.env };
  let provider: LlmProvider;
  let runtimeConfig: ProviderRuntimeConfigHandle;

  beforeEach(async () => {
    vi.clearAllMocks();
    runtimeConfig = await setupProviderRuntimeConfig("anthropic", "claude-sonnet-4-5-20250929");
    provider = await getProvider();
    provider.stop();
  });

  afterEach(async () => {
    await runtimeConfig.cleanup();
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
      max_tokens: 4096,
      system: "System",
      messages: [{ role: "user", content: "Hi" }],
    });
    expect(out).toEqual({ type: "assistant", content: "Hello from Claude" });
  });

  it("should serialize user images as Anthropic image blocks", async () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-test-key";
    const fixture = makeImageFixture();

    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "I can see the image." }],
    });

    mockAnthropicConstructor(mockCreate);

    try {
      provider.start();
      const out = await provider.generateTurn({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What is in this image?" },
              { type: "image", imagePath: fixture.imagePath, mimeType: "image/png", name: "sample.png" },
            ],
          },
        ],
      });

      expect((mockCreate.mock.calls[0]?.[0] as any)?.messages).toEqual([
        {
          role: "user",
          content: [
            { type: "text", text: "What is in this image?" },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: expect.any(String),
              },
            },
          ],
        },
      ]);
      expect(out).toEqual({ type: "assistant", content: "I can see the image." });
    } finally {
      fixture.cleanup();
    }
  });

  it("should count input tokens for the outgoing context", async () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-test-key";

    const mockCreate = vi.fn();
    const mockCount = vi.fn().mockResolvedValue({ input_tokens: 222 });

    mockAnthropicConstructor(mockCreate, mockCount);

    provider.start();
    const count = await provider.countInputTokens!({
      messages: [
        { role: "system", content: "System" },
        { role: "user", content: "Hi" },
      ],
    });

    expect(mockCount).toHaveBeenCalledWith({
      model: "claude-sonnet-4-5-20250929",
      system: "System",
      messages: [{ role: "user", content: "Hi" }],
    });
    expect(count).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-5-20250929",
      inputTokens: 222,
      exact: true,
    });
  });

  it("should return tool calls when Anthropic responds with tool_use blocks", async () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-test-key";

    const mockCreate = vi.fn().mockResolvedValue({
      content: [
        { type: "text", text: "Running tool" },
        { type: "tool_use", id: "toolu_1", name: "shell", input: { cmd: "pwd" } },
      ],
    });

    mockAnthropicConstructor(mockCreate);

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

    expect(out).toEqual({
      type: "tool_calls",
      calls: [{ id: "toolu_1", name: "shell", input: { cmd: "pwd" } }],
      assistantContent: "Running tool",
    });
  });

  it("should normalize Anthropic tool names and map them back to canonical names", async () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-test-key";

    const mockCreate = vi.fn().mockImplementation(async (request: any) => {
      const toolName = request?.tools?.[0]?.name;
      return {
        content: [
          { type: "tool_use", id: "toolu_1", name: toolName, input: { cmd: "pwd" } },
        ],
      };
    });

    mockAnthropicConstructor(mockCreate);

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

    const sentToolName = (mockCreate.mock.calls[0]?.[0] as any)?.tools?.[0]?.name as string;
    expect(sentToolName).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(sentToolName).not.toContain(".");
    expect(out).toEqual({
      type: "tool_calls",
      calls: [{ id: "toolu_1", name: "shell.tool", input: { cmd: "pwd" } }],
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

  it("should throw when calling countInputTokens before start", async () => {
    await expect(
      provider.countInputTokens!({ messages: [{ role: "user", content: "Hi" }] }),
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
