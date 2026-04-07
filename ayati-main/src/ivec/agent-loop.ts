import { readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { devLog, devWarn } from "../shared/index.js";
import type {
  AgentLoopDeps,
  AgentLoopResult,
  LoopState,
  LoopConfig,
  ControllerOutput,
  ContextSearchDirective,
  ReEvalDirective,
  SessionRotationDirective,
  StepDirective,
  CompletionDirective,
  ScoutResult,
  GoalContract,
  TaskValidationContext,
  PreparedAttachmentStateUpdate,
  RecentContextSearch,
  RecentContextSearchStatus,
} from "./types.js";
import { DEFAULT_LOOP_CONFIG } from "./types.js";

function isRotationDirective(output: ControllerOutput): output is SessionRotationDirective {
  return !output.done && "rotate_session" in output && (output as SessionRotationDirective).rotate_session === true;
}

function isContextSearchDirective(output: ControllerOutput): output is ContextSearchDirective {
  return !output.done && "context_search" in output && (output as ContextSearchDirective).context_search === true;
}

import { initRunDirectory, writeState, readState } from "./state-persistence.js";
import { callUnderstand, callReEval, callDirect, resolveOpenFeedbackReference } from "./controller.js";
import { executeStep } from "./executor.js";
import { runContextScout } from "./context-scout.js";
import { collectAgentArtifacts } from "./agent-artifacts.js";
import { prepareIncomingAttachments } from "../documents/attachment-preparer.js";
import type { ManagedDocumentManifest, PreparedAttachmentSummary } from "../documents/types.js";
import type { ScoutKnownLocations } from "./context-scout.js";
import type { OpenFeedbackItem } from "../memory/types.js";

export async function agentLoop(deps: AgentLoopDeps): Promise<AgentLoopResult> {
  const config: LoopConfig = { ...DEFAULT_LOOP_CONFIG, ...deps.config };
  const runId = deps.runHandle.runId;
  const runPath = initRunDirectory(deps.dataDir, runId);

  let totalToolCalls = 0;

  const state: LoopState = {
    runId,
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
    feedbackTtlHours: deps.feedbackTtlHours,
    preferredResponseKind: deps.preferredResponseKind,
    matchedFeedback: null,
    goal: emptyGoalContract(),
    approach: "",
    taskStatus: "not_done",
    progressLedger: emptyProgressLedger(),
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
    openFeedbacks: [],
    recentSystemActivity: [],
  };

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

  const feedbackResolution = await resolveOpenFeedbackIfNeeded(deps, state, runPath);
  if (feedbackResolution) {
    writeState(runPath, state);
    return feedbackResolution;
  }

  writeState(runPath, state);
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
    writeState(runPath, state);
  }

  // --- Understand stage (iteration 0) ---
  const systemContext = deps.systemContext ?? "";
  const understandResult = await callUnderstand(
    deps.provider,
    state,
    deps.toolDefinitions,
    systemContext,
    deps.controllerPrompts,
  );

  if (understandResult.done) {
    state.status = understandResult.status === "failed" ? "failed" : "completed";
    state.finalOutput = understandResult.summary;
    writeState(runPath, state);
    return buildLoopResult(state, {
      dataDir: deps.dataDir,
      completion: understandResult,
      status: state.status,
      totalIterations: 0,
      totalToolCalls: 0,
    });
  }

  // Store understand output on state
  state.goal = understandResult.goal;
  state.approach = understandResult.approach;
  state.workMode = understandResult.work_mode;
  writeState(runPath, state);

  let initialControllerScoutResult: ScoutResult | undefined;

  // --- Main loop: direct stage ---
  let lastDirective: StepDirective | undefined;

  while (state.status === "running" && state.iteration < config.maxIterations) {
    if (deps.signal?.aborted) {
      const finalOutput = "Agent was stopped.";
      state.status = "failed";
      state.finalOutput = finalOutput;
      writeState(runPath, state);
      return buildLoopResult(state, {
        dataDir: deps.dataDir,
        status: "failed",
        content: finalOutput,
        totalIterations: state.iteration,
        totalToolCalls,
      });
    }

    const diskState = readState(runPath);
    if (diskState) {
      Object.assign(state, diskState);
    }
    syncTransientMemoryContext(state, deps);

    state.iteration++;
    const scoutBudget: ContextSearchBudget = { used: 0 };

    // Re-evaluation after a failed step
    if (state.consecutiveFailures >= 1) {
      if (state.approachChangeCount >= config.maxApproachChanges) {
        const finalOutput = `I couldn't complete the task after changing approach ${config.maxApproachChanges} times.`;
        state.status = "failed";
        state.finalOutput = finalOutput;
        writeState(runPath, state);
        return buildLoopResult(state, {
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
        config,
        runPath,
        scoutBudget,
        systemContext,
      );
      if (reevalResolution.type === "done") {
        state.status = reevalResolution.completion.status === "failed" ? "failed" : "completed";
        state.finalOutput = reevalResolution.completion.summary;
        writeState(runPath, state);
        return buildLoopResult(state, {
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
        writeState(runPath, state);
        return buildLoopResult(state, {
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
        writeState(runPath, state);
        return buildLoopResult(state, {
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
      writeState(runPath, state);
    }

    const controllerResolution = await resolveControllerDirective(
      deps,
      state,
      config,
      runPath,
      scoutBudget,
      initialControllerScoutResult,
    );
    initialControllerScoutResult = undefined;
    if (controllerResolution.type === "done") {
      state.status = controllerResolution.completion.status === "failed" ? "failed" : "completed";
      state.finalOutput = controllerResolution.completion.summary;
      writeState(runPath, state);
      return buildLoopResult(state, {
        dataDir: deps.dataDir,
        completion: controllerResolution.completion,
        status: state.status,
        content: state.finalOutput,
        totalIterations: state.iteration,
        totalToolCalls,
      });
    }

    if (controllerResolution.type === "rotate") {
      const finalOutput = `Session rotated: ${controllerResolution.reason}`;
      deps.sessionMemory.createSession?.(deps.clientId, {
        runId: deps.runHandle.runId,
        reason: controllerResolution.reason,
        source: "agent",
        handoffSummary: controllerResolution.handoffSummary,
      });
      state.status = "completed";
      state.finalOutput = finalOutput;
      writeState(runPath, state);
      return buildLoopResult(state, {
        dataDir: deps.dataDir,
        status: "completed",
        content: finalOutput,
        totalIterations: state.iteration,
        totalToolCalls,
      });
    }

    if (controllerResolution.type === "failed") {
      state.status = "failed";
      state.finalOutput = controllerResolution.message;
      writeState(runPath, state);
      return buildLoopResult(state, {
        dataDir: deps.dataDir,
        status: "failed",
        content: state.finalOutput,
        totalIterations: state.iteration,
        totalToolCalls,
      });
    }

    const controllerOutput = controllerResolution.directive;
    lastDirective = controllerOutput;

    const stepSummary = await executeStep(
      {
        provider: deps.provider,
        toolExecutor: deps.toolExecutor,
        toolDefinitions: deps.toolDefinitions,
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

    const stepToolCalls = stepSummary.toolSuccessCount + stepSummary.toolFailureCount;
    totalToolCalls += stepToolCalls > 0 ? stepToolCalls : 1;

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
      state.progressLedger.lastSuccessfulStepSummary = stepSummary.summary;
      state.progressLedger.lastStepFacts = [...stepSummary.newFacts];
      state.progressLedger.taskEvidence = mergeUniqueValues(
        state.progressLedger.taskEvidence,
        stepSummary.taskEvidence ?? [],
      );
      state.taskStatus = stepSummary.taskStatusAfter ?? state.taskStatus;
    }

    writeState(runPath, state);
    deps.onProgress?.(
      `Step ${state.iteration}: ${stepSummary.executionContract} → ${stepSummary.outcome}`,
      runPath,
    );
  }

  const finalOutput = "I've exhausted my reasoning steps. Here's what I found so far based on my analysis.";
  state.status = "failed";
  state.finalOutput = finalOutput;
  writeState(runPath, state);
  return buildLoopResult(state, {
    dataDir: deps.dataDir,
    status: "stuck",
    content: finalOutput,
    totalIterations: state.iteration,
    totalToolCalls,
  });
}

type ControllerResolution =
  | { type: "step"; directive: StepDirective }
  | { type: "done"; completion: CompletionDirective }
  | { type: "rotate"; reason: string; handoffSummary: string }
  | { type: "failed"; message: string };

type ReEvalResolution =
  | { type: "reeval"; directive: ReEvalDirective }
  | { type: "done"; completion: CompletionDirective }
  | { type: "failed"; message: string };

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

type ContextAwareDirective = StepDirective | ReEvalDirective | SessionRotationDirective;

type ContextAwareResolution =
  | { type: "directive"; directive: ContextAwareDirective }
  | { type: "done"; completion: CompletionDirective }
  | { type: "failed"; message: string };

async function resolveControllerDirective(
  deps: AgentLoopDeps,
  state: LoopState,
  config: LoopConfig,
  runPath: string,
  scoutBudget: ContextSearchBudget,
  initialScoutResult?: ScoutResult,
): Promise<ControllerResolution> {
  const resolution = await resolveContextAwareController(
    deps,
    state,
    config,
    runPath,
    scoutBudget,
    initialScoutResult,
    (scoutContext) => callDirect(
      deps.provider,
      state,
      deps.toolDefinitions,
      scoutContext,
      deps.controllerPrompts,
      deps.systemContext ?? "",
    ),
  );

  if (resolution.type !== "directive") {
    return resolution;
  }

  if (isRotationDirective(resolution.directive)) {
    return {
      type: "rotate",
      reason: resolution.directive.reason,
      handoffSummary: resolution.directive.handoff_summary,
    };
  }

  return { type: "step", directive: resolution.directive as StepDirective };
}

async function resolveReEvalDirective(
  deps: AgentLoopDeps,
  state: LoopState,
  config: LoopConfig,
  runPath: string,
  scoutBudget: ContextSearchBudget,
  systemContext: string,
): Promise<ReEvalResolution> {
  const resolution = await resolveContextAwareController(
    deps,
    state,
    config,
    runPath,
    scoutBudget,
    undefined,
    (scoutContext) => callReEval(
      deps.provider,
      state,
      deps.toolDefinitions,
      scoutContext,
      deps.controllerPrompts,
      systemContext,
    ),
  );

  if (resolution.type !== "directive") {
    return resolution;
  }

  if (!("reeval" in resolution.directive) || resolution.directive.reeval !== true) {
    return {
      type: "failed",
      message: "I couldn't determine a revised approach after the latest failure.",
    };
  }

  return { type: "reeval", directive: resolution.directive };
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
  state.activeSessionAttachments = memCtx.activeAttachments ?? [];
  state.openFeedbacks = memCtx.openFeedbacks ?? [];
  state.recentSystemActivity = memCtx.recentSystemActivity ?? [];
}

async function resolveOpenFeedbackIfNeeded(
  deps: AgentLoopDeps,
  state: LoopState,
  runPath: string,
): Promise<AgentLoopResult | null> {
  if (state.inputKind !== "user_message" || state.openFeedbacks.length === 0) {
    return null;
  }

  const feedbackResolution = await resolveOpenFeedbackReference(
    deps.provider,
    state,
    deps.systemContext,
  );

  if (feedbackResolution.resolution === "none") {
    return null;
  }

  if (feedbackResolution.resolution === "ambiguous") {
    const clarification = feedbackResolution.clarification?.trim().length
      ? feedbackResolution.clarification.trim()
      : "I have a few open requests. Which one are you responding to?";
    state.status = "completed";
    state.finalOutput = clarification;
    return {
      type: "feedback",
      content: clarification,
      status: "completed",
      totalIterations: 0,
      totalToolCalls: 0,
      runPath,
    };
  }

  const matchedFeedback = state.openFeedbacks.find((item) => item.feedbackId === feedbackResolution.feedback_id);
  if (!matchedFeedback) {
    if (state.openFeedbacks.length <= 1) {
      return null;
    }

    const clarification = "I have a few open requests. Which one are you responding to?";
    state.status = "completed";
    state.finalOutput = clarification;
    return {
      type: "feedback",
      content: clarification,
      status: "completed",
      totalIterations: 0,
      totalToolCalls: 0,
      runPath,
    };
  }

  state.matchedFeedback = matchedFeedback;
  if (shouldTreatMatchedFeedbackAsFreshTask(state.userMessage, matchedFeedback)) {
    state.matchedFeedback = null;
    return null;
  }

  const feedbackOutcome = classifyMatchedFeedbackReply(state.userMessage);
  deps.sessionMemory.resolveOpenFeedback?.(deps.clientId, {
    runId: deps.runHandle.runId,
    sessionId: deps.runHandle.sessionId,
    feedbackId: matchedFeedback.feedbackId,
    resolution: feedbackOutcome,
    userResponse: state.userMessage,
  });
  syncTransientMemoryContext(state, deps);
  state.openFeedbacks = state.openFeedbacks.filter((item) => item.feedbackId !== matchedFeedback.feedbackId);

  if (feedbackOutcome === "rejected") {
    const content = buildFeedbackRejectionReply(matchedFeedback.shortLabel);
    state.status = "completed";
    state.finalOutput = content;
    return {
      type: "reply",
      content,
      status: "completed",
      totalIterations: 0,
      totalToolCalls: 0,
      runPath,
      resolvedFeedbackId: matchedFeedback.feedbackId,
    };
  }

  return null;
}

function classifyMatchedFeedbackReply(userMessage: string): "completed" | "rejected" {
  const normalized = userMessage.trim().toLowerCase();
  if (normalized.length === 0) {
    return "completed";
  }

  const rejectionPatterns = [
    /^(?:no|nope|nah)\b/,
    /\bdo not\b/,
    /\bdon'?t\b/,
    /\bno need\b/,
    /\bnot now\b/,
    /\bcancel\b/,
    /\bstop\b/,
    /\bignore\b/,
    /\bskip it\b/,
    /\bdo nothing\b/,
    /\bleave (?:it|that|this)\b/,
    /\bhold off\b/,
    /\bwon't need\b/,
  ];

  return rejectionPatterns.some((pattern) => pattern.test(normalized))
    ? "rejected"
    : "completed";
}

function shouldTreatMatchedFeedbackAsFreshTask(
  userMessage: string,
  matchedFeedback: OpenFeedbackItem,
): boolean {
  const normalized = userMessage.trim().toLowerCase();
  if (!looksLikeFreshTaskRequest(normalized) || looksLikeConciseFeedbackReply(normalized)) {
    return false;
  }

  return !hasFeedbackOverlap(normalized, matchedFeedback);
}

function looksLikeFreshTaskRequest(normalizedMessage: string): boolean {
  if (normalizedMessage.length < 12) return false;

  const patterns = [
    /^(?:can|could|would|will)\s+you\b/,
    /^(?:please\s+)?(?:check|fetch|pull|get|give|show|read|open|search|find|inspect|retrieve|draft|send|run|look up|summarize|explain|tell me)\b/,
    /\b(?:full details|details about|what is in|what's in|show me|tell me about)\b/,
  ];
  return patterns.some((pattern) => pattern.test(normalizedMessage));
}

function looksLikeConciseFeedbackReply(normalizedMessage: string): boolean {
  if (normalizedMessage.length === 0) return true;
  const compact = normalizedMessage.replace(/[!?.,]/g, " ").trim();
  const wordCount = compact.length === 0 ? 0 : compact.split(/\s+/).length;
  if (wordCount <= 4) return true;

  const concisePatterns = [
    /^(?:yes|yep|yeah|ok|okay|sure|go ahead)\b/,
    /^(?:no|nope|nah)\b/,
    /^(?:send|do|run|share|ship|approve)\s+(?:it|that|this)\b/,
  ];
  return concisePatterns.some((pattern) => pattern.test(compact));
}

function hasFeedbackOverlap(normalizedMessage: string, matchedFeedback: OpenFeedbackItem): boolean {
  const messageTokens = tokenizeForOverlap(normalizedMessage);
  if (messageTokens.size === 0) return false;

  const feedbackText = [
    matchedFeedback.shortLabel,
    matchedFeedback.message,
    matchedFeedback.actionType ?? "",
    matchedFeedback.payloadSummary ?? "",
    ...matchedFeedback.entityHints,
  ].join(" ").toLowerCase();
  const feedbackTokens = tokenizeForOverlap(feedbackText);
  for (const token of messageTokens) {
    if (feedbackTokens.has(token)) {
      return true;
    }
  }
  return false;
}

function tokenizeForOverlap(text: string): Set<string> {
  const stopWords = new Set([
    "a",
    "an",
    "and",
    "are",
    "about",
    "can",
    "could",
    "details",
    "do",
    "for",
    "from",
    "full",
    "get",
    "give",
    "hello",
    "i",
    "it",
    "latest",
    "mail",
    "me",
    "my",
    "of",
    "on",
    "please",
    "show",
    "tell",
    "that",
    "the",
    "this",
    "to",
    "you",
  ]);

  return new Set(
    text
      .split(/[^a-z0-9_]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 && !stopWords.has(token)),
  );
}

function buildFeedbackRejectionReply(shortLabel: string): string {
  const compactLabel = shortLabel.trim();
  if (!compactLabel) {
    return "Okay, I won't do anything with that request.";
  }
  return `Okay, I won't do anything with "${compactLabel}".`;
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

function emptyProgressLedger(): LoopState["progressLedger"] {
  return {
    lastSuccessfulStepSummary: "",
    lastStepFacts: [],
    taskEvidence: [],
  };
}

function buildTaskValidationContext(state: LoopState): TaskValidationContext {
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
    taskStatus: state.taskStatus,
    approach: state.approach,
    latestSuccessfulStepSummary: state.progressLedger.lastSuccessfulStepSummary,
    latestStepNewFacts: state.progressLedger.lastStepFacts,
    recentStepDigests: buildRecentStepDigests(state),
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

function mergeUniqueValues(existing: string[], incoming: string[]): string[] {
  return [...new Set([...existing, ...incoming])];
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
  const type = shouldForceApprovalFeedback(state)
    ? "feedback"
    : input.completion?.response_kind ?? state.preferredResponseKind ?? "reply";
  const result: AgentLoopResult = {
    type,
    content,
    status: input.status,
    totalIterations: input.totalIterations,
    totalToolCalls: input.totalToolCalls,
    runPath: state.runPath,
  };

  const artifacts = collectAgentArtifacts(state.runId, state.runPath, input.dataDir, state.completedSteps);
  if (artifacts.length > 0) {
    result.artifacts = artifacts;
  }

  if (type === "feedback") {
    result.openFeedback = buildOpenFeedbackResult(state, input.completion, content);
  }

  if (state.matchedFeedback) {
    result.resolvedFeedbackId = state.matchedFeedback.feedbackId;
  }

  return result;
}

function shouldForceApprovalFeedback(state: LoopState): boolean {
  return state.inputKind === "system_event"
    && state.approvalRequired === true
    && state.approvalState === "pending";
}

function buildOpenFeedbackResult(
  state: LoopState,
  completion: CompletionDirective | undefined,
  content: string,
): NonNullable<AgentLoopResult["openFeedback"]> {
  const fallbackLabel = truncateFeedbackLabel(
    completion?.feedback_label
      ?? state.matchedFeedback?.shortLabel
      ?? content
      ?? state.userMessage,
  );
  return {
    kind: completion?.feedback_kind ?? state.matchedFeedback?.kind ?? "clarification",
    shortLabel: fallbackLabel.length > 0 ? fallbackLabel : "follow_up",
    actionType: completion?.action_type ?? state.matchedFeedback?.actionType ?? state.systemEventRequestedAction,
    sourceEventId: state.systemEvent?.eventId ?? state.matchedFeedback?.sourceEventId,
    entityHints: completion?.entity_hints ?? state.matchedFeedback?.entityHints ?? [],
    payloadSummary: state.matchedFeedback?.payloadSummary
      ?? (state.systemEvent ? truncateFeedbackLabel(state.userMessage, 200) : undefined),
    ttlHours: state.feedbackTtlHours,
  };
}

function truncateFeedbackLabel(value: string, maxLength = 80): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, maxLength)}...`;
}
