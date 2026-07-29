import type {
  LlmToolChoice,
  LlmToolSchema,
} from "../../core/contracts/llm-protocol.js";
import type { AssistantTextToolCallViolation } from "./assistant-text-tool-call.js";
import type { AgentStateView } from "./state-view.js";

export interface DecisionToolChoicePolicy {
  directAssistantResponseAllowed: boolean;
  nativeToolCallRequired: boolean;
  toolChoice: LlmToolChoice;
}

export function resolveDecisionToolChoicePolicy(input: {
  stateView: AgentStateView;
  nativeTools: LlmToolSchema[];
  preferredNativeToolName?: string;
}): DecisionToolChoicePolicy {
  const directAssistantResponseAllowed = input.stateView.context.run?.mode?.allowedNext
    ?.includes("normal_reply") ?? true;
  const availableToolNames = new Set(input.nativeTools.map((tool) => tool.name));
  const preferredNativeToolName = input.preferredNativeToolName?.trim();
  const preferredToolAvailable = Boolean(
    preferredNativeToolName
    && availableToolNames.has(preferredNativeToolName),
  );
  const nativeToolCallRequired = input.nativeTools.length > 0
    && !directAssistantResponseAllowed;

  if (preferredToolAvailable && preferredNativeToolName) {
    return {
      directAssistantResponseAllowed,
      nativeToolCallRequired: true,
      toolChoice: { name: preferredNativeToolName },
    };
  }
  return {
    directAssistantResponseAllowed,
    nativeToolCallRequired,
    toolChoice: nativeToolCallRequired ? "required" : "auto",
  };
}

export function describeDecisionToolChoice(choice: LlmToolChoice): string {
  return typeof choice === "string"
    ? choice
    : `tool:${choice.name}`;
}

export function nativeToolRequiredAssistantViolation(
  nativeTools: LlmToolSchema[],
): AssistantTextToolCallViolation {
  return {
    kind: "assistant_text_tool_call",
    reason:
      "The current graph state requires one native tool call, but the provider returned assistant text.",
    inputKeys: [],
    selectedTools: nativeTools.map((tool) => tool.name),
  };
}
