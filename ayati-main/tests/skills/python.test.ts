import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPythonSkill } from "../../src/skills/builtins/python/index.js";

function parseOutput(result: { ok: boolean; output?: string; error?: string }) {
  expect(result.output).toBeTruthy();
  return JSON.parse(String(result.output)) as Record<string, unknown>;
}

function createTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function createFakeInterpreter(dir: string): string {
  const interpreterPath = join(dir, "fake-python");
  writeFileSync(interpreterPath, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const scriptPath = process.argv[2] || "";
const source = scriptPath && fs.existsSync(scriptPath) ? fs.readFileSync(scriptPath, "utf8") : "";

if (process.env.AYATI_PYTHON_RESULT_PATH) {
  const requestPath = process.env.AYATI_PYTHON_REQUEST_PATH;
  const resultPath = process.env.AYATI_PYTHON_RESULT_PATH;
  const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
  const resolvedSource = request.path || (request.table ? request.dbPath + "::" + request.table : request.dbPath + "::query");
  fs.writeFileSync(resultPath, JSON.stringify({
    sourceType: request.sourceType,
    resolvedSource,
    rowCount: 3,
    columnCount: 2,
    columns: [{ name: "id", dtype: "int64", nullCount: 0 }],
    sampleRows: [{ id: 1, value: 10 }],
    numericSummary: { value: { count: 3, mean: 11 } },
    categoricalSummary: {},
    warnings: []
  }, null, 2));
  process.stdout.write("inspect-ok\\n");
  process.exit(0);
}

if (source.includes("TIMEOUT")) {
  setTimeout(() => {
    process.stdout.write("late\\n");
    process.exit(0);
  }, 1500);
  return;
}

if (source.includes("MAKE_ARTIFACT")) {
  fs.mkdirSync(process.env.AYATI_PYTHON_ARTIFACT_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.AYATI_PYTHON_ARTIFACT_DIR, "chart.txt"), "artifact");
}

if (source.includes("FAIL")) {
  process.stderr.write("requested failure\\n");
  process.exit(5);
}

process.stdout.write("python-ok\\n");
`);
  chmodSync(interpreterPath, 0o755);
  return interpreterPath;
}

function getTool(name: string, interpreterPath: string, dataDir: string) {
  const skill = createPythonSkill({
    dataDir,
    interpreterPath,
    defaultCwd: dataDir,
  });
  const tool = skill.tools.find((entry) => entry.name === name);
  if (!tool) {
    throw new Error(`Missing tool: ${name}`);
  }
  return tool;
}

describe("python skill", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("inspects a dataset with the managed interpreter and writes result artifacts", async () => {
    const dataDir = createTempDir("ayati-python-data-");
    tempDirs.push(dataDir);
    const interpreterDir = createTempDir("ayati-python-bin-");
    tempDirs.push(interpreterDir);
    const interpreterPath = createFakeInterpreter(interpreterDir);
    const csvPath = join(dataDir, "sales.csv");
    writeFileSync(csvPath, "id,value\n1,10\n2,11\n3,12\n");

    const tool = getTool("python_inspect_dataset", interpreterPath, dataDir);
    const result = await tool.execute({
      sourceType: "path",
      path: csvPath,
      sampleRows: 2,
    }, {
      clientId: "local",
      runId: "run-inspect",
      sessionId: "session-1",
    });

    expect(result.ok).toBe(true);
    const output = parseOutput(result);
    expect(output["sourceType"]).toBe("path");
    expect(output["resolvedSource"]).toBe(csvPath);
    expect(output["runtime"]).toEqual(expect.objectContaining({ interpreter: interpreterPath }));

    const artifacts = output["artifacts"] as Record<string, unknown>;
    expect(typeof artifacts["resultPath"]).toBe("string");
    expect(existsSync(String(artifacts["resultPath"]))).toBe(true);
    expect(existsSync(String(artifacts["manifestPath"]))).toBe(true);
  });

  it("executes inline code with the managed interpreter and captures generated artifacts", async () => {
    const dataDir = createTempDir("ayati-python-data-");
    tempDirs.push(dataDir);
    const interpreterDir = createTempDir("ayati-python-bin-");
    tempDirs.push(interpreterDir);
    const interpreterPath = createFakeInterpreter(interpreterDir);

    const tool = getTool("python_execute", interpreterPath, dataDir);
    const result = await tool.execute({
      mode: "code",
      code: "# MAKE_ARTIFACT\nprint('hello from managed python')",
    }, {
      clientId: "local",
      runId: "run-execute",
      sessionId: "session-2",
    });

    expect(result.ok).toBe(true);
    const output = parseOutput(result);
    expect(output["stdoutPreview"]).toBe("python-ok\n");
    const artifactPaths = output["artifacts"] as string[];
    expect(Array.isArray(artifactPaths)).toBe(true);
    expect(artifactPaths.some((entry) => entry.endsWith("chart.txt"))).toBe(true);
    const files = output["files"] as Record<string, unknown>;
    expect(existsSync(String(files["manifestPath"]))).toBe(true);
  });

  it("fails closed when the managed interpreter is missing", async () => {
    const dataDir = createTempDir("ayati-python-data-");
    tempDirs.push(dataDir);
    const missingInterpreter = join(dataDir, "missing-python");

    const tool = getTool("python_execute", missingInterpreter, dataDir);
    const result = await tool.execute({
      mode: "code",
      code: "print('hello')",
    }, {
      runId: "run-missing",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Managed Python interpreter not found");
  });

  it("enforces timeouts for long-running Python code", async () => {
    const dataDir = createTempDir("ayati-python-data-");
    tempDirs.push(dataDir);
    const interpreterDir = createTempDir("ayati-python-bin-");
    tempDirs.push(interpreterDir);
    const interpreterPath = createFakeInterpreter(interpreterDir);

    const tool = getTool("python_execute", interpreterPath, dataDir);
    const result = await tool.execute({
      mode: "code",
      code: "# TIMEOUT\nprint('waiting')",
      timeoutMs: 100,
    }, {
      runId: "run-timeout",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("timed out");
    const output = parseOutput(result);
    expect(output["timedOut"]).toBe(true);
  });

  it("documents the managed interpreter policy in the prompt block", () => {
    const dataDir = createTempDir("ayati-python-data-");
    tempDirs.push(dataDir);
    const skill = createPythonSkill({ dataDir, interpreterPath: "/tmp/fake-python" });
    expect(skill.promptBlock).toContain("python_inspect_dataset");
    expect(skill.promptBlock).toContain("python_execute");
    expect(skill.promptBlock).toContain("Do not use bare python");
  });
});
