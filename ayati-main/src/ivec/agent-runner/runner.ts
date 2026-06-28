import { createHash } from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";
import { devLog, devWarn } from "../../shared/index.js";
import { prepareIncomingAttachments } from "../../documents/attachment-preparer.js";
import type { PreparedAttachmentRecord } from "../../documents/prepared-attachment-registry.js";
import type { PreparedAttachmentSummary } from "../../documents/types.js";
import type { MemoryRunHandle, SessionInputHandle } from "../../memory/types.js";
import type { TaskAssetRecord } from "../../context-engine/index.js";
import type { AgentArtifact } from "../types.js";
import type {
  ActToolCallRecord,
  AgentLoopDeps,
  AgentLoopResult,
  AgentTaskSummaryRecord,
  CompletionDirective,
  LoopConfig,
  LoopState,
  StepSummary,
  TaskSummaryFailureSummary,
  ToolObservation,
  WorkState,
} from "../types.js";
import {
  DEFAULT_LOOP_CONFIG,
} from "../types.js";
import {
  initRunDirectory,
  queueStateWrite,
  flushStateWrites,
  writeStepMarkdown,
  formatActMarkdown,
  formatVerifyMarkdown,
} from "../state-persistence.js";
import { RunStateManager } from "../run-state-manager.js";
import type { StepRecord } from "../run-state-manager.js";
import {
  createRunMetrics,
  formatRunMetrics,
  recordCompactionMetric,
  recordPlanModeMetric,
  recordRunMetric,
  recordStateSizeMetric,
  recordVerificationMetric,
  writeOptimizationMetrics,
} from "../metrics.js";
import {
  buildLoopStateSizeBreakdown,
  compactStepSummaryForState,
  compactToolContext,
  compactWorkState,
  measureJson,
} from "../state-compaction.js";
import { collectAgentArtifacts } from "../agent-artifacts.js";
import {
  applyHarnessContextToState,
  buildHarnessContextFromSources,
  createInitialHarnessContext,
  type HarnessContextInput,
} from "../harness-context.js";
import { buildAgentStateView, type AgentStateView } from "./state-view.js";
import { selectToolsForDecision } from "./tool-selector.js";
import { callAgentDecision } from "./decision.js";
import type { AgentAction, AgentDecision } from "./decision.js";
import { executeAgentAction } from "./action-executor.js";
import type { AgentActionExecutionResult } from "./action-executor.js";
import { planLocalRecovery } from "./failure-policy.js";
import { createEvidenceTools } from "./evidence-tools.js";
import { isEvidenceToolName } from "./observation-builder.js";

interface MemoryRunContext {
  runHandle: MemoryRunHandle;
  runPath: string;
  runStateManager: RunStateManager;
}

export async function runAgentLoop(
  deps: AgentLoopDeps,
  resolvedConfig?: LoopConfig,
): Promise<AgentLoopResult> {
  const config: LoopConfig = resolvedConfig ?? { ...DEFAULT_LOOP_CONFIG, ...deps.config };
  const inputHandle = resolveInputHandle(deps);
  let workRunHandle = deps.runHandle;
  let runPath = workRunHandle ? initRunDirectory(deps.dataDir, workRunHandle.runId) : "";
  let runStateManager: RunStateManager | null = runPath ? new RunStateManager(runPath) : null;
  if (runStateManager) {
    await runStateManager.ready();
  }
  const metrics = createRunMetrics();

  let totalToolCalls = 0;
  let toolLoadDecisionCount = 0;
  let actionStepCount = 0;
  let failedVerificationCount = 0;
  let lastVerificationPassed: boolean | undefined;
  const state = buildInitialState(deps, config, inputHandle, runPath, workRunHandle);
  recordFeedback(deps, inputHandle, workRunHandle?.runId, "loop", "started", {
    inputKind: state.inputKind ?? "user_message",
    userMessage: state.userMessage,
  });

  const ensureWorkRun = async (): Promise<MemoryRunContext> => {
    if (!workRunHandle) {
      const createWorkRun = deps.createWorkRun ?? ((handle: SessionInputHandle): MemoryRunHandle => {
        const sessionCreateWorkRun = deps.sessionMemory.createWorkRun;
        if (!sessionCreateWorkRun) {
          throw new Error("Session memory does not support work run creation.");
        }
        return sessionCreateWorkRun.call(deps.sessionMemory, deps.clientId, handle);
      });
      workRunHandle = createWorkRun(inputHandle);
      deps.runHandle = workRunHandle;
      deps.onWorkRunCreated?.(workRunHandle);
      recordFeedback(deps, inputHandle, workRunHandle.runId, "run", "created", {
        reason: "agent_action_or_tool_load",
      });
    }
    if (!runPath) {
      runPath = initRunDirectory(deps.dataDir, workRunHandle.runId);
      runStateManager = new RunStateManager(runPath);
      await runStateManager.ready();
      state.runId = workRunHandle.runId;
      state.runPath = runPath;
    }
    return { runHandle: workRunHandle, runPath, runStateManager: runStateManager! };
  };

  const queueStateSnapshot = (): void => {
    if (!runPath) {
      return;
    }
    void queueStateWrite(runPath, state).catch((error) => {
      devWarn(
        `[${deps.clientId}] failed to persist run state snapshot: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  };
  const recordStateSnapshotMetric = (label: string): void => {
    recordStateSizeMetric(metrics, label, buildLoopStateSizeBreakdown(state));
  };
  const finalize = async (input: {
    status: AgentLoopResult["status"];
    content?: string;
    completion?: CompletionDirective;
    responseKind?: AgentLoopResult["type"];
  }): Promise<AgentLoopResult> => {
    syncPreparedAttachmentsFromRegistry(state, deps);
    syncHarnessContext(state, deps, inputHandle);
    queueStateSnapshot();
    recordStateSnapshotMetric("final");
    if (runPath) {
      await flushStateWrites(runPath);
      await writeOptimizationMetrics(runPath, metrics).catch((error) => {
        devWarn(
          `[${deps.clientId}] failed to persist optimization metrics: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
    const cleanupRunId = state.runId || decisionScopeId(inputHandle);
    deps.skillActivationManager?.deactivateRun({
      clientId: deps.clientId,
      runId: cleanupRunId,
      sessionId: inputHandle.sessionId,
      stepNumber: state.iteration,
      ...(deps.uiContext ? { uiContext: deps.uiContext } : {}),
    });
    deps.toolWorkingSetManager?.resetRun({
      clientId: deps.clientId,
      runId: cleanupRunId,
      sessionId: inputHandle.sessionId,
      stepNumber: state.iteration,
      ...(deps.uiContext ? { uiContext: deps.uiContext } : {}),
    });
    deps.toolExecutor?.unmount?.(evidenceToolGroupId(cleanupRunId));
    devLog(`[${deps.clientId}] [metrics:agent_loop] ${formatRunMetrics(metrics)}`);
    const responseKind = input.responseKind ?? input.completion?.response_kind ?? state.preferredResponseKind ?? "reply";
    const finalContent = input.content ?? state.finalOutput;
    const taskSummary = state.runClass === "task"
      ? buildTaskSummaryRecord(state, finalContent, input.status, responseKind, input.completion)
      : undefined;
    const warningFlags = buildFinalFeedbackWarnings({
      status: input.status,
      totalToolCalls,
      toolLoadDecisionCount,
      actionStepCount,
      failedVerificationCount,
      runPath,
      state,
    });
    recordFeedback(deps, inputHandle, state.runId || workRunHandle?.runId, "final", "reply", {
      status: input.status,
      responseKind,
      content: finalContent,
      totalIterations: state.iteration,
      totalToolCalls,
      toolLoadDecisionCount,
      actionStepCount,
      failedVerificationCount,
      verificationPassed: lastVerificationPassed,
      basedOnVerifiedFacts: state.workState.verifiedFacts.length > 0 || lastVerificationPassed === true,
      warnings: warningFlags,
      runPath,
      taskSummary: summarizeTaskSummary(taskSummary),
      feedbackSummary: {
        status: input.status,
        responseKind,
        iterations: state.iteration,
        toolCalls: totalToolCalls,
        toolLoadDecisions: toolLoadDecisionCount,
        actionSteps: actionStepCount,
        verificationPassed: lastVerificationPassed ?? false,
        basedOnVerifiedFacts: state.workState.verifiedFacts.length > 0 || lastVerificationPassed === true,
        warnings: warningFlags,
      },
    });
    return buildLoopResult(state, deps.dataDir, {
      status: input.status,
      totalIterations: state.iteration,
      totalToolCalls,
      content: input.content,
      completion: input.completion,
      responseKind: input.responseKind,
    });
  };

  state.userMessage = getPrimaryUserMessage(deps);
  syncHarnessContext(state, deps, inputHandle);

  devLog(
    `[${deps.clientId}] agentLoop start inputKind=${state.inputKind ?? "user_message"} seq=${inputHandle.seq} workRun=${state.runId || "none"} message=${state.userMessage.slice(0, 160)}`,
  );

  queueStateSnapshot();
  recordStateSnapshotMetric("initial");

  if ((state.attachedDocuments ?? []).some((document) => document.kind !== "image")) {
    const work = await ensureWorkRun();
    await prepareAttachmentsForRun(deps, state, work.runHandle.runId, work.runPath);
    syncHarnessContext(state, deps, inputHandle);
    queueStateSnapshot();
  }

  while (state.status === "running" && state.iteration < config.maxIterations) {
    if (deps.signal?.aborted) {
      state.status = "failed";
      state.finalOutput = "Agent was stopped.";
      return finalize({ status: "failed", content: state.finalOutput });
    }

    syncHarnessContext(state, deps, inputHandle);
    state.iteration++;
    const finalReplyFromVerifiedState = canCompleteFromVerifiedState(state);
    if (finalReplyFromVerifiedState) {
      state.status = "completed";
      state.finalOutput = buildVerifiedCompletionReply(state);
      return finalize({
        status: "completed",
        content: state.finalOutput,
        responseKind: state.preferredResponseKind ?? "reply",
        completion: {
          done: true,
          summary: state.finalOutput,
          status: "completed",
          response_kind: state.preferredResponseKind ?? "reply",
        },
      });
    }

    const toolContext = {
      clientId: deps.clientId,
      runId: state.runId || decisionScopeId(inputHandle),
      sessionId: inputHandle.sessionId,
      stepNumber: state.iteration,
      ...(deps.uiContext ? { uiContext: deps.uiContext } : {}),
    };
    if (deps.toolWorkingSetManager) {
      deps.toolWorkingSetManager.prepareForDecision(state, toolContext);
    } else {
      await deps.skillActivationManager?.prepareForDecision(state, toolContext);
    }
    syncEvidenceTools(deps, state, toolContext);

    const visibleTools = deps.toolWorkingSetManager
      ? deps.toolWorkingSetManager.visibleToolDefinitions(toolContext)
      : deps.toolExecutor?.definitions({
        ...toolContext,
      }) ?? deps.toolDefinitions;
    const selectedTools = finalReplyFromVerifiedState
      ? []
      : selectToolsForDecision(state, visibleTools, config.maxSelectedTools);
    const stateView = buildAgentStateView(state);
    recordFeedback(deps, inputHandle, state.runId || workRunHandle?.runId, "decision", "prompt_summary", {
      iteration: state.iteration,
      nativeControlTools: ["decision_reply", "decision_ask_user", "decision_load_tools"],
      selectedTools: selectedTools.map((tool) => tool.name),
      selectedToolCount: selectedTools.length,
      visibleToolCount: visibleTools.length,
      executableToolsVisibleNatively: true,
      toolRoutingAvailable: Boolean(deps.toolWorkingSetManager?.getPromptSummary().trim()),
      workStatus: state.workState.status,
      progressSummary: state.workState.summary,
      workingFeedbackCount: stateView.workingFeedback?.latest.length ?? 0,
      recentFailureCount: state.failureHistory.length,
      consecutiveFailures: state.consecutiveFailures,
      finalReplyFromVerifiedState,
      inputState: summarizeDecisionInputState(stateView),
    });
    const decision = await callAgentDecision({
      provider: deps.provider,
      stateView,
      toolDefinitions: selectedTools,
      toolRoutingSummary: deps.toolWorkingSetManager?.getPromptSummary(),
      systemContext: deps.systemContext,
      metrics,
      feedbackLedger: deps.feedbackLedger,
      feedbackContext: {
        clientId: deps.clientId,
        sessionId: inputHandle.sessionId,
        seq: inputHandle.seq,
        ...(state.runId || workRunHandle?.runId ? { runId: state.runId || workRunHandle?.runId } : {}),
      },
    });
    discardModelWorkingNotes(decision);

    if (decision.kind === "reply") {
      state.status = decision.status === "failed" ? "failed" : "completed";
      state.finalOutput = decision.message;
      if (decision.status === "completed" && canMarkTerminalReplyDone(state)) {
        state.workState = {
          ...state.workState,
          status: "done",
          summary: state.workState.summary || decision.message,
        };
      }
      const responseKind = state.preferredResponseKind ?? "reply";
      return finalize({
        status: state.status,
        content: state.finalOutput,
        responseKind,
        completion: {
          done: true,
          summary: decision.message,
          status: decision.status,
          response_kind: responseKind,
        },
      });
    }

    if (decision.kind === "ask_user") {
      state.runClass = "task";
      state.status = "completed";
      state.workState = {
        ...state.workState,
        status: "needs_user_input",
        userInputNeeded: decision.question,
        summary: decision.reason || "User input is needed before the task can continue.",
      };
      state.finalOutput = decision.question;
      return finalize({
        status: "completed",
        content: state.finalOutput,
        responseKind: "feedback",
        completion: {
          done: true,
          summary: decision.question,
          status: "completed",
          response_kind: "feedback",
          feedback_kind: "clarification",
        },
      });
    }

    if (decision.kind === "load_tools") {
      toolLoadDecisionCount++;
      const work = await ensureWorkRun();
      const workToolContext = { ...toolContext, runId: work.runHandle.runId };
      recordFeedback(deps, inputHandle, work.runHandle.runId, "tool_load", "requested", {
        iteration: state.iteration,
        request: decision.request,
      });
      const loadResult = deps.toolWorkingSetManager?.load(decision.request, workToolContext) ?? {
        status: "failed" as const,
        requested: {
          ...(decision.request.query ? { query: decision.request.query } : {}),
          toolNames: decision.request.toolNames ?? [],
          groups: decision.request.groups ?? [],
        },
        loaded: [],
        alreadyActive: [],
        evicted: [],
        missing: [],
        message: "No tool working-set manager is available.",
      };
      state.lastToolLoad = loadResult;
      recordFeedback(deps, inputHandle, work.runHandle.runId, "tool_load", "completed", {
        iteration: state.iteration,
        request: decision.request,
        result: loadResult,
        status: loadResult.status,
        loaded: loadResult.loaded,
        alreadyActive: loadResult.alreadyActive,
        missing: loadResult.missing,
        evicted: loadResult.evicted,
        message: loadResult.message,
      });
      queueStateSnapshot();
      recordRunMetric(metrics, "tool_load_decision", {
        kind: "local",
        status: ["loaded", "partial", "already_active"].includes(loadResult.status) ? "success" : "failed",
      });
      continue;
    }

    const work = await ensureWorkRun();
    const workToolContext = { ...toolContext, runId: work.runHandle.runId };
    if (deps.toolWorkingSetManager) {
      deps.toolWorkingSetManager.prepareForDecision(state, workToolContext);
    } else {
      await deps.skillActivationManager?.prepareForDecision(state, workToolContext);
    }
    syncEvidenceTools(deps, state, workToolContext);
    recordFeedback(deps, inputHandle, work.runHandle.runId, "action", "started", {
      iteration: state.iteration,
      mode: decision.action.mode,
      plannedCallCount: decision.action.calls.length,
      calls: decision.action.calls.map((call) => ({
        id: call.id,
        tool: call.tool,
        input: summarizeActionInput(call.input),
        dependsOn: call.dependsOn,
        purpose: call.purpose,
      })),
      allowedTools: decision.action.allowedTools,
    });
    const stepResult = await executeActionStep({
      deps,
      state,
      config,
      metrics,
      selectedTools,
      decision,
      stepNumber: state.iteration,
    });
    actionStepCount++;
    lastVerificationPassed = stepResult.execution.verifyOutput.passed;
    if (!stepResult.execution.verifyOutput.passed) {
      failedVerificationCount++;
    }
    totalToolCalls += stepResult.stepSummary.toolSuccessCount + stepResult.stepSummary.toolFailureCount;
    recordActionFeedback(deps, inputHandle, work.runHandle.runId, decision.action, stepResult);

    const beforeWorkStateChars = measureJson(stepResult.execution.nextWorkState);
    const compactedWorkState = compactWorkState(stepResult.execution.nextWorkState);
    recordCompactionMetric(metrics, "workState", beforeWorkStateChars, measureJson(compactedWorkState), { step: state.iteration });
    state.workState = compactedWorkState;
    state.toolContext = compactToolContext({ recent: getLatestObservations(stepResult.execution) });
    stepResult.stepSummary.workState = compactedWorkState;
    stepResult.stepRecord.workState = compactedWorkState;

    const compactedStep = compactStepSummaryForState(stepResult.stepSummary);
    recordCompactionMetric(metrics, "completedStepSummary", measureJson(stepResult.stepSummary), measureJson(compactedStep), { step: state.iteration });
    const evidenceReviewAction = isEvidenceReviewAction(decision.action);
    if (!evidenceReviewAction) {
      state.completedSteps.push(compactedStep);
      await work.runStateManager.appendStepRecord(stepResult.stepRecord, stepResult.fullStepText);
    }

    recordPlanModeMetric(metrics, decision.action.mode, {
      step: state.iteration,
      tools: decision.action.calls.map((call) => call.tool).join(","),
    });
    recordVerificationMetric(metrics, stepResult.stepSummary.verificationMethod, {
      step: state.iteration,
      executionStatus: stepResult.stepSummary.executionStatus,
      validationStatus: stepResult.stepSummary.validationStatus,
    });
    deps.skillActivationManager?.cleanupAfterStep(stepResult.stepSummary.toolsUsed ?? [], {
      clientId: deps.clientId,
      runId: work.runHandle.runId,
      sessionId: inputHandle.sessionId,
      stepNumber: state.iteration,
      ...(deps.uiContext ? { uiContext: deps.uiContext } : {}),
    });
    if (deps.toolWorkingSetManager) {
      const cleanupContext = {
        clientId: deps.clientId,
        runId: work.runHandle.runId,
        sessionId: inputHandle.sessionId,
        stepNumber: state.iteration,
        ...(deps.uiContext ? { uiContext: deps.uiContext } : {}),
      };
      state.lastToolLoad = deps.toolWorkingSetManager.afterExecution(stepResult.execution.actOutput.toolCalls, cleanupContext);
      deps.toolWorkingSetManager.cleanupAfterStep(cleanupContext);
    }

    if (stepResult.stepSummary.outcome === "failed") {
      state.consecutiveFailures++;
      state.failureHistory.push({
        step: stepResult.stepSummary.step,
        executionContract: stepResult.stepSummary.executionContract,
        failureType: stepResult.stepSummary.failureType ?? "verify_failed",
        reason: buildFailureHistoryReason(stepResult.stepSummary),
        blockedTargets: stepResult.stepSummary.blockedTargets ?? [],
      });
      if (hasRepeatedToolInputValidationFailure(state.failureHistory)) {
        state.status = "failed";
        state.finalOutput = buildFailureReply(state);
        return finalize({ status: "failed", content: state.finalOutput });
      }
      if (state.consecutiveFailures >= config.maxConsecutiveFailures) {
        state.status = "failed";
        state.finalOutput = buildFailureReply(state);
        return finalize({ status: "failed", content: state.finalOutput });
      }
    } else {
      state.consecutiveFailures = 0;
    }

    queueStateSnapshot();
    recordStateSnapshotMetric("after_step");
    deps.onProgress?.(
      `Step ${state.iteration}: ${stepResult.stepSummary.executionContract} -> ${stepResult.stepSummary.outcome}`,
      runPath,
    );

    if (canCompleteLocallyAfterAction(decision.action, stepResult.stepSummary, state.workState)) {
      state.workState = compactWorkState({
        ...state.workState,
        status: "done",
      });
      recordRunMetric(metrics, "verified_completion", { kind: "local" });
      state.status = "completed";
      state.finalOutput = buildVerifiedCompletionReply(state, decision.action);
      return finalize({
        status: "completed",
        content: state.finalOutput,
        responseKind: state.preferredResponseKind ?? "reply",
        completion: {
          done: true,
          summary: state.finalOutput,
          status: "completed",
          response_kind: state.preferredResponseKind ?? "reply",
        },
      });
    }
  }

  state.status = "stuck";
  state.finalOutput = `I reached the ${config.maxIterations}-step limit before finishing the task.`;
  return finalize({ status: "stuck", content: state.finalOutput });
}

interface ExecuteActionStepInput {
  deps: AgentLoopDeps;
  state: LoopState;
  config: LoopConfig;
  metrics: ReturnType<typeof createRunMetrics>;
  selectedTools: ReturnType<typeof selectToolsForDecision>;
  decision: Extract<AgentDecision, { kind: "act" }>;
  stepNumber: number;
}

interface ExecuteActionStepResult {
  execution: AgentActionExecutionResult;
  stepSummary: StepSummary;
  stepRecord: StepRecord;
  fullStepText: string;
}

function recordFeedback(
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

function recordActionFeedback(
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
      outputStorage: call.outputStorage,
      rawOutputPath: call.rawOutputPath,
      artifacts: call.artifacts,
      evidenceRef: call.evidenceRef,
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

function summarizeDecisionInputState(stateView: AgentStateView): Record<string, unknown> {
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
    gitSessionId: stateView.context.gitContext?.session.sessionId,
    gitWorkId: stateView.context.gitContext?.task?.workId,
    gitWorkTitle: stateView.context.gitContext?.task?.title,
    gitOpenWorkCount: stateView.context.gitContext?.task?.open.length ?? 0,
    workStatus: stateView.progress?.status,
    blockerCount: stateView.progress?.blockers?.length ?? 0,
    verifiedFactCount: stateView.progress?.verifiedFacts?.length ?? 0,
    evidenceRefCount: stateView.progress?.evidenceRefs?.length ?? 0,
    recentObservationCount: stateView.observations?.latest.length ?? 0,
    recentTraceStepCount: stateView.trace?.recentSteps?.length ?? 0,
    recentFailureCount: stateView.trace?.recentFailures?.length ?? 0,
    attachmentCount,
    toolLoadStatus: stateView.toolLoad?.status,
    systemEventName: stateView.systemEvent?.eventName,
  };
}

function buildFinalFeedbackWarnings(input: {
  status: AgentLoopResult["status"];
  totalToolCalls: number;
  toolLoadDecisionCount: number;
  actionStepCount: number;
  failedVerificationCount: number;
  runPath: string;
  state: LoopState;
}): string[] {
  const warnings: string[] = [];
  if (input.status !== "completed") {
    warnings.push("stuck_or_failed");
  }
  if (
    input.status === "completed"
    && input.totalToolCalls === 0
    && (input.toolLoadDecisionCount > 0 || input.actionStepCount > 0 || input.state.runClass === "task" || input.runPath.length > 0)
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

function summarizeTaskSummary(taskSummary: AgentTaskSummaryRecord | undefined): Record<string, unknown> | undefined {
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

async function executeActionStep(input: ExecuteActionStepInput): Promise<ExecuteActionStepResult> {
  input.state.runClass = "task";
  const runHandle = requireWorkRunHandle(input.deps);
  let execution = await executeAgentAction(
    {
      toolExecutor: input.deps.toolExecutor,
      selectedTools: input.selectedTools,
      config: input.config,
      clientId: input.deps.clientId,
      ...(input.deps.uiContext ? { uiContext: input.deps.uiContext } : {}),
      runRecorder: input.deps.runRecorder ?? input.deps.sessionMemory,
      runHandle,
      metrics: input.metrics,
      runPath: input.state.runPath,
      taskAssets: input.state.harnessContext.contextEngine?.task?.assets,
    },
    input.decision.action,
    input.stepNumber,
    input.state.workState,
  );

  if (!execution.verifyOutput.passed) {
    const recovery = planLocalRecovery(input.decision.action, execution.actOutput.toolCalls);
    if (recovery) {
      recordRunMetric(input.metrics, "local_recovery", { kind: "local" });
      const retryExecution = await executeAgentAction(
        {
          toolExecutor: input.deps.toolExecutor,
          selectedTools: input.selectedTools,
          config: input.config,
          clientId: input.deps.clientId,
          ...(input.deps.uiContext ? { uiContext: input.deps.uiContext } : {}),
          runRecorder: input.deps.runRecorder ?? input.deps.sessionMemory,
          runHandle,
          metrics: input.metrics,
          runPath: input.state.runPath,
          taskAssets: input.state.harnessContext.contextEngine?.task?.assets,
        },
        recovery.action,
        input.stepNumber,
        input.state.workState,
      );
      execution = mergeRecoveredExecution(execution, retryExecution, recovery.reason);
    }
  }

  await applyToolStateUpdates(input.state, input.deps, execution.actOutput.toolCalls);
  syncPreparedAttachmentsFromRegistry(input.state, input.deps);

  const pad = String(input.stepNumber).padStart(3, "0");
  const actMarkdownPath = `steps/${pad}-act.md`;
  const verifyMarkdownPath = `steps/${pad}-verify.md`;
  writeStepMarkdown(input.state.runPath, actMarkdownPath, formatActMarkdown(execution.actOutput));
  writeStepMarkdown(input.state.runPath, verifyMarkdownPath, formatVerifyMarkdown(execution.verifyOutput, execution.actOutput.toolCalls));

  const stepSummary = buildStepSummary({
    stepNumber: input.stepNumber,
    action: input.decision.action,
    execution,
    actMarkdownPath,
    verifyMarkdownPath,
  });
  const stepRecord = buildStepRecord(stepSummary, execution);
  const fullStepText = [
    `Step ${input.stepNumber}`,
    formatActMarkdown(execution.actOutput),
    formatVerifyMarkdown(execution.verifyOutput, execution.actOutput.toolCalls),
  ].join("\n\n");

  return {
    execution,
    stepSummary,
    stepRecord,
    fullStepText,
  };
}

async function applyToolStateUpdates(state: LoopState, deps: AgentLoopDeps, calls: ActToolCallRecord[]): Promise<void> {
  for (const update of calls.flatMap((call) => readToolStateUpdates(call.meta))) {
    if (update["type"] === "restore_prepared_attachment") {
      syncPreparedAttachmentsFromRegistry(state, deps);
      continue;
    }
    if (update["type"] === "restore_managed_file") {
      await syncManagedFilesFromLibrary(state, deps);
      continue;
    }
    if (update["type"] === "restore_managed_directory") {
      await syncManagedDirectoriesFromLibrary(state, deps);
      continue;
    }
    if (update["type"] === "mark_document_indexed") {
      const preparedInputId = readString(update["preparedInputId"]);
      if (!preparedInputId) continue;
      deps.preparedAttachmentRegistry?.updateAttachmentSummary(state.runId, preparedInputId, (summary) => ({
        ...summary,
        ...(summary.unstructured ? {
          unstructured: {
            ...summary.unstructured,
            indexed: update["indexed"] === true,
          },
        } : {}),
      }));
      continue;
    }
    if (update["type"] === "mark_dataset_staged") {
      const preparedInputId = readString(update["preparedInputId"]);
      if (!preparedInputId) continue;
      deps.preparedAttachmentRegistry?.updateAttachmentSummary(state.runId, preparedInputId, (summary) => ({
        ...summary,
        ...(summary.structured ? {
          structured: {
            ...summary.structured,
            staged: update["staged"] === true,
            ...(readString(update["stagingDbPath"]) ? { stagingDbPath: readString(update["stagingDbPath"])! } : {}),
            ...(readString(update["stagingTableName"]) ? { stagingTableName: readString(update["stagingTableName"])! } : {}),
          },
        } : {}),
      }));
    }
  }
}

async function syncManagedFilesFromLibrary(state: LoopState, deps: AgentLoopDeps): Promise<void> {
  if (!deps.fileLibrary) {
    return;
  }
  state.managedFiles = await deps.fileLibrary.listRunFiles(state.runId);
}

async function syncManagedDirectoriesFromLibrary(state: LoopState, deps: AgentLoopDeps): Promise<void> {
  if (!deps.directoryLibrary) {
    return;
  }
  state.managedDirectories = await deps.directoryLibrary.listRunDirectories(state.runId);
}

function syncPreparedAttachmentsFromRegistry(state: LoopState, deps: AgentLoopDeps): void {
  const records = deps.preparedAttachmentRegistry?.getRunAttachments(state.runId) ?? [];
  if (records.length === 0) {
    return;
  }
  state.preparedAttachmentRecords = records;
  state.preparedAttachments = records.map((record) => record.summary);
}

function readToolStateUpdates(meta: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
  const raw = meta?.["stateUpdates"];
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)));
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function mergeRecoveredExecution(
  first: AgentActionExecutionResult,
  retry: AgentActionExecutionResult,
  reason: string,
): AgentActionExecutionResult {
  return {
    actOutput: {
      toolCalls: [...first.actOutput.toolCalls, ...retry.actOutput.toolCalls],
      finalText: retry.actOutput.finalText,
      stoppedEarlyReason: retry.actOutput.stoppedEarlyReason,
    },
    verifyOutput: {
      ...retry.verifyOutput,
      evidenceItems: [reason, ...first.verifyOutput.evidenceItems, ...retry.verifyOutput.evidenceItems],
      evidenceSummary: [reason, first.verifyOutput.evidenceSummary, retry.verifyOutput.evidenceSummary]
        .filter((item) => item.trim().length > 0)
        .join(" "),
    },
    nextWorkState: retry.nextWorkState,
  };
}

function buildStepSummary(input: {
  stepNumber: number;
  action: AgentAction;
  execution: AgentActionExecutionResult;
  actMarkdownPath: string;
  verifyMarkdownPath: string;
}): StepSummary {
  const toolSuccessCount = input.execution.actOutput.toolCalls.filter((call) => !call.error).length;
  const toolFailureCount = input.execution.actOutput.toolCalls.length - toolSuccessCount;
  const artifacts = [
    input.actMarkdownPath,
    input.verifyMarkdownPath,
    ...input.execution.actOutput.toolCalls.flatMap((call) => (call.artifacts ?? []).map((artifact) => artifact.path ?? artifact.uri ?? artifact.id ?? "")),
    ...input.execution.verifyOutput.artifacts,
  ].filter((artifact) => artifact.trim().length > 0);
  const failure = classifyFailure(input.execution);

  return {
    step: input.stepNumber,
    executionContract: buildActionExecutionContract(input.action),
    outcome: input.execution.verifyOutput.passed ? "success" : "failed",
    summary: input.execution.verifyOutput.summary,
    newFacts: input.execution.verifyOutput.newFacts,
    artifacts: [...new Set(artifacts)],
    toolsUsed: [...new Set(input.execution.actOutput.toolCalls.map((call) => call.tool))],
    toolSuccessCount,
    toolFailureCount,
    contractVersion: 2,
    verificationPolicy: "deterministic",
    verificationRationale: "The runner uses tool result contracts and local assertions before any semantic model review.",
    expectedArtifacts: [],
    expectedStateChange: "Verified facts and work state are updated from tool-owned evidence.",
    requiresFullStepContext: false,
    expectationCheckStatus: input.execution.verifyOutput.expectationCheckStatus,
    expectationCheckSummary: input.execution.verifyOutput.expectationCheckSummary,
    verificationMethod: input.execution.verifyOutput.method,
    executionStatus: input.execution.verifyOutput.executionStatus,
    validationStatus: input.execution.verifyOutput.validationStatus,
    evidenceSummary: input.execution.verifyOutput.evidenceSummary,
    evidenceItems: input.execution.verifyOutput.evidenceItems,
    usedRawArtifacts: input.execution.verifyOutput.usedRawArtifacts,
    workState: input.execution.nextWorkState,
    stoppedEarlyReason: input.execution.actOutput.stoppedEarlyReason,
    failureType: failure.failureType,
    blockedTargets: failure.blockedTargets,
  };
}

function buildStepRecord(step: StepSummary, execution: AgentActionExecutionResult): StepRecord {
  return {
    step: step.step,
    executionContract: step.executionContract ?? "",
    outcome: step.outcome,
    summary: step.summary,
    newFacts: step.newFacts,
    artifacts: step.artifacts,
    toolSuccessCount: step.toolSuccessCount,
    toolFailureCount: step.toolFailureCount,
    contractVersion: 2,
    verificationPolicy: step.verificationPolicy,
    verificationRationale: step.verificationRationale,
    expectedArtifacts: step.expectedArtifacts,
    expectedStateChange: step.expectedStateChange,
    requiresFullStepContext: step.requiresFullStepContext,
    expectationCheckStatus: step.expectationCheckStatus,
    expectationCheckSummary: step.expectationCheckSummary,
    verificationMethod: step.verificationMethod,
    executionStatus: step.executionStatus,
    validationStatus: step.validationStatus,
    evidenceSummary: step.evidenceSummary,
    evidenceItems: step.evidenceItems ?? [],
    workState: step.workState,
    stoppedEarlyReason: step.stoppedEarlyReason,
    failureType: step.failureType,
    blockedTargets: step.blockedTargets ?? [],
    act: {
      toolCalls: execution.actOutput.toolCalls,
      finalText: execution.actOutput.finalText,
    },
  };
}

function buildInitialState(
  deps: AgentLoopDeps,
  config: LoopConfig,
  inputHandle: SessionInputHandle,
  runPath: string,
  runHandle: MemoryRunHandle | undefined,
): LoopState {
  const harnessContext = createInitialHarnessContext(harnessContextInputFromDeps(deps));
  return {
    runId: runHandle?.runId ?? "",
    currentSeq: inputHandle.seq,
    runClass: "interaction",
    inputKind: deps.inputKind ?? (deps.systemEvent ? "system_event" : "user_message"),
    userMessage: "",
    systemEvent: deps.systemEvent,
    originSource: deps.systemEvent?.source,
    systemEventIntentKind: deps.systemEventIntentKind,
    systemEventRequestedAction: deps.systemEventRequestedAction,
    systemEventCreatedBy: deps.systemEventCreatedBy,
    handlingMode: deps.systemEventHandlingMode,
    approvalRequired: deps.systemEventApprovalRequired,
    approvalState: deps.systemEventApprovalState,
    contextVisibility: deps.systemEventContextVisibility,
    preferredResponseKind: deps.preferredResponseKind,
    workState: emptyWorkState(),
    status: "running",
    finalOutput: "",
    iteration: 0,
    maxIterations: config.maxIterations,
    consecutiveFailures: 0,
    completedSteps: [],
    runPath,
    failureHistory: [],
    attachedDocuments: deps.attachedDocuments ?? [],
    attachmentWarnings: deps.attachmentWarnings ?? [],
    preparedAttachments: [],
    preparedAttachmentRecords: [],
    managedFiles: deps.managedFiles ?? [],
    managedDirectories: deps.managedDirectories ?? [],
    harnessContext,
    toolContext: { recent: [] },
  };
}

function resolveInputHandle(deps: AgentLoopDeps): SessionInputHandle {
  if (deps.inputHandle) {
    return deps.inputHandle;
  }
  if (deps.runHandle) {
    return {
      sessionId: deps.runHandle.sessionId,
      seq: deps.runHandle.triggerSeq ?? 1,
    };
  }
  throw new Error("Agent loop requires a session input handle.");
}

function decisionScopeId(inputHandle: SessionInputHandle): string {
  return `decision:${inputHandle.sessionId}:${inputHandle.seq}`;
}

function requireWorkRunHandle(deps: AgentLoopDeps): MemoryRunHandle {
  if (!deps.runHandle) {
    throw new Error("Action execution requires a work run.");
  }
  return deps.runHandle;
}

async function prepareAttachmentsForRun(
  deps: AgentLoopDeps,
  state: LoopState,
  runId: string,
  runPath: string,
): Promise<void> {
  const preparableDocuments = (state.attachedDocuments ?? []).filter((document) => document.kind !== "image");
  if (preparableDocuments.length === 0 || !deps.documentStore || !deps.preparedAttachmentRegistry) {
    return;
  }
  const prepared = await prepareIncomingAttachments({
    attachedDocuments: preparableDocuments,
    runId,
    runPath,
    documentStore: deps.documentStore,
    registry: deps.preparedAttachmentRegistry,
  });
  state.preparedAttachments = prepared.summaries;
  state.preparedAttachmentRecords = prepared.records;
}

function syncHarnessContext(state: LoopState, deps: AgentLoopDeps, inputHandle: SessionInputHandle): void {
  applyHarnessContextToState(state, buildHarnessContextFromSources({
    sessionMemory: deps.sessionMemory,
    clientId: deps.clientId,
    sessionId: inputHandle.sessionId,
    userMessage: state.userMessage,
    input: harnessContextInputFromDeps(deps),
  }));
}

function harnessContextInputFromDeps(deps: AgentLoopDeps): HarnessContextInput {
  return deps.harnessContext ?? {};
}

function getPrimaryUserMessage(deps: AgentLoopDeps): string {
  const override = deps.userMessageOverride?.trim();
  if (override) {
    return override;
  }
  const systemEventSummary = deps.systemEvent?.summary?.trim();
  if (systemEventSummary) {
    return systemEventSummary;
  }
  const initial = deps.initialUserMessage?.trim();
  if (initial) {
    return initial;
  }
  const context = deps.sessionMemory.getPromptMemoryContext();
  const lastUser = [...(context.conversationTurns ?? [])].reverse().find((turn) => turn.role === "user");
  return lastUser?.content ?? "";
}

function emptyWorkState(): WorkState {
  return {
    status: "not_done",
    openWork: [],
    blockers: [],
    summary: "",
    verifiedFacts: [],
    evidence: [],
  };
}

function canMarkTerminalReplyDone(state: LoopState): boolean {
  return state.workState.status === "not_done"
    && (state.workState.openWork?.length ?? 0) === 0
    && (state.workState.blockers?.length ?? 0) === 0
    && !state.workState.userInputNeeded?.trim();
}

function discardModelWorkingNotes(decision: AgentDecision): void {
  void decision.workingNotes;
}

function getLatestObservations(execution: AgentActionExecutionResult): ToolObservation[] {
  return execution.actOutput.toolCalls
    .map((call) => call.observation)
    .filter((observation): observation is NonNullable<ActToolCallRecord["observation"]> => observation !== undefined);
}

function isEvidenceReviewAction(action: AgentAction): boolean {
  return action.calls.length > 0 && action.calls.every((call) => isEvidenceToolName(call.tool));
}

function syncEvidenceTools(
  deps: AgentLoopDeps,
  state: LoopState,
  toolContext: { runId: string; sessionId: string; stepNumber: number; clientId: string },
): void {
  if (!deps.toolExecutor?.mount || !deps.toolExecutor.unmount) {
    return;
  }
  const groupId = evidenceToolGroupId(toolContext.runId);
  const evidenceRefs = state.workState.evidenceRefs ?? [];
  if (evidenceRefs.length === 0) {
    deps.toolExecutor.unmount(groupId);
    return;
  }
  deps.toolExecutor.mount(groupId, createEvidenceTools(state), {
    scope: "run",
    runId: toolContext.runId,
    sessionId: toolContext.sessionId,
    activatedAtStep: toolContext.stepNumber,
    skillId: "evidence",
    toolIds: ["next_chunk", "search", "read_lines", "tail"],
    description: "Run-scoped tools for reading saved tool-output evidence.",
  });
}

function evidenceToolGroupId(runId: string): string {
  return `dynamic:evidence:${runId}`;
}

function canCompleteFromVerifiedState(state: LoopState): boolean {
  return state.workState.status === "done" && state.workState.userInputNeeded === undefined;
}

function canCompleteLocallyAfterAction(
  action: AgentAction,
  step: StepSummary,
  workState: WorkState,
): boolean {
  return action.completion?.intent === "completion_candidate"
    && step.outcome === "success"
    && step.toolFailureCount === 0
    && !(workState.userInputNeeded?.trim())
    && (workState.blockers?.length ?? 0) === 0;
}

function buildVerifiedCompletionReply(state: LoopState, action?: AgentAction): string {
  const reason = action?.completion?.reason?.trim();
  if (reason) {
    return reason;
  }
  const summary = state.workState.summary?.trim();
  if (summary) {
    return summary;
  }
  return "I completed the task.";
}

function buildFailureReply(state: LoopState): string {
  const latest = state.failureHistory[state.failureHistory.length - 1];
  if (!latest) {
    return "I couldn't complete the task.";
  }
  return `I couldn't complete the task. Latest failure: ${latest.reason}`;
}

function hasRepeatedToolInputValidationFailure(history: LoopState["failureHistory"]): boolean {
  if (history.length < 2) {
    return false;
  }
  const latest = history[history.length - 1];
  const previous = history[history.length - 2];
  if (!latest || !previous || latest.reason !== previous.reason) {
    return false;
  }
  return latest.reason.includes("Invalid input for")
    || latest.reason.includes("Tool input preflight failed");
}

function buildFailureHistoryReason(step: StepSummary): string {
  const primaryEvidence = step.evidenceItems?.find((item) => item.trim().length > 0);
  if (
    primaryEvidence
    && (
      step.summary === "Step failed during tool execution before output validation could run."
      || step.summary === "Step produced no output to validate."
    )
  ) {
    return `${step.summary}: ${primaryEvidence}`;
  }
  return step.summary;
}

function summarizeActionInput(input: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(input);
  return {
    keys,
    empty: keys.length === 0,
    summary: keys.length === 0
      ? "empty object"
      : keys.map((key) => `${key}:${describeActionInputValue(input[key])}`).join(", "),
  };
}

function describeActionInputValue(value: unknown): string {
  if (Array.isArray(value)) return `array(${value.length})`;
  if (value === null) return "null";
  if (typeof value === "object") return "object";
  return typeof value;
}

function buildActionExecutionContract(action: AgentAction): string {
  const calls = action.calls.map((call) => `${call.tool}${call.purpose ? ` (${call.purpose})` : ""}`).join(", ");
  return `${action.mode} action: ${calls || "no calls"}`;
}

function classifyFailure(execution: AgentActionExecutionResult): {
  failureType?: StepSummary["failureType"];
  blockedTargets: string[];
} {
  if (execution.verifyOutput.passed) {
    return { blockedTargets: [] };
  }

  const failedCalls = execution.actOutput.toolCalls.filter((call) => call.error);
  const categories = failedCalls.map((call) => call.result?.error?.category);
  const failureType: StepSummary["failureType"] = categories.includes("permission")
    ? "permission"
    : categories.includes("missing_path")
      ? "missing_path"
      : categories.includes("validation")
        ? "validation_error"
        : failedCalls.length > 0
          ? "tool_error"
          : "verify_failed";
  const blockedTargets = failedCalls
    .map((call) => call.result?.error?.target)
    .filter((target): target is string => typeof target === "string" && target.trim().length > 0);
  return {
    failureType,
    blockedTargets,
  };
}

function buildLoopResult(
  state: LoopState,
  dataDir: string,
  input: {
    status: AgentLoopResult["status"];
    totalIterations: number;
    totalToolCalls: number;
    content?: string;
    completion?: CompletionDirective;
    responseKind?: AgentLoopResult["type"];
  },
): AgentLoopResult {
  const content = input.content ?? input.completion?.summary ?? state.finalOutput;
  const responseKind = input.responseKind ?? input.completion?.response_kind ?? state.preferredResponseKind ?? "reply";
  const result: AgentLoopResult = {
    type: responseKind,
    runClass: state.runClass,
    content,
    status: input.status,
    totalIterations: input.totalIterations,
    totalToolCalls: input.totalToolCalls,
    runPath: state.runPath,
    ...(state.runId ? { workRunId: state.runId } : {}),
    workState: state.workState,
    completedSteps: state.completedSteps,
  };

  if (state.runClass === "task") {
    result.taskSummary = buildTaskSummaryRecord(state, content, input.status, responseKind, input.completion);
    result.taskAssets = buildTaskAssets(state);
  }

  const artifacts = state.runId && state.runPath
    ? collectAgentArtifacts(state.runId, state.runPath, dataDir, state.completedSteps) as AgentArtifact[]
    : [];
  if (artifacts.length > 0) {
    result.artifacts = artifacts;
  }
  return result;
}

function buildTaskSummaryRecord(
  state: LoopState,
  assistantResponse: string,
  runStatus: AgentLoopResult["status"],
  responseKind: AgentLoopResult["type"],
  completion?: CompletionDirective,
): AgentTaskSummaryRecord {
  const userFacingSummary = completion?.summary?.trim() || assistantResponse.trim();
  const progressSummary = state.workState.summary.trim();
  const taskStatus = toTaskSummaryTaskStatus(state.workState.status);
  const failureSummary = buildFailureSummary(state);
  const openWork = buildTaskSummaryOpenWork(state, taskStatus, failureSummary);
  const blockers = buildTaskSummaryBlockers(state, taskStatus, failureSummary);
  return {
    runId: state.runId,
    runPath: state.runPath ? absolutePath(state.runPath) : "",
    triggerSeq: state.currentSeq,
    discussionStartSeq: findDiscussionStartSeq(state),
    discussionEndSeq: state.currentSeq,
    runStatus,
    taskStatus,
    objective: state.userMessage.trim() || undefined,
    summary: userFacingSummary || progressSummary,
    progressSummary: progressSummary || undefined,
    currentFocus: state.workState.nextStep?.trim() || undefined,
    completedMilestones: [],
    openWork,
    blockers,
    keyFacts: normalizeList(state.workState.verifiedFacts),
    evidence: normalizeList(state.workState.evidence),
    userInputNeeded: state.workState.userInputNeeded?.trim() || undefined,
    userMessage: state.userMessage.trim() || undefined,
    assistantResponse,
    assistantResponseKind: responseKind === "none" ? undefined : responseKind,
    feedbackKind: completion?.feedback_kind,
    feedbackLabel: completion?.feedback_label,
    actionType: completion?.action_type,
    entityHints: completion?.entity_hints,
    toolsUsed: normalizeList(state.completedSteps.flatMap((step) => step.toolsUsed ?? [])),
    nextAction: deriveNextAction(state),
    stopReason: deriveStopReason(state, runStatus),
    failureSummary,
    attachmentNames: buildAttachmentNames(state.preparedAttachments),
  };
}

function toTaskSummaryTaskStatus(status: WorkState["status"]): AgentTaskSummaryRecord["taskStatus"] {
  return status === "not_done" ? "open" : status;
}

function buildTaskSummaryOpenWork(
  state: LoopState,
  taskStatus: AgentTaskSummaryRecord["taskStatus"],
  failureSummary: TaskSummaryFailureSummary | undefined,
): string[] {
  const openWork = normalizeList(state.workState.openWork);
  if (taskStatus !== "open" || openWork.length > 0) {
    return openWork;
  }
  const nextAction = deriveNextAction(state);
  if (nextAction) {
    return [nextAction];
  }
  if (failureSummary?.suggestedRecovery) {
    return [failureSummary.suggestedRecovery];
  }
  return ["Continue the requested task."];
}

function buildTaskSummaryBlockers(
  state: LoopState,
  taskStatus: AgentTaskSummaryRecord["taskStatus"],
  failureSummary: TaskSummaryFailureSummary | undefined,
): string[] {
  const blockers = normalizeList(state.workState.blockers);
  if (taskStatus !== "blocked" || blockers.length > 0) {
    return blockers;
  }
  if (failureSummary?.error) {
    return [failureSummary.error];
  }
  return ["Task is blocked."];
}

function deriveNextAction(state: LoopState): string | undefined {
  if (state.workState.userInputNeeded?.trim()) {
    return state.workState.userInputNeeded.trim();
  }
  if (state.workState.nextStep?.trim()) {
    return state.workState.nextStep.trim();
  }
  const openWork = state.workState.openWork ?? [];
  if (openWork.length > 0) {
    return openWork[0];
  }
  const blockers = state.workState.blockers ?? [];
  if (blockers.length > 0) {
    return blockers[0];
  }
  return undefined;
}

function findDiscussionStartSeq(state: LoopState): number | undefined {
  if (!state.currentSeq) {
    return undefined;
  }
  return state.currentSeq;
}

function deriveStopReason(
  state: LoopState,
  status: AgentLoopResult["status"],
): AgentTaskSummaryRecord["stopReason"] {
  if (state.workState.status === "needs_user_input") return "needs_user_input";
  if (state.workState.status === "blocked") return "blocked";
  if (status === "failed") return "failed";
  if (status === "stuck") return "stuck";
  return "completed";
}

function buildFailureSummary(state: LoopState): TaskSummaryFailureSummary | undefined {
  if (state.workState.status !== "blocked" && state.status !== "failed" && state.status !== "stuck") {
    return undefined;
  }
  const failedStep = [...state.completedSteps].reverse().find((step) => step.outcome === "failed");
  const latestFailure = state.failureHistory[state.failureHistory.length - 1];
  const error = latestFailure?.reason
    || failedStep?.evidenceSummary
    || failedStep?.summary
    || state.workState.blockers?.[0]
    || state.workState.summary;
  const failedTool = failedStep?.toolsUsed?.[0];
  const failureType = failedStep?.failureType ?? latestFailure?.failureType;
  const suggestedRecovery = suggestFailureRecovery(failedTool, failureType, error);
  return {
    ...(failedStep?.step ? { failedStep: failedStep.step } : {}),
    ...(failedTool ? { failedTool } : {}),
    ...(failureType ? { failureType } : {}),
    error,
    retryable: isRetryableFailure(failureType, error),
    ...(suggestedRecovery ? { suggestedRecovery } : {}),
  };
}

function isRetryableFailure(failureType: string | undefined, error: string): boolean {
  if (failureType === "permission") {
    return false;
  }
  return !/\b(destructive|irreversible|unauthorized)\b/i.test(error);
}

function suggestFailureRecovery(
  failedTool: string | undefined,
  failureType: string | undefined,
  error: string,
): string | undefined {
  if (failedTool === "directory_search" && /No managed directories are available/i.test(error)) {
    return "Restore the relevant task asset or use the absolute project path directly before searching.";
  }
  if (failureType === "missing_path") {
    return "Restore or verify the absolute path before retrying.";
  }
  if (failureType === "validation_error") {
    return "Retry with input that matches the tool schema.";
  }
  if (failureType === "tool_error") {
    return "Retry with the relevant durable asset restored and verify the target path first.";
  }
  return undefined;
}

function buildAttachmentNames(preparedAttachments: PreparedAttachmentSummary[] | undefined): string[] {
  return (preparedAttachments ?? []).map((attachment) => attachment.displayName);
}

function buildTaskAssets(state: LoopState): TaskAssetRecord[] {
  return dedupeTaskAssets([
    ...(state.preparedAttachmentRecords ?? []).map(attachmentRecordToTaskAsset),
    ...(state.managedFiles ?? []).map((file): TaskAssetRecord => ({
      assetId: stableAssetId("file", file.fileId),
      role: "input",
      kind: "file",
      name: file.originalName,
      path: absolutePath(file.storagePath),
    })),
    ...(state.managedDirectories ?? []).map((directory): TaskAssetRecord => ({
      assetId: stableAssetId("directory", directory.directoryId),
      role: "input",
      kind: "directory",
      name: directory.name,
      path: absolutePath(directory.rootPath),
    })),
    ...buildGeneratedArtifactAssets(state),
  ]);
}

function buildGeneratedArtifactAssets(state: LoopState): TaskAssetRecord[] {
  const artifacts = normalizeList(state.completedSteps.flatMap((step) => step.artifacts))
    .filter((artifact) => isDurableStepArtifact(artifact))
    .map((artifact) => absolutePath(artifact));
  const assets: TaskAssetRecord[] = [];
  const directoryCounts = new Map<string, number>();

  for (const artifact of artifacts) {
    const kind = inferPathAssetKind(artifact);
    if (kind === "file") {
      const parent = dirname(artifact);
      directoryCounts.set(parent, (directoryCounts.get(parent) ?? 0) + 1);
    }
    assets.push({
      assetId: stableAssetId(kind, artifact),
      role: "generated",
      kind,
      name: artifact.split("/").pop() || artifact,
      path: artifact,
    });
  }

  for (const [directoryPath, count] of directoryCounts.entries()) {
    if (count < 2) {
      continue;
    }
    assets.push({
      assetId: stableAssetId("directory", directoryPath),
      role: "generated",
      kind: "directory",
      name: directoryPath.split("/").pop() || directoryPath,
      path: directoryPath,
    });
  }

  return assets;
}

function attachmentRecordToTaskAsset(
  record: PreparedAttachmentRecord,
): TaskAssetRecord {
  const kind = record.summary.mode === "structured_data" ? "dataset" : "document";
  return {
    assetId: stableAssetId(kind, record.summary.documentId),
    role: "input",
    kind,
    name: record.summary.displayName,
    path: absolutePath(record.manifest.originalPath || record.summary.artifactPath),
  };
}

function dedupeTaskAssets(assets: TaskAssetRecord[]): TaskAssetRecord[] {
  const output = new Map<string, TaskAssetRecord>();
  for (const asset of assets) {
    output.set(asset.assetId, asset);
  }
  return [...output.values()];
}

function isDurableStepArtifact(artifact: string): boolean {
  const normalized = artifact.trim();
  if (!normalized || normalized.startsWith("steps/")) {
    return false;
  }
  return !normalized.includes("/observations/");
}

function inferPathAssetKind(path: string): string {
  if (/\.(?:html|css|js|jsx|ts|tsx|json|md|txt|py|sql|csv|pdf|png|jpg|jpeg|svg)$/i.test(path)) {
    return "file";
  }
  return "directory";
}

function absolutePath(path: string): string {
  return isAbsolute(path) ? path : resolve(path);
}

function stableAssetId(kind: string, identity: string): string {
  return `asset_${createHash("sha256").update(`${kind}:${identity}`).digest("hex").slice(0, 20)}`;
}

function normalizeList(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter((value) => value.length > 0))];
}
