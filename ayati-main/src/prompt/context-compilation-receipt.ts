import type { ContextBudgetReport } from "./context-budget.js";

export type ContextCompilationMode =
  | "full"
  | "tool_compact"
  | "timeline_checkpoint"
  | "session_digest"
  | "step_ledger";

export interface ContextCompilationReceipt {
  schemaVersion: 1;
  decisionAttempt: number;
  mode: ContextCompilationMode;
  provider: string;
  model: string;
  candidateInputTokens: number;
  finalInputTokens: number;
  recoveryTargetTokens: number;
  softInputTokens: number;
  hardInputTokens: number;
  admissionLimitTokens: number;
  softLimitExceeded: boolean;
  candidateHardLimitExceeded?: boolean;
  hardLimitExceeded: boolean;
  admitted: boolean;
  countSource: ContextBudgetReport["countSource"];
  candidateCountSource?: ContextBudgetReport["countSource"];
  targetReached?: boolean;
  needsEscalation?: boolean;
  transformations: Array<{
    kind: string;
    callId?: string;
    tool?: string;
    projectorId?: string;
    from?: string;
    to?: string;
    reason?: string;
    tokensBefore: number;
    tokensAfter: number;
  }>;
}

export function buildToolCompactContextCompilationReceipt(input: {
  candidate: ContextBudgetReport;
  final: ContextBudgetReport;
  decisionAttempt: number;
  transformations: ContextCompilationReceipt["transformations"];
}): ContextCompilationReceipt {
  return {
    schemaVersion: 1,
    decisionAttempt: input.decisionAttempt,
    mode: "tool_compact",
    provider: input.final.provider,
    model: input.final.model,
    candidateInputTokens: input.candidate.measuredInputTokens,
    finalInputTokens: input.final.measuredInputTokens,
    recoveryTargetTokens: input.final.recoveryTargetTokens,
    softInputTokens: input.final.softInputTokens,
    hardInputTokens: input.final.hardInputTokens,
    admissionLimitTokens: input.final.admissionLimitTokens,
    softLimitExceeded: input.candidate.softLimitExceeded,
    candidateHardLimitExceeded: input.candidate.hardLimitExceeded,
    hardLimitExceeded: input.final.hardLimitExceeded,
    admitted: !input.final.admissionLimitExceeded,
    countSource: input.final.countSource,
    candidateCountSource: input.candidate.countSource,
    targetReached: input.final.measuredInputTokens <= input.final.recoveryTargetTokens,
    needsEscalation: input.final.measuredInputTokens > input.final.recoveryTargetTokens,
    transformations: input.transformations,
  };
}

export function buildFullContextCompilationReceipt(
  report: ContextBudgetReport,
  decisionAttempt: number,
): ContextCompilationReceipt {
  return {
    schemaVersion: 1,
    decisionAttempt,
    mode: "full",
    provider: report.provider,
    model: report.model,
    candidateInputTokens: report.measuredInputTokens,
    finalInputTokens: report.measuredInputTokens,
    recoveryTargetTokens: report.recoveryTargetTokens,
    softInputTokens: report.softInputTokens,
    hardInputTokens: report.hardInputTokens,
    admissionLimitTokens: report.admissionLimitTokens,
    softLimitExceeded: report.softLimitExceeded,
    hardLimitExceeded: report.hardLimitExceeded,
    admitted: !report.admissionLimitExceeded,
    countSource: report.countSource,
    transformations: [],
  };
}

export class ContextInputLimitError extends Error {
  readonly receipt: ContextCompilationReceipt;

  constructor(receipt: ContextCompilationReceipt) {
    super(
      `Decision input requires ${receipt.finalInputTokens} tokens, exceeding the ${receipt.admissionLimitTokens}-token admission limit.`,
    );
    this.name = "ContextInputLimitError";
    this.receipt = receipt;
  }
}

export function assertContextIsAdmissible(receipt: ContextCompilationReceipt): void {
  if (!receipt.admitted) {
    throw new ContextInputLimitError(receipt);
  }
}
