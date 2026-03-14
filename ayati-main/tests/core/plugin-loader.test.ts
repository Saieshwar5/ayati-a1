import { describe, expect, it } from "vitest";
import { loadPlugins } from "../../src/core/runtime/plugin-loader.js";
import type { AyatiPlugin, PluginRuntimeContext } from "../../src/core/contracts/plugin.js";

const runtimeContext = {
  clientId: "local",
  dataDir: "/tmp/data",
  projectRoot: "/tmp/project",
  async publishSystemEvent() {
    return {
      accepted: true as const,
      event: {
        type: "system_event" as const,
        eventId: "evt-1",
        source: "test",
        eventName: "ready",
        receivedAt: "2026-03-13T00:00:00.000Z",
        summary: "test event",
        payload: {},
      },
    };
  },
} satisfies PluginRuntimeContext;

describe("loadPlugins", () => {
  it("should load plugin default exports from factories", async () => {
    const plugin: AyatiPlugin = {
      name: "sample-plugin",
      version: "1.0.0",
      start(_context) {},
      stop(_context) {},
    };

    const loaded = await loadPlugins([async () => ({ default: plugin })]);
    expect(loaded).toEqual([plugin]);
    await loaded[0]?.start(runtimeContext);
  });

  it("should throw for invalid plugin modules", async () => {
    await expect(loadPlugins([async () => ({} as { default: AyatiPlugin })])).rejects.toThrow(
      "Invalid plugin module: expected a default export.",
    );
  });
});
