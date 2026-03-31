import { join, resolve } from "node:path";
import { devLog, devWarn } from "../shared/index.js";
import type { LlmResponseFormat, LlmTurnOutput } from "../core/contracts/llm-protocol.js";
import { compileResponseFormatForProvider } from "../providers/shared/provider-profiles.js";
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
import {
  getContextCacheEntriesByIds,
  listContextCacheMetadata,
  storeContextCache,
  type ContextCacheEntry,
  type ContextCacheMetadataEntry,
  type ContextCacheStatus,
} from "./context-cache.js";

const CACHE_SELECTION_RESPONSE_FORMAT: LlmResponseFormat = {
  type: "json_schema",
  name: "context_cache_selection_response",
  strict: true,
  schema: {
    type: "object",
    properties: {
      ids: {
        type: "array",
        items: { type: "string" },
      },
      reason: { type: "string" },
    },
    required: ["ids", "reason"],
    additionalProperties: false,
  },
};

const CACHE_SUFFICIENCY_RESPONSE_FORMAT: LlmResponseFormat = {
  type: "json_schema",
  name: "context_cache_sufficiency_response",
  strict: true,
  schema: {
    type: "object",
    properties: {
      sufficient: { type: "boolean" },
      ids: {
        type: "array",
        items: { type: "string" },
      },
      reason: { type: "string" },
    },
    required: ["sufficient", "ids", "reason"],
    additionalProperties: false,
  },
};

const CACHE_JSON_REPAIR_PROMPT = `Your previous response was invalid because it was not a single valid JSON object that matched the requested shape.
Reply again with exactly one JSON object.
Use strict JSON syntax with double-quoted strings and lowercase true, false, and null.
Do not include markdown fences.
Do not include any explanation before or after the JSON.`;

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

  if ((state.attachedDocuments ?? []).length > 0 && deps.documentStore && deps.preparedAttachmentRegistry) {
    const prepared = await prepareIncomingAttachments({
      attachedDocuments: state.attachedDocuments ?? [],
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
  const documentScout = createDocumentScoutSessionState(initialScoutResult, state.userMessage);
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

    const locations = buildScoutLocations(deps, state, runPath);
    scoutBudget.used++;

    const cachedResult = await resolveContextCacheBeforeScout(
      deps,
      state,
      runPath,
      controllerOutput,
    );
    if (cachedResult.type === "sufficient") {
      if (controllerOutput.scope !== "documents") {
        priorGenericScoutResults.set(
          buildScoutAttemptKey(controllerOutput.scope, controllerOutput.query),
          cachedResult.result,
        );
      }
      updateDocumentScoutSessionState(documentScout, controllerOutput.query, cachedResult.result);
      scoutContext = buildCurrentScoutContext(cachedResult.result, documentScout);
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
      result,
    });
    if (controllerOutput.scope !== "documents") {
      priorGenericScoutResults.set(
        buildScoutAttemptKey(controllerOutput.scope, controllerOutput.query),
        result,
      );
    }
    updateDocumentScoutSessionState(documentScout, controllerOutput.query, result);
    scoutContext = buildCurrentScoutContext(result, documentScout);
  }
}

type CacheResolution =
  | { type: "miss" }
  | { type: "sufficient"; result: ScoutResult };

interface CacheSelectionResponse {
  ids: string[];
  reason: string;
}

interface CacheSufficiencyResponse {
  sufficient: boolean;
  ids: string[];
  reason: string;
}

async function resolveContextCacheBeforeScout(
  deps: AgentLoopDeps,
  state: LoopState,
  runPath: string,
  directive: ContextSearchDirective,
): Promise<CacheResolution> {
  if (directive.scope === "documents") {
    devLog("[context-cache] skip scope=documents reason=existing-document-reuse-flow");
    return { type: "miss" };
  }

  const metadata = listContextCacheMetadata(runPath, directive.scope);
  if (metadata.length === 0) {
    devLog(`[context-cache] miss scope=${directive.scope} reason=no-entries`);
    return { type: "miss" };
  }

  const selection = await selectRelevantContextCacheEntries(
    deps,
    state,
    directive,
    metadata,
  );
  const selectedIds = uniqueIds(selection.ids).slice(0, 3);
  if (selectedIds.length === 0) {
    devLog(
      `[context-cache] miss scope=${directive.scope} reason=no-relevant-entries query="${directive.query.replace(/\s+/g, " ").trim().slice(0, 140)}"`,
    );
    return { type: "miss" };
  }

  const selectedEntries = getContextCacheEntriesByIds(runPath, selectedIds);
  if (selectedEntries.length === 0) {
    devLog(`[context-cache] miss scope=${directive.scope} reason=selected-ids-not-found`);
    return { type: "miss" };
  }

  const sufficiency = await assessContextCacheSufficiency(
    deps,
    state,
    directive,
    selectedEntries,
  );
  if (!sufficiency.sufficient) {
    devLog(
      `[context-cache] insufficient scope=${directive.scope} ids=${selectedIds.join(",")} reason="${sufficiency.reason.replace(/\s+/g, " ").trim().slice(0, 160)}"`,
    );
    return { type: "miss" };
  }

  const idsToUse = uniqueIds(sufficiency.ids).filter((id) => selectedIds.includes(id));
  const entriesToUse = idsToUse.length > 0
    ? getContextCacheEntriesByIds(runPath, idsToUse)
    : selectedEntries;
  const result = buildScoutResultFromCacheEntries(directive.scope, entriesToUse);

  devLog(
    `[context-cache] sufficient scope=${directive.scope} ids=${entriesToUse.map((entry) => entry.id).join(",")} reason="${sufficiency.reason.replace(/\s+/g, " ").trim().slice(0, 160)}"`,
  );
  return { type: "sufficient", result };
}

async function selectRelevantContextCacheEntries(
  deps: AgentLoopDeps,
  state: LoopState,
  directive: ContextSearchDirective,
  metadata: ContextCacheMetadataEntry[],
): Promise<CacheSelectionResponse> {
  const prompt = buildContextCacheSelectionPrompt(state, directive, metadata);
  return runContextCacheJsonTurn(
    deps.provider,
    [{ role: "user", content: prompt }],
    CACHE_SELECTION_RESPONSE_FORMAT,
    parseCacheSelectionResponse,
  );
}

async function assessContextCacheSufficiency(
  deps: AgentLoopDeps,
  state: LoopState,
  directive: ContextSearchDirective,
  entries: ContextCacheEntry[],
): Promise<CacheSufficiencyResponse> {
  const prompt = buildContextCacheSufficiencyPrompt(state, directive, entries);
  return runContextCacheJsonTurn(
    deps.provider,
    [{ role: "user", content: prompt }],
    CACHE_SUFFICIENCY_RESPONSE_FORMAT,
    parseCacheSufficiencyResponse,
  );
}

function buildContextCacheSelectionPrompt(
  state: LoopState,
  directive: ContextSearchDirective,
  metadata: ContextCacheMetadataEntry[],
): string {
  const metadataBlock = metadata
    .map((entry) => {
      const query = entry.query.trim().length > 0 ? entry.query : "(empty query)";
      return `- id=${entry.id} | status=${entry.status} | confidence=${entry.confidence.toFixed(2)} | query=${query.slice(0, 220)}`;
    })
    .join("\n");

  return `You are selecting useful cached context-search entries.

Current request:
- scope: ${directive.scope}
- query: ${directive.query}
- overall goal: ${state.goal.objective || state.userMessage}

Choose up to 3 cache ids that are likely useful for this request.
- Read only the metadata below.
- Prefer entries with status "success" or "sufficient".
- Use "partial" only if it may still help.
- Choose "empty" or "unavailable" only when they clearly match the same request and would help avoid repeating the same failed search.
- If none are useful, return an empty ids array.

Cache metadata:
${metadataBlock}

Respond with strict JSON:
{ "ids": ["..."], "reason": "..." }`;
}

function buildContextCacheSufficiencyPrompt(
  state: LoopState,
  directive: ContextSearchDirective,
  entries: ContextCacheEntry[],
): string {
  const entriesBlock = entries
    .map((entry) => {
      const sources = entry.sources.length > 0 ? entry.sources.join(", ") : "(none)";
      const context = entry.context.trim().length > 0 ? entry.context : "(empty context)";
      return [
        `Entry ${entry.id}`,
        `- status: ${entry.status}`,
        `- confidence: ${entry.confidence.toFixed(2)}`,
        `- cached query: ${entry.query || "(empty)"}`,
        `- sources: ${sources}`,
        `- context:`,
        context,
      ].join("\n");
    })
    .join("\n\n");

  return `You are deciding whether cached context-search entries are sufficient.

Current request:
- scope: ${directive.scope}
- query: ${directive.query}
- overall goal: ${state.goal.objective || state.userMessage}

Rules:
- Return sufficient=true only if the cached entries already provide enough grounded context to hand back to the controller.
- If any important detail still appears missing, return sufficient=false so the system can run scout.
- If sufficient=true, choose the subset of ids to keep (you may keep all of them).
- Be conservative.

Selected cache entries:
${entriesBlock}

Respond with strict JSON:
{ "sufficient": true|false, "ids": ["..."], "reason": "..." }`;
}

async function runContextCacheJsonTurn<T>(
  provider: AgentLoopDeps["provider"],
  messages: Array<{ role: "user"; content: string }>,
  preferredResponseFormat: LlmResponseFormat,
  parser: (text: string) => T,
): Promise<T> {
  const responseFormat = compileResponseFormatForProvider(
    provider.name,
    provider.capabilities,
    preferredResponseFormat,
  );

  const firstTurn = await provider.generateTurn({
    messages,
    ...(responseFormat ? { responseFormat } : {}),
  });
  const firstText = extractContextCacheTurnText(firstTurn);

  try {
    return parser(firstText);
  } catch {
    const retryTurn = await provider.generateTurn({
      messages: [
        ...messages,
        ...(firstText.trim().length > 0 ? [{ role: "assistant" as const, content: firstText }] : []),
        { role: "user" as const, content: CACHE_JSON_REPAIR_PROMPT },
      ],
      ...(responseFormat ? { responseFormat } : {}),
    });
    return parser(extractContextCacheTurnText(retryTurn));
  }
}

function parseCacheSelectionResponse(text: string): CacheSelectionResponse {
  const parsed = extractContextCacheJson(text);
  return {
    ids: Array.isArray(parsed["ids"]) ? (parsed["ids"] as unknown[]).map(String) : [],
    reason: String(parsed["reason"] ?? ""),
  };
}

function parseCacheSufficiencyResponse(text: string): CacheSufficiencyResponse {
  const parsed = extractContextCacheJson(text);
  return {
    sufficient: parsed["sufficient"] === true,
    ids: Array.isArray(parsed["ids"]) ? (parsed["ids"] as unknown[]).map(String) : [],
    reason: String(parsed["reason"] ?? ""),
  };
}

function extractContextCacheTurnText(turn: LlmTurnOutput): string {
  if (turn.type === "assistant") {
    return turn.content;
  }
  return turn.assistantContent ?? "";
}

function extractContextCacheJson(text: string): Record<string, unknown> {
  const normalized = unwrapContextCacheJsonFence(text.trim());
  const direct = tryParseContextCacheJsonObject(normalized);
  if (direct) return direct;

  const extracted = findFirstContextCacheJsonObject(normalized);
  if (extracted) {
    const parsed = tryParseContextCacheJsonObject(extracted);
    if (parsed) return parsed;
  }

  throw new SyntaxError("Expected a JSON object from context-cache helper prompt.");
}

function unwrapContextCacheJsonFence(text: string): string {
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch?.[1]) {
    return fenceMatch[1].trim();
  }
  return text;
}

function tryParseContextCacheJsonObject(text: string): Record<string, unknown> | null {
  if (text.length === 0) return null;
  try {
    const parsed = JSON.parse(normalizeContextCacheJsonLikeRecord(text));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function normalizeContextCacheJsonLikeRecord(text: string): string {
  return text
    .replace(/\bTrue\b/g, "true")
    .replace(/\bFalse\b/g, "false")
    .replace(/\bNone\b/g, "null");
}

function findFirstContextCacheJsonObject(text: string): string | null {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (!char) continue;

    if (start === -1) {
      if (char === "{") {
        start = index;
        depth = 1;
        inString = false;
        escaping = false;
      }
      continue;
    }

    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return null;
}

function buildScoutResultFromCacheEntries(
  scope: ContextSearchDirective["scope"],
  entries: ContextCacheEntry[],
): ScoutResult {
  const contextBlocks = entries
    .map((entry) => {
      const context = entry.context.trim();
      if (context.length === 0) {
        return "";
      }
      return entries.length === 1
        ? context
        : `Cached query: ${entry.query}\n${context}`;
    })
    .filter((block) => block.length > 0);

  const mergedContext = contextBlocks.join("\n\n");
  const mergedSources = [...new Set(entries.flatMap((entry) => entry.sources))];
  const mergedConfidence = entries.length > 0
    ? entries.reduce((sum, entry) => sum + entry.confidence, 0) / entries.length
    : 0;

  if (scope === "documents") {
    const mergedStatus = selectBestCacheStatus(entries.map((entry) => entry.status));
    return {
      context: mergedContext,
      sources: mergedSources,
      confidence: mergedConfidence,
      documentState: {
        status: toDocumentScoutStatus(mergedStatus),
        insufficientEvidence: mergedStatus === "partial" || mergedStatus === "empty" || mergedStatus === "unavailable",
        warnings: [],
      },
    };
  }

  const firstEntry = entries[0];
  const genericScoutState = entries.length === 1 && firstEntry?.status === "empty"
    ? {
        status: "empty" as const,
        scope,
        query: firstEntry.query,
        searchedLocations: firstEntry.sources,
        attemptedSearches: [],
        errors: [],
      }
    : undefined;

  return {
    context: mergedContext,
    sources: mergedSources,
    confidence: mergedConfidence,
    ...(genericScoutState ? { scoutState: genericScoutState } : {}),
  };
}

function selectBestCacheStatus(statuses: ContextCacheStatus[]): ContextCacheStatus {
  if (statuses.includes("sufficient")) return "sufficient";
  if (statuses.includes("success")) return "success";
  if (statuses.includes("partial")) return "partial";
  if (statuses.includes("empty")) return "empty";
  return "unavailable";
}

function toDocumentScoutStatus(status: ContextCacheStatus): NonNullable<ScoutResult["documentState"]>["status"] {
  switch (status) {
    case "partial":
      return "partial";
    case "empty":
      return "empty";
    case "unavailable":
      return "unavailable";
    case "success":
    case "sufficient":
    default:
      return "sufficient";
  }
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids.filter((id) => id.trim().length > 0))];
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

  storeContextCache(runPath, {
    scope: "documents",
    query,
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
    contextDir: resolve(deps.dataDir, "..", "context"),
    sessionPath: memCtx.activeSessionPath ?? undefined,
    sessionDir: resolve(deps.dataDir, "memory", "sessions"),
    skillsDir: resolve(deps.dataDir, "skills"),
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
      return `step ${step.step}: ${step.intent} -> ${step.outcome} | ${summary.slice(0, 140)}`;
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
