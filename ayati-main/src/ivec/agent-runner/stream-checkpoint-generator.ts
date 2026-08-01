import {
  CONTEXT_CHECKPOINT_CATEGORY_MAX_ITEMS,
  CONTEXT_CHECKPOINT_NARRATIVE_MAX_CHARS,
  CONTEXT_CHECKPOINT_STATEMENT_MAX_CHARS,
  type ContextCheckpointPlan,
  type ContextCheckpointStatement,
  type ContextCheckpointSummary,
} from "ayati-context-engine";
import type { LlmProvider } from "../../core/contracts/provider.js";
import type { LlmCostEstimate, LlmTokenUsage } from "../../core/contracts/llm-protocol.js";
import { correctLocalInputTokenEstimate } from "../../prompt/context-token-counter.js";
import { estimateTurnInputTokens } from "../../prompt/token-estimator.js";
import { AGENT_STREAM_CHECKPOINT_SUMMARY_SCHEMA } from "./agent-context-events.js";
import { withEvaluationModelOperation } from "../../evaluation/capture-runtime.js";
import {
  checkpointModelTargetTokens,
  checkpointPlanAnchors,
  checkpointSummaryTokenCount,
  createDeterministicCheckpointFallback,
  fitCheckpointToBudget,
  type StreamCheckpointSummaryKey,
} from "./stream-checkpoint-fitter.js";

export interface StreamCheckpointGenerationAttempt {
  attempt: number;
  status: "success" | "failed";
  providerCalled: boolean;
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
  generationMethod?: "model" | "model_fitted" | "deterministic_fallback";
  recoveryReason?: string;
  modelTokenCount?: number;
  droppedCounts?: Record<StreamCheckpointSummaryKey, number>;
  truncatedCounts?: Record<StreamCheckpointSummaryKey, number>;
}

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
  /** Optional stricter ceiling required to recover the current prompt. */
  maximumSummaryTokens?: number;
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
  const maximumTokens = Math.min(
    input.plan.estimatedCheckpointTokens,
    Math.max(1, Math.trunc(
      input.maximumSummaryTokens ?? input.plan.estimatedCheckpointTokens,
    )),
  );
  const startedAt = Date.now();
  let providerCalled = false;
  try {
    const turnInput = {
      messages: checkpointMessages(input.plan, maximumTokens),
      responseFormat: {
        type: "json_schema",
        name: "agent_stream_checkpoint_summary",
        schema: AGENT_STREAM_CHECKPOINT_SUMMARY_SCHEMA,
        strict: true,
      },
      maxOutputTokens: maximumTokens,
    } as const;
    const correctedInputTokens = correctLocalInputTokenEstimate(
      estimateTurnInputTokens(turnInput).totalTokens,
    );
    if (input.maxInputTokens !== undefined && correctedInputTokens > input.maxInputTokens) {
      const errors = [
        `checkpoint generator input requires ${correctedInputTokens} tokens, exceeding capacity ${input.maxInputTokens}`,
      ];
      attempts.push({
        attempt: 1,
        status: "failed",
        providerCalled: false,
        durationMs: Date.now() - startedAt,
        errors,
      });
      return fallbackResult(input.plan, attempts, errors.join("; "), maximumTokens);
    }
    providerCalled = true;
    const response = await withEvaluationModelOperation({
      purpose: "durable_checkpoint_summary",
    }, async () => await input.provider.generateTurn(turnInput));
    if (response.type !== "assistant") {
      const errors = ["checkpoint provider returned tool calls instead of assistant JSON"];
      attempts.push({
        attempt: 1,
        status: "failed",
        providerCalled: true,
        durationMs: Date.now() - startedAt,
        errors,
        usage: response.usage,
        cost: response.cost,
      });
      return fallbackResult(input.plan, attempts, errors[0]!, maximumTokens);
    }
    const parsed = parseSummary(response.content);
    const validationErrors = parsed.summary
      ? validateSummary(parsed.summary, input.plan)
      : parsed.errors;
    const modelTokenCount = parsed.summary
      ? checkpointSummaryTokenCount(parsed.summary)
      : undefined;
    if (!parsed.summary || validationErrors.length > 0 || modelTokenCount === undefined) {
      const errors = compactErrors(validationErrors);
      attempts.push({
        attempt: 1,
        status: "failed",
        providerCalled: true,
        durationMs: Date.now() - startedAt,
        errors,
        usage: response.usage,
        cost: response.cost,
      });
      return fallbackResult(input.plan, attempts, errors.join("; "), maximumTokens, modelTokenCount);
    }
    const modelBoundsError = checkpointBoundsError(parsed.summary);
    if (modelTokenCount > maximumTokens || modelBoundsError) {
      const errors = [modelBoundsError
        ?? `checkpoint uses ${modelTokenCount} tokens, above budget ${maximumTokens}`];
      attempts.push({
        attempt: 1,
        status: "failed",
        providerCalled: true,
        durationMs: Date.now() - startedAt,
        errors,
        usage: response.usage,
        cost: response.cost,
      });
      const fitted = fitCheckpointToBudget({
        summary: parsed.summary,
        validAnchors: checkpointPlanAnchors(input.plan),
        maximumTokens,
      });
      return {
        status: "success",
        attempts,
        errors: [],
        summary: fitted.summary,
        tokenCount: fitted.tokenCount,
        generationMethod: "model_fitted",
        recoveryReason: errors[0],
        modelTokenCount,
        droppedCounts: fitted.droppedCounts,
        truncatedCounts: fitted.truncatedCounts,
      };
    }
    attempts.push({
      attempt: 1,
      status: "success",
      providerCalled: true,
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
      tokenCount: modelTokenCount,
      generationMethod: "model",
      modelTokenCount,
    };
  } catch (error) {
    const errors = compactErrors([error instanceof Error ? error.message : String(error)]);
    if (attempts.length === 0) {
      attempts.push({
        attempt: 1,
        status: "failed",
        providerCalled,
        durationMs: Date.now() - startedAt,
        errors,
      });
    }
    return fallbackResult(input.plan, attempts, errors.join("; "), maximumTokens);
  }
}

function checkpointMessages(
  plan: ContextCheckpointPlan,
  maximumTokens: number,
): Array<{ role: "system" | "user"; content: string }> {
  return [
    {
      role: "system",
      content: [
        "Create a structured conversation-continuity checkpoint for one agent stream.",
        "Summarize only the supplied previous checkpoint and messagesToSummarize; never invent facts.",
        "protectedRecentContext remains exact outside the checkpoint. Use it only to detect repetition, resolution, or newer corrections; do not copy it into the checkpoint and do not cite it.",
        "Every array item must cite the exact message sequence that supports it.",
        "Retention priority 1: active user requests, explicit constraints, user corrections, unresolved questions, assistant commitments, and literal references or attachment identities needed later.",
        "Retention priority 2: durable decisions and rationale, confirmed facts, stable user preferences, and definitions that still affect later discussion.",
        "Forget first: greetings, thanks, social filler, repetition, already-resolved explanations, superseded instructions, abandoned alternatives, transient errors, unsolicited follow-up offers, speculation, long quotations, and raw logs.",
        "A newer user correction overrides older conflicting text. Omit the superseded statement instead of preserving both as current truth.",
        "Never turn an assistant suggestion into a user request, an unverified assistant claim into a fact, or historical conversation into permission or execution evidence.",
        "Treat assistant responseKind and feedbackKind as exact relationship metadata. Preserve an unanswered feedback question under unresolvedQuestions.",
        "Treat attachmentRefs as belonging only to their exact user-message sequence. Preserve important attachment identities under references.",
        "Do not include tool action logs, WorkState, workstream state, or personal memory.",
        `Prefer a concise result within ${checkpointModelTargetTokens(maximumTokens)} estimated tokens.`,
        `The complete JSON must never exceed ${maximumTokens} estimated tokens.`,
        "Return only the requested JSON object.",
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify({
        coveredFromSeq: plan.coveredFromSeq,
        coveredToSeq: plan.coveredToSeq,
        previousCheckpoint: plan.previousCheckpoint?.summary ?? null,
        messagesToSummarize: plan.selectedMessages.map(checkpointMessage),
        protectedRecentContext: plan.exactTail.map(checkpointMessage),
      }, null, 2),
    },
  ];
}

function checkpointMessage(
  message: ContextCheckpointPlan["selectedMessages"][number],
): Record<string, unknown> {
  return {
    seq: message.sequence,
    role: message.role,
    at: message.at,
    content: message.content,
    ...(message.responseKind ? { responseKind: message.responseKind } : {}),
    ...(message.feedbackKind ? { feedbackKind: message.feedbackKind } : {}),
    ...(message.attachmentRefs && message.attachmentRefs.length > 0
      ? { attachmentRefs: message.attachmentRefs }
      : {}),
  };
}

function fallbackResult(
  plan: ContextCheckpointPlan,
  attempts: StreamCheckpointGenerationAttempt[],
  recoveryReason: string,
  maximumTokens: number,
  modelTokenCount?: number,
): StreamCheckpointGenerationResult {
  try {
    const fallback = createDeterministicCheckpointFallback({
      plan,
      maximumTokens,
    });
    return {
      status: "success",
      attempts,
      errors: [],
      summary: fallback.summary,
      tokenCount: fallback.tokenCount,
      generationMethod: "deterministic_fallback",
      recoveryReason,
      ...(modelTokenCount !== undefined ? { modelTokenCount } : {}),
      droppedCounts: fallback.droppedCounts,
      truncatedCounts: fallback.truncatedCounts,
    };
  } catch (error) {
    return {
      status: "failed",
      attempts,
      errors: compactErrors([
        recoveryReason,
        `deterministic checkpoint fallback failed: ${error instanceof Error ? error.message : String(error)}`,
      ]),
      ...(modelTokenCount !== undefined ? { modelTokenCount } : {}),
    };
  }
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

function checkpointBoundsError(summary: ContextCheckpointSummary): string | undefined {
  if (summary.narrative.length > CONTEXT_CHECKPOINT_NARRATIVE_MAX_CHARS) {
    return `checkpoint narrative exceeds ${CONTEXT_CHECKPOINT_NARRATIVE_MAX_CHARS} characters`;
  }
  for (const key of SUMMARY_ARRAY_KEYS) {
    if (summary[key].length > CONTEXT_CHECKPOINT_CATEGORY_MAX_ITEMS) {
      return `checkpoint ${key} contains more than ${CONTEXT_CHECKPOINT_CATEGORY_MAX_ITEMS} items`;
    }
    if (summary[key].some((statement) => {
      return statement.text.length > CONTEXT_CHECKPOINT_STATEMENT_MAX_CHARS;
    })) {
      return `checkpoint ${key} contains a statement above ${CONTEXT_CHECKPOINT_STATEMENT_MAX_CHARS} characters`;
    }
  }
  return undefined;
}

function compactErrors(errors: string[]): string[] {
  return [...new Set(errors.map((error) => error.trim()).filter(Boolean))].slice(0, 12);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
