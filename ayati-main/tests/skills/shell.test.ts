import { afterEach, beforeEach, describe, expect, it } from "vitest";

const oldEnv = { ...process.env };

function restoreEnv() {
  process.env = { ...oldEnv };
}

describe("shell.exec tool", () => {
  beforeEach(() => {
    restoreEnv();
  });

  afterEach(() => {
    restoreEnv();
  });

  it("executes command in full mode", async () => {
    process.env["SHELL_TOOL_ENABLED"] = "true";
    process.env["SHELL_TOOL_MODE"] = "full";

    const { shellExecTool } = await import("../../src/skills/builtins/shell/index.js");
    const result = await shellExecTool.execute({ cmd: "echo hello" });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("hello");
  });

  it("blocks execution when mode is off", async () => {
    process.env["SHELL_TOOL_ENABLED"] = "true";
    process.env["SHELL_TOOL_MODE"] = "off";

    const { shellExecTool } = await import("../../src/skills/builtins/shell/index.js");
    const result = await shellExecTool.execute({ cmd: "echo hello" });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("SHELL_TOOL_MODE=off");
  });

  it("enforces allowlist mode", async () => {
    process.env["SHELL_TOOL_ENABLED"] = "true";
    process.env["SHELL_TOOL_MODE"] = "allowlist";
    process.env["SHELL_TOOL_ALLOWED_PREFIXES"] = "echo,pwd";

    const { shellExecTool } = await import("../../src/skills/builtins/shell/index.js");
    const allowed = await shellExecTool.execute({ cmd: "echo hello" });
    const blocked = await shellExecTool.execute({ cmd: "uname -a" });

    expect(allowed.ok).toBe(true);
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toContain("not allowed");
  });
});
