import { describe, it, expect, vi } from "vitest";
import { PluginRegistry } from "../../src/core/runtime/plugin-registry.js";
import type { AyatiPlugin } from "../../src/core/contracts/plugin.js";

function makePlugin(name: string): AyatiPlugin & { started: boolean; stopped: boolean } {
  const p = {
    name,
    version: "1.0.0",
    started: false,
    stopped: false,
    start() { p.started = true; },
    stop() { p.stopped = true; },
  };
  return p;
}

describe("PluginRegistry", () => {
  it("should register and list plugins", () => {
    const registry = new PluginRegistry();
    registry.register(makePlugin("a"));
    registry.register(makePlugin("b"));
    expect(registry.list()).toEqual(["a", "b"]);
  });

  it("should start all plugins", async () => {
    const registry = new PluginRegistry();
    const p = makePlugin("a");
    registry.register(p);
    await registry.startAll();
    expect(p.started).toBe(true);
  });

  it("should stop all plugins in reverse order", async () => {
    const order: string[] = [];
    const registry = new PluginRegistry();

    const a: AyatiPlugin = { name: "a", version: "1.0.0", start() {}, stop() { order.push("a"); } };
    const b: AyatiPlugin = { name: "b", version: "1.0.0", start() {}, stop() { order.push("b"); } };

    registry.register(a);
    registry.register(b);
    await registry.stopAll();

    expect(order).toEqual(["b", "a"]);
  });

  it("should find a plugin by name", () => {
    const registry = new PluginRegistry();
    const p = makePlugin("x");
    registry.register(p);
    expect(registry.getPlugin("x")).toBe(p);
    expect(registry.getPlugin("nope")).toBeUndefined();
  });
});
