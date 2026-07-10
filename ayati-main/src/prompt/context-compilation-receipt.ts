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
  hardLimitExceeded: boolean;
  admitted: boolean;
  countSource: ContextBudgetReport["countSource"];
  transformations: Array<{
    kind: string;
    tokensBefore: number;
    tokensAfter: number;
  }>;
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
