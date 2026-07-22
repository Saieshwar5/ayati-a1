import type { ResolvedModelContextLimits } from "../../providers/shared/model-context-limits.js";
import type { ContextLane, ContextPreparationTriggerDecision } from "./types.js";

const PREPARATION_LEAD_RATIO = 15_000 / 128_000;
const MIN_NEXT_DECISION_RESERVE_TOKENS = 8_000;

export interface ContextLaneBudgetPlan {
  hardInputTokens: number;
  targets: Record<ContextLane, number>;
  demand: Record<ContextLane, number>;
  allocated: Record<ContextLane, number>;
  borrowed: Record<ContextLane, number>;
  unusedTokens: number;
  totalDemandTokens: number;
  fitsTotalBudget: boolean;
}

export function contextLaneTargets(hardInputTokens: number): Record<ContextLane, number> {
  const system = Math.floor(hardInputTokens * 0.15);
  const session = Math.floor(hardInputTokens * 0.25);
  return {
    system,
    session,
    work: hardInputTokens - system - session,
  };
}

export function planFlexibleLaneAllocation(input: {
  hardInputTokens: number;
  demand: Record<ContextLane, number>;
}): ContextLaneBudgetPlan {
  const targets = contextLaneTargets(input.hardInputTokens);
  const allocated: Record<ContextLane, number> = {
    system: Math.min(input.demand.system, targets.system),
    session: Math.min(input.demand.session, targets.session),
    work: Math.min(input.demand.work, targets.work),
  };
  let unusedTokens = input.hardInputTokens
    - allocated.system
    - allocated.session
    - allocated.work;
  const borrowed: Record<ContextLane, number> = { system: 0, session: 0, work: 0 };

  for (const lane of ["system", "session", "work"] as const) {
    const unmet = Math.max(0, input.demand[lane] - allocated[lane]);
    const amount = Math.min(unusedTokens, unmet);
    allocated[lane] += amount;
    borrowed[lane] = amount;
    unusedTokens -= amount;
  }

  const totalDemandTokens = input.demand.system + input.demand.session + input.demand.work;
  return {
    hardInputTokens: input.hardInputTokens,
    targets,
    demand: { ...input.demand },
    allocated,
    borrowed,
    unusedTokens,
    totalDemandTokens,
    fitsTotalBudget: totalDemandTokens <= input.hardInputTokens,
  };
}

export function preparationLeadTokens(contextWindowTokens: number): number {
  return Math.max(1, Math.floor(contextWindowTokens * PREPARATION_LEAD_RATIO));
}

export function decideContextPreparationTrigger(input: {
  measuredInputTokens: number;
  preparationInputTokens: number;
  softInputTokens: number;
  preparationLeadTokens: number;
}): ContextPreparationTriggerDecision {
  const predictedInputTokens = input.measuredInputTokens + input.preparationLeadTokens;
  if (input.measuredInputTokens >= input.preparationInputTokens) {
    return { triggered: true, reason: "preparation_threshold", predictedInputTokens };
  }
  if (predictedInputTokens >= input.softInputTokens) {
    return { triggered: true, reason: "predicted_soft_pressure", predictedInputTokens };
  }
  return { triggered: false, reason: "below_threshold", predictedInputTokens };
}

export function nextDecisionReserveTokens(input: {
  softInputTokens: number;
  recoveryTargetTokens: number;
}): number {
  return Math.max(
    MIN_NEXT_DECISION_RESERVE_TOKENS,
    input.softInputTokens - input.recoveryTargetTokens,
  );
}

export function forcedSynchronousBarrier(input: {
  admissionLimitTokens: number;
  softInputTokens: number;
  recoveryTargetTokens: number;
}): number {
  return Math.max(1, input.admissionLimitTokens - nextDecisionReserveTokens(input));
}

export function modelProfileVersion(limits: ResolvedModelContextLimits): string {
  return [
    limits.provider,
    limits.model,
    limits.contextWindowTokens,
    limits.maxInputTokens ?? "auto",
    limits.outputReserveTokens,
    limits.preparationInputTokens,
    limits.recoveryTargetTokens,
    limits.softInputTokens,
    limits.hardInputTokens,
  ].join(":");
}
