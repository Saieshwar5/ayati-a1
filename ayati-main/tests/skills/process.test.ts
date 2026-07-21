import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  processPollTool,
  processRunTool,
  processSendInputTool,
  processStartTool,
  processStopTool,
} from "../../src/skills/builtins/process/index.js";
import { workspaceRoot } from "../../src/skills/workspace-paths.js";
import { canCaptureNodeSubprocessOutput } from "../fixtures/runtime-capabilities.js";

const supportsSubprocessOutput = canCaptureNodeSubprocessOutput();

describe("focused process tools", () => {
  it("runs one executable with structured arguments", async () => {
    const result = await processRunTool.execute({ executable: "node", args: ["--version"] });

    expect(result.ok).toBe(true);
    expect(result.rawOutput).toMatch(/^v\d+/);
    expect(result.v2?.structuredContent).toMatchObject({
      exitCode: 0,
      timedOut: false,
      observation: { mode: "focused" },
    });
  });

  it("does not interpret arguments as shell syntax", async () => {
    const result = await processRunTool.execute({
      executable: "echo",
      args: ["hello; echo should-not-run"],
    });

    expect(result.ok).toBe(true);
    expect(result.rawOutput?.trim()).toBe("hello; echo should-not-run");
  });

  it.runIf(supportsSubprocessOutput)("returns stdout and stderr when an executable fails", async () => {
    const temp = await mkdtemp(join(tmpdir(), "ayati-process-failure-"));
    try {
      const scriptPath = join(temp, "fail.mjs");
      await writeFile(scriptPath, "console.log('stdout-line'); console.error('stderr-line'); process.exit(7);\n", "utf8");

      const result = await processRunTool.execute({ executable: "node", args: [scriptPath] });

      expect(result.ok).toBe(false);
      expect(result.output).toContain("stdout-line");
      expect(result.output).toContain("stderr-line");
      expect(result.v2?.structuredContent).toMatchObject({ exitCode: 7 });
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it.each([
    ["cat", "read_files"],
    ["rg", "search_in_files"],
    ["find", "find_files"],
    ["ls", "list_directory"],
    ["sqlite3", "database tools"],
    ["git", "Context Engine runtime"],
    ["python3", "python_execute"],
    ["curl", "file_fetch_url"],
  ])("rejects %s because a focused tool owns the capability", async (executable, owner) => {
    const result = await processRunTool.execute({ executable });

    expect(result.ok).toBe(false);
    expect(result.v2?.code).toBe("PROCESS_DEDICATED_TOOL_REQUIRED");
    expect(result.error).toContain(owner);
  });

  it("rejects shell interpreters and inline interpreter code", async () => {
    const shell = await processRunTool.execute({ executable: "bash", args: ["-lc", "echo hidden"] });
    const inline = await processRunTool.execute({ executable: "node", args: ["-e", "console.log('hidden')"] });

    expect(shell.v2?.code).toBe("PROCESS_SHELL_INTERPRETER_BLOCKED");
    expect(inline.v2?.code).toBe("PROCESS_INLINE_CODE_BLOCKED");
  });

  it.runIf(supportsSubprocessOutput)("defaults cwd to the configured workspace", async () => {
    const temp = await mkdtemp(join(tmpdir(), "ayati-process-cwd-"));
    try {
      const scriptPath = join(temp, "cwd.mjs");
      await writeFile(scriptPath, "console.log(process.cwd());\n", "utf8");

      const result = await processRunTool.execute({ executable: "node", args: [scriptPath] });

      expect(result.ok).toBe(true);
      expect(String(result.rawOutput ?? "").trim()).toBe(workspaceRoot);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("rejects supplied relative working directories", async () => {
    const result = await processRunTool.execute({ executable: "node", args: ["--version"], cwd: "project" });

    expect(result.ok).toBe(false);
    expect(result.v2?.code).toBe("ABSOLUTE_PATH_REQUIRED");
  });

  it.runIf(supportsSubprocessOutput)("separates process input, polling, and stopping", async () => {
    const temp = await mkdtemp(join(tmpdir(), "ayati-process-session-"));
    try {
      const scriptPath = join(temp, "echo-input.mjs");
      await writeFile(scriptPath, [
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (value) => process.stdout.write(value));",
      ].join("\n"), "utf8");

      const started = await processStartTool.execute({ executable: "node", args: [scriptPath] });
      expect(started.ok).toBe(true);
      const sessionId = String(started.meta?.["sessionId"]);

      const sent = await processSendInputTool.execute({ sessionId, input: "ping\n" });
      expect(sent.ok).toBe(true);
      expect(sent.output).not.toContain("ping\n");

      const polled = await processPollTool.execute({ sessionId, waitMs: 200 });
      expect(polled.ok).toBe(true);
      expect(polled.rawOutput).toContain("ping");

      const stopped = await processStopTool.execute({ sessionId });
      expect(stopped.ok).toBe(true);
      expect(stopped.v2?.structuredContent).toMatchObject({ running: false });
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});
