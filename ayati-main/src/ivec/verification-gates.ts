import type { ActOutput, VerifyOutput, VerificationExecutionStatus } from "./types.js";

function formatToolErrors(calls: Array<{ tool: string; error?: string }>): string {
  return calls
    .filter((call) => call.error)
    .map((call) => `${call.tool}: ${call.error}`)
    .join("; ");
}

export function deriveExecutionStatus(actOutput: ActOutput): VerificationExecutionStatus {
  if (actOutput.toolCalls.length === 0) {
    return "no_tools";
  }

  const successfulCalls = actOutput.toolCalls.filter((call) => !call.error).length;
  if (successfulCalls === 0) {
    return "all_failed";
  }
  if (successfulCalls === actOutput.toolCalls.length) {
    return "all_succeeded";
  }
  return "partial_success";
}

/**
 * Execution-only verification gates.
 *
 * These gates answer a narrow question: do we have enough successful execution
 * to justify output validation? They never mark a step as passed on their own.
 */
export function checkVerificationGates(actOutput: ActOutput): VerifyOutput | null {
  const executionStatus = deriveExecutionStatus(actOutput);

  if (executionStatus === "all_failed") {
    return {
      passed: false,
      method: "execution_gate",
      executionStatus,
      validationStatus: "skipped",
      summary: "Step failed during tool execution before output validation could run.",
      evidenceSummary: `All tool calls failed: ${formatToolErrors(actOutput.toolCalls)}`,
      evidenceItems: actOutput.toolCalls
        .filter((call) => call.error)
        .map((call) => `${call.tool}: ${call.error}`),
      newFacts: [],
      artifacts: [],
      usedRawArtifacts: [],
    };
  }

  if (executionStatus === "no_tools" && actOutput.finalText.trim().length === 0) {
    return {
      passed: false,
      method: "execution_gate",
      executionStatus,
      validationStatus: "skipped",
      summary: "Step produced no output to validate.",
      evidenceSummary: actOutput.stoppedEarlyReason
        ? `Execution stopped before producing output: ${actOutput.stoppedEarlyReason}.`
        : "Execution produced no tool output and no final text.",
      evidenceItems: actOutput.stoppedEarlyReason ? [actOutput.stoppedEarlyReason] : [],
      newFacts: [],
      artifacts: [],
      usedRawArtifacts: [],
    };
  }

  return null;
}

const DETERMINISTIC_SUCCESS_TOOLS = new Set([
  "create_directory",
  "delete",
  "patch_files",
  "move",
  "write_files",
  "read_files",
  "list_directory",
  "find_files",
  "search_in_files",
  "attachment_restore",
  "attachment_list",
  "attachment_inspect",
  "attachment_read",
  "attachment_query",
  "attachment_query_table",
  "directory_search",
  "restore_attachment_context",
  "dataset_profile",
  "dataset_query",
  "dataset_promote_table",
  "document_list_sections",
  "document_read_section",
  "document_query",
]);

export function checkDeterministicSuccessGate(
  actOutput: ActOutput,
  successCriteria: string,
): VerifyOutput | null {
  const executionStatus = deriveExecutionStatus(actOutput);
  if (executionStatus !== "all_succeeded" || actOutput.toolCalls.length === 0) {
    return null;
  }

  const unsupportedTool = actOutput.toolCalls.find((call) => !isDeterministicSuccessCall(call));
  if (unsupportedTool) {
    return null;
  }
  if (!isDeterministicCriteriaCompatible(actOutput, successCriteria)) {
    return null;
  }

  const evidenceItems = actOutput.toolCalls.map(formatDeterministicEvidenceItem);
  const summary = buildDeterministicSummary(actOutput, successCriteria, evidenceItems);
  return {
    passed: true,
    method: "script",
    executionStatus,
    validationStatus: "passed",
    summary,
    evidenceSummary: evidenceItems.join("; "),
    evidenceItems,
    newFacts: evidenceItems,
    artifacts: [],
    usedRawArtifacts: [],
  };
}

const READ_ONLY_SUCCESS_TOOLS = new Set([
  "read_files",
  "list_directory",
  "find_files",
  "search_in_files",
  "attachment_list",
  "attachment_inspect",
  "attachment_read",
  "attachment_query",
  "attachment_query_table",
  "directory_search",
  "dataset_profile",
  "dataset_query",
  "document_list_sections",
  "document_read_section",
  "document_query",
]);

export function isDeterministicSuccessTool(tool: string): boolean {
  return DETERMINISTIC_SUCCESS_TOOLS.has(tool);
}

function isDeterministicSuccessCall(call: ActOutput["toolCalls"][number]): boolean {
  if (!DETERMINISTIC_SUCCESS_TOOLS.has(call.tool)) {
    return false;
  }

  const payload = parseJsonObject(call.output);
  switch (call.tool) {
    case "attachment_restore":
    case "restore_attachment_context":
      return typeof payload?.["attachmentKind"] === "string"
        && typeof payload["attachmentId"] === "string"
        && payload["attachmentId"].trim().length > 0;
    case "attachment_list":
      return Array.isArray(payload?.["files"]) && Array.isArray(payload["directories"]);
    case "attachment_inspect":
      return payload?.["type"] === "file" || payload?.["type"] === "directory";
    case "attachment_read":
      return payload?.["type"] === "file"
        ? typeof payload["text"] === "string"
        : payload?.["type"] === "directory" && typeof payload["directory"] === "object";
    case "attachment_query":
      return payload?.["type"] === "file"
        ? typeof payload["matchCount"] === "number" && Array.isArray(payload["matches"])
        : payload?.["type"] === "directory" && typeof payload["matchCount"] === "number" && Array.isArray(payload["matches"]);
    case "attachment_query_table":
      return typeof payload?.["rowCount"] === "number" && Array.isArray(payload["rows"]);
    case "directory_search":
      return typeof payload?.["matchCount"] === "number" && Array.isArray(payload["matches"]);
    case "dataset_profile":
      return typeof payload?.["rowCount"] === "number" && Array.isArray(payload["columns"]);
    case "dataset_query":
      return typeof payload?.["rowCount"] === "number" && Array.isArray(payload["rows"]);
    case "dataset_promote_table":
      return typeof payload?.["rowsCopied"] === "number"
        && typeof payload["targetTable"] === "string"
        && payload["targetTable"].trim().length > 0;
    case "document_list_sections":
      return typeof payload?.["sectionCount"] === "number" && Array.isArray(payload["sections"]);
    case "document_read_section":
      return Array.isArray(payload?.["sections"]) && payload["sections"].length > 0;
    case "document_query":
      return isGroundedDocumentQueryPayload(payload);
    default:
      return true;
  }
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function isGroundedDocumentQueryPayload(payload: Record<string, unknown> | null): boolean {
  if (!payload) {
    return false;
  }
  const context = typeof payload["context"] === "string" ? payload["context"].trim() : "";
  const sources = Array.isArray(payload["sources"]) ? payload["sources"] : [];
  const confidence = typeof payload["confidence"] === "number" ? payload["confidence"] : 0;
  const documentState = payload["documentState"] && typeof payload["documentState"] === "object" && !Array.isArray(payload["documentState"])
    ? payload["documentState"] as Record<string, unknown>
    : {};
  return context.length > 0
    && sources.length > 0
    && confidence > 0
    && documentState["insufficientEvidence"] !== true;
}

function isDeterministicCriteriaCompatible(actOutput: ActOutput, successCriteria: string): boolean {
  const tools = new Set(actOutput.toolCalls.map((call) => call.tool));
  const readOnly = [...tools].every((tool) => READ_ONLY_SUCCESS_TOOLS.has(tool));
  if (!readOnly) {
    return true;
  }

  const normalized = successCriteria.toLowerCase();
  return !/\b(write|wrote|save|saved|regenerate|rewrite|create|created|update|updated|modify|modified|edit|edited|delete|deleted|move|moved|show|open|display|reopen)\b/.test(normalized);
}

function buildDeterministicSummary(
  actOutput: ActOutput,
  successCriteria: string,
  evidenceItems: string[],
): string {
  const criteria = successCriteria.replace(/\s+/g, " ").trim();
  const criteriaText = criteria.length > 0 ? ` Success criteria: ${criteria}` : "";
  const contentPreview = buildContentPreview(actOutput);
  return [
    `Deterministic tool execution passed: ${evidenceItems.join("; ")}.${criteriaText}`.trim(),
    contentPreview,
  ].filter((part) => part.trim().length > 0).join(" ");
}

function formatDeterministicEvidenceItem(call: ActOutput["toolCalls"][number]): string {
  const payload = parseJsonObject(call.output);
  const target = readMetaString(call, ["filePath", "dirPath", "targetPath", "source", "destination", "preparedInputId"])
    ?? readPayloadString(payload, ["filePath", "dirPath", "targetPath", "source", "destination", "preparedInputId", "displayName", "targetTable"]);
  const bytes = readMetaNumber(call, ["bytesWritten", "sizeBytes", "rawOutputChars"]);
  const count = readMetaNumber(call, ["lineCount", "matchCount", "rowCount", "resultCount", "entryCount", "replacements"])
    ?? readPayloadNumber(payload, ["rowCount", "sectionCount", "rowsCopied"]);
  const output = call.output.replace(/\s+/g, " ").trim();
  const outputPreview = output.length > 0 ? ` output="${truncate(output, 180)}"` : "";
  const targetText = target ? ` target=${target}` : "";
  const bytesText = bytes !== undefined ? ` bytes=${bytes}` : "";
  const countText = count !== undefined ? ` count=${count}` : "";
  return `${call.tool} succeeded${targetText}${bytesText}${countText}${outputPreview}`.trim();
}

function buildContentPreview(actOutput: ActOutput): string {
  const readableOutputs = actOutput.toolCalls
    .filter((call) => ["read_files", "search_in_files", "find_files", "dataset_query", "document_query"].includes(call.tool))
    .map((call) => {
      const output = call.output.replace(/\s+/g, " ").trim();
      if (!output) return "";
      return `${call.tool} preview: ${truncate(output, 600)}`;
    })
    .filter((item) => item.length > 0);
  return readableOutputs.length > 0 ? readableOutputs.join(" ") : "";
}

function readMetaString(call: ActOutput["toolCalls"][number], keys: string[]): string | undefined {
  for (const key of keys) {
    const value = call.meta?.[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function readMetaNumber(call: ActOutput["toolCalls"][number], keys: string[]): number | undefined {
  for (const key of keys) {
    const value = call.meta?.[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function readPayloadString(payload: Record<string, unknown> | null, keys: string[]): string | undefined {
  if (!payload) {
    return undefined;
  }
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function readPayloadNumber(payload: Record<string, unknown> | null, keys: string[]): number | undefined {
  if (!payload) {
    return undefined;
  }
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function truncate(value: string, maxLen: number): string {
  if (value.length <= maxLen) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLen - 3))}...`;
}
