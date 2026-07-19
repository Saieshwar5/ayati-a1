import type { LlmMessage, LlmTurnInput } from "../../core/contracts/llm-protocol.js";
import { projectAgentStateViewForPrompt } from "./prompt-context.js";
import type { AgentPromptStateView, PromptRunContext } from "./prompt-context.js";
import type { PromptToolCalls } from "./run-tool-call-context.js";
import type { AgentStateView } from "./state-view.js";
import { shedSessionContext } from "./session-context-shedding.js";
import type {
  TimelineCheckpointEvent,
  TimelineCheckpointPlan,
} from "./timeline-checkpoint.js";

export function buildTimelineCheckpointTurnInput(input: {
  stateView: AgentStateView;
  turnInput: LlmTurnInput;
  plan: TimelineCheckpointPlan;
  checkpoint: TimelineCheckpointEvent;
  projectedToolCalls?: PromptToolCalls;
  buildPrompt: (stateView: AgentPromptStateView) => string;
}): LlmTurnInput {
  const run = input.stateView.context.run;
  const contextPressure = run?.contextPressure;
  const git = input.stateView.context.git;
  const shedSession = git ? shedSessionContext(git.session) : undefined;
  const sessionWithoutCheckpoint = shedSession
    ? omitRecentRunCheckpoints(shedSession)
    : undefined;
  const projectedStateView: AgentStateView = {
    ...input.stateView,
    context: {
      ...input.stateView.context,
      timeline: [input.checkpoint, ...input.plan.exactTail],
      ...(git && sessionWithoutCheckpoint ? {
        git: {
          ...git,
          session: sessionWithoutCheckpoint,
        },
      } : {}),
      ...(run ? {
        run: {
          ...run,
          ...(input.projectedToolCalls ? { toolCalls: input.projectedToolCalls } : {}),
          ...(contextPressure ? {
            contextPressure: appliedTimelinePressure(contextPressure),
          } : {}),
        },
      } : {}),
    },
  };
  const promptStateView = projectAgentStateViewForPrompt(projectedStateView);
  return {
    ...input.turnInput,
    messages: replaceFirstUserPrompt(
      input.turnInput.messages,
      input.buildPrompt(promptStateView),
    ),
  };
}

function omitRecentRunCheckpoints(
  session: ReturnType<typeof shedSessionContext>,
): ReturnType<typeof shedSessionContext> {
  const { recentRunCheckpoints: _recentRunCheckpoints, ...rest } = session;
  return rest;
}

function appliedTimelinePressure(
  pressure: NonNullable<PromptRunContext["contextPressure"]>,
): NonNullable<PromptRunContext["contextPressure"]> {
  const { recommendedMode, ...rest } = pressure;
  return {
    ...rest,
    mode: "timeline_checkpoint",
    ...(recommendedMode && recommendedMode !== "timeline_checkpoint" ? { recommendedMode } : {}),
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
