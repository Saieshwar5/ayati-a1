import type {
  AssistantFeedbackKind,
  AssistantResponseKind,
  FinalizeRunRequest,
} from "../contracts.js";

export interface ResolvedAssistantResponseMetadata {
  responseKind: AssistantResponseKind;
  feedbackKind?: AssistantFeedbackKind;
}

export function resolveAssistantResponseMetadata(
  input: Pick<
    FinalizeRunRequest,
    "outcome" | "assistantResponseKind" | "assistantFeedbackKind"
  >,
): ResolvedAssistantResponseMetadata {
  const responseKind = input.assistantResponseKind
    ?? (input.outcome === "needs_user_input" ? "feedback" : "reply");
  if (input.assistantFeedbackKind && responseKind !== "feedback") {
    throw new Error("Assistant feedback kind requires a feedback response.");
  }
  const feedbackKind = input.assistantFeedbackKind
    ?? (input.outcome === "needs_user_input" ? "clarification" : undefined);
  return {
    responseKind,
    ...(feedbackKind ? { feedbackKind } : {}),
  };
}
