import { access, readFile, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { spawn } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import type { ToolExecutionContext } from "../../types.js";
import { workspaceRoot, resolveWorkspaceCwd } from "../../workspace-paths.js";
import {
  createPythonArtifactPaths,
  listFilesRecursive,
  toRelativeArtifactPath,
  writePythonManifest,
  type PythonArtifactPaths,
} from "./artifacts.js";

export const DEFAULT_MANAGED_PYTHON_INTERPRETER = "/home/sai-eshwar/python-virtual-interpretor/.venv/bin/python";
export const DEFAULT_PYTHON_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_OUTPUT_CHARS = 100_000;

export interface PythonSkillRuntimeDeps {
  dataDir: string;
  interpreterPath?: string;
  defaultCwd?: string;
}

export interface PythonSpawnResult {
  ok: boolean;
  error?: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdoutPreview: string;
  stderrPreview: string;
  durationMs: number;
  interpreter: string;
  timedOut: boolean;
  outputTruncated: boolean;
  cwd: string;
}

function appendCapped(current: string, incoming: string, cap: number): { value: string; truncated: boolean } {
  if (incoming.length === 0) {
    return { value: current, truncated: false };
  }
  const combined = current + incoming;
  if (combined.length <= cap) {
    return { value: combined, truncated: false };
  }
  return {
    value: `${combined.slice(0, cap)}\n...[truncated]`,
    truncated: true,
  };
}

function sanitizeEnvList(values: string[] | undefined): string {
  return JSON.stringify(values ?? []);
}

export function resolveManagedPythonInterpreter(deps: PythonSkillRuntimeDeps): string {
  const envOverride = process.env["AYATI_PYTHON_INTERPRETER"]?.trim();
  return envOverride || deps.interpreterPath || DEFAULT_MANAGED_PYTHON_INTERPRETER;
}

export async function ensureManagedPythonInterpreter(interpreterPath: string): Promise<void> {
  const resolved = resolvePath(interpreterPath);
  const info = await stat(resolved).catch(() => null);
  if (!info || !info.isFile()) {
    throw new Error(`Managed Python interpreter not found: ${resolved}`);
  }
  await access(resolved, fsConstants.X_OK).catch(() => {
    throw new Error(`Managed Python interpreter is not executable: ${resolved}`);
  });
}

export async function allocatePythonArtifacts(
  deps: PythonSkillRuntimeDeps,
  context?: ToolExecutionContext,
): Promise<PythonArtifactPaths> {
  return await createPythonArtifactPaths(deps.dataDir, context?.runId);
}

export function resolvePythonCwd(deps: PythonSkillRuntimeDeps, cwd?: string): string {
  if (!cwd || cwd.trim().length === 0) {
    return deps.defaultCwd ?? workspaceRoot;
  }
  return resolveWorkspaceCwd(cwd);
}

export async function writePythonRequest(requestPath: string, payload: Record<string, unknown>): Promise<void> {
  await writeFile(requestPath, JSON.stringify(payload, null, 2), "utf-8");
}

export async function writePythonScript(scriptPath: string, content: string): Promise<void> {
  await writeFile(scriptPath, content, "utf-8");
}

export async function readPythonJsonResult(resultPath: string): Promise<Record<string, unknown>> {
  const raw = await readFile(resultPath, "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}

export async function runManagedPythonProcess(input: {
  deps: PythonSkillRuntimeDeps;
  context?: ToolExecutionContext;
  artifacts: PythonArtifactPaths;
  scriptPath: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  maxOutputChars?: number;
  extraEnv?: Record<string, string>;
}): Promise<PythonSpawnResult> {
  const interpreter = resolveManagedPythonInterpreter(input.deps);
  await ensureManagedPythonInterpreter(interpreter);

  const timeoutMs = Math.max(1, Math.min(input.timeoutMs ?? DEFAULT_PYTHON_TIMEOUT_MS, DEFAULT_PYTHON_TIMEOUT_MS));
  const maxOutputChars = Math.max(1, Math.min(input.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS, DEFAULT_MAX_OUTPUT_CHARS));
  const cwd = resolvePythonCwd(input.deps, input.cwd);
  const start = Date.now();

  return await new Promise<PythonSpawnResult>((resolveResult) => {
    const child = spawn(interpreter, [input.scriptPath, ...(input.args ?? [])], {
      cwd,
      env: {
        ...process.env,
        AYATI_PYTHON_RUN_ID: input.context?.runId ?? "",
        AYATI_PYTHON_SESSION_ID: input.context?.sessionId ?? "",
        AYATI_PYTHON_CLIENT_ID: input.context?.clientId ?? "",
        AYATI_PYTHON_RUN_DIR: input.artifacts.runDir,
        AYATI_PYTHON_ARTIFACT_DIR: input.artifacts.artifactsDir,
        AYATI_PYTHON_REQUEST_PATH: input.artifacts.requestPath,
        ...(input.extraEnv ?? {}),
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdoutPreview = "";
    let stderrPreview = "";
    let outputTruncated = false;
    let timedOut = false;
    let settled = false;

    const finish = async (result: Omit<PythonSpawnResult, "durationMs">): Promise<void> => {
      if (settled) return;
      settled = true;
      await Promise.all([
        writeFile(input.artifacts.stdoutPath, stdoutPreview, "utf-8"),
        writeFile(input.artifacts.stderrPath, stderrPreview, "utf-8"),
      ]);
      resolveResult({
        ...result,
        durationMs: Date.now() - start,
      });
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => {
      const next = appendCapped(stdoutPreview, chunk.toString(), maxOutputChars);
      stdoutPreview = next.value;
      outputTruncated = outputTruncated || next.truncated;
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      const next = appendCapped(stderrPreview, chunk.toString(), maxOutputChars);
      stderrPreview = next.value;
      outputTruncated = outputTruncated || next.truncated;
    });

    child.on("error", async (err: Error) => {
      clearTimeout(timeout);
      await finish({
        ok: false,
        error: err.message,
        exitCode: null,
        signal: null,
        stdoutPreview,
        stderrPreview,
        interpreter,
        timedOut,
        outputTruncated,
        cwd,
      });
    });

    child.on("close", async (code, signal) => {
      clearTimeout(timeout);
      await finish({
        ok: !timedOut && code === 0,
        error: timedOut ? "Python execution timed out and was terminated." : code === 0 ? undefined : `Python exited with code ${code ?? "unknown"}.`,
        exitCode: code,
        signal,
        stdoutPreview,
        stderrPreview,
        interpreter,
        timedOut,
        outputTruncated,
        cwd,
      });
    });
  });
}

export async function collectArtifactPaths(
  deps: PythonSkillRuntimeDeps,
  artifacts: PythonArtifactPaths,
): Promise<string[]> {
  const files = await listFilesRecursive(artifacts.artifactsDir);
  return files.map((filePath) => toRelativeArtifactPath(deps.dataDir, filePath));
}

export { toRelativeArtifactPath };

export async function writeExecutionManifest(input: {
  artifacts: PythonArtifactPaths;
  runtime: PythonSpawnResult;
  relativeArtifacts: string[];
  request: Record<string, unknown>;
}): Promise<void> {
  await writePythonManifest(input.artifacts.manifestPath, {
    request: input.request,
    runtime: {
      ok: input.runtime.ok,
      error: input.runtime.error ?? null,
      exitCode: input.runtime.exitCode,
      signal: input.runtime.signal,
      durationMs: input.runtime.durationMs,
      interpreter: input.runtime.interpreter,
      timedOut: input.runtime.timedOut,
      outputTruncated: input.runtime.outputTruncated,
      cwd: input.runtime.cwd,
    },
    files: {
      requestPath: input.artifacts.requestPath,
      resultPath: input.artifacts.resultPath,
      stdoutPath: input.artifacts.stdoutPath,
      stderrPath: input.artifacts.stderrPath,
      entryPath: input.artifacts.entryPath,
      helperPath: input.artifacts.helperPath,
      manifestPath: input.artifacts.manifestPath,
    },
    artifacts: input.relativeArtifacts,
  });
}

export function buildPythonExecutionEnvironment(inputFiles?: string[], sqliteDbPaths?: string[]): Record<string, string> {
  return {
    AYATI_PYTHON_INPUT_FILES: sanitizeEnvList(inputFiles),
    AYATI_PYTHON_SQLITE_DB_PATHS: sanitizeEnvList(sqliteDbPaths),
  };
}
