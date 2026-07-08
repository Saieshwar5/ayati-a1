import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { devLog } from "../../shared/index.js";
import { prepareIncomingAttachments } from "../../documents/attachment-preparer.js";
import type { PreparedAttachmentRecord } from "../../documents/prepared-attachment-registry.js";
import type { PreparedAttachmentSummary } from "../../documents/types.js";
import type { MemoryRunHandle, RunRecorder, SessionInputHandle } from "../../memory/types.js";
import type { TaskAssetRecord } from "../../context-engine/index.js";
import type {
  ActOutput,
  ActToolCallRecord,
  AgentLoopDeps,
  AgentLoopResult,
  AgentTaskSummaryRecord,
  CreatedWorkRun,
  CompletionDirective,
  FailureRecord,
  LoopConfig,
  LoopState,
  PromptToolCallContext,
  StepSummary,
  TaskSummaryFailureSummary,
  ToolObservation,
  WorkState,
} from "../types.js";
import {
  DEFAULT_LOOP_CONFIG,
} from "../types.js";
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
  compactToolContext,
  compactWorkState,
  measureJson,
} from "../state-compaction.js";
import {
  applyHarnessContextToState,
  buildHarnessContextFromSources,
  createInitialHarnessContext,
  type HarnessContextInput,
} from "../harness-context.js";
import { buildAgentStateView, type AgentStateView } from "./state-view.js";
import { selectToolsForDecision } from "./tool-selector.js";
import { callAgentDecision } from "./decision.js";
import type { AgentAction, AgentDecision, AgentWorkStateUpdate } from "./decision.js";
import type { RepairCode, RepairSignal } from "./repair-policy.js";
import {
  createRepairSignal,
  repairSignalToFeedbackData,
  repairSignalToPromptCard,
} from "./repair-policy.js";
import {
  evaluateReadProgressGuard,
  markReadProgressRejected,
  updateReadProgressAfterActOutput,
} from "./read-progress-policy.js";
import type { ReadProgressViolation } from "./read-progress-policy.js";
import type { ToolLoadResult } from "./tool-working-set.js";
import { executeAgentAction } from "./action-executor.js";
import type { AgentActionExecutionResult } from "./action-executor.js";
import {
  buildStepSummary,
  recordSessionStep,
  recordTaskStep,
  type ExecuteActionStepResult,
} from "./step-lifecycle.js";
import { planLocalRecovery } from "./failure-policy.js";
import { deriveExecutionStatus } from "../verification-gates.js";
import { buildContextEngineFeedbackSummary } from "../feedback-ledger.js";
import type { ToolDefinition, ToolResult } from "../../skills/types.js";
import { isReadOnlyTool } from "../../skills/tool-taxonomy.js";
import {
  isGitContextAllowedDuringPendingRouting,
  isGitContextReadOnlyToolName,
  isGitContextTurnRoutingToolName,
} from "../../skills/builtins/git-context/tool-policy.js";
import {
  createRoutingAttemptState as emptyRoutingAttemptState,
  deferredMutationToolNames,
  mutationTargetPathsForAction,
  readRoutingToolStatus,
  shouldAutoBindActiveTaskArtifactMutation,
  shouldDeferPreTaskMutation,
  stepUsesFileMutationTool,
  summarizeRoutingAttempts,
  updateRoutingAttemptsFromActOutput,
  validateRoutingAttemptLimits,
} from "./task-routing-policy.js";
import {
  detectRuntimeCapabilityMode,
  isDecisionAllowedInRuntimeMode,
  isFreshSessionRoutingMode,
  isGitContextRoutingToolName,
  summarizeRuntimeCapabilityTools,
} from "./runtime-capability-mode.js";
import {
  summarizeAgentAction,
  summarizeDecision,
  summarizeHarnessContext,
  summarizeStep,
  summarizeToolDefinitions,
  summarizeToolLoadResult,
  summarizeVerification,
  summarizeWorkState,
} from "./feedback-summary.js";
import { auditToolPolicy } from "./tool-policy-audit.js";

interface MemoryRunContext {
  runHandle: MemoryRunHandle;
}

const FRESH_SESSION_TOOL_REPAIR_MESSAGE = "No active task exists. Before mutation, search and activate an existing task or create a new task. Ask a short clarification directly if task ownership is unclear.";
const REPEATED_REPAIR_FAILURE_THRESHOLD = 3;

const noopRunRecorder: RunRecorder = {
  recordToolCall(): void {
    return;
  },
  recordToolResult(): void {
    return;
  },
  recordAssistantFinal(): void {
    return;
  },
  recordRunFailure(): void {
    return;
  },
  recordAgentStep(): void {
    return;
  },
};

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
    const decisionToolPolicyAudit = auditToolPolicy({
      mode: decisionRuntimeMode,
      selectedTools,
    });
    recordFeedback(deps, inputHandle, state.runId || workRunHandle?.runId || sessionRunHandle?.runId, "decision", "prompt_summary", {
      iteration: state.iteration,
      nativeControlTools: [
        ...(decisionRuntimeMode.allowToolLoading ? ["decision_load_tools"] : []),
        ...(isWorkStateUpdateToolAvailable(state, workRunHandle) ? ["update_work_state"] : []),
        ...(taskFeedbackToolAvailable ? ["ask_user_feedback"] : []),
      ],
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
      finalReplyFromWorkState,
      contextEngine: buildContextEngineFeedbackSummary({
        context: state.harnessContext.contextEngine,
      }),
      warningCodes: buildToolExposureWarningCodes(state, selectedTools, workRunHandle, sessionRunHandle),
      toolPolicyAudit: decisionToolPolicyAudit,
      inputState: summarizeDecisionInputState(stateView),
    });
    const decision = await callAgentDecision({
      provider: deps.provider,
      stateView,
      toolDefinitions: selectedTools,
      toolRoutingSummary: deps.toolWorkingSetManager?.getPromptSummary(),
      toolLoadingAvailable: decisionRuntimeMode.allowToolLoading,
      taskFeedbackToolAvailable,
      workStateUpdateAvailable: isWorkStateUpdateToolAvailable(state, workRunHandle),
      systemContext: deps.systemContext,
      metrics,
      feedbackLedger: deps.feedbackLedger,
      feedbackContext: {
        clientId: deps.clientId,
        sessionId: inputHandle.sessionId,
        seq: inputHandle.seq,
        ...(state.runId || workRunHandle?.runId || sessionRunHandle?.runId ? { runId: state.runId || workRunHandle?.runId || sessionRunHandle?.runId } : {}),
      },
    });
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
      } else if (decision.status === "completed" && canMarkTerminalReplyDone(state)) {
        state.workState = {
          ...state.workState,
          status: "done",
          summary: state.runClass === "session" ? decision.message : state.workState.summary || decision.message,
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

    if (decision.kind === "update_work_state") {
      const updateResult = applyAgentWorkStateUpdate(state, decision.update);
      const rejectionReason = updateResult.accepted ? undefined : updateResult.reason;
      recordFeedback(deps, inputHandle, state.runId || workRunHandle?.runId || sessionRunHandle?.runId, "work_state", updateResult.accepted ? "updated" : "rejected", {
        iteration: state.iteration,
        update: decision.update,
        workState: summarizeWorkState(state.workState),
        ...(rejectionReason ? { reason: rejectionReason } : {}),
      });
      if (!updateResult.accepted) {
        state.consecutiveFailures++;
        state.failureHistory.push(createFailureRecordFromWorkStateUpdate(state.iteration, updateResult.reason));
        if (hasRepeatedRepairFailure(state.failureHistory) || state.consecutiveFailures >= config.maxConsecutiveFailures) {
          state.status = "failed";
          state.finalOutput = buildFailureReply(state);
          return finalize({ status: "failed", content: state.finalOutput });
        }
      } else {
        state.consecutiveFailures = 0;
      }
      recordStateSnapshotMetric("after_work_state_update");
      continue;
    }

    const runtimeMode = detectRuntimeCapabilityMode({ state, workRunHandle, sessionRunHandle });
    const freshSessionWithoutActiveTask = isFreshSessionRoutingMode(runtimeMode);

    const autoBindActiveTaskArtifactMutation = shouldAutoBindActiveTaskArtifactMutation(state, decision);
    if (shouldDeferPreTaskMutation(state, decision, workRunHandle) && !autoBindActiveTaskArtifactMutation) {
      if (decision.kind !== "act") {
        continue;
      }
      if (!sessionRunHandle?.runId) {
        await ensureSessionRun("mutation_deferred_for_task_routing");
        syncHarnessContext(state, deps, inputHandle);
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
    if (autoBindActiveTaskArtifactMutation && decision.kind === "act") {
      recordFeedback(deps, inputHandle, sessionRunHandle?.runId, "guard", "active_task_artifact_auto_bind", {
        iteration: state.iteration,
        reason: "mutation_targets_active_task_artifacts",
        action: summarizeAgentAction(decision.action),
        mutationTargets: mutationTargetPathsForAction(decision.action),
        activeTaskId: state.harnessContext.contextEngine?.focus.status === "active"
          ? state.harnessContext.contextEngine.focus.workId
          : undefined,
        contextEngine: buildContextEngineFeedbackSummary({
          context: state.harnessContext.contextEngine,
        }),
      });
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
      recordSessionStep(deps, ensuredSessionRun, decision.action, stepResult, {
        startedAt: stepStartedAt,
        completedAt: stepCompletedAt,
      });

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
        state.failureHistory.push(createFailureRecordFromStepSummary(stepResult.stepSummary));
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
      if (canCompleteLocallyAfterAction(decision.action, stepResult.stepSummary, state.workState, state)) {
        state.workState = compactWorkState({
          ...state.workState,
          status: "done",
        });
        recordRunMetric(metrics, "verified_completion", { kind: "local" });
        recordStateSnapshotMetric("after_verified_completion");
      }
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
        state.failureHistory.push(createFailureRecordFromStepSummary(stepResult.stepSummary));
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
          recordTaskStep(deps, state, decision.action, stepResult, {
            startedAt: nonRoutingStepStartedAt,
            completedAt: nonRoutingStepCompletedAt,
          });
        } else {
          recordSessionStep(deps, sessionRunHandle, decision.action, stepResult, {
            startedAt: nonRoutingStepStartedAt,
            completedAt: nonRoutingStepCompletedAt,
          });
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
        recordTaskStep(deps, state, replayDecision.action, replayResult, {
          startedAt: replayStartedAt,
          completedAt: replayCompletedAt,
        });

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
          state.failureHistory.push(createFailureRecordFromStepSummary(replayResult.stepSummary));
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

        if (canCompleteLocallyAfterAction(replayDecision.action, replayResult.stepSummary, state.workState, state)) {
          state.workState = compactWorkState({
            ...state.workState,
            status: "done",
          });
          recordRunMetric(metrics, "verified_completion", { kind: "local" });
          recordStateSnapshotMetric("after_verified_completion");
        }
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
    recordTaskStep(deps, state, decision.action, stepResult, {
      startedAt: stepStartedAt,
      completedAt: stepCompletedAt,
    });

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
      state.failureHistory.push(createFailureRecordFromStepSummary(stepResult.stepSummary));
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

    if (canCompleteLocallyAfterAction(decision.action, stepResult.stepSummary, state.workState, state)) {
      state.workState = compactWorkState({
        ...state.workState,
        status: "done",
      });
      recordRunMetric(metrics, "verified_completion", { kind: "local" });
      recordStateSnapshotMetric("after_verified_completion");
      continue;
    }
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

interface ExecuteActionStepInput {
  deps: AgentLoopDeps;
  state: LoopState;
  config: LoopConfig;
  metrics: ReturnType<typeof createRunMetrics>;
  selectedTools: ReturnType<typeof selectToolsForDecision>;
  decision: Extract<AgentDecision, { kind: "act" }>;
  stepNumber: number;
  runHandle?: MemoryRunHandle;
  runClass?: LoopState["runClass"];
}

interface ExecutePendingRoutingActionInput {
  deps: AgentLoopDeps;
  state: LoopState;
  config: LoopConfig;
  selectedTools: ReturnType<typeof selectToolsForDecision>;
  decision: Extract<AgentDecision, { kind: "act" }>;
  stepNumber: number;
  toolContext: {
    clientId: string;
    runId: string;
    sessionId: string;
    stepNumber: number;
  };
  readOnlySessionAction?: boolean;
}

type TurnRoutingUpdate =
  | {
      status: "ready";
      sessionId: string;
      taskId: string;
      branch: string;
      mode?: string;
      runId: string;
      harnessContext: HarnessContextInput;
    }
  | {
      status: "ambiguous";
      harnessContext: HarnessContextInput;
    };

async function executePendingRoutingAction(
  input: ExecutePendingRoutingActionInput,
): Promise<ExecuteActionStepResult> {
  const validationError = validatePendingRoutingAction(input);
  const actOutput = validationError
    ? failedPendingRoutingActOutput(input.decision.action, validationError)
    : await executePendingRoutingCalls(input);
  const verifyOutput = buildPendingRoutingVerifyOutput(actOutput);
  const execution: AgentActionExecutionResult = {
    actOutput,
    verifyOutput,
    nextWorkState: input.state.workState,
  };
  await applyToolStateUpdates(input.state, input.deps, execution.actOutput.toolCalls);
  const stepSummary = buildStepSummary({
    stepNumber: input.stepNumber,
    action: input.decision.action,
    execution,
  });
  stepSummary.artifacts = stepSummary.artifacts.filter((artifact) => artifact.trim().length > 0);
  return {
    execution,
    stepSummary,
  };
}

function validatePendingRoutingAction(input: ExecutePendingRoutingActionInput): string | undefined {
  const action = input.decision.action;
  if (!input.deps.toolExecutor) {
    return "No tool executor is available for pending-turn routing.";
  }
  if (action.mode === "parallel") {
    return "Pending-turn routing cannot run tools in parallel; use single or sequential mode.";
  }
  if (action.calls.length === 0) {
    return "Pending-turn routing action contains no tool calls.";
  }
  if (action.mode === "single" && action.calls.length !== 1) {
    return `Single pending-turn routing action must contain exactly one tool call, received ${action.calls.length}.`;
  }
  if (action.calls.length > input.config.maxSequentialToolCallsPerStep) {
    return `Pending-turn routing requested ${action.calls.length} calls, above max ${input.config.maxSequentialToolCallsPerStep}.`;
  }
  const routingAttemptBlock = validateRoutingAttemptLimits(input.state, action, Boolean(input.state.runId));
  if (routingAttemptBlock) {
    return routingAttemptBlock.message;
  }
  const selected = new Set(input.selectedTools.map((tool) => tool.name));
  const allowed = new Set(action.allowedTools);
  for (const tool of action.allowedTools) {
    if (!selected.has(tool)) {
      return `Allowed tool '${tool}' was not selected for this decision.`;
    }
    if (input.readOnlySessionAction && !isReadOnlyTool(tool)) {
      return `Allowed tool '${tool}' cannot run in a session read-only action before task promotion.`;
    }
  }
  for (const call of action.calls) {
    if (!selected.has(call.tool)) {
      return `Tool '${call.tool}' was not selected for this decision.`;
    }
    if (!allowed.has(call.tool)) {
      return `Tool '${call.tool}' was not listed in action.allowedTools.`;
    }
    if (input.readOnlySessionAction) {
      if (!isReadOnlyTool(call.tool)) {
        return `Tool '${call.tool}' cannot run in a session read-only action before task promotion.`;
      }
    } else if (!isGitContextAllowedDuringPendingRouting(call.tool)) {
      return [
        `Tool '${call.tool}' cannot run while the current git-memory pending turn is unbound or clarifying.`,
        "Use git-context read/search tools and then git_context_activate_task_for_turn or git_context_create_task_for_turn before task execution. Ask the user directly if task ownership is unclear.",
      ].join(" ");
    }
    const validation = input.deps.toolExecutor.validate(call.tool, call.input, input.toolContext);
    if (!validation.valid) {
      return `Tool input preflight failed for '${call.tool}': ${validation.error}`;
    }
  }
  return undefined;
}

function recordRoutingAttemptFeedback(
  deps: AgentLoopDeps,
  inputHandle: SessionInputHandle,
  runId: string | undefined,
  state: LoopState,
  actOutput: ActOutput,
  options: {
    blocked: boolean;
  },
): void {
  const routingCalls = actOutput.toolCalls.filter((call) => isGitContextTurnRoutingToolName(call.tool));
  if (routingCalls.length === 0 && !options.blocked) {
    return;
  }
  recordFeedback(deps, inputHandle, runId, "guard", "routing_attempt_recorded", {
    blocked: options.blocked,
    calls: routingCalls.map((call) => ({
      tool: call.tool,
      status: call.error ? "failed" : readRoutingToolStatus(call) ?? "completed",
      ...(call.error ? { error: call.error } : {}),
    })),
    routing: summarizeRoutingAttempts(state.routingAttempts),
  });
  if (state.routingAttempts.resolved || state.routingAttempts.successCount > 0) {
    recordFeedback(deps, inputHandle, runId, "guard", "routing_resolved", {
      routing: summarizeRoutingAttempts(state.routingAttempts),
    });
  } else if (state.routingAttempts.failureCount >= state.routingAttempts.maxFailures) {
    recordFeedback(deps, inputHandle, runId, "guard", "routing_retry_limit_reached", {
      routing: summarizeRoutingAttempts(state.routingAttempts),
    });
  }
}

async function executePendingRoutingCalls(input: ExecutePendingRoutingActionInput): Promise<ActOutput> {
  const toolCalls: ActToolCallRecord[] = [];
  const failedCallIds = new Set<string>();
  let stoppedByFailure: string | undefined;
  for (const call of input.decision.action.calls) {
    if (stoppedByFailure) {
      const skipped = pendingRoutingToolCallRecord(call, "", `Skipped because an earlier sequential call failed: ${stoppedByFailure}`);
      failedCallIds.add(call.id);
      toolCalls.push(skipped);
      continue;
    }
    if (call.dependsOn.some((dep) => failedCallIds.has(dep))) {
      const skipped = pendingRoutingToolCallRecord(call, "", `Skipped because dependency failed: ${call.dependsOn.join(", ")}`);
      failedCallIds.add(call.id);
      toolCalls.push(skipped);
      continue;
    }
    let result: ToolResult;
    try {
      result = await input.deps.toolExecutor!.execute(call.tool, call.input, input.toolContext);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failedCallIds.add(call.id);
      stoppedByFailure = `${call.tool}: ${message}`;
      toolCalls.push(pendingRoutingToolCallRecord(call, "", message));
      continue;
    }
    const output = result.output ?? "";
    const record = pendingRoutingToolCallRecord(call, output, result.error);
    if (result.meta) {
      record.meta = result.meta;
    }
    if (result.v2) {
      record.result = result.v2;
      record.operationStatus = result.v2.operationStatus;
      record.code = result.v2.code;
      record.artifacts = result.v2.artifacts;
      record.verifiedFacts = result.v2.verification?.facts;
      record.assertionResults = result.v2.verification?.assertions;
    }
    if (record.error) {
      failedCallIds.add(call.id);
      stoppedByFailure = `${call.tool}: ${record.error}`;
    }
    toolCalls.push(record);
  }
  return { toolCalls, finalText: "" };
}

function pendingRoutingToolCallRecord(
  call: AgentAction["calls"][number],
  output: string,
  error?: string,
): ActToolCallRecord {
  return {
    callId: call.id,
    tool: call.tool,
    input: call.input,
    output,
    ...(error ? { error } : {}),
    observation: {
      id: `OBS-${call.id}`,
      step: 0,
      callId: call.id,
      tool: call.tool,
      purpose: call.purpose,
      status: error ? "failed" : "success",
      mode: "summary",
      retention: "next_step",
      content: error ? `${call.tool} failed: ${error}` : output,
      hasMore: false,
    },
  };
}

function failedPendingRoutingActOutput(action: AgentAction, error: string): ActOutput {
  return {
    toolCalls: action.calls.length > 0
      ? action.calls.map((call) => pendingRoutingToolCallRecord(call, "", error))
      : [{
        tool: "pending_turn_routing_guard",
        input: action,
        output: "",
        error,
        observation: {
          id: "OBS-pending_turn_routing_guard",
          step: 0,
          callId: "pending_turn_routing_guard",
          tool: "pending_turn_routing_guard",
          status: "failed",
          mode: "summary",
          retention: "next_step",
          content: error,
          hasMore: false,
        },
      }],
    finalText: "",
    stoppedEarlyReason: "planned_call_failed",
  };
}

function buildPendingRoutingVerifyOutput(actOutput: ActOutput): AgentActionExecutionResult["verifyOutput"] {
  const failed = actOutput.toolCalls.filter((call) => call.error);
  const passed = failed.length === 0 && actOutput.toolCalls.length > 0;
  const evidenceItems = actOutput.toolCalls.map((call) => call.error
    ? `${call.tool}: ${call.error}`
    : `${call.tool}: ${call.result?.message ?? "completed"}`);
  return {
    passed,
    method: "execution_gate",
    executionStatus: deriveExecutionStatus(actOutput),
    validationStatus: passed ? "passed" : "failed",
    summary: passed
      ? "Pending-turn routing tools executed successfully."
      : `Pending-turn routing failed: ${failed.map((call) => `${call.tool}: ${call.error}`).join(" | ")}`,
    evidenceSummary: evidenceItems.join(" "),
    evidenceItems,
    newFacts: [],
    artifacts: [],
    usedRawArtifacts: [],
  };
}

function extractTurnRoutingUpdate(calls: ActToolCallRecord[]): TurnRoutingUpdate | null {
  for (const call of [...calls].reverse()) {
    const content = call.result?.structuredContent;
    if (!content || typeof content !== "object" || Array.isArray(content)) {
      continue;
    }
    const record = content as Record<string, unknown>;
    const harnessContext = readHarnessContext(record["harnessContext"]);
    if (!harnessContext) {
      continue;
    }
    if (record["status"] === "ready") {
      const sessionId = readString(record["sessionId"]);
      const taskId = readString(record["taskId"]);
      const branch = readString(record["branch"]);
      const runId = readString(record["runId"]);
      const mode = readString(record["mode"]);
      if (sessionId && taskId && branch && runId) {
        return {
          status: "ready",
          sessionId,
          taskId,
          branch,
          ...(mode ? { mode } : {}),
          runId,
          harnessContext,
        };
      }
    }
    if (record["status"] === "ambiguous") {
      return {
        status: "ambiguous",
        harnessContext,
      };
    }
  }
  return null;
}

function readHarnessContext(value: unknown): HarnessContextInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as HarnessContextInput;
}

function recordFreshSessionToolRepair(input: {
  deps: AgentLoopDeps;
  inputHandle: SessionInputHandle;
  state: LoopState;
  config: LoopConfig;
  decision: AgentDecision;
  reason: "fresh_session_tool_load" | "fresh_session_wrong_tool";
}): void {
  input.state.consecutiveFailures++;
  const blockedTargets = freshSessionDecisionTargets(input.decision);
  const repair = createRepairSignal("R_FRESH_SESSION_NEEDS_TASK", {
    blockedTargets,
    operatorDetails: {
      reason: input.reason,
      consecutiveFailures: input.state.consecutiveFailures,
      maxConsecutiveFailures: input.config.maxConsecutiveFailures,
      decision: summarizeDecision(input.decision),
      contextEngine: buildContextEngineFeedbackSummary({
        context: input.state.harnessContext.contextEngine,
      }),
      harnessContext: summarizeHarnessContext(input.state.harnessContext),
    },
  });
  input.state.failureHistory.push({
    step: input.state.iteration,
    failureType: "validation_error",
    reason: FRESH_SESSION_TOOL_REPAIR_MESSAGE,
    blockedTargets,
    repairCode: repair.code,
    repair: repairSignalToPromptCard(repair),
  });
  recordFeedback(input.deps, input.inputHandle, undefined, "guard", "fresh_session_tool_repair_requested", {
    reason: input.reason,
    message: FRESH_SESSION_TOOL_REPAIR_MESSAGE,
    warningCodes: ["fresh_session_tool_repair_requested"],
    consecutiveFailures: input.state.consecutiveFailures,
    maxConsecutiveFailures: input.config.maxConsecutiveFailures,
    blockedTargets,
    decision: summarizeDecision(input.decision),
    contextEngine: buildContextEngineFeedbackSummary({
      context: input.state.harnessContext.contextEngine,
    }),
    harnessContext: summarizeHarnessContext(input.state.harnessContext),
    ...repairSignalToFeedbackData(repair),
  });
}

function recordDeferredMutationRoutingRepair(input: {
  deps: AgentLoopDeps;
  inputHandle: SessionInputHandle;
  state: LoopState;
  config: LoopConfig;
  decision: AgentDecision;
  reason: "deferred_mutation_reply" | "deferred_mutation_already_pending";
}): void {
  input.state.consecutiveFailures++;
  const deferredTools = input.state.deferredMutation?.blockedTools ?? [];
  const repair = createRepairSignal("R_PENDING_TURN_UNBOUND", {
    source: "runner.deferred_mutation_guard",
    message: "A mutation is already deferred and cannot execute until this session run is routed to a task.",
    blockedTargets: input.decision.kind === "act"
      ? deferredMutationToolNames(input.decision.action)
      : ["direct_reply"],
    allowedNextActions: [
      "Call git_context_activate_task_for_turn if this belongs to the active or another existing task.",
      "Call git_context_search_tasks first if another existing task may own the request.",
      "Call git_context_create_task_for_turn if this is a new durable task.",
      "After routing succeeds, the deferred mutation will execute automatically; do not repeat the mutation call.",
    ],
    operatorDetails: {
      reason: input.reason,
      deferredTools,
      consecutiveFailures: input.state.consecutiveFailures,
      maxConsecutiveFailures: input.config.maxConsecutiveFailures,
      decision: summarizeDecision(input.decision),
      contextEngine: buildContextEngineFeedbackSummary({
        context: input.state.harnessContext.contextEngine,
      }),
    },
  });
  const promptCard = repairSignalToPromptCard(repair);
  input.state.failureHistory.push({
    step: input.state.iteration,
    failureType: "validation_error",
    reason: repair.message,
    blockedTargets: repair.blockedTargets,
    repairCode: repair.code,
    ...(promptCard ? { repair: promptCard } : {}),
  });
  recordFeedback(input.deps, input.inputHandle, input.state.runId || undefined, "guard", "deferred_mutation_routing_required", {
    reason: input.reason,
    deferredTools,
    decision: summarizeDecision(input.decision),
    consecutiveFailures: input.state.consecutiveFailures,
    maxConsecutiveFailures: input.config.maxConsecutiveFailures,
    ...repairSignalToFeedbackData(repair),
  });
}

function recordReadProgressRepair(input: {
  deps: AgentLoopDeps;
  inputHandle: SessionInputHandle;
  state: LoopState;
  config: LoopConfig;
  decision: AgentDecision;
  runId: string;
  violation: ReadProgressViolation;
}): void {
  input.state.consecutiveFailures++;
  input.state.readProgress = markReadProgressRejected(input.state.readProgress);
  const repair = createRepairSignal(input.violation.code, {
    message: input.violation.message,
    blockedTargets: input.violation.blockedTargets,
    allowedNextActions: input.violation.allowedNextActions,
    operatorDetails: {
      ...input.violation.operatorDetails,
      consecutiveFailures: input.state.consecutiveFailures,
      maxConsecutiveFailures: input.config.maxConsecutiveFailures,
      decision: summarizeDecision(input.decision),
      readProgress: input.state.readProgress,
    },
  });
  const promptCard = repairSignalToPromptCard(repair);
  input.state.failureHistory.push({
    step: input.state.iteration,
    failureType: "no_progress",
    reason: repair.message,
    blockedTargets: repair.blockedTargets,
    repairCode: repair.code,
    ...(promptCard ? { repair: promptCard } : {}),
  });
  recordFeedback(input.deps, input.inputHandle, input.runId, "guard", "read_progress_repair_requested", {
    message: repair.message,
    warningCodes: ["read_progress_repair_requested", repair.code],
    consecutiveFailures: input.state.consecutiveFailures,
    maxConsecutiveFailures: input.config.maxConsecutiveFailures,
    decision: summarizeDecision(input.decision),
    readProgress: input.state.readProgress,
    ...repairSignalToFeedbackData(repair),
  });
}

function recordTerminalReplyMutationRepair(input: {
  deps: AgentLoopDeps;
  inputHandle: SessionInputHandle;
  state: LoopState;
  config: LoopConfig;
  decision: Extract<AgentDecision, { kind: "reply" }>;
  reason: string;
  failedStep?: StepSummary;
}): void {
  input.state.consecutiveFailures++;
  const repair = createRepairSignal("R_MUTATION_EXPECTED_AFTER_CONTEXT", {
    source: "runner.completion_guard",
    message: input.reason,
    blockedTargets: ["direct_reply"],
    allowedNextActions: [
      "Call patch_files with small stable targets from the latest read output.",
      "Call write_files if replacing the complete file is clearer.",
      "Call another selected mutation tool if it is the correct way to complete the requested change.",
      "Do not send a final reply until a mutation tool succeeds after the latest failed mutation.",
    ],
    operatorDetails: {
      consecutiveFailures: input.state.consecutiveFailures,
      maxConsecutiveFailures: input.config.maxConsecutiveFailures,
      decision: summarizeDecision(input.decision),
      ...(input.failedStep ? { failedStep: summarizeStep(input.failedStep) } : {}),
    },
  });
  const promptCard = repairSignalToPromptCard(repair);
  input.state.failureHistory.push({
    step: input.state.iteration,
    failureType: "no_progress",
    reason: repair.message,
    blockedTargets: repair.blockedTargets,
    repairCode: repair.code,
    ...(promptCard ? { repair: promptCard } : {}),
  });
  recordFeedback(input.deps, input.inputHandle, input.state.runId, "guard", "terminal_reply_repair_requested", {
    message: repair.message,
    warningCodes: ["terminal_reply_rejected", repair.code],
    consecutiveFailures: input.state.consecutiveFailures,
    maxConsecutiveFailures: input.config.maxConsecutiveFailures,
    decision: summarizeDecision(input.decision),
    ...(input.failedStep ? { failedStep: summarizeStep(input.failedStep) } : {}),
    ...repairSignalToFeedbackData(repair),
  });
}

function createMissingWorkRunRepairSignal(input: {
  reason: string;
  message: string;
  decision?: AgentDecision;
  pendingTurnStatus?: string;
}): RepairSignal {
  return createRepairSignal(missingWorkRunRepairCode(input.pendingTurnStatus), {
    blockedTargets: input.decision ? freshSessionDecisionTargets(input.decision) : [],
    operatorDetails: {
      reason: input.reason,
      message: input.message,
      pendingTurnStatus: input.pendingTurnStatus,
      ...(input.decision ? { decision: summarizeDecision(input.decision) } : {}),
    },
  });
}

function missingWorkRunRepairCode(pendingTurnStatus: string | undefined): "R_NORMAL_TOOL_WITHOUT_TASK_RUN" | "R_PENDING_TURN_UNBOUND" | "R_PENDING_TURN_CLARIFYING" {
  if (pendingTurnStatus === "unbound") {
    return "R_PENDING_TURN_UNBOUND";
  }
  if (pendingTurnStatus === "clarifying") {
    return "R_PENDING_TURN_CLARIFYING";
  }
  return "R_NORMAL_TOOL_WITHOUT_TASK_RUN";
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
  const contextEngine = state.harnessContext.contextEngine;
  const focus = contextEngine?.focus;
  return {
    reason,
    userMessage: state.userMessage,
    ...(focus?.status === "active" ? {
      activeTaskId: focus.workId,
      activeBranch: branchFromRef(focus.ref),
    } : {}),
  };
}

function normalizeCreatedWorkRun(created: CreatedWorkRun | MemoryRunHandle): CreatedWorkRun {
  if ("runHandle" in created) {
    return created;
  }
  return { runHandle: created };
}

function branchFromRef(ref: string | undefined): string | undefined {
  if (!ref) {
    return undefined;
  }
  return ref.startsWith("refs/heads/")
    ? ref.slice("refs/heads/".length)
    : ref;
}

function createFailureRecordFromStepSummary(step: StepSummary): LoopState["failureHistory"][number] {
  const failureType = step.failureType ?? "verify_failed";
  const reason = buildFailureHistoryReason(step);
  const blockedTargets = uniqueStrings([
    ...(step.blockedTargets ?? []),
    ...(step.blockedTargets && step.blockedTargets.length > 0 ? [] : toolsFromExecutionContract(step.executionContract)),
  ]);
  const repair = createRepairSignalFromStepSummary(step);
  const promptCard = repair ? repairSignalToPromptCard(repair) : undefined;
  return {
    step: step.step,
    executionContract: step.executionContract,
    failureType,
    reason,
    blockedTargets,
    ...(repair ? { repairCode: repair.code } : {}),
    ...(promptCard ? { repair: promptCard } : {}),
  };
}

function createRepairSignalFromStepSummary(step: StepSummary): RepairSignal | undefined {
  const failureType = step.failureType ?? "verify_failed";
  const reason = buildFailureHistoryReason(step);
  const blockedTargets = uniqueStrings([
    ...(step.blockedTargets ?? []),
    ...(step.blockedTargets && step.blockedTargets.length > 0 ? [] : toolsFromExecutionContract(step.executionContract)),
  ]);
  return createStepFailureRepairSignal({
    failureType,
    reason,
    blockedTargets,
    step,
  });
}

function createStepFailureRepairSignal(input: {
  failureType: LoopState["failureHistory"][number]["failureType"];
  reason: string;
  blockedTargets: string[];
  step: StepSummary;
}): RepairSignal | undefined {
  const missingFields = extractMissingRequiredFields(input.reason);
  const invalidFields = missingFields.length > 0 ? [] : extractInvalidFields(input.reason);
  const code = stepFailureRepairCode(input.failureType, input.reason, missingFields, invalidFields);
  if (!code) {
    return undefined;
  }
  return createRepairSignal(code, {
    blockedTargets: input.blockedTargets,
    missingFields,
    invalidFields,
    operatorDetails: {
      step: input.step.step,
      reason: input.reason,
      failureType: input.failureType,
      executionContract: input.step.executionContract,
      toolsUsed: input.step.toolsUsed,
      evidenceItems: input.step.evidenceItems,
    },
  });
}

function stepFailureRepairCode(
  failureType: LoopState["failureHistory"][number]["failureType"],
  reason: string,
  missingFields: string[],
  invalidFields: string[],
): RepairCode | undefined {
  if (failureType === "validation_error") {
    return missingFields.length > 0 ? "R_TOOL_INPUT_MISSING_REQUIRED_FIELD" : "R_TOOL_INPUT_INVALID";
  }
  if (reason.includes("was not selected") || reason.includes("was not listed in action.allowedTools")) {
    return "R_TOOL_NOT_SELECTED";
  }
  if (failureType === "verify_failed") {
    return "R_VERIFICATION_FAILED";
  }
  if (failureType === "no_progress") {
    return "R_NO_PROGRESS";
  }
  if (reason.includes("missing required field")) {
    return "R_TOOL_INPUT_MISSING_REQUIRED_FIELD";
  }
  if (reason.includes("Invalid input for") || reason.includes("Tool input preflight failed")) {
    return invalidFields.length > 0 ? "R_TOOL_INPUT_INVALID" : "R_TOOL_INPUT_INVALID";
  }
  return undefined;
}

function toolsFromExecutionContract(value: string | undefined): string[] {
  const match = value?.match(/^(?:single|sequential|parallel) action: (.+)$/);
  const calls = match?.[1];
  if (!calls || calls === "no calls") {
    return [];
  }
  return calls
    .split(",")
    .map((call) => call.trim().split(/\s|\(/)[0])
    .filter((tool): tool is string => Boolean(tool) && tool !== "execution_plan");
}

function hasRepeatedRepairFailure(history: LoopState["failureHistory"]): boolean {
  const signature = latestRepairSignature(history);
  if (!signature) {
    return false;
  }
  let count = 0;
  for (let index = history.length - 1; index >= 0; index--) {
    const current = repairFailureSignature(history[index]);
    if (current !== signature) {
      break;
    }
    count++;
  }
  return count >= REPEATED_REPAIR_FAILURE_THRESHOLD;
}

function latestRepairSignature(history: LoopState["failureHistory"]): string | undefined {
  return repairFailureSignature(history[history.length - 1]);
}

function repairFailureSignature(failure: LoopState["failureHistory"][number] | undefined): string | undefined {
  if (!failure?.repairCode || failure.repairCode === "R_REPEATED_REPAIR_FAILURE") {
    return undefined;
  }
  const repair = failure.repair;
  return [
    failure.repairCode,
    compactSignaturePart(failure.blockedTargets),
    compactSignaturePart(repair?.missingFields ?? []),
    compactSignaturePart(repair?.invalidFields ?? []),
  ].join("|");
}

function compactSignaturePart(values: string[]): string {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))]
    .sort()
    .join(",");
}

function recordRepeatedRepairFailure(input: {
  deps: AgentLoopDeps;
  inputHandle: SessionInputHandle;
  state: LoopState;
  runId: string | undefined;
}): void {
  const previous = input.state.failureHistory[input.state.failureHistory.length - 1];
  const repair = createRepairSignal("R_REPEATED_REPAIR_FAILURE", {
    blockedTargets: previous?.blockedTargets ?? [],
    operatorDetails: {
      repeatedSignature: latestRepairSignature(input.state.failureHistory),
      repeatedThreshold: REPEATED_REPAIR_FAILURE_THRESHOLD,
      previousRepairCode: previous?.repairCode,
      previousReason: previous?.reason,
    },
  });
  input.state.failureHistory.push({
    step: input.state.iteration,
    failureType: "validation_error",
    reason: repair.message,
    blockedTargets: previous?.blockedTargets ?? [],
    repairCode: repair.code,
  });
  recordFeedback(input.deps, input.inputHandle, input.runId, "guard", "repeated_repair_failure", {
    message: repair.message,
    repeatedThreshold: REPEATED_REPAIR_FAILURE_THRESHOLD,
    previousRepairCode: previous?.repairCode,
    previousReason: previous?.reason,
    ...repairSignalToFeedbackData(repair),
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

function freshSessionDecisionTargets(decision: AgentDecision): string[] {
  if (decision.kind === "load_tools") {
    return uniqueStrings([
      ...decision.request.toolNames,
      ...decision.request.groups.map((group) => `group:${group}`),
      ...(decision.request.query ? [`query:${decision.request.query}`] : []),
    ]);
  }
  if (decision.kind === "act") {
    return uniqueStrings([
      ...decision.action.calls.map((call) => call.tool),
      ...decision.action.allowedTools,
    ]);
  }
  return [];
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

function recordToolWorkingSetFeedback(input: {
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

function recordStepFeedback(
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

function recordReducerFeedback(
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

function buildToolExposureWarningCodes(
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

function missingWorkRunWarningCodes(decision: AgentDecision | undefined): string[] {
  if (decision?.kind !== "act") {
    return [];
  }
  const normalTools = decision.action.calls
    .map((call) => call.tool)
    .filter((tool) => !isGitContextAllowedDuringPendingRouting(tool));
  return normalTools.length > 0 ? ["normal_tool_before_routing"] : [];
}

function normalTaskToolNames(tools: ToolDefinition[]): string[] {
  return tools
    .map((tool) => tool.name)
    .filter((tool) => !isGitContextAllowedDuringPendingRouting(tool));
}

function latestCompletedTaskRoutingToolNames(state: LoopState): string[] {
  const latestStep = state.completedSteps.at(-1);
  return uniqueStrings((latestStep?.toolsUsed ?? []).filter(isGitContextRoutingToolName));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
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

function buildFinalFeedbackWarnings(input: {
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
  input.state.runClass = input.runClass ?? "task";
  const runHandle = input.runHandle ?? requireWorkRunHandle(input.deps);
  const taskAssets = input.state.runClass === "task"
    ? input.state.harnessContext.contextEngine?.task?.assets
    : undefined;
  let execution = await executeAgentAction(
    {
      toolExecutor: input.deps.toolExecutor,
      selectedTools: input.selectedTools,
      config: input.config,
      clientId: input.deps.clientId,
      ...(input.deps.uiContext ? { uiContext: input.deps.uiContext } : {}),
      runRecorder: input.deps.runRecorder ?? noopRunRecorder,
      runHandle,
      metrics: input.metrics,
      taskAssets,
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
          runRecorder: input.deps.runRecorder ?? noopRunRecorder,
          runHandle,
          metrics: input.metrics,
          taskAssets,
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

  const stepSummary = buildStepSummary({
    stepNumber: input.stepNumber,
    action: input.decision.action,
    execution,
  });

  return {
    execution,
    stepSummary,
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
      continue;
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

function buildInitialState(
  deps: AgentLoopDeps,
  config: LoopConfig,
  inputHandle: SessionInputHandle,
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
    routingAttempts: emptyRoutingAttemptState(),
    runPath: "",
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

function syncHarnessContext(state: LoopState, deps: AgentLoopDeps, _inputHandle: SessionInputHandle): void {
  applyHarnessContextToState(state, buildHarnessContextFromSources({
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
  return "";
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
    && !state.workState.userInputNeeded?.trim()
    && !hasUnresolvedFileMutationFailure(state);
}

function shouldRejectTerminalReplyForUnresolvedMutation(
  state: LoopState,
  decision: Extract<AgentDecision, { kind: "reply" }>,
): { reason: string; failedStep?: StepSummary } | null {
  if (decision.status !== "completed" || state.runClass !== "task" || !isFileMutationRequest(state.userMessage)) {
    return null;
  }
  const failedStep = latestFileMutationStep(state.completedSteps, "failed");
  if (!failedStep) {
    return null;
  }
  const latestSuccess = latestFileMutationStep(state.completedSteps, "success");
  if (latestSuccess && latestSuccess.step > failedStep.step) {
    return null;
  }
  return {
    reason: "The user asked for file changes, but the latest file mutation failed and no later file mutation succeeded. Continue with patch_files, write_files, edit_files, or another mutation tool instead of sending a final reply.",
    failedStep,
  };
}

function hasUnresolvedFileMutationFailure(state: LoopState): boolean {
  return Boolean(shouldRejectTerminalReplyForUnresolvedMutation(state, {
    kind: "reply",
    status: "completed",
    message: "",
  }));
}

function isFileMutationRequest(message: string): boolean {
  return /\b(?:create|write|save|edit|update|change|modify|patch|replace|delete|remove|move|rename|fix|build|generate)\b/i.test(message)
    && /\b(?:file|files|folder|directory|path|html|css|js|ts|tsx|jsx|json|md|txt|site|website|app|page|component|code)\b/i.test(message);
}

function latestFileMutationStep(steps: StepSummary[], outcome: "success" | "failed"): StepSummary | undefined {
  return [...steps]
    .reverse()
    .find((step) => step.outcome === outcome && stepUsesFileMutationTool(step));
}

function deriveUserInputNeededFromTerminalReply(message: string): string | undefined {
  const sentences = message
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
  const waitingSentence = sentences.find(isUserInputRequestSentence);
  return waitingSentence ? normalizeTerminalReplyRequest(waitingSentence) : undefined;
}

function isUserInputRequestSentence(sentence: string): boolean {
  return /\b(?:send|tell|provide|share|choose|confirm|pick|select|let me know|when you|once you|after you)\b/i.test(sentence)
    && /\b(?:you|your|me|the|which|what|when|whether)\b/i.test(sentence);
}

function normalizeTerminalReplyRequest(sentence: string): string {
  const trimmed = sentence.trim();
  if (trimmed.endsWith(".") || trimmed.endsWith("?") || trimmed.endsWith("!")) {
    return trimmed;
  }
  return `${trimmed}.`;
}

function discardModelWorkingNotes(decision: AgentDecision): void {
  void decision.workingNotes;
}

function getLatestObservations(execution: AgentActionExecutionResult): ToolObservation[] {
  return execution.actOutput.toolCalls
    .map((call) => call.observation)
    .filter((observation): observation is NonNullable<ActToolCallRecord["observation"]> => observation !== undefined);
}

function buildUpdatedToolContext(
  state: LoopState,
  execution: AgentActionExecutionResult,
): LoopState["toolContext"] {
  return compactToolContext({
    recent: getLatestObservations(execution),
    toolCalls: [
      ...(state.toolContext?.toolCalls ?? []),
      ...execution.actOutput.toolCalls.map((call) => toPromptToolCallContext(state.runId, state.iteration, call)),
    ],
  });
}

function toPromptToolCallContext(runId: string, step: number, call: ActToolCallRecord): PromptToolCallContext {
  return {
    step,
    ...(call.callId ? { callId: call.callId } : {}),
    tool: call.tool,
    input: call.input,
    status: call.error ? "failed" : "success",
    output: call.output,
    ...(call.error ? { error: call.error } : {}),
    ...(call.code ? { code: call.code } : {}),
    ...(call.operationStatus ? { operationStatus: call.operationStatus } : {}),
    ...(call.artifacts && call.artifacts.length > 0 ? { artifacts: call.artifacts } : {}),
    ...(call.observation?.hasMore !== undefined ? { hasMore: call.observation.hasMore } : {}),
    ...(runId.trim().length > 0 ? { stepRef: { runId, step, ...(call.callId ? { callId: call.callId } : {}) } } : {}),
    ...(call.observation?.evidenceRef ? { evidenceRef: call.observation.evidenceRef } : {}),
    ...(call.rawOutputChars !== undefined ? { rawOutputChars: call.rawOutputChars } : {}),
    ...(call.outputTruncated !== undefined ? { outputTruncated: call.outputTruncated } : {}),
  };
}

function canFinalizeFromWorkState(state: LoopState): boolean {
  return state.workState.status === "done"
    || state.workState.status === "needs_user_input";
}

async function buildFinalResponseFromWorkState(input: {
  deps: AgentLoopDeps;
  state: LoopState;
  metrics: ReturnType<typeof createRunMetrics>;
  inputHandle: SessionInputHandle;
  workRunHandle: MemoryRunHandle | undefined;
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
  const decision = await callAgentDecision({
    provider: input.deps.provider,
    stateView,
    toolDefinitions: [],
    toolLoadingAvailable: false,
    taskFeedbackToolAvailable: false,
    workStateUpdateAvailable: false,
    systemContext: [
      input.deps.systemContext,
      "Final response-only mode: tools are unavailable. Reply naturally to the user from context.run.workState, verified facts, artifacts, and recent tool-call memory. Do not mention harness internals. Do not say control tool names such as update_work_state, decision_load_tools, or ask_user_feedback.",
    ].filter((section): section is string => Boolean(section?.trim())).join("\n\n"),
    metrics: input.metrics,
    feedbackLedger: input.deps.feedbackLedger,
    feedbackContext: {
      clientId: input.deps.clientId,
      sessionId: input.inputHandle.sessionId,
      seq: input.inputHandle.seq,
      ...(input.state.runId || input.workRunHandle?.runId ? { runId: input.state.runId || input.workRunHandle?.runId } : {}),
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
  if (decision.kind === "reply" && decision.status === "completed" && decision.message.trim().length > 0) {
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

function isUsableFinalResponseMessage(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed) return false;
  if (["update_work_state", "decision_load_tools", "ask_user_feedback"].includes(trimmed)) {
    return false;
  }
  if (/\b(?:update_work_state|decision_load_tools|ask_user_feedback)\b/i.test(trimmed)) {
    return false;
  }
  if (/<tool_call>|tool use displayed to the user as a native function call/i.test(trimmed)) {
    return false;
  }
  if (!trimmed.startsWith("{")) {
    return true;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return true;
    }
    const value = parsed as Record<string, unknown>;
    return !["act", "load_tools", "update_work_state", "ask_user", "reply"].includes(String(value["kind"] ?? ""));
  } catch {
    return true;
  }
}

function buildBlockedWorkStateReply(state: LoopState): string {
  const blocker = state.workState.blockers?.find((item) => item.trim().length > 0);
  return blocker ? `I couldn't complete the task. ${blocker}` : "I couldn't complete the task.";
}

function isWorkStateUpdateToolAvailable(
  state: LoopState,
  workRunHandle: MemoryRunHandle | undefined,
): boolean {
  const hasTaskRun = Boolean(state.runId || workRunHandle?.runId);
  return hasTaskRun && state.runClass === "task" && state.workState.status === "not_done";
}

function applyAgentWorkStateUpdate(
  state: LoopState,
  update: AgentWorkStateUpdate,
): { accepted: true } | { accepted: false; reason: string } {
  const summary = update.summary?.trim() || state.workState.summary;
  if (update.status === "done") {
    if (update.userInputNeeded?.trim()) {
      return { accepted: false, reason: "Done work state cannot also require user input." };
    }
    if ((update.blockers ?? []).some((item) => item.trim().length > 0)) {
      return { accepted: false, reason: "Done work state cannot include blockers." };
    }
    if (!hasWorkStateCompletionEvidence(state)) {
      return { accepted: false, reason: "Cannot mark work done without prior successful tool evidence, verified facts, evidence, or artifacts." };
    }
    state.workState = compactWorkState({
      ...state.workState,
      status: "done",
      summary,
      openWork: [],
      blockers: [],
      nextStep: undefined,
      userInputNeeded: undefined,
    });
    return { accepted: true };
  }

  if (update.status === "blocked") {
    const blockers = normalizeList(update.blockers);
    if (blockers.length === 0) {
      return { accepted: false, reason: "Blocked work state requires at least one blocker." };
    }
    state.workState = compactWorkState({
      ...state.workState,
      status: "blocked",
      summary,
      blockers,
      openWork: normalizeList(update.openWork).length > 0 ? normalizeList(update.openWork) : state.workState.openWork,
      nextStep: update.nextStep,
      userInputNeeded: undefined,
    });
    return { accepted: true };
  }

  if (update.status === "needs_user_input") {
    const userInputNeeded = update.userInputNeeded?.trim();
    if (!userInputNeeded) {
      return { accepted: false, reason: "Needs-user-input work state requires userInputNeeded." };
    }
    state.workState = compactWorkState({
      ...state.workState,
      status: "needs_user_input",
      summary,
      userInputNeeded,
      nextStep: userInputNeeded,
      openWork: normalizeList(update.openWork).length > 0 ? normalizeList(update.openWork) : state.workState.openWork,
      blockers: [],
    });
    return { accepted: true };
  }

  state.workState = compactWorkState({
    ...state.workState,
    status: "not_done",
    summary,
    ...(Array.isArray(update.openWork) ? { openWork: normalizeList(update.openWork) } : {}),
    ...(Array.isArray(update.blockers) ? { blockers: normalizeList(update.blockers) } : {}),
    ...(update.nextStep ? { nextStep: update.nextStep.trim() } : {}),
    userInputNeeded: undefined,
  });
  return { accepted: true };
}

function hasWorkStateCompletionEvidence(state: LoopState): boolean {
  if (isFileMutationRequest(state.userMessage)) {
    const latestFailure = latestFileMutationStep(state.completedSteps, "failed");
    const latestSuccess = latestFileMutationStep(state.completedSteps, "success");
    return Boolean(latestSuccess && (!latestFailure || latestSuccess.step > latestFailure.step));
  }
  return state.completedSteps.some((step) => step.outcome === "success" && (step.toolSuccessCount ?? 0) > 0)
    || state.workState.verifiedFacts.length > 0
    || state.workState.evidence.length > 0
    || (state.workState.artifacts?.length ?? 0) > 0
    || (state.toolContext?.toolCalls ?? []).some((call) => call.status === "success");
}

function createFailureRecordFromWorkStateUpdate(step: number, reason: string): FailureRecord {
  return {
    step,
    failureType: "validation_error",
    reason,
    blockedTargets: ["update_work_state"],
  };
}

function canCompleteLocallyAfterAction(
  action: AgentAction,
  step: StepSummary,
  workState: WorkState,
  state: LoopState,
): boolean {
  return action.completion?.intent === "completion_candidate"
    && step.outcome === "success"
    && step.toolFailureCount === 0
    && (!isFileMutationRequest(state.userMessage) || stepUsesFileMutationTool(step))
    && !(workState.userInputNeeded?.trim())
    && (workState.blockers?.length ?? 0) === 0;
}

function buildVerifiedCompletionReply(state: LoopState, step?: StepSummary): string {
  const artifacts = normalizeList(step && stepHasGeneratedArtifactEvidence(step) ? step.artifacts : [])
    .filter((artifact) => isDurableStepArtifact(artifact))
    .map((artifact) => displayArtifactPath(artifact));
  if (artifacts.length > 0) {
    return `Done. I created or updated ${formatDisplayList(artifacts)}.`;
  }

  const summary = state.workState.summary?.trim();
  if (summary && !looksLikeInternalCompletionText(summary)) {
    return summary;
  }
  return "Done. I completed the task.";
}

function displayArtifactPath(path: string): string {
  const trimmed = path.trim();
  if (!isAbsolute(trimmed)) {
    return trimmed;
  }
  const workspaceDir = process.env["AYATI_WORKSPACE_DIR"];
  if (!workspaceDir) {
    return trimmed;
  }
  const workspaceRoot = resolve(workspaceDir);
  const relative = trimmed.startsWith(`${workspaceRoot}/`)
    ? trimmed.slice(workspaceRoot.length + 1)
    : trimmed;
  return relative || trimmed;
}

function formatDisplayList(values: string[]): string {
  const display = values.slice(0, 4).map((value) => `\`${value}\``);
  const remaining = Math.max(0, values.length - display.length);
  if (remaining > 0) {
    display.push(`${remaining} more`);
  }
  if (display.length === 1) {
    return display[0]!;
  }
  if (display.length === 2) {
    return `${display[0]} and ${display[1]}`;
  }
  return `${display.slice(0, -1).join(", ")}, and ${display[display.length - 1]}`;
}

function looksLikeInternalCompletionText(text: string): boolean {
  return /\b(?:tool(?:\s+call)?|sha256|deterministic verification|evidence contract|assertion|reducer|work state|harness|completion candidate|batch write)\b/i.test(text);
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
    runPath: "",
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

function readContextSessionId(
  session: NonNullable<LoopState["harnessContext"]["contextEngine"]>["session"] | undefined,
): string | undefined {
  if (!session) {
    return undefined;
  }
  return session.meta?.sessionId ?? (session as unknown as { sessionId?: string }).sessionId;
}

function buildTaskAssets(state: LoopState): TaskAssetRecord[] {
  const sessionId = readContextSessionId(state.harnessContext.contextEngine?.session);
  return dedupeTaskAssets([
    ...(state.preparedAttachmentRecords ?? []).map((record) => attachmentRecordToTaskAsset(record, sessionId)),
    ...(state.managedFiles ?? []).map((file): TaskAssetRecord => ({
      assetId: stableAssetId("file", file.fileId),
      role: "input",
      kind: "file",
      name: file.originalName,
      ...(sessionId ? { sessionAssetId: stableSessionAssetId(sessionId, "file", file.fileId) } : {}),
      path: absolutePath(file.storagePath),
    })),
    ...(state.managedDirectories ?? []).map((directory): TaskAssetRecord => ({
      assetId: stableAssetId("directory", directory.directoryId),
      role: "input",
      kind: "directory",
      name: directory.name,
      ...(sessionId ? { sessionAssetId: stableSessionAssetId(sessionId, "directory", directory.directoryId) } : {}),
      path: absolutePath(directory.rootPath),
    })),
    ...buildGeneratedArtifactAssets(state),
  ]);
}

function buildGeneratedArtifactAssets(state: LoopState): TaskAssetRecord[] {
  const artifacts = normalizeList(state.completedSteps.flatMap((step) => (
    stepHasGeneratedArtifactEvidence(step) ? step.artifacts : []
  )))
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
  sessionId: string | undefined,
): TaskAssetRecord {
  const kind = record.summary.mode === "structured_data" ? "dataset" : "document";
  return {
    assetId: stableAssetId(kind, record.summary.documentId),
    role: "input",
    kind,
    name: record.summary.displayName,
    ...(sessionId ? { sessionAssetId: stableSessionAssetId(sessionId, "document", record.summary.documentId) } : {}),
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

function stepHasGeneratedArtifactEvidence(step: StepSummary): boolean {
  const toolsUsed = step.toolsUsed ?? [];
  if (toolsUsed.length === 0) {
    return true;
  }
  return toolsUsed.some((tool) => !isReadOnlyTool(tool) && !isGitContextReadOnlyToolName(tool) && !isGitContextRoutingToolName(tool));
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

function stableSessionAssetId(sessionId: string, kind: string, identity: string): string {
  return `SA-${createHash("sha256").update(`${sessionId}\0${kind}\0${identity}`).digest("hex").slice(0, 16)}`;
}

function normalizeList(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter((value) => value.length > 0))];
}
