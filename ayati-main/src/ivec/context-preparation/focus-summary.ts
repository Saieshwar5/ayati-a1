import type { LlmProvider } from "../../core/contracts/provider.js";
import type { LlmCostEstimate, LlmTokenUsage } from "../../core/contracts/llm-protocol.js";
import { correctLocalInputTokenEstimate } from "../../prompt/context-token-counter.js";
import { estimateTextTokens, estimateTurnInputTokens } from "../../prompt/token-estimator.js";
import {
  RUN_FOCUS_SUMMARY_MAX_TOKENS,
  type AnchoredFocusStatement,
  type RunFocusSummary,
} from "./types.js";
import { withEvaluationModelOperation } from "../../evaluation/capture-runtime.js";

export interface FocusSummarySource {
  goal: string;
  validRefs: string[];
  messages: Array<{
    ref: string;
    seq: number;
    role: string;
    content: string;
  }>;
  steps: Array<{
    refs: string[];
    step: number;
    content: unknown;
  }>;
  priorFocus?: RunFocusSummary;
}

export interface FocusSummaryGenerationAttempt {
  attempt: number;
  status: "success" | "failed";
  durationMs: number;
  errors: string[];
  usage?: LlmTokenUsage;
  cost?: LlmCostEstimate;
}

export interface FocusSummaryGenerationResult {
  status: "success" | "failed";
  attempts: FocusSummaryGenerationAttempt[];
  errors: string[];
  summary?: RunFocusSummary;
  tokenCount?: number;
  usage?: LlmTokenUsage;
  cost?: LlmCostEstimate;
}

const MAX_ATTEMPTS = 2;
const STATEMENT_KEYS = [
  "constraints",
  "decisions",
  "completedWork",
  "importantFindings",
  "artifacts",
  "unresolvedQuestions",
] as const;

export const RUN_FOCUS_SUMMARY_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "coveredMessageRange",
    "coveredStepRange",
    "goal",
    ...STATEMENT_KEYS,
    "references",
  ],
  properties: {
    schemaVersion: { const: 1 },
    coveredMessageRange: nullableRangeSchema("fromSeq", "toSeq"),
    coveredStepRange: nullableRangeSchema("fromStep", "toStep"),
    goal: { type: "string", minLength: 1, maxLength: 1_000 },
    constraints: statementArraySchema(),
    decisions: statementArraySchema(),
    completedWork: statementArraySchema(),
    importantFindings: statementArraySchema(),
    artifacts: statementArraySchema(),
    unresolvedQuestions: statementArraySchema(),
    references: {
      type: "array",
      maxItems: 160,
      items: { type: "string", minLength: 1, maxLength: 500 },
    },
  },
};

export async function generateFocusSummary(input: {
  provider: LlmProvider;
  source: FocusSummarySource;
  maxTokens?: number;
  maxInputTokens?: number;
}): Promise<FocusSummaryGenerationResult> {
  const maxTokens = input.maxTokens ?? RUN_FOCUS_SUMMARY_MAX_TOKENS;
  const attempts: FocusSummaryGenerationAttempt[] = [];
  let previousErrors: string[] = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const startedAt = Date.now();
    try {
      const turnInput = {
        messages: focusMessages(input.source, maxTokens, previousErrors),
        responseFormat: {
          type: "json_schema",
          name: "run_focus_summary",
          schema: RUN_FOCUS_SUMMARY_SCHEMA,
          strict: true,
        },
      } as const;
      const correctedInputTokens = correctLocalInputTokenEstimate(
        estimateTurnInputTokens(turnInput).totalTokens,
      );
      if (input.maxInputTokens !== undefined && correctedInputTokens > input.maxInputTokens) {
        previousErrors = [
          `focus-summary input requires ${correctedInputTokens} tokens, exceeding capacity ${input.maxInputTokens}`,
        ];
        attempts.push({
          attempt,
          status: "failed",
          durationMs: Date.now() - startedAt,
          errors: previousErrors,
        });
        break;
      }
      const response = await withEvaluationModelOperation({
        purpose: "run_focus_summary",
      }, async () => await input.provider.generateTurn(turnInput));
      if (response.type !== "assistant") {
        previousErrors = ["focus-summary provider returned tool calls instead of assistant JSON"];
        attempts.push({
          attempt,
          status: "failed",
          durationMs: Date.now() - startedAt,
          errors: previousErrors,
          usage: response.usage,
          cost: response.cost,
        });
        continue;
      }
      const parsed = parseFocusSummary(response.content);
      const errors = parsed.summary
        ? validateFocusSummary(parsed.summary, input.source, maxTokens)
        : parsed.errors;
      if (!parsed.summary || errors.length > 0) {
        previousErrors = compactErrors(errors);
        attempts.push({
          attempt,
          status: "failed",
          durationMs: Date.now() - startedAt,
          errors: previousErrors,
          usage: response.usage,
          cost: response.cost,
        });
        continue;
      }
      const tokenCount = estimateTextTokens(JSON.stringify(parsed.summary));
      attempts.push({
        attempt,
        status: "success",
        durationMs: Date.now() - startedAt,
        errors: [],
        usage: response.usage,
        cost: response.cost,
      });
      return {
        status: "success",
        attempts,
        errors: [],
        summary: parsed.summary,
        tokenCount,
        usage: aggregateUsage(attempts),
        cost: aggregateCost(attempts),
      };
    } catch (error) {
      previousErrors = compactErrors([error instanceof Error ? error.message : String(error)]);
      attempts.push({
        attempt,
        status: "failed",
        durationMs: Date.now() - startedAt,
        errors: previousErrors,
      });
    }
  }

  return {
    status: "failed",
    attempts,
    errors: compactErrors(attempts.flatMap((attempt) => attempt.errors)),
    usage: aggregateUsage(attempts),
    cost: aggregateCost(attempts),
  };
}

export function validateFocusSummary(
  summary: RunFocusSummary,
  source: FocusSummarySource,
  maxTokens = RUN_FOCUS_SUMMARY_MAX_TOKENS,
): string[] {
  const errors: string[] = [];
  const validRefs = new Set(source.validRefs);
  for (const key of STATEMENT_KEYS) {
    for (const [index, statement] of summary[key].entries()) {
      if (statement.refs.length === 0) errors.push(`${key}[${index}] requires at least one source ref`);
      for (const ref of statement.refs) {
        if (!validRefs.has(ref)) errors.push(`${key}[${index}] uses invented ref ${ref}`);
      }
    }
  }
  for (const ref of summary.references) {
    if (!validRefs.has(ref)) errors.push(`references uses invented ref ${ref}`);
  }
  validateCoveredRange(summary.coveredMessageRange, source.messages.map((message) => message.seq), "message", errors);
  validateCoveredRange(summary.coveredStepRange, source.steps.map((step) => step.step), "step", errors);
  if (source.messages.length > 0 && !summary.coveredMessageRange) {
    errors.push("covered message range is required when message source is present");
  }
  if (source.steps.length > 0 && !summary.coveredStepRange) {
    errors.push("covered step range is required when step source is present");
  }
  const tokens = estimateTextTokens(JSON.stringify(summary));
  if (tokens > maxTokens) errors.push(`focus summary uses ${tokens} tokens, above budget ${maxTokens}`);
  return compactErrors(errors);
}

function focusMessages(
  source: FocusSummarySource,
  maxTokens: number,
  previousErrors: string[],
): Array<{ role: "system" | "user"; content: string }> {
  return [
    {
      role: "system",
      content: [
        "Create an anchored run focus summary.",
        "Use only the supplied source. Never invent facts, outcomes, ids, paths, evidence, or authority.",
        "Every statement must cite one or more exact refs from validRefs.",
        "Do not treat this summary as verification, completion evidence, resource authority, or permission.",
        "Do not summarize current input, WorkState, active authority, unresolved failures, or completion evidence.",
        `Keep the complete JSON within ${maxTokens} estimated tokens.`,
        "Return only the requested JSON object.",
        ...(previousErrors.length > 0
          ? [`Repair these validation failures: ${previousErrors.join("; ")}`]
          : []),
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify({
        goal: source.goal,
        validRefs: source.validRefs,
        priorFocus: source.priorFocus ?? null,
        messages: source.messages,
        steps: source.steps,
      }, null, 2),
    },
  ];
}

function parseFocusSummary(content: string): { summary?: RunFocusSummary; errors: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { errors: ["focus-summary response is not valid JSON"] };
  }
  if (!isRecord(parsed)) return { errors: ["focus-summary response must be an object"] };
  const errors: string[] = [];
  if (parsed["schemaVersion"] !== 1) errors.push("schemaVersion must be 1");
  const goal = typeof parsed["goal"] === "string" ? parsed["goal"].trim() : "";
  if (!goal) errors.push("goal must be non-empty");
  const statements = new Map<string, AnchoredFocusStatement[]>();
  for (const key of STATEMENT_KEYS) {
    const result = parseStatements(parsed[key], key);
    errors.push(...result.errors);
    if (result.statements) statements.set(key, result.statements);
  }
  const references = Array.isArray(parsed["references"])
    ? parsed["references"].filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  if (!Array.isArray(parsed["references"])) errors.push("references must be an array");
  const messageRange = parseRange(parsed["coveredMessageRange"], "fromSeq", "toSeq", errors);
  const stepRange = parseRange(parsed["coveredStepRange"], "fromStep", "toStep", errors);
  if (errors.length > 0) return { errors };
  return {
    errors: [],
    summary: {
      schemaVersion: 1,
      ...(messageRange ? { coveredMessageRange: { fromSeq: messageRange.from, toSeq: messageRange.to } } : {}),
      ...(stepRange ? { coveredStepRange: { fromStep: stepRange.from, toStep: stepRange.to } } : {}),
      goal,
      constraints: statements.get("constraints")!,
      decisions: statements.get("decisions")!,
      completedWork: statements.get("completedWork")!,
      importantFindings: statements.get("importantFindings")!,
      artifacts: statements.get("artifacts")!,
      unresolvedQuestions: statements.get("unresolvedQuestions")!,
      references: [...new Set(references.map((ref) => ref.trim()))],
    },
  };
}

function parseStatements(value: unknown, key: string): {
  statements?: AnchoredFocusStatement[];
  errors: string[];
} {
  if (!Array.isArray(value)) return { errors: [`${key} must be an array`] };
  const statements: AnchoredFocusStatement[] = [];
  const errors: string[] = [];
  for (const [index, item] of value.entries()) {
    if (!isRecord(item) || typeof item["text"] !== "string" || !item["text"].trim()) {
      errors.push(`${key}[${index}] requires non-empty text`);
      continue;
    }
    if (!Array.isArray(item["refs"]) || item["refs"].length === 0
      || !item["refs"].every((ref) => typeof ref === "string" && ref.trim().length > 0)) {
      errors.push(`${key}[${index}] requires non-empty refs`);
      continue;
    }
    statements.push({
      text: item["text"].trim(),
      refs: [...new Set((item["refs"] as string[]).map((ref) => ref.trim()))],
    });
  }
  return errors.length > 0 ? { errors } : { statements, errors: [] };
}

function parseRange(
  value: unknown,
  fromKey: string,
  toKey: string,
  errors: string[],
): { from: number; to: number } | undefined {
  if (value === null || value === undefined) return undefined;
  if (!isRecord(value)
    || !Number.isSafeInteger(value[fromKey])
    || !Number.isSafeInteger(value[toKey])
    || Number(value[fromKey]) > Number(value[toKey])) {
    errors.push(`${fromKey}/${toKey} must be an ordered integer range or null`);
    return undefined;
  }
  return { from: Number(value[fromKey]), to: Number(value[toKey]) };
}

function validateCoveredRange(
  range: { fromSeq: number; toSeq: number } | { fromStep: number; toStep: number } | undefined,
  available: number[],
  kind: "message" | "step",
  errors: string[],
): void {
  if (!range) return;
  const from = "fromSeq" in range ? range.fromSeq : range.fromStep;
  const to = "toSeq" in range ? range.toSeq : range.toStep;
  if (!available.some((value) => value >= from && value <= to)) {
    errors.push(`covered ${kind} range does not contain supplied source`);
  }
  if (available.some((value) => value < from || value > to)) {
    errors.push(`covered ${kind} range omits supplied source items`);
  }
}

function aggregateUsage(attempts: FocusSummaryGenerationAttempt[]): LlmTokenUsage | undefined {
  const values = attempts.flatMap((attempt) => attempt.usage ? [attempt.usage] : []);
  const last = values.at(-1);
  if (!last) return undefined;
  return {
    provider: last.provider,
    model: last.model,
    inputTokens: values.reduce((sum, value) => sum + value.inputTokens, 0),
    outputTokens: values.reduce((sum, value) => sum + value.outputTokens, 0),
    totalTokens: values.reduce((sum, value) => sum + value.totalTokens, 0),
    ...(values.some((value) => value.cachedInputTokens !== undefined)
      ? { cachedInputTokens: values.reduce((sum, value) => sum + (value.cachedInputTokens ?? 0), 0) }
      : {}),
    exact: values.every((value) => value.exact),
  };
}

function aggregateCost(attempts: FocusSummaryGenerationAttempt[]): LlmCostEstimate | undefined {
  const values = attempts.flatMap((attempt) => attempt.cost ? [attempt.cost] : []);
  const last = values.at(-1);
  if (!last) return undefined;
  return {
    currency: "USD",
    inputCostUsd: values.reduce((sum, value) => sum + value.inputCostUsd, 0),
    cachedInputCostUsd: values.reduce((sum, value) => sum + value.cachedInputCostUsd, 0),
    outputCostUsd: values.reduce((sum, value) => sum + value.outputCostUsd, 0),
    totalCostUsd: values.reduce((sum, value) => sum + value.totalCostUsd, 0),
    pricingSource: last.pricingSource,
  };
}

function nullableRangeSchema(from: string, to: string): Record<string, unknown> {
  return {
    anyOf: [
      { type: "null" },
      {
        type: "object",
        additionalProperties: false,
        required: [from, to],
        properties: {
          [from]: { type: "integer", minimum: 1 },
          [to]: { type: "integer", minimum: 1 },
        },
      },
    ],
  };
}

function statementArraySchema(): Record<string, unknown> {
  return {
    type: "array",
    maxItems: 48,
    items: {
      type: "object",
      additionalProperties: false,
      required: ["text", "refs"],
      properties: {
        text: { type: "string", minLength: 1, maxLength: 1_000 },
        refs: {
          type: "array",
          minItems: 1,
          maxItems: 12,
          items: { type: "string", minLength: 1, maxLength: 500 },
        },
      },
    },
  };
}

function compactErrors(errors: string[]): string[] {
  return [...new Set(errors.map((error) => error.trim()).filter(Boolean))].slice(0, 16);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
