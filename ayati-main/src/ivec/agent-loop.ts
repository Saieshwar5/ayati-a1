import { join } from "node:path";
import { createId, devLog, devWarn } from "../shared/index.js";
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
} from "./types.js";
import { DEFAULT_LOOP_CONFIG } from "./types.js";

function isRotationDirective(output: ControllerOutput): output is SessionRotationDirective {
  return !output.done && "rotate_session" in output && (output as SessionRotationDirective).rotate_session === true;
}

function isContextSearchDirective(output: ControllerOutput): output is ContextSearchDirective {
  return !output.done && "context_search" in output && (output as ContextSearchDirective).context_search === true;
}

import { initRunDirectory, writeState, readState } from "./state-persistence.js";
import { callUnderstand, callReEval, callDirect } from "./controller.js";
import { executeStep } from "./executor.js";
import { runContextScout } from "./context-scout.js";
import type { ScoutKnownLocations } from "./context-scout.js";
import { lookupContextCache, storeContextCache } from "./context-cache.js";

export async function agentLoop(deps: AgentLoopDeps): Promise<AgentLoopResult> {
  const config: LoopConfig = { ...DEFAULT_LOOP_CONFIG, ...deps.config };
  const runId = createId();
  const runPath = initRunDirectory(deps.dataDir, runId);

  let totalToolCalls = 0;

  const state: LoopState = {
    runId,
    inputKind: deps.inputKind ?? (deps.systemEvent ? "system_event" : "user_message"),
    userMessage: "",
    systemEvent: deps.systemEvent,
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
    runPath,
    failedApproaches: [],
    attachedDocuments: deps.attachedDocuments ?? [],
    attachmentWarnings: deps.attachmentWarnings ?? [],
    sessionHistory: [],
    recentRunLedgers: [],
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

  writeState(runPath, state);
  deps.sessionMemory.recordRunLedger?.(deps.clientId, {
    runId: deps.runHandle.runId,
    sessionId: deps.runHandle.sessionId,
    runPath,
    state: "started",
  });

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
    return {
      type: "reply",
      content: state.finalOutput,
      status: state.status,
      totalIterations: 0,
      totalToolCalls: 0,
      runPath,
    };
  }

  // Store understand output on state
  state.goal = understandResult.goal;
  state.approach = understandResult.approach;
  writeState(runPath, state);

  let initialControllerScoutResult = await buildInitialDocumentScoutContext(
    deps,
    state,
    config,
    runPath,
  );

  // --- Main loop: direct stage ---
  let lastDirective: StepDirective | undefined;

  while (state.status === "running" && state.iteration < config.maxIterations) {
    if (deps.signal?.aborted) {
      const finalOutput = "Agent was stopped.";
      state.status = "failed";
      state.finalOutput = finalOutput;
      writeState(runPath, state);
      return {
        type: "reply",
        content: finalOutput,
        status: "failed",
        totalIterations: state.iteration,
        totalToolCalls,
        runPath,
      };
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
        return {
          type: "reply",
          content: finalOutput,
          status: "failed",
          totalIterations: state.iteration,
          totalToolCalls,
          runPath,
        };
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
        state.status = reevalResolution.status === "failed" ? "failed" : "completed";
        state.finalOutput = reevalResolution.summary;
        writeState(runPath, state);
        return {
          type: "reply",
          content: state.finalOutput,
          status: state.status,
          totalIterations: state.iteration,
          totalToolCalls,
          runPath,
        };
      }

      if (reevalResolution.type === "failed") {
        state.status = "failed";
        state.finalOutput = reevalResolution.message;
        writeState(runPath, state);
        return {
          type: "reply",
          content: state.finalOutput,
          status: "failed",
          totalIterations: state.iteration,
          totalToolCalls,
          runPath,
        };
      }

      const nextApproach = reevalResolution.directive.approach.trim();
      if (nextApproach.length === 0 || normalizeApproach(nextApproach) === normalizeApproach(state.approach)) {
        const finalOutput = "I couldn't find a different working approach after the latest failure.";
        state.status = "failed";
        state.finalOutput = finalOutput;
        writeState(runPath, state);
        return {
          type: "reply",
          content: finalOutput,
          status: "failed",
          totalIterations: state.iteration,
          totalToolCalls,
          runPath,
        };
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
      state.status = controllerResolution.status === "failed" ? "failed" : "completed";
      state.finalOutput = controllerResolution.summary;
      writeState(runPath, state);
      return {
        type: "reply",
        content: state.finalOutput,
        status: state.status,
        totalIterations: state.iteration,
        totalToolCalls,
        runPath,
      };
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
      return {
        type: "reply",
        content: finalOutput,
        status: "completed",
        totalIterations: state.iteration,
        totalToolCalls,
        runPath,
      };
    }

    if (controllerResolution.type === "failed") {
      state.status = "failed";
      state.finalOutput = controllerResolution.message;
      writeState(runPath, state);
      return {
        type: "reply",
        content: state.finalOutput,
        status: "failed",
        totalIterations: state.iteration,
        totalToolCalls,
        runPath,
      };
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
        intent: stepSummary.intent,
        tools_hint: lastDirective?.tools_hint ?? [],
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
      `Step ${state.iteration}: ${stepSummary.intent} → ${stepSummary.outcome}`,
      runPath,
    );
  }

  const finalOutput = "I've exhausted my reasoning steps. Here's what I found so far based on my analysis.";
  state.status = "failed";
  state.finalOutput = finalOutput;
  writeState(runPath, state);
  return {
    type: "reply",
    content: finalOutput,
    status: "stuck",
    totalIterations: state.iteration,
    totalToolCalls,
    runPath,
  };
}

type ControllerResolution =
  | { type: "step"; directive: StepDirective }
  | { type: "done"; summary: string; status: "completed" | "failed" }
  | { type: "rotate"; reason: string; handoffSummary: string }
  | { type: "failed"; message: string };

type ReEvalResolution =
  | { type: "reeval"; directive: ReEvalDirective }
  | { type: "done"; summary: string; status: "completed" | "failed" }
  | { type: "failed"; message: string };

type ContextSearchBudget = { used: number };

interface DocumentScoutSessionState {
  bestResult?: ScoutResult;
  latestResult?: ScoutResult;
  executedQueries: string[];
  blockedRequests: number;
}

type ContextAwareDirective = StepDirective | ReEvalDirective | SessionRotationDirective;

type ContextAwareResolution =
  | { type: "directive"; directive: ContextAwareDirective }
  | { type: "done"; summary: string; status: "completed" | "failed" }
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
  const documentScout = createDocumentScoutSessionState(initialScoutResult, state.userMessage);
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
        summary: controllerOutput.summary,
        status: controllerOutput.status,
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

    if (scoutBudget.used >= config.maxScoutCallsPerIteration) {
      devWarn(
        `[context-search] limit exceeded iteration=${state.iteration} used=${scoutBudget.used} limit=${config.maxScoutCallsPerIteration} latest_scope=${controllerOutput.scope} latest_query="${controllerOutput.query.replace(/\s+/g, " ").trim().slice(0, 140)}"`,
      );
      return {
        type: "failed",
        message: `I couldn't progress because the controller requested context_search too many times in one iteration (limit ${config.maxScoutCallsPerIteration}, latest scope: ${controllerOutput.scope}).`,
      };
    }

    const locations = buildScoutLocations(deps, state, runPath);
    scoutBudget.used++;

    const cachedResult = lookupContextCache(runPath, {
      scope: controllerOutput.scope,
      query: controllerOutput.query,
      knownLocations: locations,
      iteration: state.iteration,
      documentPaths: controllerOutput.document_paths,
    });
    if (cachedResult) {
      updateDocumentScoutSessionState(documentScout, controllerOutput.query, cachedResult);
      scoutContext = buildCurrentScoutContext(cachedResult, documentScout);
      continue;
    }

    const result = await runContextScout(
      {
        provider: deps.provider,
        maxTurns: config.maxScoutTurns,
        documentContextBackend: deps.documentContextBackend,
      },
      controllerOutput.query,
      controllerOutput.scope,
      locations,
      controllerOutput.document_paths,
    );
    storeContextCache(runPath, {
      scope: controllerOutput.scope,
      query: controllerOutput.query,
      knownLocations: locations,
      iteration: state.iteration,
      documentPaths: controllerOutput.document_paths,
      result,
    });
    updateDocumentScoutSessionState(documentScout, controllerOutput.query, result);
    scoutContext = buildCurrentScoutContext(result, documentScout);
  }
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

function buildCurrentScoutContext(current: ScoutResult | undefined, documentScout: DocumentScoutSessionState): string {
  const bestDocumentContext = documentScout.bestResult?.documentState
    ? formatScoutContext(documentScout.bestResult)
    : "";

  if (current?.documentState) {
    return bestDocumentContext || formatScoutContext(current);
  }

  if (current) {
    if (bestDocumentContext) {
      return `${bestDocumentContext}\n\nAdditional scout context:\n${formatScoutContext(current)}`;
    }
    return formatScoutContext(current);
  }

  return bestDocumentContext;
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

  storeContextCache(runPath, {
    scope: "documents",
    query,
    knownLocations: locations,
    iteration: 0,
    result,
  });

  devLog(
    `[context-search] preload-result scope=documents status=${result.documentState?.status ?? "unknown"} context=${result.context.trim().length > 0 ? "present" : "empty"} sources=${result.sources.length} confidence=${result.confidence.toFixed(3)}`,
  );
  return result;
}

function buildScoutLocations(deps: AgentLoopDeps, state: LoopState, runPath: string): ScoutKnownLocations {
  const memCtx = deps.sessionMemory.getPromptMemoryContext();
  return {
    runPath,
    contextDir: "context",
    sessionPath: memCtx.activeSessionPath ?? undefined,
    sessionDir: "data/memory/sessions",
    skillsDir: "data/skills",
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
      return `step ${step.step}: ${step.intent} -> ${step.outcome} | ${summary.slice(0, 140)}`;
    });
}

function mergeUniqueValues(existing: string[], incoming: string[]): string[] {
  return [...new Set([...existing, ...incoming])];
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
