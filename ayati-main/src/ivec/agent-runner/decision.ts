import type { LlmProvider } from "../../core/contracts/provider.js";
import {
  isProviderEmptyResponseError,
  isProviderMalformedResponseError,
} from "../../core/contracts/provider-errors.js";
import type {
  ProviderEmptyResponseError,
  ProviderMalformedResponseError,
} from "../../core/contracts/provider-errors.js";
import type { LlmMessage, LlmToolCall, LlmToolSchema, LlmTurnOutput } from "../../core/contracts/llm-protocol.js";
import { agentTrace, isAgentTracePromptEnabled, tracePreview } from "../../shared/index.js";
import type { ToolContractAssertion, ToolDefinition } from "../../skills/types.js";
import type { AgentFeedbackLedger } from "../feedback-ledger.js";
import type { RunMetrics } from "../metrics.js";
import { recordPromptMetric, recordProviderUsageMetric, recordRunMetric } from "../metrics.js";
import { projectAgentStateViewForPrompt } from "./prompt-context.js";
import type { RepairCode, RepairSignal } from "./repair-policy.js";
import {
  createRepairSignal,
  repairSignalToFeedbackData,
  repairSignalToPromptText,
} from "./repair-policy.js";
import type { AgentStateView } from "./state-view.js";
import {
  summarizePromptStateView,
  summarizeToolDefinitions,
} from "./feedback-summary.js";

export type AgentDecisionStatus = "completed" | "failed";
export type AgentActionMode = "single" | "sequential" | "parallel";
export type TaskCompletionIntent = "not_completion" | "completion_candidate";

export interface AgentActionCompletion {
  intent: TaskCompletionIntent;
  reason?: string;
  expectedEvidence?: string[];
}

export interface AgentToolCallSpec {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  dependsOn: string[];
  purpose?: string;
}

export interface AgentAction {
  mode: AgentActionMode;
  calls: AgentToolCallSpec[];
  allowedTools: string[];
  assertions: ToolContractAssertion[];
  completion?: AgentActionCompletion;
}

export interface AgentToolLoadRequest {
  query?: string;
  toolNames: string[];
  groups: string[];
}

export type DecisionFailureKind =
  | "invalid_json"
  | "unsupported_decision_kind"
  | "tool_protocol_violation"
  | "assistant_text_tool_call"
  | "tool_input_schema_violation";

export type AgentDecision =
  | {
      kind: "reply";
      message: string;
      status: AgentDecisionStatus;
      workingNotes?: string[];
    }
  | {
      kind: "ask_user";
      question: string;
      reason: string;
      workingNotes?: string[];
    }
  | {
      kind: "act";
      action: AgentAction;
      workingNotes?: string[];
    }
  | {
      kind: "load_tools";
      request: AgentToolLoadRequest;
      workingNotes?: string[];
    };

interface CallAgentDecisionInput {
  provider: LlmProvider;
  stateView: AgentStateView;
  toolDefinitions: ToolDefinition[];
  toolRoutingSummary?: string;
  toolLoadingAvailable?: boolean;
  taskFeedbackToolAvailable?: boolean;
  systemContext?: string;
  metrics?: RunMetrics;
  feedbackLedger?: AgentFeedbackLedger;
  feedbackContext?: AgentDecisionFeedbackContext;
}

interface ToolProtocolViolation {
  kind: Extract<DecisionFailureKind, "tool_protocol_violation">;
  reason: string;
  invalidTools: string[];
  selectedTools: string[];
  loadToolsUsedAsAction: boolean;
}

interface ToolInputSchemaViolation {
  kind: Extract<DecisionFailureKind, "tool_input_schema_violation">;
  reason: string;
  selectedTools: string[];
  failures: Array<{
    callId: string;
    tool: string;
    error: string;
    inputKeys: string[];
    schema: Record<string, unknown>;
  }>;
}

interface AssistantTextToolCallViolation {
  kind: Extract<DecisionFailureKind, "assistant_text_tool_call">;
  reason: string;
  toolName?: string;
  inputKeys: string[];
  selectedTools: string[];
}

interface AgentDecisionFeedbackContext {
  clientId: string;
  sessionId: string;
  seq: number;
  runId?: string;
}

const MAX_DECISION_ATTEMPTS = 3;
const MAX_PROVIDER_EMPTY_RESPONSE_RETRIES = 1;
const PROVIDER_EMPTY_RESPONSE_RETRY_DELAY_MS = 400;
const TOOL_PROTOCOL_FAILURE_REPLY = "I could not form a valid tool call for this request.";
const TASK_FEEDBACK_TOOL_NAME = "ask_user_feedback";

export async function callAgentDecision(input: CallAgentDecisionInput): Promise<AgentDecision> {
  const promptStateView = projectAgentStateViewForPrompt(input.stateView);
  const promptSections = buildDecisionPromptSections(promptStateView, input.toolDefinitions, input.toolRoutingSummary);
  const prompt = Object.values(promptSections).filter((section) => section.trim().length > 0).join("\n\n");
  const systemSections = buildDecisionSystemSections(input.systemContext);
  const systemContext = Object.values(systemSections).filter((section) => section.trim().length > 0).join("\n\n");
  recordDecisionFeedback(input, "state_view_projected", {
    stateView: promptStateView,
    summary: summarizePromptStateView(promptStateView),
    selectedTools: summarizeToolDefinitions(input.toolDefinitions),
  });
  recordPromptMetric(input.metrics, "agent_decision", {
    "system.stableDecisionRules": systemSections.stableDecisionRules,
    "system.runtimeContext": systemSections.runtimeContext,
    ...promptSections,
  }, {
    stateBreakdown: buildStateViewPromptBreakdown(promptStateView),
  });

  let messages: LlmMessage[] = [
    { role: "system", content: systemContext },
    { role: "user", content: prompt },
  ];

  let rawText = "";
  for (let attempt = 0; attempt < MAX_DECISION_ATTEMPTS; attempt++) {
    const metricStage = attempt === 0 ? "agent_decision" : "agent_decision_repair";
    const startedAt = Date.now();
    let turn: LlmTurnOutput;
    traceDecisionProviderRequest(input.provider, messages, attempt);
    try {
      if (!input.provider.capabilities.nativeToolCalling) {
        throw new Error(`Provider ${input.provider.name} does not support native decision tools.`);
      }
      const decisionTools = buildNativeDecisionTools(input.toolDefinitions, {
        toolLoadingAvailable: input.toolLoadingAvailable !== false,
        taskFeedbackToolAvailable: input.taskFeedbackToolAvailable === true,
      });
      recordDecisionFeedback(input, "native_tool_surface", {
        attempt: attempt + 1,
        controlTools: decisionTools
          .filter((tool) => CONTROL_DECISION_TOOL_NAMES.has(tool.name))
          .map((tool) => tool.name),
        selectedTools: summarizeToolDefinitions(input.toolDefinitions),
        executableTools: input.toolDefinitions.map((tool) => ({
          name: tool.name,
          hasInputSchema: Boolean(tool.inputSchema),
          requiredFields: readSchemaRequiredFields(tool.inputSchema),
        })),
        nativeToolCount: decisionTools.length,
      });
      turn = await generateTurnWithEmptyResponseRetry(input, {
        messages,
        decisionTools,
        decisionAttempt: attempt + 1,
        requestStartedAt: startedAt,
      });
      recordRunMetric(input.metrics, metricStage, {
        durationMs: Date.now() - startedAt,
        kind: "llm",
        status: "success",
      });
      recordProviderUsageMetric(input.metrics, metricStage, turn.usage, turn.cost);
    } catch (error) {
      recordRunMetric(input.metrics, metricStage, {
        durationMs: Date.now() - startedAt,
        kind: "llm",
        status: "failed",
      });
      throw error;
    }
    traceDecisionProviderResponse(turn, attempt);

    const nativeDecision = turn.type === "tool_calls"
      ? nativeDecisionFromToolCalls(turn.calls, input.toolDefinitions)
      : null;
    rawText = turn.type === "assistant"
      ? turn.content.trim()
      : typeof nativeDecision === "string"
        ? nativeDecision
        : serializeNativeDecisionToolCalls(turn.calls, input.toolDefinitions);
    agentTrace("agent_decision", `attempt=${attempt + 1} raw_response=${tracePreview(rawText)}`);
    recordDecisionFeedback(input, "raw_response", {
      attempt: attempt + 1,
      turnType: turn.type,
      rawResponse: rawText,
      ...(turn.type === "tool_calls" ? { toolCalls: summarizeNativeToolCalls(turn.calls, input.toolDefinitions) } : {}),
    });

    try {
      const assistantTextToolCallViolation = turn.type === "assistant"
        ? detectAssistantTextToolCall(rawText, input.toolDefinitions)
        : null;
      if (assistantTextToolCallViolation) {
        const repair = createAssistantTextToolCallRepairSignal(assistantTextToolCallViolation, attempt + 1);
        agentTrace(
          "agent_decision",
          `attempt=${attempt + 1} assistant_text_tool_call reason=${assistantTextToolCallViolation.reason}`,
        );
        recordDecisionFeedback(input, "assistant_text_tool_call", {
          attempt: attempt + 1,
          ...assistantTextToolCallViolation,
          ...repairSignalToFeedbackData(repair),
        });
        if (attempt >= MAX_DECISION_ATTEMPTS - 1) {
          agentTrace("agent_decision", `attempt=${attempt + 1} assistant_text_tool_call_failed_fallback`);
          recordDecisionFeedback(input, "failed_fallback", {
            attempt: attempt + 1,
            reason: assistantTextToolCallViolation.reason,
            ...repairSignalToFeedbackData(repair),
          });
          return {
            kind: "reply",
            status: "failed",
            message: TOOL_PROTOCOL_FAILURE_REPLY,
          };
        }
        agentTrace("agent_decision", `attempt=${attempt + 1} repair_request reason=assistant_text_tool_call`);
        recordDecisionFeedback(input, "repair_requested", {
          attempt: attempt + 1,
          reason: "assistant_text_tool_call",
          violation: assistantTextToolCallViolation,
          ...repairSignalToFeedbackData(repair),
        });
        messages = buildRepairMessages(messages, rawText, repairPromptText(repair));
        continue;
      }

      const directReply = turn.type === "assistant" ? directAssistantReplyDecision(rawText) : null;
      if (directReply) {
        agentTrace("agent_decision", `attempt=${attempt + 1} direct_reply`);
        recordDecisionFeedback(input, "direct_reply", {
          attempt: attempt + 1,
          message: directReply.message,
        });
        return directReply;
      }
      const decision = nativeDecision && typeof nativeDecision !== "string"
        ? nativeDecision
        : parseAgentDecision(rawText);
      agentTrace("agent_decision", `attempt=${attempt + 1} parsed_decision kind=${decision.kind}`);
      recordDecisionFeedback(input, "parsed", {
        attempt: attempt + 1,
        decision: summarizeDecisionForFeedback(decision),
      });
      const violation = validateToolProtocol(decision, input.toolDefinitions, {
        toolLoadingAvailable: input.toolLoadingAvailable !== false,
        taskFeedbackToolAvailable: input.taskFeedbackToolAvailable === true,
      });
      if (violation) {
        const repair = createToolProtocolRepairSignal(violation, attempt + 1);
        agentTrace(
          "agent_decision",
          `attempt=${attempt + 1} tool_protocol_violation reason=${violation.reason} invalidTools=${violation.invalidTools.join(",") || "(none)"}`,
        );
        recordDecisionFeedback(input, "protocol_violation", {
          attempt: attempt + 1,
          ...violation,
          ...repairSignalToFeedbackData(repair),
        });
        if (attempt >= MAX_DECISION_ATTEMPTS - 1) {
          agentTrace("agent_decision", `attempt=${attempt + 1} tool_protocol_failed_fallback`);
          recordDecisionFeedback(input, "failed_fallback", {
            attempt: attempt + 1,
            reason: violation.reason,
            ...repairSignalToFeedbackData(repair),
          });
          return {
            kind: "reply",
            status: "failed",
            message: TOOL_PROTOCOL_FAILURE_REPLY,
          };
        }
        agentTrace("agent_decision", `attempt=${attempt + 1} repair_request reason=tool_protocol_violation`);
        recordDecisionFeedback(input, "repair_requested", {
          attempt: attempt + 1,
          reason: "tool_protocol_violation",
          violation,
          ...repairSignalToFeedbackData(repair),
        });
        messages = buildRepairMessages(messages, rawText, repairPromptText(repair));
        continue;
      }

      const inputViolation = validateToolInputSchemas(decision, input.toolDefinitions);
      if (!inputViolation) {
        return decision;
      }

      agentTrace(
        "agent_decision",
        `attempt=${attempt + 1} tool_input_schema_violation reason=${inputViolation.reason}`,
      );
      const repair = createToolInputSchemaRepairSignal(inputViolation, attempt + 1);
      recordDecisionFeedback(input, "input_schema_violation", {
        attempt: attempt + 1,
        ...inputViolation,
        ...repairSignalToFeedbackData(repair),
      });
      if (attempt >= MAX_DECISION_ATTEMPTS - 1) {
        agentTrace("agent_decision", `attempt=${attempt + 1} tool_input_schema_failed_fallback`);
        recordDecisionFeedback(input, "failed_fallback", {
          attempt: attempt + 1,
          reason: inputViolation.reason,
          ...repairSignalToFeedbackData(repair),
        });
        return {
          kind: "reply",
          status: "failed",
          message: `I could not form a valid tool call for this request. ${inputViolation.reason}`,
        };
      }
      agentTrace("agent_decision", `attempt=${attempt + 1} repair_request reason=tool_input_schema_violation`);
      recordDecisionFeedback(input, "repair_requested", {
        attempt: attempt + 1,
        reason: "tool_input_schema_violation",
        violation: inputViolation,
        ...repairSignalToFeedbackData(repair),
      });
      messages = buildRepairMessages(messages, rawText, repairPromptText(repair));
      continue;
    } catch (error) {
      const repair = createParseFailedRepairSignal(error, attempt + 1);
      agentTrace(
        "agent_decision",
        `attempt=${attempt + 1} parse_failed error=${error instanceof Error ? error.message : String(error)}`,
      );
      recordDecisionFeedback(input, "parse_failed", {
        attempt: attempt + 1,
        error: error instanceof Error ? error.message : String(error),
        ...repairSignalToFeedbackData(repair),
      });
      if (attempt >= 1) {
        throw error;
      }
      agentTrace("agent_decision", `attempt=${attempt + 1} repair_request reason=parse_failed`);
      recordDecisionFeedback(input, "repair_requested", {
        attempt: attempt + 1,
        reason: "parse_failed",
        ...repairSignalToFeedbackData(repair),
      });
      messages = buildRepairMessages(
        messages,
        rawText,
        repairPromptText(repair),
      );
    }
  }

  return parseAgentDecision(rawText);
}

async function generateTurnWithEmptyResponseRetry(
  input: CallAgentDecisionInput,
  request: {
    messages: LlmMessage[];
    decisionTools: LlmToolSchema[];
    decisionAttempt: number;
    requestStartedAt: number;
  },
): Promise<LlmTurnOutput> {
  let providerAttempt = 0;

  for (;;) {
    providerAttempt++;
    try {
      return await input.provider.generateTurn({
        messages: request.messages,
        tools: request.decisionTools,
        toolChoice: "auto",
        parallelToolCalls: false,
      });
    } catch (error) {
      const responseFailure = providerResponseFailureDetails(error);
      if (!responseFailure) {
        throw error;
      }

      const willRetry = providerAttempt <= MAX_PROVIDER_EMPTY_RESPONSE_RETRIES;
      const repair = createRepairSignal(responseFailure.repairCode, {
        operatorDetails: {
          attempt: request.decisionAttempt,
          providerAttempt,
          provider: responseFailure.provider,
          model: responseFailure.model,
          latencyMs: Date.now() - request.requestStartedAt,
          ...responseFailure.operatorDetails,
          toolChoice: "auto",
          nativeToolCount: request.decisionTools.length,
          requestMode: request.decisionTools.length > 0 ? "tools" : "text",
          willRetry,
          ...(willRetry ? { retryDelayMs: PROVIDER_EMPTY_RESPONSE_RETRY_DELAY_MS } : {}),
        },
      });
      recordDecisionFeedback(input, responseFailure.event, {
        attempt: request.decisionAttempt,
        providerAttempt,
        provider: responseFailure.provider,
        model: responseFailure.model,
        latencyMs: Date.now() - request.requestStartedAt,
        ...responseFailure.operatorDetails,
        toolChoice: "auto",
        nativeToolCount: request.decisionTools.length,
        requestMode: request.decisionTools.length > 0 ? "tools" : "text",
        willRetry,
        ...(willRetry ? { retryDelayMs: PROVIDER_EMPTY_RESPONSE_RETRY_DELAY_MS } : {}),
        ...repairSignalToFeedbackData(repair),
      });

      if (!willRetry) {
        throw error;
      }
      await delay(PROVIDER_EMPTY_RESPONSE_RETRY_DELAY_MS);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function providerResponseFailureDetails(error: unknown): {
  event: "provider_empty_response" | "provider_malformed_response";
  repairCode: "R_PROVIDER_EMPTY_RESPONSE" | "R_PROVIDER_MALFORMED_RESPONSE";
  provider: string;
  model?: string;
  operatorDetails: Record<string, unknown>;
} | undefined {
  if (isProviderEmptyResponseError(error)) {
    return providerEmptyResponseFailureDetails(error);
  }
  if (isProviderMalformedResponseError(error)) {
    return providerMalformedResponseFailureDetails(error);
  }
  return undefined;
}

function providerEmptyResponseFailureDetails(error: ProviderEmptyResponseError): {
  event: "provider_empty_response";
  repairCode: "R_PROVIDER_EMPTY_RESPONSE";
  provider: string;
  model?: string;
  operatorDetails: Record<string, unknown>;
} {
  return {
    event: "provider_empty_response",
    repairCode: "R_PROVIDER_EMPTY_RESPONSE",
    provider: error.details.provider,
    model: error.details.model,
    operatorDetails: {
      choiceCount: error.details.choiceCount,
      responseKeys: error.details.responseKeys ?? [],
      finishReason: error.details.finishReason,
    },
  };
}

function providerMalformedResponseFailureDetails(error: ProviderMalformedResponseError): {
  event: "provider_malformed_response";
  repairCode: "R_PROVIDER_MALFORMED_RESPONSE";
  provider: string;
  model?: string;
  operatorDetails: Record<string, unknown>;
} {
  return {
    event: "provider_malformed_response",
    repairCode: "R_PROVIDER_MALFORMED_RESPONSE",
    provider: error.details.provider,
    model: error.details.model,
    operatorDetails: {
      errorName: error.details.errorName,
      errorMessage: error.details.errorMessage,
    },
  };
}

function recordDecisionFeedback(
  input: CallAgentDecisionInput,
  event: string,
  data: Record<string, unknown>,
): void {
  if (!input.feedbackLedger || !input.feedbackContext) {
    return;
  }
  input.feedbackLedger.record({
    ...input.feedbackContext,
    stage: "decision",
    event,
    data,
  });
}

function summarizeDecisionForFeedback(decision: AgentDecision): Record<string, unknown> {
  if (decision.kind === "reply") {
    return {
      kind: decision.kind,
      status: decision.status,
      message: decision.message,
    };
  }
  if (decision.kind === "ask_user") {
    return {
      kind: decision.kind,
      question: decision.question,
      reason: decision.reason,
    };
  }
  if (decision.kind === "load_tools") {
    return {
      kind: decision.kind,
      request: decision.request,
    };
  }
  return {
    kind: decision.kind,
    mode: decision.action.mode,
    calls: decision.action.calls.map((call) => ({
      id: call.id,
      tool: call.tool,
      input: summarizeToolInput(call.input),
      dependsOn: call.dependsOn,
      purpose: call.purpose,
    })),
    allowedTools: decision.action.allowedTools,
  };
}

function buildRepairMessages(messages: LlmMessage[], rawText: string, prompt: string): LlmMessage[] {
  return [
    ...messages,
    { role: "assistant", content: rawText },
    {
      role: "user",
      content: prompt,
    },
  ];
}

function repairPromptText(signal: RepairSignal): string {
  return repairSignalToPromptText(signal)
    ?? `Repair code: ${signal.code}\nProblem: ${signal.message}`;
}

function createAssistantTextToolCallRepairSignal(
  violation: AssistantTextToolCallViolation,
  attempt: number,
): RepairSignal {
  return createRepairSignal("R_ASSISTANT_TEXT_TOOL_CALL", {
    blockedTargets: violation.toolName ? [violation.toolName] : [],
    operatorDetails: {
      attempt,
      reason: violation.reason,
      ...(violation.toolName ? { toolName: violation.toolName } : {}),
      inputKeys: violation.inputKeys,
      selectedTools: violation.selectedTools,
    },
  });
}

function createToolProtocolRepairSignal(violation: ToolProtocolViolation, attempt: number): RepairSignal {
  const code = toolProtocolRepairCode(violation);
  return createRepairSignal(code, {
    blockedTargets: violation.invalidTools,
    operatorDetails: {
      attempt,
      reason: violation.reason,
      invalidTools: violation.invalidTools,
      selectedTools: violation.selectedTools,
      loadToolsUsedAsAction: violation.loadToolsUsedAsAction,
    },
  });
}

function toolProtocolRepairCode(violation: ToolProtocolViolation): RepairCode {
  if (violation.invalidTools.includes(TASK_FEEDBACK_TOOL_NAME)) {
    return "R_TASK_FEEDBACK_UNAVAILABLE";
  }
  if (violation.reason.includes("no tool calls")) {
    return "R_NO_PROGRESS";
  }
  if (violation.loadToolsUsedAsAction) {
    return "R_LOAD_TOOLS_USED_AS_ACTION";
  }
  if (violation.reason.includes("load_tools request must include")) {
    return "R_EMPTY_TOOL_LOAD_SELECTOR";
  }
  if (violation.invalidTools.length > 0) {
    return "R_TOOL_NOT_SELECTED";
  }
  return "R_TOOL_INPUT_INVALID";
}

function createToolInputSchemaRepairSignal(violation: ToolInputSchemaViolation, attempt: number): RepairSignal {
  const missingFields = uniqueStrings(violation.failures.flatMap((failure) => extractMissingRequiredFields(failure.error)));
  const code: RepairCode = missingFields.length > 0
    ? "R_TOOL_INPUT_MISSING_REQUIRED_FIELD"
    : "R_TOOL_INPUT_INVALID";
  return createRepairSignal(code, {
    blockedTargets: violation.failures.map((failure) => failure.tool),
    missingFields,
    invalidFields: missingFields.length > 0
      ? []
      : uniqueStrings(violation.failures.flatMap((failure) => extractInvalidFields(failure.error))),
    operatorDetails: {
      attempt,
      reason: violation.reason,
      selectedTools: violation.selectedTools,
      failures: violation.failures,
    },
  });
}

function createParseFailedRepairSignal(error: unknown, attempt: number): RepairSignal {
  const message = error instanceof Error ? error.message : String(error);
  const code: RepairCode = message.includes("expected exactly one native tool call")
    ? "R_MULTIPLE_NATIVE_TOOL_CALLS"
    : "R_PARSE_FAILED";
  return createRepairSignal(code, {
    operatorDetails: {
      attempt,
      error: message,
    },
  });
}

function extractMissingRequiredFields(error: string): string[] {
  const matches = [...error.matchAll(/missing required field '([^']+)'/g)];
  return matches.map((match) => match[1]).filter((field): field is string => Boolean(field));
}

function extractInvalidFields(error: string): string[] {
  const matches = [...error.matchAll(/field '([^']+)' expected type/g)];
  return matches.map((match) => match[1]).filter((field): field is string => Boolean(field));
}

function validateToolProtocol(
  decision: AgentDecision,
  selectedToolDefinitions: ToolDefinition[],
  options: {
    toolLoadingAvailable: boolean;
    taskFeedbackToolAvailable: boolean;
  },
): ToolProtocolViolation | null {
  const selectedTools = selectedToolDefinitions.map((tool) => tool.name);
  if (decision.kind === "ask_user" && !options.taskFeedbackToolAvailable) {
    return {
      kind: "tool_protocol_violation",
      reason: "ask_user_feedback is only available during an active task run",
      invalidTools: [TASK_FEEDBACK_TOOL_NAME],
      selectedTools,
      loadToolsUsedAsAction: false,
    };
  }
  if (decision.kind === "load_tools") {
    if (!options.toolLoadingAvailable) {
      return {
        kind: "tool_protocol_violation",
        reason: "decision_load_tools is not available in the current runtime mode",
        invalidTools: ["decision_load_tools"],
        selectedTools,
        loadToolsUsedAsAction: false,
      };
    }
    const hasSelector = Boolean(decision.request.query?.trim())
      || decision.request.toolNames.length > 0
      || decision.request.groups.length > 0;
    if (hasSelector) {
      return null;
    }
    return {
      kind: "tool_protocol_violation",
      reason: "load_tools request must include at least one non-empty selector: groups, toolNames, or query",
      invalidTools: [],
      selectedTools,
      loadToolsUsedAsAction: false,
    };
  }

  if (decision.kind !== "act") {
    return null;
  }

  const selectedToolSet = new Set(selectedTools);
  const invalidCallTools = decision.action.calls
    .map((call) => call.tool)
    .filter((tool) => tool === "load_tools" || !selectedToolSet.has(tool));
  const invalidAllowedTools = decision.action.allowedTools.filter((tool) => tool === "load_tools" || !selectedToolSet.has(tool));
  const invalidTools = uniqueStrings([...invalidCallTools, ...invalidAllowedTools]);
  const loadToolsUsedAsAction = decision.action.calls.some((call) => call.tool === "load_tools");

  if (decision.action.calls.length === 0) {
    return {
      kind: "tool_protocol_violation",
      reason: "act decision contained no tool calls",
      invalidTools,
      selectedTools,
      loadToolsUsedAsAction,
    };
  }

  if (invalidTools.length === 0 && !loadToolsUsedAsAction) {
    return null;
  }

  return {
    kind: "tool_protocol_violation",
    reason: loadToolsUsedAsAction
      ? "load_tools was used as an action tool"
      : "act decision referenced tools not listed in Selected tools",
    invalidTools,
    selectedTools,
    loadToolsUsedAsAction,
  };
}

function validateToolInputSchemas(
  decision: AgentDecision,
  selectedToolDefinitions: ToolDefinition[],
): ToolInputSchemaViolation | null {
  if (decision.kind !== "act") {
    return null;
  }

  const selectedTools = selectedToolDefinitions.map((tool) => tool.name);
  const byName = new Map(selectedToolDefinitions.map((tool) => [tool.name, tool]));
  const failures: ToolInputSchemaViolation["failures"] = [];

  for (const call of decision.action.calls) {
    const tool = byName.get(call.tool);
    if (!tool?.inputSchema) {
      continue;
    }
    const validationError = validateInputAgainstSchema(call.tool, call.input, tool.inputSchema);
    if (validationError) {
      failures.push({
        callId: call.id,
        tool: call.tool,
        error: validationError,
        inputKeys: Object.keys(call.input),
        schema: tool.inputSchema,
      });
    }
  }

  if (failures.length === 0) {
    return null;
  }

  return {
    kind: "tool_input_schema_violation",
    reason: failures.map((failure) => `${failure.tool}.${failure.callId}: ${failure.error}`).join("; "),
    selectedTools,
    failures,
  };
}

function validateInputAgainstSchema(
  toolName: string,
  input: Record<string, unknown>,
  schema: Record<string, unknown>,
): string | null {
  const required = Array.isArray(schema["required"]) ? schema["required"].map(String) : [];
  const properties = isPlainObject(schema["properties"])
    ? schema["properties"] as Record<string, Record<string, unknown>>
    : {};

  for (const field of required) {
    if (input[field] === undefined || input[field] === null) {
      return `Invalid input for '${toolName}': missing required field '${field}'`;
    }
  }

  for (const [field, value] of Object.entries(input)) {
    const property = properties[field];
    const expectedType = typeof property?.["type"] === "string" ? property["type"] : undefined;
    if (expectedType && !matchesJsonSchemaType(value, expectedType)) {
      return `Invalid input for '${toolName}': field '${field}' expected type '${expectedType}', got '${describeJsonType(value)}'`;
    }
  }

  return null;
}

function matchesJsonSchemaType(value: unknown, expectedType: string): boolean {
  if (expectedType === "array") return Array.isArray(value);
  if (expectedType === "integer") return typeof value === "number" && Number.isInteger(value);
  if (expectedType === "number") return typeof value === "number" && Number.isFinite(value);
  if (expectedType === "object") return isPlainObject(value);
  if (expectedType === "string") return typeof value === "string";
  if (expectedType === "boolean") return typeof value === "boolean";
  return true;
}

function describeJsonType(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function summarizeToolInput(input: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(input);
  return {
    keys,
    empty: keys.length === 0,
    summary: keys.length === 0
      ? "empty object"
      : keys.map((key) => `${key}:${describeJsonType(input[key])}`).join(", "),
  };
}

function traceDecisionProviderRequest(
  provider: LlmProvider,
  messages: LlmMessage[],
  attempt: number,
): void {
  agentTrace(
    "agent_decision",
    `attempt=${attempt + 1} provider_request provider=${provider.name} version=${provider.version} nativeDecisionTools=auto messages=${messages.length}`,
  );
  if (isAgentTracePromptEnabled()) {
    agentTrace("agent_decision", `attempt=${attempt + 1} prompt=${tracePreview(messages)}`);
  }
}

function traceDecisionProviderResponse(turn: LlmTurnOutput, attempt: number): void {
  const usage = turn.usage
    ? ` usage=${turn.usage.provider}:${turn.usage.model} input=${turn.usage.inputTokens} output=${turn.usage.outputTokens} total=${turn.usage.totalTokens}`
    : "";
  agentTrace("agent_decision", `attempt=${attempt + 1} provider_response type=${turn.type}${usage}`);
}

function directAssistantReplyDecision(text: string): Extract<AgentDecision, { kind: "reply" }> | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  if (looksLikeStructuredDecision(trimmed)) {
    return null;
  }
  return {
    kind: "reply",
    status: "completed",
    message: trimmed,
  };
}

function looksLikeStructuredDecision(text: string): boolean {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("native_decision_error:")) {
    return true;
  }
  const parsed = parseJsonRecord(trimmed);
  return typeof parsed?.["kind"] === "string" || looksLikeToolCallRecord(parsed);
}

function detectAssistantTextToolCall(
  text: string,
  selectedTools: ToolDefinition[],
): AssistantTextToolCallViolation | null {
  const internalAction = detectInternalActionTextToolCall(text, selectedTools);
  if (internalAction) {
    return internalAction;
  }

  const parsed = parseJsonRecord(text);
  if (!looksLikeToolCallRecord(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const toolName = readToolLikeName(record);
  const input = readToolLikeInput(record);
  return {
    kind: "assistant_text_tool_call",
    reason: "Assistant text contained JSON shaped like a tool call. Native tools must be called through provider tool calling, not printed as text.",
    ...(toolName ? { toolName } : {}),
    inputKeys: Object.keys(input ?? {}),
    selectedTools: selectedTools.map((tool) => tool.name),
  };
}

function detectInternalActionTextToolCall(
  text: string,
  selectedTools: ToolDefinition[],
): AssistantTextToolCallViolation | null {
  const trimmed = text.trimStart();
  if (parseJsonRecord(trimmed)) {
    return null;
  }
  if (!trimmed.startsWith("{") || !/"kind"\s*:\s*"act"/.test(trimmed)) {
    return null;
  }
  if (!/"action"\s*:/.test(trimmed) && !/"allowedTools"\s*:/.test(trimmed) && !/"calls"\s*:/.test(trimmed)) {
    return null;
  }
  const selectedToolNames = selectedTools.map((tool) => tool.name);
  const toolName = extractInternalActionToolName(trimmed, selectedToolNames);
  return {
    kind: "assistant_text_tool_call",
    reason: "Assistant text contained internal action JSON. Executable work must use provider native tool calling, not printed harness JSON.",
    ...(toolName ? { toolName } : {}),
    inputKeys: [],
    selectedTools: selectedToolNames,
  };
}

function extractInternalActionToolName(text: string, selectedToolNames: string[]): string | undefined {
  const allowedMatch = text.match(/"allowedTools"\s*:\s*\[\s*"([^"]+)"/);
  if (allowedMatch?.[1]) {
    return allowedMatch[1];
  }
  const toolMatch = text.match(/"tool"\s*:\s*"([^"]+)"/);
  if (toolMatch?.[1]) {
    return toolMatch[1];
  }
  return selectedToolNames.find((tool) => text.includes(`"${tool}"`) || text.includes(tool));
}

function looksLikeToolCallRecord(value: unknown): boolean {
  if (!isPlainObject(value)) {
    return false;
  }
  if (typeof value["kind"] === "string") {
    return false;
  }
  const hasToolName = typeof value["tool"] === "string" || typeof value["name"] === "string";
  const hasInput = isPlainObject(value["arguments"]) || isPlainObject(value["input"]);
  return hasToolName && hasInput;
}

function readToolLikeName(record: Record<string, unknown>): string | undefined {
  const name = typeof record["tool"] === "string" ? record["tool"] : record["name"];
  return typeof name === "string" && name.trim().length > 0 ? name.trim() : undefined;
}

function readToolLikeInput(record: Record<string, unknown>): Record<string, unknown> | undefined {
  if (isPlainObject(record["arguments"])) {
    return record["arguments"];
  }
  if (isPlainObject(record["input"])) {
    return record["input"];
  }
  return undefined;
}

export function parseAgentDecision(text: string): AgentDecision {
  const parsed = extractJsonObject(text);
  const kind = parsed["kind"];

  if (kind === "reply") {
    return {
      kind: "reply",
      message: String(parsed["message"] ?? ""),
      status: parsed["status"] === "failed" ? "failed" : "completed",
      workingNotes: normalizeWorkingNotes(parsed["workingNotes"]),
    };
  }

  if (kind === "ask_user") {
    return {
      kind: "ask_user",
      question: String(parsed["question"] ?? ""),
      reason: String(parsed["reason"] ?? ""),
      workingNotes: normalizeWorkingNotes(parsed["workingNotes"]),
    };
  }

  if (kind === "act") {
    return {
      kind: "act",
      action: normalizeAgentAction(parsed["action"]),
      workingNotes: normalizeWorkingNotes(parsed["workingNotes"]),
    };
  }

  if (kind === "load_tools") {
    return {
      kind: "load_tools",
      request: normalizeToolLoadRequest(parsed["request"] ?? parsed),
      workingNotes: normalizeWorkingNotes(parsed["workingNotes"]),
    };
  }

  throw new SyntaxError(`Unsupported agent decision kind: ${String(kind)}`);
}

const STABLE_DECISION_SYSTEM_CONTEXT = `You are the decision component of an AI agent harness.
Choose the next agent decision only. Use native tool calls; the harness executes tools locally.
Prefer deterministic actions with concrete tool inputs.
Use the structured context pack and optional work state in the state view.
Use direct assistant text for normal terminal replies. Use native tool calls only for tool loading, executable work, or task-run feedback requests.

Decision rules:
- Return direct assistant text for normal user-facing replies, including greetings, explanations, summaries, poems, stories, and final answers after completed work.
- Call exactly one native tool only when work needs tool loading, executable action, or task-run feedback.
- Available control tools are decision_load_tools and, only during an active task run, ask_user_feedback.
- Treat State view.context as the bounded context pack for this decision.
- Use context.timeline as chronological conversation context. The item with current=true is the current input.
- Use the immediately preceding assistant item in context.timeline to interpret short replies like yes, no, do it, go ahead, continue, or stop.
- Prefer the grouped context paths: context.git for session/task memory, context.scratch for current-run state, context.tools for active tool state, and context.personal for long-lived user memory.
- Use context.git.current.task as the durable task/work state when present. Continue from task.identity, task.state, task.assets, and task.activity.
- Use context.git.current.focus to understand whether the runtime selected an existing work branch or created/kept current work.
- Use context.git.session.meta for session identity, context.git.session.attachments for user-provided session inputs, and context.git.session.activity for recent session activity.
- Use context.git.session.summary as compressed session history. Use context.timeline for exact recent messages and current input. If summary and exact conversation conflict, trust context.timeline.
- Treat context.git.session.summary as an aid, not a complete source of truth; do not infer omitted details from it.
- Task routing tools may be visible briefly at the start of a run. Before task work, decide whether the current request belongs to the current active task, a different existing task, a new task, or no task.
- If the request clearly continues the current active task, continue directly with normal task tools; do not call a routing tool just to confirm the active task.
- If task ownership may belong to a different existing task, use git-context task search/read tools and then activate/switch only when there is a clear match.
- If the request starts clear durable work with a concrete deliverable and enough detail to begin now, use git_context_create_task_for_turn. If an active task exists, create a new task only for clearly separate work and include whyNotActiveTask plus separateTaskReason; otherwise activate the active/existing task or ask clarification. If the user is still exploring, brainstorming, or vague, reply directly with one short clarifying question instead of creating a task.
- Visible routing tools are optional routing aids, not an instruction to create, switch, or ask clarification.
- Normal work tools require a task run. If no task run exists, reply directly, ask a short clarification, or use git-context routing tools to create or activate the right task first.
- If context.git.current.pendingTurn.routingStatus is "unbound", route the pending turn before normal task work. Use git-context read/search tools, then git_context_activate_task_for_turn, git_context_create_task_for_turn, or git_context_ask_clarification_for_turn. Do not call shell, filesystem, document, database, Python, UI, or other task tools while the pending turn is unbound.
- If context.git.current.pendingTurn.routingStatus is "clarifying", do not call executable tools or load more tools. Ask the user directly what task or target they mean.
- If context.git.current.pendingTurn.routingStatus is "bound", normal task tools may be used according to the selected task context.
- Do not mention git branches, commits, refs, or context-engine mechanics to the user unless they explicitly ask about the implementation.
- If git context is ambiguous, the app runtime should ask the user before this decision runs; do not guess between multiple possible tasks.
- Treat context.scratch.progress as the authoritative current task progress. It may be absent on the first decision.
- Use context.scratch.feedback as the latest harness feedback. Correct the specific failed tool call or protocol issue before trying a different path.
- Use context.scratch.observations.latest as the latest real tool output cards. If these cards answer the user, reply instead of rerunning equivalent tools.
- Treat observations as hot bounded context. Respect each card's retention: next_step is temporary, while_relevant can guide nearby work, and evidence_only means use evidence tools before relying on the preview.
- Use context.scratch.trace.recentSteps only as compact execution history, not as evidence.
- Use context.scratch.trace.recentFailures to avoid repeating failed paths.
- Use context.tools.active and context.tools.lastLoad as compact tool availability state. Full executable schemas are provided as native tools, not inside context.
- Use context.personal.memorySnapshot for long-lived user preferences or facts when present.
- Legacy fields such as context.gitContext, State view.progress, State view.workingFeedback, State view.observations, and State view.trace may still exist for compatibility; prefer the grouped context paths above.
- Do not use workingNotes as factual memory; the harness owns tool-output context.
- Use evidence tools for truncated, chunked, or evidence_only output before rerunning the original output-producing tool.
- If context.scratch.progress.status is "done", return a direct reply. Do not call more tools.
- Autonomous execution policy: for actionable user requests, prefer progress over discussion.
- Treat preference gaps as assumptions, not blockers, when reasonable safe defaults exist.
- Treat short confirmations or delegation like "yes", "go ahead", "continue", "do it", "whatever feels right", and "surprise me" as permission to proceed with reasonable defaults.
- Use direct assistant text only as a terminal response: pure conversation, final answer after completed work, failed task, or impossible task.
- Evidence-before-done rule: for durable work requests, a final direct reply is allowed only after observed tool output or verified task state shows the work is complete. Durable work includes creating, editing, deleting, saving, building, running, testing, fixing, or changing files, code, docs, apps, websites, or workspace state. If durable work remains, call the appropriate selected tool or routing tool instead of replying.
- Do not use direct assistant text to say you will do future work. If work remains, call a selected executable tool or decision_load_tools.
- Final replies must answer the user's request in natural, human-readable language.
- Do not mention internal execution details in final replies: tool calls, deterministic verification, evidence contracts, assertions, reducers, work state, or harness steps.
- Use user-visible results from observations and trace summaries, such as created paths, changed files, command results, document findings, or next steps.
- Use ask_user_feedback only during an active task run, and only for hard blockers: missing target with no safe default, destructive or irreversible action, credentials or approval required, external cost/account action, or true ambiguity where the wrong choice would likely waste substantial work.
- Do not use ask_user_feedback for final responses, casual chat, pre-task planning, style, wording, organization, or preference choices when reasonable defaults can satisfy the request.
- Before a task run exists, ask planning or context questions directly in assistant text.
- For tool work, call the selected executable tool directly. Never wrap executable calls inside another tool.
- Use decision_load_tools when the visible selected tools are not enough for the next action. Do not tell the user tools are missing.
- decision_load_tools must include a non-empty selector: exact toolNames when known, groups when a group fits, or query when uncertain.
- Tool protocol has two separate phases: decision_load_tools only changes the visible tool set for a later decision; selected executable tools perform work.
- decision_load_tools is a meta decision tool, not an executable tool.
- If Selected tools is "(none)" and work remains, call decision_load_tools instead of replying that you will do work later.
- Executable tool calls may use only tool names listed under Selected tools.
- Keep each model decision to one executable tool call. The harness will continue the loop for follow-up calls after observing the result.
- Use only tools listed in Selected tools.
- Prefer write_files for generated websites, apps, and multi-file file creation.
- Hidden tools are loaded by decision_load_tools, not by calling skill_search or skill_activate unless those are explicitly selected executable tools.
- Do not include assertions. Tool-owned contracts provide deterministic verification.
- Every executable tool call must include taskCompletion.
- Set taskCompletion.intent to "not_completion" for preparation, inspection, context gathering, partial edits, setup, or actions that still require later verification.
- Set taskCompletion.intent to "completion_candidate" only when that exact tool call should satisfy the current user request if it succeeds.
- For read-only analysis tasks, gather evidence with tools and finish with direct assistant text when the answer is ready.
- For UI/layout fixes, use "not_completion" when an edit still needs screenshot, build, or test verification.

Control tool shapes:
- decision_load_tools({ "query": "...", "toolNames": ["read_file"], "groups": ["workflow:code_edit"] })
- ask_user_feedback({ "question": "...", "reason": "..." }) only when exposed during an active task run

Tool protocol examples:
- Bad when shell is not selected: calling shell or trying to use load_tools as executable work.
- Good instead: decision_load_tools({ "groups": ["skill:shell"] }).
- Good after shell appears in Selected tools: call shell directly with its required input schema.
- Good when write_files is selected: call write_files directly with files, createDirs, and taskCompletion.`;

function buildDecisionSystemSections(systemContext: string | undefined): Record<string, string> {
  const trimmed = systemContext?.trim();
  if (!trimmed) {
    return {
      stableDecisionRules: STABLE_DECISION_SYSTEM_CONTEXT,
      runtimeContext: "",
    };
  }
  const compact = trimmed.length > 6_000
    ? `${trimmed.slice(0, 6_000).trimEnd()}\n[system context truncated for decision budget]`
    : trimmed;
  return {
    stableDecisionRules: STABLE_DECISION_SYSTEM_CONTEXT,
    runtimeContext: `System context:\n${compact}`,
  };
}

function buildDecisionPromptSections(
  stateView: ReturnType<typeof projectAgentStateViewForPrompt>,
  toolDefinitions: ToolDefinition[],
  toolRoutingSummary: string | undefined,
): Record<string, string> {
  return {
    "user.tools": `Selected tools:\n${formatSelectedTools(toolDefinitions)}`,
    "user.toolRouting": toolRoutingSummary?.trim()
      ? `Tool loading map (request these with decision_load_tools, not action.calls):\n${toolRoutingSummary.trim()}`
      : "",
    "user.state": `State view:\n${JSON.stringify(stateView, null, 2)}`,
  };
}

function buildStateViewPromptBreakdown(
  stateView: ReturnType<typeof projectAgentStateViewForPrompt>,
): Record<string, string | undefined> {
  return {
    "state.context": stringifySection(stateView.context),
    "state.context.timeline": stringifySection(stateView.context.timeline),
    "state.context.git": stringifySection(stateView.context.git),
    "state.context.tools": stringifySection(stateView.context.tools),
    "state.context.personal": stringifySection(stateView.context.personal),
    "state.context.scratch": stringifySection(stateView.context.scratch),
  };
}

function stringifySection(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value, null, 2);
}

function formatSelectedTools(toolDefinitions: ToolDefinition[]): string {
  if (toolDefinitions.length === 0) {
    return "(none)";
  }

  return toolDefinitions.map((tool) => {
    const parts = [
      `- ${tool.name}: ${tool.description}`,
      tool.annotations ? `  annotations=${JSON.stringify(tool.annotations)}` : "",
      tool.inputSchema ? `  inputSchema=${JSON.stringify(tool.inputSchema)}` : "",
      tool.outputSchema ? `  outputSchema=${JSON.stringify(tool.outputSchema)}` : "",
      tool.selectionHints ? `  hints=${JSON.stringify(tool.selectionHints)}` : "",
    ].filter((part) => part.length > 0);
    return parts.join("\n");
  }).join("\n");
}

function normalizeAgentAction(value: unknown): AgentAction {
  const record = isPlainObject(value) ? value : {};
  const mode = normalizeActionMode(record["mode"]);
  const calls = Array.isArray(record["calls"])
    ? record["calls"].map(normalizeToolCallSpec).filter((call): call is AgentToolCallSpec => call !== null)
    : [];
  const allowedTools = Array.isArray(record["allowedTools"])
    ? record["allowedTools"].map(String).filter((tool) => tool.trim().length > 0)
    : [];
  const assertions: ToolContractAssertion[] = [];

  return {
    mode,
    calls,
    allowedTools,
    assertions,
    completion: normalizeActionCompletion(record["completion"] ?? record["taskCompletion"]),
  };
}

function normalizeToolLoadRequest(value: unknown): AgentToolLoadRequest {
  const record = isPlainObject(value) ? value : {};
  return {
    query: typeof record["query"] === "string" ? record["query"] : undefined,
    toolNames: normalizeStringArray(record["toolNames"]),
    groups: normalizeStringArray(record["groups"]),
  };
}

function normalizeWorkingNotes(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const notes = value
    .map((note) => String(note).replace(/\s+/g, " ").trim())
    .filter((note) => note.length > 0)
    .slice(0, 12);
  return notes.length > 0 ? notes : [];
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(String).map((item) => item.trim()).filter((item) => item.length > 0)
    : [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function normalizeActionMode(value: unknown): AgentActionMode {
  return value === "single" || value === "sequential" || value === "parallel"
    ? value
    : "single";
}

function normalizeToolCallSpec(value: unknown): AgentToolCallSpec | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const tool = String(value["tool"] ?? "").trim();
  if (!tool) {
    return null;
  }
  const rawInput = value["input"];
  const input = isPlainObject(rawInput) ? { ...rawInput } : {};
  const rawDependsOn = value["dependsOn"];
  return {
    id: String(value["id"] ?? tool).trim() || tool,
    tool,
    input,
    dependsOn: Array.isArray(rawDependsOn)
      ? rawDependsOn.map(String).filter((dep) => dep.trim().length > 0)
      : [],
    purpose: typeof value["purpose"] === "string" ? value["purpose"] : undefined,
  };
}

function normalizeActionCompletion(value: unknown): AgentActionCompletion {
  if (!isPlainObject(value)) {
    return { intent: "not_completion" };
  }
  const intent = value["intent"] === "completion_candidate"
    ? "completion_candidate"
    : "not_completion";
  const reason = typeof value["reason"] === "string" && value["reason"].trim().length > 0
    ? value["reason"].trim()
    : undefined;
  const expectedEvidence = normalizeStringArray(value["expectedEvidence"]).slice(0, 8);
  return {
    intent,
    ...(reason ? { reason } : {}),
    ...(expectedEvidence.length > 0 ? { expectedEvidence } : {}),
  };
}

function extractJsonObject(text: string): Record<string, unknown> {
  const trimmed = unwrapJsonFence(text.trim());
  const direct = parseJsonRecord(trimmed);
  if (direct) {
    return direct;
  }

  const start = trimmed.indexOf("{");
  if (start < 0) {
    throw new SyntaxError(`Expected JSON object but received: ${text.slice(0, 120)}`);
  }

  let depth = 0;
  let inString = false;
  let escaping = false;
  for (let index = start; index < trimmed.length; index++) {
    const char = trimmed[index];
    if (!char) continue;

    if (escaping) {
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "{") {
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0) {
        const candidate = trimmed.slice(start, index + 1);
        const parsed = parseJsonRecord(candidate);
        if (parsed) {
          return parsed;
        }
      }
    }
  }

  throw new SyntaxError(`Expected JSON object but received: ${text.slice(0, 120)}`);
}

function unwrapJsonFence(text: string): string {
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch?.[1]) {
    return fenceMatch[1].trim();
  }
  return text;
}

function parseJsonRecord(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const CONTROL_DECISION_TOOL_NAMES = new Set([
  "decision_reply",
  "decision_ask_user",
  "decision_load_tools",
  TASK_FEEDBACK_TOOL_NAME,
]);

function buildNativeDecisionTools(
  selectedTools: ToolDefinition[],
  options: {
    toolLoadingAvailable: boolean;
    taskFeedbackToolAvailable: boolean;
  },
): LlmToolSchema[] {
  const controlTools: LlmToolSchema[] = [];
  if (options.toolLoadingAvailable) {
    controlTools.push({
      name: "decision_load_tools",
      description: "Request hidden tools by exact group, exact tool name, or search query when selected tools are insufficient.",
      inputSchema: {
        ...objectSchema({
          query: {
            type: "string",
            minLength: 1,
          },
          toolNames: {
            type: "array",
            items: {
              type: "string",
              minLength: 1,
            },
            maxItems: 12,
          },
          groups: {
            type: "array",
            items: {
              type: "string",
              minLength: 1,
            },
            maxItems: 12,
          },
          workingNotes: workingNotesSchema(),
        }, []),
        anyOf: [
          { required: ["query"] },
          { required: ["toolNames"] },
          { required: ["groups"] },
        ],
      },
    });
  }
  if (options.taskFeedbackToolAvailable) {
    controlTools.push({
      name: TASK_FEEDBACK_TOOL_NAME,
      description: "Pause the active task run to ask the user for required feedback when progress is blocked and no safe default exists. Do not use for final responses.",
      inputSchema: objectSchema({
        question: {
          type: "string",
          minLength: 1,
        },
        reason: {
          type: "string",
          minLength: 1,
        },
        workingNotes: workingNotesSchema(),
      }, ["question", "reason"]),
    });
  }
  const executableTools = selectedTools
    .filter((tool) => !CONTROL_DECISION_TOOL_NAMES.has(tool.name))
    .map(toNativeExecutableToolSchema);
  return [...controlTools, ...executableTools];
}

function toNativeExecutableToolSchema(tool: ToolDefinition): LlmToolSchema {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: withTaskCompletionSchema(tool.inputSchema ?? objectSchema({}, [])),
  };
}

function withTaskCompletionSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = isPlainObject(schema["properties"])
    ? { ...(schema["properties"] as Record<string, unknown>) }
    : {};
  const required = Array.isArray(schema["required"])
    ? schema["required"].map(String)
    : [];
  return {
    ...schema,
    type: "object",
    properties: {
      ...properties,
      taskCompletion: taskCompletionSchema(),
    },
    required: uniqueStrings([...required, "taskCompletion"]),
    additionalProperties: schema["additionalProperties"] ?? false,
  };
}

function taskCompletionSchema(): Record<string, unknown> {
  return objectSchema({
    intent: {
      type: "string",
      enum: ["not_completion", "completion_candidate"],
      description: "Whether this exact tool call is expected to complete the user's current task if verification passes.",
    },
    reason: {
      type: "string",
      minLength: 1,
      description: "Internal completion rationale for the harness. This is not shown directly to the user.",
    },
    expectedEvidence: {
      type: "array",
      items: {
        type: "string",
        minLength: 1,
      },
      maxItems: 8,
    },
  }, ["intent", "reason"]);
}

function objectSchema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function workingNotesSchema(): Record<string, unknown> {
  return {
    type: "array",
    items: {
      type: "string",
    },
    maxItems: 5,
  };
}

function serializeNativeDecisionToolCalls(calls: LlmToolCall[], selectedTools: ToolDefinition[]): string {
  if (calls.length !== 1) {
    return `native_decision_error: expected exactly one native tool call, received ${calls.length}.`;
  }

  const call = calls[0]!;
  const input = isPlainObject(call.input) ? call.input : {};
  if (CONTROL_DECISION_TOOL_NAMES.has(call.name)) {
    return JSON.stringify(nativeDecisionToolCallToPayload(call.name, input));
  }

  const selected = selectedTools.find((tool) => tool.name === call.name);
  if (!selected) {
    return `native_decision_error: unknown or unselected native tool '${call.name}'. Request tools with decision_load_tools before executable work.`;
  }

  return JSON.stringify(nativeExecutableToolCallToPayload(call, input));
}

function nativeDecisionFromToolCalls(calls: LlmToolCall[], selectedTools: ToolDefinition[]): AgentDecision | string {
  if (calls.length !== 1) {
    return `native_decision_error: expected exactly one native tool call, received ${calls.length}.`;
  }

  const call = calls[0]!;
  const input = isPlainObject(call.input) ? call.input : {};
  if (CONTROL_DECISION_TOOL_NAMES.has(call.name)) {
    return nativeDecisionToolCallToDecision(call.name, input);
  }

  const selected = selectedTools.find((tool) => tool.name === call.name);
  if (!selected) {
    return `native_decision_error: unknown or unselected native tool '${call.name}'. Request tools with decision_load_tools before executable work.`;
  }

  return nativeExecutableToolCallToDecision(call, input);
}

function nativeDecisionToolCallToPayload(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
  switch (toolName) {
    case "decision_reply":
      return {
        kind: "reply",
        status: input["status"],
        message: input["message"],
        ...(input["workingNotes"] ? { workingNotes: input["workingNotes"] } : {}),
      };
    case "decision_ask_user":
    case TASK_FEEDBACK_TOOL_NAME:
      return {
        kind: "ask_user",
        question: input["question"],
        reason: input["reason"],
        ...(input["workingNotes"] ? { workingNotes: input["workingNotes"] } : {}),
      };
    case "decision_load_tools":
      return {
        kind: "load_tools",
        request: {
          ...(input["query"] ? { query: input["query"] } : {}),
          ...(input["toolNames"] ? { toolNames: input["toolNames"] } : {}),
          ...(input["groups"] ? { groups: input["groups"] } : {}),
        },
        ...(input["workingNotes"] ? { workingNotes: input["workingNotes"] } : {}),
      };
    default:
      return {
        kind: "reply",
        status: "failed",
        message: `Unknown native control tool: ${toolName}`,
      };
  }
}

function nativeDecisionToolCallToDecision(toolName: string, input: Record<string, unknown>): AgentDecision {
  switch (toolName) {
    case "decision_reply":
      return {
        kind: "reply",
        status: input["status"] === "failed" ? "failed" : "completed",
        message: String(input["message"] ?? ""),
        workingNotes: normalizeWorkingNotes(input["workingNotes"]),
      };
    case "decision_ask_user":
    case TASK_FEEDBACK_TOOL_NAME:
      return {
        kind: "ask_user",
        question: String(input["question"] ?? ""),
        reason: String(input["reason"] ?? ""),
        workingNotes: normalizeWorkingNotes(input["workingNotes"]),
      };
    case "decision_load_tools":
      return {
        kind: "load_tools",
        request: normalizeToolLoadRequest(input),
        workingNotes: normalizeWorkingNotes(input["workingNotes"]),
      };
    default:
      return {
        kind: "reply",
        status: "failed",
        message: `Unknown native control tool: ${toolName}`,
      };
  }
}

function nativeExecutableToolCallToPayload(call: LlmToolCall, input: Record<string, unknown>): Record<string, unknown> {
  const { cleanInput, completion } = extractTaskCompletion(input);
  return {
    kind: "act",
    action: {
      mode: "single",
      allowedTools: [call.name],
      calls: [{
        id: call.id || `${call.name}_call`,
        tool: call.name,
        input: cleanInput,
        dependsOn: [],
        purpose: `Execute ${call.name}`,
      }],
      assertions: [],
      completion,
    },
  };
}

function nativeExecutableToolCallToDecision(call: LlmToolCall, input: Record<string, unknown>): AgentDecision {
  const { cleanInput, completion } = extractTaskCompletion(input);
  return {
    kind: "act",
    action: {
      mode: "single",
      allowedTools: [call.name],
      calls: [{
        id: call.id || `${call.name}_call`,
        tool: call.name,
        input: cleanInput,
        dependsOn: [],
        purpose: `Execute ${call.name}`,
      }],
      assertions: [],
      completion,
    },
  };
}

function extractTaskCompletion(input: Record<string, unknown>): {
  cleanInput: Record<string, unknown>;
  completion: AgentActionCompletion;
} {
  const { taskCompletion, ...cleanInput } = input;
  return {
    cleanInput,
    completion: normalizeActionCompletion(taskCompletion),
  };
}

function summarizeNativeToolCalls(calls: LlmToolCall[], selectedTools: ToolDefinition[]): Array<Record<string, unknown>> {
  const selectedToolNames = new Set(selectedTools.map((tool) => tool.name));
  return calls.map((call) => ({
    id: call.id,
    name: call.name,
    kind: CONTROL_DECISION_TOOL_NAMES.has(call.name)
      ? "control"
      : selectedToolNames.has(call.name)
        ? "executable"
        : "unknown",
    input: summarizeToolInput(isPlainObject(call.input) ? call.input : {}),
  }));
}

function readSchemaRequiredFields(schema: Record<string, unknown> | undefined): string[] {
  return Array.isArray(schema?.["required"]) ? schema["required"].map(String) : [];
}
