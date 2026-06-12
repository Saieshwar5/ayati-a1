import { devLog, devWarn } from "../../shared/index.js";
import { prepareIncomingAttachments } from "../../documents/attachment-preparer.js";
import type { PreparedAttachmentSummary } from "../../documents/types.js";
import type { AgentArtifact } from "../types.js";
import type {
  AgentLoopDeps,
  AgentLoopResult,
  AgentTaskSummaryRecord,
  CompletionDirective,
  GoalContract,
  LoopConfig,
  LoopState,
  StepSummary,
  TaskProgressState,
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
import { buildLoopStateSizeBreakdown, compactStepSummaryForState, compactTaskProgress, measureJson } from "../state-compaction.js";
import { collectAgentArtifacts } from "../agent-artifacts.js";
import { buildAgentStateView } from "./state-view.js";
import { selectToolsForDecision } from "./tool-selector.js";
import { callAgentDecision } from "./decision.js";
import type { AgentAction, AgentDecision } from "./decision.js";
import { executeAgentAction } from "./action-executor.js";
import type { AgentActionExecutionResult } from "./action-executor.js";
import { planLocalRecovery } from "./failure-policy.js";

export async function runAgentLoop(
  deps: AgentLoopDeps,
  resolvedConfig?: LoopConfig,
): Promise<AgentLoopResult> {
  const config: LoopConfig = resolvedConfig ?? { ...DEFAULT_LOOP_CONFIG, ...deps.config };
  const runId = deps.runHandle.runId;
  const runPath = initRunDirectory(deps.dataDir, runId);
  const runStateManager = new RunStateManager(runPath);
  await runStateManager.ready();
  const metrics = createRunMetrics();

  let totalToolCalls = 0;
  const state = buildInitialState(deps, config, runPath);

  const queueStateSnapshot = (): void => {
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
    queueStateSnapshot();
    recordStateSnapshotMetric("final");
    await flushStateWrites(runPath);
    await writeOptimizationMetrics(runPath, metrics).catch((error) => {
      devWarn(
        `[${deps.clientId}] failed to persist optimization metrics: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    deps.externalSkillBroker?.deactivate({}, {
      clientId: deps.clientId,
      runId: deps.runHandle.runId,
      sessionId: deps.runHandle.sessionId,
      stepNumber: state.iteration,
      ...(deps.uiContext ? { uiContext: deps.uiContext } : {}),
    });
    devLog(`[${deps.clientId}] [metrics:agent_loop] ${formatRunMetrics(metrics)}`);
    return buildLoopResult(state, deps.dataDir, {
      status: input.status,
      totalIterations: state.iteration,
      totalToolCalls,
      content: input.content,
      completion: input.completion,
      responseKind: input.responseKind,
    });
  };

  syncTransientMemoryContext(state, deps);
  state.userMessage = getPrimaryUserMessage(deps);
  state.goal = goalFromUserMessage(state.userMessage);
  state.taskProgress = {
    ...state.taskProgress,
    progressSummary: "Starting decision-action-reducer loop.",
    currentFocus: state.userMessage,
  };

  devLog(
    `[${deps.clientId}] agentLoop start inputKind=${state.inputKind ?? "user_message"} runHandle=${deps.runHandle.runId} message=${state.userMessage.slice(0, 160)}`,
  );

  queueStateSnapshot();
  recordStateSnapshotMetric("initial");

  await prepareAttachmentsForRun(deps, state, runId, runPath);
  queueStateSnapshot();

  while (state.status === "running" && state.iteration < config.maxIterations) {
    if (deps.signal?.aborted) {
      state.status = "failed";
      state.finalOutput = "Agent was stopped.";
      return finalize({ status: "failed", content: state.finalOutput });
    }

    syncTransientMemoryContext(state, deps);
    state.iteration++;

    if (canCompleteFromVerifiedState(state)) {
      state.status = "completed";
      state.finalOutput = buildLocalCompletionReply(state);
      recordRunMetric(metrics, "local_completion", { kind: "local" });
      return finalize({ status: "completed", content: state.finalOutput });
    }

    const visibleTools = deps.toolExecutor?.definitions({
      clientId: deps.clientId,
      runId: deps.runHandle.runId,
      sessionId: deps.runHandle.sessionId,
      stepNumber: state.iteration,
      ...(deps.uiContext ? { uiContext: deps.uiContext } : {}),
    }) ?? deps.toolDefinitions;
    const selectedTools = selectToolsForDecision(state, visibleTools, config.maxSelectedTools);
    const decision = await callAgentDecision({
      provider: deps.provider,
      stateView: buildAgentStateView(state),
      toolDefinitions: selectedTools,
      systemContext: deps.systemContext,
      metrics,
    });

    if (decision.kind === "reply") {
      state.status = decision.status === "failed" ? "failed" : "completed";
      state.finalOutput = decision.message;
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
      state.taskProgress = {
        ...state.taskProgress,
        status: "needs_user_input",
        userInputNeeded: decision.question,
        progressSummary: decision.reason || "User input is needed before the task can continue.",
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

    const stepResult = await executeActionStep({
      deps,
      state,
      config,
      metrics,
      selectedTools,
      decision,
      stepNumber: state.iteration,
    });
    totalToolCalls += stepResult.stepSummary.toolSuccessCount + stepResult.stepSummary.toolFailureCount;

    const beforeProgressChars = measureJson(stepResult.execution.nextProgress);
    const compactedProgress = compactTaskProgress(stepResult.execution.nextProgress);
    recordCompactionMetric(metrics, "taskProgress", beforeProgressChars, measureJson(compactedProgress), { step: state.iteration });
    state.taskProgress = compactedProgress;
    stepResult.stepSummary.taskProgress = compactedProgress;
    stepResult.stepRecord.taskProgress = compactedProgress;

    const compactedStep = compactStepSummaryForState(stepResult.stepSummary);
    recordCompactionMetric(metrics, "completedStepSummary", measureJson(stepResult.stepSummary), measureJson(compactedStep), { step: state.iteration });
    state.completedSteps.push(compactedStep);
    await runStateManager.appendStepRecord(stepResult.stepRecord, stepResult.fullStepText);

    recordPlanModeMetric(metrics, decision.action.mode, {
      step: state.iteration,
      tools: decision.action.calls.map((call) => call.tool).join(","),
    });
    recordVerificationMetric(metrics, stepResult.stepSummary.verificationMethod, {
      step: state.iteration,
      executionStatus: stepResult.stepSummary.executionStatus,
      validationStatus: stepResult.stepSummary.validationStatus,
    });

    if (stepResult.stepSummary.outcome === "failed") {
      state.consecutiveFailures++;
      state.failureHistory.push({
        step: stepResult.stepSummary.step,
        executionContract: stepResult.stepSummary.executionContract,
        failureType: stepResult.stepSummary.failureType ?? "verify_failed",
        reason: stepResult.stepSummary.summary,
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
    recordStateSnapshotMetric("after_step");
    deps.onProgress?.(
      `Step ${state.iteration}: ${stepResult.stepSummary.executionContract} -> ${stepResult.stepSummary.outcome}`,
      runPath,
    );

    if (canCompleteLocallyAfterAction(decision.action, stepResult.stepSummary, state.taskProgress)) {
      state.status = "completed";
      state.finalOutput = buildLocalCompletionReply(state);
      return finalize({ status: "completed", content: state.finalOutput });
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

async function executeActionStep(input: ExecuteActionStepInput): Promise<ExecuteActionStepResult> {
  input.state.runClass = "task";
  let execution = await executeAgentAction(
    {
      toolExecutor: input.deps.toolExecutor,
      selectedTools: input.selectedTools,
      config: input.config,
      clientId: input.deps.clientId,
      ...(input.deps.uiContext ? { uiContext: input.deps.uiContext } : {}),
      sessionMemory: input.deps.sessionMemory,
      runHandle: input.deps.runHandle,
      metrics: input.metrics,
    },
    input.decision.action,
    input.stepNumber,
    input.state.taskProgress,
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
          sessionMemory: input.deps.sessionMemory,
          runHandle: input.deps.runHandle,
          metrics: input.metrics,
        },
        recovery.action,
        input.stepNumber,
        input.state.taskProgress,
      );
      execution = mergeRecoveredExecution(execution, retryExecution, recovery.reason);
    }
  }

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
    nextProgress: retry.nextProgress,
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
    expectedStateChange: "Verified facts and progress state are updated from tool-owned evidence.",
    requiresFullStepContext: false,
    expectationCheckStatus: input.execution.verifyOutput.expectationCheckStatus,
    expectationCheckSummary: input.execution.verifyOutput.expectationCheckSummary,
    verificationMethod: input.execution.verifyOutput.method,
    executionStatus: input.execution.verifyOutput.executionStatus,
    validationStatus: input.execution.verifyOutput.validationStatus,
    evidenceSummary: input.execution.verifyOutput.evidenceSummary,
    evidenceItems: input.execution.verifyOutput.evidenceItems,
    usedRawArtifacts: [],
    taskProgress: input.execution.nextProgress,
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
    taskProgress: step.taskProgress,
    stoppedEarlyReason: step.stoppedEarlyReason,
    failureType: step.failureType,
    blockedTargets: step.blockedTargets ?? [],
    act: {
      toolCalls: execution.actOutput.toolCalls,
      finalText: execution.actOutput.finalText,
    },
  };
}

function buildInitialState(deps: AgentLoopDeps, config: LoopConfig, runPath: string): LoopState {
  return {
    runId: deps.runHandle.runId,
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
    goal: emptyGoalContract(),
    taskProgress: emptyTaskProgress(),
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
    managedFiles: deps.managedFiles ?? [],
    managedDirectories: deps.managedDirectories ?? [],
    activeSessionAttachments: [],
    runtimeContext: deps.runtimeContext,
    activeLearningContext: deps.activeLearningContext,
    previousSessionSummary: "",
    personalMemorySnapshot: "",
    attentionShelf: [],
    activeSessionPath: "",
    sessionStatus: deps.sessionStatus ?? null,
    sessionHistory: [],
    recentTaskSummaries: [],
    recentSystemActivity: [],
  };
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
}

function syncTransientMemoryContext(state: LoopState, deps: AgentLoopDeps): void {
  const memCtx = deps.sessionMemory.getPromptMemoryContext();
  state.runtimeContext = deps.runtimeContext;
  state.activeLearningContext = deps.activeLearningContext;
  state.previousSessionSummary = memCtx.previousSessionSummary ?? "";
  state.personalMemorySnapshot = memCtx.personalMemorySnapshot ?? "";
  state.attentionShelf = memCtx.attentionShelf ?? [];
  state.activeSessionPath = memCtx.activeSessionPath ?? "";
  state.sessionStatus = deps.sessionStatus ?? deps.sessionMemory.getSessionStatus?.() ?? null;
  state.sessionHistory = (memCtx.conversationTurns ?? []).filter((turn) => {
    if (state.inputKind !== "user_message") {
      return true;
    }
    return !(turn.role === "user" && turn.content === state.userMessage);
  });
  state.recentTaskSummaries = memCtx.recentTaskSummaries ?? [];
  state.activeSessionAttachments = memCtx.activeAttachments ?? [];
  state.recentSystemActivity = memCtx.recentSystemActivity ?? [];
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

function goalFromUserMessage(userMessage: string): GoalContract {
  const objective = userMessage.trim() || "Handle the user request.";
  return {
    objective,
    done_when: ["The user request has been satisfied."],
    required_evidence: [],
    ask_user_when: ["Required information is missing and cannot be inferred safely."],
    stop_when_no_progress: ["The same failure repeats without deterministic recovery."],
  };
}

function emptyGoalContract(): GoalContract {
  return {
    objective: "",
    done_when: [],
    required_evidence: [],
    ask_user_when: [],
    stop_when_no_progress: [],
  };
}

function emptyTaskProgress(): TaskProgressState {
  return {
    status: "not_done",
    progressSummary: "",
    currentFocus: "",
    completedMilestones: [],
    openWork: [],
    blockers: [],
    keyFacts: [],
    evidence: [],
  };
}

function canCompleteFromVerifiedState(state: LoopState): boolean {
  return state.taskProgress.status === "done" && state.taskProgress.userInputNeeded === undefined;
}

const LOCAL_COMPLETION_TOOLS = new Set([
  "create_directory",
  "write_file",
  "write_files",
  "edit_file",
  "move",
  "delete",
]);

function canCompleteLocallyAfterAction(
  action: AgentAction,
  step: StepSummary,
  progress: TaskProgressState,
): boolean {
  if (step.outcome !== "success") {
    return false;
  }
  const tools = action.calls.map((call) => call.tool);
  return tools.length > 0
    && tools.every((tool) => LOCAL_COMPLETION_TOOLS.has(tool))
    && !(progress.userInputNeeded?.trim());
}

function buildLocalCompletionReply(state: LoopState): string {
  const summary = state.taskProgress.progressSummary.trim() || "The task is complete.";
  const evidence = normalizeList(state.taskProgress.evidence).slice(0, 3);
  if (evidence.length === 0) {
    return `Done - ${summary}`;
  }
  return `Done - ${summary}\n\nEvidence: ${evidence.join("; ")}`;
}

function buildFailureReply(state: LoopState): string {
  const latest = state.failureHistory[state.failureHistory.length - 1];
  if (!latest) {
    return "I couldn't complete the task.";
  }
  return `I couldn't complete the task. Latest failure: ${latest.reason}`;
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
  };

  if (state.runClass === "task") {
    result.taskSummary = buildTaskSummaryRecord(state, content, input.status, responseKind, input.completion);
  }

  const artifacts = collectAgentArtifacts(state.runId, state.runPath, dataDir, state.completedSteps) as AgentArtifact[];
  if (artifacts.length > 0) {
    result.artifacts = artifacts;
  }
  return result;
}

function buildTaskSummaryRecord(
  state: LoopState,
  assistantResponse: string,
  status: AgentLoopResult["status"],
  responseKind: AgentLoopResult["type"],
  completion?: CompletionDirective,
): AgentTaskSummaryRecord {
  return {
    runId: state.runId,
    runPath: state.runPath,
    status,
    taskStatus: state.taskProgress.status,
    objective: state.goal.objective.trim() || undefined,
    summary: state.taskProgress.progressSummary.trim() || assistantResponse,
    progressSummary: state.taskProgress.progressSummary.trim() || undefined,
    currentFocus: state.taskProgress.currentFocus?.trim() || undefined,
    completedMilestones: normalizeList(state.taskProgress.completedMilestones),
    openWork: normalizeList(state.taskProgress.openWork),
    blockers: normalizeList(state.taskProgress.blockers),
    keyFacts: normalizeList(state.taskProgress.keyFacts),
    evidence: normalizeList(state.taskProgress.evidence),
    userInputNeeded: state.taskProgress.userInputNeeded?.trim() || undefined,
    userMessage: state.userMessage.trim() || undefined,
    assistantResponse,
    assistantResponseKind: responseKind === "none" ? undefined : responseKind,
    feedbackKind: completion?.feedback_kind,
    feedbackLabel: completion?.feedback_label,
    actionType: completion?.action_type,
    entityHints: completion?.entity_hints,
    goalDoneWhen: normalizeList(state.goal.done_when),
    goalRequiredEvidence: normalizeList(state.goal.required_evidence),
    nextAction: deriveNextAction(state),
    stopReason: deriveStopReason(state, status),
    attachmentNames: buildAttachmentNames(state.preparedAttachments),
  };
}

function deriveNextAction(state: LoopState): string | undefined {
  if (state.taskProgress.userInputNeeded?.trim()) {
    return state.taskProgress.userInputNeeded.trim();
  }
  const openWork = state.taskProgress.openWork ?? [];
  if (openWork.length > 0) {
    return openWork[0];
  }
  const blockers = state.taskProgress.blockers ?? [];
  if (blockers.length > 0) {
    return blockers[0];
  }
  return undefined;
}

function deriveStopReason(
  state: LoopState,
  status: AgentLoopResult["status"],
): AgentTaskSummaryRecord["stopReason"] {
  if (state.taskProgress.status === "needs_user_input") return "needs_user_input";
  if (state.taskProgress.status === "blocked") return "blocked";
  if (status === "failed") return "failed";
  if (status === "stuck") return "stuck";
  return "completed";
}

function buildAttachmentNames(preparedAttachments: PreparedAttachmentSummary[] | undefined): string[] {
  return (preparedAttachments ?? []).map((attachment) => attachment.displayName);
}

function normalizeList(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter((value) => value.length > 0))];
}
