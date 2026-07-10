import { estimateTextTokens } from "../../prompt/token-estimator.js";
import { correctLocalInputTokenEstimate } from "../../prompt/context-token-counter.js";
import {
  type PromptRunToolCallContext,
  type PromptRunToolCallMode,
  type PromptToolCalls,
} from "./run-tool-call-context.js";
import { projectToolCallForPressure } from "./tool-context-projectors/registry.js";
import type { PressureProjectionMode } from "./tool-context-projectors/types.js";

export type ToolCallProjectionReason =
  | "below_soft_limit"
  | "latest_six"
  | "failed_call"
  | "not_recoverable"
  | "evidence_only"
  | "expired_next_step"
  | "older_relevant_context"
  | "older_recoverable_call"
  | "target_reached";

export interface ToolCallProjectionPlanEntry {
  callId?: string;
  step: number;
  tool: string;
  mode: PromptRunToolCallMode;
  reason: ToolCallProjectionReason;
  projectorId?: string;
  tokensBefore: number;
  tokensAfter: number;
}

export interface ToolContextProjectionPlan {
  schemaVersion: 1;
  shadow: true;
  triggered: boolean;
  candidateInputTokens: number;
  recoveryTargetTokens: number;
  softInputTokens: number;
  requiredSavingsTokens: number;
  estimatedSavingsTokens: number;
  projectedInputTokens: number;
  hotWindowSize: number;
  canReachTarget: boolean;
  calls: ToolCallProjectionPlanEntry[];
  projectedCalls: PromptToolCalls;
}

const HOT_CALL_COUNT = 6;

export function planToolContextProjection(input: {
  calls: PromptToolCalls;
  candidateInputTokens: number;
  recoveryTargetTokens: number;
  softInputTokens: number;
}): ToolContextProjectionPlan {
  const triggered = input.candidateInputTokens >= input.softInputTokens;
  const requiredSavingsTokens = triggered
    ? Math.max(0, input.candidateInputTokens - input.recoveryTargetTokens)
    : 0;
  const hotStart = Math.max(0, input.calls.length - HOT_CALL_COUNT);
  const entries = input.calls.map((call, index) => initialEntry(call, index, hotStart, triggered));
  const projectedCalls = input.calls.map((call) => ({ ...call }));

  if (!triggered || requiredSavingsTokens === 0) {
    return buildPlan(input, entries, projectedCalls, requiredSavingsTokens, 0);
  }

  const candidates = input.calls
    .map((call, index) => projectionCandidate(call, index, hotStart))
    .filter((candidate): candidate is ProjectionCandidate => candidate !== undefined)
    .sort(compareProjectionCandidates);
  let estimatedSavingsTokens = 0;

  for (const candidate of candidates) {
    if (estimatedSavingsTokens >= requiredSavingsTokens) {
      entries[candidate.index] = {
        ...entries[candidate.index]!,
        reason: "target_reached",
      };
      continue;
    }
    entries[candidate.index] = candidate.entry;
    projectedCalls[candidate.index] = candidate.projectedCall;
    estimatedSavingsTokens += candidate.savingsTokens;
  }

  return buildPlan(input, entries, projectedCalls, requiredSavingsTokens, estimatedSavingsTokens);
}

interface ProjectionCandidate {
  index: number;
  priority: number;
  savingsTokens: number;
  projectedCall: PromptRunToolCallContext;
  entry: ToolCallProjectionPlanEntry;
}

function projectionCandidate(
  call: PromptRunToolCallContext,
  index: number,
  hotStart: number,
): ProjectionCandidate | undefined {
  if (index >= hotStart || call.status === "failed" || (!call.stepRef && !call.evidenceRef)) {
    return undefined;
  }
  const mode = projectionMode(call);
  const projection = projectToolCallForPressure(call, mode);
  const projected = projection.call;
  const tokensBefore = estimateProjectionTokens(call);
  const tokensAfter = estimateProjectionTokens(projected);
  if (tokensAfter >= tokensBefore) {
    return undefined;
  }
  return {
    index,
    priority: projectionPriority(call),
    savingsTokens: Math.max(0, tokensBefore - tokensAfter),
    projectedCall: projected,
    entry: {
      ...(call.callId ? { callId: call.callId } : {}),
      step: call.step,
      tool: call.tool,
      mode,
      reason: projectionReason(call),
      projectorId: projection.projectorId,
      tokensBefore,
      tokensAfter,
    },
  };
}

function initialEntry(
  call: PromptRunToolCallContext,
  index: number,
  hotStart: number,
  triggered: boolean,
): ToolCallProjectionPlanEntry {
  const tokens = estimateProjectionTokens(call);
  return {
    ...(call.callId ? { callId: call.callId } : {}),
    step: call.step,
    tool: call.tool,
    mode: "full",
    reason: !triggered
      ? "below_soft_limit"
      : index >= hotStart
        ? "latest_six"
        : call.status === "failed"
          ? "failed_call"
          : !call.stepRef && !call.evidenceRef
            ? "not_recoverable"
            : "older_recoverable_call",
    tokensBefore: tokens,
    tokensAfter: tokens,
  };
}

function projectionMode(call: PromptRunToolCallContext): PressureProjectionMode {
  if (call.retention === "while_relevant") return "preview";
  return "summary";
}

function projectionReason(call: PromptRunToolCallContext): ToolCallProjectionReason {
  if (call.retention === "evidence_only") return "evidence_only";
  if (call.retention === "while_relevant") return "older_relevant_context";
  if (call.retention === "next_step") return "expired_next_step";
  return "older_recoverable_call";
}

function projectionPriority(call: PromptRunToolCallContext): number {
  if (call.retention === "evidence_only") return 0;
  if (call.retention === "next_step") return 1;
  if (call.retention === "while_relevant") return 2;
  return 3;
}

function compareProjectionCandidates(left: ProjectionCandidate, right: ProjectionCandidate): number {
  if (left.priority !== right.priority) return left.priority - right.priority;
  if (left.savingsTokens !== right.savingsTokens) return right.savingsTokens - left.savingsTokens;
  return left.index - right.index;
}

function estimateProjectionTokens(call: PromptRunToolCallContext): number {
  const { projectionMetadata: _projectionMetadata, ...promptCall } = call;
  return correctLocalInputTokenEstimate(estimateTextTokens(JSON.stringify(promptCall)));
}

function buildPlan(
  input: {
    calls: PromptToolCalls;
    candidateInputTokens: number;
    recoveryTargetTokens: number;
    softInputTokens: number;
  },
  calls: ToolCallProjectionPlanEntry[],
  projectedCalls: PromptToolCalls,
  requiredSavingsTokens: number,
  estimatedSavingsTokens: number,
): ToolContextProjectionPlan {
  const projectedInputTokens = Math.max(0, input.candidateInputTokens - estimatedSavingsTokens);
  const triggered = input.candidateInputTokens >= input.softInputTokens;
  return {
    schemaVersion: 1,
    shadow: true,
    triggered,
    candidateInputTokens: input.candidateInputTokens,
    recoveryTargetTokens: input.recoveryTargetTokens,
    softInputTokens: input.softInputTokens,
    requiredSavingsTokens,
    estimatedSavingsTokens,
    projectedInputTokens,
    hotWindowSize: Math.min(HOT_CALL_COUNT, input.calls.length),
    canReachTarget: !triggered || projectedInputTokens <= input.recoveryTargetTokens,
    calls,
    projectedCalls,
  };
}
