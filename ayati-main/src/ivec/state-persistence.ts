import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { LoopState } from "./types.js";

export function initRunDirectory(dataDir: string, runId: string): string {
  const runPath = join(dataDir, "runs", runId);
  mkdirSync(join(runPath, "steps"), { recursive: true });
  return runPath;
}

export function writeJSON(runPath: string, filename: string, data: unknown): void {
  const filePath = join(runPath, filename);
  writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

export function readState(runPath: string): LoopState | null {
  const filePath = join(runPath, "state.json");
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as LoopState;
}
