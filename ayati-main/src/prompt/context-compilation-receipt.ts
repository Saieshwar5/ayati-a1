import type { ContextBudgetReport } from "./context-budget.js";

export type ContextCompilationMode =
  | "full"
  | "tool_compact"
  | "stream_project"
  | "stream_checkpoint"
  | "step_ledger";

export interface ContextCompilationReceipt {
  schemaVersion: 1;
  decisionAttempt: number;
  mode: ContextCompilationMode;
  provider: string;
  model: string;
  candidateInputTokens: number;
  intermediateInputTokens?: number;
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
  toolProjectionPolicy?: "shadow" | "enforce";
  targetReached?: boolean;
  needsEscalation?: boolean;
  streamCheckpoint?: {
    coveredFromSeq: number;
    coveredToSeq: number;
    sourceEventCount: number;
    sourceHash: string;
    checkpointTokens: number;
    cacheStatus: "generated" | "success_hit";
    generationAttempts: number;
  };
  streamProjection?: {
    removedCandidateCount: number;
    removedRecentWorkCount: number;
    removedResourceCount: number;
    removedObservationCount: number;
    tokensBefore: number;
    tokensAfter: number;
  };
  recoveryExhausted?: boolean;
  transformations: Array<{
    kind: string;
    callId?: string;
    tool?: string;
    projectorId?: string;
    from?: string;
    to?: string;
    reason?: string;
    coveredFromSeq?: number;
    coveredToSeq?: number;
    sourceHash?: string;
    tokensBefore: number;
    tokensAfter: number;
  }>;
}

export function buildStreamProjectionCompilationReceipt(input: {
  candidate: ContextBudgetReport;
  intermediate: ContextBudgetReport;
  final: ContextBudgetReport;
  decisionAttempt: number;
  transformations: ContextCompilationReceipt["transformations"];
  projection: NonNullable<ContextCompilationReceipt["streamProjection"]>;
}): ContextCompilationReceipt {
  return {
    schemaVersion: 1,
    decisionAttempt: input.decisionAttempt,
    mode: "stream_project",
    provider: input.final.provider,
    model: input.final.model,
    candidateInputTokens: input.candidate.measuredInputTokens,
    intermediateInputTokens: input.intermediate.measuredInputTokens,
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
    toolProjectionPolicy: "enforce",
    targetReached: input.final.measuredInputTokens <= input.final.recoveryTargetTokens,
    needsEscalation: input.final.softLimitExceeded,
    streamProjection: input.projection,
    transformations: input.transformations,
  };
}

export function buildStreamCheckpointCompilationReceipt(input: {
  candidate: ContextBudgetReport;
  intermediate: ContextBudgetReport;
  final: ContextBudgetReport;
  decisionAttempt: number;
  transformations: ContextCompilationReceipt["transformations"];
  checkpoint: NonNullable<ContextCompilationReceipt["streamCheckpoint"]>;
  streamProjection?: NonNullable<ContextCompilationReceipt["streamProjection"]>;
  recoveryExhausted?: boolean;
}): ContextCompilationReceipt {
  return {
    schemaVersion: 1,
    decisionAttempt: input.decisionAttempt,
    mode: "stream_checkpoint",
    provider: input.final.provider,
    model: input.final.model,
    candidateInputTokens: input.candidate.measuredInputTokens,
    intermediateInputTokens: input.intermediate.measuredInputTokens,
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
    toolProjectionPolicy: "enforce",
    targetReached: input.final.measuredInputTokens <= input.final.recoveryTargetTokens,
    needsEscalation: input.final.softLimitExceeded,
    streamCheckpoint: input.checkpoint,
    ...(input.streamProjection ? { streamProjection: input.streamProjection } : {}),
    ...(input.recoveryExhausted ? { recoveryExhausted: true } : {}),
    transformations: input.transformations,
  };
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
    toolProjectionPolicy: "enforce",
    targetReached: input.final.measuredInputTokens <= input.final.recoveryTargetTokens,
    needsEscalation: input.final.softLimitExceeded,
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

export class ContextRunCapacityError extends Error {
  readonly receipt: ContextCompilationReceipt;

  constructor(receipt: ContextCompilationReceipt) {
    super(
      `Decision input remains at ${receipt.finalInputTokens} tokens after context recovery, at or above the ${receipt.softInputTokens}-token soft limit.`,
    );
    this.name = "ContextRunCapacityError";
    this.receipt = receipt;
  }
}

export function assertContextIsAdmissible(receipt: ContextCompilationReceipt): void {
  if (!receipt.admitted) {
    throw new ContextInputLimitError(receipt);
  }
}

export function assertContextRecoveryIsNotExhausted(receipt: ContextCompilationReceipt): void {
  if (receipt.recoveryExhausted) {
    throw new ContextRunCapacityError(receipt);
  }
}
