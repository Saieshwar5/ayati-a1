import { access } from "node:fs/promises";
import type {
  GitMemoryRunId,
  GitMemorySessionId,
  GitMemorySessionMetaFile,
  GitMemoryTaskId,
} from "./schema.js";
import {
  gitMemorySessionStoreMetaPath,
  gitMemorySessionStoreSchemaPath,
  gitMemoryTaskDir,
} from "./schema.js";
import { prettyJson } from "./session-store-renderers.js";

export interface BuildInitialSessionFilesInput {
  sessionId: GitMemorySessionId;
  date: string;
  timezone: string;
  agentId: string;
  createdAt: string;
}

export function buildInitialSessionStoreFiles(input: BuildInitialSessionFilesInput): Record<string, string> {
  const meta: GitMemorySessionMetaFile = {
    schemaVersion: 1,
    sessionId: input.sessionId,
    date: input.date,
    timezone: input.timezone,
    createdAt: input.createdAt,
    repoKind: "daily_session",
    agentId: input.agentId,
  };
  return {
    [gitMemorySessionStoreMetaPath(input.sessionId)]: prettyJson(meta),
    [gitMemorySessionStoreSchemaPath(input.sessionId)]: prettyJson({
      schemaVersion: 1,
      kind: "git_memory_session",
      sourceOfTruth: "session_store",
      commitPolicy: "task_run_snapshot",
    }),
  };
}

export function legacyGitMemoryTaskEvidenceManifestPath(taskId: GitMemoryTaskId, runId: GitMemoryRunId): string {
  return `${gitMemoryTaskDir(taskId)}/evidence/${runId}/manifest.jsonl`;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function runIdFromActionPath(path: string): GitMemoryRunId {
  const fileName = path.split("/").pop() ?? "";
  return fileName.replace(/\.jsonl$/, "");
}

export function runIdFromRunMarkdownPath(path: string): GitMemoryRunId {
  const fileName = path.split("/").pop() ?? "";
  return fileName.replace(/\.md$/, "");
}

export function runIdFromRunPath(path: string): GitMemoryRunId {
  const fileName = path.split("/").pop() ?? "";
  return fileName.replace(/\.json$/, "");
}
