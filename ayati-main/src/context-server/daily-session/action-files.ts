import type { ActionId, RunId, WorkId } from "./ids.js";

export type ToolActionStatus = "success" | "failed" | "skipped";

export interface ToolActionFile {
  schemaVersion: 1;
  actionId: ActionId;
  runId: RunId;
  workId: WorkId;
  tool: string;
  input: unknown;
  status: ToolActionStatus;
  summary: string;
  outputRef?: string;
  error?: string;
  createdAt: string;
}

export interface RunActionResultFile {
  schemaVersion: 1;
  runId: RunId;
  workId: WorkId;
  status: "completed" | "failed" | "blocked" | "needs_user_input";
  summary: string;
  actions: ActionId[];
  createdAt: string;
}
