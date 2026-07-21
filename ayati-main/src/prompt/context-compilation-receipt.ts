import type { ContextBudgetReport } from "./context-budget.js";

export type ContextCompilationMode =
  | "full"
  | "tool_compact"
  | "stream_project"
  | "stream_checkpoint"
  | "step_ledger";

export interface ContextCompilationReceipt {
  schemaVersion: 2;
  decisionAttempt: number;
  mode: ContextCompilationMode;
  provider: string;
  model: string;
  candidateInputTokens: number;
  intermediateInputTokens?: number;
  finalInputTokens: number;
  preparationInputTokens: number;
  recoveryTargetTokens: number;
  softInputTokens: number;
  hardInputTokens: number;
  admissionLimitTokens: number;
  forcedBarrierTokens: number;
  nextDecisionReserveTokens: number;
  preparationLeadTokens?: number;
  manifestPolicyVersion?: number;
  laneEstimates?: Record<"system" | "session" | "work", number>;
  candidateLaneEstimates?: Record<"system" | "session" | "work", number>;
  toolSchemaTokens?: number;
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
  forcedRecovery?: boolean;
  candidate?: {
    candidateId: string;
    laneId: string;
    kind: "durable_checkpoint" | "run_focus" | "resolver_focus";
    status: "preparing" | "ready" | "adopted" | "stale" | "failed" | "discarded";
    targetReached: boolean;
  };
  candidateAction?: "none" | "measured" | "adopted" | "rejected" | "awaited";
  candidateReason?: string;
  backgroundPreparation?: {
    triggered: boolean;
    deduplicated: boolean;
    overlappedForeground: boolean;
    durationMs?: number;
    attempts?: number;
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    costUsd?: number;
  };
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
    schemaVersion: 2,
    decisionAttempt: input.decisionAttempt,
    mode: "stream_project",
    provider: input.final.provider,
    model: input.final.model,
    candidateInputTokens: input.candidate.measuredInputTokens,
    intermediateInputTokens: input.intermediate.measuredInputTokens,
    finalInputTokens: input.final.measuredInputTokens,
    preparationInputTokens: input.final.preparationInputTokens,
    recoveryTargetTokens: input.final.recoveryTargetTokens,
    softInputTokens: input.final.softInputTokens,
    hardInputTokens: input.final.hardInputTokens,
    admissionLimitTokens: input.final.admissionLimitTokens,
    ...forcedBarrierReceiptFields(input.final),
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
    schemaVersion: 2,
    decisionAttempt: input.decisionAttempt,
    mode: "stream_checkpoint",
    provider: input.final.provider,
    model: input.final.model,
    candidateInputTokens: input.candidate.measuredInputTokens,
    intermediateInputTokens: input.intermediate.measuredInputTokens,
    finalInputTokens: input.final.measuredInputTokens,
    preparationInputTokens: input.final.preparationInputTokens,
    recoveryTargetTokens: input.final.recoveryTargetTokens,
    softInputTokens: input.final.softInputTokens,
    hardInputTokens: input.final.hardInputTokens,
    admissionLimitTokens: input.final.admissionLimitTokens,
    ...forcedBarrierReceiptFields(input.final),
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
    schemaVersion: 2,
    decisionAttempt: input.decisionAttempt,
    mode: "tool_compact",
    provider: input.final.provider,
    model: input.final.model,
    candidateInputTokens: input.candidate.measuredInputTokens,
    finalInputTokens: input.final.measuredInputTokens,
    preparationInputTokens: input.final.preparationInputTokens,
    recoveryTargetTokens: input.final.recoveryTargetTokens,
    softInputTokens: input.final.softInputTokens,
    hardInputTokens: input.final.hardInputTokens,
    admissionLimitTokens: input.final.admissionLimitTokens,
    ...forcedBarrierReceiptFields(input.final),
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
    schemaVersion: 2,
    decisionAttempt,
    mode: "full",
    provider: report.provider,
    model: report.model,
    candidateInputTokens: report.measuredInputTokens,
    finalInputTokens: report.measuredInputTokens,
    preparationInputTokens: report.preparationInputTokens,
    recoveryTargetTokens: report.recoveryTargetTokens,
    softInputTokens: report.softInputTokens,
    hardInputTokens: report.hardInputTokens,
    admissionLimitTokens: report.admissionLimitTokens,
    ...forcedBarrierReceiptFields(report),
    softLimitExceeded: report.softLimitExceeded,
    hardLimitExceeded: report.hardLimitExceeded,
    admitted: !report.admissionLimitExceeded,
    countSource: report.countSource,
    transformations: [],
  };
}

export function enrichContextCompilationReceipt(
  receipt: ContextCompilationReceipt,
  input: {
    preparationLeadTokens: number;
    manifestPolicyVersion: number;
    laneEstimates: Record<"system" | "session" | "work", number>;
    candidateLaneEstimates?: Record<"system" | "session" | "work", number>;
    toolSchemaTokens: number;
    forcedRecovery: boolean;
    candidate?: ContextCompilationReceipt["candidate"];
    candidateAction?: ContextCompilationReceipt["candidateAction"];
    candidateReason?: string;
    backgroundPreparation?: ContextCompilationReceipt["backgroundPreparation"];
  },
): ContextCompilationReceipt {
  return {
    ...receipt,
    preparationLeadTokens: input.preparationLeadTokens,
    manifestPolicyVersion: input.manifestPolicyVersion,
    laneEstimates: input.laneEstimates,
    ...(input.candidateLaneEstimates ? { candidateLaneEstimates: input.candidateLaneEstimates } : {}),
    toolSchemaTokens: input.toolSchemaTokens,
    ...(input.forcedRecovery ? { forcedRecovery: true } : {}),
    ...(input.candidate ? { candidate: input.candidate } : {}),
    ...(input.candidateAction ? { candidateAction: input.candidateAction } : {}),
    ...(input.candidateReason ? { candidateReason: input.candidateReason } : {}),
    ...(input.backgroundPreparation ? { backgroundPreparation: input.backgroundPreparation } : {}),
  };
}

function forcedBarrierReceiptFields(report: ContextBudgetReport): {
  forcedBarrierTokens: number;
  nextDecisionReserveTokens: number;
} {
  const nextDecisionReserveTokens = Math.max(
    8_000,
    report.softInputTokens - report.recoveryTargetTokens,
  );
  return {
    nextDecisionReserveTokens,
    forcedBarrierTokens: Math.max(1, report.admissionLimitTokens - nextDecisionReserveTokens),
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
      `Decision input remains at ${receipt.finalInputTokens} tokens after context recovery, at or above the ${receipt.forcedBarrierTokens}-token forced recovery barrier.`,
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
