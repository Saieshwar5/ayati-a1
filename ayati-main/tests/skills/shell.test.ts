import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  shellExecTool,
  shellRunScriptTool,
  shellSessionStartTool,
  shellSessionWriteTool,
  shellSessionCloseTool,
  shellCapabilitiesTool,
} from "../../src/skills/builtins/shell/index.js";
import { _setConfigForTesting, _resetConfigToDefault } from "../../src/skills/tool-access-config.js";
import { clearPendingConfirmationsForTests } from "../../src/skills/guardrails/confirmation-store.js";

describe("shell tool", () => {
  afterEach(() => {
    clearPendingConfirmationsForTests();
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

  it("blocks dangerous command patterns", async () => {
    _setConfigForTesting({
      global: { enabled: true, mode: "full", allowedTools: [] },
      tools: {
        shell: { enabled: true, mode: "full", allowedPrefixes: [], timeoutMs: 15000, maxOutputChars: 20000, allowAnyCwd: true },
      },
    });

    const blocked = await shellExecTool.execute({ cmd: "rm -rf /tmp/test-dir" });
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toContain("blocked");
  });

  it("requires confirmation for destructive prefixes", async () => {
    _setConfigForTesting({
      global: { enabled: true, mode: "full", allowedTools: [] },
      tools: {
        shell: { enabled: true, mode: "allowlist", allowedPrefixes: ["mv"], timeoutMs: 15000, maxOutputChars: 20000, allowAnyCwd: true },
      },
    });

    const first = await shellExecTool.execute({ cmd: "mv a b" });
    expect(first.ok).toBe(false);
    expect(first.error).toContain("confirmation required");

    const operationId = String((first.meta as Record<string, unknown>)["operationId"]);
    const second = await shellExecTool.execute({ cmd: "mv a b", confirmationToken: `CONFIRM:${operationId}` });
    expect(String(second.error ?? "")).not.toContain("confirmation required");
  });

  it("runs script with confirmation", async () => {
    const scriptPath = join("/tmp", `ayati-shell-test-${Date.now()}.sh`);
    writeFileSync(scriptPath, "echo script-ok\n");
    _setConfigForTesting({
      global: { enabled: true, mode: "full", allowedTools: [] },
      tools: {
        shell: { enabled: true, mode: "allowlist", allowedPrefixes: ["bash"], timeoutMs: 15000, maxOutputChars: 20000, allowAnyCwd: true },
      },
    });

    const first = await shellRunScriptTool.execute({ scriptPath });
    expect(first.ok).toBe(false);
    expect(first.error).toContain("confirmation required");

    const operationId = String((first.meta as Record<string, unknown>)["operationId"]);
    const second = await shellRunScriptTool.execute({ scriptPath, confirmationToken: `CONFIRM:${operationId}` });
    expect(second.ok).toBe(true);
    expect(second.output).toContain("script-ok");
  });

  it("supports interactive shell sessions", async () => {
    _setConfigForTesting({
      global: { enabled: true, mode: "full", allowedTools: [] },
      tools: {
        shell: { enabled: true, mode: "full", allowedPrefixes: [], timeoutMs: 15000, maxOutputChars: 20000, allowAnyCwd: true },
      },
    });

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

  it("lists shell capabilities", async () => {
    _setConfigForTesting({
      global: { enabled: true, mode: "full", allowedTools: [] },
      tools: {
        shell: { enabled: true, mode: "full", allowedPrefixes: [], timeoutMs: 15000, maxOutputChars: 20000, allowAnyCwd: true },
      },
    });

    const result = await shellCapabilitiesTool.execute({});
    expect(result.ok).toBe(true);
    expect(String(result.output ?? "")).toContain("effective_allowed_prefixes=");
  });
});
