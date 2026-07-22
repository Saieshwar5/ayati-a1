import type {
  ContextCheckpointPlan,
  ContextCheckpointStatement,
  ContextCheckpointSummary,
} from "ayati-context-engine";
import type { LlmProvider } from "../../core/contracts/provider.js";
import type { LlmCostEstimate, LlmTokenUsage } from "../../core/contracts/llm-protocol.js";
import { correctLocalInputTokenEstimate } from "../../prompt/context-token-counter.js";
import { estimateTextTokens, estimateTurnInputTokens } from "../../prompt/token-estimator.js";
import { AGENT_STREAM_CHECKPOINT_SUMMARY_SCHEMA } from "./agent-context-events.js";
import { withEvaluationModelOperation } from "../../evaluation/capture-runtime.js";

export interface StreamCheckpointGenerationAttempt {
  attempt: number;
  status: "success" | "failed";
  durationMs: number;
  errors: string[];
  usage?: LlmTokenUsage;
  cost?: LlmCostEstimate;
}

export interface StreamCheckpointGenerationResult {
  status: "success" | "failed";
  attempts: StreamCheckpointGenerationAttempt[];
  errors: string[];
  summary?: ContextCheckpointSummary;
  tokenCount?: number;
}

const MAX_GENERATION_ATTEMPTS = 2;
const SUMMARY_ARRAY_KEYS = [
  "userRequests",
  "constraints",
  "decisions",
  "corrections",
  "importantFacts",
  "unresolvedQuestions",
  "references",
] as const;

export async function generateStreamCheckpoint(input: {
  provider: LlmProvider;
  plan: ContextCheckpointPlan;
  maxInputTokens?: number;
}): Promise<StreamCheckpointGenerationResult> {
  if (!input.plan.triggered
    || input.plan.coveredFromSeq === undefined
    || input.plan.coveredToSeq === undefined
    || !input.plan.sourceHash) {
    return {
      status: "failed",
      attempts: [],
      errors: ["checkpoint plan does not contain a pressure-selected source range"],
    };
  }
  const attempts: StreamCheckpointGenerationAttempt[] = [];
  let previousErrors: string[] = [];
  for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
    const startedAt = Date.now();
    try {
      const turnInput = {
        messages: checkpointMessages(input.plan, previousErrors),
        responseFormat: {
          type: "json_schema",
          name: "agent_stream_checkpoint_summary",
          schema: AGENT_STREAM_CHECKPOINT_SUMMARY_SCHEMA,
          strict: true,
        },
      } as const;
      const correctedInputTokens = correctLocalInputTokenEstimate(
        estimateTurnInputTokens(turnInput).totalTokens,
      );
      if (input.maxInputTokens !== undefined && correctedInputTokens > input.maxInputTokens) {
        previousErrors = [
          `checkpoint generator input requires ${correctedInputTokens} tokens, exceeding capacity ${input.maxInputTokens}`,
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
        purpose: "durable_checkpoint_summary",
      }, async () => await input.provider.generateTurn(turnInput));
      if (response.type !== "assistant") {
        previousErrors = ["checkpoint provider returned tool calls instead of assistant JSON"];
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
      const parsed = parseSummary(response.content);
      const validationErrors = parsed.summary
        ? validateSummary(parsed.summary, input.plan)
        : parsed.errors;
      const tokenCount = parsed.summary
        ? estimateTextTokens(JSON.stringify(parsed.summary))
        : undefined;
      if (tokenCount !== undefined && tokenCount > input.plan.estimatedCheckpointTokens) {
        validationErrors.push(
          `checkpoint uses ${tokenCount} tokens, above budget ${input.plan.estimatedCheckpointTokens}`,
        );
      }
      if (!parsed.summary || tokenCount === undefined || validationErrors.length > 0) {
        previousErrors = compactErrors(validationErrors);
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
  };
}

function checkpointMessages(
  plan: ContextCheckpointPlan,
  previousErrors: string[],
): Array<{ role: "system" | "user"; content: string }> {
  return [
    {
      role: "system",
      content: [
        "Create a structured continuity checkpoint for one agent stream.",
        "Use only the supplied previous checkpoint and exact messages; never invent facts.",
        "Every array item must cite the exact message sequence that supports it.",
        "Preserve requests, constraints, decisions, corrections, important facts, unresolved questions, and literal references.",
        "Do not include tool action logs, WorkState, workstream state, or personal memory.",
        `Keep the JSON within ${plan.estimatedCheckpointTokens} estimated tokens.`,
        "Return only the requested JSON object.",
        ...(previousErrors.length > 0
          ? [`Repair these validation failures: ${previousErrors.join("; ")}`]
          : []),
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify({
        coveredFromSeq: plan.coveredFromSeq,
        coveredToSeq: plan.coveredToSeq,
        previousCheckpoint: plan.previousCheckpoint?.summary ?? null,
        messages: plan.selectedMessages.map((message) => ({
          seq: message.sequence,
          role: message.role,
          at: message.at,
          content: message.content,
        })),
      }, null, 2),
    },
  ];
}

function parseSummary(content: string): {
  summary?: ContextCheckpointSummary;
  errors: string[];
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { errors: ["checkpoint response is not valid JSON"] };
  }
  if (!isRecord(parsed)) return { errors: ["checkpoint response must be an object"] };
  const expected: string[] = [...SUMMARY_ARRAY_KEYS, "narrative"];
  const errors = Object.keys(parsed)
    .filter((key) => !expected.includes(key))
    .map((key) => `checkpoint response contains unknown field ${key}`);
  const arrays = new Map<string, ContextCheckpointStatement[]>();
  for (const key of SUMMARY_ARRAY_KEYS) {
    const result = parseStatements(parsed[key], key);
    errors.push(...result.errors);
    if (result.statements) arrays.set(key, result.statements);
  }
  const narrative = typeof parsed["narrative"] === "string"
    ? parsed["narrative"].trim()
    : "";
  if (!narrative) errors.push("checkpoint narrative must be non-empty");
  if (errors.length > 0) return { errors };
  return {
    errors: [],
    summary: {
      userRequests: arrays.get("userRequests")!,
      constraints: arrays.get("constraints")!,
      decisions: arrays.get("decisions")!,
      corrections: arrays.get("corrections")!,
      importantFacts: arrays.get("importantFacts")!,
      unresolvedQuestions: arrays.get("unresolvedQuestions")!,
      references: arrays.get("references")!,
      narrative,
    },
  };
}

function parseStatements(value: unknown, key: string): {
  statements?: ContextCheckpointStatement[];
  errors: string[];
} {
  if (!Array.isArray(value)) return { errors: [`${key} must be an array`] };
  const statements: ContextCheckpointStatement[] = [];
  const errors: string[] = [];
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)
      || !Number.isSafeInteger(item["seq"])
      || typeof item["text"] !== "string"
      || !item["text"].trim()) {
      errors.push(`${key}[${index}] must contain integer seq and non-empty text`);
      continue;
    }
    statements.push({ seq: Number(item["seq"]), text: item["text"].trim() });
  }
  return errors.length > 0 ? { errors } : { statements, errors: [] };
}

function validateSummary(
  summary: ContextCheckpointSummary,
  plan: ContextCheckpointPlan,
): string[] {
  const validAnchors = new Set([
    ...(plan.previousCheckpoint?.exactAnchors ?? []),
    ...plan.selectedMessages.map((message) => message.sequence),
  ]);
  const statements = SUMMARY_ARRAY_KEYS.flatMap((key) => summary[key]);
  const errors: string[] = [];
  for (const statement of statements) {
    if (!validAnchors.has(statement.seq)) {
      errors.push(`statement sequence ${statement.seq} is not an exact source anchor`);
    }
  }
  return errors;
}

function compactErrors(errors: string[]): string[] {
  return [...new Set(errors.map((error) => error.trim()).filter(Boolean))].slice(0, 12);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
