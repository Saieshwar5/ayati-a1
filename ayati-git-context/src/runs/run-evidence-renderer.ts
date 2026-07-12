import { createHash } from "node:crypto";
import type {
  RunEvidenceRecord,
  RunStepEvidenceRecord,
} from "../repositories/run-records.js";
import type { TaskRunOutcome } from "../contracts.js";

const MAX_STRING_LENGTH = 4_096;
const MAX_ARRAY_ITEMS = 100;
const MAX_OBJECT_KEYS = 100;
const MAX_DEPTH = 6;
const MAX_STEP_BYTES = 32 * 1_024;

export function renderRunEvidence(input: {
  run: RunEvidenceRecord;
  taskHeadBefore: string;
  taskHeadAfter: string;
  stepCount: number;
  snapshotAt: string;
  final?: {
    outcome: TaskRunOutcome;
    summary: string;
    validation: "passed" | "failed" | "not_run";
    next?: string;
    completion?: unknown;
    completedAt: string;
  };
}): string {
  return JSON.stringify({
    schemaVersion: 1,
    runId: input.run.runId,
    sessionId: input.run.sessionId,
    taskId: input.run.taskId,
    conversationId: input.run.conversationId,
    runClass: input.run.runClass,
    trigger: input.run.trigger,
    status: input.final ? terminalRunStatus(input.final.outcome) : input.run.status,
    startedAt: input.run.startedAt,
    completedAt: input.final?.completedAt ?? input.run.completedAt ?? null,
    outcome: input.final?.outcome ?? null,
    summary: input.final?.summary ?? null,
    validation: input.final?.validation ?? null,
    next: input.final?.next ?? null,
    completion: input.final?.completion === undefined
      ? null
      : compactValue(input.final.completion, 0),
    taskHeadBefore: input.taskHeadBefore,
    taskHeadAfter: input.taskHeadAfter,
    stepCount: input.stepCount,
    evidenceSnapshotAt: input.snapshotAt,
  }, null, 2) + "\n";
}

function terminalRunStatus(outcome: TaskRunOutcome): string {
  if (outcome === "failed") return "failed";
  if (outcome === "blocked") return "blocked";
  if (outcome === "needs_user_input") return "needs_user_input";
  return "completed";
}

export function renderStepEvidence(steps: RunStepEvidenceRecord[]): string {
  if (steps.length === 0) {
    return "";
  }
  return steps.map((step) => boundedStepLine(step)).join("\n") + "\n";
}

export function evidenceSourceRevision(input: {
  run: RunEvidenceRecord;
  steps: RunStepEvidenceRecord[];
  taskHeadBefore: string;
  taskHeadAfter: string;
}): string {
  return "sha256:" + createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function boundedStepLine(step: RunStepEvidenceRecord): string {
  const compacted = {
    step: step.step,
    tool: step.tool,
    purpose: boundedString(step.purpose),
    status: step.status,
    createdAt: step.createdAt,
    ...(step.boundedInput === undefined
      ? {}
      : { input: compactValue(step.boundedInput, 0) }),
    ...(step.boundedOutput === undefined
      ? {}
      : { output: compactValue(step.boundedOutput, 0) }),
    ...(step.outputHash ? { outputHash: step.outputHash } : {}),
    ...(step.verification === undefined
      ? {}
      : { verification: compactValue(step.verification, 0) }),
    ...(step.workState === undefined
      ? {}
      : { workState: compactValue(step.workState, 0) }),
  };
  const json = JSON.stringify(compacted);
  if (Buffer.byteLength(json) <= MAX_STEP_BYTES) {
    return json;
  }
  return JSON.stringify({
    step: step.step,
    tool: step.tool,
    purpose: boundedString(step.purpose),
    status: step.status,
    createdAt: step.createdAt,
    evidenceOmitted: {
      reason: "step_exceeded_32_kib",
      sha256: createHash("sha256").update(json).digest("hex"),
      bytes: Buffer.byteLength(json),
    },
    ...(step.outputHash ? { outputHash: step.outputHash } : {}),
  });
}

function compactValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return boundedString(value);
  }
  if (depth >= MAX_DEPTH) {
    return { omitted: "maximum_depth" };
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => compactValue(item, depth + 1));
  }
  if (typeof value !== "object") {
    return String(value);
  }
  const source = value as Record<string, unknown>;
  const hasFileIdentity = ["path", "file", "filePath", "name"]
    .some((key) => typeof source[key] === "string");
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort().slice(0, MAX_OBJECT_KEYS)) {
    const item = source[key];
    if (hasFileIdentity && isContentKey(key) && typeof item === "string") {
      output[key] = omittedFileContent(item);
    } else {
      output[key] = compactValue(item, depth + 1);
    }
  }
  return output;
}

function boundedString(value: string): string | { truncated: string; bytes: number; sha256: string } {
  if (value.length <= MAX_STRING_LENGTH) {
    return value;
  }
  return {
    truncated: value.slice(0, MAX_STRING_LENGTH),
    bytes: Buffer.byteLength(value),
    sha256: createHash("sha256").update(value).digest("hex"),
  };
}

function omittedFileContent(value: string): {
  omitted: string;
  bytes: number;
  sha256: string;
} {
  return {
    omitted: "content_stored_in_task_git",
    bytes: Buffer.byteLength(value),
    sha256: createHash("sha256").update(value).digest("hex"),
  };
}

function isContentKey(key: string): boolean {
  return ["content", "contents", "text", "data", "body"].includes(key.toLowerCase());
}
