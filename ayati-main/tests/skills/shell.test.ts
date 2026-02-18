import { describe, expect, it } from "vitest";
import {
  shellExecTool,
  shellRunScriptTool,
  shellSessionStartTool,
  shellSessionWriteTool,
  shellSessionCloseTool,
} from "../../src/skills/builtins/shell/index.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

describe("shell tool", () => {
  it("executes a command", async () => {
    const result = await shellExecTool.execute({ cmd: "echo hello" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("hello");
  });

  it("runs a script", async () => {
    const scriptPath = join("/tmp", `ayati-shell-test-${Date.now()}.sh`);
    writeFileSync(scriptPath, "echo script-ok\n");

    const result = await shellRunScriptTool.execute({ scriptPath });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("script-ok");
  });

  it("supports interactive shell sessions", async () => {
    const started = await shellSessionStartTool.execute({ cmd: "cat" });
    expect(started.ok).toBe(true);
    const sessionId = String((started.meta as Record<string, unknown>)["sessionId"]);
    expect(sessionId.length).toBeGreaterThan(0);

    const wrote = await shellSessionWriteTool.execute({ sessionId, input: "ping\n", waitMs: 200 });
    expect(wrote.ok).toBe(true);
    expect(String(wrote.output ?? "")).toContain("ping");

    const closed = await shellSessionCloseTool.execute({ sessionId });
    expect(closed.ok).toBe(true);
  });
});
