import { createId } from "../shared/index.js";
import type {
  AgentLoopDeps,
  AgentLoopResult,
  LoopState,
  LoopConfig,
  ControllerOutput,
  SessionRotationDirective,
} from "./types.js";
import { DEFAULT_LOOP_CONFIG } from "./types.js";

function isRotationDirective(output: ControllerOutput): output is SessionRotationDirective {
  return !output.done && "rotate_session" in output && (output as SessionRotationDirective).rotate_session === true;
}
import { initRunDirectory, writeJSON, readState } from "./state-persistence.js";
import { callController } from "./controller.js";
import { executeStep } from "./executor.js";

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
  };

  // Populate user message from sessionMemory context
  state.userMessage = getLastUserMessage(deps);
  state.goal = state.userMessage;
  state.approach = "Determine best approach based on available tools and context.";

  writeJSON(runPath, "state.json", state);

  while (state.status === "running" && state.iteration < config.maxIterations) {
    const diskState = readState(runPath);
    if (diskState) {
      Object.assign(state, diskState);
    }

    state.iteration++;

    const controllerOutput = await callController(deps.provider, state, deps.toolDefinitions, deps.systemContext);

    if (controllerOutput.done) {
      state.status = controllerOutput.status === "failed" ? "failed" : "completed";
      writeJSON(runPath, "state.json", state);
      return {
        type: "reply",
        content: controllerOutput.summary,
        status: state.status,
        totalIterations: state.iteration,
        totalToolCalls,
        runPath,
      };
    }

    if (isRotationDirective(controllerOutput)) {
      deps.sessionMemory.createSession?.(deps.clientId, {
        runId: deps.runHandle.runId,
        reason: controllerOutput.reason,
        source: "agent",
        handoffSummary: controllerOutput.handoff_summary,
      });
      state.status = "completed";
      writeJSON(runPath, "state.json", state);
      return {
        type: "reply",
        content: `Session rotated: ${controllerOutput.reason}`,
        status: "completed",
        totalIterations: state.iteration,
        totalToolCalls,
        runPath,
      };
    }

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

function getLastUserMessage(deps: AgentLoopDeps): string {
  const context = deps.sessionMemory.getPromptMemoryContext();
  const turns = context.conversationTurns ?? [];
  const lastUser = [...turns].reverse().find((t) => t.role === "user");
  return lastUser?.content ?? "";
}
