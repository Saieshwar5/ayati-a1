import type { ContextCheckpointPlan, ContextCheckpointRecord, StreamMessage } from "ayati-context-engine";
import type { LlmMessage, LlmTurnInput } from "../../core/contracts/llm-protocol.js";
import { projectAgentStateViewForPrompt } from "./prompt-context.js";
import type { AgentPromptStateView, PromptRunContext } from "./prompt-context.js";
import type { PromptToolCalls } from "./run-tool-call-context.js";
import type { AgentStateView } from "./state-view.js";
import { projectStateViewForStreamPressure } from "./stream-context-projection.js";
import type { AgentTemporalEvent } from "./agent-context-events.js";

export function buildCommittedStreamCheckpointTurnInput(input: {
  stateView: AgentStateView;
  turnInput: LlmTurnInput;
  plan: ContextCheckpointPlan;
  checkpoint: ContextCheckpointRecord;
  projectedToolCalls?: PromptToolCalls;
  buildPrompt: (stateView: AgentPromptStateView) => string;
}): LlmTurnInput {
  const pressureState = projectStateViewForStreamPressure(
    input.stateView,
    input.projectedToolCalls,
  );
  const run = pressureState.context.run;
  const exactTail = input.plan.exactTail.map((message) =>
    timelineMessage(message, input.stateView.context.current.inputSeq)
  );
  const projectedStateView: AgentStateView = {
    ...pressureState,
    context: {
      ...pressureState.context,
      temporal: {
        checkpoint: {
          coveredFromSeq: input.checkpoint.coveredFromSeq,
          coveredToSeq: input.checkpoint.coveredToSeq,
          summary: input.checkpoint.summary,
          exactAnchors: input.checkpoint.exactAnchors,
          createdAt: input.checkpoint.createdAt,
        },
        recent: exactTail,
      },
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

function timelineMessage(message: StreamMessage, currentSeq: number | undefined): AgentTemporalEvent {
  const current = message.sequence === currentSeq;
  if (message.role === "assistant") {
    return {
      kind: "assistant",
      seq: message.sequence,
      timestamp: message.at,
      content: message.content,
      ...(current ? { current: true } : {}),
    };
  }
  if (message.role === "system_event") {
    return {
      kind: "system",
      seq: message.sequence,
      timestamp: message.at,
      content: message.content,
      ...(current ? { current: true } : {}),
    };
  }
  return {
    kind: "user",
    seq: message.sequence,
    timestamp: message.at,
    content: message.content,
    ...(current ? { current: true } : {}),
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
