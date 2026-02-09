import { afterEach, describe, expect, it } from "vitest";
import { shellExecTool } from "../../src/skills/builtins/shell/index.js";
import { _setConfigForTesting, _resetConfigToDefault } from "../../src/skills/tool-access-config.js";

describe("shell tool", () => {
  afterEach(() => {
    _resetConfigToDefault();
  });

  it("executes command in full mode", async () => {
    _setConfigForTesting({
      global: { enabled: true, mode: "full", allowedTools: [] },
      tools: {
        shell: { enabled: true, mode: "full", allowedPrefixes: [], timeoutMs: 15000, maxOutputChars: 20000, allowAnyCwd: true },
      },
    });

    const result = await shellExecTool.execute({ cmd: "echo hello" });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("hello");
  });

  it("blocks execution when mode is off", async () => {
    _setConfigForTesting({
      global: { enabled: true, mode: "full", allowedTools: [] },
      tools: {
        shell: { enabled: true, mode: "off", allowedPrefixes: [], timeoutMs: 15000, maxOutputChars: 20000, allowAnyCwd: true },
      },
    });

    const result = await shellExecTool.execute({ cmd: "echo hello" });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("mode=off");
  });

  it("enforces allowlist mode", async () => {
    _setConfigForTesting({
      global: { enabled: true, mode: "full", allowedTools: [] },
      tools: {
        shell: { enabled: true, mode: "allowlist", allowedPrefixes: ["echo", "pwd"], timeoutMs: 15000, maxOutputChars: 20000, allowAnyCwd: true },
      },
    });

    const allowed = await shellExecTool.execute({ cmd: "echo hello" });
    const blocked = await shellExecTool.execute({ cmd: "uname -a" });

    expect(allowed.ok).toBe(true);
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toContain("not allowed");
  });
});
