import { describe, expect, it } from "vitest";
import { createToolExecutor } from "../../src/skills/tool-executor.js";

describe("createToolExecutor", () => {
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

  it("applies global tools allowlist policy", async () => {
    const prev = process.env["TOOLS_MODE"];
    const prevAllowed = process.env["TOOLS_ALLOWED"];
    process.env["TOOLS_MODE"] = "allowlist";
    process.env["TOOLS_ALLOWED"] = "allowed.tool";

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

    if (prev === undefined) delete process.env["TOOLS_MODE"];
    else process.env["TOOLS_MODE"] = prev;
    if (prevAllowed === undefined) delete process.env["TOOLS_ALLOWED"];
    else process.env["TOOLS_ALLOWED"] = prevAllowed;
  });
});
