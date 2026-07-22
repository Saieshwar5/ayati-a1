import { join } from "node:path";
import {
  ContextInputLimitError,
  ContextRunCapacityError,
} from "../../prompt/context-compilation-receipt.js";
import { devLog } from "../../shared/index.js";
import { prepareIncomingAttachments } from "../../documents/attachment-preparer.js";
import type { SessionInputHandle } from "../../memory/types.js";
import type {
  AgentLoopDeps,
  AgentLoopResult,
  CompletionDirective,
  LoopConfig,
  LoopState,
  WorkState,
} from "../types.js";
import {
  DEFAULT_LOOP_CONFIG,
} from "../types.js";
import { updateContextPressureState } from "../context-pressure-state.js";
import {
  createRunMetrics,
  formatRunMetrics,
  recordCompactionMetric,
  recordPlanModeMetric,
  recordRunMetric,
  recordStateSizeMetric,
  recordVerificationMetric,
} from "../metrics.js";
import {
  buildLoopStateSizeBreakdown,
  compactStepSummaryForState,
  compactWorkState,
  measureJson,
} from "../state-compaction.js";
import { buildAgentStateView } from "./state-view.js";
import {
  isContextPressureActive,
  resolveSelectedToolLimit,
  selectToolsForDecision,
} from "./tool-selector.js";
import { callAgentDecision } from "./decision.js";
import type { AgentDecision } from "./decision.js";
import {
  evaluateReadProgressGuard,
  updateReadProgressAfterActOutput,
} from "./read-progress-policy.js";
import type { ToolLoadResult } from "./tool-working-set.js";
import type { RepairCode } from "./repair-policy.js";
import {
  createToolLoadNoProgressFailure,
  createToolLoadProgressState,
  evaluateToolLoadProgress,
} from "./tool-load-progress-policy.js";
import { recordRunStep } from "./step-lifecycle.js";
import { buildContextEngineFeedbackSummary } from "../feedback-ledger.js";
import {
  createFailureRecordFromStepSummary,
  hasRepeatedRepairFailure,
  hasRepeatedToolInputValidationFailure,
  recordUnboundRunToolRepair,
  recordReadProgressRepair,
  recordRepeatedRepairFailure,
} from "./repair-feedback.js";
import {
  buildFailureReply,
  canMarkTerminalReplyDone,
  deriveUserInputNeededFromTerminalReply,
} from "./final-response-policy.js";
import {
  buildRunResources,
  buildVerifiedCompletionResources,
  buildWorkstreamSummaryRecord,
} from "./run-result.js";
import {
  buildFinalFeedbackWarnings,
  buildToolExposureWarningCodes,
  recordActionFeedback,
  recordFeedback,
  recordReducerFeedback,
  recordStepFeedback,
  recordToolWorkingSetFeedback,
  summarizeDecisionInputState,
  summarizeWorkstreamSummary,
} from "./runner-feedback.js";
import {
  buildInitialState,
  getPrimaryUserMessage,
  resolveInputHandle,
  syncHarnessContext,
} from "./runner-state.js";
import {
  buildUpdatedToolContext,
  executeActionStep,
  syncPreparedAttachmentsFromRegistry,
} from "./action-step.js";
import {
  deriveWorkstreamBindingCapabilityPolicy,
  isDecisionAllowedByWorkstreamBinding,
} from "./workstream-binding-capability-policy.js";
import {
  summarizeAgentAction,
  summarizeDecision,
  summarizeHarnessContext,
  summarizeVirtualModeTransition,
  summarizeWorkState,
} from "./feedback-summary.js";
import { auditToolPolicy } from "./tool-policy-audit.js";
import {
  buildVirtualCapabilitySummary,
  directResponseRepair,
  dispatchVirtualModeTransition,
  dispatchVirtualValidation,
  filterToolDefinitionsForVirtualMode,
  type VirtualModeRepair,
} from "./virtual-mode-runtime.js";
import { isVirtualGraphActive } from "./virtual-mode.js";

export async function runAgentLoop(
  deps: AgentLoopDeps,
  resolvedConfig?: LoopConfig,
): Promise<AgentLoopResult> {
  const config: LoopConfig = resolvedConfig ?? { ...DEFAULT_LOOP_CONFIG, ...deps.config };
  const inputHandle = resolveInputHandle(deps);
  const runHandle = deps.runHandle;
  const metrics = createRunMetrics();

  let totalToolCalls = 0;
  let modeTransitionCount = 0;
  let acceptedModeTransitionCount = 0;
  let rejectedModeTransitionCount = 0;
  let validationAttemptCount = 0;
  let validationAcceptedCount = 0;
  let validationRejectedCount = 0;
  let bindingAttemptCount = 0;
  let bindingStatus: "not_started" | "started" | "resolved" | "needs_user_input" | "failed" = "not_started";
  let actionStepCount = 0;
  let failedVerificationCount = 0;
  let lastVerificationPassed: boolean | undefined;
  let toolLoadProgress = createToolLoadProgressState();
  const state = buildInitialState(deps, config, inputHandle, runHandle);
  let bindingAttempted = false;
  recordFeedback(deps, inputHandle, runHandle.runId, "loop", "started", {
    inputKind: state.inputKind ?? "user_message",
    userMessage: state.userMessage,
  });

  const recordStateSnapshotMetric = (label: string): void => {
    recordStateSizeMetric(metrics, label, buildLoopStateSizeBreakdown(state));
  };
  const finalize = async (input: {
    status: AgentLoopResult["status"];
    content?: string;
    completion?: CompletionDirective;
    responseKind?: AgentLoopResult["type"];
  }): Promise<AgentLoopResult> => {
    state.workState = compactWorkState(state.workState);
    syncPreparedAttachmentsFromRegistry(state, deps);
    syncHarnessContext(state, deps, inputHandle);
    recordStateSnapshotMetric("final");
    const cleanupRunId = runHandle.runId;
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
    devLog(`[${deps.clientId}] [metrics:agent_loop] ${formatRunMetrics(metrics)}`);
    const responseKind = input.responseKind ?? input.completion?.response_kind ?? state.preferredResponseKind ?? "reply";
    const finalContent = input.content ?? state.finalOutput;
    const workstreamSummary = isWorkstreamBound(state)
      ? buildWorkstreamSummaryRecord(state, finalContent, input.status, responseKind, input.completion)
      : undefined;
    const warningFlags = buildFinalFeedbackWarnings({
      status: input.status,
      totalToolCalls,
      modeTransitionCount,
      failedVerificationCount,
      state,
    });
    const navigation = {
      currentMode: state.virtualMode.active ?? "ENTRY",
      modeRevision: state.virtualMode.revision,
      transitionRequests: modeTransitionCount,
      transitionAccepted: acceptedModeTransitionCount,
      transitionRejected: rejectedModeTransitionCount,
      bindingAttempts: bindingAttemptCount,
      bindingStatus,
      validationAttempts: validationAttemptCount,
      validationAccepted: validationAcceptedCount,
      validationRejected: validationRejectedCount,
    };
    recordFeedback(deps, inputHandle, runHandle.runId, "harness", "result", {
      status: input.status,
      responseKind,
      workstreamBound: isWorkstreamBound(state),
      totalIterations: state.iteration,
      totalToolCalls,
      modeTransitions: modeTransitionCount,
      navigation,
      actionStepCount,
      failedVerificationCount,
      verificationPassed: lastVerificationPassed,
      finalContentPreview: finalContent,
      workState: summarizeWorkState(state.workState),
      completedStepCount: state.completedSteps.length,
      workstreamSummary: summarizeWorkstreamSummary(workstreamSummary),
      harnessContext: summarizeHarnessContext(state.harnessContext),
    });
    recordFeedback(deps, inputHandle, runHandle.runId, "final", "reply", {
      status: input.status,
      responseKind,
      content: finalContent,
      totalIterations: state.iteration,
      totalToolCalls,
      modeTransitions: modeTransitionCount,
      actionStepCount,
      failedVerificationCount,
      verificationPassed: lastVerificationPassed,
      basedOnVerifiedFacts: state.workState.verifiedFacts.length > 0 || lastVerificationPassed === true,
      warnings: warningFlags,
      workstreamSummary: summarizeWorkstreamSummary(workstreamSummary),
      feedbackSummary: {
        status: input.status,
        responseKind,
        iterations: state.iteration,
        toolCalls: totalToolCalls,
        modeTransitions: modeTransitionCount,
        navigation,
        actionSteps: actionStepCount,
        verificationPassed: lastVerificationPassed ?? false,
        basedOnVerifiedFacts: state.workState.verifiedFacts.length > 0 || lastVerificationPassed === true,
        contextEngine: buildContextEngineFeedbackSummary({
          context: state.harnessContext.contextEngine,
          finalizationStatus: "not_started",
          committed: false,
          runId: runHandle.runId,
        }),
        warnings: warningFlags,
      },
    });
    return buildLoopResult(state, {
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
  recordFeedback(deps, inputHandle, runHandle.runId, "harness", "context_input", {
    inputKind: state.inputKind ?? "user_message",
    runId: runHandle.runId,
    userMessage: state.userMessage,
    summary: summarizeHarnessContext(state.harnessContext),
    context: state.harnessContext,
  });

  devLog(
    `[${deps.clientId}] agentLoop start inputKind=${state.inputKind ?? "user_message"} seq=${inputHandle.seq} workRun=${state.runId || "none"} message=${state.userMessage.slice(0, 160)}`,
  );

  recordStateSnapshotMetric("initial");

  if ((state.attachedDocuments ?? []).some((document) => document.kind !== "image")) {
    await prepareAttachmentsForRun(deps, state, runHandle.runId);
    syncHarnessContext(state, deps, inputHandle);
  }

  while (state.status === "running" && state.iteration < config.maxIterations) {
    if (deps.signal?.aborted) {
      state.interrupted = true;
      state.status = "failed";
      state.finalOutput = "Agent was stopped.";
      return finalize({ status: "failed", content: state.finalOutput });
    }

    syncHarnessContext(state, deps, inputHandle);
    state.iteration++;
    const finalReplyFromWorkState = false;

    const toolContext = {
      clientId: deps.clientId,
      runId: runHandle.runId,
      sessionId: inputHandle.sessionId,
      stepNumber: state.iteration,
      ...(deps.uiContext ? { uiContext: deps.uiContext } : {}),
    };
    let deterministicToolLoad: ToolLoadResult | undefined;
    if (deps.toolWorkingSetManager) {
      deterministicToolLoad = deps.toolWorkingSetManager.prepareForDecision(state, toolContext);
    } else {
      await deps.skillActivationManager?.prepareForDecision(state, toolContext);
    }
    const modeVisibleTools = deps.toolWorkingSetManager
      ? deps.toolWorkingSetManager.visibleToolDefinitions(toolContext)
      : deps.toolExecutor?.definitions({
        ...toolContext,
      }) ?? deps.toolDefinitions;
    const visibleTools = filterToolDefinitionsForVirtualMode(state, modeVisibleTools);
    const pressureToolSurface = isContextPressureActive(state);
    const selectedToolLimit = resolveSelectedToolLimit(state, config.maxSelectedTools);
    const toolRoutingSummary = deps.toolWorkingSetManager?.getCapabilitySummary()
      ?? buildVirtualCapabilitySummary(deps.toolDefinitions);
    const selectedTools = selectToolsForDecision(state, visibleTools, config.maxSelectedTools);
    recordToolWorkingSetFeedback({
      deps,
      inputHandle,
      runId: runHandle.runId,
      state,
      iteration: state.iteration,
      toolContextRunId: toolContext.runId,
      deterministicToolLoad,
      visibleTools,
      selectedTools,
      runHandle,
    });
    const stateView = buildAgentStateView(state, {
      activeTools: selectedTools.map((tool) => tool.name),
    });
    const capabilityPolicy = deriveWorkstreamBindingCapabilityPolicy(state);
    const nativeControlTools = [
      "decision_transition_mode",
      ...(isVirtualGraphActive(state.virtualMode) ? ["decision_validate"] : []),
    ];
    const decisionToolPolicyAudit = auditToolPolicy({
      policy: capabilityPolicy,
      selectedTools,
    });
    recordFeedback(deps, inputHandle, runHandle.runId, "decision", "prompt_summary", {
      iteration: state.iteration,
      nativeControlTools,
      nativeControlToolCount: nativeControlTools.length,
      selectedTools: selectedTools.map((tool) => tool.name),
      selectedToolCount: selectedTools.length,
      selectedToolLimit,
      pressureToolSurface,
      visibleToolCount: visibleTools.length,
      executableToolsVisibleNatively: true,
      toolRoutingAvailable: Boolean(toolRoutingSummary?.trim()),
      workStatus: state.workState.status,
      progressSummary: state.workState.summary,
      workingFeedbackCount: stateView.workingFeedback?.latest.length ?? 0,
      recentFailureCount: state.failureHistory.length,
      consecutiveFailures: state.consecutiveFailures,
      finalReplyFromWorkState,
      contextEngine: buildContextEngineFeedbackSummary({
        context: state.harnessContext.contextEngine,
      }),
      warningCodes: buildToolExposureWarningCodes(state, selectedTools),
      toolPolicyAudit: decisionToolPolicyAudit,
      inputState: summarizeDecisionInputState(stateView),
    });
    let decision: AgentDecision;
    try {
      decision = await callAgentDecision({
        provider: deps.provider,
        stateView,
        toolDefinitions: selectedTools,
        toolRoutingSummary,
        modeTransitionAvailable: true,
        validationAvailable: isVirtualGraphActive(state.virtualMode),
        toolContextProjectionPolicy: config.toolContextProjectionPolicy,
        contextCheckpoint: deps.contextCheckpoint,
        contextPreparation: deps.contextPreparation,
        evaluationIteration: state.iteration,
        applyAuthoritativeContext: (context) => applyAuthoritativeContextToLoop({
          deps,
          state,
          inputHandle,
          context,
          activeTools: selectedTools.map((tool) => tool.name),
        }),
        systemContext: deps.systemContext,
        metrics,
        feedbackLedger: deps.feedbackLedger,
        feedbackContext: {
          clientId: deps.clientId,
          sessionId: inputHandle.sessionId,
          seq: inputHandle.seq,
          runId: runHandle.runId,
        },
        onContextCompilation: (receipt) => {
          state.contextPressure = updateContextPressureState({
            current: state.contextPressure,
            receipt,
            iteration: state.iteration,
          });
        },
      });
    } catch (error) {
      if (!(error instanceof ContextRunCapacityError || error instanceof ContextInputLimitError)) {
        throw error;
      }
      state.contextLimitReached = true;
      state.status = "stuck";
      state.workState = preserveWorkStateForContextLimit(state);
      state.finalOutput = "This run reached its context capacity. I preserved the completed work and workstream state so it can continue in a new turn.";
      recordFeedback(deps, inputHandle, runHandle.runId, "guard", "context_limit", {
        iteration: state.iteration,
        finalInputTokens: error.receipt.finalInputTokens,
        softInputTokens: error.receipt.softInputTokens,
        hardInputTokens: error.receipt.hardInputTokens,
        mode: error.receipt.mode,
      });
      return finalize({ status: "stuck", content: state.finalOutput });
    }
    discardModelWorkingNotes(decision);
    recordFeedback(deps, inputHandle, runHandle.runId, "decision", "selected", {
      iteration: state.iteration,
      decision: summarizeDecision(decision),
      pendingTurnStatus: state.harnessContext.contextEngine?.current.routing?.status,
      contextEngine: buildContextEngineFeedbackSummary({
        context: state.harnessContext.contextEngine,
      }),
    });

    if (decision.kind === "reply") {
      const rejection = directResponseRepair(state);
      if (rejection) {
        recordVirtualModeRepair(state, rejection, "validation_error");
        recordFeedback(deps, inputHandle, runHandle.runId, "guard", "direct_response_rejected", {
          iteration: state.iteration,
          repair: rejection,
          mode: state.virtualMode,
        });
        if (hasRepeatedRepairFailure(state.failureHistory) || state.consecutiveFailures >= config.maxConsecutiveFailures) {
          state.status = "failed";
          state.finalOutput = buildFailureReply(state);
          return finalize({ status: "failed", content: state.finalOutput });
        }
        continue;
      }
      state.status = decision.status === "failed" ? "failed" : "completed";
      state.finalOutput = decision.message;
      const userInputNeeded = state.status === "completed" && decision.status === "completed"
        ? deriveUserInputNeededFromTerminalReply(decision.message)
        : undefined;
      if (userInputNeeded) {
        state.workState = {
          ...state.workState,
          status: "needs_user_input",
          userInputNeeded,
          nextStep: userInputNeeded,
          summary: state.workState.summary || decision.message,
        };
      } else if (decision.status === "completed" && canMarkTerminalReplyDone(state)) {
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

    if (decision.kind === "validate") {
      validationAttemptCount++;
      const validation = await dispatchVirtualValidation(state, decision.request);
      if (validation.accepted) validationAcceptedCount++;
      else validationRejectedCount++;
      recordFeedback(
        deps,
        inputHandle,
        runHandle.runId,
        "virtual_mode",
        validation.accepted ? "validation_accepted" : "validation_rejected",
        {
          iteration: state.iteration,
          request: decision.request,
          mode: state.virtualMode,
          ...(validation.accepted
            ? { outcome: validation.outcome, nextWorkState: validation.nextWorkState }
            : { repair: validation.repair }),
        },
      );
      if (!validation.accepted) {
        recordVirtualModeRepair(state, validation.repair, "verify_failed");
        recordStateSnapshotMetric("after_validation_rejected");
        if (hasRepeatedRepairFailure(state.failureHistory) || state.consecutiveFailures >= config.maxConsecutiveFailures) {
          state.status = "failed";
          state.finalOutput = buildFailureReply(state);
          return finalize({ status: "failed", content: state.finalOutput });
        }
        continue;
      }

      state.workState = compactWorkState(validation.nextWorkState);
      state.finalOutput = validation.response;
      state.consecutiveFailures = 0;
      if (validation.completionSummary) {
        state.verifiedCompletionSummary = validation.completionSummary;
      }
      if (validation.completionResources) {
        state.completionResources = validation.completionResources;
      }
      recordRunMetric(metrics, "verified_completion", { kind: "local" });
      recordStateSnapshotMetric("after_validation_accepted");
      const responseKind = validation.outcome === "needs_user_input"
        ? "feedback"
        : state.preferredResponseKind ?? "reply";
      const loopStatus = validation.outcome === "failed"
        ? "failed"
        : validation.outcome === "blocked"
          ? "stuck"
          : "completed";
      state.status = loopStatus;
      return finalize({
        status: loopStatus,
        content: validation.response,
        responseKind,
        ...(validation.outcome === "completed" || validation.outcome === "needs_user_input"
          ? {
              completion: {
                done: true as const,
                summary: validation.response,
                status: "completed" as const,
                response_kind: responseKind,
                ...(validation.outcome === "needs_user_input"
                  ? { feedback_kind: "clarification" as const }
                  : {}),
              },
            }
          : {}),
      });
    }

    if (decision.kind === "transition_mode") {
      modeTransitionCount++;
      recordFeedback(deps, inputHandle, runHandle.runId, "virtual_mode", "transition_requested", {
        iteration: state.iteration,
        request: decision.request,
        source: state.virtualMode.active ?? "ENTRY",
      });
      const transition = await dispatchVirtualModeTransition({
        state,
        request: decision.request,
        iteration: state.iteration,
        toolDefinitions: deps.toolDefinitions,
        toolWorkingSetManager: deps.toolWorkingSetManager,
        toolContext,
        workstreamBinding: deps.workstreamBinding,
        bindingAlreadyAttempted: bindingAttempted,
        applyContext: (context) => {
          deps.harnessContext = {
            ...(deps.harnessContext ?? {}),
            contextEngine: context,
          };
          syncHarnessContext(state, deps, inputHandle);
        },
        onBindingEvent: (event, data) => {
          recordFeedback(deps, inputHandle, runHandle.runId, "workstream_binding", event, {
            iteration: state.iteration,
            ...data,
          });
        },
      });
      if (
        transition.kind === "resolved"
        || transition.kind === "binding_needs_user_input"
        || transition.kind === "binding_failed"
      ) {
        bindingAttempted ||= transition.binding.attempted;
        if (transition.binding.attempted) {
          bindingAttemptCount = 1;
          bindingStatus = transition.binding.outcome.status;
        }
      }

      if (transition.kind === "applied" || transition.kind === "resolved") {
        acceptedModeTransitionCount++;
      } else {
        rejectedModeTransitionCount++;
      }

      recordFeedback(deps, inputHandle, runHandle.runId, "virtual_mode", `transition_${transition.kind}`, {
        iteration: state.iteration,
        request: decision.request,
        transition: summarizeVirtualModeTransition(transition),
        mode: state.virtualMode,
      });

      if (transition.kind === "applied" || transition.kind === "resolved") {
        toolLoadProgress = createToolLoadProgressState();
        recordRunMetric(metrics, "mode_transition", {
          kind: "local",
          status: "success",
        });
        continue;
      }

      if (transition.kind === "binding_needs_user_input") {
        recordVirtualModeRepair(state, {
          code: "MODE_RESOLUTION_AMBIGUOUS",
          message: transition.question,
          blockedTargets: transition.binding.outcome.candidateIds,
          allowedNextActions: [
            "Validate needs_user_input with this exact ambiguity question.",
          ],
        }, "validation_error");
        continue;
      }

      if (transition.kind === "binding_failed") {
        recordVirtualModeRepair(state, {
          code: "MODE_RESOLUTION_UNAVAILABLE",
          message: transition.message,
          blockedTargets: decision.request.targets ?? [],
          allowedNextActions: ["Validate a truthful failed or needs-input outcome without replaying mutation."],
        }, "validation_error");
        continue;
      }

      recordVirtualModeRepair(state, transition.repair, "validation_error");
      if (transition.noProgressResult) {
        const progressEvaluation = evaluateToolLoadProgress(toolLoadProgress, transition.noProgressResult);
        toolLoadProgress = progressEvaluation.state;
        if (progressEvaluation.shouldStop) {
          const failure = createToolLoadNoProgressFailure(progressEvaluation, state.iteration);
          state.failureHistory.push(failure);
          recordFeedback(deps, inputHandle, runHandle.runId, "guard", "mode_transition_no_progress", {
            iteration: state.iteration,
            repeatedTargets: progressEvaluation.repeatedTargets,
            repair: failure.repair,
          });
          state.status = "failed";
          state.finalOutput = buildFailureReply(state);
          return finalize({ status: "failed", content: state.finalOutput });
        }
      }
      if (hasRepeatedRepairFailure(state.failureHistory) || state.consecutiveFailures >= config.maxConsecutiveFailures) {
        state.status = "failed";
        state.finalOutput = buildFailureReply(state);
        return finalize({ status: "failed", content: state.finalOutput });
      }
      continue;
    }

    const decisionAllowed = isDecisionAllowedByWorkstreamBinding(capabilityPolicy, decision);
    if (!decisionAllowed) {
      recordUnboundRunToolRepair({
        deps,
        inputHandle,
        state,
        config,
        decision,
        reason: "unbound_run_wrong_tool",
      });
      if (hasRepeatedRepairFailure(state.failureHistory)) {
        recordRepeatedRepairFailure({
          deps,
          inputHandle,
          state,
          runId: runHandle.runId,
        });
        state.status = "failed";
        state.finalOutput = buildFailureReply(state);
        return finalize({ status: "failed", content: state.finalOutput });
      }
      if (state.consecutiveFailures >= config.maxConsecutiveFailures) {
        state.status = "failed";
        state.finalOutput = buildFailureReply(state);
        return finalize({ status: "failed", content: state.finalOutput });
      }
      continue;
    }

    const activeToolsForRun = deps.toolWorkingSetManager?.listActive(toolContext) ?? [];
    recordFeedback(deps, inputHandle, runHandle.runId, "tools", "run_tools_enabled", {
      iteration: state.iteration,
      toolContextRunId: toolContext.runId,
      workstreamBound: isWorkstreamBound(state),
      activeTools: activeToolsForRun,
      normalTools: activeToolsForRun,
      routingTools: [],
    });
    const readProgressViolation = evaluateReadProgressGuard(state.readProgress, decision.action);
    if (readProgressViolation) {
      recordReadProgressRepair({
        deps,
        inputHandle,
        state,
        config,
        decision,
        runId: runHandle.runId,
        violation: readProgressViolation,
      });
      if (hasRepeatedRepairFailure(state.failureHistory)) {
        recordRepeatedRepairFailure({
          deps,
          inputHandle,
          state,
          runId: runHandle.runId,
        });
        state.status = "failed";
        state.finalOutput = buildFailureReply(state);
        return finalize({ status: "failed", content: state.finalOutput });
      }
      if (state.consecutiveFailures >= config.maxConsecutiveFailures) {
        state.status = "failed";
        state.finalOutput = buildFailureReply(state);
        return finalize({ status: "failed", content: state.finalOutput });
      }
      recordStateSnapshotMetric("after_read_progress_guard");
      continue;
    }
    recordFeedback(deps, inputHandle, runHandle.runId, "action", "started", {
      iteration: state.iteration,
      mode: decision.action.mode,
      action: summarizeAgentAction(decision.action),
      plannedCallCount: decision.action.calls.length,
      workStateBefore: state.workState,
      calls: decision.action.calls.map((call) => ({
        id: call.id,
        tool: call.tool,
        input: summarizeActionInput(call.input),
        exactInput: call.input,
        dependsOn: call.dependsOn,
        purpose: call.purpose,
      })),
      allowedTools: decision.action.allowedTools,
    });
    const stepStartedAt = new Date().toISOString();
    const stepNumber = actionStepCount + 1;
    const stepResult = await executeActionStep({
      deps,
      state,
      config,
      metrics,
      selectedTools,
      decision,
      stepNumber,
    });
    const stepCompletedAt = new Date().toISOString();
    actionStepCount++;
    lastVerificationPassed = stepResult.execution.verifyOutput.passed;
    if (!stepResult.execution.verifyOutput.passed) {
      failedVerificationCount++;
    }
    totalToolCalls += stepResult.stepSummary.toolSuccessCount + stepResult.stepSummary.toolFailureCount;
    state.readProgress = updateReadProgressAfterActOutput(state.readProgress, stepResult.execution.actOutput);
    recordActionFeedback(deps, inputHandle, runHandle.runId, decision.action, stepResult);
    recordStepFeedback(deps, inputHandle, runHandle.runId, state.iteration, stepResult);

    const reducerStarted = process.hrtime.bigint();
    const beforeWorkStateChars = measureJson(stepResult.execution.nextWorkState);
    const compactedWorkState = compactWorkState(stepResult.execution.nextWorkState);
    recordCompactionMetric(metrics, "workState", beforeWorkStateChars, measureJson(compactedWorkState), { step: stepNumber });
    state.workState = compactedWorkState;
    state.toolContext = buildUpdatedToolContext(state, stepResult.execution, stepNumber);
    stepResult.stepSummary.workState = compactedWorkState;
    recordReducerFeedback(deps, inputHandle, runHandle.runId, state.iteration, {
      beforeWorkStateChars,
      compactedWorkState,
      stepSummary: stepResult.stepSummary,
      durationMs: Number(process.hrtime.bigint() - reducerStarted) / 1_000_000,
    });

    const compactedStep = compactStepSummaryForState(stepResult.stepSummary);
    recordCompactionMetric(metrics, "completedStepSummary", measureJson(stepResult.stepSummary), measureJson(compactedStep), { step: stepNumber });
    state.completedSteps.push(compactedStep);
    const persistedContext = await recordRunStep(deps, state, decision.action, stepResult, {
      startedAt: stepStartedAt,
      completedAt: stepCompletedAt,
    });
    applyPersistedStepContext(deps, state, inputHandle, persistedContext);

    recordPlanModeMetric(metrics, decision.action.mode, {
      step: stepNumber,
      tools: decision.action.calls.map((call) => call.tool).join(","),
    });
    recordVerificationMetric(metrics, stepResult.stepSummary.verificationMethod, {
      step: stepNumber,
      executionStatus: stepResult.stepSummary.executionStatus,
      validationStatus: stepResult.stepSummary.validationStatus,
    });
    deps.skillActivationManager?.cleanupAfterStep(stepResult.stepSummary.toolsUsed ?? [], {
      clientId: deps.clientId,
      runId: runHandle.runId,
      sessionId: inputHandle.sessionId,
      stepNumber,
      ...(deps.uiContext ? { uiContext: deps.uiContext } : {}),
    });
    if (deps.toolWorkingSetManager) {
      const cleanupContext = {
        clientId: deps.clientId,
        runId: runHandle.runId,
        sessionId: inputHandle.sessionId,
        stepNumber,
        ...(deps.uiContext ? { uiContext: deps.uiContext } : {}),
      };
      deps.toolWorkingSetManager.cleanupAfterStep(cleanupContext);
      recordFeedback(deps, inputHandle, runHandle.runId, "tools", "after_execution", {
        iteration: state.iteration,
        activeTools: deps.toolWorkingSetManager.listActive(cleanupContext),
      });
    }

    if (stepResult.stepSummary.outcome === "failed") {
      state.consecutiveFailures++;
      state.failureHistory.push(createFailureRecordFromStepSummary(stepResult.stepSummary, state.failureHistory));
      if (hasRepeatedRepairFailure(state.failureHistory) || hasRepeatedToolInputValidationFailure(state.failureHistory)) {
        recordRepeatedRepairFailure({
          deps,
          inputHandle,
          state,
          runId: runHandle.runId,
        });
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

    recordStateSnapshotMetric("after_step");
    deps.onProgress?.(
      `Step ${stepNumber}: ${stepResult.stepSummary.executionContract} -> ${stepResult.stepSummary.outcome}`,
      state.runPath,
    );

  }

  state.runLimitReached = true;
  state.status = "stuck";
  state.workState = compactWorkState({
    ...state.workState,
    status: state.workState.status === "done" ? "done" : "not_done",
    openWork: normalizeList(state.workState.openWork).length > 0
      ? state.workState.openWork
      : ["Continue the requested workstream from the latest verified state."],
    nextStep: state.workState.nextStep || "Continue the requested workstream from the latest verified state.",
  });
  state.finalOutput = `I reached the ${config.maxIterations}-step limit before finishing the workstream.`;
  return finalize({ status: "stuck", content: state.finalOutput });
}

async function prepareAttachmentsForRun(
  deps: AgentLoopDeps,
  state: LoopState,
  runId: string,
): Promise<void> {
  const preparableDocuments = (state.attachedDocuments ?? []).filter((document) => document.kind !== "image");
  if (preparableDocuments.length === 0 || !deps.documentStore || !deps.preparedAttachmentRegistry) {
    return;
  }
  const attachmentRoot = preparedAttachmentRoot(deps.dataDir, runId);
  const prepared = await prepareIncomingAttachments({
    attachedDocuments: preparableDocuments,
    runId,
    attachmentRoot,
    documentStore: deps.documentStore,
    registry: deps.preparedAttachmentRegistry,
  });
  state.preparedAttachments = prepared.summaries;
  state.preparedAttachmentRecords = prepared.records;
}

function preparedAttachmentRoot(dataDir: string, runId: string): string {
  return join(dataDir, "prepared-attachments", sanitizeFileName(runId));
}

function sanitizeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "run";
}

function discardModelWorkingNotes(decision: AgentDecision): void {
  void decision.workingNotes;
}

function recordVirtualModeRepair(
  state: LoopState,
  repair: VirtualModeRepair,
  failureType: LoopState["failureHistory"][number]["failureType"],
): void {
  const repairCode: RepairCode = repair.code === "MODE_NO_PROGRESS"
    ? "R_NO_PROGRESS"
    : repair.code === "DIRECT_RESPONSE_REQUIRES_MODE"
      || repair.code === "TERMINAL_REQUIRES_VALIDATION"
      ? "R_DIRECT_RESPONSE_REQUIRES_MODE"
      : repair.code.startsWith("VALIDATION_")
        ? "R_VALIDATION_REJECTED"
        : "R_MODE_TRANSITION_INVALID";
  state.consecutiveFailures++;
  state.failureHistory.push({
    step: state.iteration,
    failureType,
    reason: `${repair.code}: ${repair.message}`,
    blockedTargets: repair.blockedTargets,
    repairCode,
    repair: {
      code: repairCode,
      message: repair.message,
      ...(repair.blockedTargets.length > 0 ? { blockedTargets: repair.blockedTargets } : {}),
      allowedNextActions: repair.allowedNextActions,
    },
  });
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

function applyPersistedStepContext(
  deps: AgentLoopDeps,
  state: LoopState,
  inputHandle: SessionInputHandle,
  context: Awaited<ReturnType<typeof recordRunStep>>,
): void {
  if (!context) return;
  deps.harnessContext = {
    ...deps.harnessContext,
    ...context,
  };
  syncHarnessContext(state, deps, inputHandle);
}

function applyAuthoritativeContextToLoop(input: {
  deps: AgentLoopDeps;
  state: LoopState;
  inputHandle: SessionInputHandle;
  context: NonNullable<AgentLoopDeps["harnessContext"]>["contextEngine"];
  activeTools: string[];
}): ReturnType<typeof buildAgentStateView> {
  if (!input.context) return buildAgentStateView(input.state, { activeTools: input.activeTools });
  input.deps.harnessContext = {
    ...(input.deps.harnessContext ?? {}),
    contextEngine: input.context,
  };
  syncHarnessContext(input.state, input.deps, input.inputHandle);
  return buildAgentStateView(input.state, { activeTools: input.activeTools });
}

function describeActionInputValue(value: unknown): string {
  if (Array.isArray(value)) return `array(${value.length})`;
  if (value === null) return "null";
  if (typeof value === "object") return "object";
  return typeof value;
}

function buildLoopResult(
  state: LoopState,
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
  const terminal = deriveRunTerminal(state, input.status);
  const result: AgentLoopResult = {
    type: responseKind,
    runId: state.runId,
    outcome: terminal.outcome,
    stopReason: terminal.stopReason,
    content,
    status: input.status,
    totalIterations: input.totalIterations,
    totalToolCalls: input.totalToolCalls,
    runPath: state.runPath,
    workState: state.workState,
    completedSteps: state.completedSteps,
    harnessContext: state.harnessContext,
  };

  if (isWorkstreamBound(state)) {
    result.workstreamSummary = buildWorkstreamSummaryRecord(state, content, input.status, responseKind, input.completion);
    result.resources = buildRunResources(state);
    result.verifiedCompletionResources = buildVerifiedCompletionResources(state);
  }

  return result;
}

function isWorkstreamBound(state: LoopState): boolean {
  return state.harnessContext.contextEngine?.current.routing?.status === "bound";
}

function deriveRunTerminal(
  state: LoopState,
  status: AgentLoopResult["status"],
): Pick<AgentLoopResult, "outcome" | "stopReason"> {
  if (state.interrupted) {
    return { outcome: "incomplete", stopReason: "interrupted" };
  }
  if (state.contextLimitReached) {
    return { outcome: "incomplete", stopReason: "context_limit" };
  }
  if (state.runLimitReached) {
    return { outcome: "incomplete", stopReason: "run_limit" };
  }
  if (state.workState.status === "needs_user_input") {
    return { outcome: "needs_user_input", stopReason: "needs_user_input" };
  }
  if (state.workState.status === "blocked") {
    return { outcome: "blocked", stopReason: "blocked" };
  }
  if (status === "failed") {
    return { outcome: "failed", stopReason: "failed" };
  }
  return { outcome: "done", stopReason: "completed" };
}

function normalizeList(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter((value) => value.length > 0))];
}

function preserveWorkStateForContextLimit(state: LoopState): WorkState {
  const workstream = state.harnessContext.contextEngine?.workstream;
  const openWork = normalizeList(state.workState.openWork);
  const durableOpenWork = normalizeList([
    workstream?.currentRequest?.request,
    workstream?.next,
  ].filter((value): value is string => Boolean(value)));
  const blockers = normalizeList(state.workState.blockers);
  const verifiedFacts = normalizeList(state.workState.verifiedFacts);
  return compactWorkState({
    ...state.workState,
    status: "not_done",
    summary: state.workState.summary || "The workstream request remains in progress.",
    openWork: openWork.length > 0
      ? openWork
      : durableOpenWork.length > 0
        ? durableOpenWork
        : ["Continue the active workstream request in a new run."],
    blockers: blockers.length > 0 ? blockers : workstream?.blockers ?? [],
    verifiedFacts,
    nextStep: state.workState.nextStep
      || workstream?.next
      || "Continue the active workstream request in a new run.",
  });
}
