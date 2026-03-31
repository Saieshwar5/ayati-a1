import { mkdir, readdir, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export interface PythonArtifactPaths {
  execId: string;
  runDir: string;
  artifactsDir: string;
  requestPath: string;
  resultPath: string;
  stdoutPath: string;
  stderrPath: string;
  entryPath: string;
  helperPath: string;
  manifestPath: string;
}

export async function createPythonArtifactPaths(dataDir: string, runId?: string): Promise<PythonArtifactPaths> {
  const execId = randomUUID();
  const runDir = runId
    ? resolve(dataDir, "runs", runId, "python", execId)
    : resolve(dataDir, "python", "adhoc", execId);
  const artifactsDir = resolve(runDir, "artifacts");

  await mkdir(artifactsDir, { recursive: true });

  return {
    execId,
    runDir,
    artifactsDir,
    requestPath: resolve(runDir, "request.json"),
    resultPath: resolve(runDir, "result.json"),
    stdoutPath: resolve(runDir, "stdout.txt"),
    stderrPath: resolve(runDir, "stderr.txt"),
    entryPath: resolve(runDir, "entry.py"),
    helperPath: resolve(runDir, "helper.py"),
    manifestPath: resolve(runDir, "manifest.json"),
  };
}

export async function writePythonManifest(
  manifestPath: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await writeFile(manifestPath, JSON.stringify(payload, null, 2), "utf-8");
}

export async function listFilesRecursive(rootDir: string): Promise<string[]> {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const results: string[] = [];

  for (const entry of entries) {
    const fullPath = resolve(rootDir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await listFilesRecursive(fullPath));
      continue;
    }
    if (entry.isFile()) {
      results.push(fullPath);
    }
  }

  return results.sort();
}

export function toRelativeArtifactPath(baseDir: string, targetPath: string): string {
  return relative(baseDir, targetPath) || ".";
}
