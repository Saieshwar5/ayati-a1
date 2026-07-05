import type { Condition } from "../../types.js";
import type { ToolContextObservation } from "../../observations/context-observation.js";

export const FILE_METADATA_RECOMMENDED = "FILE_METADATA_RECOMMENDED";

const DEFAULT_MESSAGE = "For unknown, broad, large, truncated, or mixed path reads, inspect_paths can check size, type, line count, and recommended read mode before another content read.";

export function fileMetadataAdvisoryCondition(reason?: string): Condition {
  const message = reason
    ? `${reason} ${DEFAULT_MESSAGE}`
    : DEFAULT_MESSAGE;
  return {
    code: FILE_METADATA_RECOMMENDED,
    severity: "info",
    message,
  };
}

export function addFileMetadataAdvisory(
  observation: ToolContextObservation,
  reason: string,
): ToolContextObservation {
  const advisory = `Advisory: ${reason} Use inspect_paths before another broad content read if current context is not enough.`;
  return {
    ...observation,
    highlights: [...observation.highlights, advisory],
    stats: {
      ...observation.stats,
      fileMetadataAdvisory: true,
    },
  };
}
