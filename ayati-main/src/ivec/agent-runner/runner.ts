import { createHash } from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";
import { devLog, devWarn } from "../../shared/index.js";
import { prepareIncomingAttachments } from "../../documents/attachment-preparer.js";
import type { PreparedAttachmentRecord } from "../../documents/prepared-attachment-registry.js";
import type { PreparedAttachmentSummary } from "../../documents/types.js";
import type { MemoryRunHandle, RunRecorder, SessionInputHandle } from "../../memory/types.js";
import type { TaskAssetRecord } from "../../context-engine/index.js";
import type { AgentArtifact } from "../types.js";
import type {
  ActOutput,
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
import type { ToolLoadResult } from "./tool-working-set.js";
import { executeAgentAction } from "./action-executor.js";
import type { AgentActionExecutionResult } from "./action-executor.js";
import { planLocalRecovery } from "./failure-policy.js";
import { createEvidenceTools } from "./evidence-tools.js";
import { isEvidenceToolName } from "./observation-builder.js";
import { deriveExecutionStatus } from "../verification-gates.js";
import { buildContextEngineFeedbackSummary } from "../feedback-ledger.js";
import type { ToolDefinition, ToolResult } from "../../skills/types.js";
import { isGitContextAllowedDuringPendingRouting } from "../../skills/builtins/git-context/tool-policy.js";
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

interface MemoryRunContext {
  runHandle: MemoryRunHandle;
  runPath: string;
  runStateManager: RunStateManager;
}

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

  const ensureWorkRun = async (
    reason = "agent_action_or_tool_load",
    decision?: AgentDecision,
  ): Promise<MemoryRunContext> => {
    if (!workRunHandle) {
      const createWorkRun = deps.createWorkRun;
      if (!createWorkRun) {
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
        });
        throw new Error("Git-memory run handle is required before agent action execution.");
      }
      try {
        workRunHandle = createWorkRun(inputHandle);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
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
        });
        throw error;
      }
      deps.runHandle = workRunHandle;
      deps.onWorkRunCreated?.(workRunHandle);
      recordFeedback(deps, inputHandle, workRunHandle.runId, "run", "created", {
        reason,
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
    recordFeedback(deps, inputHandle, state.runId || workRunHandle?.runId, "harness", "result", {
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
      runPath,
      workState: summarizeWorkState(state.workState),
      completedStepCount: state.completedSteps.length,
      taskSummary: summarizeTaskSummary(taskSummary),
      harnessContext: summarizeHarnessContext(state.harnessContext),
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
        contextEngine: buildContextEngineFeedbackSummary({
          context: state.harnessContext.contextEngine,
          finalizationStatus: state.runClass === "task" && (state.runId || workRunHandle?.runId)
            ? "not_started"
            : "skipped",
          committed: false,
          runId: state.runId || workRunHandle?.runId,
        }),
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
  recordFeedback(deps, inputHandle, state.runId || workRunHandle?.runId, "harness", "context_input", {
    inputKind: state.inputKind ?? "user_message",
    runId: state.runId || workRunHandle?.runId,
    userMessage: state.userMessage,
    summary: summarizeHarnessContext(state.harnessContext),
    context: state.harnessContext,
  });

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
    let deterministicToolLoad: ToolLoadResult | undefined;
    if (deps.toolWorkingSetManager) {
      deterministicToolLoad = deps.toolWorkingSetManager.prepareForDecision(state, toolContext);
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
    recordToolWorkingSetFeedback({
      deps,
      inputHandle,
      runId: state.runId || workRunHandle?.runId,
      state,
      iteration: state.iteration,
      toolContextRunId: toolContext.runId,
      deterministicToolLoad,
      visibleTools,
      selectedTools,
      workRunHandle,
    });
    const stateView = buildAgentStateView(state, {
      activeTools: selectedTools.map((tool) => tool.name),
    });
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
      contextEngine: buildContextEngineFeedbackSummary({
        context: state.harnessContext.contextEngine,
      }),
      warningCodes: buildToolExposureWarningCodes(state, selectedTools, workRunHandle),
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
    recordFeedback(deps, inputHandle, state.runId || workRunHandle?.runId, "decision", "selected", {
      iteration: state.iteration,
      decision: summarizeDecision(decision),
      pendingTurnStatus: state.harnessContext.contextEngine?.pendingTurn?.routingStatus,
      contextEngine: buildContextEngineFeedbackSummary({
        context: state.harnessContext.contextEngine,
      }),
    });

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

    const pendingRouting = hasUnboundOrClarifyingPendingTurn(state);

    if (decision.kind === "load_tools") {
      toolLoadDecisionCount++;
      const work = pendingRouting ? null : await ensureWorkRun("tool_load", decision);
      const loadRunId = work?.runHandle.runId ?? decisionScopeId(inputHandle);
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
      queueStateSnapshot();
      recordRunMetric(metrics, "tool_load_decision", {
        kind: "local",
        status: ["loaded", "partial", "already_active"].includes(loadResult.status) ? "success" : "failed",
      });
      continue;
    }

    if (pendingRouting) {
      const routingRunId = decisionScopeId(inputHandle);
      const routingToolContext = { ...toolContext, runId: routingRunId };
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
        pendingRouting: true,
      });
      const stepResult = await executePendingRoutingAction({
        deps,
        state,
        config,
        selectedTools,
        decision,
        stepNumber: state.iteration,
        toolContext: routingToolContext,
      });
      actionStepCount++;
      lastVerificationPassed = stepResult.execution.verifyOutput.passed;
      if (!stepResult.execution.verifyOutput.passed) {
        failedVerificationCount++;
      }
      totalToolCalls += stepResult.stepSummary.toolSuccessCount + stepResult.stepSummary.toolFailureCount;
      recordActionFeedback(deps, inputHandle, routingRunId, decision.action, stepResult);
      recordStepFeedback(deps, inputHandle, routingRunId, state.iteration, stepResult);

      const beforeWorkStateChars = measureJson(stepResult.execution.nextWorkState);
      const compactedWorkState = compactWorkState(stepResult.execution.nextWorkState);
      recordCompactionMetric(metrics, "workState", beforeWorkStateChars, measureJson(compactedWorkState), { step: state.iteration });
      state.workState = compactedWorkState;
      state.toolContext = compactToolContext({ recent: getLatestObservations(stepResult.execution) });
      stepResult.stepSummary.workState = compactedWorkState;
      stepResult.stepRecord.workState = compactedWorkState;
      recordReducerFeedback(deps, inputHandle, routingRunId, state.iteration, {
        beforeWorkStateChars,
        compactedWorkState,
        stepSummary: stepResult.stepSummary,
      });

      const compactedStep = compactStepSummaryForState(stepResult.stepSummary);
      recordCompactionMetric(metrics, "completedStepSummary", measureJson(stepResult.stepSummary), measureJson(compactedStep), { step: state.iteration });
      state.completedSteps.push(compactedStep);

      const routingUpdate = extractTurnRoutingUpdate(stepResult.execution.actOutput.toolCalls);
      if (routingUpdate?.status === "ready") {
        const routedRunHandle: MemoryRunHandle = {
          sessionId: routingUpdate.sessionId,
          runId: routingUpdate.runId,
          triggerSeq: inputHandle.seq,
        };
        workRunHandle = routedRunHandle;
        deps.runHandle = routedRunHandle;
        deps.onWorkRunCreated?.(routedRunHandle);
        runPath = initRunDirectory(deps.dataDir, routedRunHandle.runId);
        runStateManager = new RunStateManager(runPath);
        await runStateManager.ready();
        state.runId = routedRunHandle.runId;
        state.runPath = runPath;
        state.runClass = "task";
        deps.harnessContext = routingUpdate.harnessContext;
        syncHarnessContext(state, deps, inputHandle);
        if ((state.attachedDocuments ?? []).some((document) => document.kind !== "image")) {
          await prepareAttachmentsForRun(deps, state, routedRunHandle.runId, runPath);
          syncHarnessContext(state, deps, inputHandle);
        }
        const pad = String(state.iteration).padStart(3, "0");
        const actMarkdownPath = `steps/${pad}-act.md`;
        const verifyMarkdownPath = `steps/${pad}-verify.md`;
        writeStepMarkdown(runPath, actMarkdownPath, formatActMarkdown(stepResult.execution.actOutput));
        writeStepMarkdown(runPath, verifyMarkdownPath, formatVerifyMarkdown(stepResult.execution.verifyOutput, stepResult.execution.actOutput.toolCalls));
        await runStateManager.appendStepRecord(stepResult.stepRecord, stepResult.fullStepText);
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
        state.failureHistory.push({
          step: stepResult.stepSummary.step,
          executionContract: stepResult.stepSummary.executionContract,
          failureType: stepResult.stepSummary.failureType ?? "verify_failed",
          reason: buildFailureHistoryReason(stepResult.stepSummary),
          blockedTargets: stepResult.stepSummary.blockedTargets ?? [],
        });
        if (state.consecutiveFailures >= config.maxConsecutiveFailures) {
          state.status = "failed";
          state.finalOutput = buildFailureReply(state);
          return finalize({ status: "failed", content: state.finalOutput });
        }
      } else {
        state.consecutiveFailures = 0;
      }

      queueStateSnapshot();
      recordStateSnapshotMetric("after_pending_routing_step");
      deps.onProgress?.(
        `Step ${state.iteration}: ${stepResult.stepSummary.executionContract} -> ${stepResult.stepSummary.outcome}`,
        runPath,
      );
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
    syncEvidenceTools(deps, state, workToolContext);
    recordFeedback(deps, inputHandle, work.runHandle.runId, "tools", "working_set_refreshed_for_action", {
      iteration: state.iteration,
      toolContextRunId: workToolContext.runId,
      deterministicLoad: summarizeToolLoadResult(workDeterministicToolLoad),
      activeTools: deps.toolWorkingSetManager?.listActive(workToolContext),
    });
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
    recordStepFeedback(deps, inputHandle, work.runHandle.runId, state.iteration, stepResult);

    const beforeWorkStateChars = measureJson(stepResult.execution.nextWorkState);
    const compactedWorkState = compactWorkState(stepResult.execution.nextWorkState);
    recordCompactionMetric(metrics, "workState", beforeWorkStateChars, measureJson(compactedWorkState), { step: state.iteration });
    state.workState = compactedWorkState;
    state.toolContext = compactToolContext({ recent: getLatestObservations(stepResult.execution) });
    stepResult.stepSummary.workState = compactedWorkState;
    stepResult.stepRecord.workState = compactedWorkState;
    recordReducerFeedback(deps, inputHandle, work.runHandle.runId, state.iteration, {
      beforeWorkStateChars,
      compactedWorkState,
      stepSummary: stepResult.stepSummary,
    });

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
      recordFeedback(deps, inputHandle, work.runHandle.runId, "tools", "after_execution", {
        iteration: state.iteration,
        result: summarizeToolLoadResult(state.lastToolLoad),
        activeTools: deps.toolWorkingSetManager.listActive(cleanupContext),
      });
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
  const stepSummary = buildStepSummary({
    stepNumber: input.stepNumber,
    action: input.decision.action,
    execution,
    actMarkdownPath: "",
    verifyMarkdownPath: "",
  });
  stepSummary.artifacts = stepSummary.artifacts.filter((artifact) => artifact.trim().length > 0);
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
  const selected = new Set(input.selectedTools.map((tool) => tool.name));
  const allowed = new Set(action.allowedTools);
  for (const tool of action.allowedTools) {
    if (!selected.has(tool)) {
      return `Allowed tool '${tool}' was not selected for this decision.`;
    }
  }
  for (const call of action.calls) {
    if (!selected.has(call.tool)) {
      return `Tool '${call.tool}' was not selected for this decision.`;
    }
    if (!allowed.has(call.tool)) {
      return `Tool '${call.tool}' was not listed in action.allowedTools.`;
    }
    if (!isGitContextAllowedDuringPendingRouting(call.tool)) {
      return [
        `Tool '${call.tool}' cannot run while the current git-memory pending turn is unbound or clarifying.`,
        "Use git-context read/search tools and then git_context_activate_task_for_turn, git_context_create_task_for_turn, or git_context_ask_clarification_for_turn before task execution.",
      ].join(" ");
    }
    const validation = input.deps.toolExecutor.validate(call.tool, call.input, input.toolContext);
    if (!validation.valid) {
      return `Tool input preflight failed for '${call.tool}': ${validation.error}`;
    }
  }
  return undefined;
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

function hasUnboundOrClarifyingPendingTurn(state: LoopState): boolean {
  const status = state.harnessContext.contextEngine?.pendingTurn?.routingStatus;
  return status === "unbound" || status === "clarifying";
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
}): void {
  const warningCodes = buildToolExposureWarningCodes(input.state, input.selectedTools, input.workRunHandle);
  recordFeedback(input.deps, input.inputHandle, input.runId, "tools", "working_set_prepared", {
    iteration: input.iteration,
    toolContextRunId: input.toolContextRunId,
    workRunId: input.workRunHandle?.runId,
    runHandlePresent: Boolean(input.workRunHandle || input.state.runId),
    pendingTurnStatus: input.state.harnessContext.contextEngine?.pendingTurn?.routingStatus,
    deterministicLoad: summarizeToolLoadResult(input.deterministicToolLoad),
    visible: summarizeToolDefinitions(input.visibleTools),
    selected: summarizeToolDefinitions(input.selectedTools),
    normalSelectedTools: normalTaskToolNames(input.selectedTools),
    contextEngine: buildContextEngineFeedbackSummary({
      context: input.state.harnessContext.contextEngine,
    }),
    ...(warningCodes.length > 0 ? { warningCodes } : {}),
  });
}

function recordStepFeedback(
  deps: AgentLoopDeps,
  inputHandle: SessionInputHandle,
  runId: string,
  iteration: number,
  stepResult: ExecuteActionStepResult,
): void {
  recordFeedback(deps, inputHandle, runId, "verification", "completed", {
    iteration,
    step: stepResult.stepSummary.step,
    verification: summarizeVerification(stepResult.execution.verifyOutput),
    stepSummary: summarizeStep(stepResult.stepSummary),
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
): string[] {
  const warningCodes: string[] = [];
  const pendingTurnStatus = state.harnessContext.contextEngine?.pendingTurn?.routingStatus;
  const normalTools = normalTaskToolNames(selectedTools);
  if ((pendingTurnStatus === "unbound" || pendingTurnStatus === "clarifying") && normalTools.length > 0) {
    warningCodes.push("normal_tool_visible_during_pending_routing", "routing_state_mismatch");
  }
  if (!state.runId && !workRunHandle && normalTools.length > 0) {
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
      runRecorder: input.deps.runRecorder ?? noopRunRecorder,
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
          runRecorder: input.deps.runRecorder ?? noopRunRecorder,
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
  const evidenceMetadata = buildStepEvidenceMetadata(input.execution.actOutput.toolCalls);

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
    ...evidenceMetadata,
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
    evidenceSource: step.evidenceSource,
    outputSize: step.outputSize,
    lineCount: step.lineCount,
    truncated: step.truncated,
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

function buildStepEvidenceMetadata(calls: ActToolCallRecord[]): Pick<StepSummary, "evidenceSource" | "outputSize" | "lineCount" | "truncated"> {
  const sources = calls.map(buildToolEvidenceSource);
  const outputSize = sumNumbers(calls.map((call) => call.rawOutputChars ?? call.evidenceRef?.rawOutputChars));
  const lineCount = sumNumbers(calls.map((call) => call.evidenceRef?.lineCount ?? call.observation?.lineCount));
  const truncated = calls.some((call) => call.outputTruncated === true || call.evidenceRef?.truncated === true || call.observation?.hasMore === true);
  return {
    ...(sources.length > 0 ? { evidenceSource: { kind: "tool-output", toolCalls: sources } } : {}),
    ...(outputSize !== undefined ? { outputSize } : {}),
    ...(lineCount !== undefined ? { lineCount } : {}),
    ...(calls.length > 0 ? { truncated } : {}),
  };
}

function buildToolEvidenceSource(call: ActToolCallRecord): Record<string, unknown> {
  return pruneUndefined({
    kind: "tool-output",
    tool: call.tool,
    callId: call.callId,
    status: call.error ? "failed" : "success",
    operationStatus: call.operationStatus,
    code: call.code,
    rawOutputPath: call.rawOutputPath ?? call.evidenceRef?.rawOutputPath ?? call.observation?.rawOutputPath,
    evidenceRef: call.evidenceRef?.ref ?? call.observation?.evidenceRef,
    rawOutputChars: call.rawOutputChars ?? call.evidenceRef?.rawOutputChars ?? call.observation?.rawOutputChars,
    lineCount: call.evidenceRef?.lineCount ?? call.observation?.lineCount,
    truncated: call.outputTruncated ?? call.evidenceRef?.truncated,
    ...selectedSourceFields(call.input),
    ...selectedSourceFields(call.result?.structuredContent),
  });
}

function selectedSourceFields(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const record = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of ["path", "filePath", "dirPath", "cwd", "query", "pattern", "cmd", "command", "scriptPath", "exitCode", "timedOut", "matchCount"] as const) {
    const selected = compactSourceValue(record[key]);
    if (selected !== undefined) {
      output[key] = selected;
    }
  }
  return output;
}

function compactSourceValue(value: unknown): string | number | boolean | string[] | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed.slice(0, 500) : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    const items = value
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .slice(0, 10)
      .map((item) => item.trim().slice(0, 200));
    return items.length > 0 ? items : undefined;
  }
  return undefined;
}

function sumNumbers(values: Array<number | undefined>): number | undefined {
  const numbers = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (numbers.length === 0) {
    return undefined;
  }
  return numbers.reduce((sum, value) => sum + value, 0);
}

function pruneUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
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
    harnessContext: state.harnessContext,
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
  const sessionId = state.harnessContext.contextEngine?.session.sessionId;
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
