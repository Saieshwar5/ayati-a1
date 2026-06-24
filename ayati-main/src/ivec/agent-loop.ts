import type { AgentLoopDeps, AgentLoopResult, LoopConfig } from "./types.js";
import { DEFAULT_LOOP_CONFIG } from "./types.js";
import { runAgentLoop } from "./agent-runner/runner.js";

export async function agentLoop(deps: AgentLoopDeps): Promise<AgentLoopResult> {
  const config: LoopConfig = { ...DEFAULT_LOOP_CONFIG, ...deps.config };
  validateLoopConfig(config);
  return runAgentLoop(deps, config);
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
}
