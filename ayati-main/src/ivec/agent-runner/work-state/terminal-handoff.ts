import type { ValidationCheckResult } from "../task-validation-contracts.js";
import {
  buildValidationCompletionReceipts,
  mergeValidationCompletionReceipts,
} from "./completion-receipts.js";
import type { WorkState } from "./contracts.js";

const INITIAL_WORK_STATE_SUMMARY = "Run started.";
const DIRECT_RESPONSE_HANDOFF = "Completed the direct response.";

export function completeWorkStateHandoff(input: {
  runId: string;
  workState: WorkState;
  validationChecks: ValidationCheckResult[];
}): WorkState {
  const receipts = buildValidationCompletionReceipts({
    runId: input.runId,
    checks: input.validationChecks,
  });

  return {
    ...input.workState,
    status: "done",
    summary: terminalSummary(input.workState, receipts),
    plan: input.workState.plan.map((item) => ({
      ...item,
      status: "done",
    })),
    importantContext: mergeValidationCompletionReceipts({
      runId: input.runId,
      importantContext: input.workState.importantContext,
      checks: input.validationChecks,
    }),
    nextAction: undefined,
  };
}

function terminalSummary(
  workState: WorkState,
  receipts: ReturnType<typeof buildValidationCompletionReceipts>,
): string {
  const current = workState.summary.trim();
  if (current && current !== INITIAL_WORK_STATE_SUMMARY) {
    return current;
  }
  if (receipts.length > 0) {
    return receipts.map((receipt) => receipt.value).join(" ");
  }
  return DIRECT_RESPONSE_HANDOFF;
}
