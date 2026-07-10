import type { PromptToolCallContext } from "../types.js";

export const RUN_STEP_RECOVERY_TOOL_NAME = "git_context_read_run_step";

export type PromptRunToolCallMode = "full" | "preview" | "summary" | "reference";

export interface PromptRunToolCallContext {
  step: number;
  callId?: string;
  tool: string;
  input: unknown;
  status: "success" | "failed";
  mode: PromptRunToolCallMode;
  output?: string;
  outputPreview?: string;
  summary?: string;
  error?: string;
  code?: string;
  operationStatus?: PromptToolCallContext["operationStatus"];
  artifacts?: PromptToolCallContext["artifacts"];
  stepRef?: PromptToolCallContext["stepRef"];
  evidenceRef?: string;
  rawOutputChars?: number;
  originalOutputChars?: number;
  outputTruncated?: boolean;
  outputCompacted?: boolean;
  recoverable?: boolean;
  compactionReason?: "context_budget" | "truncated_output";
}

export type PromptToolCalls = PromptRunToolCallContext[];

const PROMPT_TOOL_CALL_POLICY = {
  protectedRecentCalls: 2,
  maxTotalChars: 30_000,
  maxPreviewOutputChars: 4_000,
  maxSummaryOutputChars: 1_000,
  maxPreviewInputStringChars: 1_200,
  maxSummaryInputStringChars: 800,
  maxReferenceInputStringChars: 300,
  maxErrorChars: 1_600,
  maxSummaryChars: 520,
};

export function buildPromptToolCallsForRun(calls: PromptToolCallContext[] | undefined): PromptToolCalls | undefined {
  const projected = applyPromptToolCallBudget((calls ?? []).map(projectPromptToolCall));
  return projected.length > 0 ? projected : undefined;
}

export function hasRecoverableCompactedRunToolCall(calls: PromptToolCallContext[] | undefined): boolean {
  return (buildPromptToolCallsForRun(calls) ?? []).some((call) => (
    call.mode !== "full" && call.outputCompacted === true && Boolean(call.stepRef)
  ));
}

function projectPromptToolCall(call: PromptToolCallContext): PromptRunToolCallContext {
  const projected: PromptRunToolCallContext = {
    step: call.step,
    ...(call.callId ? { callId: call.callId } : {}),
    tool: call.tool,
    input: call.input,
    status: call.status,
    mode: "full",
    output: call.output,
    ...(call.error ? { error: truncatePreserveLines(call.error, PROMPT_TOOL_CALL_POLICY.maxErrorChars) } : {}),
    ...(call.code ? { code: call.code } : {}),
    ...(call.operationStatus ? { operationStatus: call.operationStatus } : {}),
    ...(call.artifacts && call.artifacts.length > 0 ? { artifacts: call.artifacts } : {}),
    ...(call.stepRef ? { stepRef: call.stepRef } : {}),
    ...(call.evidenceRef ? { evidenceRef: call.evidenceRef } : {}),
    ...(call.rawOutputChars !== undefined ? { rawOutputChars: call.rawOutputChars } : {}),
    ...(call.outputTruncated !== undefined ? { outputTruncated: call.outputTruncated } : {}),
  };
  return call.outputTruncated === true
    ? compactPromptToolCall(projected, "preview", "truncated_output")
    : projected;
}

function applyPromptToolCallBudget(calls: PromptRunToolCallContext[]): PromptRunToolCallContext[] {
  if (calls.length === 0) {
    return [];
  }

  const compacted = [...calls];

  if (measurePromptJson(compacted) <= PROMPT_TOOL_CALL_POLICY.maxTotalChars) {
    return compacted;
  }

  degradeOldestCalls(compacted, {
    from: "full",
    to: "preview",
    protectedRecentCount: PROMPT_TOOL_CALL_POLICY.protectedRecentCalls,
    includeFailures: false,
  });
  if (measurePromptJson(compacted) <= PROMPT_TOOL_CALL_POLICY.maxTotalChars) {
    return compacted;
  }

  degradeOldestCalls(compacted, {
    from: "preview",
    to: "summary",
    protectedRecentCount: PROMPT_TOOL_CALL_POLICY.protectedRecentCalls,
    includeFailures: false,
  });
  if (measurePromptJson(compacted) <= PROMPT_TOOL_CALL_POLICY.maxTotalChars) {
    return compacted;
  }

  degradeOldestCalls(compacted, {
    from: "full",
    to: "preview",
    protectedRecentCount: PROMPT_TOOL_CALL_POLICY.protectedRecentCalls,
    includeFailures: true,
  });
  if (measurePromptJson(compacted) <= PROMPT_TOOL_CALL_POLICY.maxTotalChars) {
    return compacted;
  }

  degradeOldestCalls(compacted, {
    from: "preview",
    to: "summary",
    protectedRecentCount: PROMPT_TOOL_CALL_POLICY.protectedRecentCalls,
    includeFailures: true,
  });
  if (measurePromptJson(compacted) <= PROMPT_TOOL_CALL_POLICY.maxTotalChars) {
    return compacted;
  }

  degradeOldestCalls(compacted, {
    from: "full",
    to: "preview",
    protectedRecentCount: 0,
    includeFailures: true,
  });
  if (measurePromptJson(compacted) <= PROMPT_TOOL_CALL_POLICY.maxTotalChars) {
    return compacted;
  }

  degradeOldestCalls(compacted, {
    from: "preview",
    to: "summary",
    protectedRecentCount: 0,
    includeFailures: true,
  });
  if (measurePromptJson(compacted) <= PROMPT_TOOL_CALL_POLICY.maxTotalChars) {
    return compacted;
  }

  degradeOldestCalls(compacted, {
    from: "summary",
    to: "reference",
    protectedRecentCount: 0,
    includeFailures: true,
  });
  return compacted;
}

function degradeOldestCalls(
  calls: PromptRunToolCallContext[],
  options: {
    from: PromptRunToolCallMode;
    to: Exclude<PromptRunToolCallMode, "full">;
    protectedRecentCount: number;
    includeFailures: boolean;
  },
): void {
  const protectedStart = Math.max(0, calls.length - options.protectedRecentCount);
  for (let index = 0; index < protectedStart; index += 1) {
    const call = calls[index];
    if (!call || call.mode !== options.from || (!options.includeFailures && call.status === "failed")) {
      continue;
    }
    calls[index] = compactPromptToolCall(call, options.to, "context_budget");
    if (measurePromptJson(calls) <= PROMPT_TOOL_CALL_POLICY.maxTotalChars) {
      return;
    }
  }
}

function compactPromptToolCall(
  call: PromptRunToolCallContext,
  mode: Exclude<PromptRunToolCallMode, "full">,
  reason: NonNullable<PromptRunToolCallContext["compactionReason"]>,
): PromptRunToolCallContext {
  const output = call.output ?? call.outputPreview ?? "";
  const outputPreview = mode === "preview"
    ? truncatePreserveLines(output, PROMPT_TOOL_CALL_POLICY.maxPreviewOutputChars)
    : mode === "summary"
      ? truncatePreserveLines(output, PROMPT_TOOL_CALL_POLICY.maxSummaryOutputChars)
      : "";
  const inputChars = mode === "preview"
    ? PROMPT_TOOL_CALL_POLICY.maxPreviewInputStringChars
    : mode === "summary"
      ? PROMPT_TOOL_CALL_POLICY.maxSummaryInputStringChars
      : PROMPT_TOOL_CALL_POLICY.maxReferenceInputStringChars;
  const recoverable = Boolean(call.stepRef);
  return {
    step: call.step,
    ...(call.callId ? { callId: call.callId } : {}),
    tool: call.tool,
    input: compactUnknownForPrompt(call.input, inputChars),
    status: call.status,
    mode,
    summary: buildToolCallSummary(call),
    ...(outputPreview.length > 0 ? { outputPreview } : {}),
    ...(call.error ? { error: truncatePreserveLines(call.error, PROMPT_TOOL_CALL_POLICY.maxErrorChars) } : {}),
    ...(call.code ? { code: call.code } : {}),
    ...(call.operationStatus ? { operationStatus: call.operationStatus } : {}),
    ...(call.artifacts && call.artifacts.length > 0 ? { artifacts: call.artifacts } : {}),
    ...(call.stepRef ? { stepRef: call.stepRef } : {}),
    ...(call.evidenceRef ? { evidenceRef: call.evidenceRef } : {}),
    ...(call.rawOutputChars !== undefined ? { rawOutputChars: call.rawOutputChars } : {}),
    ...(output.length > 0 ? { originalOutputChars: call.originalOutputChars ?? output.length } : {}),
    ...(call.outputTruncated !== undefined ? { outputTruncated: call.outputTruncated } : {}),
    outputCompacted: true,
    ...(recoverable ? { recoverable: true } : {}),
    compactionReason: reason,
  };
}

function buildToolCallSummary(call: PromptRunToolCallContext): string {
  const target = describeToolInput(call.input);
  const outputLength = call.rawOutputChars ?? call.originalOutputChars ?? call.output?.length ?? call.outputPreview?.length ?? 0;
  const artifactCount = call.artifacts?.length ?? 0;
  const targetSuffix = target ? ` for ${target}` : "";
  const outputSuffix = outputLength > 0 ? ` Output was ${outputLength} chars before prompt compaction.` : "";
  const artifactSuffix = artifactCount > 0 ? ` Produced ${artifactCount} artifact${artifactCount === 1 ? "" : "s"}.` : "";
  if (call.status === "failed") {
    const error = call.error ? ` Error: ${truncate(call.error, 180)}` : "";
    return truncate(`${call.tool} failed${targetSuffix}.${error}${outputSuffix}${artifactSuffix}`, PROMPT_TOOL_CALL_POLICY.maxSummaryChars);
  }
  if (isSearchTool(call.tool)) {
    return truncate(`${call.tool} searched${targetSuffix}.${outputSuffix}${artifactSuffix}`, PROMPT_TOOL_CALL_POLICY.maxSummaryChars);
  }
  if (isReadTool(call.tool)) {
    return truncate(`${call.tool} read${targetSuffix}.${outputSuffix}${artifactSuffix}`, PROMPT_TOOL_CALL_POLICY.maxSummaryChars);
  }
  if (isWriteTool(call.tool)) {
    return truncate(`${call.tool} changed workspace state${targetSuffix}.${outputSuffix}${artifactSuffix}`, PROMPT_TOOL_CALL_POLICY.maxSummaryChars);
  }
  if (isShellTool(call.tool)) {
    return truncate(`${call.tool} ran${targetSuffix}.${outputSuffix}${artifactSuffix}`, PROMPT_TOOL_CALL_POLICY.maxSummaryChars);
  }
  return truncate(`${call.tool} completed${targetSuffix}.${outputSuffix}${artifactSuffix}`, PROMPT_TOOL_CALL_POLICY.maxSummaryChars);
}

function describeToolInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return typeof input === "string" && input.trim().length > 0 ? truncate(input, 140) : undefined;
  }
  const record = input as Record<string, unknown>;
  const command = readStringField(record, ["cmd", "command", "script"]);
  if (command) {
    return truncate(command, 180);
  }
  const path = readStringField(record, ["path", "file", "filePath", "targetPath", "workdir"]);
  const query = readStringField(record, ["query", "pattern", "search"]);
  if (path && query) {
    return `${truncate(path, 100)} matching ${truncate(query, 80)}`;
  }
  if (path) {
    return truncate(path, 140);
  }
  if (query) {
    return truncate(query, 140);
  }
  const keys = Object.keys(record).slice(0, 4);
  return keys.length > 0 ? `input keys: ${keys.join(", ")}` : undefined;
}

function readStringField(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function isReadTool(tool: string): boolean {
  return /\b(read|inspect|list|show|cat)\b|read_files|inspect_paths|list_directory/.test(tool);
}

function isSearchTool(tool: string): boolean {
  return /\b(search|find|grep|rg)\b|search_in_files|find_files/.test(tool);
}

function isWriteTool(tool: string): boolean {
  return /\b(write|edit|patch|create|delete|move|rename|save)\b|apply_patch/.test(tool);
}

function isShellTool(tool: string): boolean {
  return /\b(shell|exec|command|terminal|script)\b|exec_command|shell_run_script/.test(tool);
}

function compactUnknownForPrompt(value: unknown, maxStringChars: number): unknown {
  if (typeof value === "string") {
    return truncatePreserveLines(value, maxStringChars);
  }
  if (Array.isArray(value)) {
    return value.map((item) => compactUnknownForPrompt(item, maxStringChars));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = compactUnknownForPrompt(item, maxStringChars);
  }
  return output;
}

function measurePromptJson(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return String(value).length;
  }
}

function truncate(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function truncatePreserveLines(value: string, maxLength: number): string {
  const normalized = value.trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}
