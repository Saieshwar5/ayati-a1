import { readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { devLog, devWarn } from "../shared/index.js";
import type {
  AgentLoopDeps,
  AgentLoopResult,
  AgentTaskSummaryRecord,
  LoopState,
  LoopConfig,
  ControllerOutput,
  ContextSearchDirective,
  UnderstandDirective,
  ReEvalDirective,
  ReadRunStateDirective,
  ActivateSkillDirective,
  StepDirective,
  CompletionDirective,
  ScoutResult,
  GoalContract,
  TaskValidationContext,
  PreparedAttachmentStateUpdate,
  RecentContextSearch,
  RecentContextSearchStatus,
} from "./types.js";
import { DEFAULT_LOOP_CONFIG, RECENT_TASK_SELECTION_LIMIT } from "./types.js";

function isContextSearchDirective(output: ControllerOutput): output is ContextSearchDirective {
  return !output.done && "context_search" in output && (output as ContextSearchDirective).context_search === true;
}

function isReadRunStateDirective(output: unknown): output is ReadRunStateDirective {
  return !!output
    && typeof output === "object"
    && !Array.isArray(output)
    && "read_run_state" in output
    && (output as ReadRunStateDirective).read_run_state === true;
}

function isActivateSkillDirective(output: unknown): output is ActivateSkillDirective {
  return !!output
    && typeof output === "object"
    && !Array.isArray(output)
    && "activate_skill" in output
    && (output as ActivateSkillDirective).activate_skill === true;
}

function truncateControllerLogValue(value: string | undefined, maxLen = 140): string {
  const normalized = (value ?? "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLen) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLen - 3))}...`;
}

function formatReadRunStateTarget(directive: ReadRunStateDirective): string {
  if (directive.action === "read_step_full") {
    return `step=${directive.step ?? "missing"}`;
  }

  const from = directive.window?.from ?? "?";
  const to = directive.window?.to ?? "?";
  return `window=${from}..${to}`;
}

function summarizeStepTools(directive: StepDirective): string {
  const tools = directive.tool_plan?.map((call) => call.tool) ?? [];
  return tools.length > 0 ? tools.join(",") : "(none)";
}

function logUnderstandDirective(clientId: string, directive: UnderstandDirective | CompletionDirective): void {
  if (directive.done) {
    devLog(
      `[${clientId}] [controller] understand -> completion status=${directive.status} response_kind=${directive.response_kind ?? "reply"} summary="${truncateControllerLogValue(directive.summary, 120)}"`,
    );
    return;
  }

  devLog(
    `[${clientId}] [controller] understand -> task objective="${truncateControllerLogValue(directive.goal.objective, 120)}" dependent_task=${directive.dependent_task} work_mode=${directive.work_mode ?? "none"}`,
  );
}

function logDirectDirective(
  clientId: string,
  directive: StepDirective | ReadRunStateDirective | ActivateSkillDirective | CompletionDirective,
): void {
  if (directive.done) {
    devLog(
      `[${clientId}] [controller] direct -> completion status=${directive.status} response_kind=${directive.response_kind ?? "reply"} summary="${truncateControllerLogValue(directive.summary, 120)}"`,
    );
    return;
  }

  if (isReadRunStateDirective(directive)) {
    devLog(
      `[${clientId}] [controller] direct -> read_run_state action=${directive.action} ${formatReadRunStateTarget(directive)} reason="${truncateControllerLogValue(directive.reason, 120)}"`,
    );
    return;
  }

  if (isActivateSkillDirective(directive)) {
    devLog(
      `[${clientId}] [controller] direct -> activate_skill skill_id=${directive.skill_id} reason="${truncateControllerLogValue(directive.reason, 120)}"`,
    );
    return;
  }

  devLog(
    `[${clientId}] [controller] direct -> step execution_mode=${directive.execution_mode} tools=${summarizeStepTools(directive)} contract="${truncateControllerLogValue(directive.execution_contract || directive.intent, 120)}"`,
  );
}

function logReEvalDirective(clientId: string, directive: ReEvalDirective | ReadRunStateDirective | CompletionDirective): void {
  if (directive.done) {
    devLog(
      `[${clientId}] [controller] reeval -> completion status=${directive.status} response_kind=${directive.response_kind ?? "reply"} summary="${truncateControllerLogValue(directive.summary, 120)}"`,
    );
    return;
  }

  if (isReadRunStateDirective(directive)) {
    devLog(
      `[${clientId}] [controller] reeval -> read_run_state action=${directive.action} ${formatReadRunStateTarget(directive)} reason="${truncateControllerLogValue(directive.reason, 120)}"`,
    );
    return;
  }

  devLog(
    `[${clientId}] [controller] reeval -> approach "${truncateControllerLogValue(directive.approach, 140)}"`,
  );
}

import { initRunDirectory, queueStateWrite, flushStateWrites } from "./state-persistence.js";
import { callUnderstand, callReEval, callDirect } from "./controller.js";
import { executeStep } from "./executor.js";
import { runContextScout } from "./context-scout.js";
import { RunStateManager } from "./run-state-manager.js";
import { collectAgentArtifacts } from "./agent-artifacts.js";
import type { ToolDefinition, ToolExecutionContext } from "../skills/types.js";
import type { ExternalSkillCard } from "../skills/external/registry.js";
import type { ActiveExternalSkillContext } from "../skills/external/broker.js";
import { prepareIncomingAttachments } from "../documents/attachment-preparer.js";
import type { ManagedDocumentManifest, PreparedAttachmentSummary } from "../documents/types.js";
import type { ScoutKnownLocations } from "./context-scout.js";

export async function agentLoop(deps: AgentLoopDeps): Promise<AgentLoopResult> {
  const config: LoopConfig = { ...DEFAULT_LOOP_CONFIG, ...deps.config };
  validateLoopConfig(config);
  const runId = deps.runHandle.runId;
  const runPath = initRunDirectory(deps.dataDir, runId);
  const runStateManager = new RunStateManager(runPath);
  await runStateManager.ready();
  const currentToolExecutionContext = currentToolRegistryContextFactory(deps);
  const currentToolRegistryContext = currentToolExecutionContext;

  let totalToolCalls = 0;

  const state: LoopState = {
    runId,
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
    approach: "",
    sessionContextSummary: "",
    dependentTask: false,
    dependentTaskSummary: null,
    taskProgress: emptyTaskProgress(),
    status: "running",
    finalOutput: "",
    iteration: 0,
    maxIterations: config.maxIterations,
    consecutiveFailures: 0,
    approachChangeCount: 0,
    completedSteps: [],
    recentContextSearches: [],
    runPath,
    failedApproaches: [],
    attachedDocuments: deps.attachedDocuments ?? [],
    attachmentWarnings: deps.attachmentWarnings ?? [],
    preparedAttachments: [],
    activeSessionAttachments: [],
    sessionHistory: [],
    recentRunLedgers: [],
    recentTaskSummaries: [],
    recentSystemActivity: [],
  };

  const queueStateSnapshot = (): void => {
    void queueStateWrite(runPath, state).catch((error) => {
      devWarn(
        `[${deps.clientId}] failed to persist run state snapshot: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  };

  const finalizeLoopResult = async (input: Parameters<typeof buildLoopResult>[1]): Promise<AgentLoopResult> => {
    queueStateSnapshot();
    await flushStateWrites(runPath);
    deps.externalSkillBroker?.deactivate({}, currentToolExecutionContext(state.iteration));
    return buildLoopResult(state, input);
  };

  const resolveVisibleToolDefinitions = (stepNumber?: number): ToolDefinition[] => deps.toolExecutor?.definitions(
    currentToolRegistryContext(stepNumber),
  ) ?? deps.toolDefinitions;
  const resolveExternalSkillCards = () => deps.externalSkillRegistry?.getSkillCards();
  const resolveActiveExternalSkills = (stepNumber?: number) => deps.externalSkillBroker?.getActiveSkillContexts(
    currentToolExecutionContext(stepNumber),
  );
  const resolveControllerRuntimeSnapshot = (): ControllerRuntimeSnapshot => ({
    toolDefinitions: resolveVisibleToolDefinitions(state.iteration),
    externalSkillCards: resolveExternalSkillCards(),
    activeExternalSkills: resolveActiveExternalSkills(state.iteration),
    toolExecutionContext: currentToolExecutionContext(state.iteration),
  });

  // Populate user message and session history from sessionMemory context
  state.userMessage = getPrimaryUserMessage(deps);
  syncTransientMemoryContext(state, deps);
  devLog(
    `[${deps.clientId}] agentLoop start inputKind=${state.inputKind ?? "user_message"} runHandle=${deps.runHandle.runId} message=${state.userMessage.slice(0, 160)}`,
  );
  if (state.inputKind === "system_event" && state.systemEvent) {
    devLog(
      `[${deps.clientId}] agentLoop system_event payload source=${state.systemEvent.source} eventName=${state.systemEvent.eventName} eventId=${state.systemEvent.eventId} payloadKeys=${Object.keys(state.systemEvent.payload).join(",") || "none"}`,
    );
  }

  queueStateSnapshot();
  deps.sessionMemory.recordRunLedger?.(deps.clientId, {
    runId: deps.runHandle.runId,
    sessionId: deps.runHandle.sessionId,
    runPath,
    state: "started",
  });

  const preparableDocuments = (state.attachedDocuments ?? []).filter((document) => document.kind !== "image");
  if (preparableDocuments.length > 0 && deps.documentStore && deps.preparedAttachmentRegistry) {
    const prepared = await prepareIncomingAttachments({
      attachedDocuments: preparableDocuments,
      runId,
      runPath,
      documentStore: deps.documentStore,
      registry: deps.preparedAttachmentRegistry,
    });
    state.preparedAttachments = prepared.summaries;
    recordActiveSessionAttachments(deps, runId, runPath, "prepared");
    queueStateSnapshot();
  }

  // --- Understand stage (iteration 0) ---
  const systemContext = deps.systemContext ?? "";
  const controllerSystemContext = deps.controllerSystemContext ?? systemContext;
  const understandResult = await callUnderstand(
    deps.provider,
    state,
    resolveVisibleToolDefinitions(),
    systemContext,
    deps.controllerPrompts,
    resolveExternalSkillCards(),
  );
  logUnderstandDirective(deps.clientId, understandResult);

  if (understandResult.done) {
    state.status = understandResult.status === "failed" ? "failed" : "completed";
    state.finalOutput = understandResult.summary;
    return finalizeLoopResult({
      dataDir: deps.dataDir,
      completion: understandResult,
      status: state.status,
      totalIterations: 0,
      totalToolCalls: 0,
    });
  }

  // Store understand output on state
  state.runClass = "task";
  state.goal = understandResult.goal;
  state.approach = understandResult.approach;
  state.sessionContextSummary = understandResult.session_context_summary.trim();
  state.dependentTask = understandResult.dependent_task;
  state.dependentTaskSummary = understandResult.dependent_task
    ? resolveDependentTaskSummary(state.recentTaskSummaries, understandResult.dependent_task_slot)
    : null;
  state.workMode = understandResult.work_mode;
  queueStateSnapshot();

  // --- Main loop: direct stage ---
  let lastDirective: StepDirective | undefined;

  while (state.status === "running" && state.iteration < config.maxIterations) {
    if (deps.signal?.aborted) {
      const finalOutput = "Agent was stopped.";
      state.status = "failed";
      state.finalOutput = finalOutput;
      return finalizeLoopResult({
        dataDir: deps.dataDir,
        status: "failed",
        content: finalOutput,
        totalIterations: state.iteration,
        totalToolCalls,
      });
    }
    syncTransientMemoryContext(state, deps);

    state.iteration++;

    // Re-evaluation after the configured number of consecutive failures
    if (state.consecutiveFailures >= config.approachReevalThreshold) {
      if (state.approachChangeCount >= config.maxApproachChanges) {
        const finalOutput = `I couldn't complete the task after changing approach ${config.maxApproachChanges} times.`;
        state.status = "failed";
        state.finalOutput = finalOutput;
        return finalizeLoopResult({
          dataDir: deps.dataDir,
          status: "failed",
          content: finalOutput,
          totalIterations: state.iteration,
          totalToolCalls,
        });
      }

      const reevalResolution = await resolveReEvalDirective(
        deps,
        state,
        runStateManager,
        controllerSystemContext,
        resolveVisibleToolDefinitions(state.iteration),
        resolveExternalSkillCards(),
        resolveActiveExternalSkills(state.iteration),
      );
      if (reevalResolution.type === "done") {
        state.status = reevalResolution.completion.status === "failed" ? "failed" : "completed";
        state.finalOutput = reevalResolution.completion.summary;
        return finalizeLoopResult({
          dataDir: deps.dataDir,
          completion: reevalResolution.completion,
          status: state.status,
          content: state.finalOutput,
          totalIterations: state.iteration,
          totalToolCalls,
        });
      }

      if (reevalResolution.type === "failed") {
        state.status = "failed";
        state.finalOutput = reevalResolution.message;
        return finalizeLoopResult({
          dataDir: deps.dataDir,
          status: "failed",
          content: state.finalOutput,
          totalIterations: state.iteration,
          totalToolCalls,
        });
      }

      const nextApproach = reevalResolution.directive.approach.trim();
      if (nextApproach.length === 0 || normalizeApproach(nextApproach) === normalizeApproach(state.approach)) {
        const finalOutput = "I couldn't find a different working approach after the latest failure.";
        state.status = "failed";
        state.finalOutput = finalOutput;
        return finalizeLoopResult({
          dataDir: deps.dataDir,
          status: "failed",
          content: finalOutput,
          totalIterations: state.iteration,
          totalToolCalls,
        });
      }

      state.approach = nextApproach;
      state.approachChangeCount++;
      state.consecutiveFailures = 0;
      queueStateSnapshot();
    }

    const controllerResolution = await resolveControllerDirective(
      deps,
      state,
      runStateManager,
      controllerSystemContext,
      resolveControllerRuntimeSnapshot,
    );
    if (controllerResolution.type === "done") {
      state.status = controllerResolution.completion.status === "failed" ? "failed" : "completed";
      state.finalOutput = controllerResolution.completion.summary;
      return finalizeLoopResult({
        dataDir: deps.dataDir,
        completion: controllerResolution.completion,
        status: state.status,
        content: state.finalOutput,
        totalIterations: state.iteration,
        totalToolCalls,
      });
    }

    if (controllerResolution.type === "failed") {
      state.status = "failed";
      state.finalOutput = controllerResolution.message;
      return finalizeLoopResult({
        dataDir: deps.dataDir,
        status: "failed",
        content: state.finalOutput,
        totalIterations: state.iteration,
        totalToolCalls,
      });
    }

    const controllerOutput = controllerResolution.directive;
    lastDirective = controllerOutput;

    const executedStep = await executeStep(
      {
        provider: deps.provider,
        toolExecutor: deps.toolExecutor,
        toolDefinitions: resolveVisibleToolDefinitions(state.iteration),
        config,
        clientId: deps.clientId,
        sessionMemory: deps.sessionMemory,
        runHandle: deps.runHandle,
        taskContext: buildTaskValidationContext(state),
      },
      controllerOutput,
      state.iteration,
      runPath,
    );
    const {
      stepRecord,
      fullStepText,
      ...stepSummary
    } = executedStep;

    applyPreparedAttachmentStateUpdates(
      state,
      deps.preparedAttachmentRegistry,
      deps.runHandle.runId,
      stepSummary.stateUpdates ?? [],
    );
    if ((stepSummary.stateUpdates ?? []).some((update) => update.type === "restore_prepared_attachment")) {
      recordActiveSessionAttachments(deps, runId, runPath, "restored");
    }

    state.completedSteps.push(stepSummary);
    if (stepSummary.taskProgress) {
      state.taskProgress = stepSummary.taskProgress;
    }

    await runStateManager.appendStepRecord(stepRecord, fullStepText);

    const stepToolCalls = stepSummary.toolSuccessCount + stepSummary.toolFailureCount;
    totalToolCalls += stepToolCalls > 0 ? stepToolCalls : 1;

    deps.toolExecutor?.cleanupExpired?.({
      clientId: deps.clientId,
      runId: deps.runHandle.runId,
      sessionId: deps.runHandle.sessionId,
      stepNumber: state.iteration,
    });
    deps.externalSkillBroker?.cleanupExpired?.(currentToolExecutionContext(state.iteration));

      if (stepSummary.outcome === "failed") {
      state.consecutiveFailures++;

      const fallbackReason = `failureType=${stepSummary.failureType ?? "verify_failed"}; stop=${stepSummary.stoppedEarlyReason ?? "none"}; tool_success=${stepSummary.toolSuccessCount}; tool_failed=${stepSummary.toolFailureCount}`;
      const failureReason = stepSummary.summary.trim().length > 0
        ? stepSummary.summary.slice(0, 300)
        : fallbackReason;

      state.failedApproaches.push({
        step: stepSummary.step,
        executionContract: stepSummary.executionContract,
        failureType: stepSummary.failureType ?? "verify_failed",
        reason: failureReason,
        blockedTargets: stepSummary.blockedTargets ?? [],
      });

      if (state.consecutiveFailures >= config.maxConsecutiveFailures - 1) {
        deps.onStuck?.(state);
      }
      if (state.consecutiveFailures >= config.maxConsecutiveFailures) {
        state.status = "failed";
      }
    } else {
      state.consecutiveFailures = 0;
    }

    queueStateSnapshot();
    deps.onProgress?.(
      `Step ${state.iteration}: ${stepSummary.executionContract} → ${stepSummary.outcome}`,
      runPath,
    );
  }

  const finalOutput = "I've exhausted my reasoning steps. Here's what I found so far based on my analysis.";
  state.status = "failed";
  state.finalOutput = finalOutput;
  return finalizeLoopResult({
    dataDir: deps.dataDir,
    status: "stuck",
    content: finalOutput,
    totalIterations: state.iteration,
    totalToolCalls,
  });
}

function validateLoopConfig(config: LoopConfig): void {
  if (!Number.isInteger(config.approachReevalThreshold) || config.approachReevalThreshold < 1) {
    throw new Error("Invalid loop config: approachReevalThreshold must be an integer greater than or equal to 1.");
  }

  if (!Number.isInteger(config.maxConsecutiveFailures) || config.maxConsecutiveFailures < 1) {
    throw new Error("Invalid loop config: maxConsecutiveFailures must be an integer greater than or equal to 1.");
  }

  if (config.approachReevalThreshold >= config.maxConsecutiveFailures) {
    throw new Error(
      "Invalid loop config: approachReevalThreshold must be less than maxConsecutiveFailures.",
    );
  }
}

function currentToolRegistryContextFactory(
  deps: AgentLoopDeps,
): (stepNumber?: number) => ToolExecutionContext {
  return (stepNumber?: number) => ({
    clientId: deps.clientId,
    runId: deps.runHandle.runId,
    sessionId: deps.runHandle.sessionId,
    ...(typeof stepNumber === "number" ? { stepNumber } : {}),
  });
}

type ControllerResolution =
  | { type: "step"; directive: StepDirective }
  | { type: "done"; completion: CompletionDirective }
  | { type: "failed"; message: string };

type ReEvalResolution =
  | { type: "reeval"; directive: ReEvalDirective }
  | { type: "done"; completion: CompletionDirective }
  | { type: "failed"; message: string };

const MAX_INLINE_CONTROLLER_PREP_DIRECTIVES = 4;

interface ControllerRuntimeSnapshot {
  toolDefinitions: ToolDefinition[];
  externalSkillCards?: ExternalSkillCard[];
  activeExternalSkills?: ActiveExternalSkillContext[];
  toolExecutionContext: ToolExecutionContext;
}

type ControllerRuntimeSnapshotResolver = () => ControllerRuntimeSnapshot;

type ContextSearchBudget = { used: number };

interface DocumentScoutSessionState {
  bestResult?: ScoutResult;
  latestResult?: ScoutResult;
  executedQueries: string[];
  blockedRequests: number;
}

interface SkillsScoutEntry {
  normalizedQuery: string;
  queryTokens: string[];
  result: ScoutResult;
  coveredSkillKeys: string[];
  coveredSkillTokens: string[];
}

interface KnownSkillRef {
  raw: string;
  key: string;
  tokens: string[];
}

interface SkillsScoutSessionState {
  entries: SkillsScoutEntry[];
  blockedRequests: number;
  knownSkills: KnownSkillRef[];
}

type ContextAwareDirective = StepDirective | ReEvalDirective;

type ContextAwareResolution =
  | { type: "directive"; directive: ContextAwareDirective }
  | { type: "done"; completion: CompletionDirective }
  | { type: "failed"; message: string };

async function resolveControllerDirective(
  deps: AgentLoopDeps,
  state: LoopState,
  runStateManager: RunStateManager,
  systemContext: string,
  resolveRuntimeSnapshot: ControllerRuntimeSnapshotResolver,
): Promise<ControllerResolution> {
  const controllerHistoryBundle = await runStateManager.buildControllerHistoryBundle(state.completedSteps);
  const prepContext: string[] = [];
  const seenReadRunStateRequests = new Set<string>();
  const seenActivateSkillRequests = new Set<string>();

  while (prepContext.length < MAX_INLINE_CONTROLLER_PREP_DIRECTIVES + 1) {
    const runtimeSnapshot = resolveRuntimeSnapshot();
    const resolution = await callDirect(
      deps.provider,
      state,
      runtimeSnapshot.toolDefinitions,
      controllerHistoryBundle,
      deps.controllerPrompts,
      systemContext,
      deps.config?.approachReevalThreshold,
      runtimeSnapshot.externalSkillCards,
      runtimeSnapshot.activeExternalSkills,
      prepContext.join("\n\n"),
    );
    logDirectDirective(deps.clientId, resolution);

    if (resolution.done) {
      return {
        type: "done",
        completion: resolution,
      };
    }

    if (isReadRunStateDirective(resolution)) {
      if (prepContext.length >= MAX_INLINE_CONTROLLER_PREP_DIRECTIVES) {
        devWarn(
          `[${deps.clientId}] [controller] direct prep limit exceeded while handling ${buildReadRunStateRequestKey(resolution)}`,
        );
        return {
          type: "failed",
          message: `I couldn't progress because the controller requested too many inline prep directives in one direct resolution (limit ${MAX_INLINE_CONTROLLER_PREP_DIRECTIVES}).`,
        };
      }

      const requestKey = buildReadRunStateRequestKey(resolution);
      if (seenReadRunStateRequests.has(requestKey)) {
        devWarn(
          `[${deps.clientId}] [controller] direct repeated prep directive read_run_state request=${requestKey}`,
        );
        return {
          type: "failed",
          message: "I couldn't progress because the controller repeated the same read_run_state request in one direct resolution.",
        };
      }
      seenReadRunStateRequests.add(requestKey);

      const retrievedContext = await buildReadRunStateContext(runStateManager, resolution);
      prepContext.push(retrievedContext);
      devLog(
        `[${deps.clientId}] [controller] direct prep appended read_run_state request=${requestKey} chars=${retrievedContext.length}`,
      );
      continue;
    }

    if (isActivateSkillDirective(resolution)) {
      if (prepContext.length >= MAX_INLINE_CONTROLLER_PREP_DIRECTIVES) {
        devWarn(
          `[${deps.clientId}] [controller] direct prep limit exceeded while handling activate_skill:${buildActivateSkillRequestKey(resolution)}`,
        );
        return {
          type: "failed",
          message: `I couldn't progress because the controller requested too many inline prep directives in one direct resolution (limit ${MAX_INLINE_CONTROLLER_PREP_DIRECTIVES}).`,
        };
      }

      const requestKey = buildActivateSkillRequestKey(resolution);
      if (seenActivateSkillRequests.has(requestKey)) {
        devWarn(
          `[${deps.clientId}] [controller] direct repeated prep directive activate_skill request=${requestKey}`,
        );
        return {
          type: "failed",
          message: "I couldn't progress because the controller repeated the same activate_skill request in one direct resolution.",
        };
      }
      seenActivateSkillRequests.add(requestKey);

      const activationResult = await buildActivateSkillContext(
        deps,
        resolution,
        resolveRuntimeSnapshot,
      );
      prepContext.push(activationResult.context);
      devLog(
        `[${deps.clientId}] [controller] direct prep appended activate_skill request=${requestKey} status=${activationResult.status} already_active=${activationResult.alreadyActive} mounted_tools=${formatPrepListValue(activationResult.mountedTools)} evicted_skills=${formatPrepListValue(activationResult.evictedSkills)} evicted_tools=${formatPrepListValue(activationResult.evictedTools)}${activationResult.error ? ` error="${truncateControllerLogValue(activationResult.error, 120)}"` : ""}`,
      );
      continue;
    }

    return { type: "step", directive: resolution };
  }

  return {
    type: "failed",
    message: `I couldn't progress because the controller requested too many inline prep directives in one direct resolution (limit ${MAX_INLINE_CONTROLLER_PREP_DIRECTIVES}).`,
  };
}

async function resolveReEvalDirective(
  deps: AgentLoopDeps,
  state: LoopState,
  runStateManager: RunStateManager,
  systemContext: string,
  toolDefinitions: ToolDefinition[],
  externalSkillCards?: ReturnType<NonNullable<AgentLoopDeps["externalSkillRegistry"]>["getSkillCards"]>,
  activeExternalSkills?: ReturnType<NonNullable<AgentLoopDeps["externalSkillBroker"]>["getActiveSkillContexts"]>,
): Promise<ReEvalResolution> {
  const prepContext: string[] = [];
  const seenReadRunStateRequests = new Set<string>();

  while (prepContext.length < MAX_INLINE_CONTROLLER_PREP_DIRECTIVES + 1) {
    const resolution = await callReEval(
      deps.provider,
      state,
      toolDefinitions,
      deps.controllerPrompts,
      systemContext,
      externalSkillCards,
      activeExternalSkills,
      prepContext.join("\n\n"),
    );
    logReEvalDirective(deps.clientId, resolution);

    if (resolution.done) {
      return {
        type: "done",
        completion: resolution,
      };
    }

    if (isReadRunStateDirective(resolution)) {
      if (prepContext.length >= MAX_INLINE_CONTROLLER_PREP_DIRECTIVES) {
        devWarn(
          `[${deps.clientId}] [controller] reeval prep limit exceeded while handling ${buildReadRunStateRequestKey(resolution)}`,
        );
        return {
          type: "failed",
          message: `I couldn't progress because the controller requested too many inline prep directives in one reeval resolution (limit ${MAX_INLINE_CONTROLLER_PREP_DIRECTIVES}).`,
        };
      }

      const requestKey = buildReadRunStateRequestKey(resolution);
      if (seenReadRunStateRequests.has(requestKey)) {
        devWarn(
          `[${deps.clientId}] [controller] reeval repeated prep directive read_run_state request=${requestKey}`,
        );
        return {
          type: "failed",
          message: "I couldn't progress because the controller repeated the same read_run_state request in one reeval resolution.",
        };
      }
      seenReadRunStateRequests.add(requestKey);

      const retrievedContext = await buildReadRunStateContext(runStateManager, resolution);
      prepContext.push(retrievedContext);
      devLog(
        `[${deps.clientId}] [controller] reeval prep appended read_run_state request=${requestKey} chars=${retrievedContext.length}`,
      );
      continue;
    }

    if (!("reeval" in resolution) || resolution.reeval !== true) {
      return {
        type: "failed",
        message: "I couldn't determine a revised approach after the latest failure.",
      };
    }

    return { type: "reeval", directive: resolution };
  }

  return {
    type: "failed",
    message: `I couldn't progress because the controller requested too many inline prep directives in one reeval resolution (limit ${MAX_INLINE_CONTROLLER_PREP_DIRECTIVES}).`,
  };
}

function buildReadRunStateRequestKey(directive: ReadRunStateDirective): string {
  if (directive.action === "read_step_full") {
    return `read_step_full:${directive.step ?? "missing"}`;
  }

  const from = Math.min(directive.window?.from ?? 0, directive.window?.to ?? 0);
  const to = Math.max(directive.window?.from ?? 0, directive.window?.to ?? 0);
  return `read_summary_window:${from}:${to}`;
}

function buildActivateSkillRequestKey(directive: ActivateSkillDirective): string {
  return directive.skill_id.trim().toLowerCase();
}

function formatPrepListValue(values: string[]): string {
  return values.length > 0 ? values.join(",") : "(none)";
}

async function buildReadRunStateContext(
  runStateManager: RunStateManager,
  directive: ReadRunStateDirective,
): Promise<string> {
  if (directive.action === "read_step_full") {
    const step = directive.step ?? 0;
    const result = await runStateManager.readStepFull(step);
    if (!result) {
      return `Retrieved run state for read_step_full:
- Requested step ${step} was not found in the active run.`;
    }

    return [
      "Retrieved run state:",
      `- action: read_step_full`,
      `- step: ${result.step}`,
      `- executionContract: ${result.record.executionContract || "(none)"}`,
      `- outcome: ${result.record.outcome}`,
      `- summary: ${result.record.summary || "(none)"}`,
      `- keyFacts: ${result.record.newFacts.slice(0, 4).join(" | ") || "(none)"}`,
      `- evidence: ${result.record.evidenceItems.slice(0, 4).join(" | ") || "(none)"}`,
      `- blockedTargets: ${(result.record.blockedTargets ?? []).slice(0, 4).join(" | ") || "(none)"}`,
    ].join("\n");
  }

  const window = directive.window ?? { from: 1, to: 1 };
  const result = await runStateManager.readSummaryWindow(window);
  const stepLines = result.steps.length > 0
    ? result.steps.map((step) => `  - step=${step.step} outcome=${step.outcome} contract=${step.executionContract || "(none)"} summary=${step.summary || "(none)"} keyFacts=${step.keyFacts.slice(0, 3).join(" | ") || "(none)"} evidence=${step.evidence.slice(0, 3).join(" | ") || "(none)"}`)
    : ["  - no recorded steps in that window"];

  return [
    "Retrieved run state:",
    `- action: read_summary_window`,
    `- window: ${result.window.from}..${result.window.to}`,
    ...stepLines,
  ].join("\n");
}

async function buildActivateSkillContext(
  deps: AgentLoopDeps,
  directive: ActivateSkillDirective,
  resolveRuntimeSnapshot: ControllerRuntimeSnapshotResolver,
): Promise<{
  context: string;
  status: string;
  alreadyActive: boolean;
  mountedTools: string[];
  evictedSkills: string[];
  evictedTools: string[];
  error?: string;
}> {
  let status = "failed";
  let alreadyActive = false;
  let activationBrief: string | undefined;
  let mountedTools: string[] = [];
  let evictedSkills: string[] = [];
  let evictedTools: string[] = [];
  let error: string | undefined;

  if (!deps.externalSkillBroker) {
    error = "External skill activation is unavailable in this run.";
  } else {
    try {
      const activationResult = await deps.externalSkillBroker.activate(
        { skillId: directive.skill_id },
        resolveRuntimeSnapshot().toolExecutionContext,
      );

      if (!activationResult.ok || !activationResult.activation) {
        error = activationResult.error ?? `Failed to activate external skill "${directive.skill_id}".`;
      } else {
        status = activationResult.activation.status ?? "activated";
        alreadyActive = activationResult.activation.status === "already_active";
        activationBrief = activationResult.activation.activationBrief;
        mountedTools = activationResult.activation.activatedTools.map((entry) => entry.toolName);
        evictedSkills = [...(activationResult.activation.evictedSkills ?? [])];
        evictedTools = activationResult.activation.evictedTools.map((entry) => entry.toolName);
      }
    } catch (activationError) {
      error = activationError instanceof Error ? activationError.message : String(activationError);
    }
  }

  const refreshedSnapshot = resolveRuntimeSnapshot();
  const activeSkillLines = (refreshedSnapshot.activeExternalSkills ?? []).map((skill) =>
    `${skill.skillId} [${skill.toolNames.join(", ") || "(none)"}]`,
  );

  const lines = [
    "Retrieved skill activation:",
    "- action: activate_skill",
    `- skill_id: ${directive.skill_id}`,
    `- reason: ${directive.reason?.trim() || "(none)"}`,
    `- status: ${error ? "failed" : status}`,
    `- already_active: ${alreadyActive ? "true" : "false"}`,
    `- activation_brief: ${activationBrief?.trim() || "(none)"}`,
    `- mounted_tools: ${mountedTools.join(" | ") || "(none)"}`,
    `- evicted_skills: ${evictedSkills.join(" | ") || "(none)"}`,
    `- evicted_tools: ${evictedTools.join(" | ") || "(none)"}`,
    `- available_tools_now: ${refreshedSnapshot.toolDefinitions.map((tool) => tool.name).join(", ") || "(none)"}`,
    `- active_external_skills_now: ${activeSkillLines.join(" | ") || "(none)"}`,
  ];

  if (error) {
    lines.push(`- error: ${error}`);
  }

  return {
    context: lines.join("\n"),
    status: error ? "failed" : status,
    alreadyActive,
    mountedTools,
    evictedSkills,
    evictedTools,
    ...(error ? { error } : {}),
  };
}

async function resolveContextAwareController(
  deps: AgentLoopDeps,
  state: LoopState,
  config: LoopConfig,
  runPath: string,
  scoutBudget: ContextSearchBudget,
  initialScoutResult: ScoutResult | undefined,
  invoke: (scoutContext?: string) => Promise<ContextAwareDirective | ContextSearchDirective | CompletionDirective>,
): Promise<ContextAwareResolution> {
  const scoutLocations = buildScoutLocations(deps, state, runPath);
  const documentScout = createDocumentScoutSessionState(initialScoutResult, state.userMessage);
  const skillsScout = createSkillsScoutSessionState(scoutLocations);
  const priorGenericScoutResults = new Map<string, ScoutResult>();
  let scoutContext = buildCurrentScoutContext(initialScoutResult, documentScout);
  if (scoutContext) {
    devLog(
      `[context-search] seed scope=documents iteration=${state.iteration} query="${state.userMessage.replace(/\s+/g, " ").trim().slice(0, 140)}"`,
    );
  }

  while (true) {
    const controllerOutput = await invoke(scoutContext || undefined);

    if (controllerOutput.done) {
      return {
        type: "done",
        completion: controllerOutput,
      };
    }

    if (!isContextSearchDirective(controllerOutput)) {
      return { type: "directive", directive: controllerOutput as ContextAwareDirective };
    }

    devLog(
      `[context-search] requested iteration=${state.iteration} used=${scoutBudget.used}/${config.maxScoutCallsPerIteration} scope=${controllerOutput.scope} query="${controllerOutput.query.replace(/\s+/g, " ").trim().slice(0, 140)}"${controllerOutput.document_paths?.length ? ` document_paths=${controllerOutput.document_paths.join(",")}` : ""}`,
    );

    const documentDecision = decideDocumentContextSearch({
      state,
      documentScout,
      directive: controllerOutput,
    });
    if (documentDecision.type === "reuse") {
      scoutContext = documentDecision.context;
      continue;
    }
    if (documentDecision.type === "failed") {
      return { type: "failed", message: documentDecision.message };
    }

    const skillsDecision = decideSkillsContextSearch({
      skillsScout,
      directive: controllerOutput,
    });
    if (skillsDecision.type === "reuse") {
      scoutContext = buildCurrentScoutContext(skillsDecision.result, documentScout, skillsDecision.note);
      continue;
    }
    if (skillsDecision.type === "failed") {
      return { type: "failed", message: skillsDecision.message };
    }

    if (controllerOutput.scope !== "documents") {
      const repeatedKey = buildScoutAttemptKey(controllerOutput.scope, controllerOutput.query);
      const repeatedResult = priorGenericScoutResults.get(repeatedKey);
      if (isReusableNegativeScoutResult(repeatedResult)) {
        devLog(
          `[context-search] reusing prior negative result iteration=${state.iteration} scope=${controllerOutput.scope} query="${controllerOutput.query.replace(/\s+/g, " ").trim().slice(0, 140)}"`,
        );
        scoutContext = buildCurrentScoutContext(
          repeatedResult,
          documentScout,
          "Repeat blocked: do not run the same context_search again in this iteration. Narrow the query, change scope, or explain that nothing relevant was found.",
        );
        continue;
      }
    }

    if (scoutBudget.used >= config.maxScoutCallsPerIteration) {
      devWarn(
        `[context-search] limit exceeded iteration=${state.iteration} used=${scoutBudget.used} limit=${config.maxScoutCallsPerIteration} latest_scope=${controllerOutput.scope} latest_query="${controllerOutput.query.replace(/\s+/g, " ").trim().slice(0, 140)}"`,
      );
      return {
        type: "failed",
        message: `I couldn't progress because the controller requested context_search too many times in one iteration (limit ${config.maxScoutCallsPerIteration}, latest scope: ${controllerOutput.scope}).`,
      };
    }

    scoutBudget.used++;

    const result = await runContextScout(
      {
        provider: deps.provider,
        maxTurns: config.maxScoutTurns,
        documentContextBackend: deps.documentContextBackend,
      },
      controllerOutput.query,
      controllerOutput.scope,
      scoutLocations,
      controllerOutput.document_paths,
    );
    appendRecentContextSearch(state, controllerOutput.scope, controllerOutput.query, result);
    if (controllerOutput.scope !== "documents") {
      priorGenericScoutResults.set(
        buildScoutAttemptKey(controllerOutput.scope, controllerOutput.query),
        result,
      );
    }
    updateDocumentScoutSessionState(documentScout, controllerOutput.query, result);
    updateSkillsScoutSessionState(skillsScout, controllerOutput.query, result, controllerOutput.scope);
    scoutContext = buildCurrentScoutContext(result, documentScout);
  }
}

function appendRecentContextSearch(
  state: LoopState,
  scope: ContextSearchDirective["scope"],
  query: string,
  result: ScoutResult,
): void {
  const nextEntry: RecentContextSearch = {
    scope,
    query: query.trim(),
    status: deriveRecentContextSearchStatus(result),
    context: result.context,
    sources: uniqueStrings(result.sources.map(normalizePath)),
    confidence: clampConfidence(result.confidence),
    iteration: state.iteration,
  };
  const entryKey = buildRecentContextSearchKey(scope, query);
  const existing = state.recentContextSearches ?? [];
  const withoutDuplicate = existing.filter((entry) => buildRecentContextSearchKey(entry.scope, entry.query) !== entryKey);
  state.recentContextSearches = [...withoutDuplicate, nextEntry].slice(-5);
}

function deriveRecentContextSearchStatus(result: ScoutResult): RecentContextSearchStatus {
  const documentStatus = result.documentState?.status;
  if (documentStatus) {
    return documentStatus;
  }
  if (result.scoutState?.status === "empty" || result.scoutState?.status === "max_turns_exhausted") {
    return "empty";
  }
  return result.context.trim().length > 0 ? "success" : "empty";
}

function buildRecentContextSearchKey(scope: ContextSearchDirective["scope"], query: string): string {
  return `${scope}:${normalizeScoutQuery(query)}`;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function clampConfidence(value: number): number {
  return Math.min(1, Math.max(0, Number(value) || 0));
}

function formatScoutContext(result: ScoutResult, note?: string): string {
  const lines: string[] = [];

  if (result.documentState) {
    lines.push(`Document retrieval status: ${result.documentState.status}`);
  }

  const context = result.context.trim();
  if (context.length > 0) {
    lines.push(context);
  }

  if (note) {
    lines.push(note);
  }

  if (result.documentState?.warnings.length) {
    lines.push(`Warnings: ${result.documentState.warnings.join(" | ")}`);
  }

  if (lines.length === 0) return "";
  const sourceLine = result.sources.length > 0
    ? `Sources: ${result.sources.join(", ")}`
    : "";
  return `${lines.join("\n")} (confidence: ${result.confidence})${sourceLine ? `\n${sourceLine}` : ""}`;
}

function buildCurrentScoutContext(
  current: ScoutResult | undefined,
  documentScout: DocumentScoutSessionState,
  note?: string,
): string {
  const bestDocumentContext = documentScout.bestResult?.documentState
    ? formatScoutContext(documentScout.bestResult)
    : "";

  if (current?.documentState) {
    return bestDocumentContext || formatScoutContext(current, note);
  }

  if (current) {
    if (bestDocumentContext) {
      return `${bestDocumentContext}\n\nAdditional scout context:\n${formatScoutContext(current, note)}`;
    }
    return formatScoutContext(current, note);
  }

  return bestDocumentContext;
}

function buildScoutAttemptKey(scope: ContextSearchDirective["scope"], query: string): string {
  return `${scope}:${normalizeScoutQuery(query)}`;
}

function isReusableNegativeScoutResult(result: ScoutResult | undefined): result is ScoutResult {
  return result?.scoutState?.status === "empty" || result?.scoutState?.status === "max_turns_exhausted";
}

async function buildInitialDocumentScoutContext(
  deps: AgentLoopDeps,
  state: LoopState,
  config: LoopConfig,
  runPath: string,
) : Promise<ScoutResult | undefined> {
  const attachedDocuments = state.attachedDocuments ?? [];
  if (attachedDocuments.length === 0 || !deps.documentContextBackend) {
    return undefined;
  }

  const query = state.userMessage.trim();
  if (query.length === 0) {
    return undefined;
  }

  const locations = buildScoutLocations(deps, state, runPath);
  devLog(
    `[context-search] preload scope=documents query="${query.replace(/\s+/g, " ").trim().slice(0, 140)}" attached=${attachedDocuments.length}`,
  );
  const result = await runContextScout(
    {
      provider: deps.provider,
      maxTurns: config.maxScoutTurns,
      documentContextBackend: deps.documentContextBackend,
    },
    query,
    "documents",
    locations,
  );
  appendRecentContextSearch(state, "documents", query, result);

  devLog(
    `[context-search] preload-result scope=documents status=${result.documentState?.status ?? "unknown"} context=${result.context.trim().length > 0 ? "present" : "empty"} sources=${result.sources.length} confidence=${result.confidence.toFixed(3)}`,
  );
  return result;
}

function buildScoutLocations(deps: AgentLoopDeps, state: LoopState, runPath: string): ScoutKnownLocations {
  const memCtx = deps.sessionMemory.getPromptMemoryContext();
  const skillsDirs = [
    resolve(deps.dataDir, "skills"),
    resolve(homedir(), ".agents", "skills"),
  ];
  return {
    runPath,
    contextDir: resolve(deps.dataDir, "..", "context"),
    sessionPath: memCtx.activeSessionPath ?? undefined,
    sessionDir: resolve(deps.dataDir, "memory", "sessions"),
    skillsDir: skillsDirs[0],
    skillsDirs,
    documentsDir: join(deps.dataDir, "documents"),
    attachedDocuments: state.attachedDocuments ?? [],
    runId: deps.runHandle.runId,
    activeSessionId: deps.runHandle.sessionId,
  };
}

function syncTransientMemoryContext(state: LoopState, deps: AgentLoopDeps): void {
  const memCtx = deps.sessionMemory.getPromptMemoryContext();
  // Exclude the current user message from history only for actual user-message runs.
  state.sessionHistory = (memCtx.conversationTurns ?? []).filter((t) => {
    if (state.inputKind !== "user_message") {
      return true;
    }
    return !(t.role === "user" && t.content === state.userMessage);
  });
  state.recentRunLedgers = memCtx.recentRunLedgers ?? [];
  state.recentTaskSummaries = memCtx.recentTaskSummaries ?? [];
  state.activeSessionAttachments = memCtx.activeAttachments ?? [];
  state.recentSystemActivity = memCtx.recentSystemActivity ?? [];
}

function resolveDependentTaskSummary(
  recentTaskSummaries: LoopState["recentTaskSummaries"],
  slot: number | undefined,
): LoopState["dependentTaskSummary"] {
  if (!slot || slot < 1) return null;

  const match = recentTaskSummaries.slice(0, RECENT_TASK_SELECTION_LIMIT)[slot - 1];
  if (!match) return null;

  return clonePromptTaskSummary(match);
}

function clonePromptTaskSummary(summary: NonNullable<LoopState["dependentTaskSummary"]>): NonNullable<LoopState["dependentTaskSummary"]> {
  return {
    ...summary,
    completedMilestones: [...summary.completedMilestones],
    openWork: [...summary.openWork],
    blockers: [...summary.blockers],
    keyFacts: [...summary.keyFacts],
    evidence: [...summary.evidence],
    entityHints: summary.entityHints ? [...summary.entityHints] : undefined,
    goalDoneWhen: summary.goalDoneWhen ? [...summary.goalDoneWhen] : undefined,
    goalRequiredEvidence: summary.goalRequiredEvidence ? [...summary.goalRequiredEvidence] : undefined,
    attachmentNames: [...summary.attachmentNames],
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

function emptyTaskProgress(): LoopState["taskProgress"] {
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

function buildTaskValidationContext(state: LoopState): TaskValidationContext {
  const latestSuccessfulStep = findLatestSuccessfulStep(state);
  const recentSuccessfulSteps = state.completedSteps
    .filter((step) => step.outcome === "success")
    .slice(-5)
    .map((step) => ({
      step: step.step,
      executionContract: step.executionContract ?? "",
      summary: step.summary,
      evidenceItems: [...(step.evidenceItems ?? [])],
      taskFacts: [...step.newFacts],
      artifacts: [...step.artifacts],
    }));
  const recentFailedSteps = state.completedSteps
    .filter((step) => step.outcome === "failed")
    .slice(-5)
    .map((step) => ({
      step: step.step,
      executionContract: step.executionContract ?? "",
      summary: step.summary,
      evidenceItems: [...(step.evidenceItems ?? [])],
      taskFacts: [...step.newFacts],
      artifacts: [...step.artifacts],
      blockedTargets: [...(step.blockedTargets ?? [])],
      failureType: step.failureType,
    }));
  return {
    inputKind: state.inputKind,
    userMessage: state.userMessage,
    systemEvent: state.systemEvent,
    originSource: state.originSource,
    systemEventIntentKind: state.systemEventIntentKind,
    systemEventRequestedAction: state.systemEventRequestedAction,
    systemEventCreatedBy: state.systemEventCreatedBy,
    handlingMode: state.handlingMode,
    approvalRequired: state.approvalRequired,
    approvalState: state.approvalState,
    goal: state.goal,
    approach: state.approach,
    previousTaskProgress: state.taskProgress,
    recentSuccessfulSteps,
    recentFailedSteps,
    latestSuccessfulStep: latestSuccessfulStep
      ? {
        summary: latestSuccessfulStep.summary,
        evidenceItems: [...(latestSuccessfulStep.evidenceItems ?? [])],
        taskFacts: [...latestSuccessfulStep.newFacts],
        artifacts: [...latestSuccessfulStep.artifacts],
      }
      : {
        summary: "",
        evidenceItems: [],
        taskFacts: [],
        artifacts: [],
      },
    recentSuccessfulSummaries: buildRecentSuccessfulSummaries(state),
  };
}

function buildRecentStepDigests(state: LoopState): string[] {
  return state.completedSteps
    .slice(-5)
    .map((step) => {
      const summary = step.summary.trim().length > 0 ? step.summary.trim() : "(no summary)";
      return `step ${step.step}: ${step.executionContract} -> ${step.outcome} | ${summary.slice(0, 140)}`;
    });
}

function findLatestSuccessfulStep(state: LoopState): LoopState["completedSteps"][number] | undefined {
  return [...state.completedSteps].reverse().find((step) => step.outcome === "success");
}

function buildRecentSuccessfulSummaries(state: LoopState): string[] {
  return state.completedSteps
    .filter((step) => step.outcome === "success" && step.summary.trim().length > 0)
    .slice(-3)
    .map((step) => step.summary.trim());
}

function applyPreparedAttachmentStateUpdates(
  state: LoopState,
  registry: AgentLoopDeps["preparedAttachmentRegistry"] | undefined,
  runId: string,
  updates: PreparedAttachmentStateUpdate[],
): void {
  if (updates.length === 0) {
    return;
  }

  for (const update of updates) {
    if (update.type === "restore_prepared_attachment") {
      state.preparedAttachments = mergePreparedAttachmentSummary(state.preparedAttachments ?? [], update.summary);
      state.attachedDocuments = mergeManagedDocumentManifest(state.attachedDocuments ?? [], update.manifest);
      continue;
    }

    const attachment = state.preparedAttachments?.find((entry) => entry.preparedInputId === update.preparedInputId);
    if (attachment) {
      if (update.type === "mark_dataset_staged" && attachment.structured) {
        attachment.structured = {
          ...attachment.structured,
          staged: true,
          stagingDbPath: update.stagingDbPath ?? attachment.structured.stagingDbPath,
          stagingTableName: update.stagingTableName ?? attachment.structured.stagingTableName,
        };
      }
      if (update.type === "mark_document_indexed" && attachment.unstructured) {
        attachment.unstructured = {
          ...attachment.unstructured,
          indexed: true,
        };
      }
    }

    registry?.updateAttachmentSummary(runId, update.preparedInputId, (summary) => {
      if (update.type === "mark_dataset_staged" && summary.structured) {
        return {
          ...summary,
          structured: {
            ...summary.structured,
            staged: true,
            stagingDbPath: update.stagingDbPath ?? summary.structured.stagingDbPath,
            stagingTableName: update.stagingTableName ?? summary.structured.stagingTableName,
          },
        };
      }
      if (update.type === "mark_document_indexed" && summary.unstructured) {
        return {
          ...summary,
          unstructured: {
            ...summary.unstructured,
            indexed: true,
          },
        };
      }
      return summary;
    });
  }
}

function mergePreparedAttachmentSummary(existing: LoopState["preparedAttachments"], summary: PreparedAttachmentSummary): PreparedAttachmentSummary[] {
  const list = [...(existing ?? [])];
  const index = list.findIndex((entry) => entry.documentId === summary.documentId || entry.preparedInputId === summary.preparedInputId);
  if (index >= 0) {
    list[index] = summary;
    return list;
  }
  list.push(summary);
  return list;
}

function mergeManagedDocumentManifest(existing: LoopState["attachedDocuments"], manifest: ManagedDocumentManifest): ManagedDocumentManifest[] {
  const list = [...(existing ?? [])];
  const index = list.findIndex((entry) => entry.documentId === manifest.documentId);
  if (index >= 0) {
    list[index] = manifest;
    return list;
  }
  list.push(manifest);
  return list;
}

function recordActiveSessionAttachments(
  deps: AgentLoopDeps,
  runId: string,
  runPath: string,
  action: "prepared" | "restored" | "used",
): void {
  const records = deps.preparedAttachmentRegistry?.getRunAttachments(runId) ?? [];
  if (records.length === 0) {
    return;
  }
  deps.sessionMemory.recordActiveAttachments?.(deps.clientId, {
    runId,
    sessionId: deps.runHandle.sessionId,
    runPath,
    action,
    attachments: records.map((record) => ({
      manifest: record.manifest,
      summary: record.summary,
      detail: record.detail.payload,
    })),
  });
}

function normalizeApproach(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function createDocumentScoutSessionState(
  initialResult: ScoutResult | undefined,
  initialQuery: string,
): DocumentScoutSessionState {
  if (!initialResult?.documentState) {
    return {
      executedQueries: [],
      blockedRequests: 0,
    };
  }

  return {
    bestResult: initialResult,
    latestResult: initialResult,
    executedQueries: initialQuery.trim().length > 0 ? [normalizeScoutQuery(initialQuery)] : [],
    blockedRequests: 0,
  };
}

function updateDocumentScoutSessionState(
  session: DocumentScoutSessionState,
  query: string,
  result: ScoutResult,
): void {
  if (!result.documentState) {
    return;
  }

  const normalizedQuery = normalizeScoutQuery(query);
  if (normalizedQuery.length > 0 && !session.executedQueries.includes(normalizedQuery)) {
    session.executedQueries.push(normalizedQuery);
  }

  session.latestResult = result;
  session.bestResult = selectPreferredDocumentResult(session.bestResult, result);
}

function createSkillsScoutSessionState(locations: ScoutKnownLocations): SkillsScoutSessionState {
  return {
    entries: [],
    blockedRequests: 0,
    knownSkills: listKnownSkills(locations),
  };
}

function updateSkillsScoutSessionState(
  session: SkillsScoutSessionState,
  query: string,
  result: ScoutResult,
  scope: ContextSearchDirective["scope"],
): void {
  if (scope !== "skills" || !isPositiveGenericScoutResult(result)) {
    return;
  }

  const normalizedQuery = normalizeScoutQuery(query);
  if (normalizedQuery.length === 0) {
    return;
  }

  const coveredSkillKeys = uniqueStrings(extractSkillIdsFromSources(result.sources).map(normalizeSkillIdentifier));
  const coveredSkillTokens = uniqueStrings(coveredSkillKeys.flatMap(tokenizeSkillIdentifier));
  const queryTokens = tokenizeScoutQuery(normalizedQuery);
  const nextEntry: SkillsScoutEntry = {
    normalizedQuery,
    queryTokens,
    result,
    coveredSkillKeys,
    coveredSkillTokens,
  };

  session.entries = [
    ...session.entries.filter((entry) => entry.normalizedQuery !== normalizedQuery),
    nextEntry,
  ].slice(-5);
}

function isPositiveGenericScoutResult(result: ScoutResult): boolean {
  if (result.scoutState?.status === "empty" || result.scoutState?.status === "max_turns_exhausted") {
    return false;
  }

  return result.context.trim().length > 0 || result.sources.length > 0;
}

function decideSkillsContextSearch(input: {
  skillsScout: SkillsScoutSessionState;
  directive: ContextSearchDirective;
}): { type: "allow" } | { type: "reuse"; result: ScoutResult; note: string } | { type: "failed"; message: string } {
  if (input.directive.scope !== "skills") {
    return { type: "allow" };
  }

  const reusable = findReusableSkillsScoutEntry(input.skillsScout, input.directive.query);
  if (!reusable) {
    return { type: "allow" };
  }

  return reuseSkillsScoutContext(
    input.skillsScout,
    reusable.result,
    "Skill documentation for this request was already retrieved in this iteration. Do not run another skills context_search for the same skill docs; use the existing excerpts to plan the next step.",
    "existing-skill-docs",
  );
}

function findReusableSkillsScoutEntry(
  session: SkillsScoutSessionState,
  query: string,
): SkillsScoutEntry | undefined {
  const normalizedQuery = normalizeScoutQuery(query);
  if (normalizedQuery.length === 0) {
    return undefined;
  }

  const queryTokens = tokenizeScoutQuery(normalizedQuery);
  const requestedSkillKeys = extractRequestedSkillKeys(query, session.knownSkills);
  if (requestedSkillKeys.length > 0) {
    return session.entries.find((entry) => requestedSkillKeys.every((key) => entry.coveredSkillKeys.includes(key)));
  }

  return session.entries.find((entry) => {
    const priorTokens = new Set([...entry.queryTokens, ...entry.coveredSkillTokens]);
    const overlap = queryTokens.filter((token) => priorTokens.has(token));
    const novelTokens = queryTokens.filter((token) => !priorTokens.has(token));
    return overlap.length >= 2 && novelTokens.length < 2;
  });
}

function reuseSkillsScoutContext(
  session: SkillsScoutSessionState,
  result: ScoutResult,
  note: string,
  reason: string,
): { type: "reuse"; result: ScoutResult; note: string } | { type: "failed"; message: string } {
  session.blockedRequests++;
  devLog(
    `[context-search] skills reuse reason=${reason} blocked=${session.blockedRequests} confidence=${result.confidence.toFixed(3)} sources=${result.sources.length}`,
  );
  if (session.blockedRequests >= 3) {
    devWarn("[context-search] controller kept requesting redundant skills searches after skill docs were available");
    return {
      type: "failed",
      message: "I couldn't progress because the controller kept requesting redundant skills context_search calls after the needed skill documentation was already available.",
    };
  }

  return {
    type: "reuse",
    result,
    note,
  };
}

function listKnownSkills(locations: ScoutKnownLocations): KnownSkillRef[] {
  const roots = [
    ...(locations.skillsDirs ?? []),
    ...(locations.skillsDir ? [locations.skillsDir] : []),
  ];
  const skills: KnownSkillRef[] = [];

  for (const root of roots) {
    if (!root) {
      continue;
    }

    try {
      for (const entry of readdirSync(root)) {
        const fullPath = join(root, entry);
        let stat;
        try {
          stat = statSync(fullPath);
        } catch {
          continue;
        }
        if (!stat.isDirectory()) {
          continue;
        }

        const key = normalizeSkillIdentifier(entry);
        if (key.length === 0) {
          continue;
        }

        skills.push({
          raw: entry,
          key,
          tokens: tokenizeSkillIdentifier(entry),
        });
      }
    } catch {
      continue;
    }
  }

  const deduped = new Map<string, KnownSkillRef>();
  for (const skill of skills) {
    if (!deduped.has(skill.key)) {
      deduped.set(skill.key, skill);
    }
  }
  return [...deduped.values()];
}

function extractRequestedSkillKeys(query: string, knownSkills: KnownSkillRef[]): string[] {
  const queryTokens = new Set(tokenizeScoutQuery(normalizeScoutQuery(query)));
  return uniqueStrings(knownSkills
    .filter((skill) => skill.tokens.length > 0 && skill.tokens.every((token) => queryTokens.has(token)))
    .map((skill) => skill.key));
}

function extractSkillIdsFromSources(sources: string[]): string[] {
  return uniqueStrings(sources.map((source) => {
    const trimmed = source.trim();
    if (!trimmed) {
      return "";
    }

    const lower = basename(trimmed).toLowerCase();
    if (lower === "skill.md" || lower === "skill.markdown") {
      return basename(dirname(trimmed));
    }

    return basename(trimmed);
  }));
}

function normalizeSkillIdentifier(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function tokenizeSkillIdentifier(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2);
}

function isMateriallyBroaderSkillQuery(queryTokens: string[], entry: SkillsScoutEntry): boolean {
  const priorTokens = new Set([...entry.queryTokens, ...entry.coveredSkillTokens]);
  const novelTokens = queryTokens.filter((token) => !priorTokens.has(token));
  return novelTokens.length >= 2;
}

function selectPreferredDocumentResult(
  current: ScoutResult | undefined,
  candidate: ScoutResult,
): ScoutResult {
  if (!candidate.documentState) return current ?? candidate;
  if (!current?.documentState) return candidate;

  const currentRank = documentStatusRank(current.documentState.status);
  const candidateRank = documentStatusRank(candidate.documentState.status);
  if (candidateRank > currentRank) return candidate;
  if (candidateRank < currentRank) return current;

  if (candidate.confidence > current.confidence) return candidate;
  if (candidate.sources.length > current.sources.length) return candidate;
  return current;
}

function documentStatusRank(status: NonNullable<ScoutResult["documentState"]>["status"]): number {
  switch (status) {
    case "sufficient":
      return 4;
    case "partial":
      return 3;
    case "empty":
      return 2;
    case "unavailable":
      return 1;
  }
}

function decideDocumentContextSearch(input: {
  state: LoopState;
  documentScout: DocumentScoutSessionState;
  directive: ContextSearchDirective;
}): { type: "allow" } | { type: "reuse"; context: string } | { type: "failed"; message: string } {
  if (input.directive.scope !== "documents" || (input.state.attachedDocuments ?? []).length === 0) {
    return { type: "allow" };
  }

  const best = input.documentScout.bestResult;
  if (!best?.documentState) {
    return { type: "allow" };
  }

  const normalizedQuery = normalizeScoutQuery(input.directive.query);
  const repeatedEquivalent = normalizedQuery.length > 0
    && input.documentScout.executedQueries.includes(normalizedQuery);
  const materiallyNarrower = isMateriallyNarrowerDocumentQuery(
    input.directive.query,
    input.documentScout.executedQueries,
  );

  if (best.documentState.status === "sufficient") {
    return reuseDocumentScoutContext(
      input.documentScout,
      best,
      "Document retrieval already found sufficient grounded evidence for the attached files. Do not request another document context search in this iteration; answer the user or take the next execution step.",
      "sufficient-result",
    );
  }

  if (best.documentState.status === "unavailable") {
    return reuseDocumentScoutContext(
      input.documentScout,
      best,
      "Document retrieval is unavailable for the attached files. Do not request more document searches in this iteration; explain the attachment-processing issue to the user.",
      "unavailable-result",
    );
  }

  if (input.documentScout.executedQueries.length >= 2) {
    return reuseDocumentScoutContext(
      input.documentScout,
      best,
      "A document retry already happened in this iteration. Use the current document evidence to answer, act, or explain that nothing relevant was found.",
      "retry-limit",
    );
  }

  if (repeatedEquivalent || !materiallyNarrower) {
    return reuseDocumentScoutContext(
      input.documentScout,
      best,
      "Another document search was blocked because the new query does not materially narrow the existing document request. Use the current document evidence instead.",
      repeatedEquivalent ? "equivalent-query" : "not-narrower",
    );
  }

  devLog(
    `[context-search] document retry allowed iteration=${input.state.iteration} prior_status=${best.documentState.status} query="${input.directive.query.replace(/\s+/g, " ").trim().slice(0, 140)}"`,
  );
  return { type: "allow" };
}

function reuseDocumentScoutContext(
  session: DocumentScoutSessionState,
  result: ScoutResult,
  note: string,
  reason: string,
): { type: "reuse"; context: string } | { type: "failed"; message: string } {
  session.blockedRequests++;
  devLog(
    `[context-search] document reuse reason=${reason} blocked=${session.blockedRequests} status=${result.documentState?.status ?? "unknown"} confidence=${result.confidence.toFixed(3)}`,
  );
  if (session.blockedRequests >= 3) {
    devWarn("[context-search] controller kept requesting redundant document searches after reuse guidance");
    return {
      type: "failed",
      message: "I couldn't progress because the controller kept requesting redundant document context_search calls after a document result was already available.",
    };
  }

  return {
    type: "reuse",
    context: formatScoutContext(result, note),
  };
}

function isMateriallyNarrowerDocumentQuery(query: string, priorQueries: string[]): boolean {
  const normalizedQuery = normalizeScoutQuery(query);
  if (normalizedQuery.length === 0) return false;
  if (priorQueries.includes(normalizedQuery)) return false;

  const newTokens = tokenizeScoutQuery(normalizedQuery);
  const priorTokens = new Set(priorQueries.flatMap(tokenizeScoutQuery));
  const novelTokens = newTokens.filter((token) => !priorTokens.has(token));
  const hasSectionHint = /\b(section|education|qualification|qualifications|skills|experience|projects|certifications?|languages|summary|company|title|location|dates?)\b/i.test(query);
  return novelTokens.length >= 2 || (hasSectionHint && novelTokens.length >= 1);
}

function tokenizeScoutQuery(value: string): string[] {
  return value
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !SCOUT_QUERY_STOPWORDS.has(token));
}

function normalizeScoutQuery(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

const SCOUT_QUERY_STOPWORDS = new Set([
  "and",
  "document",
  "documents",
  "extract",
  "find",
  "full",
  "from",
  "get",
  "give",
  "including",
  "information",
  "into",
  "need",
  "please",
  "retrieve",
  "show",
  "text",
  "the",
  "what",
]);

function getPrimaryUserMessage(deps: AgentLoopDeps): string {
  const override = deps.userMessageOverride?.trim();
  if (override && override.length > 0) {
    return override;
  }

  const systemEventSummary = deps.systemEvent?.summary?.trim();
  if (systemEventSummary && systemEventSummary.length > 0) {
    return systemEventSummary;
  }

  const initial = deps.initialUserMessage?.trim();
  if (initial && initial.length > 0) {
    return initial;
  }

  const context = deps.sessionMemory.getPromptMemoryContext();
  const turns = context.conversationTurns ?? [];
  const lastUser = [...turns].reverse().find((t) => t.role === "user");
  return lastUser?.content ?? "";
}

function buildLoopResult(
  state: LoopState,
  input: {
    dataDir: string;
    status: AgentLoopResult["status"];
    totalIterations: number;
    totalToolCalls: number;
    completion?: CompletionDirective;
    content?: string;
  },
): AgentLoopResult {
  const content = input.content ?? input.completion?.summary ?? state.finalOutput;
  const responseKind = shouldForceApprovalFeedback(state)
    ? "feedback"
    : input.completion?.response_kind ?? state.preferredResponseKind ?? "reply";
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
    result.taskSummary = buildTaskSummaryRecord(state, {
      assistantResponse: content,
      status: input.status,
      responseKind,
      completion: input.completion,
    });
  }

  const artifacts = collectAgentArtifacts(state.runId, state.runPath, input.dataDir, state.completedSteps);
  if (artifacts.length > 0) {
    result.artifacts = artifacts;
  }

  return result;
}

function buildTaskSummaryRecord(
  state: LoopState,
  input: {
    assistantResponse: string;
    status: AgentLoopResult["status"];
    responseKind: AgentLoopResult["type"];
    completion?: CompletionDirective;
  },
): AgentLoopResult["taskSummary"] {
  const assistantResponse = input.assistantResponse.trim();
  const progressSummary = state.taskProgress.progressSummary.trim() || undefined;
  const taskStatus = deriveTaskSummaryTaskStatus(state, input.responseKind);
  const userInputNeeded = deriveTaskSummaryUserInputNeeded(state, input.responseKind, assistantResponse);
  const summary = deriveTaskSummarySummary(progressSummary, assistantResponse);
  const completedMilestones = normalizeTaskSummaryList(state.taskProgress.completedMilestones);
  const openWork = normalizeTaskSummaryList(state.taskProgress.openWork);
  const blockers = normalizeTaskSummaryList(state.taskProgress.blockers);
  const keyFacts = normalizeTaskSummaryList(state.taskProgress.keyFacts);
  const evidence = normalizeTaskSummaryList(state.taskProgress.evidence);
  const entityHints = normalizeTaskSummaryList(input.completion?.entity_hints);
  const goalDoneWhen = normalizeTaskSummaryList(state.goal.done_when);
  const goalRequiredEvidence = normalizeTaskSummaryList(state.goal.required_evidence);
  const nextAction = deriveTaskSummaryNextAction(userInputNeeded, openWork, blockers, summary);
  const stopReason = deriveTaskSummaryStopReason(taskStatus, input.status);

  return {
    runId: state.runId,
    runPath: state.runPath,
    status: input.status,
    taskStatus,
    objective: state.goal.objective.trim() || undefined,
    summary,
    progressSummary,
    currentFocus: state.taskProgress.currentFocus?.trim() || undefined,
    completedMilestones,
    openWork,
    blockers,
    keyFacts,
    evidence,
    userInputNeeded,
    workMode: state.workMode,
    userMessage: state.userMessage.trim() || undefined,
    assistantResponse: assistantResponse || undefined,
    approach: state.approach.trim() || undefined,
    sessionContextSummary: state.sessionContextSummary.trim() || undefined,
    dependentTaskRunId: state.dependentTaskSummary?.runId,
    assistantResponseKind: input.responseKind === "none" ? undefined : input.responseKind,
    feedbackKind: input.completion?.feedback_kind,
    feedbackLabel: input.completion?.feedback_label,
    actionType: input.completion?.action_type,
    entityHints,
    goalDoneWhen,
    goalRequiredEvidence,
    nextAction,
    stopReason,
    attachmentNames: collectTaskAttachmentNames(state),
  };
}

function deriveTaskSummarySummary(progressSummary: string | undefined, assistantResponse: string): string {
  const summary = progressSummary ?? assistantResponse;
  return summary.trim();
}

function deriveTaskSummaryTaskStatus(
  state: LoopState,
  responseKind: AgentLoopResult["type"],
): AgentTaskSummaryRecord["taskStatus"] {
  if (responseKind === "feedback") {
    return state.taskProgress.status === "done" ? "done" : "needs_user_input";
  }
  return state.taskProgress.status;
}

function deriveTaskSummaryUserInputNeeded(
  state: LoopState,
  responseKind: AgentLoopResult["type"],
  assistantResponse: string,
): string | undefined {
  const current = state.taskProgress.userInputNeeded?.trim();
  if (current) {
    return current;
  }
  if (responseKind !== "feedback") {
    return undefined;
  }
  return assistantResponse.length > 0 ? assistantResponse : undefined;
}

function deriveTaskSummaryNextAction(
  userInputNeeded: string | undefined,
  openWork: string[],
  blockers: string[],
  summary: string,
): string | undefined {
  if (userInputNeeded?.trim()) {
    return userInputNeeded.trim();
  }
  if (openWork[0]) {
    return openWork[0];
  }
  if (blockers[0]) {
    return blockers[0];
  }
  return summary.trim() || undefined;
}

function deriveTaskSummaryStopReason(
  taskStatus: AgentTaskSummaryRecord["taskStatus"],
  status: AgentLoopResult["status"],
): AgentTaskSummaryRecord["stopReason"] {
  if (taskStatus === "needs_user_input") {
    return "needs_user_input";
  }
  if (taskStatus === "blocked") {
    return "blocked";
  }
  if (status === "stuck") {
    return "stuck";
  }
  if (status === "failed") {
    return "failed";
  }
  return "completed";
}

function normalizeTaskSummaryList(values: string[] | undefined): string[] {
  if (!values || values.length === 0) return [];

  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const clean = value.replace(/\s+/g, " ").trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    normalized.push(clean);
  }
  return normalized;
}

function collectTaskAttachmentNames(state: LoopState): string[] {
  const names = new Set<string>();

  for (const attachment of state.preparedAttachments ?? []) {
    const displayName = attachment.displayName?.trim();
    if (displayName) {
      names.add(displayName);
    }
  }

  for (const document of state.attachedDocuments ?? []) {
    const displayName = document.displayName?.trim() || document.name?.trim();
    if (displayName) {
      names.add(displayName);
    }
  }

  return [...names];
}

function shouldForceApprovalFeedback(state: LoopState): boolean {
  return state.inputKind === "system_event"
    && state.approvalRequired === true
    && state.approvalState === "pending";
}
