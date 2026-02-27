import { createId } from "../shared/index.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentLoopDeps,
  AgentLoopResult,
  LoopState,
  LoopConfig,
  ControllerOutput,
  InspectDirective,
  SessionRotationDirective,
  StepDirective,
} from "./types.js";
import { DEFAULT_LOOP_CONFIG } from "./types.js";

function isRotationDirective(output: ControllerOutput): output is SessionRotationDirective {
  return !output.done && "rotate_session" in output && (output as SessionRotationDirective).rotate_session === true;
}

function isInspectDirective(output: ControllerOutput): output is InspectDirective {
  return !output.done && "inspect_steps" in output && Array.isArray(output.inspect_steps);
}

import { initRunDirectory, writeJSON, readState } from "./state-persistence.js";
import { callController } from "./controller.js";
import { executeStep } from "./executor.js";

const MAX_INSPECT_SNIPPET_CHARS = 1000;

export async function agentLoop(deps: AgentLoopDeps): Promise<AgentLoopResult> {
  const config: LoopConfig = { ...DEFAULT_LOOP_CONFIG, ...deps.config };
  const runId = createId();
  const runPath = initRunDirectory(deps.dataDir, runId);

  let totalToolCalls = 0;

  const state: LoopState = {
    runId,
    userMessage: deps.runHandle.runId ? getLastUserMessage(deps) : "",
    goal: "",
    approach: "",
    status: "running",
    iteration: 0,
    maxIterations: config.maxIterations,
    consecutiveFailures: 0,
    facts: [],
    uncertainties: [],
    completedSteps: [],
    runPath,
    failedApproaches: [],
  };

  // Populate user message from sessionMemory context
  state.userMessage = getLastUserMessage(deps);
  state.goal = "";
  state.approach = "";

  writeJSON(runPath, "state.json", state);
  deps.sessionMemory.recordRunLedger?.(deps.clientId, {
    runId: deps.runHandle.runId,
    sessionId: deps.runHandle.sessionId,
    runPath,
    state: "started",
  });

  let lastDirective: StepDirective | undefined;

  while (state.status === "running" && state.iteration < config.maxIterations) {
    const diskState = readState(runPath);
    if (diskState) {
      Object.assign(state, diskState);
    }

    state.iteration++;

    const controllerResolution = await resolveControllerDirective(deps, state, config, runPath);
    if (controllerResolution.type === "done") {
      state.status = controllerResolution.status === "failed" ? "failed" : "completed";
      writeJSON(runPath, "state.json", state);
      return {
        type: "reply",
        content: controllerResolution.summary,
        status: state.status,
        totalIterations: state.iteration,
        totalToolCalls,
        runPath,
      };
    }

    if (controllerResolution.type === "rotate") {
      deps.sessionMemory.createSession?.(deps.clientId, {
        runId: deps.runHandle.runId,
        reason: controllerResolution.reason,
        source: "agent",
        handoffSummary: controllerResolution.handoffSummary,
      });
      state.status = "completed";
      writeJSON(runPath, "state.json", state);
      return {
        type: "reply",
        content: `Session rotated: ${controllerResolution.reason}`,
        status: "completed",
        totalIterations: state.iteration,
        totalToolCalls,
        runPath,
      };
    }

    if (controllerResolution.type === "failed") {
      state.status = "failed";
      writeJSON(runPath, "state.json", state);
      return {
        type: "reply",
        content: controllerResolution.message,
        status: "failed",
        totalIterations: state.iteration,
        totalToolCalls,
        runPath,
      };
    }

    const controllerOutput = controllerResolution.directive;

    if (state.goal.trim().length === 0) {
      state.goal = state.userMessage;
    }
    if (state.approach.trim().length === 0) {
      state.approach = controllerOutput.approach;
    }
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
      },
      controllerOutput,
      state.facts,
      state.iteration,
      runPath,
    );

    state.completedSteps.push(stepSummary);

    for (const fact of stepSummary.newFacts) {
      if (!state.facts.includes(fact)) {
        state.facts.push(fact);
      }
    }

    totalToolCalls += stepSummary.artifacts.length || 1;

    if (stepSummary.outcome === "failed") {
      state.consecutiveFailures++;

      state.failedApproaches.push({
        step: stepSummary.step,
        intent: stepSummary.intent,
        tools_hint: lastDirective?.tools_hint ?? [],
        failureType: stepSummary.failureType ?? "verify_failed",
        reason: stepSummary.evidence.slice(0, 300),
        blockedTargets: stepSummary.blockedTargets ?? [],
      });

      if (state.consecutiveFailures >= config.maxConsecutiveFailures) {
        state.status = "failed";
      }
    } else {
      state.consecutiveFailures = 0;
    }

    writeJSON(runPath, "state.json", state);
    deps.onProgress?.(
      `Step ${state.iteration}: ${stepSummary.intent} → ${stepSummary.outcome}`,
      runPath,
    );
  }

  state.status = "failed";
  writeJSON(runPath, "state.json", state);
  return {
    type: "reply",
    content: "I've exhausted my reasoning steps. Here's what I found so far based on my analysis.",
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

async function resolveControllerDirective(
  deps: AgentLoopDeps,
  state: LoopState,
  config: LoopConfig,
  runPath: string,
): Promise<ControllerResolution> {
  let inspectedStepsContext = "";
  let inspectRequeryCount = 0;

  while (true) {
    const controllerOutput = await callController(
      deps.provider,
      state,
      deps.toolDefinitions,
      deps.systemContext,
      { inspectedStepsContext },
    );

    if (controllerOutput.done) {
      return {
        type: "done",
        summary: controllerOutput.summary,
        status: controllerOutput.status,
      };
    }

    if (isRotationDirective(controllerOutput)) {
      return {
        type: "rotate",
        reason: controllerOutput.reason,
        handoffSummary: controllerOutput.handoff_summary,
      };
    }

    applyDirectiveUpdates(state, controllerOutput);

    if (!isInspectDirective(controllerOutput)) {
      return { type: "step", directive: controllerOutput };
    }

    if (inspectRequeryCount >= config.maxInspectRequeriesPerIteration) {
      return {
        type: "failed",
        message: "I couldn't progress because repeated inspection requests exceeded the per-iteration limit.",
      };
    }

    const selectedSteps = sanitizeInspectSteps(
      controllerOutput.inspect_steps,
      state.completedSteps.length,
      config.maxInspectStepsPerRequest,
    );
    if (selectedSteps.length === 0) {
      inspectedStepsContext = "No valid inspect steps were requested (either out of range or unavailable). Choose the next action using available context.";
      inspectRequeryCount++;
      continue;
    }

    inspectedStepsContext = buildInspectedStepsContext(runPath, selectedSteps);
    inspectRequeryCount++;
  }
}

function applyDirectiveUpdates(state: LoopState, directive: StepDirective | InspectDirective): void {
  if (directive.goal_update && shouldAcceptGoalUpdate(state)) {
    state.goal = directive.goal_update;
  }

  const proposedApproach = (directive.approach_update ?? "").trim();
  if (proposedApproach.length > 0 && shouldAcceptApproachUpdate(state, directive.approach_change_reason)) {
    state.approach = proposedApproach;
    return;
  }

  const fallbackApproach = "approach" in directive && typeof directive.approach === "string"
    ? directive.approach.trim()
    : "";
  if (fallbackApproach.length > 0 && state.approach.trim().length === 0) {
    state.approach = fallbackApproach;
  }
}

function shouldAcceptGoalUpdate(state: LoopState): boolean {
  return state.goal.trim().length === 0 || state.goal.trim() === state.userMessage.trim();
}

function shouldAcceptApproachUpdate(state: LoopState, reason?: string): boolean {
  if (state.approach.trim().length === 0) return true;
  if (state.completedSteps.length === 0) return true;
  if (state.consecutiveFailures > 0) return true;

  const lastStep = state.completedSteps[state.completedSteps.length - 1];
  if (!lastStep) return true;
  if (lastStep.outcome === "failed") return true;
  if (lastStep.failureType === "no_progress") return true;
  if (typeof reason === "string" && reason.trim().length > 0) return true;
  return false;
}

function sanitizeInspectSteps(requested: number[], maxCompletedStep: number, maxPerRequest: number): number[] {
  const unique = new Set<number>();
  for (const raw of requested) {
    const step = Math.trunc(raw);
    if (!Number.isInteger(step) || step <= 0) continue;
    if (step > maxCompletedStep) continue;
    unique.add(step);
    if (unique.size >= maxPerRequest) break;
  }
  return [...unique];
}

function buildInspectedStepsContext(runPath: string, steps: number[]): string {
  const lines = [
    `Inspection root: ${runPath}`,
  ];

  for (const step of steps) {
    const pad = String(step).padStart(3, "0");
    const actRel = `steps/${pad}-act.json`;
    const verifyRel = `steps/${pad}-verify.json`;
    const actPath = join(runPath, actRel);
    const verifyPath = join(runPath, verifyRel);

    lines.push("");
    lines.push(`Step ${step}:`);
    lines.push(`- act_file: ${actPath}`);
    lines.push(`- verify_file: ${verifyPath}`);
    lines.push(`- act_content: ${readFileSnippet(actPath)}`);
    lines.push(`- verify_content: ${readFileSnippet(verifyPath)}`);
  }

  return lines.join("\n");
}

function readFileSnippet(filePath: string): string {
  if (!existsSync(filePath)) return "[missing file]";

  try {
    const raw = readFileSync(filePath, "utf-8").replace(/\s+/g, " ").trim();
    if (raw.length <= MAX_INSPECT_SNIPPET_CHARS) return raw;
    return `${raw.slice(0, MAX_INSPECT_SNIPPET_CHARS)}...`;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `[failed to read file: ${message}]`;
  }
}

function getLastUserMessage(deps: AgentLoopDeps): string {
  const context = deps.sessionMemory.getPromptMemoryContext();
  const turns = context.conversationTurns ?? [];
  const lastUser = [...turns].reverse().find((t) => t.role === "user");
  return lastUser?.content ?? "";
}
