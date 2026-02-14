import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getGlobalPolicy,
  getShellPolicy,
  getFilesystemGuardrailsPolicy,
  getShellGuardrailsPolicy,
  getConfirmationGuardrailsPolicy,
  isToolEnabled,
  _setConfigForTesting,
  _resetConfigToDefault,
} from "../../src/skills/tool-access-config.js";
import type { ToolAccessConfig } from "../../src/skills/tool-access-config.js";

vi.mock("../../src/shared/index.js", () => ({
  devLog: vi.fn(),
  devWarn: vi.fn(),
}));

describe("tool-access-config", () => {
  afterEach(() => {
    _resetConfigToDefault();
  });

  it("returns defaults after reset", () => {
    const global = getGlobalPolicy();
    expect(global.enabled).toBe(true);
    expect(global.mode).toBe("full");
    expect(global.allowedTools).toEqual([]);

    const shell = getShellPolicy();
    expect(shell.enabled).toBe(true);
    expect(shell.mode).toBe("allowlist");
    expect(shell.timeoutMs).toBe(15_000);
    expect(shell.maxOutputChars).toBe(20_000);
    expect(shell.allowAnyCwd).toBe(false);
    expect(shell.allowedPrefixes.length).toBeGreaterThan(0);

    const fsGuardrails = getFilesystemGuardrailsPolicy();
    expect(fsGuardrails.allowedReadRoots).toContain("/");
    expect(fsGuardrails.allowedWriteRoots).toContain("/tmp");

    const shellGuardrails = getShellGuardrailsPolicy();
    expect(shellGuardrails.denyPrefixes).toContain("rm");

    const confirm = getConfirmationGuardrailsPolicy();
    expect(confirm.tokenPrefix).toBe("CONFIRM:");
  });

  it("_setConfigForTesting overrides config", () => {
    const config: ToolAccessConfig = {
      global: { enabled: false, mode: "off", allowedTools: [] },
      tools: {
        shell: {
          enabled: false,
          mode: "allowlist",
          allowedPrefixes: ["echo"],
          timeoutMs: 5000,
          maxOutputChars: 1000,
          allowAnyCwd: false,
        },
      },
    };

    _setConfigForTesting(config);

    expect(getGlobalPolicy().enabled).toBe(false);
    expect(getGlobalPolicy().mode).toBe("off");

    const shell = getShellPolicy();
    expect(shell.enabled).toBe(false);
    expect(shell.mode).toBe("allowlist");
    expect(shell.allowedPrefixes).toEqual(["echo"]);
    expect(shell.timeoutMs).toBe(5000);
    expect(shell.maxOutputChars).toBe(1000);
    expect(shell.allowAnyCwd).toBe(false);
  });

  it("_resetConfigToDefault restores defaults after override", () => {
    _setConfigForTesting({
      global: { enabled: false, mode: "off", allowedTools: ["x"] },
      tools: {},
    });

    _resetConfigToDefault();

    const global = getGlobalPolicy();
    expect(global.enabled).toBe(true);
    expect(global.mode).toBe("full");
    expect(global.allowedTools).toEqual([]);
  });

  it("partial shell config merges with defaults", () => {
    _setConfigForTesting({
      global: { enabled: true, mode: "full", allowedTools: [] },
      tools: {
        shell: { enabled: false },
      },
    });

    const shell = getShellPolicy();
    expect(shell.enabled).toBe(false);
    expect(shell.mode).toBe("allowlist");
    expect(shell.timeoutMs).toBe(15_000);
    expect(shell.maxOutputChars).toBe(20_000);
    expect(shell.allowAnyCwd).toBe(false);
  });

  it("enforces hard cap on timeoutMs", () => {
    _setConfigForTesting({
      global: { enabled: true, mode: "full", allowedTools: [] },
      tools: {
        shell: {
          enabled: true,
          mode: "full",
          allowedPrefixes: [],
          timeoutMs: 999_999,
          maxOutputChars: 20_000,
          allowAnyCwd: true,
        },
      },
    });

    expect(getShellPolicy().timeoutMs).toBe(120_000);
  });

  it("enforces hard cap on maxOutputChars", () => {
    _setConfigForTesting({
      global: { enabled: true, mode: "full", allowedTools: [] },
      tools: {
        shell: {
          enabled: true,
          mode: "full",
          allowedPrefixes: [],
          timeoutMs: 15_000,
          maxOutputChars: 999_999,
          allowAnyCwd: true,
        },
      },
    });

    expect(getShellPolicy().maxOutputChars).toBe(200_000);
  });

  it("returns shell defaults when tools.shell is missing", () => {
    _setConfigForTesting({
      global: { enabled: true, mode: "full", allowedTools: [] },
      tools: {},
    });

    const shell = getShellPolicy();
    expect(shell.enabled).toBe(true);
    expect(shell.mode).toBe("allowlist");
    expect(shell.timeoutMs).toBe(15_000);
  });

  it("isToolEnabled returns true when tool has no entry", () => {
    _setConfigForTesting({
      global: { enabled: true, mode: "full", allowedTools: [] },
      tools: {},
    });

    expect(isToolEnabled("nonexistent")).toBe(true);
  });

  it("isToolEnabled returns true when enabled is true", () => {
    _setConfigForTesting({
      global: { enabled: true, mode: "full", allowedTools: [] },
      tools: { rename_agent: { enabled: true } },
    });

    expect(isToolEnabled("rename_agent")).toBe(true);
  });

  it("isToolEnabled returns false when enabled is false", () => {
    _setConfigForTesting({
      global: { enabled: true, mode: "full", allowedTools: [] },
      tools: { rename_agent: { enabled: false } },
    });

    expect(isToolEnabled("rename_agent")).toBe(false);
  });

  it("loads config from JSON file", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "ayati-cfg-"));
    const contextDir = join(baseDir, "context");
    mkdirSync(contextDir, { recursive: true });

    const configContent = {
      global: { enabled: false, mode: "allowlist", allowedTools: ["shell"] },
      tools: {
        shell: {
          enabled: true,
          mode: "allowlist",
          allowedPrefixes: ["echo", "ls"],
          timeoutMs: 10_000,
          maxOutputChars: 5_000,
          allowAnyCwd: false,
        },
      },
    };

    writeFileSync(join(contextDir, "tool-access.json"), JSON.stringify(configContent));

    // Use _setConfigForTesting to simulate what loadToolAccessConfig does
    _setConfigForTesting(configContent);

    const global = getGlobalPolicy();
    expect(global.enabled).toBe(false);
    expect(global.mode).toBe("allowlist");
    expect(global.allowedTools).toEqual(["shell"]);

    const shell = getShellPolicy();
    expect(shell.allowedPrefixes).toEqual(["echo", "ls"]);
    expect(shell.timeoutMs).toBe(10_000);
  });

  it("merges custom guardrails with defaults", () => {
    _setConfigForTesting({
      global: { enabled: true, mode: "full", allowedTools: [] },
      tools: {},
      guardrails: {
        filesystem: {
          allowedWriteRoots: ["/tmp"],
          requireConfirmationFor: ["delete"],
        },
        confirmation: {
          tokenPrefix: "CONFIRM:",
          ttlMs: 60_000,
        },
      },
    });

    const fs = getFilesystemGuardrailsPolicy();
    expect(fs.allowedWriteRoots).toEqual(["/tmp"]);
    expect(fs.requireConfirmationFor).toContain("delete");
    expect(fs.allowedReadRoots).toContain("/");

    const confirmation = getConfirmationGuardrailsPolicy();
    expect(confirmation.tokenPrefix).toBe("CONFIRM:");
    expect(confirmation.ttlMs).toBe(60_000);
  });
});
