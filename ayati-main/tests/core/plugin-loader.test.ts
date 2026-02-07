import { describe, expect, it } from "vitest";
import { loadPlugins } from "../../src/core/runtime/plugin-loader.js";
import type { AyatiPlugin } from "../../src/core/contracts/plugin.js";

describe("loadPlugins", () => {
  it("should load plugin default exports from factories", async () => {
    const plugin: AyatiPlugin = {
      name: "sample-plugin",
      version: "1.0.0",
      start() {},
      stop() {},
    };

    const loaded = await loadPlugins([async () => ({ default: plugin })]);
    expect(loaded).toEqual([plugin]);
  });

  it("should throw for invalid plugin modules", async () => {
    await expect(loadPlugins([async () => ({} as { default: AyatiPlugin })])).rejects.toThrow(
      "Invalid plugin module: expected a default export.",
    );
  });
});
