import type { SessionInputHandle } from "../../memory/types.js";
import type {
  AgentLoopDeps,
  AgentLoopResult,
  AgentWorkstreamSummaryRecord,
  LoopState,
  StepSummary,
  WorkState,
} from "../types.js";
import { measureJson } from "../state-compaction.js";
import { buildContextEngineFeedbackSummary } from "../feedback-ledger.js";
import { isObservationalTool } from "../../skills/tool-taxonomy.js";
import type { ToolDefinition } from "../../skills/types.js";
import type { AgentAction } from "./decision.js";
import type { ExecuteActionStepResult } from "./step-lifecycle.js";
import type { ToolLoadResult } from "./tool-working-set.js";
import { repairSignalToFeedbackData } from "./repair-policy.js";
import { createRepairSignalFromStepSummary } from "./repair-feedback.js";
import { type AgentStateView } from "./state-view.js";
import {
  deriveWorkstreamBindingCapabilityPolicy,
  isGitContextRoutingToolName,
  summarizeCapabilityTools,
} from "./workstream-binding-capability-policy.js";
import {
  summarizeStep,
  summarizeToolDefinitions,
  summarizeToolLoadResult,
  summarizeVerification,
  summarizeWorkState,
} from "./feedback-summary.js";
import { auditToolPolicy } from "./tool-policy-audit.js";

export function recordFeedback(
  deps: AgentLoopDeps,
  inputHandle: SessionInputHandle,
  runId: string | undefined,
  stage: string,
  event: string,
  data?: Record<string, unknown>,
): void {
  deps.feedbackLedger?.record({
    clientId: deps.clientId,
    sessionId: inputHandle.sessionId,
    seq: inputHandle.seq,
    ...(runId ? { runId } : {}),
    stage,
    event,
    ...(data ? { data } : {}),
  });
}

export function recordToolWorkingSetFeedback(input: {
  deps: AgentLoopDeps;
  inputHandle: SessionInputHandle;
  runId: string | undefined;
  state: LoopState;
  iteration: number;
  toolContextRunId: string | undefined;
  deterministicToolLoad: ToolLoadResult | undefined;
  visibleTools: ToolDefinition[];
  selectedTools: ToolDefinition[];
  runHandle: AgentLoopDeps["runHandle"];
}): void {
  const warningCodes = buildToolExposureWarningCodes(input.state, input.selectedTools);
  const policy = deriveWorkstreamBindingCapabilityPolicy(input.state);
  const toolPolicyAudit = auditToolPolicy({
    policy,
    selectedTools: input.selectedTools,
  });
  const capabilities = summarizeCapabilityTools({
    policy,
    visibleTools: input.visibleTools,
    selectedTools: input.selectedTools,
  });
  recordFeedback(input.deps, input.inputHandle, input.runId, "tools", "working_set_prepared", {
    iteration: input.iteration,
    toolContextRunId: input.toolContextRunId,
    runId: input.runHandle.runId,
    workstreamBound: policy.workstreamBound,
    pendingTurnStatus: input.state.harnessContext.contextEngine?.current.routing?.status,
    capabilities,
    deterministicLoad: summarizeToolLoadResult(input.deterministicToolLoad),
    visible: summarizeToolDefinitions(input.visibleTools),
    selected: summarizeToolDefinitions(input.selectedTools),
    toolPolicyAudit,
    normalSelectedTools: normalWorkstreamToolNames(input.selectedTools),
    contextEngine: buildContextEngineFeedbackSummary({
      context: input.state.harnessContext.contextEngine,
    }),
    ...(warningCodes.length > 0 ? { warningCodes } : {}),
  });
  recordFeedback(input.deps, input.inputHandle, input.runId, "tools", "capabilities_derived", {
    iteration: input.iteration,
    toolContextRunId: input.toolContextRunId,
    ...capabilities,
    toolPolicyAudit,
    ...(warningCodes.length > 0 ? { warningCodes } : {}),
  });
  if (!policy.workstreamBound && capabilities.visibleRoutingTools.length > 0) {
    recordFeedback(input.deps, input.inputHandle, input.runId, "tools", "workstream_routing_tools_visible", {
      iteration: input.iteration,
      toolContextRunId: input.toolContextRunId,
      visibleRoutingTools: capabilities.visibleRoutingTools,
      selectedRoutingTools: capabilities.selectedRoutingTools,
      visibleReadTools: capabilities.visibleReadTools,
      pendingTurnStatus: capabilities.pendingTurnStatus,
      routingSuppressed: capabilities.routingSuppressed,
      routingAvailable: capabilities.routingAvailable,
    });
  }
}

export function recordStepFeedback(
  deps: AgentLoopDeps,
  inputHandle: SessionInputHandle,
  runId: string,
  iteration: number,
  stepResult: ExecuteActionStepResult,
): void {
  const repair = stepResult.stepSummary.outcome === "failed"
    ? createRepairSignalFromStepSummary(stepResult.stepSummary)
    : undefined;
  recordFeedback(deps, inputHandle, runId, "verification", "completed", {
    iteration,
    step: stepResult.stepSummary.step,
    verification: summarizeVerification(stepResult.execution.verifyOutput),
    stepSummary: summarizeStep(stepResult.stepSummary),
    ...(repair ? repairSignalToFeedbackData(repair) : {}),
  });
}

export function recordReducerFeedback(
  deps: AgentLoopDeps,
  inputHandle: SessionInputHandle,
  runId: string,
  iteration: number,
  input: {
    beforeWorkStateChars: number;
    compactedWorkState: WorkState;
    stepSummary: StepSummary;
  },
): void {
  recordFeedback(deps, inputHandle, runId, "reducer", "completed", {
    iteration,
    step: input.stepSummary.step,
    beforeWorkStateChars: input.beforeWorkStateChars,
    afterWorkStateChars: measureJson(input.compactedWorkState),
    workState: summarizeWorkState(input.compactedWorkState),
    stepSummary: summarizeStep(input.stepSummary),
  });
}

export function buildToolExposureWarningCodes(
  state: LoopState,
  selectedTools: ToolDefinition[],
): string[] {
  const warningCodes: string[] = [];
  const policy = deriveWorkstreamBindingCapabilityPolicy(state);
  const pendingTurnStatus = state.harnessContext.contextEngine?.current.routing?.status;
  const normalTools = normalWorkstreamToolNames(selectedTools);
  const unsafeNormalTools = normalTools.filter((tool) => !isObservationalTool(tool));
  if ((pendingTurnStatus === "unbound" || pendingTurnStatus === "clarifying") && unsafeNormalTools.length > 0) {
    warningCodes.push("normal_tool_visible_during_pending_routing", "routing_state_mismatch");
  }
  if (!policy.workstreamBound && unsafeNormalTools.length > 0) {
    warningCodes.push("mutation_tools_selected_without_workstream_binding");
  }
  return uniqueStrings(warningCodes);
}

export function recordActionFeedback(
  deps: AgentLoopDeps,
  inputHandle: SessionInputHandle,
  runId: string,
  action: AgentAction,
  stepResult: ExecuteActionStepResult,
): void {
  const skippedCalls = stepResult.execution.actOutput.toolCalls.filter((call) => call.meta?.["skipped"] === true);
  const assertionFailures = stepResult.execution.actOutput.toolCalls.flatMap((call) => call.assertionResults ?? [])
    .filter((assertion) => assertion.status === "failed");
  recordFeedback(deps, inputHandle, runId, "action", "completed", {
    step: stepResult.stepSummary.step,
    mode: action.mode,
    plannedCallCount: action.calls.length,
    recordedCallCount: stepResult.execution.actOutput.toolCalls.length,
    skippedCallCount: skippedCalls.length,
    outcome: stepResult.stepSummary.outcome,
    summary: stepResult.stepSummary.summary,
    toolSuccessCount: stepResult.stepSummary.toolSuccessCount,
    toolFailureCount: stepResult.stepSummary.toolFailureCount,
    executionStatus: stepResult.stepSummary.executionStatus,
    validationStatus: stepResult.stepSummary.validationStatus,
    verificationMethod: stepResult.stepSummary.verificationMethod,
    verificationPassed: stepResult.execution.verifyOutput.passed,
    assertionFailureCount: assertionFailures.length,
    newFactsCount: stepResult.stepSummary.newFacts.length,
    evidenceItemCount: stepResult.stepSummary.evidenceItems?.length ?? 0,
    artifactCount: stepResult.stepSummary.artifacts.length,
    nextWorkStatus: stepResult.execution.nextWorkState.status,
    stoppedEarlyReason: stepResult.stepSummary.stoppedEarlyReason,
  });
  for (const call of stepResult.execution.actOutput.toolCalls) {
    recordFeedback(deps, inputHandle, runId, "action", "tool_result", {
      step: stepResult.stepSummary.step,
      callId: call.callId,
      tool: call.tool,
      skipped: call.meta?.["skipped"] === true,
      operationStatus: call.operationStatus,
      code: call.code,
      error: call.error,
      assertionResults: call.assertionResults?.map((assertion) => ({
        id: assertion.id,
        status: assertion.status,
        severity: assertion.severity,
        message: assertion.message,
      })),
      verifiedFactCount: call.verifiedFacts?.length ?? 0,
      outputPreview: call.output,
      artifacts: call.artifacts,
    });
  }
  if (stepResult.stepSummary.outcome === "failed") {
    recordFeedback(deps, inputHandle, runId, "action", "failed", {
      step: stepResult.stepSummary.step,
      failureType: stepResult.stepSummary.failureType,
      summary: stepResult.stepSummary.summary,
      blockedTargets: stepResult.stepSummary.blockedTargets,
    });
  }
  for (const artifact of stepResult.stepSummary.artifacts) {
    recordFeedback(deps, inputHandle, runId, "artifact", "created", {
      step: stepResult.stepSummary.step,
      artifact,
    });
  }
}

export function summarizeDecisionInputState(stateView: AgentStateView): Record<string, unknown> {
  const latestUser = [...stateView.context.temporal.recent].reverse().find((event) => event.kind === "user");
  const latestAssistantQuestion = [...stateView.context.temporal.recent].reverse()
    .find((event) => event.kind === "assistant" && event.expectsUserResponse);
  const attachmentCount = Object.values(stateView.attachments ?? {})
    .reduce((count, value) => count + (Array.isArray(value) ? value.length : 0), 0);

  return {
    temporalEventCount: stateView.context.temporal.recent.length,
    latestUserInput: latestUser && "content" in latestUser ? latestUser.content : undefined,
    pendingAssistantQuestion: latestAssistantQuestion && "content" in latestAssistantQuestion
      ? latestAssistantQuestion.content
      : undefined,
    agentStreamScope: stateView.context.stream.scopeKey,
    workstreamId: stateView.context.work.active?.workstreamId,
    workstreamTitle: stateView.context.work.active?.title,
    workstreamStatus: stateView.context.work.active?.workstreamStatus,
    workStatus: stateView.progress?.status,
    blockerCount: stateView.progress?.blockers?.length ?? 0,
    verifiedFactCount: stateView.progress?.verifiedFacts?.length ?? 0,
    recentToolCallCount: stateView.toolCalls?.length ?? 0,
    recentObservationCount: stateView.observations?.latest.length ?? 0,
    reusableObservationCount: stateView.context.observations.inventory.length
      + stateView.context.observations.discovery.length
      + stateView.context.observations.evidence.length,
    recentTraceStepCount: stateView.trace?.recentSteps?.length ?? 0,
    recentFailureCount: stateView.trace?.recentFailures?.length ?? 0,
    attachmentCount,
    toolLoadStatus: stateView.toolLoad?.status,
    systemEventName: stateView.systemEvent?.eventName,
  };
}

export function buildFinalFeedbackWarnings(input: {
  status: AgentLoopResult["status"];
  totalToolCalls: number;
  toolLoadDecisionCount: number;
  actionStepCount: number;
  failedVerificationCount: number;
  state: LoopState;
}): string[] {
  const warnings: string[] = [];
  if (input.status !== "completed") {
    warnings.push("stuck_or_failed");
  }
  if (
    input.status === "completed"
    && input.totalToolCalls === 0
    && (input.toolLoadDecisionCount > 0 || input.actionStepCount > 0 || isWorkstreamBound(input.state))
  ) {
    warnings.push("completed_without_tool_calls");
  }
  if (input.toolLoadDecisionCount > 0 && input.actionStepCount === 0) {
    warnings.push("tool_load_no_action");
  }
  if (input.toolLoadDecisionCount > 2) {
    warnings.push("repeated_tool_load");
  }
  if (input.failedVerificationCount > 0) {
    warnings.push("verification_failed");
  }
  return warnings;
}

export function summarizeWorkstreamSummary(workstreamSummary: AgentWorkstreamSummaryRecord | undefined): Record<string, unknown> | undefined {
  if (!workstreamSummary) {
    return undefined;
  }
  return {
    runId: workstreamSummary.runId,
    runStatus: workstreamSummary.runStatus,
    workstreamStatus: workstreamSummary.workstreamStatus,
    summary: workstreamSummary.summary,
    objective: workstreamSummary.objective,
    openWorkCount: workstreamSummary.openWork?.length ?? 0,
    blockerCount: workstreamSummary.blockers?.length ?? 0,
    keyFactCount: workstreamSummary.keyFacts?.length ?? 0,
    evidenceCount: workstreamSummary.evidence?.length ?? 0,
  };
}

function normalWorkstreamToolNames(tools: ToolDefinition[]): string[] {
  return tools
    .map((tool) => tool.name)
    .filter((tool) => !isGitContextRoutingToolName(tool));
}

function isWorkstreamBound(state: LoopState): boolean {
  return state.harnessContext.contextEngine?.current.routing?.status === "bound";
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
