import type { ToolOperationStatus, ToolResultV2 } from "./assertion-types.js";

export function toolStatusMatches(result: ToolResultV2, expected: ToolOperationStatus): boolean {
  return result.operationStatus === expected;
}

