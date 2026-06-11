import { createHash } from "node:crypto";
import type {
  ArtifactRef,
  ArtifactExtractor,
  Condition,
  JsonSchema,
  ProgressFactExtractor,
  ToolAnnotations,
  ToolContractAssertion,
  ToolDomain,
  ToolErrorCategory,
  ToolOperationStatus,
  ToolResult,
  ToolResultContract,
  ToolResultV2,
} from "../types.js";
import { classifyErrorMessage, errnoToCategory } from "../contracts/errors.js";

export const genericObjectOutputSchema: JsonSchema = { type: "object" };

export function sha256Text(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

export function commonAnnotations(input: {
  domain: ToolDomain;
  readOnly: boolean;
  mutatesWorkspace?: boolean;
  mutatesExternalWorld?: boolean;
  destructive?: boolean;
  idempotent?: boolean;
  retrySafe?: boolean;
  longRunning?: boolean;
}): ToolAnnotations {
  return {
    domain: input.domain,
    readOnly: input.readOnly,
    mutatesWorkspace: input.mutatesWorkspace ?? false,
    mutatesExternalWorld: input.mutatesExternalWorld ?? false,
    destructive: input.destructive ?? false,
    idempotent: input.idempotent ?? input.readOnly,
    retrySafe: input.retrySafe ?? input.readOnly,
    longRunning: input.longRunning ?? false,
  };
}

export function succeededContract(input: {
  assertions?: ToolContractAssertion[];
  artifacts?: ArtifactExtractor[];
  progressFacts?: ProgressFactExtractor[];
} = {}): ToolResultContract {
  return {
    operationStatusPath: "$.operationStatus",
    successWhen: [
      { id: "operation_succeeded", kind: "tool_status", status: "succeeded" },
      ...(input.assertions ?? []),
    ],
    ...(input.artifacts ? { artifacts: input.artifacts } : {}),
    ...(input.progressFacts ? { progressFacts: input.progressFacts } : {}),
  };
}

export function successV2(input: {
  code: string;
  message: string;
  structuredContent: unknown;
  artifacts?: ArtifactRef[];
  diagnostics?: Record<string, unknown>;
  conditions?: Condition[];
  operationStatus?: ToolOperationStatus;
}): ToolResultV2 {
  return {
    transportOk: true,
    operationStatus: input.operationStatus ?? "succeeded",
    code: input.code,
    message: input.message,
    structuredContent: input.structuredContent,
    ...(input.artifacts ? { artifacts: input.artifacts } : {}),
    ...(input.conditions ? { conditions: input.conditions } : {}),
    ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
  };
}

export function failureV2(input: {
  code: string;
  message: string;
  category?: ToolErrorCategory;
  target?: string;
  expected?: unknown;
  actual?: unknown;
  retryable?: boolean;
  recoverable?: boolean;
  suggestedNextActions?: string[];
  structuredContent?: unknown;
  diagnostics?: Record<string, unknown>;
  operationStatus?: Exclude<ToolOperationStatus, "succeeded">;
}): ToolResultV2 {
  const classified = input.category
    ? {
        category: input.category,
        code: input.code,
        retryable: input.retryable ?? false,
        recoverable: input.recoverable ?? true,
        suggestedNextActions: input.suggestedNextActions ?? ["Inspect the tool error and retry with corrected input or state."],
      }
    : classifyErrorMessage(input.message);

  return {
    transportOk: true,
    operationStatus: input.operationStatus ?? "failed",
    code: input.code,
    message: input.message,
    ...(input.structuredContent !== undefined ? { structuredContent: input.structuredContent } : {}),
    error: {
      category: classified.category,
      code: input.code,
      message: input.message,
      retryable: input.retryable ?? classified.retryable,
      recoverable: input.recoverable ?? classified.recoverable,
      ...(input.target ? { target: input.target } : {}),
      ...(input.expected !== undefined ? { expected: input.expected } : {}),
      ...(input.actual !== undefined ? { actual: input.actual } : {}),
      suggestedNextActions: input.suggestedNextActions ?? classified.suggestedNextActions,
    },
    ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
  };
}

export function okResult(input: {
  output: string;
  meta?: Record<string, unknown>;
  v2: ToolResultV2;
}): ToolResult {
  return {
    ok: true,
    output: input.output,
    ...(input.meta ? { meta: input.meta } : {}),
    v2: input.v2,
  };
}

export function okJsonResult(input: {
  structuredContent: unknown;
  code: string;
  message: string;
  meta?: Record<string, unknown>;
  artifacts?: ArtifactRef[];
}): ToolResult {
  return okResult({
    output: JSON.stringify(input.structuredContent, null, 2),
    ...(input.meta ? { meta: input.meta } : {}),
    v2: successV2({
      code: input.code,
      message: input.message,
      structuredContent: input.structuredContent,
      ...(input.meta ? { diagnostics: input.meta } : {}),
      ...(input.artifacts ? { artifacts: input.artifacts } : {}),
    }),
  });
}

export function errorResult(input: {
  code: string;
  message: string;
  category?: ToolErrorCategory;
  target?: string;
  expected?: unknown;
  actual?: unknown;
  retryable?: boolean;
  recoverable?: boolean;
  suggestedNextActions?: string[];
  structuredContent?: unknown;
  meta?: Record<string, unknown>;
}): ToolResult {
  return {
    ok: false,
    error: input.message,
    ...(input.meta ? { meta: input.meta } : {}),
    v2: failureV2({
      code: input.code,
      message: input.message,
      ...(input.category ? { category: input.category } : {}),
      ...(input.target ? { target: input.target } : {}),
      ...(input.expected !== undefined ? { expected: input.expected } : {}),
      ...(input.actual !== undefined ? { actual: input.actual } : {}),
      ...(input.retryable !== undefined ? { retryable: input.retryable } : {}),
      ...(input.recoverable !== undefined ? { recoverable: input.recoverable } : {}),
      ...(input.suggestedNextActions ? { suggestedNextActions: input.suggestedNextActions } : {}),
      ...(input.structuredContent !== undefined ? { structuredContent: input.structuredContent } : {}),
      ...(input.meta ? { diagnostics: input.meta } : {}),
    }),
  };
}

export function errorResultFromUnknown(input: {
  err: unknown;
  code?: string;
  fallbackMessage: string;
  target?: string;
  meta?: Record<string, unknown>;
  suggestedNextActions?: string[];
}): ToolResult {
  const errCode = typeof input.err === "object" && input.err !== null && "code" in input.err
    ? String((input.err as { code?: unknown }).code)
    : undefined;
  const message = input.err instanceof Error ? input.err.message : input.fallbackMessage;
  const category = errnoToCategory(input.err);
  return errorResult({
    code: input.code ?? errCode ?? "TOOL_ERROR",
    message,
    category,
    ...(input.target ? { target: input.target } : {}),
    retryable: category === "missing_path" || category === "timeout" || category === "transient",
    recoverable: category !== "unknown",
    suggestedNextActions: input.suggestedNextActions ?? classifyErrorMessage(message).suggestedNextActions,
    ...(input.meta ? { meta: input.meta } : {}),
  });
}

