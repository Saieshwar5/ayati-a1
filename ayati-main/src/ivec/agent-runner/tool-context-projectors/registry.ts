import { compactPromptToolCall } from "../run-tool-call-context.js";
import type { PromptRunToolCallContext } from "../run-tool-call-context.js";
import { filesystemReadProjector } from "./filesystem-read.js";
import { filesystemSearchProjector } from "./filesystem-search.js";
import { filesystemWriteProjector } from "./filesystem-write.js";
import { gitContextProjector } from "./git-context.js";
import { shellProjector } from "./shell.js";
import { testBuildProjector } from "./test-build.js";
import type { PressureProjectionMode, ToolContextProjection, ToolContextProjector } from "./types.js";

const PROJECTORS: ToolContextProjector[] = [
  testBuildProjector,
  filesystemReadProjector,
  filesystemSearchProjector,
  filesystemWriteProjector,
  gitContextProjector,
  shellProjector,
];

export function projectToolCallForPressure(
  call: PromptRunToolCallContext,
  mode: PressureProjectionMode,
): ToolContextProjection {
  const projector = PROJECTORS.find((candidate) => candidate.supports(call));
  if (projector) {
    return projector.project(call, mode);
  }
  return {
    projectorId: "generic_v1",
    call: compactPromptToolCall(call, mode, "context_budget"),
  };
}
