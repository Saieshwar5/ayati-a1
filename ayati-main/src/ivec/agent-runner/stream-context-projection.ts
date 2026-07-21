import type { LlmMessage, LlmTurnInput } from "../../core/contracts/llm-protocol.js";
import { correctLocalInputTokenEstimate } from "../../prompt/context-token-counter.js";
import { estimateTurnInputTokens } from "../../prompt/token-estimator.js";
import { projectAgentStateViewForPrompt } from "./prompt-context.js";
import type { AgentPromptStateView, PromptRunContext } from "./prompt-context.js";
import type { PromptToolCalls } from "./run-tool-call-context.js";
import type { AgentStateView } from "./state-view.js";

const LIMITS = {
  candidates: 8,
  recentWork: 6,
  streamResources: 12,
  observationsPerKind: 8,
};

export interface StreamContextProjectionReceipt {
  schemaVersion: 1;
  triggered: boolean;
  removedCandidateCount: number;
  removedRecentWorkCount: number;
  removedResourceCount: number;
  removedObservationCount: number;
  localEstimateTokens: number;
  correctedLocalEstimateTokens: number;
}

export interface StreamContextProjectionCandidate {
  turnInput: LlmTurnInput;
  receipt: StreamContextProjectionReceipt;
}

export function buildStreamContextProjectionCandidate(input: {
  stateView: AgentStateView;
  turnInput: LlmTurnInput;
  projectedToolCalls?: PromptToolCalls;
  buildPrompt: (stateView: AgentPromptStateView) => string;
}): StreamContextProjectionCandidate {
  const context = input.stateView.context;
  const removedCandidateCount = Math.max(0, context.work.candidates.length - LIMITS.candidates);
  const removedRecentWorkCount = Math.max(0, context.stream.recentWork.length - LIMITS.recentWork);
  const removedResourceCount = Math.max(0, context.resources.stream.length - LIMITS.streamResources);
  const observationCount = context.observations.inventory.length
    + context.observations.discovery.length
    + context.observations.evidence.length;
  const projectedObservationCount = Math.min(
    context.observations.inventory.length,
    LIMITS.observationsPerKind,
  ) + Math.min(context.observations.discovery.length, LIMITS.observationsPerKind)
    + Math.min(context.observations.evidence.length, LIMITS.observationsPerKind);
  const removedObservationCount = observationCount - projectedObservationCount;
  const triggered = removedCandidateCount > 0
    || removedRecentWorkCount > 0
    || removedResourceCount > 0
    || removedObservationCount > 0;
  const projectedStateView = triggered || input.projectedToolCalls
    ? projectStateViewForStreamPressure(input.stateView, input.projectedToolCalls)
    : input.stateView;
  const promptStateView = projectAgentStateViewForPrompt(projectedStateView);
  const turnInput = {
    ...input.turnInput,
    messages: replaceFirstUserPrompt(input.turnInput.messages, input.buildPrompt(promptStateView)),
  };
  const localEstimateTokens = estimateTurnInputTokens(turnInput).totalTokens;
  return {
    turnInput,
    receipt: {
      schemaVersion: 1,
      triggered,
      removedCandidateCount,
      removedRecentWorkCount,
      removedResourceCount,
      removedObservationCount,
      localEstimateTokens,
      correctedLocalEstimateTokens: correctLocalInputTokenEstimate(localEstimateTokens),
    },
  };
}

export function projectStateViewForStreamPressure(
  stateView: AgentStateView,
  projectedToolCalls: PromptToolCalls | undefined,
): AgentStateView {
  const context = stateView.context;
  const run = context.run;
  return {
    ...stateView,
    context: {
      ...context,
      stream: {
        ...context.stream,
        recentWork: context.stream.recentWork.slice(0, LIMITS.recentWork),
      },
      work: {
        ...context.work,
        candidates: context.work.candidates.slice(0, LIMITS.candidates),
      },
      resources: {
        ...context.resources,
        stream: context.resources.stream.slice(0, LIMITS.streamResources),
      },
      observations: {
        ...context.observations,
        inventory: context.observations.inventory.slice(-LIMITS.observationsPerKind),
        discovery: context.observations.discovery.slice(-LIMITS.observationsPerKind),
        evidence: context.observations.evidence.slice(-LIMITS.observationsPerKind),
      },
      ...(run ? {
        run: {
          ...run,
          ...(projectedToolCalls ? { toolCalls: projectedToolCalls } : {}),
          ...(run.contextPressure ? {
            contextPressure: appliedStreamProjectionPressure(run.contextPressure),
          } : {}),
        },
      } : {}),
    },
  };
}

function appliedStreamProjectionPressure(
  pressure: NonNullable<PromptRunContext["contextPressure"]>,
): NonNullable<PromptRunContext["contextPressure"]> {
  const { recommendedMode, ...rest } = pressure;
  return {
    ...rest,
    mode: "stream_project",
    ...(recommendedMode && recommendedMode !== "stream_project" ? { recommendedMode } : {}),
  };
}

function replaceFirstUserPrompt(messages: LlmMessage[], prompt: string): LlmMessage[] {
  let replaced = false;
  return messages.map((message) => {
    if (replaced || message.role !== "user") return message;
    replaced = true;
    return { role: "user", content: prompt };
  });
}
