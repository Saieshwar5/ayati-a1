import type { LlmProvider } from "../../core/contracts/provider.js";
import {
  isProviderEmptyResponseError,
  isProviderMalformedResponseError,
} from "../../core/contracts/provider-errors.js";
import type {
  ProviderEmptyResponseError,
  ProviderMalformedResponseError,
} from "../../core/contracts/provider-errors.js";
import type {
  LlmMessage,
  LlmToolCall,
  LlmToolChoice,
  LlmToolSchema,
  LlmTurnInput,
  LlmTurnOutput,
} from "../../core/contracts/llm-protocol.js";
import {
  assertContextIsAdmissible,
  assertContextRecoveryIsNotExhausted,
} from "../../prompt/context-compilation-receipt.js";
import type { ContextCompilationReceipt } from "../../prompt/context-compilation-receipt.js";
import { resolveModelContextLimits } from "../../providers/shared/model-context-limits.js";
import type { ResolvedModelContextLimits } from "../../providers/shared/model-context-limits.js";
import {
  classifyProviderFailure,
  MAX_PROVIDER_RETRIES,
  PROVIDER_RETRY_DELAY_MS,
  toProviderCallError,
} from "../../providers/shared/provider-call-policy.js";
import { agentTrace, isAgentTracePromptEnabled, tracePreview } from "../../shared/index.js";
import {
  getToolPurpose,
  isNativeControlToolName,
  type ToolPurpose,
} from "../../skills/tool-taxonomy.js";
import type { ToolContractAssertion, ToolDefinition } from "../../skills/types.js";
import type { AgentEventSink } from "../agent-event-sink.js";
import {
  operationPurposeForDecision,
  withEvaluationModelOperation,
} from "../../evaluation/capture-runtime.js";
import type { RunMetrics } from "../metrics.js";
import { recordOptimizationEvent, recordPromptMetric, recordProviderUsageMetric, recordRunMetric } from "../metrics.js";
import type { AgentContextCheckpointCoordinator, ToolContextProjectionPolicy } from "../types.js";
import type { ContextPreparationManager } from "../context-preparation/manager.js";
import type { ContextMaintenanceLifecycle } from "../context-preparation/context-maintenance.js";
import type { ContextEngineMachineContext } from "../../context-engine/index.js";
import { compileDecisionContext } from "./decision-context-compiler.js";
import { buildDecisionSystemSections } from "./decision-system-prompt.js";
import { recordStreamCheckpointObservability } from "./stream-checkpoint-observability.js";
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
import type {
  ModeTransitionRequest,
  TerminalStopRequest,
  VirtualModeTransitionTarget,
} from "./virtual-mode.js";
import {
  buildModeTransitionControlTools,
  isModeTransitionControlToolName,
  MODE_TRANSITION_CONTROL_TOOL_NAMES,
  modeTransitionRequestFromControlCall,
} from "./mode-transition-controls.js";
import { CapabilityCatalog } from "./capabilities/catalog.js";
import type { ModeCapabilityOptions } from "./capabilities/contracts.js";
import type { WorkStateUpdateInput } from "./work-state/contracts.js";
import { WORK_STATE_LIMITS } from "./work-state/contracts.js";
import { normalizeWorkStateUpdateInput } from "./work-state/checkpoint.js";
import type {
  PromptRunContextMaintenanceCard,
  RunContextMaintenanceSelection,
} from "./run-context-maintenance-contracts.js";
import {
  normalizeRunContextMaintenanceSelection,
} from "./run-context-maintenance-contracts.js";
import {
  buildRunContextMaintenanceControlTool,
  RUN_CONTEXT_MAINTENANCE_TOOL_NAME,
} from "./run-context-maintenance-control.js";
import {
  detectAssistantTextToolCall,
  looksLikeToolCallRecord,
  type AssistantTextToolCallViolation,
} from "./assistant-text-tool-call.js";
import {
  describeDecisionToolChoice,
  nativeToolRequiredAssistantViolation,
  resolveDecisionToolChoicePolicy,
} from "./decision-tool-choice-policy.js";
import { validateJsonSchemaInput } from "./json-schema-input-validator.js";

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
      kind: "act";
      action: AgentAction;
      workingNotes?: string[];
    }
  | {
      kind: "transition_mode";
      request: ModeTransitionRequest;
      workingNotes?: string[];
    }
  | {
      kind: "stop";
      request: TerminalStopRequest;
      workingNotes?: string[];
    }
  | {
      kind: "checkpoint_work_state";
      update: WorkStateUpdateInput;
      workingNotes?: string[];
    }
  | {
      kind: "maintain_run_context";
      selection: RunContextMaintenanceSelection;
      workingNotes?: string[];
    };

interface CallAgentDecisionInput {
  provider: LlmProvider;
  stateView: AgentStateView;
  toolDefinitions: ToolDefinition[];
  toolRoutingSummary?: string;
  modeCapabilityOptions?: ModeCapabilityOptions;
  modeTransitionAvailable?: boolean;
  terminalStopAvailable?: boolean;
  workStateCheckpointAvailable?: boolean;
  runContextMaintenanceAvailable?: boolean;
  systemContext?: string;
  metrics?: RunMetrics;
  eventSink?: AgentEventSink;
  feedbackContext?: AgentDecisionFeedbackContext;
  toolContextProjectionPolicy?: ToolContextProjectionPolicy;
  contextCheckpoint?: AgentContextCheckpointCoordinator;
  contextPreparation?: ContextPreparationManager;
  contextMaintenance?: ContextMaintenanceLifecycle;
  applyAuthoritativeContext?: (context: ContextEngineMachineContext) => AgentStateView;
  contextPreparationMode?: "primary" | "final_response";
  evaluationIteration?: number;
  onContextCompilation?: (receipt: ContextCompilationReceipt) => void;
  onAssistantTextDelta?: (delta: string) => void;
}

interface ToolProtocolViolation {
  kind: Extract<DecisionFailureKind, "tool_protocol_violation">;
  reason: string;
  invalidTools: string[];
  selectedTools: string[];
  controlToolUsedAsAction: boolean;
  mutationRequiresWorkstreamBinding: boolean;
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

interface AgentDecisionFeedbackContext {
  clientId: string;
  sessionId: string;
  seq: number;
  runId?: string;
}

const MAX_DECISION_ATTEMPTS = 3;
const TOOL_PROTOCOL_FAILURE_REPLY = "I could not form a valid tool call for this request.";
const TERMINAL_STOP_TOOL_NAME = "decision_stop";
const WORK_STATE_CHECKPOINT_TOOL_NAME = "decision_checkpoint_workstate";
const DEFAULT_MODE_CAPABILITY_OPTIONS = new CapabilityCatalog().modeOptions();

export async function callAgentDecision(input: CallAgentDecisionInput): Promise<AgentDecision> {
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
  let preferredNativeToolName: string | undefined;
  for (let attempt = 0; attempt < MAX_DECISION_ATTEMPTS; attempt++) {
    const metricStage = attempt === 0 ? "agent_decision" : "agent_decision_repair";
    const startedAt = Date.now();
    let turn: LlmTurnOutput;
    const decisionTools = buildNativeDecisionTools(input.toolDefinitions, {
      modeTransitionAvailable: input.modeTransitionAvailable !== false,
      terminalStopAvailable: input.terminalStopAvailable === true,
      workStateCheckpointAvailable: input.workStateCheckpointAvailable === true,
      runContextMaintenanceAvailable: input.runContextMaintenanceAvailable === true,
      runContextMaintenance: input.stateView.context.run?.mode?.runMaintain,
      modeCapabilityOptions: input.modeCapabilityOptions ?? DEFAULT_MODE_CAPABILITY_OPTIONS,
      allowedModeDestinations: allowedModeDestinations(input.stateView),
    });
    const toolChoicePolicy = resolveDecisionToolChoicePolicy({
      stateView: input.stateView,
      nativeTools: decisionTools,
      ...(preferredNativeToolName ? { preferredNativeToolName } : {}),
    });
    traceDecisionProviderRequest(
      input.provider,
      messages,
      attempt,
      toolChoicePolicy.toolChoice,
    );
    try {
      if (!input.provider.capabilities.nativeToolCalling) {
        throw new Error(`Provider ${input.provider.name} does not support native decision tools.`);
      }
      recordDecisionFeedback(input, "native_tool_surface", {
        attempt: attempt + 1,
        controlTools: decisionTools
          .filter((tool) => isNativeControlToolName(tool.name))
          .map((tool) => tool.name),
        selectedTools: summarizeToolDefinitions(input.toolDefinitions),
        executableTools: input.toolDefinitions.map((tool) => ({
          name: tool.name,
          hasInputSchema: Boolean(tool.inputSchema),
          requiredFields: readSchemaRequiredFields(tool.inputSchema),
        })),
        nativeToolCount: decisionTools.length,
        directAssistantResponseAllowed: toolChoicePolicy.directAssistantResponseAllowed,
        nativeToolCallRequired: toolChoicePolicy.nativeToolCallRequired,
        toolChoice: describeDecisionToolChoice(toolChoicePolicy.toolChoice),
      });
      turn = await generateTurnWithEmptyResponseRetry(input, {
        messages,
        decisionTools,
        toolChoice: toolChoicePolicy.toolChoice,
        contextLimits,
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
      const detectedAssistantTextToolCall = turn.type === "assistant"
        ? detectAssistantTextToolCall(rawText, {
          selectedTools: input.toolDefinitions.map((tool) => tool.name),
          nativeTools: decisionTools,
        })
        : null;
      const assistantTextToolCallViolation = detectedAssistantTextToolCall
        ?? (
          turn.type === "assistant" && toolChoicePolicy.nativeToolCallRequired
            ? nativeToolRequiredAssistantViolation(decisionTools)
            : null
        );
      if (assistantTextToolCallViolation) {
        const repair = createAssistantTextToolCallRepairSignal(
          assistantTextToolCallViolation,
          attempt + 1,
          toolChoicePolicy.nativeToolCallRequired,
        );
        preferredNativeToolName = assistantTextToolCallViolation.toolName
          && decisionTools.some((tool) => tool.name === assistantTextToolCallViolation.toolName)
          ? assistantTextToolCallViolation.toolName
          : undefined;
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
        modeTransitionAvailable: input.modeTransitionAvailable !== false,
        terminalStopAvailable: input.terminalStopAvailable === true,
        workStateCheckpointAvailable: input.workStateCheckpointAvailable === true,
        runContextMaintenanceAvailable: input.runContextMaintenanceAvailable === true,
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

      const inputViolation = turn.type === "tool_calls"
        ? validateNativeToolInputSchemas(turn.calls, decisionTools)
        : null;
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
        recordDecisionFeedback(input, "failed_fallback", {
          attempt: attempt + 1,
          reason: error instanceof Error ? error.message : String(error),
          ...repairSignalToFeedbackData(repair),
        });
        return {
          kind: "reply",
          status: "failed",
          message: TOOL_PROTOCOL_FAILURE_REPLY,
        };
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
    toolChoice: LlmToolChoice;
    contextLimits: ResolvedModelContextLimits;
    decisionAttempt: number;
    requestStartedAt: number;
  },
): Promise<LlmTurnOutput> {
  const candidateTurnInput: LlmTurnInput = {
    messages: request.messages,
    tools: request.decisionTools,
    toolChoice: request.toolChoice,
    parallelToolCalls: false,
  };
  const contextPreparationStarted = process.hrtime.bigint();
  const compilation = await compileDecisionContext({
    provider: input.provider,
    turnInput: candidateTurnInput,
    stateView: input.stateView,
    contextLimits: request.contextLimits,
    decisionAttempt: request.decisionAttempt,
    policy: input.toolContextProjectionPolicy ?? "shadow",
    contextCheckpoint: input.contextCheckpoint,
    contextPreparation: input.contextPreparation,
    contextMaintenance: input.contextMaintenance,
    applyAuthoritativeContext: input.applyAuthoritativeContext
      ? (context) => {
          const refreshed = input.applyAuthoritativeContext!(context);
          input.stateView = refreshed;
          return refreshed;
        }
      : undefined,
    allowBackgroundPreparation: request.decisionAttempt === 1
      && input.contextPreparationMode !== "final_response",
    allowSynchronousSemanticRecovery: request.decisionAttempt === 1
      && input.contextPreparationMode !== "final_response",
    buildPrompt: (stateView) => Object.values(buildDecisionPromptSections(
      stateView,
      input.toolDefinitions,
      input.toolRoutingSummary,
    )).filter((section) => section.trim().length > 0).join("\n\n"),
  });
  recordDecisionFeedback(input, "context_preparation_span", {
    decisionAttempt: request.decisionAttempt,
    durationMs: Number(process.hrtime.bigint() - contextPreparationStarted) / 1_000_000,
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
  recordStreamCheckpointObservability({
    compilation,
    decisionAttempt: request.decisionAttempt,
    metrics: input.metrics,
    recordFeedback: (event, data) => recordDecisionFeedback(input, event, data),
  });
  for (const event of compilation.preparationEvents ?? []) {
    recordOptimizationEvent(input.metrics, event.event, {
      laneId: event.laneId,
      at: event.at,
      ...event.data,
    });
    recordDecisionFeedback(input, event.event, {
      laneId: event.laneId,
      at: event.at,
      ...event.data,
    });
  }
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
    let receivedStreamingOutput = false;
    try {
      const purpose = operationPurposeForDecision({
        finalResponse: input.contextPreparationMode === "final_response",
        decisionAttempt: request.decisionAttempt,
        providerAttempt,
      });
      return await withEvaluationModelOperation({
        purpose,
        ...(input.feedbackContext?.runId ? { runId: input.feedbackContext.runId } : {}),
        ...(input.feedbackContext?.sessionId ? { sessionId: input.feedbackContext.sessionId } : {}),
        ...(input.feedbackContext?.runId ? { laneId: `main:${input.feedbackContext.runId}` } : {}),
        ...(input.evaluationIteration !== undefined ? { iteration: input.evaluationIteration } : {}),
        compilationReceipt: compilation.receipt,
        promptManifest: compilation.promptManifest,
      }, async () => {
        if (
          input.onAssistantTextDelta
          && request.decisionTools.length === 0
          && request.decisionAttempt === 1
          && input.provider.capabilities.streaming === true
          && input.provider.streamTurn
        ) {
          return await input.provider.streamTurn(compilation.finalTurnInput, {
            onTextDelta: (delta) => {
              receivedStreamingOutput = true;
              input.onAssistantTextDelta?.(delta);
            },
          });
        }
        return await input.provider.generateTurn(compilation.finalTurnInput);
      });
    } catch (error) {
      const responseFailure = providerResponseFailureDetails(error);
      if (!responseFailure) {
        const failure = classifyProviderFailure(error, input.provider.name);
        const willRetry = failure.retryable
          && providerAttempt <= MAX_PROVIDER_RETRIES
          && !receivedStreamingOutput;
        const retryDelayMs = failure.retryDelayMs ?? PROVIDER_RETRY_DELAY_MS;
        recordDecisionFeedback(input, "provider_call_failed", {
          attempt: request.decisionAttempt,
          providerAttempt,
          ...failure,
          receivedStreamingOutput,
          willRetry,
          ...(willRetry ? { retryDelayMs } : {}),
        });
        if (!willRetry) {
          throw toProviderCallError(error, input.provider.name);
        }
        await delay(retryDelayMs);
        continue;
      }

      const willRetry = providerAttempt <= MAX_PROVIDER_RETRIES;
      const repair = createRepairSignal(responseFailure.repairCode, {
        operatorDetails: {
          attempt: request.decisionAttempt,
          providerAttempt,
          provider: responseFailure.provider,
          model: responseFailure.model,
          latencyMs: Date.now() - request.requestStartedAt,
          ...responseFailure.operatorDetails,
          toolChoice: describeDecisionToolChoice(request.toolChoice),
          nativeToolCount: request.decisionTools.length,
          requestMode: request.decisionTools.length > 0 ? "tools" : "text",
          willRetry,
          ...(willRetry ? { retryDelayMs: PROVIDER_RETRY_DELAY_MS } : {}),
        },
      });
      recordDecisionFeedback(input, responseFailure.event, {
        attempt: request.decisionAttempt,
        providerAttempt,
        provider: responseFailure.provider,
        model: responseFailure.model,
        latencyMs: Date.now() - request.requestStartedAt,
        ...responseFailure.operatorDetails,
        toolChoice: describeDecisionToolChoice(request.toolChoice),
        nativeToolCount: request.decisionTools.length,
        requestMode: request.decisionTools.length > 0 ? "tools" : "text",
        willRetry,
        ...(willRetry ? { retryDelayMs: PROVIDER_RETRY_DELAY_MS } : {}),
        ...repairSignalToFeedbackData(repair),
      });

      if (!willRetry) {
        throw error;
      }
      await delay(PROVIDER_RETRY_DELAY_MS);
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
  if (!input.eventSink || !input.feedbackContext) {
    return;
  }
  input.eventSink.record({
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
  if (decision.kind === "transition_mode") {
    return {
      kind: decision.kind,
      request: decision.request,
    };
  }
  if (decision.kind === "stop") {
    return {
      kind: decision.kind,
      request: decision.request,
    };
  }
  if (decision.kind === "checkpoint_work_state") {
    return {
      kind: decision.kind,
      reason: decision.update.reason,
      planItemCount: decision.update.plan.length,
      importantContextCount: decision.update.importantContext.length,
      summary: decision.update.summary,
    };
  }
  if (decision.kind === "maintain_run_context") {
    return {
      kind: decision.kind,
      maintenanceId: decision.selection.maintenanceId,
      keepExactCount: decision.selection.keepExactRefs.length,
      keepCompactCount: decision.selection.keepCompactRefs.length,
      releaseCount: decision.selection.releaseRefs.length,
      summary: decision.selection.workState.summary,
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
  nativeToolCallRequired = false,
): RepairSignal {
  return createRepairSignal("R_ASSISTANT_TEXT_TOOL_CALL", {
    ...(nativeToolCallRequired
      ? {
          message:
            "The current graph state requires one native tool call; assistant text cannot advance this decision.",
          allowedNextActions: [
            violation.toolName
              ? `Call ${violation.toolName} through provider native tool calling.`
              : "Call exactly one currently available native tool through provider tool calling.",
            "Do not print tool names or arguments as assistant text.",
          ],
        }
      : {}),
    blockedTargets: violation.toolName ? [violation.toolName] : [],
    operatorDetails: {
      attempt,
      reason: violation.reason,
      nativeToolCallRequired,
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
      controlToolUsedAsAction: violation.controlToolUsedAsAction,
      mutationRequiresWorkstreamBinding: violation.mutationRequiresWorkstreamBinding,
    },
  });
}

function toolProtocolRepairCode(violation: ToolProtocolViolation): RepairCode {
  if (violation.reason.includes("no tool calls")) {
    return "R_NO_PROGRESS";
  }
  if (violation.controlToolUsedAsAction) {
    return "R_CONTROL_TOOL_USED_AS_ACTION";
  }
  if (violation.mutationRequiresWorkstreamBinding) {
    return "R_MUTATION_REQUIRES_WORKSTREAM_BINDING";
  }
  if (violation.reason.startsWith("Every executable tool call requires a specific purpose")) {
    return "R_TOOL_PURPOSE_INVALID";
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
  const matches = [...error.matchAll(
    /field '([^']+)' (?:expected type|is not allowed|does not match|must contain|must be)/g,
  )];
  return matches.map((match) => match[1]).filter((field): field is string => Boolean(field));
}

function validateToolProtocol(
  decision: AgentDecision,
  selectedToolDefinitions: ToolDefinition[],
  options: {
    modeTransitionAvailable: boolean;
    terminalStopAvailable: boolean;
    workStateCheckpointAvailable: boolean;
    runContextMaintenanceAvailable: boolean;
  },
): ToolProtocolViolation | null {
  const selectedTools = selectedToolDefinitions.map((tool) => tool.name);
  if (decision.kind === "transition_mode") {
    if (!options.modeTransitionAvailable) {
      return {
        kind: "tool_protocol_violation",
        reason: "Mode-transition controls are not available in the current runtime phase",
        invalidTools: [...MODE_TRANSITION_CONTROL_TOOL_NAMES],
        selectedTools,
        controlToolUsedAsAction: false,
        mutationRequiresWorkstreamBinding: false,
      };
    }
    return null;
  }

  if (decision.kind === "stop") {
    if (!options.terminalStopAvailable) {
      return {
        kind: "tool_protocol_violation",
        reason: "decision_stop is available only after the virtual graph is active",
        invalidTools: [TERMINAL_STOP_TOOL_NAME],
        selectedTools,
        controlToolUsedAsAction: false,
        mutationRequiresWorkstreamBinding: false,
      };
    }
    return null;
  }

  if (decision.kind === "checkpoint_work_state") {
    if (!options.workStateCheckpointAvailable) {
      return {
        kind: "tool_protocol_violation",
        reason: "WorkState checkpoints are available only during active graph work",
        invalidTools: [WORK_STATE_CHECKPOINT_TOOL_NAME],
        selectedTools,
        controlToolUsedAsAction: false,
        mutationRequiresWorkstreamBinding: false,
      };
    }
    return null;
  }

  if (decision.kind === "maintain_run_context") {
    if (!options.runContextMaintenanceAvailable) {
      return {
        kind: "tool_protocol_violation",
        reason: "Run-context maintenance is available only while run.maintain is active",
        invalidTools: [RUN_CONTEXT_MAINTENANCE_TOOL_NAME],
        selectedTools,
        controlToolUsedAsAction: false,
        mutationRequiresWorkstreamBinding: false,
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
    .filter((tool) => isNativeControlToolName(tool) || !selectedToolSet.has(tool));
  const invalidAllowedTools = decision.action.allowedTools.filter((tool) => isNativeControlToolName(tool) || !selectedToolSet.has(tool));
  const invalidTools = uniqueStrings([...invalidCallTools, ...invalidAllowedTools]);
  const controlToolUsedAsAction = decision.action.calls.some((call) => isNativeControlToolName(call.tool));
  const mutationRequiresWorkstreamBinding = false;

  if (decision.action.calls.length === 0) {
    return {
      kind: "tool_protocol_violation",
      reason: "act decision contained no tool calls",
      invalidTools,
      selectedTools,
      controlToolUsedAsAction,
      mutationRequiresWorkstreamBinding,
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
      controlToolUsedAsAction,
      mutationRequiresWorkstreamBinding,
    };
  }

  if (invalidTools.length === 0 && !controlToolUsedAsAction) {
    return null;
  }

  return {
    kind: "tool_protocol_violation",
    reason: controlToolUsedAsAction
      ? "A harness control was used as an action tool"
      : "act decision referenced tools not listed in Selected tools",
    invalidTools,
    selectedTools,
    controlToolUsedAsAction,
    mutationRequiresWorkstreamBinding,
  };
}

function validateNativeToolInputSchemas(
  calls: LlmToolCall[],
  nativeTools: LlmToolSchema[],
): ToolInputSchemaViolation | null {
  const selectedTools = nativeTools.map((tool) => tool.name);
  const byName = new Map(nativeTools.map((tool) => [tool.name, tool]));
  const failures: ToolInputSchemaViolation["failures"] = [];

  for (const call of calls) {
    const tool = byName.get(call.name);
    if (!tool) {
      continue;
    }
    const callInput = isPlainObject(call.input) ? call.input : {};
    const validationError = validateInputAgainstSchema(
      call.name,
      callInput,
      tool.inputSchema,
    );
    if (validationError) {
      failures.push({
        callId: call.id,
        tool: call.name,
        error: validationError,
        inputKeys: Object.keys(callInput),
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
  const error = validateJsonSchemaInput(input, schema, {
    enforceAdditionalProperties: isNativeControlToolName(toolName),
  });
  return error ? `Invalid input for '${toolName}': ${error}` : null;
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
  toolChoice: LlmToolChoice,
): void {
  agentTrace(
    "agent_decision",
    `attempt=${attempt + 1} provider_request provider=${provider.name} version=${provider.version} nativeDecisionTools=${describeDecisionToolChoice(toolChoice)} messages=${messages.length}`,
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

function buildDecisionPromptSections(
  stateView: ReturnType<typeof projectAgentStateViewForPrompt>,
  toolDefinitions: ToolDefinition[],
  toolRoutingSummary: string | undefined,
): Record<string, string> {
  return {
    "user.tools": `Selected tools:\n${formatSelectedToolNames(toolDefinitions)}`,
    "user.toolRouting": toolRoutingSummary?.trim()
      ? `Capability catalog (use exact ids in the selected mode control's capabilities field):\n${toolRoutingSummary.trim()}`
      : "",
    "user.state": `State view:\n${JSON.stringify(stateView, null, 2)}`,
  };
}

function buildStateViewPromptBreakdown(
  stateView: ReturnType<typeof projectAgentStateViewForPrompt>,
): Record<string, string | undefined> {
  return {
    "state.context": stringifySection(stateView.context),
    "state.context.core": stringifySection(stateView.context.core),
    "state.context.hot": stringifySection(stateView.context.hot),
    "state.context.tools": stringifySection(stateView.context.tools),
    "state.context.harness": stringifySection(stateView.context.harness),
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
  const groups: Record<ToolPurpose | "unclassified", string[]> = {
    list: [],
    read: [],
    search: [],
    control: [],
    mutation: [],
    unclassified: [],
  };
  for (const tool of toolDefinitions) {
    groups[getToolPurpose(tool.name) ?? "unclassified"].push(tool.name);
  }
  return (["list", "search", "read", "control", "mutation", "unclassified"] as const)
    .filter((purpose) => groups[purpose].length > 0)
    .map((purpose) => `- ${purpose}: ${groups[purpose].join(", ")}`)
    .join("\n");
}

function normalizeTerminalStopRequest(input: unknown): TerminalStopRequest {
  const record = isPlainObject(input) ? input : {};
  const outcome = record["outcome"] === "needs_user_input"
    || record["outcome"] === "blocked"
    ? record["outcome"]
    : "failed";
  return {
    outcome,
    response: typeof record["response"] === "string" ? record["response"].trim() : "",
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

function allowedModeDestinations(stateView: AgentStateView): VirtualModeTransitionTarget[] {
  const allowed = stateView.context.run?.mode?.allowedNext
    .filter((destination): destination is VirtualModeTransitionTarget => (
      destination === "context.retrieve"
      || destination === "observe.locate"
      || destination === "observe.investigate"
      || destination === "workstream.route"
      || destination === "resolve"
      || destination === "execute"
      || destination === "validation"
    ));
  return allowed
    ?? [
      "context.retrieve",
      "observe.locate",
      "observe.investigate",
      "workstream.route",
      "resolve",
      "execute",
      "validation",
    ];
}

function buildNativeDecisionTools(
  selectedTools: ToolDefinition[],
  options: {
    modeTransitionAvailable: boolean;
    terminalStopAvailable: boolean;
    workStateCheckpointAvailable: boolean;
    runContextMaintenanceAvailable: boolean;
    runContextMaintenance?: PromptRunContextMaintenanceCard;
    modeCapabilityOptions: ModeCapabilityOptions;
    allowedModeDestinations: VirtualModeTransitionTarget[];
  },
): LlmToolSchema[] {
  const controlTools: LlmToolSchema[] = [];
  if (options.modeTransitionAvailable) {
    controlTools.push(...buildModeTransitionControlTools(
      options.modeCapabilityOptions,
      options.allowedModeDestinations,
    ));
  }
  if (options.terminalStopAvailable) {
    controlTools.push({
      name: TERMINAL_STOP_TOOL_NAME,
      description: "Stop active graph work only when current state proves that user input is required, progress is blocked, or an unrecovered failure occurred. Completed work must pass validation mode and then reply directly.",
      inputSchema: objectSchema({
        outcome: {
          type: "string",
          enum: ["needs_user_input", "blocked", "failed"],
        },
        response: {
          type: "string",
          minLength: 1,
          description: "Complete user-facing terminal response to send after validation is accepted.",
        },
        workingNotes: workingNotesSchema(),
      }, ["outcome", "response"]),
    });
  }
  if (options.workStateCheckpointAvailable) {
    controlTools.push(workStateCheckpointTool());
  }
  if (options.runContextMaintenanceAvailable && options.runContextMaintenance) {
    controlTools.push(buildRunContextMaintenanceControlTool(options.runContextMaintenance));
  }
  const executableTools = selectedTools
    .filter((tool) => !isNativeControlToolName(tool.name))
    .map(toNativeExecutableToolSchema);
  return [...controlTools, ...executableTools];
}

function workStateCheckpointTool(): LlmToolSchema {
  return {
    name: WORK_STATE_CHECKPOINT_TOOL_NAME,
    description: "Checkpoint the small durable run handoff only when implementation needs a real plan or before context-pressure reduction. Do not copy routine tool output or verification details.",
    inputSchema: objectSchema({
      reason: {
        type: "string",
        enum: ["plan", "context_pressure"],
      },
      summary: {
        type: "string",
        minLength: 1,
        maxLength: WORK_STATE_LIMITS.summaryChars,
        description: "Concise description of what has actually been done and the current responsibility.",
      },
      plan: {
        type: "array",
        maxItems: WORK_STATE_LIMITS.planItems,
        description: "Flat implementation plan. Keep empty unless work is genuinely complex.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: {
              type: "string",
              minLength: 1,
              maxLength: WORK_STATE_LIMITS.planIdChars,
            },
            task: {
              type: "string",
              minLength: 1,
              maxLength: WORK_STATE_LIMITS.planTaskChars,
            },
            status: {
              type: "string",
              enum: ["pending", "active", "done", "blocked"],
            },
          },
          required: ["id", "task", "status"],
        },
      },
      importantContext: {
        type: "array",
        maxItems: WORK_STATE_LIMITS.importantContextItems,
        description: "Only artifacts, decisions, findings, or constraints needed to continue.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: {
              type: "string",
              enum: ["artifact", "decision", "finding", "constraint"],
            },
            value: {
              type: "string",
              minLength: 1,
              maxLength: WORK_STATE_LIMITS.importantContextValueChars,
            },
            ref: {
              type: "string",
              minLength: 1,
              maxLength: WORK_STATE_LIMITS.importantContextRefChars,
            },
          },
          required: ["kind", "value"],
        },
      },
      nextAction: {
        type: "string",
        minLength: 1,
        maxLength: WORK_STATE_LIMITS.nextActionChars,
      },
      workingNotes: workingNotesSchema(),
    }, ["reason", "summary", "plan", "importantContext"]),
  };
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
        description: "One short workstream-specific sentence explaining why this tool is being called now. Describe intent, not a claimed result.",
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
  if (isNativeControlToolName(call.name)) {
    return JSON.stringify(nativeDecisionToolCallToPayload(call.name, input));
  }

  const selected = selectedTools.find((tool) => tool.name === call.name);
  if (!selected) {
    return `native_decision_error: unknown or unselected native tool '${call.name}'. Use one available destination-specific mode control before executable work.`;
  }

  return JSON.stringify(nativeExecutableToolCallToPayload(call, input));
}

function nativeDecisionFromToolCalls(calls: LlmToolCall[], selectedTools: ToolDefinition[]): AgentDecision | string {
  if (calls.length !== 1) {
    return `native_decision_error: expected exactly one native tool call, received ${calls.length}.`;
  }

  const call = calls[0]!;
  const input = isPlainObject(call.input) ? call.input : {};
  if (isNativeControlToolName(call.name)) {
    return nativeDecisionToolCallToDecision(call.name, input);
  }

  const selected = selectedTools.find((tool) => tool.name === call.name);
  if (!selected) {
    return nativeExecutableToolCallToDecision(call, input);
  }

  return nativeExecutableToolCallToDecision(call, input);
}

function nativeDecisionToolCallToPayload(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
  if (isModeTransitionControlToolName(toolName)) {
    return {
      kind: "transition_mode",
      request: modeTransitionRequestFromControlCall(toolName, input),
      ...(input["workingNotes"] ? { workingNotes: input["workingNotes"] } : {}),
    };
  }
  switch (toolName) {
    case WORK_STATE_CHECKPOINT_TOOL_NAME:
      return {
        kind: "checkpoint_work_state",
        update: normalizeWorkStateUpdateInput(input),
        ...(input["workingNotes"] ? { workingNotes: input["workingNotes"] } : {}),
      };
    case RUN_CONTEXT_MAINTENANCE_TOOL_NAME:
      return {
        kind: "maintain_run_context",
        selection: normalizeRunContextMaintenanceSelection(input),
        ...(input["workingNotes"] ? { workingNotes: input["workingNotes"] } : {}),
      };
    case TERMINAL_STOP_TOOL_NAME:
      return {
        kind: "stop",
        request: {
          outcome: input["outcome"],
          response: input["response"],
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
  if (isModeTransitionControlToolName(toolName)) {
    return {
      kind: "transition_mode",
      request: modeTransitionRequestFromControlCall(toolName, input),
      workingNotes: normalizeWorkingNotes(input["workingNotes"]),
    };
  }
  switch (toolName) {
    case WORK_STATE_CHECKPOINT_TOOL_NAME:
      return {
        kind: "checkpoint_work_state",
        update: normalizeWorkStateUpdateInput(input),
        workingNotes: normalizeWorkingNotes(input["workingNotes"]),
      };
    case RUN_CONTEXT_MAINTENANCE_TOOL_NAME:
      return {
        kind: "maintain_run_context",
        selection: normalizeRunContextMaintenanceSelection(input),
        workingNotes: normalizeWorkingNotes(input["workingNotes"]),
      };
    case TERMINAL_STOP_TOOL_NAME:
      return {
        kind: "stop",
        request: normalizeTerminalStopRequest(input),
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
    kind: isNativeControlToolName(call.name)
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
