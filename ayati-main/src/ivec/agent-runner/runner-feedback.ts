import type { MemoryRunHandle, SessionInputHandle } from "../../memory/types.js";
import type {
  AgentLoopDeps,
  AgentLoopResult,
  AgentTaskSummaryRecord,
  LoopState,
  StepSummary,
  WorkState,
} from "../types.js";
import { measureJson } from "../state-compaction.js";
import { buildContextEngineFeedbackSummary } from "../feedback-ledger.js";
import { isReadOnlyTool } from "../../skills/tool-taxonomy.js";
import { isGitContextAllowedDuringPendingRouting } from "../../skills/builtins/git-context/tool-policy.js";
import type { ToolDefinition } from "../../skills/types.js";
import type { AgentAction, AgentDecision } from "./decision.js";
import type { ExecuteActionStepResult } from "./step-lifecycle.js";
import type { ToolLoadResult } from "./tool-working-set.js";
import { repairSignalToFeedbackData } from "./repair-policy.js";
import { createRepairSignalFromStepSummary } from "./repair-feedback.js";
import { type AgentStateView } from "./state-view.js";
import {
  detectRuntimeCapabilityMode,
  isGitContextRoutingToolName,
  summarizeRuntimeCapabilityTools,
} from "./runtime-capability-mode.js";
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
  workRunHandle: MemoryRunHandle | undefined;
  sessionRunHandle: MemoryRunHandle | undefined;
}): void {
  const warningCodes = buildToolExposureWarningCodes(input.state, input.selectedTools, input.workRunHandle, input.sessionRunHandle);
  const runtimeMode = detectRuntimeCapabilityMode({
    state: input.state,
    workRunHandle: input.workRunHandle,
    sessionRunHandle: input.sessionRunHandle,
  });
  const toolPolicyAudit = auditToolPolicy({
    mode: runtimeMode,
    selectedTools: input.selectedTools,
  });
  const toolMode = summarizeRuntimeCapabilityTools({
    mode: runtimeMode,
    visibleTools: input.visibleTools,
    selectedTools: input.selectedTools,
  });
  recordFeedback(input.deps, input.inputHandle, input.runId, "tools", "working_set_prepared", {
    iteration: input.iteration,
    toolContextRunId: input.toolContextRunId,
    workRunId: input.workRunHandle?.runId,
    sessionRunId: input.sessionRunHandle?.runId,
    runHandlePresent: Boolean(input.workRunHandle || input.sessionRunHandle || input.state.runId),
    pendingTurnStatus: input.state.harnessContext.contextEngine?.pendingTurn?.routingStatus,
    toolMode,
    deterministicLoad: summarizeToolLoadResult(input.deterministicToolLoad),
    visible: summarizeToolDefinitions(input.visibleTools),
    selected: summarizeToolDefinitions(input.selectedTools),
    toolPolicyAudit,
    normalSelectedTools: normalTaskToolNames(input.selectedTools),
    contextEngine: buildContextEngineFeedbackSummary({
      context: input.state.harnessContext.contextEngine,
    }),
    ...(warningCodes.length > 0 ? { warningCodes } : {}),
  });
  recordFeedback(input.deps, input.inputHandle, input.runId, "tools", "tool_mode_selected", {
    iteration: input.iteration,
    toolContextRunId: input.toolContextRunId,
    ...toolMode,
    toolPolicyAudit,
    ...(runtimeMode.routingWindow ? { routingWindow: runtimeMode.routingWindow } : {}),
    ...(warningCodes.length > 0 ? { warningCodes } : {}),
  });
  if (runtimeMode.routingWindow) {
    const routingWindowFeedback = {
      iteration: input.iteration,
      toolContextRunId: input.toolContextRunId,
      mode: toolMode.mode,
      hasWorkRun: toolMode.hasWorkRun,
      hasSessionRun: toolMode.hasSessionRun,
      focusStatus: toolMode.focusStatus,
      pendingTurnStatus: toolMode.pendingTurnStatus,
      step: runtimeMode.routingWindow.step,
      maxSteps: runtimeMode.routingWindow.maxSteps,
      remaining: runtimeMode.routingWindow.remaining,
      open: runtimeMode.routingWindow.open,
      expired: runtimeMode.routingWindow.expired ?? false,
      expiresAfterThisDecision: runtimeMode.routingWindow.expiresAfterThisDecision,
      readToolsVisible: toolMode.visibleReadTools,
      routingToolsVisible: toolMode.visibleTaskRoutingTools,
      readToolsAvailable: runtimeMode.routingWindow.readToolsAvailable,
      routingToolsAvailable: runtimeMode.routingWindow.routingToolsAvailable,
      readToolsRemainAfterExpiry: runtimeMode.routingWindow.readToolsRemainAfterExpiry,
      guidance: runtimeMode.routingWindow.guidance,
    };
    if (runtimeMode.routingWindow.open) {
      recordFeedback(input.deps, input.inputHandle, input.runId, "tools", "routing_window_visible", routingWindowFeedback);
      if (runtimeMode.routingWindow.expiresAfterThisDecision) {
        recordFeedback(input.deps, input.inputHandle, input.runId, "tools", "routing_window_expiring", routingWindowFeedback);
      }
    } else {
      recordFeedback(input.deps, input.inputHandle, input.runId, "tools", "routing_window_expired", routingWindowFeedback);
    }
  }
  if (!toolMode.hasWorkRun && toolMode.visibleRoutingTools.length > 0) {
    recordFeedback(input.deps, input.inputHandle, input.runId, "tools", "pre_task_routing_tools_visible", {
      iteration: input.iteration,
      toolContextRunId: input.toolContextRunId,
      mode: toolMode.mode,
      visibleRoutingTools: toolMode.visibleRoutingTools,
      selectedRoutingTools: toolMode.selectedRoutingTools,
      visibleReadTools: toolMode.visibleReadTools,
      visibleTaskRoutingTools: toolMode.visibleTaskRoutingTools,
      visibleNormalTools: toolMode.visibleNormalTools,
      pendingTurnStatus: toolMode.pendingTurnStatus,
      focusStatus: toolMode.focusStatus,
      ...(runtimeMode.routingWindow ? { routingWindow: runtimeMode.routingWindow } : {}),
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
  workRunHandle: MemoryRunHandle | undefined,
  sessionRunHandle: MemoryRunHandle | undefined,
): string[] {
  const warningCodes: string[] = [];
  const mode = detectRuntimeCapabilityMode({ state, workRunHandle, sessionRunHandle });
  const pendingTurnStatus = state.harnessContext.contextEngine?.pendingTurn?.routingStatus;
  const normalTools = normalTaskToolNames(selectedTools);
  const unsafeNormalTools = normalTools.filter((tool) => !isReadOnlyTool(tool));
  if ((pendingTurnStatus === "unbound" || pendingTurnStatus === "clarifying") && unsafeNormalTools.length > 0) {
    warningCodes.push("normal_tool_visible_during_pending_routing", "routing_state_mismatch");
  }
  if (!state.runId && !workRunHandle && mode.name !== "active_task_ready" && unsafeNormalTools.length > 0) {
    warningCodes.push("normal_tools_selected_without_work_run");
  }
  return uniqueStrings(warningCodes);
}

export function missingWorkRunWarningCodes(decision: AgentDecision | undefined): string[] {
  if (decision?.kind !== "act") {
    return [];
  }
  const normalTools = decision.action.calls
    .map((call) => call.tool)
    .filter((tool) => !isGitContextAllowedDuringPendingRouting(tool));
  return normalTools.length > 0 ? ["normal_tool_before_routing"] : [];
}

export function latestCompletedTaskRoutingToolNames(state: LoopState): string[] {
  const latestStep = state.completedSteps.at(-1);
  return uniqueStrings((latestStep?.toolsUsed ?? []).filter(isGitContextRoutingToolName));
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
  const latestUser = [...stateView.context.timeline].reverse().find((event) => event.kind === "user");
  const latestAssistantQuestion = [...stateView.context.timeline].reverse()
    .find((event) => event.kind === "assistant" && event.expectsUserResponse);
  const attachmentCount = Object.values(stateView.attachments ?? {})
    .reduce((count, value) => count + (Array.isArray(value) ? value.length : 0), 0);

  return {
    timelineEventCount: stateView.context.timeline.length,
    latestUserInput: latestUser && "content" in latestUser ? latestUser.content : undefined,
    pendingAssistantQuestion: latestAssistantQuestion && "content" in latestAssistantQuestion
      ? latestAssistantQuestion.content
      : undefined,
    gitSessionId: readContextSessionId(stateView.context.gitContext?.session),
    gitWorkId: stateView.context.gitContext?.task?.workId,
    gitWorkTitle: stateView.context.gitContext?.task?.title,
    gitOpenWorkCount: stateView.context.gitContext?.task?.open.length ?? 0,
    workStatus: stateView.progress?.status,
    blockerCount: stateView.progress?.blockers?.length ?? 0,
    verifiedFactCount: stateView.progress?.verifiedFacts?.length ?? 0,
    recentToolCallCount: stateView.toolCalls?.length ?? 0,
    recentObservationCount: stateView.observations?.latest.length ?? 0,
    recentReadContextCount: stateView.readContext?.latest.length ?? 0,
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
    && (input.toolLoadDecisionCount > 0 || input.actionStepCount > 0 || input.state.runClass === "task")
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

export function summarizeTaskSummary(taskSummary: AgentTaskSummaryRecord | undefined): Record<string, unknown> | undefined {
  if (!taskSummary) {
    return undefined;
  }
  return {
    runId: taskSummary.runId,
    runStatus: taskSummary.runStatus,
    taskStatus: taskSummary.taskStatus,
    summary: taskSummary.summary,
    objective: taskSummary.objective,
    openWorkCount: taskSummary.openWork?.length ?? 0,
    blockerCount: taskSummary.blockers?.length ?? 0,
    keyFactCount: taskSummary.keyFacts?.length ?? 0,
    evidenceCount: taskSummary.evidence?.length ?? 0,
  };
}

function normalTaskToolNames(tools: ToolDefinition[]): string[] {
  return tools
    .map((tool) => tool.name)
    .filter((tool) => !isGitContextAllowedDuringPendingRouting(tool));
}

function readContextSessionId(
  session: NonNullable<LoopState["harnessContext"]["contextEngine"]>["session"] | undefined,
): string | undefined {
  if (!session) {
    return undefined;
  }
  return session.meta?.sessionId ?? (session as unknown as { sessionId?: string }).sessionId;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
