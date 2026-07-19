import type { AgentAction, AgentToolCallSpec } from "./decision.js";
import type { ActOutput, ReadProgressState } from "../types.js";
import type { RepairCode } from "./repair-policy.js";
import { hasMutationEffect } from "../../skills/tool-taxonomy.js";

const MAX_OBSERVATIONAL_STEPS_BEFORE_MUTATION = 3;
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
      message: "The selected read repeats context that is already available in this task-bound run.",
      blockedTargets: [duplicate.call.tool],
      allowedNextActions: [
        "Use the current observations/evidence instead of reading the same target again.",
        "If the user asked for a concrete file change, call patch_files or write_files next.",
        "Ask one specific clarification if the missing detail blocks the requested change.",
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

  if (progress.observationalStepCount >= MAX_OBSERVATIONAL_STEPS_BEFORE_MUTATION) {
    return {
      code: "R_MUTATION_EXPECTED_AFTER_CONTEXT",
      message: "This task-bound run has already gathered enough read context before making a change.",
      blockedTargets: readCalls.map(({ call }) => call.tool),
      allowedNextActions: [
        "Use the current observations/evidence to make the requested change.",
        "Call patch_files or write_files next when the user asked to build or update files.",
        "Ask one specific clarification if the change cannot be made from the available context.",
      ],
      operatorDetails: {
        attemptedTools: readCalls.map(({ call }) => call.tool),
        attemptedSignatures: readCalls.map(({ signature }) => signature),
        observationalStepCount: progress.observationalStepCount,
        mutationStepCount: progress.mutationStepCount,
        maxObservationalStepsBeforeMutation: MAX_OBSERVATIONAL_STEPS_BEFORE_MUTATION,
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
      return stableSignature(call.tool, pick(input, ["query", "roots", "maxDepth", "caseSensitive", "contextLines", "maxResults"]));
    case "find_files":
      return stableSignature(call.tool, pick(input, ["query", "roots", "maxDepth", "maxResults"]));
    case "list_directory":
      return stableSignature(call.tool, pick(input, ["path", "recursive", "showHidden", "maxEntries"]));
    default:
      return undefined;
  }
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
