import { mkdtemp, readFile, rm, stat, writeFile as writeNodeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { calculatorTool } from "../../src/skills/builtins/calculator/index.js";
import databaseSkill from "../../src/skills/builtins/database/index.js";
import { createDirectoryTool } from "../../src/skills/builtins/filesystem/create-directory.js";
import { deleteTool } from "../../src/skills/builtins/filesystem/delete.js";
import { moveTool } from "../../src/skills/builtins/filesystem/move.js";
import { patchFilesTool } from "../../src/skills/builtins/filesystem/patch-files.js";
import { readFilesTool } from "../../src/skills/builtins/filesystem/read-files.js";
import { writeFilesTool } from "../../src/skills/builtins/filesystem/write-files.js";
import { pulseTool } from "../../src/skills/builtins/pulse/index.js";
import {
  shellExecTool,
  shellRunScriptTool,
  shellSessionCloseTool,
  shellSessionStartTool,
  shellSessionWriteTool,
} from "../../src/skills/builtins/shell/index.js";
import { createToolExecutor } from "../../src/skills/tool-executor.js";

describe("static built-in tool contracts", () => {
  let tmp: string;
  let previousPulsePath: string | undefined;
  let previousPulseTimezone: string | undefined;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "ayati-static-contracts-"));
    previousPulsePath = process.env["PULSE_STORE_FILE_PATH"];
    previousPulseTimezone = process.env["PULSE_TIMEZONE"];
    process.env["PULSE_STORE_FILE_PATH"] = join(tmp, "pulse.sqlite");
    process.env["PULSE_TIMEZONE"] = "UTC";
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (previousPulsePath === undefined) {
      delete process.env["PULSE_STORE_FILE_PATH"];
    } else {
      process.env["PULSE_STORE_FILE_PATH"] = previousPulsePath;
    }
    if (previousPulseTimezone === undefined) {
      delete process.env["PULSE_TIMEZONE"];
    } else {
      process.env["PULSE_TIMEZONE"] = previousPulseTimezone;
    }
    await rm(tmp, { recursive: true, force: true });
  });

  it("verifies filesystem read/write/edit/move/delete contracts", async () => {
    const executor = createToolExecutor([
      createDirectoryTool,
      writeFilesTool,
      readFilesTool,
      patchFilesTool,
      moveTool,
      deleteTool,
    ]);
    const dir = join(tmp, "nested");
    const source = join(dir, "source.txt");
    const destination = join(dir, "destination.txt");

    const created = await executor.execute("create_directory", {
      path: dir,
      allowExternalPath: true,
    });
    expect(created.ok).toBe(true);
    expect(created.v2?.verification?.status).toBe("passed");
    expect((await stat(dir)).isDirectory()).toBe(true);

    const written = await executor.execute("write_files", {
      files: [{ path: source, content: "alpha beta" }],
      allowExternalPath: true,
    });
    expect(written.ok).toBe(true);
    expect(written.v2?.code).toBe("FILES_WRITTEN");
    expect(written.v2?.verification?.assertions.map((assertion) => assertion.id)).toEqual([
      "operation_succeeded",
      "files_written_matches_request",
      "written_paths_exist",
      "written_hashes_match",
    ]);

    const read = await executor.execute("read_files", {
      files: [{ path: source }],
    });
    expect(read.ok).toBe(true);
    expect(read.v2?.verification?.status).toBe("passed");
    expect(read.v2?.structuredContent).toMatchObject({
      results: [
        { requestedPath: source, ok: true, content: "alpha beta" },
      ],
    });

    const batchRead = await executor.execute("read_files", {
      files: [{ path: source }, { path: source, mode: "search", query: "beta" }],
    });
    expect(batchRead.ok).toBe(true);
    expect(batchRead.v2?.verification?.status).toBe("passed");
    expect(batchRead.v2?.structuredContent).toMatchObject({
      summary: {
        requested: 2,
        succeeded: 2,
      },
    });

    const batchEdited = await executor.execute("patch_files", {
      allowExternalPath: true,
      files: [{
        path: source,
        patches: [
          { kind: "replace_text", find: "beta", replace: "gamma" },
          { kind: "replace_text", find: "alpha", replace: "omega" },
        ],
      }],
    });
    expect(batchEdited.ok).toBe(true);
    expect(batchEdited.v2?.verification?.status).toBe("passed");
    expect(await readFile(source, "utf-8")).toBe("omega gamma");

    const patched = await executor.execute("patch_files", {
      allowExternalPath: true,
      files: [{
        path: source,
        patches: [{ kind: "replace_text", find: "omega", replace: "alpha" }],
      }],
    });
    expect(patched.ok).toBe(true);
    expect(patched.v2?.verification?.status).toBe("passed");
    expect(await readFile(source, "utf-8")).toBe("alpha gamma");

    const moved = await executor.execute("move", {
      source,
      destination,
      allowExternalPath: true,
    });
    expect(moved.ok).toBe(true);
    expect(moved.v2?.verification?.status).toBe("passed");
    expect(await readFile(destination, "utf-8")).toBe("alpha gamma");

    const deleted = await executor.execute("delete", {
      path: destination,
      allowExternalPath: true,
    });
    expect(deleted.ok).toBe(true);
    expect(deleted.v2?.verification?.status).toBe("passed");
    await expect(stat(destination)).rejects.toThrow();
  });

  it("verifies shell command, shell script, and shell session contracts", async () => {
    const executor = createToolExecutor([
      shellExecTool,
      shellRunScriptTool,
      shellSessionStartTool,
      shellSessionWriteTool,
      shellSessionCloseTool,
    ]);
    const shell = await executor.execute("shell", {
      cmd: "printf contract-ok",
      cwd: tmp,
    });
    expect(shell.ok).toBe(true);
    expect(shell.v2?.verification?.status).toBe("passed");
    expect(shell.v2?.structuredContent).toMatchObject({ exitCode: 0, timedOut: false });

    const scriptPath = join(tmp, "script.sh");
    await writeNodeFile(scriptPath, "printf script-ok\n", "utf-8");
    const script = await executor.execute("shell_run_script", { scriptPath, cwd: tmp });
    expect(script.ok).toBe(true);
    expect(script.v2?.verification?.status).toBe("passed");
    expect(script.output).toContain("script-ok");

    const started = await executor.execute("shell_session_start", { cmd: "cat", waitMs: 20 });
    expect(started.ok).toBe(true);
    expect(started.v2?.verification?.status).toBe("passed");
    const sessionId = String(started.meta?.["sessionId"]);
    const wrote = await executor.execute("shell_session_write", { sessionId, input: "ping\n", waitMs: 100 });
    expect(wrote.ok).toBe(true);
    expect(wrote.v2?.verification?.status).toBe("passed");
    expect(wrote.output).toContain("ping");
    const closed = await executor.execute("shell_session_close", { sessionId });
    expect(closed.ok).toBe(true);
    expect(closed.v2?.verification?.status).toBe("passed");
  });

  it("verifies calculator, database, and pulse contracts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T12:00:00.000Z"));

    const calculatorExecutor = createToolExecutor([calculatorTool]);
    const calculated = await calculatorExecutor.execute("calculator", { expression: "sqrt(3^2 + 4^2)" });
    expect(calculated.ok).toBe(true);
    expect(calculated.v2?.verification?.status).toBe("passed");
    expect(calculated.v2?.structuredContent).toMatchObject({ result: "5" });

    const dbExecutor = createToolExecutor(databaseSkill.tools);
    const dbPath = join(tmp, "agent.sqlite");
    const createdTable = await dbExecutor.execute("db_create_table", {
      dbPath,
      table: "tasks",
      columns: [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "title", type: "TEXT", notNull: true },
      ],
    });
    expect(createdTable.ok).toBe(true);
    expect(createdTable.v2?.verification?.status).toBe("passed");
    expect(createdTable.v2?.artifacts?.some((artifact) => artifact.kind === "table" && artifact.id === "tasks")).toBe(true);

    const inserted = await dbExecutor.execute("db_insert_rows", {
      dbPath,
      table: "tasks",
      rows: [{ id: 1, title: "contract test" }],
    });
    expect(inserted.ok).toBe(true);
    expect(inserted.v2?.verification?.status).toBe("passed");
    expect(inserted.v2?.structuredContent).toMatchObject({ insertedRowCount: 1 });

    const queried = await dbExecutor.execute("db_query", {
      dbPath,
      table: "tasks",
    });
    expect(queried.ok).toBe(true);
    expect(queried.v2?.verification?.status).toBe("passed");
    expect(queried.v2?.structuredContent).toMatchObject({ rowCount: 1 });

    const pulseExecutor = createToolExecutor([pulseTool]);
    const createdPulse = await pulseExecutor.execute(
      "pulse",
      {
        action: "create",
        instruction: "Check contract state",
        every: "every one hour",
        timezone: "UTC",
      },
      { clientId: "contract-client", runId: "run-1", sessionId: "session-1" },
    );
    expect(createdPulse.ok).toBe(true);
    expect(createdPulse.v2?.verification?.status).toBe("passed");
    expect(createdPulse.v2?.code).toBe("PULSE_CREATE_SUCCEEDED");
    expect(createdPulse.v2?.artifacts?.some((artifact) => artifact.label === "pulse_item")).toBe(true);
  });
});
