import type { RunWorkState } from "../contracts.js";
import type {
  RunEvidenceRecord,
  RunStepEvidenceRecord,
} from "../repositories/run-records.js";

export function renderCompletedSessionRun(input: {
  run: RunEvidenceRecord;
  workState: RunWorkState;
  completedAt: string;
}): string {
  return JSON.stringify({
    schemaVersion: 1,
    runId: input.run.runId,
    sessionId: input.run.sessionId,
    conversationId: input.run.conversationId,
    runClass: "session",
    trigger: input.run.trigger,
    status: "completed",
    startedAt: input.run.startedAt,
    completedAt: input.completedAt,
    stepCount: input.run.stepCount,
    workState: input.workState,
  }, null, 2) + "\n";
}

export function renderCompleteSessionRunSteps(steps: RunStepEvidenceRecord[]): string {
  if (steps.length === 0) return "";
  return steps.map((step) => JSON.stringify({
    step: step.step,
    tool: step.tool,
    toolSchemaVersion: step.toolSchemaVersion,
    toolEffect: step.toolEffect,
    purpose: step.purpose,
    status: step.status,
    ...(step.input === undefined ? {} : { input: step.input }),
    ...(step.output === undefined ? {} : { output: step.output }),
    ...(step.outputHash ? { outputHash: step.outputHash } : {}),
    ...(step.verification === undefined ? {} : { verification: step.verification }),
    createdAt: step.createdAt,
  })).join("\n") + "\n";
}
