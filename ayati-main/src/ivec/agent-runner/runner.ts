import { join } from "node:path";
import {
  ContextInputLimitError,
  ContextRunCapacityError,
} from "../../prompt/context-compilation-receipt.js";
import { devLog } from "../../shared/index.js";
import { prepareIncomingAttachments } from "../../documents/attachment-preparer.js";
import type { MemoryRunHandle, SessionInputHandle } from "../../memory/types.js";
import type {
  AgentLoopDeps,
  AgentLoopResult,
  CreatedWorkRun,
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
import { repairSignalToFeedbackData } from "./repair-policy.js";
import {
  evaluateReadProgressGuard,
  updateReadProgressAfterActOutput,
} from "./read-progress-policy.js";
import type { ToolLoadResult } from "./tool-working-set.js";
import {
  recordSessionStep,
  recordTaskStep,
} from "./step-lifecycle.js";
import { buildContextEngineFeedbackSummary } from "../feedback-ledger.js";
import { isReadOnlyTool } from "../../skills/tool-taxonomy.js";
import {
  isGitContextAllowedDuringPendingRouting,
  isGitContextReadOnlyToolName,
  isGitContextTurnRoutingToolName,
} from "../../skills/builtins/git-context/tool-policy.js";
import {
  deferredMutationToolNames,
  shouldDeferPreTaskMutation,
  summarizeRoutingAttempts,
  updateRoutingAttemptsFromActOutput,
  validateRoutingAttemptLimits,
} from "./task-routing-policy.js";
import {
  executePendingRoutingAction,
  extractTurnRoutingUpdate,
  recordRoutingAttemptFeedback,
} from "./task-routing-executor.js";
import {
  createFailureRecordFromStepSummary,
  createMissingWorkRunRepairSignal,
  hasRepeatedRepairFailure,
  hasRepeatedToolInputValidationFailure,
  recordDeferredMutationRoutingRepair,
  recordFreshSessionToolRepair,
  recordReadProgressRepair,
  recordRepeatedRepairFailure,
  recordTerminalReplyMutationRepair,
} from "./repair-feedback.js";
import {
  buildBlockedWorkStateReply,
  buildFailureReply,
  buildVerifiedCompletionReply,
  canFinalizeFromWorkState,
  canMarkTerminalReplyDone,
  deriveUserInputNeededFromTerminalReply,
  isUsableFinalResponseMessage,
  shouldRejectTerminalReplyForUnresolvedMutation,
} from "./final-response-policy.js";
import {
  buildTaskAssets,
  buildVerifiedCompletionAssets,
  buildTaskSummaryRecord,
} from "./task-run-result.js";
import {
  buildFinalFeedbackWarnings,
  buildToolExposureWarningCodes,
  latestCompletedTaskRoutingToolNames,
  missingWorkRunWarningCodes,
  recordActionFeedback,
  recordFeedback,
  recordReducerFeedback,
  recordStepFeedback,
  recordToolWorkingSetFeedback,
  summarizeDecisionInputState,
  summarizeTaskSummary,
} from "./runner-feedback.js";
import {
  buildInitialState,
  decisionScopeId,
  getPrimaryUserMessage,
  resolveInputHandle,
  syncHarnessContext,
} from "./runner-state.js";
import {
  applyToolStateUpdates,
  buildUpdatedToolContext,
  executeActionStep,
  syncPreparedAttachmentsFromRegistry,
} from "./action-step.js";
import {
  evaluateTaskCompletion,
  isTaskCompletionAvailable,
} from "./task-completion-policy.js";
import {
  detectRuntimeCapabilityMode,
  isDecisionAllowedInRuntimeMode,
  isFreshSessionRoutingMode,
  isGitContextRoutingToolName,
} from "./runtime-capability-mode.js";
import {
  summarizeAgentAction,
  summarizeDecision,
  summarizeHarnessContext,
  summarizeToolLoadResult,
  summarizeWorkState,
} from "./feedback-summary.js";
import { auditToolPolicy } from "./tool-policy-audit.js";

interface MemoryRunContext {
  runHandle: MemoryRunHandle;
}

export async function runAgentLoop(
  deps: AgentLoopDeps,
  resolvedConfig?: LoopConfig,
): Promise<AgentLoopResult> {
  const config: LoopConfig = resolvedConfig ?? { ...DEFAULT_LOOP_CONFIG, ...deps.config };
  const inputHandle = resolveInputHandle(deps);
  let workRunHandle = deps.runHandle;
  let sessionRunHandle = deps.sessionRunHandle;
  const metrics = createRunMetrics();

  let totalToolCalls = 0;
  let toolLoadDecisionCount = 0;
  let actionStepCount = 0;
  let failedVerificationCount = 0;
  let lastVerificationPassed: boolean | undefined;
  const state = buildInitialState(deps, config, inputHandle, workRunHandle);
  recordFeedback(deps, inputHandle, workRunHandle?.runId, "loop", "started", {
    inputKind: state.inputKind ?? "user_message",
    userMessage: state.userMessage,
  });

  const ensureWorkRun = async (
    reason = "agent_action_or_tool_load",
    decision?: AgentDecision,
  ): Promise<MemoryRunContext> => {
    if (!workRunHandle) {
      const createWorkRun = deps.createWorkRun;
      if (!createWorkRun) {
        const repair = createMissingWorkRunRepairSignal({
          reason,
          message: "Git-memory run handle is required before agent action execution.",
          decision,
          pendingTurnStatus: state.harnessContext.contextEngine?.pendingTurn?.routingStatus,
        });
        recordFeedback(deps, inputHandle, undefined, "guard", "missing_work_run", {
          reason,
          message: "Git-memory run handle is required before agent action execution.",
          warningCodes: ["missing_work_run_for_action"],
          pendingTurnStatus: state.harnessContext.contextEngine?.pendingTurn?.routingStatus,
          ...(decision ? { decision: summarizeDecision(decision) } : {}),
          contextEngine: buildContextEngineFeedbackSummary({
            context: state.harnessContext.contextEngine,
          }),
          harnessContext: summarizeHarnessContext(state.harnessContext),
          ...repairSignalToFeedbackData(repair),
        });
        throw new Error("Git-memory run handle is required before agent action execution.");
      }
      try {
        const createdWorkRun = await createWorkRun(inputHandle, buildCreateWorkRunRequest(state, reason));
        const normalizedWorkRun = normalizeCreatedWorkRun(createdWorkRun);
        workRunHandle = normalizedWorkRun.runHandle;
        if (normalizedWorkRun.harnessContext) {
          deps.harnessContext = normalizedWorkRun.harnessContext;
          syncHarnessContext(state, deps, inputHandle);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const repair = createMissingWorkRunRepairSignal({
          reason,
          message,
          decision,
          pendingTurnStatus: state.harnessContext.contextEngine?.pendingTurn?.routingStatus,
        });
        recordFeedback(deps, inputHandle, undefined, "guard", "missing_work_run", {
          reason,
          message,
          warningCodes: [
            "missing_work_run_for_action",
            ...missingWorkRunWarningCodes(decision),
          ],
          pendingTurnStatus: state.harnessContext.contextEngine?.pendingTurn?.routingStatus,
          ...(decision ? { decision: summarizeDecision(decision) } : {}),
          contextEngine: buildContextEngineFeedbackSummary({
            context: state.harnessContext.contextEngine,
          }),
          harnessContext: summarizeHarnessContext(state.harnessContext),
          ...repairSignalToFeedbackData(repair),
        });
        throw error;
      }
      deps.runHandle = workRunHandle;
      deps.onWorkRunCreated?.(workRunHandle);
      recordFeedback(deps, inputHandle, workRunHandle.runId, "run", "created", {
        reason,
      });
    }
    state.runId = workRunHandle.runId;
    return { runHandle: workRunHandle };
  };
  const ensureSessionRun = async (
    reason = "session_tool_action",
  ): Promise<MemoryRunHandle> => {
    if (sessionRunHandle?.runId) {
      return sessionRunHandle;
    }
    const createSessionRun = deps.createSessionRun;
    if (!createSessionRun) {
      throw new Error("Git-memory session run handle is required before session tool execution.");
    }
    sessionRunHandle = await createSessionRun(inputHandle);
    deps.sessionRunHandle = sessionRunHandle;
    recordFeedback(deps, inputHandle, sessionRunHandle.runId, "run", "session_run_attached", {
      reason,
    });
    return sessionRunHandle;
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
    recordStateSnapshotMetric("final");
    const cleanupRunId = state.runId || sessionRunHandle?.runId || decisionScopeId(inputHandle);
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
    const taskSummary = state.runClass === "task"
      ? buildTaskSummaryRecord(state, finalContent, input.status, responseKind, input.completion)
      : undefined;
    const warningFlags = buildFinalFeedbackWarnings({
      status: input.status,
      totalToolCalls,
      toolLoadDecisionCount,
      actionStepCount,
      failedVerificationCount,
      state,
    });
    recordFeedback(deps, inputHandle, state.runId || workRunHandle?.runId || sessionRunHandle?.runId, "harness", "result", {
      status: input.status,
      responseKind,
      runClass: state.runClass,
      totalIterations: state.iteration,
      totalToolCalls,
      toolLoadDecisionCount,
      actionStepCount,
      failedVerificationCount,
      verificationPassed: lastVerificationPassed,
      finalContentPreview: finalContent,
      workState: summarizeWorkState(state.workState),
      completedStepCount: state.completedSteps.length,
      taskSummary: summarizeTaskSummary(taskSummary),
      harnessContext: summarizeHarnessContext(state.harnessContext),
    });
    recordFeedback(deps, inputHandle, state.runId || workRunHandle?.runId || sessionRunHandle?.runId, "final", "reply", {
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
        contextEngine: buildContextEngineFeedbackSummary({
          context: state.harnessContext.contextEngine,
          finalizationStatus: state.runClass === "task" && (state.runId || workRunHandle?.runId)
            ? "not_started"
            : "skipped",
          committed: false,
          runId: state.runId || workRunHandle?.runId || sessionRunHandle?.runId,
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
  recordFeedback(deps, inputHandle, state.runId || workRunHandle?.runId || sessionRunHandle?.runId, "harness", "context_input", {
    inputKind: state.inputKind ?? "user_message",
    runId: state.runId || workRunHandle?.runId || sessionRunHandle?.runId,
    userMessage: state.userMessage,
    summary: summarizeHarnessContext(state.harnessContext),
    context: state.harnessContext,
  });

  devLog(
    `[${deps.clientId}] agentLoop start inputKind=${state.inputKind ?? "user_message"} seq=${inputHandle.seq} workRun=${state.runId || "none"} message=${state.userMessage.slice(0, 160)}`,
  );

  recordStateSnapshotMetric("initial");

  if ((state.attachedDocuments ?? []).some((document) => document.kind !== "image")) {
    const work = await ensureWorkRun();
    await prepareAttachmentsForRun(deps, state, work.runHandle.runId);
    syncHarnessContext(state, deps, inputHandle);
  }

  while (state.status === "running" && state.iteration < config.maxIterations) {
    if (deps.signal?.aborted) {
      state.status = "failed";
      state.finalOutput = "Agent was stopped.";
      return finalize({ status: "failed", content: state.finalOutput });
    }

    syncHarnessContext(state, deps, inputHandle);
    state.iteration++;
    const finalReplyFromWorkState = canFinalizeFromWorkState(state);
    if (finalReplyFromWorkState) {
      state.status = "completed";
      state.finalOutput = await buildFinalResponseFromWorkState({
        deps,
        state,
        metrics,
        inputHandle,
        workRunHandle,
        config,
      });
      const responseKind = state.workState.status === "needs_user_input"
        ? "feedback"
        : state.preferredResponseKind ?? "reply";
      return finalize({
        status: "completed",
        content: state.finalOutput,
        responseKind,
        completion: {
          done: true,
          summary: state.finalOutput,
          status: "completed",
          response_kind: responseKind,
          ...(state.workState.status === "needs_user_input" ? { feedback_kind: "clarification" } : {}),
        },
      });
    }

    const toolContext = {
      clientId: deps.clientId,
      runId: state.runId || sessionRunHandle?.runId || decisionScopeId(inputHandle),
      sessionId: inputHandle.sessionId,
      stepNumber: state.iteration,
      ...(deps.uiContext ? { uiContext: deps.uiContext } : {}),
    };
    let deterministicToolLoad: ToolLoadResult | undefined;
    if (deps.toolWorkingSetManager) {
      deterministicToolLoad = deps.toolWorkingSetManager.prepareForDecision(state, toolContext, {
        workRunHandle,
        sessionRunHandle,
      });
    } else {
      await deps.skillActivationManager?.prepareForDecision(state, toolContext);
    }
    const visibleTools = deps.toolWorkingSetManager
      ? deps.toolWorkingSetManager.visibleToolDefinitions(toolContext)
      : deps.toolExecutor?.definitions({
        ...toolContext,
      }) ?? deps.toolDefinitions;
    const pressureToolSurface = isContextPressureActive(state);
    const selectedToolLimit = resolveSelectedToolLimit(state, config.maxSelectedTools);
    const toolRoutingSummary = deps.toolWorkingSetManager?.getPromptSummary({
      compact: pressureToolSurface,
    });
    const selectedTools = selectToolsForDecision(state, visibleTools, config.maxSelectedTools, {
      workRunHandle,
      sessionRunHandle,
    });
    recordToolWorkingSetFeedback({
      deps,
      inputHandle,
      runId: state.runId || workRunHandle?.runId || sessionRunHandle?.runId,
      state,
      iteration: state.iteration,
      toolContextRunId: toolContext.runId,
      deterministicToolLoad,
      visibleTools,
      selectedTools,
      workRunHandle,
      sessionRunHandle,
    });
    const stateView = buildAgentStateView(state, {
      activeTools: selectedTools.map((tool) => tool.name),
      workRunHandle,
      sessionRunHandle,
    });
    const taskFeedbackToolAvailable = isTaskFeedbackToolAvailable(state, workRunHandle);
    const decisionRuntimeMode = detectRuntimeCapabilityMode({ state, workRunHandle, sessionRunHandle });
    const nativeControlTools = [
      ...(decisionRuntimeMode.allowToolLoading ? ["decision_load_tools"] : []),
      ...(isTaskCompletionAvailable(state) ? ["task_completion"] : []),
      ...(taskFeedbackToolAvailable ? ["ask_user_feedback"] : []),
    ];
    const decisionToolPolicyAudit = auditToolPolicy({
      mode: decisionRuntimeMode,
      selectedTools,
    });
    recordFeedback(deps, inputHandle, state.runId || workRunHandle?.runId || sessionRunHandle?.runId, "decision", "prompt_summary", {
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
      warningCodes: buildToolExposureWarningCodes(state, selectedTools, workRunHandle, sessionRunHandle),
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
        toolLoadingAvailable: decisionRuntimeMode.allowToolLoading,
        taskFeedbackToolAvailable,
        taskCompletionAvailable: isTaskCompletionAvailable(state),
        toolContextProjectionPolicy: config.toolContextProjectionPolicy,
        timelineCheckpointCache: state.timelineCheckpointCache,
        systemContext: deps.systemContext,
        metrics,
        feedbackLedger: deps.feedbackLedger,
        feedbackContext: {
          clientId: deps.clientId,
          sessionId: inputHandle.sessionId,
          seq: inputHandle.seq,
          ...(state.runId || workRunHandle?.runId || sessionRunHandle?.runId ? { runId: state.runId || workRunHandle?.runId || sessionRunHandle?.runId } : {}),
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
      if (state.harnessContext.contextEngine?.task) {
        state.runClass = "task";
      }
      state.status = "stuck";
      state.workState = preserveWorkStateForContextLimit(state);
      state.finalOutput = "This run reached its context capacity. I preserved the completed work and task state so it can continue in a new turn.";
      recordFeedback(deps, inputHandle, state.runId || workRunHandle?.runId || sessionRunHandle?.runId, "guard", "context_limit", {
        iteration: state.iteration,
        finalInputTokens: error.receipt.finalInputTokens,
        softInputTokens: error.receipt.softInputTokens,
        hardInputTokens: error.receipt.hardInputTokens,
        mode: error.receipt.mode,
      });
      return finalize({ status: "stuck", content: state.finalOutput });
    }
    discardModelWorkingNotes(decision);
    recordFeedback(deps, inputHandle, state.runId || workRunHandle?.runId || sessionRunHandle?.runId, "decision", "selected", {
      iteration: state.iteration,
      decision: summarizeDecision(decision),
      pendingTurnStatus: state.harnessContext.contextEngine?.pendingTurn?.routingStatus,
      contextEngine: buildContextEngineFeedbackSummary({
        context: state.harnessContext.contextEngine,
      }),
    });

    if (decision.kind === "reply") {
      if (state.deferredMutation) {
        recordDeferredMutationRoutingRepair({
          deps,
          inputHandle,
          state,
          config,
          decision,
          reason: "deferred_mutation_reply",
        });
        if (hasRepeatedRepairFailure(state.failureHistory)) {
          recordRepeatedRepairFailure({
            deps,
            inputHandle,
            state,
            runId: state.runId || workRunHandle?.runId || sessionRunHandle?.runId,
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
      const terminalReplyRejection = shouldRejectTerminalReplyForUnresolvedMutation(state, decision);
      if (terminalReplyRejection) {
        recordTerminalReplyMutationRepair({
          deps,
          inputHandle,
          state,
          config,
          decision,
          reason: terminalReplyRejection.reason,
          failedStep: terminalReplyRejection.failedStep,
        });
        if (hasRepeatedRepairFailure(state.failureHistory)) {
          recordRepeatedRepairFailure({
            deps,
            inputHandle,
            state,
            runId: state.runId || workRunHandle?.runId || sessionRunHandle?.runId,
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
      const directTaskCompletionRejected = state.runClass === "task"
        && state.workState.status === "not_done"
        && decision.status === "completed"
        && !deriveUserInputNeededFromTerminalReply(decision.message);
      if (directTaskCompletionRejected) {
        const reason = "An active task run cannot finish through a direct reply while WorkState is not_done. Call task_completion after the requested work and deterministic verification are complete.";
        state.consecutiveFailures++;
        state.failureHistory.push({
          step: state.iteration,
          failureType: "validation_error",
          reason,
          blockedTargets: ["task_completion"],
        });
        recordFeedback(deps, inputHandle, state.runId || workRunHandle?.runId, "guard", "task_reply_before_completion", {
          iteration: state.iteration,
          reason,
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
      const userInputNeeded = decision.status === "completed"
        ? deriveUserInputNeededFromTerminalReply(decision.message)
        : undefined;
      if (userInputNeeded && state.runClass === "task") {
        state.workState = {
          ...state.workState,
          status: "needs_user_input",
          userInputNeeded,
          nextStep: userInputNeeded,
          summary: state.workState.summary || decision.message,
        };
      } else if (decision.status === "completed" && state.runClass === "session") {
        state.workState = {
          ...state.workState,
          status: "done",
          summary: decision.message,
          openWork: [],
          blockers: [],
          nextStep: undefined,
          userInputNeeded: undefined,
        };
      } else if (decision.status === "completed" && state.runClass !== "task" && canMarkTerminalReplyDone(state)) {
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

    if (decision.kind === "task_completion") {
      const evaluation = await evaluateTaskCompletion(state, decision.request);
      state.workState = compactWorkState(evaluation.nextWorkState);
      recordFeedback(
        deps,
        inputHandle,
        state.runId || workRunHandle?.runId || sessionRunHandle?.runId,
        "task_completion",
        evaluation.accepted ? "accepted" : "rejected",
        {
          iteration: state.iteration,
          request: decision.request,
          code: evaluation.code,
          ...(evaluation.accepted
            ? { verifiedAssets: evaluation.assets }
            : { failures: evaluation.failures }),
          workState: summarizeWorkState(state.workState),
        },
      );
      if (evaluation.accepted) {
        state.completionAssets = evaluation.assets;
        state.consecutiveFailures = 0;
        recordRunMetric(metrics, "verified_completion", { kind: "local" });
        recordStateSnapshotMetric("after_task_completion_accepted");
      } else {
        state.consecutiveFailures++;
        const reason = evaluation.failures.map((failure) => failure.message).join(" ");
        state.failureHistory.push({
          step: state.iteration,
          failureType: "verify_failed",
          reason,
          blockedTargets: evaluation.failures.flatMap((failure) => failure.path ? [failure.path] : ["task_completion"]),
        });
        recordStateSnapshotMetric("after_task_completion_rejected");
        if (hasRepeatedRepairFailure(state.failureHistory) || state.consecutiveFailures >= config.maxConsecutiveFailures) {
          state.status = "failed";
          state.finalOutput = buildFailureReply(state);
          return finalize({ status: "failed", content: state.finalOutput });
        }
      }
      continue;
    }

    const runtimeMode = detectRuntimeCapabilityMode({ state, workRunHandle, sessionRunHandle });
    const freshSessionWithoutActiveTask = isFreshSessionRoutingMode(runtimeMode);

    if (shouldDeferPreTaskMutation(state, decision, workRunHandle)) {
      if (decision.kind !== "act") {
        continue;
      }
      if (state.deferredMutation) {
        recordDeferredMutationRoutingRepair({
          deps,
          inputHandle,
          state,
          config,
          decision,
          reason: "deferred_mutation_already_pending",
        });
        if (hasRepeatedRepairFailure(state.failureHistory)) {
          recordRepeatedRepairFailure({
            deps,
            inputHandle,
            state,
            runId: sessionRunHandle?.runId,
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
        state.deferredMutation = {
          action: decision.action,
          selectedTools,
          deferredAtIteration: state.iteration,
          reason: "mutation_requires_task_ownership",
          blockedTools: deferredMutationToolNames(decision.action),
        };
        recordFeedback(deps, inputHandle, sessionRunHandle?.runId, "guard", "mutation_deferred_for_task_routing", {
          iteration: state.iteration,
          reason: "mutation_requires_task_ownership",
          deferredTools: state.deferredMutation.blockedTools,
          action: summarizeAgentAction(decision.action),
          contextEngine: buildContextEngineFeedbackSummary({
            context: state.harnessContext.contextEngine,
          }),
        });
      }
      continue;
    }
    if (freshSessionWithoutActiveTask && !runtimeMode.allowToolLoading && decision.kind === "load_tools") {
      recordFreshSessionToolRepair({
        deps,
        inputHandle,
        state,
        config,
        decision,
        reason: "fresh_session_tool_load",
      });
      if (hasRepeatedRepairFailure(state.failureHistory)) {
        recordRepeatedRepairFailure({
          deps,
          inputHandle,
          state,
          runId: undefined,
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

    if (decision.kind === "load_tools" && !runtimeMode.allowToolLoading) {
      if (state.deferredMutation) {
        recordDeferredMutationRoutingRepair({
          deps,
          inputHandle,
          state,
          config,
          decision,
          reason: "deferred_mutation_already_pending",
        });
        if (hasRepeatedRepairFailure(state.failureHistory)) {
          recordRepeatedRepairFailure({
            deps,
            inputHandle,
            state,
            runId: state.runId || workRunHandle?.runId || sessionRunHandle?.runId,
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
      recordFreshSessionToolRepair({
        deps,
        inputHandle,
        state,
        config,
        decision,
        reason: "fresh_session_tool_load",
      });
      if (hasRepeatedRepairFailure(state.failureHistory)) {
        recordRepeatedRepairFailure({
          deps,
          inputHandle,
          state,
          runId: undefined,
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

    if (decision.kind === "load_tools") {
      toolLoadDecisionCount++;
      const work = workRunHandle ? await ensureWorkRun("tool_load", decision) : null;
      const loadRunId = work?.runHandle.runId ?? sessionRunHandle?.runId ?? decisionScopeId(inputHandle);
      const workToolContext = { ...toolContext, runId: loadRunId };
      recordFeedback(deps, inputHandle, work?.runHandle.runId, "tool_load", "requested", {
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
      recordFeedback(deps, inputHandle, work?.runHandle.runId, "tool_load", "completed", {
        iteration: state.iteration,
        request: decision.request,
        result: summarizeToolLoadResult(loadResult),
        status: loadResult.status,
        loaded: loadResult.loaded,
        alreadyActive: loadResult.alreadyActive,
        missing: loadResult.missing,
        evicted: loadResult.evicted,
        message: loadResult.message,
      });
      recordRunMetric(metrics, "tool_load_decision", {
        kind: "local",
        status: ["loaded", "partial", "already_active"].includes(loadResult.status) ? "success" : "failed",
      });
      continue;
    }

    const freshSessionDecisionAllowed = freshSessionWithoutActiveTask && isDecisionAllowedInRuntimeMode(runtimeMode, decision);
    const freshSessionRouting = freshSessionDecisionAllowed
      && decision.kind === "act"
      && decision.action.calls.some((call) => isGitContextTurnRoutingToolName(call.tool));
    if (freshSessionWithoutActiveTask && !freshSessionDecisionAllowed) {
      const routingAttemptBlock = decision.kind === "act"
        ? validateRoutingAttemptLimits(state, decision.action, Boolean(workRunHandle || state.runId))
        : undefined;
      if (routingAttemptBlock) {
        recordFeedback(deps, inputHandle, sessionRunHandle?.runId, "guard", "routing_attempt_blocked", {
          iteration: state.iteration,
          reason: routingAttemptBlock.reason,
          tools: routingAttemptBlock.tools,
          routing: summarizeRoutingAttempts(state.routingAttempts),
        });
      }
      recordFreshSessionToolRepair({
        deps,
        inputHandle,
        state,
        config,
        decision,
        reason: "fresh_session_wrong_tool",
      });
      if (hasRepeatedRepairFailure(state.failureHistory)) {
        recordRepeatedRepairFailure({
          deps,
          inputHandle,
          state,
          runId: undefined,
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

    const preRunGitContextReadAction = isPreRunGitContextReadAction(decision, workRunHandle);
    const preRunGitContextRoutingAction = isPreRunGitContextRoutingAction(decision, workRunHandle);
    const preRunGitContextAction = preRunGitContextReadAction
      || preRunGitContextRoutingAction
      || isPreRunGitContextAction(decision, workRunHandle);
    const sessionReadOnlyAction = isSessionReadOnlyAction(decision, workRunHandle);
    const sessionRunReadOnlyAction = sessionReadOnlyAction && !preRunGitContextAction;

    const routingControlAction = freshSessionRouting
      || preRunGitContextRoutingAction
      || decision.action.calls.some((call) => isGitContextTurnRoutingToolName(call.tool));
    if (sessionRunReadOnlyAction) {
      const ensuredSessionRun = sessionRunHandle?.runId
        ? sessionRunHandle
        : await ensureSessionRun("read_only_tool_action");
      syncHarnessContext(state, deps, inputHandle);
      if (deps.toolWorkingSetManager) {
        deps.toolWorkingSetManager.prepareForDecision(state, {
          ...toolContext,
          runId: ensuredSessionRun.runId,
        }, {
          workRunHandle,
          sessionRunHandle: ensuredSessionRun,
        });
      }
      const sessionRunId = ensuredSessionRun.runId;
      recordFeedback(deps, inputHandle, undefined, "action", "started", {
        iteration: state.iteration,
        mode: decision.action.mode,
        action: summarizeAgentAction(decision.action),
        plannedCallCount: decision.action.calls.length,
        calls: decision.action.calls.map((call) => ({
          id: call.id,
          tool: call.tool,
          input: summarizeActionInput(call.input),
          dependsOn: call.dependsOn,
          purpose: call.purpose,
        })),
        allowedTools: decision.action.allowedTools,
        sessionReadOnlyAction: true,
      });
      const stepStartedAt = new Date().toISOString();
      const stepResult = await executeActionStep({
        deps,
        state,
        config,
        metrics,
        selectedTools,
        decision,
        stepNumber: state.iteration,
        runHandle: ensuredSessionRun,
        runClass: "session",
      });
      const stepCompletedAt = new Date().toISOString();
      actionStepCount++;
      lastVerificationPassed = stepResult.execution.verifyOutput.passed;
      if (!stepResult.execution.verifyOutput.passed) {
        failedVerificationCount++;
      }
      totalToolCalls += stepResult.stepSummary.toolSuccessCount + stepResult.stepSummary.toolFailureCount;
      state.readProgress = updateReadProgressAfterActOutput(state.readProgress, stepResult.execution.actOutput);
      recordActionFeedback(deps, inputHandle, sessionRunId, decision.action, stepResult);
      recordStepFeedback(deps, inputHandle, sessionRunId, state.iteration, stepResult);

      const beforeWorkStateChars = measureJson(stepResult.execution.nextWorkState);
      const compactedWorkState = compactWorkState(stepResult.execution.nextWorkState);
      recordCompactionMetric(metrics, "workState", beforeWorkStateChars, measureJson(compactedWorkState), { step: state.iteration });
      state.workState = compactedWorkState;
      state.toolContext = buildUpdatedToolContext(state, stepResult.execution);
      stepResult.stepSummary.workState = compactedWorkState;
      recordReducerFeedback(deps, inputHandle, sessionRunId, state.iteration, {
        beforeWorkStateChars,
        compactedWorkState,
        stepSummary: stepResult.stepSummary,
      });

      const compactedStep = compactStepSummaryForState(stepResult.stepSummary);
      recordCompactionMetric(metrics, "completedStepSummary", measureJson(stepResult.stepSummary), measureJson(compactedStep), { step: state.iteration });
      state.completedSteps.push(compactedStep);
      const persistedContext = await recordSessionStep(deps, ensuredSessionRun, decision.action, stepResult, {
        startedAt: stepStartedAt,
        completedAt: stepCompletedAt,
      });
      applyPersistedStepContext(deps, state, inputHandle, persistedContext);

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
        runId: sessionRunId,
      });
      deps.toolWorkingSetManager?.afterExecution(stepResult.execution.actOutput.toolCalls, {
        clientId: deps.clientId,
        runId: sessionRunId,
        sessionId: ensuredSessionRun.sessionId,
        stepNumber: state.iteration,
      });

      if (stepResult.stepSummary.outcome === "failed") {
        state.consecutiveFailures++;
        state.failureHistory.push(createFailureRecordFromStepSummary(stepResult.stepSummary, state.failureHistory));
        if (hasRepeatedRepairFailure(state.failureHistory)) {
          recordRepeatedRepairFailure({
            deps,
            inputHandle,
            state,
            runId: sessionRunId,
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

      deps.onProgress?.(
        `Step ${state.iteration}: ${stepResult.stepSummary.executionContract} -> ${stepResult.stepSummary.outcome}`,
        state.runPath,
      );
      recordStateSnapshotMetric("after_session_read_only_step");
      continue;
    }

    if (routingControlAction || preRunGitContextAction) {
      if ((routingControlAction || preRunGitContextReadAction) && !sessionRunHandle?.runId) {
        const ensuredSessionRun = await ensureSessionRun(
          routingControlAction
            ? "routing_tool_action"
            : "git_context_read_action",
        );
        syncHarnessContext(state, deps, inputHandle);
        if (deps.toolWorkingSetManager) {
          deps.toolWorkingSetManager.prepareForDecision(state, {
            ...toolContext,
            runId: ensuredSessionRun.runId,
          }, {
            workRunHandle,
            sessionRunHandle: ensuredSessionRun,
          });
        }
      }
      const routingRunId = sessionRunHandle?.runId ?? decisionScopeId(inputHandle);
      const routingToolContext = { ...toolContext, runId: routingRunId };
      const routingAttemptBlock = routingControlAction
        ? validateRoutingAttemptLimits(state, decision.action, Boolean(workRunHandle || state.runId))
        : undefined;
      if (routingAttemptBlock) {
        recordFeedback(deps, inputHandle, routingRunId, "guard", "routing_attempt_blocked", {
          iteration: state.iteration,
          reason: routingAttemptBlock.reason,
          tools: routingAttemptBlock.tools,
          routing: summarizeRoutingAttempts(state.routingAttempts),
        });
      }
      recordFeedback(deps, inputHandle, undefined, "action", "started", {
        iteration: state.iteration,
        mode: decision.action.mode,
        action: summarizeAgentAction(decision.action),
        plannedCallCount: decision.action.calls.length,
        calls: decision.action.calls.map((call) => ({
          id: call.id,
          tool: call.tool,
          input: summarizeActionInput(call.input),
          dependsOn: call.dependsOn,
          purpose: call.purpose,
        })),
        allowedTools: decision.action.allowedTools,
        pendingRouting: routingControlAction,
        freshSessionRouting,
        preRunGitContextAction,
        preRunGitContextReadAction,
        preRunGitContextRoutingAction,
      });
      const stepResult = await executePendingRoutingAction({
        deps,
        state,
        config,
        selectedTools,
        decision,
        stepNumber: state.iteration,
        toolContext: routingToolContext,
        readOnlySessionAction: sessionReadOnlyAction,
        applyToolStateUpdates,
      });
      lastVerificationPassed = stepResult.execution.verifyOutput.passed;
      if (!stepResult.execution.verifyOutput.passed) {
        failedVerificationCount++;
      }
      recordActionFeedback(deps, inputHandle, routingRunId, decision.action, stepResult);
      updateRoutingAttemptsFromActOutput(state, stepResult.execution.actOutput, {
        blocked: Boolean(routingAttemptBlock),
      });
      recordRoutingAttemptFeedback(deps, inputHandle, routingRunId, state, stepResult.execution.actOutput, {
        blocked: Boolean(routingAttemptBlock),
      });
      if (!routingControlAction) {
        actionStepCount++;
        totalToolCalls += stepResult.stepSummary.toolSuccessCount + stepResult.stepSummary.toolFailureCount;
        recordStepFeedback(deps, inputHandle, routingRunId, state.iteration, stepResult);

        const beforeWorkStateChars = measureJson(stepResult.execution.nextWorkState);
        const compactedWorkState = compactWorkState(stepResult.execution.nextWorkState);
        recordCompactionMetric(metrics, "workState", beforeWorkStateChars, measureJson(compactedWorkState), { step: state.iteration });
        state.workState = compactedWorkState;
        state.toolContext = buildUpdatedToolContext(state, stepResult.execution);
        stepResult.stepSummary.workState = compactedWorkState;
        recordReducerFeedback(deps, inputHandle, routingRunId, state.iteration, {
          beforeWorkStateChars,
          compactedWorkState,
          stepSummary: stepResult.stepSummary,
        });

        const compactedStep = compactStepSummaryForState(stepResult.stepSummary);
        recordCompactionMetric(metrics, "completedStepSummary", measureJson(stepResult.stepSummary), measureJson(compactedStep), { step: state.iteration });
        state.completedSteps.push(compactedStep);
      }

      const routingUpdate = extractTurnRoutingUpdate(stepResult.execution.actOutput.toolCalls);
      let routedRunHandle: MemoryRunHandle | undefined;
      if (routingUpdate?.status === "ready") {
        routedRunHandle = {
          sessionId: routingUpdate.sessionId,
          runId: routingUpdate.runId,
          triggerSeq: inputHandle.seq,
        };
        workRunHandle = routedRunHandle;
        deps.runHandle = routedRunHandle;
        deps.onWorkRunCreated?.(routedRunHandle);
        state.runId = routedRunHandle.runId;
        state.runClass = "task";
        deps.harnessContext = routingUpdate.harnessContext;
        syncHarnessContext(state, deps, inputHandle);
        if ((state.attachedDocuments ?? []).some((document) => document.kind !== "image")) {
          await prepareAttachmentsForRun(deps, state, routedRunHandle.runId);
          syncHarnessContext(state, deps, inputHandle);
        }
        recordFeedback(deps, inputHandle, routedRunHandle.runId, "run", "created", {
          reason: "git_context_turn_routed",
          taskId: routingUpdate.taskId,
          branch: routingUpdate.branch,
        });
        recordFeedback(deps, inputHandle, routedRunHandle.runId, "context_engine", "agent_routed", {
          status: routingUpdate.status,
          mode: routingUpdate.mode,
          taskId: routingUpdate.taskId,
          branch: routingUpdate.branch,
          runId: routingUpdate.runId,
          contextEngine: buildContextEngineFeedbackSummary({
            context: routingUpdate.harnessContext.contextEngine,
            routeStatus: routingUpdate.status,
            routeMode: routingUpdate.mode,
            routeSource: "agent_tool",
            pendingTurnStatus: "bound",
            taskId: routingUpdate.taskId,
            branch: routingUpdate.branch,
            runId: routingUpdate.runId,
          }),
        });
      } else if (routingUpdate?.status === "ambiguous") {
        deps.harnessContext = routingUpdate.harnessContext;
        syncHarnessContext(state, deps, inputHandle);
        recordFeedback(deps, inputHandle, routingRunId, "context_engine", "clarification_requested", {
          status: routingUpdate.status,
          contextEngine: buildContextEngineFeedbackSummary({
            context: routingUpdate.harnessContext.contextEngine,
            routeStatus: routingUpdate.status,
            routeSource: "agent_tool",
            pendingTurnStatus: "clarifying",
          }),
        });
      }

      if (stepResult.stepSummary.outcome === "failed") {
        state.consecutiveFailures++;
        state.failureHistory.push(createFailureRecordFromStepSummary(stepResult.stepSummary, state.failureHistory));
        if (hasRepeatedRepairFailure(state.failureHistory)) {
          recordRepeatedRepairFailure({
            deps,
            inputHandle,
            state,
            runId: routingRunId,
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

      recordStateSnapshotMetric("after_pending_routing_step");
      if (!routingControlAction) {
        const nonRoutingStepStartedAt = new Date().toISOString();
        const nonRoutingStepCompletedAt = nonRoutingStepStartedAt;
        if (state.runClass === "task") {
          const persistedContext = await recordTaskStep(deps, state, decision.action, stepResult, {
            startedAt: nonRoutingStepStartedAt,
            completedAt: nonRoutingStepCompletedAt,
          });
          applyPersistedStepContext(deps, state, inputHandle, persistedContext);
        } else {
          const persistedContext = await recordSessionStep(deps, sessionRunHandle, decision.action, stepResult, {
            startedAt: nonRoutingStepStartedAt,
            completedAt: nonRoutingStepCompletedAt,
          });
          applyPersistedStepContext(deps, state, inputHandle, persistedContext);
        }
        deps.onProgress?.(
          `Step ${state.iteration}: ${stepResult.stepSummary.executionContract} -> ${stepResult.stepSummary.outcome}`,
          state.runPath,
        );
      }
      if (routedRunHandle && state.deferredMutation) {
        const deferred = state.deferredMutation;
        state.deferredMutation = undefined;
        recordFeedback(deps, inputHandle, routedRunHandle.runId, "guard", "deferred_mutation_resuming", {
          iteration: state.iteration,
          deferredAtIteration: deferred.deferredAtIteration,
          deferredTools: deferred.blockedTools,
          action: summarizeAgentAction(deferred.action),
        });
        const replayDecision: Extract<AgentDecision, { kind: "act" }> = {
          kind: "act",
          action: deferred.action,
        };
        recordFeedback(deps, inputHandle, routedRunHandle.runId, "action", "started", {
          iteration: state.iteration,
          mode: replayDecision.action.mode,
          action: summarizeAgentAction(replayDecision.action),
          plannedCallCount: replayDecision.action.calls.length,
          calls: replayDecision.action.calls.map((call) => ({
            id: call.id,
            tool: call.tool,
            input: summarizeActionInput(call.input),
            dependsOn: call.dependsOn,
            purpose: call.purpose,
          })),
          allowedTools: replayDecision.action.allowedTools,
          deferredMutationReplay: true,
        });
        const replayStartedAt = new Date().toISOString();
        const replayResult = await executeActionStep({
          deps,
          state,
          config,
          metrics,
          selectedTools: deferred.selectedTools,
          decision: replayDecision,
          stepNumber: state.iteration,
        });
        const replayCompletedAt = new Date().toISOString();
        actionStepCount++;
        lastVerificationPassed = replayResult.execution.verifyOutput.passed;
        if (!replayResult.execution.verifyOutput.passed) {
          failedVerificationCount++;
        }
        totalToolCalls += replayResult.stepSummary.toolSuccessCount + replayResult.stepSummary.toolFailureCount;
        state.readProgress = updateReadProgressAfterActOutput(state.readProgress, replayResult.execution.actOutput);
        recordActionFeedback(deps, inputHandle, routedRunHandle.runId, replayDecision.action, replayResult);
        recordStepFeedback(deps, inputHandle, routedRunHandle.runId, state.iteration, replayResult);

        const beforeReplayWorkStateChars = measureJson(replayResult.execution.nextWorkState);
        const compactedReplayWorkState = compactWorkState(replayResult.execution.nextWorkState);
        recordCompactionMetric(metrics, "workState", beforeReplayWorkStateChars, measureJson(compactedReplayWorkState), { step: state.iteration });
        state.workState = compactedReplayWorkState;
        state.toolContext = buildUpdatedToolContext(state, replayResult.execution);
        replayResult.stepSummary.workState = compactedReplayWorkState;
        recordReducerFeedback(deps, inputHandle, routedRunHandle.runId, state.iteration, {
          beforeWorkStateChars: beforeReplayWorkStateChars,
          compactedWorkState: compactedReplayWorkState,
          stepSummary: replayResult.stepSummary,
        });

        const compactedReplayStep = compactStepSummaryForState(replayResult.stepSummary);
        recordCompactionMetric(metrics, "completedStepSummary", measureJson(replayResult.stepSummary), measureJson(compactedReplayStep), { step: state.iteration });
        state.completedSteps.push(compactedReplayStep);
        const persistedContext = await recordTaskStep(deps, state, replayDecision.action, replayResult, {
          startedAt: replayStartedAt,
          completedAt: replayCompletedAt,
        });
        applyPersistedStepContext(deps, state, inputHandle, persistedContext);

        recordPlanModeMetric(metrics, replayDecision.action.mode, {
          step: state.iteration,
          tools: replayDecision.action.calls.map((call) => call.tool).join(","),
        });
        recordVerificationMetric(metrics, replayResult.stepSummary.verificationMethod, {
          step: state.iteration,
          executionStatus: replayResult.stepSummary.executionStatus,
          validationStatus: replayResult.stepSummary.validationStatus,
        });
        deps.skillActivationManager?.cleanupAfterStep(replayResult.stepSummary.toolsUsed ?? [], {
          clientId: deps.clientId,
          runId: routedRunHandle.runId,
          sessionId: inputHandle.sessionId,
          stepNumber: state.iteration,
          ...(deps.uiContext ? { uiContext: deps.uiContext } : {}),
        });
        if (deps.toolWorkingSetManager) {
          const cleanupContext = {
            clientId: deps.clientId,
            runId: routedRunHandle.runId,
            sessionId: inputHandle.sessionId,
            stepNumber: state.iteration,
            ...(deps.uiContext ? { uiContext: deps.uiContext } : {}),
          };
          state.lastToolLoad = deps.toolWorkingSetManager.afterExecution(replayResult.execution.actOutput.toolCalls, cleanupContext);
          deps.toolWorkingSetManager.cleanupAfterStep(cleanupContext);
          recordFeedback(deps, inputHandle, routedRunHandle.runId, "tools", "after_execution", {
            iteration: state.iteration,
            result: summarizeToolLoadResult(state.lastToolLoad),
            activeTools: deps.toolWorkingSetManager.listActive(cleanupContext),
          });
        }

        if (replayResult.stepSummary.outcome === "failed") {
          state.consecutiveFailures++;
          state.failureHistory.push(createFailureRecordFromStepSummary(replayResult.stepSummary, state.failureHistory));
          if (hasRepeatedRepairFailure(state.failureHistory) || hasRepeatedToolInputValidationFailure(state.failureHistory)) {
            recordRepeatedRepairFailure({
              deps,
              inputHandle,
              state,
              runId: routedRunHandle.runId,
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

        recordStateSnapshotMetric("after_deferred_mutation_replay");
        deps.onProgress?.(
          `Step ${state.iteration}: ${replayResult.stepSummary.executionContract} -> ${replayResult.stepSummary.outcome}`,
          state.runPath,
        );

      }
      continue;
    }

    const work = await ensureWorkRun("agent_action", decision);
    const workToolContext = { ...toolContext, runId: work.runHandle.runId };
    let workDeterministicToolLoad: ToolLoadResult | undefined;
    if (deps.toolWorkingSetManager) {
      workDeterministicToolLoad = deps.toolWorkingSetManager.prepareForDecision(state, workToolContext);
    } else {
      await deps.skillActivationManager?.prepareForDecision(state, workToolContext);
    }
    recordFeedback(deps, inputHandle, work.runHandle.runId, "tools", "working_set_refreshed_for_action", {
      iteration: state.iteration,
      toolContextRunId: workToolContext.runId,
      deterministicLoad: summarizeToolLoadResult(workDeterministicToolLoad),
      activeTools: deps.toolWorkingSetManager?.listActive(workToolContext),
    });
    const activeToolsForWorkRun = deps.toolWorkingSetManager?.listActive(workToolContext) ?? [];
    const routingToolsForWorkRun = activeToolsForWorkRun.filter(isGitContextRoutingToolName);
    recordFeedback(deps, inputHandle, work.runHandle.runId, "tools", "normal_tools_enabled_for_work_run", {
      iteration: state.iteration,
      toolContextRunId: workToolContext.runId,
      workRunId: work.runHandle.runId,
      activeTools: activeToolsForWorkRun,
      normalTools: activeToolsForWorkRun.filter((tool) => !isGitContextRoutingToolName(tool)),
      routingTools: routingToolsForWorkRun,
    });
    const completedRoutingTools = latestCompletedTaskRoutingToolNames(state);
    if (completedRoutingTools.length > 0 && routingToolsForWorkRun.length === 0) {
      recordFeedback(deps, inputHandle, work.runHandle.runId, "tools", "routing_tools_deactivated", {
        iteration: state.iteration,
        workRunId: work.runHandle.runId,
        completedRoutingTools,
        activeTools: activeToolsForWorkRun,
      });
    }
    const readProgressViolation = evaluateReadProgressGuard(state.readProgress, decision.action);
    if (readProgressViolation) {
      recordReadProgressRepair({
        deps,
        inputHandle,
        state,
        config,
        decision,
        runId: work.runHandle.runId,
        violation: readProgressViolation,
      });
      if (hasRepeatedRepairFailure(state.failureHistory)) {
        recordRepeatedRepairFailure({
          deps,
          inputHandle,
          state,
          runId: work.runHandle.runId,
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
    recordFeedback(deps, inputHandle, work.runHandle.runId, "action", "started", {
      iteration: state.iteration,
      mode: decision.action.mode,
      action: summarizeAgentAction(decision.action),
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
    const stepStartedAt = new Date().toISOString();
    const stepResult = await executeActionStep({
      deps,
      state,
      config,
      metrics,
      selectedTools,
      decision,
      stepNumber: state.iteration,
    });
    const stepCompletedAt = new Date().toISOString();
    actionStepCount++;
    lastVerificationPassed = stepResult.execution.verifyOutput.passed;
    if (!stepResult.execution.verifyOutput.passed) {
      failedVerificationCount++;
    }
    totalToolCalls += stepResult.stepSummary.toolSuccessCount + stepResult.stepSummary.toolFailureCount;
    state.readProgress = updateReadProgressAfterActOutput(state.readProgress, stepResult.execution.actOutput);
    recordActionFeedback(deps, inputHandle, work.runHandle.runId, decision.action, stepResult);
    recordStepFeedback(deps, inputHandle, work.runHandle.runId, state.iteration, stepResult);

    const beforeWorkStateChars = measureJson(stepResult.execution.nextWorkState);
    const compactedWorkState = compactWorkState(stepResult.execution.nextWorkState);
    recordCompactionMetric(metrics, "workState", beforeWorkStateChars, measureJson(compactedWorkState), { step: state.iteration });
    state.workState = compactedWorkState;
    state.toolContext = buildUpdatedToolContext(state, stepResult.execution);
    stepResult.stepSummary.workState = compactedWorkState;
    recordReducerFeedback(deps, inputHandle, work.runHandle.runId, state.iteration, {
      beforeWorkStateChars,
      compactedWorkState,
      stepSummary: stepResult.stepSummary,
    });

    const compactedStep = compactStepSummaryForState(stepResult.stepSummary);
    recordCompactionMetric(metrics, "completedStepSummary", measureJson(stepResult.stepSummary), measureJson(compactedStep), { step: state.iteration });
    state.completedSteps.push(compactedStep);
    const persistedContext = await recordTaskStep(deps, state, decision.action, stepResult, {
      startedAt: stepStartedAt,
      completedAt: stepCompletedAt,
    });
    applyPersistedStepContext(deps, state, inputHandle, persistedContext);

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
      recordFeedback(deps, inputHandle, work.runHandle.runId, "tools", "after_execution", {
        iteration: state.iteration,
        result: summarizeToolLoadResult(state.lastToolLoad),
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
          runId: work.runHandle.runId,
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
      `Step ${state.iteration}: ${stepResult.stepSummary.executionContract} -> ${stepResult.stepSummary.outcome}`,
      state.runPath,
    );

  }

  if (state.runClass === "task") {
    state.runLimitReached = true;
    if (state.workState.status !== "done") {
      state.iteration++;
      syncHarnessContext(state, deps, inputHandle);
      const completionStateView = buildAgentStateView(state, {
        activeTools: [],
        workRunHandle,
        sessionRunHandle,
      });
      let completionDecision: AgentDecision | undefined;
      try {
        completionDecision = await callAgentDecision({
          provider: deps.provider,
          stateView: completionStateView,
          toolDefinitions: [],
          toolLoadingAvailable: false,
          taskFeedbackToolAvailable: false,
          taskCompletionAvailable: true,
          toolContextProjectionPolicy: config.toolContextProjectionPolicy,
          timelineCheckpointCache: state.timelineCheckpointCache,
          systemContext: [
            deps.systemContext,
            `Run-limit completion-only mode: the ${config.maxIterations} normal work steps are exhausted. Call task_completion exactly once using the latest verified WorkState, tool-call evidence, and created file/directory assets. Executable tools and direct final replies are unavailable in this phase.`,
          ].filter((section): section is string => Boolean(section?.trim())).join("\n\n"),
          metrics,
          feedbackLedger: deps.feedbackLedger,
          feedbackContext: {
            clientId: deps.clientId,
            sessionId: inputHandle.sessionId,
            seq: inputHandle.seq,
            ...(state.runId || workRunHandle?.runId ? { runId: state.runId || workRunHandle?.runId } : {}),
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
        if (!(error instanceof ContextRunCapacityError || error instanceof ContextInputLimitError)) throw error;
        state.contextLimitReached = true;
      }

      if (completionDecision?.kind === "task_completion") {
        const evaluation = await evaluateTaskCompletion(state, completionDecision.request);
        state.workState = compactWorkState(evaluation.nextWorkState);
        recordFeedback(deps, inputHandle, state.runId || workRunHandle?.runId, "task_completion", evaluation.accepted ? "run_limit_accepted" : "run_limit_rejected", {
          iteration: state.iteration,
          trigger: "run_limit",
          request: completionDecision.request,
          code: evaluation.code,
          ...(evaluation.accepted
            ? { verifiedAssets: evaluation.assets }
            : { failures: evaluation.failures }),
          workState: summarizeWorkState(state.workState),
        });
        if (evaluation.accepted) {
          state.completionAssets = evaluation.assets;
          recordRunMetric(metrics, "verified_completion", { kind: "local" });
        }
      } else {
        const reason = "The run-limit completion phase did not produce the required task_completion request.";
        state.workState = compactWorkState({
          ...state.workState,
          status: "not_done",
          summary: reason,
          openWork: normalizeList([
            ...(state.workState.openWork ?? []),
            "Continue the requested task from the latest verified state.",
          ]),
          nextStep: state.workState.nextStep || "Continue the requested task from the latest verified state.",
        });
        recordFeedback(deps, inputHandle, state.runId || workRunHandle?.runId, "task_completion", "run_limit_missing", {
          iteration: state.iteration,
          trigger: "run_limit",
          receivedDecisionKind: completionDecision?.kind,
          reason,
          workState: summarizeWorkState(state.workState),
        });
      }
    }

    state.iteration++;
    state.status = state.workState.status === "done" ? "completed" : "stuck";
    state.finalOutput = await buildFinalResponseFromWorkState({
      deps,
      state,
      metrics,
      inputHandle,
      workRunHandle,
      config,
    });
    const responseKind = state.workState.status === "needs_user_input"
      ? "feedback"
      : state.preferredResponseKind ?? "reply";
    return finalize({
      status: state.status,
      content: state.finalOutput,
      responseKind,
      completion: {
        done: true,
        summary: state.finalOutput,
        status: state.workState.status === "done" ? "completed" : "failed",
        response_kind: responseKind,
        ...(state.workState.status === "needs_user_input" ? { feedback_kind: "clarification" } : {}),
      },
    });
  }

  state.status = "stuck";
  state.workState = compactWorkState({
    ...state.workState,
    status: state.workState.status === "done" ? "done" : "not_done",
    openWork: normalizeList(state.workState.openWork).length > 0
      ? state.workState.openWork
      : ["Continue the requested task from the latest verified state."],
    nextStep: state.workState.nextStep || "Continue the requested task from the latest verified state.",
  });
  state.finalOutput = `I reached the ${config.maxIterations}-step limit before finishing the task.`;
  return finalize({ status: "stuck", content: state.finalOutput });
}

function isPreRunGitContextAction(
  decision: AgentDecision,
  workRunHandle: MemoryRunHandle | undefined,
): boolean {
  return decision.kind === "act"
    && !workRunHandle
    && decision.action.calls.length > 0
    && decision.action.calls.every((call) => isGitContextAllowedDuringPendingRouting(call.tool));
}

function isPreRunGitContextReadAction(
  decision: AgentDecision,
  workRunHandle: MemoryRunHandle | undefined,
): boolean {
  return decision.kind === "act"
    && !workRunHandle
    && decision.action.calls.length > 0
    && decision.action.calls.every((call) => isGitContextReadOnlyToolName(call.tool));
}

function isPreRunGitContextRoutingAction(
  decision: AgentDecision,
  workRunHandle: MemoryRunHandle | undefined,
): boolean {
  return decision.kind === "act"
    && !workRunHandle
    && decision.action.calls.length > 0
    && decision.action.calls.every((call) => isGitContextTurnRoutingToolName(call.tool));
}

function isSessionReadOnlyAction(
  decision: AgentDecision,
  workRunHandle: MemoryRunHandle | undefined,
): boolean {
  return decision.kind === "act"
    && !workRunHandle
    && decision.action.calls.length > 0
    && decision.action.calls.every((call) => isReadOnlyTool(call.tool));
}

function buildCreateWorkRunRequest(state: LoopState, reason: string) {
  return {
    reason,
    userMessage: state.userMessage,
  };
}

function normalizeCreatedWorkRun(created: CreatedWorkRun | MemoryRunHandle): CreatedWorkRun {
  if ("runHandle" in created) {
    return created;
  }
  return { runHandle: created };
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

async function buildFinalResponseFromWorkState(input: {
  deps: AgentLoopDeps;
  state: LoopState;
  metrics: ReturnType<typeof createRunMetrics>;
  inputHandle: SessionInputHandle;
  workRunHandle: MemoryRunHandle | undefined;
  config: LoopConfig;
}): Promise<string> {
  const stateView = buildAgentStateView(input.state, {
    activeTools: [],
  });
  const finalResponseKind = input.state.workState.status === "needs_user_input"
    ? "feedback"
    : input.state.preferredResponseKind === "notification"
      ? "notification"
      : "reply";
  const streamFinalResponse = Boolean(
    input.deps.onFinalResponseStream
      && input.deps.provider.capabilities.streaming === true
      && input.deps.provider.streamTurn,
  );
  if (streamFinalResponse) {
    input.deps.onFinalResponseStream?.({
      type: "start",
      kind: finalResponseKind,
    });
  }
  let decision: AgentDecision | undefined;
  try {
    decision = await callAgentDecision({
      provider: input.deps.provider,
      stateView,
      toolDefinitions: [],
      toolLoadingAvailable: false,
      taskFeedbackToolAvailable: false,
      toolContextProjectionPolicy: input.config.toolContextProjectionPolicy,
      timelineCheckpointCache: input.state.timelineCheckpointCache,
      systemContext: [
        input.deps.systemContext,
        "Final response-only mode: tools are unavailable. Reply naturally to the user from context.run.workState, verified facts, artifacts, and recent tool-call memory. Do not mention harness internals. Do not say control tool names such as task_completion, decision_load_tools, or ask_user_feedback.",
      ].filter((section): section is string => Boolean(section?.trim())).join("\n\n"),
      metrics: input.metrics,
      feedbackLedger: input.deps.feedbackLedger,
      feedbackContext: {
        clientId: input.deps.clientId,
        sessionId: input.inputHandle.sessionId,
        seq: input.inputHandle.seq,
        ...(input.state.runId || input.workRunHandle?.runId ? { runId: input.state.runId || input.workRunHandle?.runId } : {}),
      },
      onContextCompilation: (receipt) => {
        input.state.contextPressure = updateContextPressureState({
          current: input.state.contextPressure,
          receipt,
          iteration: input.state.iteration,
        });
      },
      ...(streamFinalResponse
        ? {
            onAssistantTextDelta: (delta: string) => {
              input.deps.onFinalResponseStream?.({
                type: "delta",
                delta,
              });
            },
          }
        : {}),
    });
  } catch (error) {
    if (!(error instanceof ContextRunCapacityError || error instanceof ContextInputLimitError)) throw error;
    recordFeedback(input.deps, input.inputHandle, input.state.runId || input.workRunHandle?.runId, "guard", "final_response_context_limit", {
      iteration: input.state.iteration,
      finalInputTokens: error.receipt.finalInputTokens,
      softInputTokens: error.receipt.softInputTokens,
      mode: error.receipt.mode,
    });
  }
  if (decision?.kind === "reply" && decision.status === "completed" && decision.message.trim().length > 0) {
    if (!isUsableFinalResponseMessage(decision.message)) {
      recordFeedback(input.deps, input.inputHandle, input.state.runId || input.workRunHandle?.runId, "decision", "final_response_rejected", {
        reason: "control_or_action_payload_in_final_response",
        messagePreview: decision.message.slice(0, 160),
      });
    } else {
      return decision.message;
    }
  }
  if (input.state.workState.status === "needs_user_input" && input.state.workState.userInputNeeded?.trim()) {
    return input.state.workState.userInputNeeded.trim();
  }
  if (input.state.workState.status === "blocked") {
    return buildBlockedWorkStateReply(input.state);
  }
  return buildVerifiedCompletionReply(input.state);
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
  context: Awaited<ReturnType<typeof recordTaskStep>>,
): void {
  if (!context) return;
  deps.harnessContext = {
    ...deps.harnessContext,
    ...context,
  };
  syncHarnessContext(state, deps, inputHandle);
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
    harnessContext: state.harnessContext,
  };

  if (state.runClass === "task") {
    result.taskSummary = buildTaskSummaryRecord(state, content, input.status, responseKind, input.completion);
    result.taskAssets = buildTaskAssets(state);
    result.verifiedCompletionAssets = buildVerifiedCompletionAssets(state);
  }

  return result;
}

function isTaskFeedbackToolAvailable(
  state: LoopState,
  workRunHandle: MemoryRunHandle | undefined,
): boolean {
  const hasTaskRun = Boolean(state.runId || workRunHandle?.runId);
  if (!hasTaskRun) {
    return false;
  }
  return state.workState.status === "not_done";
}

function normalizeList(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter((value) => value.length > 0))];
}

function preserveWorkStateForContextLimit(state: LoopState): WorkState {
  const task = state.harnessContext.contextEngine?.task;
  const openWork = normalizeList(state.workState.openWork);
  const taskOpenWork = normalizeList(task?.open);
  const blockers = normalizeList(state.workState.blockers);
  const verifiedFacts = normalizeList(state.workState.verifiedFacts);
  return compactWorkState({
    ...state.workState,
    status: "not_done",
    summary: state.workState.summary || "The task remains in progress.",
    openWork: openWork.length > 0
      ? openWork
      : taskOpenWork.length > 0
        ? taskOpenWork
        : ["Continue the requested task in a new run."],
    blockers: blockers.length > 0 ? blockers : task?.blockers ?? [],
    verifiedFacts: verifiedFacts.length > 0
      ? verifiedFacts
      : normalizeList(task?.facts.map((fact) => fact.text)),
    nextStep: state.workState.nextStep || task?.next || "Continue the requested task in a new run.",
  });
}
