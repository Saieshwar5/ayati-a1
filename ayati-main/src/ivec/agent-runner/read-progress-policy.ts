import type { AgentAction, AgentToolCallSpec } from "./decision.js";
import type { ActOutput, ReadProgressState } from "../types.js";
import type { RepairCode } from "./repair-policy.js";
import { hasMutationEffect } from "../../skills/tool-taxonomy.js";

const MAX_SIGNATURES_RETAINED = 40;

const TRACKED_OBSERVATIONAL_TOOLS = new Set([
  "read_files",
  "search_in_files",
  "find_files",
  "list_directory",
]);

export interface ReadProgressViolation {
  code: Extract<RepairCode, "R_DUPLICATE_READ" | "R_MUTATION_EXPECTED_AFTER_CONTEXT">;
  message: string;
  blockedTargets: string[];
  allowedNextActions: string[];
  operatorDetails: Record<string, unknown>;
}

export function createEmptyReadProgressState(): ReadProgressState {
  return {
    observationalStepCount: 0,
    duplicateReadCount: 0,
    mutationStepCount: 0,
    rejectedReadCount: 0,
    signatures: [],
  };
}

export function evaluateReadProgressGuard(
  state: ReadProgressState | undefined,
  action: AgentAction,
): ReadProgressViolation | undefined {
  const progress = state ?? createEmptyReadProgressState();
  const readCalls = action.calls
    .filter((call) => TRACKED_OBSERVATIONAL_TOOLS.has(call.tool))
    .map((call) => ({ call, signature: readSignature(call) }));
  if (readCalls.length === 0 || action.calls.some((call) => hasMutationEffect(call.tool))) {
    return undefined;
  }
  if (progress.mutationStepCount > 0) {
    return undefined;
  }

  const previousSignatures = new Set(progress.signatures);
  const duplicate = readCalls.find(({ signature }) => signature && previousSignatures.has(signature));
  if (duplicate?.signature) {
    return {
      code: "R_DUPLICATE_READ",
      message: "The selected read repeats an equivalent observation that is already current in this run.",
      blockedTargets: [duplicate.call.tool],
      allowedNextActions: [
        "If a matching outcomeRef is projected in context.run.verifiedOutcomes, select it and enter validation instead of reading again.",
        "If the user asked for a concrete file change, call patch_files or write_files next.",
        "Change the read scope only when the current verified coverage is insufficient.",
      ],
      operatorDetails: {
        tool: duplicate.call.tool,
        signature: duplicate.signature,
        observationalStepCount: progress.observationalStepCount,
        duplicateReadCount: progress.duplicateReadCount + 1,
        mutationStepCount: progress.mutationStepCount,
      },
    };
  }

  return undefined;
}

export function markReadProgressRejected(
  state: ReadProgressState | undefined,
): ReadProgressState {
  const progress = state ?? createEmptyReadProgressState();
  return {
    ...progress,
    rejectedReadCount: progress.rejectedReadCount + 1,
  };
}

export function updateReadProgressAfterActOutput(
  state: ReadProgressState | undefined,
  output: ActOutput,
): ReadProgressState {
  const progress = state ?? createEmptyReadProgressState();
  const successfulCalls = output.toolCalls.filter((call) => !call.error && call.operationStatus !== "failed");
  const mutationCalls = successfulCalls.filter((call) => hasMutationEffect(call.tool));
  if (mutationCalls.length > 0) {
    return {
      ...progress,
      mutationStepCount: progress.mutationStepCount + mutationCalls.length,
      observationalStepCount: 0,
      duplicateReadCount: 0,
      signatures: [],
    };
  }

  const readSignatures = successfulCalls
    .filter((call) => TRACKED_OBSERVATIONAL_TOOLS.has(call.tool))
    .map((call) => readSignature({ tool: call.tool, input: normalizeRecord(call.input) }))
    .filter((signature): signature is string => Boolean(signature));
  if (readSignatures.length === 0) {
    return progress;
  }

  const existing = new Set(progress.signatures);
  const duplicateCount = readSignatures.filter((signature) => existing.has(signature)).length;
  const signatures = [...progress.signatures, ...readSignatures.filter((signature) => !existing.has(signature))]
    .slice(-MAX_SIGNATURES_RETAINED);

  return {
    ...progress,
    observationalStepCount: progress.observationalStepCount + readSignatures.length,
    duplicateReadCount: progress.duplicateReadCount + duplicateCount,
    signatures,
  };
}

function readSignature(call: Pick<AgentToolCallSpec, "tool" | "input">): string | undefined {
  const input = normalizeRecord(call.input);
  switch (call.tool) {
    case "read_files":
      return stableSignature(call.tool, {
        files: normalizeReadFilesInput(input["files"]),
        maxPerFileChars: input["maxPerFileChars"],
        maxTotalChars: input["maxTotalChars"],
        allowMissing: input["allowMissing"],
      });
    case "search_in_files":
      return stableSignature(call.tool, normalizeSearchInFilesInput(input));
    case "find_files":
      return stableSignature(call.tool, pick(input, ["query", "roots", "maxDepth", "maxResults"]));
    case "list_directory":
      return stableSignature(call.tool, pick(input, ["path", "recursive", "showHidden", "maxEntries"]));
    default:
      return undefined;
  }
}

function normalizeSearchInFilesInput(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const resultMode = input["resultMode"] === "snippets"
    ? "snippets"
    : input["resultMode"] === "count"
      ? "count"
      : "paths";
  const common = {
    query: input["query"],
    roots: normalizeStringArray(input["roots"]),
    maxDepth: input["maxDepth"] ?? 10,
    includeHidden: input["includeHidden"] ?? false,
    caseSensitive: input["caseSensitive"] ?? false,
    resultMode,
  };
  return {
    ...common,
    ...(resultMode === "count"
      ? {}
      : { maxResults: input["maxResults"] ?? 500 }),
    ...(resultMode === "snippets"
      ? { contextLines: input["contextLines"] ?? 1 }
      : {}),
  };
}

function normalizeStringArray(value: unknown): unknown {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    return value;
  }
  return [...new Set(value)].sort();
}

function normalizeReadFilesInput(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return value;
  }
  return value.map((entry) => {
    const record = normalizeRecord(entry);
    return pick(record, ["path", "mode", "query", "startLine", "lineCount", "contextLines"]);
  });
}

function pick(record: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    if (record[key] !== undefined) {
      picked[key] = record[key];
    }
  }
  return picked;
}

function stableSignature(tool: string, value: unknown): string {
  return `${tool}:${stableJson(value)}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
