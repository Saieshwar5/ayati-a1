import type { LlmMessage, LlmTurnInput } from "../../core/contracts/llm-protocol.js";
import { correctLocalInputTokenEstimate } from "../../prompt/context-token-counter.js";
import { estimateTurnInputTokens } from "../../prompt/token-estimator.js";
import { projectAgentStateViewForPrompt } from "./prompt-context.js";
import type {
  AgentPromptStateView,
  PromptGitSessionContext,
  PromptRunContext,
} from "./prompt-context.js";
import type { PromptToolCalls } from "./run-tool-call-context.js";
import type { AgentStateView } from "./state-view.js";

export interface SessionContextSheddingReceipt {
  schemaVersion: 1;
  triggered: boolean;
  removedSummary: boolean;
  removedCheckpointCount: number;
  retainedCheckpointId?: string;
  removedActivityCount: number;
  localEstimateTokens: number;
  correctedLocalEstimateTokens: number;
}

export interface SessionContextSheddingCandidate {
  turnInput: LlmTurnInput;
  receipt: SessionContextSheddingReceipt;
}

export function buildSessionContextSheddingCandidate(input: {
  stateView: AgentStateView;
  turnInput: LlmTurnInput;
  projectedToolCalls?: PromptToolCalls;
  buildPrompt: (stateView: AgentPromptStateView) => string;
}): SessionContextSheddingCandidate {
  const session = input.stateView.context.git?.session;
  const checkpoints = session?.recentTaskRuns ?? [];
  const latestCheckpoint = checkpoints.at(-1);
  const removedSummary = Boolean(session?.summary);
  const removedCheckpointCount = Math.max(0, checkpoints.length - (latestCheckpoint ? 1 : 0));
  const removedActivityCount = session?.activity.recent.length ?? 0;
  const triggered = removedSummary || removedCheckpointCount > 0 || removedActivityCount > 0;
  const projectedStateView = triggered || input.projectedToolCalls
    ? projectStateView(input.stateView, {
        ...(session ? { session: shedSessionContext(session) } : {}),
        projectedToolCalls: input.projectedToolCalls,
      })
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
      removedSummary,
      removedCheckpointCount,
      ...(latestCheckpoint ? { retainedCheckpointId: latestCheckpoint.checkpointId } : {}),
      removedActivityCount,
      localEstimateTokens,
      correctedLocalEstimateTokens: correctLocalInputTokenEstimate(localEstimateTokens),
    },
  };
}

export function shedSessionContext(session: PromptGitSessionContext): PromptGitSessionContext {
  const latestCheckpoint = session.recentTaskRuns?.at(-1);
  return {
    meta: session.meta,
    ...(latestCheckpoint ? { recentTaskRuns: [latestCheckpoint] } : {}),
    ...(session.attachments ? { attachments: session.attachments } : {}),
    activity: { recent: [] },
  };
}

function projectStateView(
  stateView: AgentStateView,
  input: {
    session?: PromptGitSessionContext;
    projectedToolCalls?: PromptToolCalls;
  },
): AgentStateView {
  const git = stateView.context.git;
  const run = stateView.context.run;
  return {
    ...stateView,
    context: {
      ...stateView.context,
      ...(git && input.session ? {
        git: {
          ...git,
          session: input.session,
        },
      } : {}),
      ...(run ? {
        run: {
          ...run,
          ...(input.projectedToolCalls ? { toolCalls: input.projectedToolCalls } : {}),
          ...(run.contextPressure ? {
            contextPressure: appliedSessionSheddingPressure(run.contextPressure),
          } : {}),
        },
      } : {}),
    },
  };
}

function appliedSessionSheddingPressure(
  pressure: NonNullable<PromptRunContext["contextPressure"]>,
): NonNullable<PromptRunContext["contextPressure"]> {
  const { recommendedMode, ...rest } = pressure;
  return {
    ...rest,
    mode: "session_shed",
    ...(recommendedMode && recommendedMode !== "session_shed" ? { recommendedMode } : {}),
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
