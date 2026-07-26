import type { ContextCheckpointPlan, ContextCheckpointRecord } from "ayati-context-engine";
import type { LlmMessage, LlmTurnInput } from "../../core/contracts/llm-protocol.js";
import { projectAgentStateViewForPrompt } from "./prompt-context.js";
import type { AgentPromptStateView, PromptRunContext } from "./prompt-context.js";
import type { PromptToolCalls } from "./run-tool-call-context.js";
import type { AgentStateView } from "./state-view.js";
import { projectStreamMessageEvent } from "./agent-context-events.js";
import { buildCoreCapsule } from "./core-capsule.js";

export function buildCommittedStreamCheckpointTurnInput(input: {
  stateView: AgentStateView;
  turnInput: LlmTurnInput;
  plan: ContextCheckpointPlan;
  checkpoint: ContextCheckpointRecord;
  projectedToolCalls?: PromptToolCalls;
  buildPrompt: (stateView: AgentPromptStateView) => string;
}): LlmTurnInput {
  const pressureState = projectCheckpointRunState(
    input.stateView,
    input.projectedToolCalls,
  );
  const run = pressureState.context.run;
  const exactTail = input.plan.exactTail.map((message) =>
    projectStreamMessageEvent(
      message,
      message.sequence === input.stateView.context.core.current.input.seq,
    )
  );
  const projectedStateView: AgentStateView = {
    ...pressureState,
    context: {
      ...pressureState.context,
      core: buildCoreCapsule({
        revision: input.stateView.context.core.revision,
        runId: input.stateView.context.core.current.runId,
        timeline: exactTail,
        checkpoint: input.checkpoint,
        ...(input.stateView.context.core.current.routing
          ? { routing: input.stateView.context.core.current.routing }
          : {}),
        ...(input.stateView.context.core.current.activeDocuments
          ? {
              activeDocuments:
                input.stateView.context.core.current.activeDocuments,
            }
          : {}),
        continuityMaxTokens: input.stateView.context.core.budget.continuityMaxTokens,
      }),
      ...(run ? {
        run: {
          ...run,
          ...(run.contextPressure ? {
            contextPressure: appliedCheckpointPressure(run.contextPressure),
          } : {}),
        },
      } : {}),
    },
  };
  return {
    ...input.turnInput,
    messages: replaceFirstUserPrompt(
      input.turnInput.messages,
      input.buildPrompt(projectAgentStateViewForPrompt(projectedStateView)),
    ),
  };
}

function projectCheckpointRunState(
  stateView: AgentStateView,
  projectedToolCalls: PromptToolCalls | undefined,
): AgentStateView {
  const run = stateView.context.run;
  if (!run || !projectedToolCalls) return stateView;
  return {
    ...stateView,
    context: {
      ...stateView.context,
      run: {
        ...run,
        toolCalls: projectedToolCalls,
      },
    },
  };
}

function appliedCheckpointPressure(
  pressure: NonNullable<PromptRunContext["contextPressure"]>,
): NonNullable<PromptRunContext["contextPressure"]> {
  const { recommendedMode, ...rest } = pressure;
  return {
    ...rest,
    mode: "stream_checkpoint",
    ...(recommendedMode && recommendedMode !== "stream_checkpoint" ? { recommendedMode } : {}),
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
