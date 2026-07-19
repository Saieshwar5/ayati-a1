import type { RunWorkState } from "../contracts.js";
import type {
  RunEvidenceRecord,
  RunStepEvidenceRecord,
} from "../repositories/run-records.js";

export function renderFinalizedUnboundRun(input: {
  run: RunEvidenceRecord;
  workState: RunWorkState;
}): string {
  return JSON.stringify({
    schemaVersion: 2,
    runId: input.run.runId,
    sessionId: input.run.sessionId,
    conversationId: input.run.conversationId,
    trigger: input.run.trigger,
    status: input.run.status,
    stopReason: input.run.stopReason,
    startedAt: input.run.startedAt,
    completedAt: input.run.completedAt,
    stepCount: input.run.stepCount,
    workState: input.workState,
  }, null, 2) + "\n";
}

export function renderUnboundRunSteps(steps: RunStepEvidenceRecord[]): string {
  if (steps.length === 0) return "";
  return steps.map((step) => JSON.stringify(step)).join("\n") + "\n";
}
