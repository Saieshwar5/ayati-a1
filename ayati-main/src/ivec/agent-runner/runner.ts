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
import type { WorkstreamResolutionOutcome } from "../workstream-resolution/types.js";
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
  evaluateWorkstreamCompletion,
  isWorkstreamCompletionAvailable,
} from "./workstream-completion-policy.js";
import {
  deriveWorkstreamBindingCapabilityPolicy,
  isDecisionAllowedByWorkstreamBinding,
} from "./workstream-binding-capability-policy.js";
import {
  summarizeAgentAction,
  summarizeDecision,
  summarizeHarnessContext,
  summarizeToolLoadResult,
  summarizeWorkState,
} from "./feedback-summary.js";
import { auditToolPolicy } from "./tool-policy-audit.js";

export async function runAgentLoop(
  deps: AgentLoopDeps,
  resolvedConfig?: LoopConfig,
): Promise<AgentLoopResult> {
  const config: LoopConfig = resolvedConfig ?? { ...DEFAULT_LOOP_CONFIG, ...deps.config };
  const inputHandle = resolveInputHandle(deps);
  const runHandle = deps.runHandle;
  const metrics = createRunMetrics();

  let totalToolCalls = 0;
  let toolLoadDecisionCount = 0;
  let actionStepCount = 0;
  let failedVerificationCount = 0;
  let lastVerificationPassed: boolean | undefined;
  let toolLoadProgress = createToolLoadProgressState();
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
      toolLoadDecisionCount,
      actionStepCount,
      failedVerificationCount,
      state,
    });
    recordFeedback(deps, inputHandle, runHandle.runId, "harness", "result", {
      status: input.status,
      responseKind,
      workstreamBound: isWorkstreamBound(state),
      totalIterations: state.iteration,
      totalToolCalls,
      toolLoadDecisionCount,
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
      toolLoadDecisionCount,
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
        toolLoadDecisions: toolLoadDecisionCount,
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
    const finalReplyFromWorkState = canFinalizeFromWorkState(state);
    if (finalReplyFromWorkState) {
      state.status = "completed";
      state.finalOutput = await buildFinalResponseFromWorkState({
        deps,
        state,
        metrics,
        inputHandle,
        runHandle,
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
    const workstreamFeedbackToolAvailable = isWorkstreamFeedbackToolAvailable(state);
    const capabilityPolicy = deriveWorkstreamBindingCapabilityPolicy(state);
    const workstreamResolutionAvailable = Boolean(
      deps.workstreamResolution
      && capabilityPolicy.routingAvailable
      && state.harnessContext.contextEngine?.workstreamResolution?.runId !== runHandle.runId,
    );
    const nativeControlTools = [
      ...(workstreamResolutionAvailable ? ["workstream_resolve"] : []),
      ...(capabilityPolicy.allowToolLoading ? ["decision_load_tools"] : []),
      ...(isWorkstreamCompletionAvailable(state) ? ["workstream_completion"] : []),
      ...(workstreamFeedbackToolAvailable ? ["ask_user_feedback"] : []),
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
        toolLoadingAvailable: capabilityPolicy.allowToolLoading,
        workstreamFeedbackToolAvailable,
        workstreamCompletionAvailable: isWorkstreamCompletionAvailable(state),
        workstreamResolutionAvailable,
        workstreamBound: capabilityPolicy.workstreamBound,
        toolContextProjectionPolicy: config.toolContextProjectionPolicy,
        contextCheckpoint: deps.contextCheckpoint,
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
      const directWorkstreamCompletionRejected = isWorkstreamBound(state)
        && state.workState.status === "not_done"
        && decision.status === "completed"
        && !deriveUserInputNeededFromTerminalReply(decision.message);
      if (directWorkstreamCompletionRejected) {
        const reason = "An active workstream-bound run cannot finish through a direct reply while WorkState is not_done. Call workstream_completion after the requested work and deterministic verification are complete.";
        state.consecutiveFailures++;
        state.failureHistory.push({
          step: state.iteration,
          failureType: "validation_error",
          reason,
          blockedTargets: ["workstream_completion"],
        });
        recordFeedback(deps, inputHandle, runHandle.runId, "guard", "workstream_reply_before_completion", {
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
      } else if (decision.status === "completed" && !isWorkstreamBound(state) && canMarkTerminalReplyDone(state)) {
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
      state.status = "completed";
      state.workState = {
        ...state.workState,
        status: "needs_user_input",
        userInputNeeded: decision.question,
        summary: decision.reason || "User input is needed before the workstream can continue.",
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

    if (decision.kind === "resolve_workstream") {
      if (!deps.workstreamResolution || !workstreamResolutionAvailable) {
        state.consecutiveFailures++;
        state.failureHistory.push({
          step: state.iteration,
          failureType: "validation_error",
          reason: "The isolated workstream resolver is not available for this run.",
          blockedTargets: ["workstream_resolve"],
        });
        continue;
      }
      recordFeedback(deps, inputHandle, runHandle.runId, "workstream_resolution", "started", {
        iteration: state.iteration,
        purpose: decision.request.purpose,
        hintCount: decision.request.hints.length,
      });
      let outcome: WorkstreamResolutionOutcome;
      try {
        outcome = await deps.workstreamResolution.resolve(decision.request);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        state.failureHistory.push({
          step: state.iteration,
          failureType: "validation_error",
          reason: `Isolated workstream resolution failed: ${reason}`,
          blockedTargets: ["workstream_resolve"],
        });
        recordFeedback(deps, inputHandle, runHandle.runId, "workstream_resolution", "failed", {
          iteration: state.iteration,
          reason,
        });
        state.status = "failed";
        state.finalOutput = "Workstream resolution failed before a safe binding was available, so execution stopped without changing task state.";
        return finalize({ status: "failed", content: state.finalOutput });
      }
      deps.harnessContext = {
        ...(deps.harnessContext ?? {}),
        contextEngine: outcome.context,
      };
      syncHarnessContext(state, deps, inputHandle);
      recordFeedback(deps, inputHandle, runHandle.runId, "workstream_resolution", outcome.receipt.status, {
        iteration: state.iteration,
        receipt: outcome.receipt,
        contextRevision: outcome.context.contextRevision,
        routing: outcome.context.current.routing,
      });
      if (outcome.receipt.status === "resolved"
        && outcome.context.current.routing?.status !== "bound") {
        state.status = "failed";
        state.finalOutput = "Workstream resolution completed without an authoritative run binding, so execution stopped safely.";
        return finalize({ status: "failed", content: state.finalOutput });
      }
      state.consecutiveFailures = 0;
      recordStateSnapshotMetric("after_workstream_resolution");
      continue;
    }

    if (decision.kind === "workstream_completion") {
      const evaluation = await evaluateWorkstreamCompletion(state, decision.request);
      state.workState = compactWorkState(evaluation.nextWorkState);
      recordFeedback(
        deps,
        inputHandle,
        runHandle.runId,
        "workstream_completion",
        evaluation.accepted ? "accepted" : "rejected",
        {
          iteration: state.iteration,
          request: decision.request,
          code: evaluation.code,
          ...(evaluation.accepted
            ? { verifiedResources: evaluation.resources }
            : { failures: evaluation.failures }),
          workState: summarizeWorkState(state.workState),
        },
      );
      if (evaluation.accepted) {
        state.verifiedCompletionSummary = decision.request.summary;
        state.completionResources = evaluation.resources;
        state.consecutiveFailures = 0;
        recordRunMetric(metrics, "verified_completion", { kind: "local" });
        recordStateSnapshotMetric("after_workstream_completion_accepted");
      } else {
        state.consecutiveFailures++;
        const reason = evaluation.failures.map((failure) => failure.message).join(" ");
        state.failureHistory.push({
          step: state.iteration,
          failureType: "verify_failed",
          reason,
          blockedTargets: evaluation.failures.flatMap((failure) => failure.path ? [failure.path] : ["workstream_completion"]),
        });
        recordStateSnapshotMetric("after_workstream_completion_rejected");
        if (hasRepeatedRepairFailure(state.failureHistory) || state.consecutiveFailures >= config.maxConsecutiveFailures) {
          state.status = "failed";
          state.finalOutput = buildFailureReply(state);
          return finalize({ status: "failed", content: state.finalOutput });
        }
      }
      continue;
    }

    if (decision.kind === "load_tools" && !capabilityPolicy.allowToolLoading) {
      recordUnboundRunToolRepair({
        deps,
        inputHandle,
        state,
        config,
        decision,
        reason: "unbound_run_tool_load",
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

    if (decision.kind === "load_tools") {
      toolLoadDecisionCount++;
      const workToolContext = { ...toolContext, runId: runHandle.runId };
      recordFeedback(deps, inputHandle, runHandle.runId, "tool_load", "requested", {
        iteration: state.iteration,
        request: decision.request,
      });
      const loadResult = deps.toolWorkingSetManager?.load(
        decision.request,
        workToolContext,
        capabilityPolicy,
      ) ?? {
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
        unavailable: [],
        message: "No tool working-set manager is available.",
      };
      state.lastToolLoad = loadResult;
      recordFeedback(deps, inputHandle, runHandle.runId, "tool_load", "completed", {
        iteration: state.iteration,
        request: decision.request,
        result: summarizeToolLoadResult(loadResult),
        status: loadResult.status,
        loaded: loadResult.loaded,
        alreadyActive: loadResult.alreadyActive,
        missing: loadResult.missing,
        unavailable: loadResult.unavailable,
        evicted: loadResult.evicted,
        message: loadResult.message,
      });
      recordRunMetric(metrics, "tool_load_decision", {
        kind: "local",
        status: ["loaded", "partial", "already_active"].includes(loadResult.status) ? "success" : "failed",
      });
      const progressEvaluation = evaluateToolLoadProgress(toolLoadProgress, loadResult);
      toolLoadProgress = progressEvaluation.state;
      if (progressEvaluation.shouldStop) {
        const failure = createToolLoadNoProgressFailure(progressEvaluation, state.iteration);
        state.consecutiveFailures++;
        state.failureHistory.push(failure);
        recordFeedback(deps, inputHandle, runHandle.runId, "guard", "tool_load_no_progress", {
          iteration: state.iteration,
          status: loadResult.status,
          repeatedTargets: progressEvaluation.repeatedTargets,
          message: failure.reason,
          warningCodes: ["tool_load_no_progress", "R_NO_PROGRESS"],
          repair: failure.repair,
        });
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

    const beforeWorkStateChars = measureJson(stepResult.execution.nextWorkState);
    const compactedWorkState = compactWorkState(stepResult.execution.nextWorkState);
    recordCompactionMetric(metrics, "workState", beforeWorkStateChars, measureJson(compactedWorkState), { step: stepNumber });
    state.workState = compactedWorkState;
    state.toolContext = buildUpdatedToolContext(state, stepResult.execution);
    stepResult.stepSummary.workState = compactedWorkState;
    recordReducerFeedback(deps, inputHandle, runHandle.runId, state.iteration, {
      beforeWorkStateChars,
      compactedWorkState,
      stepSummary: stepResult.stepSummary,
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
      state.lastToolLoad = deps.toolWorkingSetManager.afterExecution(
        stepResult.execution.actOutput.toolCalls,
        cleanupContext,
        deriveWorkstreamBindingCapabilityPolicy(state),
      );
      deps.toolWorkingSetManager.cleanupAfterStep(cleanupContext);
      recordFeedback(deps, inputHandle, runHandle.runId, "tools", "after_execution", {
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

async function buildFinalResponseFromWorkState(input: {
  deps: AgentLoopDeps;
  state: LoopState;
  metrics: ReturnType<typeof createRunMetrics>;
  inputHandle: SessionInputHandle;
  runHandle: AgentLoopDeps["runHandle"];
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
      workstreamFeedbackToolAvailable: false,
      workstreamBound: isWorkstreamBound(input.state),
      toolContextProjectionPolicy: input.config.toolContextProjectionPolicy,
      contextCheckpoint: input.deps.contextCheckpoint,
      systemContext: [
        input.deps.systemContext,
        "Final response-only mode: tools are unavailable. Reply naturally to the user from context.run.workState, verified facts, artifacts, and recent tool-call memory. Do not mention harness internals. Do not say control tool names such as workstream_completion, decision_load_tools, or ask_user_feedback.",
      ].filter((section): section is string => Boolean(section?.trim())).join("\n\n"),
      metrics: input.metrics,
      feedbackLedger: input.deps.feedbackLedger,
      feedbackContext: {
        clientId: input.deps.clientId,
        sessionId: input.inputHandle.sessionId,
        seq: input.inputHandle.seq,
        runId: input.runHandle.runId,
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
    recordFeedback(input.deps, input.inputHandle, input.runHandle.runId, "guard", "final_response_context_limit", {
      iteration: input.state.iteration,
      finalInputTokens: error.receipt.finalInputTokens,
      softInputTokens: error.receipt.softInputTokens,
      mode: error.receipt.mode,
    });
  }
  if (decision?.kind === "reply" && decision.status === "completed" && decision.message.trim().length > 0) {
    if (!isUsableFinalResponseMessage(decision.message)) {
      recordFeedback(input.deps, input.inputHandle, input.runHandle.runId, "decision", "final_response_rejected", {
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
  context: Awaited<ReturnType<typeof recordRunStep>>,
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

function isWorkstreamFeedbackToolAvailable(state: LoopState): boolean {
  return isWorkstreamBound(state) && state.workState.status === "not_done";
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
