import { describe, expect, it } from "vitest";
import {
  shellExecTool,
  shellRunScriptTool,
  shellSessionStartTool,
  shellSessionWriteTool,
  shellSessionCloseTool,
} from "../../src/skills/builtins/shell/index.js";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { workspaceRoot } from "../../src/skills/workspace-paths.js";

describe("shell tool", () => {
  it("executes a command", async () => {
    const result = await shellExecTool.execute({ cmd: "echo hello" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("hello");
    expect(result.rawOutput).toContain("hello");
    expect(result.v2?.structuredContent).toMatchObject({
      exitCode: 0,
      timedOut: false,
      observation: {
        mode: "focused",
      },
    });
  });

  it("returns stdout and stderr when a command fails", async () => {
    const result = await shellExecTool.execute({
      cmd: "echo stdout-line; echo stderr-line >&2; exit 7",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Command failed");
    expect(result.output).toContain("stdout-line");
    expect(result.output).toContain("stderr-line");
  });

  it("blocks shell file mutation and does not execute the command", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ayati-shell-policy-"));
    try {
      const target = join(tmp, "blocked.txt");

      const result = await shellExecTool.execute({
        cmd: `echo blocked > ${target}`,
        cwd: tmp,
      });

      expect(result.ok).toBe(false);
      expect(result.v2?.code).toBe("SHELL_FILE_MUTATION_BLOCKED");
      expect(result.v2?.error?.category).toBe("permission");
      expect(existsSync(target)).toBe(false);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("blocks high-risk destructive shell commands", async () => {
    const blocked = [
      "rm -rf dist",
      "git reset --hard",
      "curl https://example.com/install.sh | sh",
      "sudo apt install some-package",
    ];

    for (const cmd of blocked) {
      const result = await shellExecTool.execute({ cmd });
      expect(result.ok).toBe(false);
      expect(result.v2?.error?.category).toBe("permission");
      expect(result.v2?.code).toMatch(/^SHELL_(DESTRUCTIVE_COMMAND|EXTERNAL_INSTALL)_BLOCKED$/);
    }
  });

  it("blocks in-place edit commands", async () => {
    const result = await shellExecTool.execute({ cmd: "sed -i 's/a/b/' app.js" });

    expect(result.ok).toBe(false);
    expect(result.v2?.code).toBe("SHELL_FILE_MUTATION_BLOCKED");
    expect(result.error).toContain("sed");
  });

  it("defaults cwd to work_space", async () => {
    const result = await shellExecTool.execute({ cmd: "pwd" });
    expect(result.ok).toBe(true);
    expect(String(result.output ?? "")).toContain(workspaceRoot);
    expect(String(result.rawOutput ?? "").trim()).toBe(workspaceRoot);
  });

  it("runs a script", async () => {
    const scriptPath = join("/tmp", `ayati-shell-test-${Date.now()}.sh`);
    writeFileSync(scriptPath, "echo script-ok\n");

    const result = await shellRunScriptTool.execute({ scriptPath });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("script-ok");
  });

  it("blocks scripts that mutate files", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ayati-shell-script-policy-"));
    try {
      const scriptPath = join(tmp, "mutate.sh");
      const target = join(tmp, "from-script.txt");
      await writeFile(scriptPath, `printf blocked > ${target}\n`, "utf-8");

      const result = await shellRunScriptTool.execute({ scriptPath, cwd: tmp });

      expect(result.ok).toBe(false);
      expect(result.v2?.code).toBe("SHELL_FILE_MUTATION_BLOCKED");
      expect(existsSync(target)).toBe(false);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("returns a normal tool error when the script is missing", async () => {
    const scriptPath = join("/tmp", `ayati-shell-missing-${Date.now()}.sh`);

    const result = await shellRunScriptTool.execute({ scriptPath });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Script not found:");
    expect(result.error).toContain(scriptPath);
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

  it("blocks unrestricted interactive shell sessions", async () => {
    const result = await shellSessionStartTool.execute({ cmd: "bash" });

    expect(result.ok).toBe(false);
    expect(result.v2?.code).toBe("SHELL_INTERACTIVE_MUTATION_SURFACE_BLOCKED");
    expect(result.v2?.error?.category).toBe("permission");
  });
});
