import type { LlmProvider } from "../../core/contracts/provider.js";
import {
  isProviderEmptyResponseError,
  isProviderMalformedResponseError,
} from "../../core/contracts/provider-errors.js";
import type {
  ProviderEmptyResponseError,
  ProviderMalformedResponseError,
} from "../../core/contracts/provider-errors.js";
import type { LlmMessage, LlmToolCall, LlmToolSchema, LlmTurnInput, LlmTurnOutput } from "../../core/contracts/llm-protocol.js";
import {
  assertContextIsAdmissible,
  assertContextRecoveryIsNotExhausted,
} from "../../prompt/context-compilation-receipt.js";
import type { ContextCompilationReceipt } from "../../prompt/context-compilation-receipt.js";
import { resolveModelContextLimits } from "../../providers/shared/model-context-limits.js";
import type { ResolvedModelContextLimits } from "../../providers/shared/model-context-limits.js";
import { agentTrace, isAgentTracePromptEnabled, tracePreview } from "../../shared/index.js";
import type { ToolContractAssertion, ToolDefinition } from "../../skills/types.js";
import type { AgentFeedbackLedger } from "../feedback-ledger.js";
import type { RunMetrics } from "../metrics.js";
import { recordOptimizationEvent, recordPromptMetric, recordProviderUsageMetric, recordRunMetric } from "../metrics.js";
import type { ToolContextProjectionPolicy } from "../types.js";
import { compileDecisionContext } from "./decision-context-compiler.js";
import { buildDecisionSystemSections } from "./decision-system-prompt.js";
import { createTimelineCheckpointCache } from "./timeline-checkpoint-cache.js";
import type { TimelineCheckpointCacheState } from "./timeline-checkpoint-cache.js";
import { recordTimelineCheckpointObservability } from "./timeline-checkpoint-observability.js";
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
export interface AgentToolCallSpec {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  dependsOn: string[];
  purpose: string;
}

const TOOL_CALL_PURPOSE_MAX_CHARS = 240;

export interface AgentAction {
  mode: AgentActionMode;
  calls: AgentToolCallSpec[];
  allowedTools: string[];
  assertions: ToolContractAssertion[];
}

export interface TaskCompletionAssetInput {
  path: string;
  kind: "file" | "directory";
  description: string;
}

export interface AgentTaskCompletionRequest {
  summary: string;
  assets: TaskCompletionAssetInput[];
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
    }
  | {
      kind: "task_completion";
      request: AgentTaskCompletionRequest;
      workingNotes?: string[];
    };

interface CallAgentDecisionInput {
  provider: LlmProvider;
  stateView: AgentStateView;
  toolDefinitions: ToolDefinition[];
  toolRoutingSummary?: string;
  toolLoadingAvailable?: boolean;
  taskFeedbackToolAvailable?: boolean;
  taskCompletionAvailable?: boolean;
  systemContext?: string;
  metrics?: RunMetrics;
  feedbackLedger?: AgentFeedbackLedger;
  feedbackContext?: AgentDecisionFeedbackContext;
  toolContextProjectionPolicy?: ToolContextProjectionPolicy;
  timelineCheckpointCache?: TimelineCheckpointCacheState;
  onContextCompilation?: (receipt: ContextCompilationReceipt) => void;
  onAssistantTextDelta?: (delta: string) => void;
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
const TASK_COMPLETION_TOOL_NAME = "task_completion";

export async function callAgentDecision(input: CallAgentDecisionInput): Promise<AgentDecision> {
  const timelineCheckpointCache = input.timelineCheckpointCache ?? createTimelineCheckpointCache();
  const contextLimits = resolveModelContextLimits(input.provider);
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
        taskCompletionAvailable: input.taskCompletionAvailable === true,
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
        contextLimits,
        decisionAttempt: attempt + 1,
        requestStartedAt: startedAt,
        timelineCheckpointCache,
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
      if (!nativeDecision || typeof nativeDecision === "string") {
        throw new SyntaxError(nativeDecision ?? "Expected a native decision tool call.");
      }
      const decision = nativeDecision;
      agentTrace("agent_decision", `attempt=${attempt + 1} parsed_decision kind=${decision.kind}`);
      recordDecisionFeedback(input, "parsed", {
        attempt: attempt + 1,
        decision: summarizeDecisionForFeedback(decision),
      });
      const violation = validateToolProtocol(decision, input.toolDefinitions, {
        toolLoadingAvailable: input.toolLoadingAvailable !== false,
        taskFeedbackToolAvailable: input.taskFeedbackToolAvailable === true,
        taskCompletionAvailable: input.taskCompletionAvailable === true,
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
        messages = buildRepairMessages(
          messages,
          rawText,
          `${repairPromptText(repair)}\nProtocol detail: ${violation.reason}`,
        );
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

  throw new SyntaxError("The provider did not return a valid native decision.");
}

async function generateTurnWithEmptyResponseRetry(
  input: CallAgentDecisionInput,
  request: {
    messages: LlmMessage[];
    decisionTools: LlmToolSchema[];
    contextLimits: ResolvedModelContextLimits;
    decisionAttempt: number;
    requestStartedAt: number;
    timelineCheckpointCache: TimelineCheckpointCacheState;
  },
): Promise<LlmTurnOutput> {
  const candidateTurnInput: LlmTurnInput = {
    messages: request.messages,
    tools: request.decisionTools,
    toolChoice: "auto" as const,
    parallelToolCalls: false,
  };
  const compilation = await compileDecisionContext({
    provider: input.provider,
    turnInput: candidateTurnInput,
    stateView: input.stateView,
    contextLimits: request.contextLimits,
    decisionAttempt: request.decisionAttempt,
    policy: input.toolContextProjectionPolicy ?? "shadow",
    timelineCheckpointCache: request.timelineCheckpointCache,
    buildPrompt: (stateView) => Object.values(buildDecisionPromptSections(
      stateView,
      input.toolDefinitions,
      input.toolRoutingSummary,
    )).filter((section) => section.trim().length > 0).join("\n\n"),
  });
  const contextBudget = compilation.candidateBudget;
  recordOptimizationEvent(input.metrics, "context_budget", {
    stage: request.decisionAttempt === 1 ? "agent_decision" : "agent_decision_repair",
    phase: "candidate",
    decisionAttempt: request.decisionAttempt,
    ...contextBudget,
  });
  recordDecisionFeedback(input, "context_budget", {
    phase: "candidate",
    decisionAttempt: request.decisionAttempt,
    ...contextBudget,
  });
  if (compilation.projection) {
    recordOptimizationEvent(input.metrics, compilation.projection.event, {
      ...compilation.projection.receipt,
      policy: compilation.projection.policy,
    });
    recordDecisionFeedback(input, compilation.projection.event, {
      ...compilation.projection.receipt,
      policy: compilation.projection.policy,
    });
  }
  recordTimelineCheckpointObservability({
    compilation,
    decisionAttempt: request.decisionAttempt,
    metrics: input.metrics,
    recordFeedback: (event, data) => recordDecisionFeedback(input, event, data),
  });
  if (compilation.finalBudgetMeasured) {
    recordOptimizationEvent(input.metrics, "context_budget_final", {
      stage: request.decisionAttempt === 1 ? "agent_decision" : "agent_decision_repair",
      phase: "final",
      decisionAttempt: request.decisionAttempt,
      ...compilation.finalBudget,
    });
    recordDecisionFeedback(input, "context_budget_final", {
      phase: "final",
      decisionAttempt: request.decisionAttempt,
      ...compilation.finalBudget,
    });
  }
  recordOptimizationEvent(input.metrics, "context_compilation", { ...compilation.receipt });
  recordDecisionFeedback(input, "context_compilation", { ...compilation.receipt });
  input.onContextCompilation?.(compilation.receipt);
  agentTrace(
    "agent_decision",
    `context_budget attempt=${request.decisionAttempt} candidate=${contextBudget.measuredInputTokens} final=${compilation.finalBudget.measuredInputTokens} mode=${compilation.receipt.mode} soft=${compilation.finalBudget.softInputTokens} hard=${compilation.finalBudget.hardInputTokens}`,
  );
  assertContextIsAdmissible(compilation.receipt);
  assertContextRecoveryIsNotExhausted(compilation.receipt);
  let providerAttempt = 0;

  for (;;) {
    providerAttempt++;
    try {
      if (
        input.onAssistantTextDelta
        && request.decisionTools.length === 0
        && request.decisionAttempt === 1
        && input.provider.capabilities.streaming === true
        && input.provider.streamTurn
      ) {
        return await input.provider.streamTurn(compilation.finalTurnInput, {
          onTextDelta: input.onAssistantTextDelta,
        });
      }
      return await input.provider.generateTurn(compilation.finalTurnInput);
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
  if (decision.kind === "task_completion") {
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
  if (violation.reason.includes("decision_load_tools request must include")) {
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
    taskCompletionAvailable: boolean;
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
      reason: "decision_load_tools request must include at least one non-empty selector: groups, toolNames, or query",
      invalidTools: [],
      selectedTools,
      loadToolsUsedAsAction: false,
    };
  }

  if (decision.kind === "task_completion") {
    if (!options.taskCompletionAvailable) {
      return {
        kind: "tool_protocol_violation",
        reason: "task_completion is only available during an active task run",
        invalidTools: [TASK_COMPLETION_TOOL_NAME],
        selectedTools,
        loadToolsUsedAsAction: false,
      };
    }
    return null;
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

  const invalidPurposeCalls = decision.action.calls.filter((call) => {
    const purpose = call.purpose.replace(/\s+/g, " ").trim();
    return purpose.length === 0 || purpose.length > TOOL_CALL_PURPOSE_MAX_CHARS;
  });
  if (invalidPurposeCalls.length > 0) {
    return {
      kind: "tool_protocol_violation",
      reason: `Every executable tool call requires a specific purpose between 1 and ${TOOL_CALL_PURPOSE_MAX_CHARS} characters. Invalid calls: ${invalidPurposeCalls.map((call) => call.id).join(", ")}`,
      invalidTools: uniqueStrings(invalidPurposeCalls.map((call) => call.tool)),
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
      ? "A tool-loading control was used as an action tool"
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

function buildDecisionPromptSections(
  stateView: ReturnType<typeof projectAgentStateViewForPrompt>,
  toolDefinitions: ToolDefinition[],
  toolRoutingSummary: string | undefined,
): Record<string, string> {
  return {
    "user.tools": `Selected tools:\n${formatSelectedToolNames(toolDefinitions)}`,
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
    "state.context.harness": stringifySection(stateView.context.harness),
    "state.context.personal": stringifySection(stateView.context.personal),
    "state.context.run": stringifySection(stateView.context.run),
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

function formatSelectedToolNames(toolDefinitions: ToolDefinition[]): string {
  if (toolDefinitions.length === 0) {
    return "(none)";
  }
  return toolDefinitions.map((tool) => `- ${tool.name}`).join("\n");
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
  "decision_load_tools",
  TASK_FEEDBACK_TOOL_NAME,
  TASK_COMPLETION_TOOL_NAME,
]);

function buildNativeDecisionTools(
  selectedTools: ToolDefinition[],
  options: {
    toolLoadingAvailable: boolean;
    taskFeedbackToolAvailable: boolean;
    taskCompletionAvailable: boolean;
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
  if (options.taskCompletionAvailable) {
    controlTools.push({
      name: TASK_COMPLETION_TOOL_NAME,
      description: "Request deterministic completion verification for the active task run after the requested work appears complete. The runtime verifies declared assets, tool evidence, and unresolved failures before updating task state.",
      inputSchema: objectSchema({
        summary: {
          type: "string",
          minLength: 1,
          maxLength: 1000,
          description: "Compact cumulative current state of the task after this run. Describe the reusable result and remaining state, not only the latest tool call.",
        },
        assets: {
          type: "array",
          maxItems: 20,
          items: objectSchema({
            path: {
              type: "string",
              minLength: 1,
              description: "Portable path relative to the active task repository root.",
            },
            kind: { type: "string", enum: ["file", "directory"] },
            description: { type: "string", minLength: 1, maxLength: 300 },
          }, ["path", "kind", "description"]),
        },
        workingNotes: workingNotesSchema(),
      }, ["summary", "assets"]),
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
    inputSchema: withToolCallPurposeSchema(tool.inputSchema),
  };
}

function withToolCallPurposeSchema(inputSchema: Record<string, unknown> | undefined): Record<string, unknown> {
  const schema = inputSchema ?? objectSchema({}, []);
  const properties = isPlainObject(schema["properties"]) ? schema["properties"] : {};
  const required = Array.isArray(schema["required"])
    ? schema["required"].map(String)
    : [];
  return {
    ...schema,
    type: "object",
    properties: {
      ...properties,
      purpose: {
        type: "string",
        minLength: 1,
        maxLength: TOOL_CALL_PURPOSE_MAX_CHARS,
        description: "One short task-specific sentence explaining why this tool is being called now. Describe intent, not a claimed result.",
      },
    },
    required: uniqueStrings([...required, "purpose"]),
  };
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
    return nativeExecutableToolCallToDecision(call, input);
  }

  return nativeExecutableToolCallToDecision(call, input);
}

function nativeDecisionToolCallToPayload(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
  switch (toolName) {
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
    case TASK_COMPLETION_TOOL_NAME:
      return {
        kind: "task_completion",
        ...nativeTaskCompletionPayload(input),
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
    case TASK_COMPLETION_TOOL_NAME:
      return {
        kind: "task_completion",
        request: normalizeTaskCompletionRequest(input),
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

function nativeTaskCompletionPayload(input: Record<string, unknown>): Record<string, unknown> {
  return {
    request: {
      summary: input["summary"],
      assets: input["assets"],
    },
  };
}

function normalizeTaskCompletionRequest(input: unknown): AgentTaskCompletionRequest {
  const record = isPlainObject(input) && isPlainObject(input["request"])
    ? input["request"]
    : isPlainObject(input)
      ? input
      : {};
  const assets = Array.isArray(record["assets"])
    ? record["assets"].flatMap((item): TaskCompletionAssetInput[] => {
        if (!isPlainObject(item)) return [];
        const path = typeof item["path"] === "string" ? item["path"].trim() : "";
        const description = typeof item["description"] === "string" ? item["description"].trim() : "";
        const kind = item["kind"] === "directory" ? "directory" : "file";
        return path && description ? [{ path, kind, description }] : [];
      })
    : [];
  return {
    summary: typeof record["summary"] === "string" ? record["summary"].trim() : "",
    assets,
  };
}

function nativeExecutableToolCallToPayload(call: LlmToolCall, input: Record<string, unknown>): Record<string, unknown> {
  const { purpose, toolInput } = extractNativeToolCallPurpose(input);
  return {
    kind: "act",
    action: {
      mode: "single",
      allowedTools: [call.name],
      calls: [{
        id: call.id || `${call.name}_call`,
        tool: call.name,
        input: toolInput,
        dependsOn: [],
        purpose,
      }],
      assertions: [],
    },
  };
}

function nativeExecutableToolCallToDecision(call: LlmToolCall, input: Record<string, unknown>): AgentDecision {
  const { purpose, toolInput } = extractNativeToolCallPurpose(input);
  return {
    kind: "act",
    action: {
      mode: "single",
      allowedTools: [call.name],
      calls: [{
        id: call.id || `${call.name}_call`,
        tool: call.name,
        input: toolInput,
        dependsOn: [],
        purpose,
      }],
      assertions: [],
    },
  };
}

function extractNativeToolCallPurpose(input: Record<string, unknown>): {
  purpose: string;
  toolInput: Record<string, unknown>;
} {
  const { purpose: rawPurpose, ...toolInput } = input;
  return {
    purpose: typeof rawPurpose === "string" ? rawPurpose.replace(/\s+/g, " ").trim() : "",
    toolInput,
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
