import { describe, it, expect } from "vitest";
import { loadProvider } from "../../src/core/runtime/provider-loader.js";
import type { LlmProvider } from "../../src/core/contracts/provider.js";

describe("loadProvider", () => {
  it("should load a provider default export from a factory", async () => {
    const provider: LlmProvider = {
      name: "test-provider",
      version: "1.0.0",
      capabilities: { nativeToolCalling: true },
      start() {},
      stop() {},
      async generateTurn() {
        return { type: "assistant", content: "" };
      },
    };

    const loaded = await loadProvider(async () => ({ default: provider }));
    expect(loaded).toBe(provider);
  });

  it("should throw for invalid provider modules", async () => {
    await expect(
      loadProvider(async () => ({}) as { default: LlmProvider }),
    ).rejects.toThrow("Invalid provider module: expected a default export.");
  });
});
