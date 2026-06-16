import { createHash } from "node:crypto";
import { devLog, devWarn } from "../../shared/index.js";
import { prepareIncomingAttachments } from "../../documents/attachment-preparer.js";
import type { PreparedAttachmentRecord } from "../../documents/prepared-attachment-registry.js";
import type { PreparedAttachmentSummary } from "../../documents/types.js";
import type { FocusAssetRef } from "../../memory/types.js";
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
  compactLatestObservation,
  compactLatestObservations,
  compactStepSummaryForState,
  compactToolContext,
  compactWorkState,
  measureJson,
} from "../state-compaction.js";
import { collectAgentArtifacts } from "../agent-artifacts.js";
import { buildAgentStateView } from "./state-view.js";
import { selectToolsForDecision } from "./tool-selector.js";
import { callAgentDecision } from "./decision.js";
import type { AgentAction, AgentDecision } from "./decision.js";
import { executeAgentAction } from "./action-executor.js";
import type { AgentActionExecutionResult } from "./action-executor.js";
import { planLocalRecovery } from "./failure-policy.js";
import { createEvidenceTools } from "./evidence-tools.js";
import { isEvidenceToolName } from "./observation-builder.js";

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
    syncPreparedAttachmentsFromRegistry(state, deps);
    syncTransientMemoryContext(state, deps);
    queueStateSnapshot();
    recordStateSnapshotMetric("final");
    await flushStateWrites(runPath);
    await writeOptimizationMetrics(runPath, metrics).catch((error) => {
      devWarn(
        `[${deps.clientId}] failed to persist optimization metrics: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    deps.skillActivationManager?.deactivateRun({
      clientId: deps.clientId,
      runId: deps.runHandle.runId,
      sessionId: deps.runHandle.sessionId,
      stepNumber: state.iteration,
      ...(deps.uiContext ? { uiContext: deps.uiContext } : {}),
    });
    deps.toolExecutor?.unmount?.(evidenceToolGroupId(deps.runHandle.runId));
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
    const finalReplyFromVerifiedState = canCompleteFromVerifiedState(state);

    const toolContext = {
      clientId: deps.clientId,
      runId: deps.runHandle.runId,
      sessionId: deps.runHandle.sessionId,
      stepNumber: state.iteration,
      ...(deps.uiContext ? { uiContext: deps.uiContext } : {}),
    };
    await deps.skillActivationManager?.prepareForDecision(state, toolContext);
    syncEvidenceTools(deps, state, toolContext);

    const visibleTools = deps.toolExecutor?.definitions({
      ...toolContext,
    }) ?? deps.toolDefinitions;
    const selectedTools = finalReplyFromVerifiedState
      ? []
      : selectToolsForDecision(state, visibleTools, config.maxSelectedTools);
    const decision = await callAgentDecision({
      provider: deps.provider,
      stateView: buildAgentStateView(state),
      toolDefinitions: selectedTools,
      systemContext: deps.systemContext,
      metrics,
    });
    discardModelWorkingNotes(decision);

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

    const beforeWorkStateChars = measureJson(stepResult.execution.nextWorkState);
    const compactedWorkState = compactWorkState(stepResult.execution.nextWorkState);
    recordCompactionMetric(metrics, "workState", beforeWorkStateChars, measureJson(compactedWorkState), { step: state.iteration });
    state.workState = compactedWorkState;
    const latestObservations = compactLatestObservations(getLatestObservations(stepResult.execution));
    state.latestObservations = latestObservations;
    state.latestObservation = compactLatestObservation(latestObservations?.at(-1));
    state.toolContext = compactToolContext(latestObservations ? { recent: latestObservations } : undefined);
    stepResult.stepSummary.workState = compactedWorkState;
    stepResult.stepRecord.workState = compactedWorkState;

    const compactedStep = compactStepSummaryForState(stepResult.stepSummary);
    recordCompactionMetric(metrics, "completedStepSummary", measureJson(stepResult.stepSummary), measureJson(compactedStep), { step: state.iteration });
    const evidenceReviewAction = isEvidenceReviewAction(decision.action);
    if (!evidenceReviewAction) {
      state.completedSteps.push(compactedStep);
      await runStateManager.appendStepRecord(stepResult.stepRecord, stepResult.fullStepText);
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
      runId: deps.runHandle.runId,
      sessionId: deps.runHandle.sessionId,
      stepNumber: state.iteration,
      ...(deps.uiContext ? { uiContext: deps.uiContext } : {}),
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

    if (canCompleteLocallyAfterAction(decision.action, stepResult.stepSummary, state.workState)) {
      state.workState = compactWorkState({
        ...state.workState,
        status: "done",
      });
      recordRunMetric(metrics, "verified_completion", { kind: "local" });
      if (state.iteration >= config.maxIterations) {
        state.status = "completed";
        state.finalOutput = "I completed the task.";
        return finalize({ status: "completed", content: state.finalOutput });
      }
      continue;
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
      runPath: input.state.runPath,
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
          sessionMemory: input.deps.sessionMemory,
          runHandle: input.deps.runHandle,
          metrics: input.metrics,
          runPath: input.state.runPath,
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
    activeLearningContext: deps.activeLearningContext,
    personalMemorySnapshot: "",
    activeFocus: [],
    attentionShelf: [],
    sessionFocusCards: [],
    recentExchanges: [],
    toolContext: { recent: [] },
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
  state.preparedAttachmentRecords = prepared.records;
}

function syncTransientMemoryContext(state: LoopState, deps: AgentLoopDeps): void {
  const memCtx = deps.sessionMemory.getPromptMemoryContext();
  state.activeLearningContext = deps.activeLearningContext;
  state.personalMemorySnapshot = memCtx.personalMemorySnapshot ?? "";
  state.activeFocus = memCtx.activeFocus ?? [];
  state.attentionShelf = memCtx.attentionShelf ?? [];
  state.sessionFocusCards = memCtx.sessionFocusCards ?? [];
  state.recentExchanges = memCtx.recentExchanges ?? [];
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

function discardModelWorkingNotes(decision: AgentDecision): void {
  void decision.workingNotes;
}

function getLatestObservations(execution: AgentActionExecutionResult): NonNullable<LoopState["latestObservations"]> {
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
  const groupId = evidenceToolGroupId(deps.runHandle.runId);
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
  workState: WorkState,
): boolean {
  if (step.outcome !== "success") {
    return false;
  }
  const tools = action.calls.map((call) => call.tool);
  return tools.length > 0
    && tools.every((tool) => LOCAL_COMPLETION_TOOLS.has(tool))
    && !(workState.userInputNeeded?.trim());
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
  const userFacingSummary = completion?.summary?.trim() || assistantResponse.trim();
  const progressSummary = state.workState.summary.trim();
  return {
    runId: state.runId,
    runPath: state.runPath,
    focusId: selectContinuationFocusId(state),
    status,
    taskStatus: state.workState.status,
    objective: state.userMessage.trim() || undefined,
    summary: userFacingSummary || progressSummary,
    progressSummary: progressSummary || undefined,
    currentFocus: state.workState.nextStep?.trim() || undefined,
    completedMilestones: [],
    openWork: normalizeList(state.workState.openWork),
    blockers: normalizeList(state.workState.blockers),
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
    stopReason: deriveStopReason(state, status),
    attachmentNames: buildAttachmentNames(state.preparedAttachments),
    focusAssets: buildFocusAssets(state),
  };
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

function buildAttachmentNames(preparedAttachments: PreparedAttachmentSummary[] | undefined): string[] {
  return (preparedAttachments ?? []).map((attachment) => attachment.displayName);
}

function selectContinuationFocusId(state: LoopState): string | undefined {
  const active = state.activeFocus ?? [];
  if (active.length === 0) {
    return undefined;
  }
  return active[0]?.focusId;
}

function buildFocusAssets(state: LoopState): FocusAssetRef[] {
  const now = new Date().toISOString();
  return dedupeFocusAssets([
    ...(state.preparedAttachmentRecords ?? []).map((record) => attachmentRecordToFocusAsset(record, state.runId, state.runPath, now)),
    ...(state.managedFiles ?? []).map((file) => ({
      assetId: stableAssetId("file", file.fileId),
      kind: "file" as const,
      origin: file.origin === "generated_artifact"
        ? "agent_generated" as const
        : file.origin === "agent_download"
          ? "tool_result" as const
          : file.origin === "local_path"
            ? "user_selected" as const
            : "user_attached" as const,
      role: "input" as const,
      displayName: file.originalName,
      path: file.storagePath,
      fileId: file.fileId,
      restore: { filePath: file.storagePath },
      sourceRunId: state.runId,
      sourceRunPath: state.runPath,
      lastUsedRunId: state.runId,
      lastUsedAt: file.lastUsedAt ?? now,
      metadata: {
        kind: file.kind,
        capabilities: file.capabilities,
        sizeBytes: file.sizeBytes,
        processingStatus: file.processingStatus,
      },
    })),
    ...(state.managedDirectories ?? []).map((directory) => ({
      assetId: stableAssetId("directory", directory.directoryId),
      kind: "directory" as const,
      origin: "user_attached" as const,
      role: "input" as const,
      displayName: directory.name,
      path: directory.rootPath,
      directoryId: directory.directoryId,
      restore: { directoryPath: directory.rootPath },
      sourceRunId: state.runId,
      sourceRunPath: state.runPath,
      lastUsedRunId: state.runId,
      lastUsedAt: directory.lastUsedAt ?? now,
      metadata: {
        capabilities: directory.capabilities,
        fileCount: directory.fileCount,
        directoryCount: directory.directoryCount,
        truncated: directory.truncated,
      },
    })),
    ...state.completedSteps.flatMap((step) => step.artifacts)
      .filter((artifact) => isDurableStepArtifact(artifact))
      .map((artifact) => ({
        assetId: stableAssetId("artifact", artifact),
        kind: inferPathAssetKind(artifact),
        origin: "agent_generated" as const,
        role: "working_artifact" as const,
        displayName: artifact.split("/").pop() || artifact,
        path: artifact,
        restore: inferPathAssetKind(artifact) === "directory"
          ? { directoryPath: artifact }
          : { filePath: artifact },
        sourceRunId: state.runId,
        sourceRunPath: state.runPath,
        lastUsedRunId: state.runId,
        lastUsedAt: now,
      })),
  ]);
}

function attachmentRecordToFocusAsset(
  record: PreparedAttachmentRecord,
  runId: string,
  runPath: string,
  now: string,
): FocusAssetRef {
  const kind = record.summary.mode === "structured_data" ? "dataset" : "document";
  return {
    assetId: stableAssetId(kind, record.summary.documentId),
    kind,
    origin: "user_attached",
    role: "input",
    displayName: record.summary.displayName,
    documentId: record.summary.documentId,
    preparedInputId: record.summary.preparedInputId,
    manifest: record.manifest,
    summary: record.summary,
    detail: record.detail,
    restore: {
      documentId: record.summary.documentId,
      preparedInputId: record.summary.preparedInputId,
      manifestPath: record.summary.artifactPath,
    },
    sourceRunId: runId,
    sourceRunPath: runPath,
    lastUsedRunId: runId,
    lastUsedAt: now,
    metadata: {
      action: "prepared",
      mode: record.summary.mode,
    },
  };
}

function dedupeFocusAssets(assets: FocusAssetRef[]): FocusAssetRef[] {
  const output = new Map<string, FocusAssetRef>();
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

function inferPathAssetKind(path: string): FocusAssetRef["kind"] {
  if (/\.(?:html|css|js|jsx|ts|tsx|json|md|txt|py|sql|csv|pdf|png|jpg|jpeg|svg)$/i.test(path)) {
    return "file";
  }
  return "directory";
}

function stableAssetId(kind: string, identity: string): string {
  return `asset_${createHash("sha256").update(`${kind}:${identity}`).digest("hex").slice(0, 20)}`;
}

function normalizeList(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter((value) => value.length > 0))];
}
