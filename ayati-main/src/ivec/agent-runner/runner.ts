import { resolve } from "node:path";
import type { LlmImageContentPart } from "../../core/contracts/llm-protocol.js";
import {
  ContextInputLimitError,
  ContextRunCapacityError,
} from "../../prompt/context-compilation-receipt.js";
import { devLog } from "../../shared/index.js";
import type { SessionInputHandle } from "../../memory/types.js";
import { getWorkspaceRoot } from "../../skills/workspace-paths.js";
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
import { callAgentDecision } from "./decision.js";
import type { AgentDecision } from "./decision.js";
import { modeTransitionControlNames } from "./mode-transition-controls.js";
import type { VirtualModeTransitionTarget } from "./virtual-mode.js";
import {
  evaluateReadProgressGuard,
  updateReadProgressAfterActOutput,
} from "./read-progress-policy.js";
import type { CapabilitySurfaceResult } from "./capabilities/contracts.js";
import type { RepairCode } from "./repair-policy.js";
import {
  createCapabilitySurfaceNoProgressFailure,
  createCapabilitySurfaceProgressState,
  evaluateCapabilitySurfaceProgress,
} from "./capability-surface-progress-policy.js";
import { recordRunStep } from "./step-lifecycle.js";
import { buildContextEngineEventSummary } from "../context-engine-event-summary.js";
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
} from "./final-response-policy.js";
import {
  appendActiveFailure,
  latestActiveFailure,
  resolveActiveFailures,
  resolveReportedDenialFailures,
} from "./failure-lifecycle.js";
import {
  buildRunResources,
  buildVerifiedCompletionResources,
  buildWorkstreamSummaryRecord,
} from "./run-result.js";
import { completeWorkStateHandoff } from "./work-state/terminal-handoff.js";
import { buildVerifiedResourceEffects } from "./verified-resource-effects.js";
import { buildRunLimitHandoff } from "./run-limit-handoff.js";
import { buildRunFailureHandoff } from "./run-failure-handoff.js";
import { workStateFindings } from "./work-state/selectors.js";
import {
  buildFinalFeedbackWarnings,
  buildToolExposureWarningCodes,
  recordActionFeedback,
  recordFeedback,
  recordFailureResolutionFeedback,
  recordReducerFeedback,
  recordStepFeedback,
  recordCapabilitySurfaceFeedback,
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
  filterToolDefinitionsForVirtualMode,
  type VirtualModeRepair,
} from "./virtual-mode-runtime.js";
import {
  isVirtualGraphActive,
  modeTransitionTargetValues,
} from "./virtual-mode.js";
import { validationModePassed } from "./validation-mode.js";
import { buildValidatedWorkstreamCriteria } from "./task-validation-criteria.js";
import {
  dispatchDeterministicBindingClarification,
  dispatchTerminalStop,
  type TerminalStopResult,
} from "./terminal-stop.js";
import {
  completeContextRetrieval,
  isContextRetrievalAction,
} from "./context-retrieval.js";
import {
  createBindingAttemptPolicyState,
  recordBindingAttempt,
} from "./binding-attempt-policy.js";
import { createContextMaintenanceLifecycle } from "./context-maintenance-runtime.js";
import {
  enterRunContextMaintenance,
  handleRunContextMaintenanceDecision,
  planRunContextMaintenance,
} from "./run-context-maintenance-runtime.js";

export async function runAgentLoop(
  deps: AgentLoopDeps,
  resolvedConfig?: LoopConfig,
): Promise<AgentLoopResult> {
  const config: LoopConfig = resolvedConfig ?? { ...DEFAULT_LOOP_CONFIG, ...deps.config };
  const workspaceRoot = resolve(deps.workspaceRoot ?? getWorkspaceRoot());
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
  let terminalStopAttemptCount = 0;
  let terminalStopAcceptedCount = 0;
  let terminalStopRejectedCount = 0;
  let bindingAttemptPolicy = createBindingAttemptPolicyState();
  let bindingStatus: "not_started" | "started" | "resolved" | "needs_user_input" | "failed" = "not_started";
  let durableStepCount = 0;
  let transientContextActionCount = 0;
  let failedVerificationCount = 0;
  let lastVerificationPassed: boolean | undefined;
  let capabilitySurfaceProgress = createCapabilitySurfaceProgressState();
  const state = buildInitialState(deps, config, inputHandle, runHandle);
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
    if (
      input.status === "failed"
      && state.workState.status === "in_progress"
    ) {
      const failure = latestFailureReason(state);
      state.workState = {
        ...state.workState,
        summary: state.workState.summary === "Run started."
          ? failure || "The run failed before completion."
          : state.workState.summary,
        importantContext: failure
          ? appendWorkStateConstraint(state.workState, failure)
          : state.workState.importantContext,
        nextAction: state.workState.nextAction
          || "Retry from the latest verified state when a safe recovery is available.",
      };
    }
    state.workState = compactWorkState(state.workState);
    syncHarnessContext(state, deps, inputHandle);
    recordStateSnapshotMetric("final");
    const cleanupRunId = runHandle.runId;
    deps.capabilitySurfaceManager?.resetRun({
      clientId: deps.clientId,
      runId: cleanupRunId,
      sessionId: inputHandle.sessionId,
      stepNumber: state.iteration,
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
      bindingAttempts: bindingAttemptPolicy.attempts,
      bindingStatus,
      validationAttempts: validationAttemptCount,
      validationAccepted: validationAcceptedCount,
      validationRejected: validationRejectedCount,
      terminalStopAttempts: terminalStopAttemptCount,
      terminalStopAccepted: terminalStopAcceptedCount,
      terminalStopRejected: terminalStopRejectedCount,
    };
    recordFeedback(deps, inputHandle, runHandle.runId, "harness", "result", {
      status: input.status,
      responseKind,
      workstreamBound: isWorkstreamBound(state),
      totalIterations: state.iteration,
      totalToolCalls,
      modeTransitions: modeTransitionCount,
      navigation,
      actionStepCount: durableStepCount,
      transientContextActionCount,
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
      actionStepCount: durableStepCount,
      transientContextActionCount,
      failedVerificationCount,
      verificationPassed: lastVerificationPassed,
      basedOnVerifiedFacts: workStateFindings(state.workState).length > 0
        || lastVerificationPassed === true,
      warnings: warningFlags,
      workstreamSummary: summarizeWorkstreamSummary(workstreamSummary),
      feedbackSummary: {
        status: input.status,
        responseKind,
        iterations: state.iteration,
        toolCalls: totalToolCalls,
        modeTransitions: modeTransitionCount,
        navigation,
        actionSteps: durableStepCount,
        transientContextActions: transientContextActionCount,
        verificationPassed: lastVerificationPassed ?? false,
        basedOnVerifiedFacts: workStateFindings(state.workState).length > 0
          || lastVerificationPassed === true,
        contextEngine: buildContextEngineEventSummary({
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
  const finalizeAcceptedTerminalStop = async (
    stop: Extract<TerminalStopResult, { accepted: true }>,
  ): Promise<AgentLoopResult> => {
    recordFailureResolutionFeedback(
      deps,
      inputHandle,
      runHandle.runId,
      resolveActiveFailures(state, {
        scopes: ["navigation", "binding", "action", "validation"],
        iteration: state.iteration,
        kind: "validation_accepted",
      }),
    );
    state.workState = compactWorkState(stop.nextWorkState);
    state.finalOutput = stop.response;
    state.consecutiveFailures = 0;
    recordStateSnapshotMetric("after_terminal_stop_accepted");
    const responseKind = stop.outcome === "needs_user_input"
      ? "feedback"
      : state.preferredResponseKind ?? "reply";
    const loopStatus = stop.outcome === "failed"
      ? "failed"
      : stop.outcome === "blocked"
        ? "stuck"
        : "completed";
    state.status = loopStatus;
    return await finalize({
      status: loopStatus,
      content: stop.response,
      responseKind,
      ...(stop.outcome === "needs_user_input"
        ? {
            completion: {
              done: true as const,
              summary: stop.response,
              status: "completed" as const,
              response_kind: responseKind,
              feedback_kind: "clarification" as const,
            },
          }
        : {}),
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

  while (
    state.status === "running"
    && state.iteration - (state.runContextMaintenanceBudgetCredits ?? 0) < config.maxIterations
  ) {
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
    };
    const deterministicCapabilitySurface: CapabilitySurfaceResult | undefined = deps.capabilitySurfaceManager
      ?.prepareForDecision(state, toolContext);
    const modeVisibleTools = deps.capabilitySurfaceManager
      ? deps.capabilitySurfaceManager.visibleToolDefinitions(toolContext)
      : deps.toolExecutor?.definitions({
        ...toolContext,
      }) ?? deps.toolDefinitions;
    const visibleTools = filterToolDefinitionsForVirtualMode(state, modeVisibleTools);
    const pressureToolSurface = Boolean(state.contextPressure && state.contextPressure.mode !== "full");
    const selectedToolLimit = Math.min(config.maxCapabilitySurfaceTools, 8);
    const toolRoutingSummary = deps.capabilitySurfaceManager?.getCapabilitySummary(state, toolContext)
      ?? buildVirtualCapabilitySummary(deps.toolDefinitions);
    const selectedTools = visibleTools;
    recordCapabilitySurfaceFeedback({
      deps,
      inputHandle,
      runId: runHandle.runId,
      state,
      iteration: state.iteration,
      toolContextRunId: toolContext.runId,
      deterministicCapabilitySurface,
      visibleTools,
      selectedTools,
      runHandle,
    });
    const stateView = buildAgentStateView(state, {
      activeTools: selectedTools.map((tool) => tool.name),
      workspaceRoot,
    });
    const capabilityPolicy = deriveWorkstreamBindingCapabilityPolicy(state);
    const graphActive = isVirtualGraphActive(state.virtualMode);
    const runContextMaintenanceActive = state.virtualMode.active === "run.maintain";
    const workStateCheckpointAvailable = graphActive
      && !runContextMaintenanceActive
      && deps.checkpointWorkState !== undefined;
    const runContextMaintenanceAvailable = runContextMaintenanceActive
      && deps.checkpointWorkState !== undefined;
    const allowedModeDestinations = stateView.context.run?.mode?.allowedNext
      .filter((value): value is VirtualModeTransitionTarget => (
        value === "context.retrieve"
        || value === "observe.locate"
        || value === "observe.investigate"
        || value === "workstream.route"
        || value === "resolve"
        || value === "execute"
        || value === "validation"
      )) ?? [];
    const nativeControlTools = [
      ...modeTransitionControlNames(allowedModeDestinations),
      ...(workStateCheckpointAvailable
        ? ["decision_checkpoint_workstate"]
        : []),
      ...(runContextMaintenanceAvailable
        ? ["decision_maintain_run_context"]
        : []),
      ...(graphActive && !runContextMaintenanceActive ? ["decision_stop"] : []),
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
      contextEngine: buildContextEngineEventSummary({
        context: state.harnessContext.contextEngine,
      }),
      warningCodes: buildToolExposureWarningCodes(state, selectedTools),
      toolPolicyAudit: decisionToolPolicyAudit,
      inputState: summarizeDecisionInputState(stateView, state),
    });
    let decision: AgentDecision;
    try {
      decision = await callAgentDecision({
        provider: deps.provider,
        stateView,
        toolDefinitions: selectedTools,
        toolRoutingSummary,
        modeCapabilityOptions: deps.capabilitySurfaceManager?.getModeCapabilityOptions(state),
        modeTransitionAvailable: !runContextMaintenanceActive,
        terminalStopAvailable: graphActive && !runContextMaintenanceActive,
        workStateCheckpointAvailable,
        runContextMaintenanceAvailable,
        toolContextProjectionPolicy: config.toolContextProjectionPolicy,
        contextCheckpoint: deps.contextCheckpoint,
        contextPreparation: deps.contextPreparation,
        contextMaintenance: createContextMaintenanceLifecycle({
          state,
          buildStateView: () => buildAgentStateView(state, {
            activeTools: selectedTools.map((tool) => tool.name),
            workspaceRoot,
          }),
          onEvent: (event, data) => {
            recordFeedback(
              deps,
              inputHandle,
              runHandle.runId,
              "virtual_mode",
              `context_maintenance_${event}`,
              {
                iteration: state.iteration,
                ...data,
              },
            );
          },
        }),
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
        eventSink: deps.eventSink,
        feedbackContext: {
          clientId: deps.clientId,
          sessionId: inputHandle.sessionId,
          seq: inputHandle.seq,
          runId: runHandle.runId,
        },
        imageInputs: managedImageInputs(deps.provider, state),
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
        const handoff = buildRunFailureHandoff(state, error);
        state.status = "failed";
        state.workState = handoff.workState;
        state.finalOutput = handoff.response;
        recordFeedback(deps, inputHandle, runHandle.runId, "guard", "decision_runtime_failed", {
          iteration: state.iteration,
          errorName: error instanceof Error ? error.name : "UnknownError",
          errorMessage: error instanceof Error ? error.message : String(error),
          verifiedEffectCount: handoff.verifiedEffectCount,
        });
        return finalize({ status: "failed", content: state.finalOutput });
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
      contextEngine: buildContextEngineEventSummary({
        context: state.harnessContext.contextEngine,
      }),
    });

    if (
      !runContextMaintenanceActive
      && graphActive
      && deps.checkpointWorkState
    ) {
      const maintenancePlan = planRunContextMaintenance(state);
      if (maintenancePlan) {
        enterRunContextMaintenance(state, maintenancePlan);
        recordFeedback(
          deps,
          inputHandle,
          runHandle.runId,
          "virtual_mode",
          "run_context_maintenance_entered",
          {
            iteration: state.iteration,
            maintenanceId: maintenancePlan.maintenanceId,
            returnMode: state.virtualMode.runMaintain?.returnState.active ?? "ENTRY",
            sourceThroughStep: maintenancePlan.sourceThroughStep,
            expectedWorkStateRevision: maintenancePlan.expectedWorkStateRevision,
            requiredSavingsTokens: maintenancePlan.requiredSavingsTokens,
            candidateCount: maintenancePlan.inventory.length,
            omittedCandidateCount: maintenancePlan.omittedCandidateCount,
            protectedRefCount: maintenancePlan.protectedRefs.length,
          },
        );
        recordStateSnapshotMetric("run_context_maintenance_entered");
        continue;
      }
    }

    if (decision.kind === "maintain_run_context") {
      if (!deps.checkpointWorkState) {
        throw new Error("WorkState checkpoint persistence is unavailable for run-context maintenance.");
      }
      const maintenance = await handleRunContextMaintenanceDecision({
        state,
        selection: decision.selection,
        checkpointWorkState: deps.checkpointWorkState,
        afterStep: durableStepCount,
        at: new Date().toISOString(),
      });
      if (maintenance.status === "retry") {
        recordVirtualModeRepair(state, {
          code: "MODE_INPUT_INVALID",
          message: maintenance.reason,
          blockedTargets: [],
          allowedNextActions: [
            "Retry decision_maintain_run_context using the current maintenance id, WorkState revision, and only listed candidate references.",
          ],
        }, "validation_error");
        recordFeedback(
          deps,
          inputHandle,
          runHandle.runId,
          "virtual_mode",
          "run_context_maintenance_rejected",
          {
            iteration: state.iteration,
            attempt: maintenance.attempt,
            reason: maintenance.reason,
          },
        );
        continue;
      }
      if (maintenance.status === "failed") {
        state.contextLimitReached = true;
        state.status = "stuck";
        state.workState = preserveWorkStateForContextLimit(state);
        state.finalOutput = "This run could not safely reduce its active context. I preserved the verified handoff so the work can continue in a new turn.";
        recordFeedback(
          deps,
          inputHandle,
          runHandle.runId,
          "guard",
          "run_context_maintenance_failed",
          {
            iteration: state.iteration,
            reason: maintenance.reason,
          },
        );
        return finalize({ status: "stuck", content: state.finalOutput });
      }
      if (maintenance.context) {
        applyPersistedStepContext(deps, state, inputHandle, maintenance.context);
      }
      deps.contextPreparation?.clearOverlay();
      recordFeedback(
        deps,
        inputHandle,
        runHandle.runId,
        "virtual_mode",
        "run_context_maintenance_completed",
        {
          iteration: state.iteration,
          maintenanceId: maintenance.plan.maintenanceId,
          restoredMode: state.virtualMode.active ?? "ENTRY",
          workStateRevision: state.workStateRuntime.revision,
          transformationCount: maintenance.transformationCount,
          estimatedSavingsTokens: maintenance.estimatedSavingsTokens,
          targetReached: maintenance.targetReached,
          usedFallback: maintenance.usedFallback,
          ...(maintenance.priorRejection
            ? { priorRejection: maintenance.priorRejection }
            : {}),
        },
      );
      recordStateSnapshotMetric("run_context_maintenance_completed");
      continue;
    }

    if (
      requiresContextPressureCheckpoint(state)
      && decision.kind !== "checkpoint_work_state"
      && decision.kind !== "reply"
      && decision.kind !== "stop"
    ) {
      const repair: VirtualModeRepair = {
        code: "MODE_NO_PROGRESS",
        message: "Context pressure is active. Checkpoint the small durable WorkState before continuing graph work.",
        blockedTargets: [],
        allowedNextActions: [
          "Call decision_checkpoint_workstate with reason context_pressure, a concise summary, the current plan if one exists, only important continuation context, and one next action.",
        ],
      };
      recordVirtualModeRepair(state, repair, "validation_error");
      recordFeedback(deps, inputHandle, runHandle.runId, "work_state", "checkpoint_required", {
        pressureMode: state.contextPressure?.mode,
        workStateRevision: state.workStateRuntime.revision,
        workStateReason: state.workStateRuntime.updateReason,
      });
      continue;
    }

    if (decision.kind === "checkpoint_work_state") {
      const nextWorkState = compactWorkState({
        status: "in_progress",
        summary: decision.update.summary,
        plan: decision.update.plan,
        importantContext: decision.update.importantContext,
        ...(decision.update.nextAction
          ? { nextAction: decision.update.nextAction }
          : {}),
      });
      if (
        decision.update.reason === "context_pressure"
        && state.contextPressure?.mode === "full"
      ) {
        recordVirtualModeRepair(state, {
          code: "MODE_NO_PROGRESS",
          message: "A context-pressure WorkState checkpoint is valid only while context pressure is active.",
          blockedTargets: [],
          allowedNextActions: [
            "Continue the current graph work, or use a plan checkpoint only if a material implementation plan is needed.",
          ],
        }, "validation_error");
        continue;
      }
      if (
        decision.update.reason === "plan"
        && JSON.stringify(nextWorkState) === JSON.stringify(state.workState)
      ) {
        recordVirtualModeRepair(state, {
          code: "MODE_NO_PROGRESS",
          message: "The proposed WorkState plan checkpoint does not change the current handoff.",
          blockedTargets: [],
          allowedNextActions: ["Continue the current graph work without another checkpoint."],
        }, "validation_error");
        continue;
      }
      if (!deps.checkpointWorkState) {
        throw new Error("WorkState checkpoint persistence is unavailable for this run.");
      }
      const checkpoint = await deps.checkpointWorkState({
        reason: decision.update.reason,
        workState: nextWorkState,
        runtime: state.workStateRuntime,
        afterStep: durableStepCount,
        at: new Date().toISOString(),
      });
      state.workState = nextWorkState;
      state.workStateRuntime = checkpoint.runtime;
      if (checkpoint.context) {
        applyPersistedStepContext(deps, state, inputHandle, checkpoint.context);
      }
      recordFeedback(deps, inputHandle, runHandle.runId, "work_state", "checkpointed", {
        reason: decision.update.reason,
        revision: state.workStateRuntime.revision,
        afterStep: state.workStateRuntime.afterStep,
        planItemCount: state.workState.plan.length,
        importantContextCount: state.workState.importantContext.length,
      });
      recordStateSnapshotMetric("after_work_state_checkpoint");
      continue;
    }

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
      if (decision.status === "completed" && canMarkTerminalReplyDone(state)) {
        state.workState = completeWorkStateHandoff({
          runId: state.runId,
          workState: state.workState,
          validationChecks: state.virtualMode.validation?.checks ?? [],
        });
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

    if (decision.kind === "stop") {
      terminalStopAttemptCount++;
      const stop = dispatchTerminalStop(state, decision.request);
      if (stop.accepted) terminalStopAcceptedCount++;
      else terminalStopRejectedCount++;
      recordFeedback(
        deps,
        inputHandle,
        runHandle.runId,
        "virtual_mode",
        stop.accepted ? "terminal_stop_accepted" : "terminal_stop_rejected",
        {
          iteration: state.iteration,
          request: decision.request,
          mode: state.virtualMode,
          ...(stop.accepted
            ? { outcome: stop.outcome, nextWorkState: stop.nextWorkState }
            : { repair: stop.repair }),
        },
      );
      if (!stop.accepted) {
        recordVirtualModeRepair(state, stop.repair, "verify_failed");
        recordStateSnapshotMetric("after_terminal_stop_rejected");
        if (hasRepeatedRepairFailure(state.failureHistory) || state.consecutiveFailures >= config.maxConsecutiveFailures) {
          state.status = "failed";
          state.finalOutput = buildFailureReply(state);
          return finalize({ status: "failed", content: state.finalOutput });
        }
        continue;
      }

      return await finalizeAcceptedTerminalStop(stop);
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
        workspaceRoot,
        iteration: state.iteration,
        toolDefinitions: deps.toolDefinitions,
        capabilitySurfaceManager: deps.capabilitySurfaceManager,
        toolContext,
        workstreamBinding: deps.workstreamBinding,
        bindingAlreadyAttempted: bindingAttemptPolicy.unavailable,
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
        bindingStatus = transition.kind === "resolved"
          ? "resolved"
          : transition.kind === "binding_needs_user_input"
            ? "needs_user_input"
            : "failed";
        if (transition.binding.attempted) {
          bindingAttemptPolicy = recordBindingAttempt(
            bindingAttemptPolicy,
            transition.binding.attemptConsumed,
          );
        }
      }

      if (transition.kind === "applied" || transition.kind === "resolved") {
        acceptedModeTransitionCount++;
        if (
          transition.kind === "applied"
          && state.virtualMode.active === "validation"
        ) {
          validationAttemptCount++;
          if (validationModePassed(state.virtualMode)) {
            validationAcceptedCount++;
          } else {
            validationRejectedCount++;
          }
        }
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
        const validationAccepted = transition.kind === "applied"
          && validationModePassed(state.virtualMode);
        const resolutionKind = transition.kind === "resolved"
          ? "authoritative_binding"
          : validationAccepted
            ? "validation_accepted"
            : "accepted_mode_transition";
        recordFailureResolutionFeedback(
          deps,
          inputHandle,
          runHandle.runId,
          resolveActiveFailures(state, {
            scopes: transition.kind === "resolved"
              ? ["navigation", "binding"]
              : validationAccepted
                ? ["navigation", "validation"]
                : ["navigation"],
            iteration: state.iteration,
            kind: resolutionKind,
          }),
        );
        if (validationAccepted) {
          recordFailureResolutionFeedback(
            deps,
            inputHandle,
            runHandle.runId,
            resolveReportedDenialFailures(state, {
              callIds: validatedDenialCallIds(state),
              iteration: state.iteration,
            }),
          );
        }
        state.consecutiveFailures = 0;
        capabilitySurfaceProgress = createCapabilitySurfaceProgressState();
        recordRunMetric(metrics, "mode_transition", {
          kind: "local",
          status: "success",
        });
        continue;
      }

      if (transition.kind === "binding_needs_user_input") {
        terminalStopAttemptCount++;
        const stop = dispatchDeterministicBindingClarification(state, transition.question);
        if (stop.accepted) terminalStopAcceptedCount++;
        else terminalStopRejectedCount++;
        recordFeedback(
          deps,
          inputHandle,
          runHandle.runId,
          "virtual_mode",
          stop.accepted ? "terminal_stop_accepted" : "terminal_stop_rejected",
          {
            iteration: state.iteration,
            source: "deterministic_binding_clarification",
            mode: state.virtualMode,
            ...(stop.accepted
              ? { outcome: stop.outcome, nextWorkState: stop.nextWorkState }
              : { repair: stop.repair }),
          },
        );
        if (!stop.accepted) {
          recordVirtualModeRepair(state, stop.repair, "verify_failed");
          state.status = "failed";
          state.finalOutput = buildFailureReply(state);
          return finalize({ status: "failed", content: state.finalOutput });
        }
        return await finalizeAcceptedTerminalStop(stop);
      }

      if (transition.kind === "binding_failed") {
        const canCorrectBinding = !transition.binding.attemptConsumed;
        recordVirtualModeRepair(state, {
          code: canCorrectBinding
            ? "MODE_INPUT_INVALID"
            : "MODE_RESOLUTION_UNAVAILABLE",
          message: transition.message,
          blockedTargets: modeTransitionTargetValues(decision.request),
          allowedNextActions: canCorrectBinding
            ? [
                "Correct the request lifecycle operation using the observed request state, then retry resolve once.",
              ]
            : [
                "Validate a truthful failed or needs-input outcome without replaying mutation.",
              ],
        }, "validation_error");
        continue;
      }

      recordVirtualModeRepair(state, transition.repair, "validation_error");
      if (transition.noProgressResult) {
        const progressEvaluation = evaluateCapabilitySurfaceProgress(
          capabilitySurfaceProgress,
          transition.noProgressResult,
        );
        capabilitySurfaceProgress = progressEvaluation.state;
        if (progressEvaluation.shouldStop) {
          const failure = createCapabilitySurfaceNoProgressFailure(progressEvaluation, state.iteration);
          appendActiveFailure(state, failure);
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

    const activeToolsForRun = deps.capabilitySurfaceManager?.listActive(toolContext) ?? [];
    recordFeedback(deps, inputHandle, runHandle.runId, "tools", "run_tools_enabled", {
      iteration: state.iteration,
      toolContextRunId: toolContext.runId,
      workstreamBound: isWorkstreamBound(state),
      activeTools: activeToolsForRun,
      normalTools: activeToolsForRun,
      routingTools: [],
    });
    const isContextAction = isContextRetrievalAction(state, decision.action);
    const stepNumber = isContextAction
      ? transientContextActionCount + 1
      : durableStepCount + 1;
    const stepKind = isContextAction
      ? "transient_context" as const
      : "durable" as const;
    const readProgressViolation = isContextAction
      ? undefined
      : evaluateReadProgressGuard(state.readProgress, decision.action);
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
      step: stepNumber,
      stepKind,
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
    const stepResult = await executeActionStep({
      deps,
      state,
      config,
      metrics,
      selectedTools,
      decision,
      stepNumber,
      preserveWorkState: isContextAction,
    });
    const stepCompletedAt = new Date().toISOString();
    if (isContextAction) {
      transientContextActionCount++;
    } else {
      lastVerificationPassed = stepResult.execution.verifyOutput.passed;
      if (!stepResult.execution.verifyOutput.passed) {
        failedVerificationCount++;
      }
    }
    totalToolCalls += stepResult.stepSummary.toolSuccessCount + stepResult.stepSummary.toolFailureCount;
    if (!isContextAction) {
      state.readProgress = updateReadProgressAfterActOutput(state.readProgress, stepResult.execution.actOutput);
    }
    recordActionFeedback(deps, inputHandle, runHandle.runId, decision.action, stepResult);
    recordStepFeedback(deps, inputHandle, runHandle.runId, state.iteration, stepResult);

    const reducerStarted = process.hrtime.bigint();
    const beforeWorkStateChars = measureJson(stepResult.execution.nextWorkState);
    const compactedWorkState = compactWorkState(stepResult.execution.nextWorkState);
    recordCompactionMetric(metrics, "workState", beforeWorkStateChars, measureJson(compactedWorkState), {
      step: stepNumber,
      stepKind,
    });
    state.workState = compactedWorkState;
    state.toolContext = buildUpdatedToolContext(
      state,
      stepResult.execution,
      stepNumber,
      isContextAction ? { stepKind: "transient_context" } : {},
    );
    stepResult.stepSummary.workState = compactedWorkState;
    if (isContextAction) {
      completeContextRetrieval({
        state,
        capabilitySurfaceManager: deps.capabilitySurfaceManager,
        toolContext,
      });
    }
    recordReducerFeedback(deps, inputHandle, runHandle.runId, state.iteration, {
      beforeWorkStateChars,
      compactedWorkState,
      stepSummary: stepResult.stepSummary,
      durationMs: Number(process.hrtime.bigint() - reducerStarted) / 1_000_000,
    });

    const compactedStep = compactStepSummaryForState(stepResult.stepSummary);
    recordCompactionMetric(
      metrics,
      "completedStepSummary",
      measureJson(stepResult.stepSummary),
      measureJson(compactedStep),
      { step: stepNumber, stepKind },
    );
    if (!isContextAction) {
      const persistedContext = await recordRunStep(deps, state, decision.action, stepResult, {
        startedAt: stepStartedAt,
        completedAt: stepCompletedAt,
      });
      durableStepCount++;
      state.completedSteps.push(compactedStep);
      applyPersistedStepContext(deps, state, inputHandle, persistedContext);
    }

    recordPlanModeMetric(metrics, decision.action.mode, {
      step: stepNumber,
      stepKind,
      tools: decision.action.calls.map((call) => call.tool).join(","),
    });
    recordVerificationMetric(metrics, stepResult.stepSummary.verificationMethod, {
      step: stepNumber,
      stepKind,
      executionStatus: stepResult.stepSummary.executionStatus,
      validationStatus: stepResult.stepSummary.validationStatus,
    });
    if (deps.capabilitySurfaceManager) {
      recordFeedback(deps, inputHandle, runHandle.runId, "tools", "after_execution", {
        iteration: state.iteration,
        activeTools: deps.capabilitySurfaceManager.listActive({
          clientId: deps.clientId,
          runId: runHandle.runId,
          sessionId: inputHandle.sessionId,
          stepNumber,
        }),
      });
    }

    if (stepResult.stepSummary.outcome === "failed") {
      state.consecutiveFailures++;
      appendActiveFailure(
        state,
        createFailureRecordFromStepSummary(stepResult.stepSummary, state.failureHistory),
      );
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
      if (!isContextAction) {
        recordFailureResolutionFeedback(
          deps,
          inputHandle,
          runHandle.runId,
          resolveActiveFailures(state, {
            scopes: ["action"],
            iteration: state.iteration,
            kind: "verified_action",
          }),
        );
      }
    }

    recordStateSnapshotMetric("after_step");
    deps.onProgress?.(
      isContextAction
        ? `Context load ${stepNumber}: ${stepResult.stepSummary.executionContract} -> ${stepResult.stepSummary.outcome}`
        : `Step ${stepNumber}: ${stepResult.stepSummary.executionContract} -> ${stepResult.stepSummary.outcome}`,
      state.runPath,
    );

  }

  if (validationModePassed(state.virtualMode) && canMarkTerminalReplyDone(state)) {
    state.status = "completed";
    state.workState = completeWorkStateHandoff({
      runId: state.runId,
      workState: state.workState,
      validationChecks: state.virtualMode.validation?.checks ?? [],
    });
    state.finalOutput = "The requested work passed validation before the decision limit, and the run is complete.";
    return finalize({
      status: "completed",
      content: state.finalOutput,
      completion: {
        done: true,
        summary: state.finalOutput,
        status: "completed",
        response_kind: state.preferredResponseKind ?? "reply",
      },
    });
  }

  const handoff = buildRunLimitHandoff(state, config.maxIterations);
  state.runLimitReached = true;
  state.status = "stuck";
  state.workState = handoff.workState;
  state.finalOutput = handoff.response;
  recordFeedback(deps, inputHandle, runHandle.runId, "guard", "run_limit_handoff_validated", {
    iteration: state.iteration,
    maxIterations: config.maxIterations,
    verifiedEffectCount: handoff.verifiedEffectCount,
    verifiedStepCount: handoff.verifiedStepCount,
    workstreamBound: handoff.bound,
    ...(handoff.requestId ? { requestId: handoff.requestId } : {}),
    nextAction: handoff.workState.nextAction,
  });
  return finalize({ status: "stuck", content: state.finalOutput });
}

function validatedDenialCallIds(state: LoopState): string[] {
  return (state.virtualMode.validation?.checks ?? [])
    .filter((check) => (
      check.status === "passed"
      && check.kind === "tool.call_denied"
      && Boolean(check.satisfiedBy?.callId)
    ))
    .map((check) => check.satisfiedBy!.callId!);
}

function requiresContextPressureCheckpoint(state: LoopState): boolean {
  return isVirtualGraphActive(state.virtualMode)
    && state.contextPressure?.mode !== undefined
    && state.contextPressure.mode !== "full"
    && state.workStateRuntime.updateReason !== "context_pressure";
}

function latestFailureReason(state: LoopState): string | undefined {
  return latestActiveFailure(state.failureHistory)?.reason.trim();
}

function appendWorkStateConstraint(
  workState: WorkState,
  value: string,
): WorkState["importantContext"] {
  const normalized = value.trim();
  if (!normalized || workState.importantContext.some((item) =>
    item.kind === "constraint" && item.value === normalized)) {
    return workState.importantContext;
  }
  return [
    ...workState.importantContext,
    { kind: "constraint" as const, value: normalized },
  ].slice(-12);
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
    : repair.code === "TERMINAL_REQUIRES_VALIDATION"
      ? "R_DIRECT_RESPONSE_REQUIRES_MODE"
      : repair.code.startsWith("VALIDATION_")
        ? "R_VALIDATION_REJECTED"
        : "R_MODE_TRANSITION_INVALID";
  state.consecutiveFailures++;
  appendActiveFailure(state, {
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
    repairScope: virtualModeRepairScope(repair),
  });
}

function virtualModeRepairScope(
  repair: VirtualModeRepair,
): LoopState["failureHistory"][number]["repairScope"] {
  if (
    repair.code === "MODE_RESOLUTION_AMBIGUOUS"
    || repair.code === "MODE_RESOLUTION_UNAVAILABLE"
    || repair.code === "MODE_BINDING_REQUIRED"
    || repair.code === "MODE_BINDING_PROPOSAL_REQUIRED"
    || repair.code === "MODE_BINDING_PROPOSAL_UNVERIFIED"
  ) {
    return "binding";
  }
  if (
    repair.code.startsWith("VALIDATION_")
    || repair.code === "TERMINAL_REQUIRES_VALIDATION"
  ) {
    return "validation";
  }
  return "navigation";
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
  const stateViewOptions = {
    activeTools: input.activeTools,
    workspaceRoot: resolve(input.deps.workspaceRoot ?? getWorkspaceRoot()),
  };
  if (!input.context) return buildAgentStateView(input.state, stateViewOptions);
  input.deps.harnessContext = {
    ...(input.deps.harnessContext ?? {}),
    contextEngine: input.context,
  };
  syncHarnessContext(input.state, input.deps, input.inputHandle);
  return buildAgentStateView(input.state, stateViewOptions);
}

function describeActionInputValue(value: unknown): string {
  if (Array.isArray(value)) return `array(${value.length})`;
  if (value === null) return "null";
  if (typeof value === "object") return "object";
  return typeof value;
}

function managedImageInputs(
  provider: AgentLoopDeps["provider"],
  state: LoopState,
): LlmImageContentPart[] | undefined {
  if (provider.capabilities.imageInput !== true) return undefined;
  const images = (state.managedFiles ?? []).flatMap((file): LlmImageContentPart[] => {
    if (file.kind !== "image" || !file.mimeType?.startsWith("image/")) return [];
    return [{
      type: "image",
      imagePath: file.storagePath,
      mimeType: file.mimeType,
      name: file.originalName,
    }];
  });
  return images.length > 0 ? images : undefined;
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
    result.verifiedResourceEffects = buildVerifiedResourceEffects(state);
    result.validatedCriteria = buildValidatedWorkstreamCriteria(state);
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

function preserveWorkStateForContextLimit(state: LoopState): WorkState {
  const workstream = state.harnessContext.contextEngine?.workstream;
  return compactWorkState({
    ...state.workState,
    status: "in_progress",
    summary: state.workState.summary === "Run started."
      ? "The workstream request remains in progress."
      : state.workState.summary,
    nextAction: state.workState.nextAction
      || workstream?.next
      || "Continue the active workstream request in a new run.",
  });
}
