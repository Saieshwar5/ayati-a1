import { afterEach, describe, expect, it } from "vitest";
import { createToolExecutor } from "../../src/skills/tool-executor.js";
import { _setConfigForTesting, _resetConfigToDefault } from "../../src/skills/tool-access-config.js";

describe("createToolExecutor", () => {
  afterEach(() => {
    _resetConfigToDefault();
  });

  it("routes to registered tool by name", async () => {
    const executor = createToolExecutor([
      {
        name: "x.run",
        description: "x",
        async execute(input) {
          return { ok: true, output: String((input as { v: string }).v) };
        },
      },
    ]);

    const result = await executor.execute("x.run", { v: "hello" });
    expect(result).toEqual({ ok: true, output: "hello" });
  });

  it("returns unknown tool error", async () => {
    const executor = createToolExecutor([]);
    const result = await executor.execute("missing", {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Unknown tool");
  });

  it("blocks tool when per-tool enabled is false", async () => {
    _setConfigForTesting({
      global: { enabled: true, mode: "full", allowedTools: [] },
      tools: { "my.tool": { enabled: false } },
    });

    const executor = createToolExecutor([
      {
        name: "my.tool",
        description: "x",
        async execute() {
          return { ok: true, output: "should not run" };
        },
      },
    ]);

    const result = await executor.execute("my.tool", {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("disabled");
  });

  it("applies global tools allowlist policy", async () => {
    _setConfigForTesting({
      global: { enabled: true, mode: "allowlist", allowedTools: ["allowed.tool"] },
      tools: {},
    });

    const executor = createToolExecutor([
      {
        name: "denied.tool",
        description: "x",
        async execute() {
          return { ok: true, output: "should not run" };
        },
      },
    ]);

    const result = await executor.execute("denied.tool", {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("allowlist");
  });
});
