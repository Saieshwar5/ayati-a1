import type { ActionId, AssetId, RunId, SessionId, WorkId } from "./ids.js";
import { isActionId, isRunId, isWorkId } from "./ids.js";

export type TaskStatus = "active" | "paused" | "blocked" | "done" | "failed";
export type TaskAssetRole = "input" | "output" | "generated" | "reference";

export interface TaskFile {
  schemaVersion: 1;
  workId: WorkId;
  sessionId: SessionId;
  title: string;
  objective: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
}

export interface TaskFact {
  text: string;
  source: string;
}

export interface TaskStateFile {
  schemaVersion: 1;
  workId: WorkId;
  status: TaskStatus;
  completed: string[];
  open: string[];
  blockers?: string[];
  facts: TaskFact[];
  decisions?: string[];
  assumptions?: string[];
  next?: string;
}

export interface TaskAssetRecord {
  assetId: AssetId;
  role: TaskAssetRole;
  kind: string;
  name: string;
  sessionAssetId?: AssetId;
  path?: string;
}

export interface TaskRunSummaryFile {
  schemaVersion: 1;
  runId: RunId;
  workId: WorkId;
  status: "completed" | "failed" | "blocked" | "needs_user_input";
  summary: string;
  completed: string[];
  open: string[];
  actions: ActionId[];
  createdAt: string;
}

export interface TaskOutputFile {
  schemaVersion: 1;
  runId: RunId;
  workId: WorkId;
  kind: "final" | "intermediate";
  content: unknown;
  createdAt: string;
}

export function taskDirectory(workId: WorkId): string {
  assertWorkId(workId);
  return `tasks/${workId}`;
}

export function taskFilePath(workId: WorkId): string {
  return `${taskDirectory(workId)}/task.json`;
}

export function taskStatePath(workId: WorkId): string {
  return `${taskDirectory(workId)}/state.json`;
}

export function taskAssetsPath(workId: WorkId): string {
  return `${taskDirectory(workId)}/assets.jsonl`;
}

export function taskActionsDirectory(workId: WorkId, runId: RunId): string {
  assertWorkId(workId);
  assertRunId(runId);
  return `${taskDirectory(workId)}/actions/${runId}`;
}

export function taskActionFilePath(workId: WorkId, runId: RunId, actionId: ActionId): string {
  assertActionId(actionId);
  return `${taskActionsDirectory(workId, runId)}/${actionId}.json`;
}

export function taskActionOutputPath(workId: WorkId, runId: RunId, actionId: ActionId, extension = "txt"): string {
  assertActionId(actionId);
  return `${taskActionsDirectory(workId, runId)}/${actionId}-output.${extension}`;
}

export function taskRunSummaryPath(workId: WorkId, runId: RunId): string {
  assertWorkId(workId);
  assertRunId(runId);
  return `${taskDirectory(workId)}/summaries/${runId}.json`;
}

export function taskFinalOutputPath(workId: WorkId): string {
  return `${taskDirectory(workId)}/outputs/final.json`;
}

function assertWorkId(workId: WorkId): void {
  if (!isWorkId(workId)) {
    throw new Error(`Invalid work id: ${workId}`);
  }
}

function assertRunId(runId: RunId): void {
  if (!isRunId(runId)) {
    throw new Error(`Invalid run id: ${runId}`);
  }
}

function assertActionId(actionId: ActionId): void {
  if (!isActionId(actionId)) {
    throw new Error(`Invalid action id: ${actionId}`);
  }
}
