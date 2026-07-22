import type { AgentLoopDeps, AgentLoopResult, LoopConfig } from "./types.js";
import { DEFAULT_LOOP_CONFIG } from "./types.js";
import { runAgentLoop } from "./agent-runner/runner.js";
import { ContextPreparationManager } from "./context-preparation/manager.js";
import { withEvaluationContext } from "../evaluation/capture-runtime.js";

export async function agentLoop(deps: AgentLoopDeps): Promise<AgentLoopResult> {
  return await withEvaluationContext({
    runId: deps.runHandle.runId,
    sessionId: deps.runHandle.streamId,
    laneId: `main:${deps.runHandle.runId}`,
    attribution: "foreground",
  }, async () => {
    const config: LoopConfig = { ...DEFAULT_LOOP_CONFIG, ...deps.config };
    validateLoopConfig(config);
    const contextPreparation = deps.contextPreparation ?? new ContextPreparationManager({
      laneId: `main:${deps.runHandle.runId}`,
      provider: deps.provider,
      onDetachedEvent: (event) => {
        deps.feedbackLedger?.record({
          clientId: deps.clientId,
          sessionId: deps.runHandle.streamId,
          runId: deps.runHandle.runId,
          stage: "decision",
          event: event.event,
          data: {
            laneId: event.laneId,
            at: event.at,
            ...event.data,
          },
        });
      },
    });
    try {
      return await runAgentLoop({ ...deps, contextPreparation }, config);
    } finally {
      contextPreparation.close();
    }
  });
}

function validateLoopConfig(config: LoopConfig): void {
  if (config.maxIterations <= 0) {
    throw new Error("maxIterations must be positive");
  }
  if (config.maxConsecutiveFailures <= 0) {
    throw new Error("maxConsecutiveFailures must be positive");
  }
  if (config.maxTotalToolCallsPerStep <= 0) {
    throw new Error("maxTotalToolCallsPerStep must be positive");
  }
  if (config.maxSequentialToolCallsPerStep <= 0) {
    throw new Error("maxSequentialToolCallsPerStep must be positive");
  }
  if (config.maxParallelToolCallsPerStep <= 0) {
    throw new Error("maxParallelToolCallsPerStep must be positive");
  }
  if (config.maxInlineActOutputChars <= 0) {
    throw new Error("maxInlineActOutputChars must be positive");
  }
  if (config.maxVerifyArtifactChars <= 0) {
    throw new Error("maxVerifyArtifactChars must be positive");
  }
  if (config.maxSelectedTools <= 0) {
    throw new Error("maxSelectedTools must be positive");
  }
  if (config.strategyReviewFailureThreshold <= 0) {
    throw new Error("strategyReviewFailureThreshold must be positive");
  }
  if (config.toolContextProjectionPolicy !== "shadow" && config.toolContextProjectionPolicy !== "enforce") {
    throw new Error("toolContextProjectionPolicy must be shadow or enforce");
  }
}
