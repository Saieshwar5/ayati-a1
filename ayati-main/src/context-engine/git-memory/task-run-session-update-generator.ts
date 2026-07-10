import type { LlmProvider } from "../../core/contracts/provider.js";
import type {
  LlmCostEstimate,
  LlmTokenUsage,
  LlmTurnInput,
} from "../../core/contracts/llm-protocol.js";
import { estimateTextTokens, estimateTurnInputTokens } from "../../prompt/token-estimator.js";
import type { ContextSessionSummary } from "../contracts.js";
import {
  DEFAULT_SESSION_SNAPSHOT_MAX_TOKENS,
  renderSessionSnapshotMarkdown,
} from "./session-snapshot.js";
import type {
  SessionSnapshot,
  SessionSnapshotValidationContext,
} from "./session-snapshot.js";
import {
  assembleTaskRunCheckpoint,
  hashTaskRunCheckpointSource,
  validateTaskRunCheckpointAgainstPlan,
} from "./task-run-checkpoint.js";
import type {
  ReadyTaskRunCheckpointPlan,
  TaskRunCheckpoint,
  TaskRunCheckpointPlan,
  TaskRunCheckpointSessionInterval,
} from "./task-run-checkpoint.js";
import {
  generateDeterministicTaskRunCheckpoint,
} from "./task-run-checkpoint-generator.js";
import type {
  DeterministicTaskRunCheckpointContext,
  TaskRunCheckpointOmission,
} from "./task-run-checkpoint-generator.js";
import {
  hashTaskRunSessionUpdateInput,
  readTaskRunSessionUpdateCache,
  taskRunSessionUpdateCacheKey,
  writeTaskRunSessionUpdateCache,
} from "./task-run-session-update-cache.js";
import type {
  TaskRunSessionUpdateCacheState,
} from "./task-run-session-update-cache.js";
import { parseTaskRunSessionUpdate } from "./task-run-session-update-parser.js";
import { TASK_RUN_SESSION_UPDATE_SCHEMA } from "./task-run-session-update-schema.js";

export interface TaskRunSessionUpdateGenerationAttempt {
  attempt: number;
  status: "success" | "failed";
  durationMs: number;
  errors: string[];
  usage?: LlmTokenUsage;
  cost?: LlmCostEstimate;
}

export type TaskRunSessionUpdateGenerationResult =
  | {
      status: "success";
      strategy: "llm";
      cacheStatus: "generated" | "success_hit";
      checkpoint: TaskRunCheckpoint;
      sessionSnapshot: SessionSnapshot;
      summaryMarkdown: string;
      summaryUpdated: true;
      checkpointTokens: number;
      snapshotTokens: number;
      attempts: TaskRunSessionUpdateGenerationAttempt[];
      errors: [];
    }
  | {
      status: "fallback";
      strategy: "deterministic";
      cacheStatus: "generated" | "failure_hit";
      checkpoint: TaskRunCheckpoint;
      retainedSummary?: ContextSessionSummary;
      summaryUpdated: false;
      omitted: TaskRunCheckpointOmission[];
      attempts: TaskRunSessionUpdateGenerationAttempt[];
      errors: string[];
    }
  | {
      status: "failed";
      strategy: "deterministic";
      cacheStatus: "generated" | "failure_hit";
      summaryUpdated: false;
      attempts: TaskRunSessionUpdateGenerationAttempt[];
      errors: string[];
    };

export interface GenerateTaskRunSessionUpdateInput {
  provider: LlmProvider;
  plan: TaskRunCheckpointPlan;
  previousSummary?: ContextSessionSummary;
  structuredContext?: DeterministicTaskRunCheckpointContext;
  knownTaskIds?: string[];
  knownRunIds?: string[];
  cache: TaskRunSessionUpdateCacheState;
  maxGeneratorInputTokens?: number;
  maxSnapshotTokens?: number;
}

const MAX_GENERATION_ATTEMPTS = 2;
const MAX_REPAIR_OUTPUT_CHARS = 12_000;

export async function generateTaskRunSessionUpdate(
  input: GenerateTaskRunSessionUpdateInput,
): Promise<TaskRunSessionUpdateGenerationResult> {
  if (input.plan.status !== "ready") {
    return buildFallback(input, [], "generated", [`task-run checkpoint plan is ${input.plan.status}`]);
  }
  if (hashTaskRunCheckpointSource(input.plan.sourceRecords) !== input.plan.coverage.sourceHash) {
    return buildFallback(input, [], "generated", ["plan source records no longer match the source hash"]);
  }
  const prepared = prepareGeneration(input, input.plan);
  const cached = readTaskRunSessionUpdateCache(input.cache, prepared.cacheKey);
  if (cached?.status === "success") {
    return {
      status: "success",
      strategy: "llm",
      cacheStatus: "success_hit",
      checkpoint: cached.checkpoint,
      sessionSnapshot: cached.sessionSnapshot,
      summaryMarkdown: cached.summaryMarkdown,
      summaryUpdated: true,
      checkpointTokens: cached.checkpointTokens,
      snapshotTokens: cached.snapshotTokens,
      attempts: [],
      errors: [],
    };
  }
  if (cached?.status === "failed") {
    return buildFallback(input, [], "failure_hit", cached.errors);
  }

  const attempts: TaskRunSessionUpdateGenerationAttempt[] = [];
  let previousErrors: string[] = [];
  let previousOutput = "";
  for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
    const startedAt = Date.now();
    const turnInput = buildTurnInput(prepared, previousErrors, previousOutput);
    const estimatedInputTokens = estimateTurnInputTokens(turnInput).totalTokens;
    if (
      input.maxGeneratorInputTokens !== undefined
      && estimatedInputTokens > input.maxGeneratorInputTokens
    ) {
      previousErrors = [
        `task-run session update input requires ${estimatedInputTokens} estimated tokens, exceeding its ${input.maxGeneratorInputTokens}-token capacity`,
      ];
      attempts.push(failedAttempt(attempt, startedAt, previousErrors));
      break;
    }

    try {
      const response = await input.provider.generateTurn(turnInput);
      if (response.type !== "assistant") {
        previousErrors = ["task-run session update provider returned tool calls instead of assistant JSON"];
        attempts.push(failedAttempt(attempt, startedAt, previousErrors, response.usage, response.cost));
        previousOutput = "";
        continue;
      }
      previousOutput = response.content;
      const parsed = parseTaskRunSessionUpdate(response.content, prepared.snapshotContext);
      if (!parsed.update) {
        previousErrors = compactErrors(parsed.errors);
        attempts.push(failedAttempt(attempt, startedAt, previousErrors, response.usage, response.cost));
        continue;
      }

      const checkpoint = assembleTaskRunCheckpoint(input.plan, parsed.update.sessionInterval);
      const validationErrors = [
        ...validateTaskRunCheckpointAgainstPlan(checkpoint, input.plan),
        ...validatePendingInterval(parsed.update.sessionInterval, input.plan),
        ...validateStructuredContext(parsed.update.sessionInterval, input.structuredContext),
        ...validateCurrentRunProgress(parsed.update.sessionSnapshot, input.plan),
      ];
      const summaryMarkdown = renderSessionSnapshotMarkdown(parsed.update.sessionSnapshot);
      const snapshotTokens = estimateTextTokens(summaryMarkdown);
      if (snapshotTokens > prepared.maxSnapshotTokens) {
        validationErrors.push(
          `session summary markdown uses ${snapshotTokens} tokens, exceeding the ${prepared.maxSnapshotTokens}-token limit`,
        );
      }
      if (validationErrors.length > 0) {
        previousErrors = compactErrors(validationErrors);
        attempts.push(failedAttempt(attempt, startedAt, previousErrors, response.usage, response.cost));
        continue;
      }

      const checkpointTokens = estimateTextTokens(JSON.stringify(checkpoint));
      attempts.push({
        attempt,
        status: "success",
        durationMs: Date.now() - startedAt,
        errors: [],
        ...(response.usage ? { usage: response.usage } : {}),
        ...(response.cost ? { cost: response.cost } : {}),
      });
      writeTaskRunSessionUpdateCache(input.cache, prepared.cacheKey, {
        status: "success",
        checkpoint,
        sessionSnapshot: parsed.update.sessionSnapshot,
        summaryMarkdown,
        checkpointTokens,
        snapshotTokens,
      });
      return {
        status: "success",
        strategy: "llm",
        cacheStatus: "generated",
        checkpoint,
        sessionSnapshot: parsed.update.sessionSnapshot,
        summaryMarkdown,
        summaryUpdated: true,
        checkpointTokens,
        snapshotTokens,
        attempts,
        errors: [],
      };
    } catch (error) {
      previousErrors = compactErrors([error instanceof Error ? error.message : String(error)]);
      attempts.push(failedAttempt(attempt, startedAt, previousErrors));
    }
  }

  const errors = compactErrors(attempts.flatMap((attempt) => attempt.errors));
  writeTaskRunSessionUpdateCache(input.cache, prepared.cacheKey, { status: "failed", errors });
  return buildFallback(input, attempts, "generated", errors);
}

function prepareGeneration(input: GenerateTaskRunSessionUpdateInput, plan: ReadyTaskRunCheckpointPlan) {
  const knownTaskIds = sortedUnique([...(input.knownTaskIds ?? []), plan.run.taskId]);
  const knownRunIds = sortedUnique([...(input.knownRunIds ?? []), plan.run.runId]);
  const maxSnapshotTokens = positiveInteger(
    input.maxSnapshotTokens,
    DEFAULT_SESSION_SNAPSHOT_MAX_TOKENS,
  );
  const generationSource = {
    run: plan.run,
    pendingUserInput: plan.pendingUserInput ?? null,
    previousSummary: input.previousSummary ?? null,
    structuredContext: input.structuredContext ?? {},
    knownTaskIds,
    knownRunIds,
  };
  const generationInputHash = hashTaskRunSessionUpdateInput(generationSource);
  return {
    plan,
    previousSummary: input.previousSummary,
    structuredContext: input.structuredContext ?? {},
    knownTaskIds,
    knownRunIds,
    maxSnapshotTokens,
    snapshotContext: {
      conversationSeqs: plan.sourceRecords.map((record) => record.seq),
      taskIds: knownTaskIds,
      runIds: knownRunIds,
      previousSummarySupplied: Boolean(input.previousSummary?.text.trim()),
      ...(plan.pendingUserInput ? {
        pendingUserInput: {
          question: plan.pendingUserInput.question,
          sourceSeq: plan.pendingUserInput.sourceSeq,
        },
      } : {}),
      maxTokens: maxSnapshotTokens,
    } satisfies SessionSnapshotValidationContext,
    cacheKey: taskRunSessionUpdateCacheKey({
      provider: input.provider.name,
      model: input.provider.version,
      checkpointId: plan.checkpointId,
      sourceHash: plan.coverage.sourceHash,
      generationInputHash,
      checkpointTokenBudget: plan.limits.maxCheckpointTokens,
      snapshotTokenBudget: maxSnapshotTokens,
      ...(input.maxGeneratorInputTokens !== undefined
        ? { generatorInputCapacity: input.maxGeneratorInputTokens }
        : {}),
    }),
  };
}

function buildTurnInput(
  prepared: ReturnType<typeof prepareGeneration>,
  previousErrors: string[],
  previousOutput: string,
): LlmTurnInput {
  return {
    messages: [
      {
        role: "system",
        content: [
          "Create a semantic task-run checkpoint interval and a replacement AI-agent session snapshot.",
          "Use only the supplied previous summary, conversation, finalized run, structured facts, and references.",
          "Do not invent task ids, run ids, facts, decisions, constraints, commitments, questions, or references.",
          "Every sessionInterval statement must cite an exact supplied conversation seq.",
          "Snapshot semantic items must cite conversation, task_run, or previous_summary sources.",
          "Use previous_summary only when a previous summary is supplied.",
          "Preserve pending user-input questions exactly, including their conversation seq.",
          "Mark replaced requests as superseded and keep unrelated session threads separate.",
          "Do not include raw tool output, work state, personal memory, or harness feedback.",
          `Keep the complete checkpoint within ${prepared.plan.limits.maxCheckpointTokens} estimated tokens.`,
          `Keep the rendered session snapshot within ${prepared.maxSnapshotTokens} estimated tokens.`,
          "Return only the requested JSON object.",
          ...(previousErrors.length > 0
            ? [`Repair these validation failures: ${previousErrors.join("; ")}`]
            : []),
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify({
          previousSessionSummary: prepared.previousSummary?.text ?? null,
          conversationInterval: prepared.plan.sourceRecords,
          finalizedRun: prepared.plan.run,
          structuredContext: prepared.structuredContext,
          allowedTaskIds: prepared.knownTaskIds,
          allowedRunIds: prepared.knownRunIds,
          pendingUserInput: prepared.plan.pendingUserInput ?? null,
          ...(previousErrors.length > 0 ? {
            invalidPreviousOutput: previousOutput.slice(0, MAX_REPAIR_OUTPUT_CHARS),
          } : {}),
        }, null, 2),
      },
    ],
    responseFormat: {
      type: "json_schema",
      name: "task_run_session_update",
      schema: TASK_RUN_SESSION_UPDATE_SCHEMA,
      strict: true,
    },
  };
}

function validatePendingInterval(
  interval: TaskRunCheckpointSessionInterval,
  plan: ReadyTaskRunCheckpointPlan,
): string[] {
  if (!plan.pendingUserInput) return [];
  const preserved = interval.unresolvedQuestions.some((question) => (
    question.seq === plan.pendingUserInput!.sourceSeq
    && question.text === plan.pendingUserInput!.question
  ));
  return preserved
    ? []
    : ["sessionInterval must preserve the exact pending user-input question and source sequence"];
}

function validateCurrentRunProgress(snapshot: SessionSnapshot, plan: ReadyTaskRunCheckpointPlan): string[] {
  const current = snapshot.recentProgress.find((progress) => progress.runId === plan.run.runId);
  if (!current) return [`session snapshot must include recent progress for current run ${plan.run.runId}`];
  const errors: string[] = [];
  if (current.taskId !== plan.run.taskId) errors.push("current session progress taskId does not match the plan");
  if (current.status !== plan.run.status) errors.push("current session progress status does not match the plan");
  if (!current.sources.some((source) => source.kind === "task_run" && source.runId === plan.run.runId)) {
    errors.push("current session progress must cite the current task run");
  }
  return errors;
}

function validateStructuredContext(
  interval: TaskRunCheckpointSessionInterval,
  context: DeterministicTaskRunCheckpointContext | undefined,
): string[] {
  return [
    ...missingStructuredValues("decision", context?.decisions, interval.decisions),
    ...missingStructuredValues("important fact", context?.importantFacts, interval.importantFacts),
    ...missingStructuredValues("reference", context?.references, interval.references),
  ];
}

function missingStructuredValues(
  label: string,
  required: string[] | undefined,
  actual: Array<{ text: string }>,
): string[] {
  const actualValues = new Set(actual.map((item) => normalizedText(item.text)));
  return sortedUnique(required ?? [])
    .filter((value) => !actualValues.has(normalizedText(value)))
    .map((value) => `sessionInterval must preserve structured ${label}: ${value}`);
}

function buildFallback(
  input: GenerateTaskRunSessionUpdateInput,
  attempts: TaskRunSessionUpdateGenerationAttempt[],
  cacheStatus: "generated" | "failure_hit",
  llmErrors: string[],
): TaskRunSessionUpdateGenerationResult {
  const fallback = generateDeterministicTaskRunCheckpoint({
    plan: input.plan,
    context: input.structuredContext,
  });
  if (fallback.status === "success") {
    return {
      status: "fallback",
      strategy: "deterministic",
      cacheStatus,
      checkpoint: fallback.checkpoint,
      ...(input.previousSummary ? { retainedSummary: structuredClone(input.previousSummary) } : {}),
      summaryUpdated: false,
      omitted: fallback.omitted,
      attempts,
      errors: compactErrors(llmErrors),
    };
  }
  return {
    status: "failed",
    strategy: "deterministic",
    cacheStatus,
    summaryUpdated: false,
    attempts,
    errors: compactErrors([...llmErrors, ...fallback.errors]),
  };
}

function failedAttempt(
  attempt: number,
  startedAt: number,
  errors: string[],
  usage?: LlmTokenUsage,
  cost?: LlmCostEstimate,
): TaskRunSessionUpdateGenerationAttempt {
  return {
    attempt,
    status: "failed",
    durationMs: Date.now() - startedAt,
    errors,
    ...(usage ? { usage } : {}),
    ...(cost ? { cost } : {}),
  };
}

function compactErrors(errors: string[]): string[] {
  return [...new Set(errors)]
    .slice(0, 12)
    .map((error) => error.length <= 300 ? error : `${error.slice(0, 297)}...`);
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function normalizedText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value !== undefined && value > 0 ? value : fallback;
}
