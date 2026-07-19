import { compactPromptToolCall } from "../run-tool-call-context.js";
import type { PromptRunToolCallContext } from "../run-tool-call-context.js";
import type { PressureProjectionMode, ToolContextProjection } from "./types.js";

export function projectStructuredCall(input: {
  projectorId: string;
  call: PromptRunToolCallContext;
  mode: PressureProjectionMode;
  compactInput: unknown;
  summary: Record<string, unknown>;
  previewSource?: string;
}): ToolContextProjection {
  const base = compactPromptToolCall(input.call, input.mode, "context_budget");
  const previewChars = input.mode === "preview" ? 4_000 : 1_200;
  const preview = boundedHeadTail(input.previewSource ?? input.call.output ?? "", previewChars);
  return {
    projectorId: input.projectorId,
    call: {
      ...base,
      input: input.compactInput,
      summary: JSON.stringify(input.summary),
      ...(preview ? { outputPreview: preview } : {}),
    },
  };
}

export function boundedHeadTail(value: string, maxChars: number): string {
  const text = value.trim();
  if (text.length <= maxChars) return text;
  const separator = "\n...[bounded middle omitted]...\n";
  const available = Math.max(0, maxChars - separator.length);
  const headChars = Math.ceil(available * 0.4);
  const tailChars = available - headChars;
  return `${text.slice(0, headChars).trimEnd()}${separator}${text.slice(-tailChars).trimStart()}`;
}

export function compactInputFields(input: unknown, options: {
  keep?: string[];
  arrayObjectFields?: Record<string, string[]>;
}): unknown {
  if (!isRecord(input)) return input;
  const output: Record<string, unknown> = {};
  for (const key of options.keep ?? []) {
    if (key in input) output[key] = compactValue(input[key]);
  }
  for (const [key, fields] of Object.entries(options.arrayObjectFields ?? {})) {
    const value = input[key];
    if (!Array.isArray(value)) continue;
    output[key] = value.slice(0, 40).map((item) => {
      if (!isRecord(item)) return compactValue(item);
      return Object.fromEntries(fields.filter((field) => field in item).map((field) => [field, compactValue(item[field])]));
    });
  }
  return output;
}

export function readCommand(input: unknown): string {
  if (!isRecord(input)) return "";
  if (typeof input["executable"] === "string" && input["executable"].trim()) {
    const args = Array.isArray(input["args"])
      ? input["args"].filter((arg): arg is string => typeof arg === "string")
      : [];
    return [input["executable"].trim(), ...args].join(" ");
  }
  for (const key of ["cmd", "command", "script", "input"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export function readMetadata(call: PromptRunToolCallContext): Record<string, unknown> {
  return call.projectionMetadata ?? {};
}

export function omitFields(input: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const omitted = new Set(fields);
  return Object.fromEntries(Object.entries(input).filter(([key]) => !omitted.has(key)));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function compactValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length <= 500 ? value : `${value.slice(0, 497).trimEnd()}...`;
  }
  if (Array.isArray(value)) return value.slice(0, 40).map(compactValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, compactValue(item)]));
}
