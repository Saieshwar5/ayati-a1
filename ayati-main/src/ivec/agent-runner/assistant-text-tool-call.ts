import type { LlmToolSchema } from "../../core/contracts/llm-protocol.js";
import { isNativeControlToolName } from "../../skills/tool-taxonomy.js";

export interface AssistantTextToolCallViolation {
  kind: "assistant_text_tool_call";
  reason: string;
  toolName?: string;
  inputKeys: string[];
  selectedTools: string[];
}

export function detectAssistantTextToolCall(
  text: string,
  input: {
    selectedTools: string[];
    nativeTools: LlmToolSchema[];
  },
): AssistantTextToolCallViolation | null {
  const internalAction = detectInternalActionTextToolCall(text, input.selectedTools);
  if (internalAction) {
    return internalAction;
  }

  const parsed = parseJsonRecord(text);
  if (!parsed) {
    return null;
  }
  if (looksLikeToolCallRecord(parsed)) {
    const toolName = readToolLikeName(parsed);
    const toolInput = readToolLikeInput(parsed);
    return {
      kind: "assistant_text_tool_call",
      reason: "Assistant text contained JSON shaped like a tool call. Native tools must be called through provider tool calling, not printed as text.",
      ...(toolName ? { toolName } : {}),
      inputKeys: Object.keys(toolInput ?? {}),
      selectedTools: input.selectedTools,
    };
  }

  const bareControl = matchBareNativeControlInput(parsed, input.nativeTools);
  if (!bareControl) {
    return null;
  }
  return {
    kind: "assistant_text_tool_call",
    reason: "Assistant text contained bare JSON matching a native control input. Harness controls must be called through provider tool calling, not printed as text.",
    ...(bareControl.toolName ? { toolName: bareControl.toolName } : {}),
    inputKeys: Object.keys(parsed),
    selectedTools: input.nativeTools.map((tool) => tool.name),
  };
}

export function looksLikeToolCallRecord(value: unknown): boolean {
  if (!isPlainObject(value)) {
    return false;
  }
  if (typeof value["kind"] === "string") {
    return false;
  }
  const hasToolName = typeof value["tool"] === "string"
    || typeof value["name"] === "string";
  const hasInput = isPlainObject(value["arguments"])
    || isPlainObject(value["input"]);
  return hasToolName && hasInput;
}

function matchBareNativeControlInput(
  input: Record<string, unknown>,
  nativeTools: LlmToolSchema[],
): { toolName?: string } | null {
  if (typeof input["kind"] === "string" || looksLikeToolCallRecord(input)) {
    return null;
  }
  const matches = nativeTools.filter(
    (tool) => isNativeControlToolName(tool.name)
      && matchesTopLevelToolInputSignature(input, tool.inputSchema),
  );
  if (matches.length === 0) {
    return null;
  }
  return matches.length === 1
    ? { toolName: matches[0]!.name }
    : {};
}

function matchesTopLevelToolInputSignature(
  input: Record<string, unknown>,
  schema: Record<string, unknown>,
): boolean {
  const properties = isPlainObject(schema["properties"])
    ? schema["properties"]
    : {};
  const required = Array.isArray(schema["required"])
    ? schema["required"].filter((field): field is string => typeof field === "string")
    : [];
  if (required.length < 2 || !required.every((field) => input[field] !== undefined)) {
    return false;
  }

  const inputKeys = Object.keys(input);
  if (
    schema["additionalProperties"] === false
    && inputKeys.some((field) => properties[field] === undefined)
  ) {
    return false;
  }
  return inputKeys.every((field) => {
    const propertySchema = properties[field];
    return !isPlainObject(propertySchema)
      || matchesTopLevelSchemaValue(input[field], propertySchema);
  });
}

function matchesTopLevelSchemaValue(
  value: unknown,
  schema: Record<string, unknown>,
): boolean {
  const expectedType = typeof schema["type"] === "string"
    ? schema["type"]
    : undefined;
  if (expectedType && !matchesJsonType(value, expectedType)) {
    return false;
  }
  if (
    Array.isArray(schema["enum"])
    && !schema["enum"].some((candidate) => candidate === value)
  ) {
    return false;
  }
  if (
    typeof value === "string"
    && typeof schema["minLength"] === "number"
    && value.length < schema["minLength"]
  ) {
    return false;
  }
  if (
    typeof value === "string"
    && typeof schema["maxLength"] === "number"
    && value.length > schema["maxLength"]
  ) {
    return false;
  }
  if (!Array.isArray(value)) {
    return true;
  }
  if (
    typeof schema["minItems"] === "number"
    && value.length < schema["minItems"]
  ) {
    return false;
  }
  if (
    typeof schema["maxItems"] === "number"
    && value.length > schema["maxItems"]
  ) {
    return false;
  }
  const itemSchema = isPlainObject(schema["items"]) ? schema["items"] : undefined;
  if (!itemSchema) {
    return true;
  }
  return value.every((item) => {
    if (itemSchema["type"] === "object") {
      return isPlainObject(item);
    }
    return matchesTopLevelSchemaValue(item, itemSchema);
  });
}

function matchesJsonType(value: unknown, expectedType: string): boolean {
  if (expectedType === "array") return Array.isArray(value);
  if (expectedType === "integer") {
    return typeof value === "number" && Number.isInteger(value);
  }
  if (expectedType === "number") {
    return typeof value === "number" && Number.isFinite(value);
  }
  if (expectedType === "object") return isPlainObject(value);
  if (expectedType === "string") return typeof value === "string";
  if (expectedType === "boolean") return typeof value === "boolean";
  return true;
}

function detectInternalActionTextToolCall(
  text: string,
  selectedToolNames: string[],
): AssistantTextToolCallViolation | null {
  const trimmed = text.trimStart();
  if (parseJsonRecord(trimmed)) {
    return null;
  }
  if (!trimmed.startsWith("{") || !/"kind"\s*:\s*"act"/.test(trimmed)) {
    return null;
  }
  if (
    !/"action"\s*:/.test(trimmed)
    && !/"allowedTools"\s*:/.test(trimmed)
    && !/"calls"\s*:/.test(trimmed)
  ) {
    return null;
  }
  const toolName = extractInternalActionToolName(trimmed, selectedToolNames);
  return {
    kind: "assistant_text_tool_call",
    reason: "Assistant text contained internal action JSON. Executable work must use provider native tool calling, not printed harness JSON.",
    ...(toolName ? { toolName } : {}),
    inputKeys: [],
    selectedTools: selectedToolNames,
  };
}

function extractInternalActionToolName(
  text: string,
  selectedToolNames: string[],
): string | undefined {
  const allowedMatch = text.match(/"allowedTools"\s*:\s*\[\s*"([^"]+)"/);
  if (allowedMatch?.[1]) {
    return allowedMatch[1];
  }
  const toolMatch = text.match(/"tool"\s*:\s*"([^"]+)"/);
  if (toolMatch?.[1]) {
    return toolMatch[1];
  }
  return selectedToolNames.find(
    (tool) => text.includes(`"${tool}"`) || text.includes(tool),
  );
}

function readToolLikeName(record: Record<string, unknown>): string | undefined {
  const name = typeof record["tool"] === "string"
    ? record["tool"]
    : record["name"];
  return typeof name === "string" && name.trim().length > 0
    ? name.trim()
    : undefined;
}

function readToolLikeInput(
  record: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (isPlainObject(record["arguments"])) {
    return record["arguments"];
  }
  if (isPlainObject(record["input"])) {
    return record["input"];
  }
  return undefined;
}

function parseJsonRecord(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
