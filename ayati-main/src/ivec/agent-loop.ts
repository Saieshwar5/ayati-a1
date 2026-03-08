import { createId } from "../shared/index.js";
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
    userMessage: "",
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
    sessionHistory: [],
    recentRunLedgers: [],
  };

  // Populate user message and session history from sessionMemory context
  state.userMessage = getPrimaryUserMessage(deps);
  syncTransientMemoryContext(state, deps);

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

    const controllerResolution = await resolveControllerDirective(deps, state, config, runPath, scoutBudget);
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
): Promise<ControllerResolution> {
  const resolution = await resolveContextAwareController(
    deps,
    state,
    config,
    runPath,
    scoutBudget,
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
  invoke: (scoutContext?: string) => Promise<ContextAwareDirective | ContextSearchDirective | CompletionDirective>,
): Promise<ContextAwareResolution> {
  let scoutContext = "";

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

    if (scoutBudget.used >= config.maxScoutCallsPerIteration) {
      return {
        type: "failed",
        message: "I couldn't progress because repeated context search requests exceeded the per-iteration limit.",
      };
    }

    const locations = buildScoutLocations(deps, runPath);
    scoutBudget.used++;

    const cachedResult = lookupContextCache(runPath, {
      scope: controllerOutput.scope,
      query: controllerOutput.query,
      knownLocations: locations,
      iteration: state.iteration,
    });
    if (cachedResult) {
      scoutContext = formatScoutContext(cachedResult);
      continue;
    }

    const result = await runContextScout(
      { provider: deps.provider, maxTurns: config.maxScoutTurns },
      controllerOutput.query,
      controllerOutput.scope,
      locations,
    );
    storeContextCache(runPath, {
      scope: controllerOutput.scope,
      query: controllerOutput.query,
      knownLocations: locations,
      iteration: state.iteration,
      result,
    });
    scoutContext = formatScoutContext(result);
  }
}

function formatScoutContext(result: ScoutResult): string {
  if (!result.summary) return "";
  const sourceLine = result.sources.length > 0
    ? `\nSources: ${result.sources.join(", ")}`
    : "";
  return `${result.summary} (confidence: ${result.confidence})${sourceLine}`;
}

function buildScoutLocations(deps: AgentLoopDeps, runPath: string): ScoutKnownLocations {
  const memCtx = deps.sessionMemory.getPromptMemoryContext();
  return {
    runPath,
    contextDir: "context",
    sessionPath: memCtx.activeSessionPath ?? undefined,
    sessionDir: "data/memory/sessions",
    skillsDir: "data/skills",
    runId: deps.runHandle.runId,
    activeSessionId: deps.runHandle.sessionId,
  };
}

function syncTransientMemoryContext(state: LoopState, deps: AgentLoopDeps): void {
  const memCtx = deps.sessionMemory.getPromptMemoryContext();
  // Exclude the current user message from history — it's already on state.userMessage
  state.sessionHistory = (memCtx.conversationTurns ?? []).filter(
    (t) => !(t.role === "user" && t.content === state.userMessage),
  );
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
    userMessage: state.userMessage,
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

function getPrimaryUserMessage(deps: AgentLoopDeps): string {
  const override = deps.userMessageOverride?.trim();
  if (override && override.length > 0) {
    return override;
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
