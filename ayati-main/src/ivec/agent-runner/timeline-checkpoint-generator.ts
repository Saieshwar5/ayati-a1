import type { LlmProvider } from "../../core/contracts/provider.js";
import type { LlmCostEstimate, LlmTokenUsage } from "../../core/contracts/llm-protocol.js";
import { estimateTextTokens, estimateTurnInputTokens } from "../../prompt/token-estimator.js";
import {
  TIMELINE_CHECKPOINT_SUMMARY_SCHEMA,
  validateTimelineCheckpointAgainstPlan,
} from "./timeline-checkpoint.js";
import type {
  TimelineCheckpointEvent,
  TimelineCheckpointPlan,
  TimelineCheckpointStatement,
  TimelineCheckpointSummary,
} from "./timeline-checkpoint.js";
import {
  readTimelineCheckpointCache,
  timelineCheckpointCacheKey,
  writeTimelineCheckpointCache,
} from "./timeline-checkpoint-cache.js";
import type { TimelineCheckpointCacheState } from "./timeline-checkpoint-cache.js";

export interface TimelineCheckpointGenerationAttempt {
  attempt: number;
  status: "success" | "failed";
  durationMs: number;
  errors: string[];
  usage?: LlmTokenUsage;
  cost?: LlmCostEstimate;
}

export interface TimelineCheckpointGenerationResult {
  status: "success" | "failed";
  cacheStatus: "generated" | "success_hit" | "failure_hit";
  sourceHash: string;
  attempts: TimelineCheckpointGenerationAttempt[];
  errors: string[];
  checkpoint?: TimelineCheckpointEvent;
  checkpointTokens?: number;
}

const MAX_GENERATION_ATTEMPTS = 2;

export async function generateTimelineCheckpoint(input: {
  provider: LlmProvider;
  plan: TimelineCheckpointPlan;
  cache: TimelineCheckpointCacheState;
  maxInputTokens?: number;
}): Promise<TimelineCheckpointGenerationResult> {
  if (!input.plan.triggered || !input.plan.sourceHash) {
    return {
      status: "failed",
      cacheStatus: "generated",
      sourceHash: input.plan.sourceHash ?? "",
      attempts: [],
      errors: ["checkpoint plan does not contain a selected source range"],
    };
  }
  const key = timelineCheckpointCacheKey({
    provider: input.provider.name,
    model: input.provider.version,
    sourceHash: input.plan.sourceHash,
    checkpointTokenBudget: input.plan.estimatedCheckpointTokens,
    ...(input.maxInputTokens !== undefined ? { generatorInputCapacity: input.maxInputTokens } : {}),
  });
  const cached = readTimelineCheckpointCache(input.cache, key);
  if (cached?.status === "success") {
    return {
      status: "success",
      cacheStatus: "success_hit",
      sourceHash: input.plan.sourceHash,
      attempts: [],
      errors: [],
      checkpoint: cached.checkpoint,
      checkpointTokens: cached.checkpointTokens,
    };
  }
  if (cached?.status === "failed") {
    return {
      status: "failed",
      cacheStatus: "failure_hit",
      sourceHash: input.plan.sourceHash,
      attempts: [],
      errors: cached.errors,
    };
  }

  const attempts: TimelineCheckpointGenerationAttempt[] = [];
  let previousErrors: string[] = [];
  for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
    const startedAt = Date.now();
    try {
      const turnInput = {
        messages: buildCheckpointMessages(input.plan, previousErrors),
        responseFormat: {
          type: "json_schema",
          name: "timeline_checkpoint_summary",
          schema: TIMELINE_CHECKPOINT_SUMMARY_SCHEMA,
          strict: true,
        },
      } as const;
      const estimatedInputTokens = estimateTurnInputTokens(turnInput).totalTokens;
      if (input.maxInputTokens !== undefined && estimatedInputTokens > input.maxInputTokens) {
        previousErrors = [
          `checkpoint generator input requires ${estimatedInputTokens} estimated tokens, exceeding its ${input.maxInputTokens}-token capacity`,
        ];
        attempts.push({
          attempt,
          status: "failed",
          durationMs: Date.now() - startedAt,
          errors: previousErrors,
        });
        break;
      }
      const response = await input.provider.generateTurn(turnInput);
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
      const parsed = parseTimelineCheckpointSummary(response.content);
      if (!parsed.summary) {
        previousErrors = compactErrors(parsed.errors);
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
      const checkpoint = buildCheckpointEvent(input.plan, parsed.summary);
      const checkpointTokens = estimateTextTokens(JSON.stringify(checkpoint));
      const validationErrors = validateTimelineCheckpointAgainstPlan(checkpoint, input.plan);
      if (checkpointTokens > input.plan.estimatedCheckpointTokens) {
        validationErrors.push(
          `checkpoint uses ${checkpointTokens} tokens, exceeding the ${input.plan.estimatedCheckpointTokens}-token budget`,
        );
      }
      if (validationErrors.length > 0) {
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
      writeTimelineCheckpointCache(input.cache, key, {
        status: "success",
        checkpoint,
        checkpointTokens,
      });
      return {
        status: "success",
        cacheStatus: "generated",
        sourceHash: input.plan.sourceHash,
        attempts,
        errors: [],
        checkpoint,
        checkpointTokens,
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

  const errors = compactErrors(attempts.flatMap((attempt) => attempt.errors));
  writeTimelineCheckpointCache(input.cache, key, { status: "failed", errors });
  return {
    status: "failed",
    cacheStatus: "generated",
    sourceHash: input.plan.sourceHash,
    attempts,
    errors,
  };
}

function buildCheckpointMessages(
  plan: TimelineCheckpointPlan,
  previousErrors: string[],
): Array<{ role: "system" | "user"; content: string }> {
  return [
    {
      role: "system",
      content: [
        "Create a structured checkpoint for older AI-agent conversation events.",
        "Use only the supplied events. Do not invent facts, decisions, constraints, or references.",
        "Every array item must cite the exact source event seq that supports it.",
        "Preserve user requests, corrections, constraints, decisions, important facts, unresolved questions, and literal references such as paths, URLs, ids, commands, and error strings.",
        "Do not summarize tool results, task state, work state, or personal memory because they are not part of this input.",
        `The complete checkpoint event must remain within ${plan.estimatedCheckpointTokens} estimated tokens.`,
        "Return only the requested JSON object.",
        ...(previousErrors.length > 0
          ? [`Repair these validation failures from the previous attempt: ${previousErrors.join("; ")}`]
          : []),
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify({
        coveredFromSeq: plan.coveredFromSeq,
        coveredToSeq: plan.coveredToSeq,
        sourceEventCount: plan.selectedEvents.length,
        events: plan.selectedEvents,
      }, null, 2),
    },
  ];
}

function buildCheckpointEvent(
  plan: TimelineCheckpointPlan,
  summary: TimelineCheckpointSummary,
): TimelineCheckpointEvent {
  const lastEvent = plan.selectedEvents.at(-1)!;
  return {
    kind: "checkpoint",
    seq: plan.coveredToSeq!,
    timestamp: lastEvent.timestamp,
    schemaVersion: 1,
    coveredFromSeq: plan.coveredFromSeq!,
    coveredToSeq: plan.coveredToSeq!,
    sourceEventCount: plan.selectedEvents.length,
    sourceHash: plan.sourceHash!,
    summary,
  };
}

function parseTimelineCheckpointSummary(content: string): {
  summary?: TimelineCheckpointSummary;
  errors: string[];
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { errors: ["checkpoint response is not valid JSON"] };
  }
  if (!isPlainObject(parsed)) return { errors: ["checkpoint response must be an object"] };
  const expectedKeys = [
    "userRequests",
    "constraints",
    "decisions",
    "corrections",
    "importantFacts",
    "unresolvedQuestions",
    "references",
    "narrative",
  ];
  const unknownKeys = Object.keys(parsed).filter((key) => !expectedKeys.includes(key));
  const errors = unknownKeys.map((key) => `checkpoint response contains unknown field ${key}`);
  const parsedArrays = new Map<string, TimelineCheckpointStatement[]>();
  for (const key of expectedKeys.slice(0, -1)) {
    const result = parseStatements(parsed[key], key);
    errors.push(...result.errors);
    if (result.statements) parsedArrays.set(key, result.statements);
  }
  const narrative = typeof parsed["narrative"] === "string" ? parsed["narrative"].trim() : "";
  if (!narrative) errors.push("checkpoint narrative must be a non-empty string");
  if (errors.length > 0) return { errors };

  return {
    errors: [],
    summary: {
      userRequests: parsedArrays.get("userRequests")!,
      constraints: parsedArrays.get("constraints")!,
      decisions: parsedArrays.get("decisions")!,
      corrections: parsedArrays.get("corrections")!,
      importantFacts: parsedArrays.get("importantFacts")!,
      unresolvedQuestions: parsedArrays.get("unresolvedQuestions")!,
      references: parsedArrays.get("references")!,
      narrative,
    },
  };
}

function parseStatements(value: unknown, field: string): {
  statements?: TimelineCheckpointStatement[];
  errors: string[];
} {
  if (!Array.isArray(value)) return { errors: [`checkpoint ${field} must be an array`] };
  const statements: TimelineCheckpointStatement[] = [];
  const errors: string[] = value.length > 64
    ? [`checkpoint ${field} must contain at most 64 items`]
    : [];
  value.forEach((entry, index) => {
    if (!isPlainObject(entry)) {
      errors.push(`checkpoint ${field}[${index}] must be an object`);
      return;
    }
    const unknownKeys = Object.keys(entry).filter((key) => key !== "seq" && key !== "text");
    const entryErrors: string[] = [];
    if (unknownKeys.length > 0) {
      entryErrors.push(`checkpoint ${field}[${index}] contains unknown fields`);
    }
    if (!Number.isInteger(entry["seq"]) || Number(entry["seq"]) < 1) {
      entryErrors.push(`checkpoint ${field}[${index}].seq must be a positive integer`);
    }
    if (typeof entry["text"] !== "string" || !entry["text"].trim()) {
      entryErrors.push(`checkpoint ${field}[${index}].text must be a non-empty string`);
    }
    errors.push(...entryErrors);
    if (entryErrors.length === 0) {
      statements.push({ seq: Number(entry["seq"]), text: String(entry["text"]).trim() });
    }
  });
  return errors.length > 0 ? { errors } : { statements, errors: [] };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compactErrors(errors: string[]): string[] {
  return [...new Set(errors)]
    .slice(0, 8)
    .map((error) => error.length <= 300 ? error : `${error.slice(0, 297)}...`);
}
