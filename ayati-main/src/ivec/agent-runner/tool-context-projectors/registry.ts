import { compactPromptToolCall } from "../run-tool-call-context.js";
import type { PromptRunToolCallContext } from "../run-tool-call-context.js";
import { getToolTaxonomy } from "../../../skills/tool-taxonomy.js";
import { filesystemReadProjector } from "./filesystem-read.js";
import { filesystemSearchProjector } from "./filesystem-search.js";
import { filesystemWriteProjector } from "./filesystem-write.js";
import { gitContextProjector } from "./git-context.js";
import { historyProjector } from "./history.js";
import { processProjector } from "./process.js";
import { testBuildProjector } from "./test-build.js";
import type {
  PressureProjectionMode,
  ToolContextCompactionPolicy,
  ToolContextProjection,
  ToolContextProjector,
} from "./types.js";

const PROJECTORS: ToolContextProjector[] = [
  testBuildProjector,
  filesystemReadProjector,
  filesystemSearchProjector,
  filesystemWriteProjector,
  historyProjector,
  gitContextProjector,
  processProjector,
];

export function projectToolCallForPressure(
  call: PromptRunToolCallContext,
  mode: PressureProjectionMode,
): ToolContextProjection | undefined {
  const projector = PROJECTORS.find((candidate) => candidate.supports(call));
  if (projector) {
    return projector.project(call, mode);
  }
  if (mode !== "reference" || !getToolTaxonomy(call.tool)) return undefined;
  const compacted = compactPromptToolCall(call, "reference", "context_budget");
  return {
    projectorId: "typed_reference_v1",
    call: {
      ...compacted,
      input: referenceInput(call.input),
      candidateSet: undefined,
      projectionMetadata: undefined,
      outputPreview: undefined,
    },
  };
}

export function toolContextCompactionPolicy(
  call: PromptRunToolCallContext,
): ToolContextCompactionPolicy {
  if (PROJECTORS.some((candidate) => candidate.supports(call))) {
    return "projectable";
  }
  return getToolTaxonomy(call.tool) ? "referenceable" : "exact_only";
}

function referenceInput(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const scalarKeys = [
    "path",
    "file",
    "filePath",
    "targetPath",
    "workdir",
    "cwd",
    "query",
    "pattern",
    "resourceId",
    "workstreamId",
    "requestId",
    "runId",
    "step",
    "callId",
  ];
  const output: Record<string, unknown> = {};
  for (const key of scalarKeys) {
    const item = record[key];
    if (typeof item === "string" || typeof item === "number") output[key] = item;
  }
  for (const key of ["paths", "files", "targets"]) {
    const items = record[key];
    if (!Array.isArray(items)) continue;
    output[key] = items.slice(0, 8).map((item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object" || Array.isArray(item)) return {};
      const candidate = item as Record<string, unknown>;
      return Object.fromEntries(
        ["path", "filePath", "resourceId", "kind"]
          .filter((field) => typeof candidate[field] === "string")
          .map((field) => [field, candidate[field]]),
      );
    });
  }
  return output;
}
