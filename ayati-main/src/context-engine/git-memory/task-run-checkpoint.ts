import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { estimateTextTokens } from "../../prompt/token-estimator.js";
import type {
  GitMemoryConversationRecord,
  GitMemoryRunStatus,
  GitMemorySessionRunStatus,
} from "./schema.js";

export interface TaskRunCheckpointLimits {
  recentExchangeLimit: number;
  maxExactConversationTokens: number;
  maxCheckpointTokens: number;
}

export const DEFAULT_TASK_RUN_CHECKPOINT_LIMITS: TaskRunCheckpointLimits = {
  recentExchangeLimit: 3,
  maxExactConversationTokens: 2_000,
  maxCheckpointTokens: 4_000,
};

export interface TaskRunCheckpointRunSource {
  runClass: "task" | "session";
  taskId?: string;
  runId: string;
  status: GitMemorySessionRunStatus;
  summary: string;
  outcome?: string;
  completed?: string[];
  open?: string[];
  blockers?: string[];
  next?: string;
}

export interface TaskRunCheckpointRunContext {
  taskId: string;
  runId: string;
  status: GitMemoryRunStatus;
  summary: string;
  outcome?: string;
  completed: string[];
  open: string[];
  blockers: string[];
  next?: string;
}

export interface TaskRunCheckpointStatement {
  seq: number;
  text: string;
}

export interface TaskRunCheckpointSessionInterval {
  summary: string;
  userRequests: TaskRunCheckpointStatement[];
  assistantCommitments: TaskRunCheckpointStatement[];
  decisions: TaskRunCheckpointStatement[];
  corrections: TaskRunCheckpointStatement[];
  constraints: TaskRunCheckpointStatement[];
  importantFacts: TaskRunCheckpointStatement[];
  unresolvedQuestions: TaskRunCheckpointStatement[];
  references: TaskRunCheckpointStatement[];
}

export interface TaskRunCheckpointPendingUserInput {
  question: string;
  sourceSeq: number;
  options?: string[];
  expectedResponse?: string;
}

export interface TaskRunCheckpoint {
  schemaVersion: 1;
  checkpointId: string;
  sessionId: string;
  coverage: {
    fromSeq: number;
    toSeq: number;
    sourceEventCount: number;
    sourceHash: string;
  };
  run: TaskRunCheckpointRunContext;
  sessionInterval: TaskRunCheckpointSessionInterval;
  recentExactConversation: GitMemoryConversationRecord[];
  pendingUserInput?: TaskRunCheckpointPendingUserInput;
}

export interface PlanTaskRunCheckpointInput {
  sessionId: string;
  run: TaskRunCheckpointRunSource;
  conversation: GitMemoryConversationRecord[];
  coveredToSeq: number;
  previousCoveredUntilSeq?: number;
  limits?: Partial<TaskRunCheckpointLimits>;
}

export type TaskRunCheckpointPlan =
  | {
      schemaVersion: 1;
      status: "ineligible";
      reason: "session_run" | "task_run_not_finalized";
    }
  | {
      schemaVersion: 1;
      status: "invalid";
      errors: string[];
    }
  | ReadyTaskRunCheckpointPlan;

export interface ReadyTaskRunCheckpointPlan {
  schemaVersion: 1;
  status: "ready";
  checkpointId: string;
  sessionId: string;
  coverage: TaskRunCheckpoint["coverage"];
  run: TaskRunCheckpointRunContext;
  sourceRecords: GitMemoryConversationRecord[];
  recentExactConversation: GitMemoryConversationRecord[];
  pendingUserInput?: TaskRunCheckpointPendingUserInput;
  exactConversationTokens: number;
  limits: TaskRunCheckpointLimits;
}

export function planTaskRunCheckpoint(input: PlanTaskRunCheckpointInput): TaskRunCheckpointPlan {
  if (input.run.runClass === "session") {
    return { schemaVersion: 1, status: "ineligible", reason: "session_run" };
  }
  if (!isFinalizedTaskRunStatus(input.run.status)) {
    return { schemaVersion: 1, status: "ineligible", reason: "task_run_not_finalized" };
  }

  const limits = normalizeLimits(input.limits);
  const errors = validateIdentityAndBounds(input);
  const orderedRecords = input.conversation
    .map(cloneConversationRecord)
    .sort((left, right) => left.seq - right.seq);
  const fromSeq = input.previousCoveredUntilSeq === undefined
    ? orderedRecords[0]?.seq
    : input.previousCoveredUntilSeq + 1;
  const sourceRecords = fromSeq === undefined
    ? []
    : orderedRecords.filter((record) => record.seq >= fromSeq && record.seq <= input.coveredToSeq);

  errors.push(...validateSourceRecords(sourceRecords, fromSeq, input.coveredToSeq));
  if (errors.length > 0 || fromSeq === undefined || !input.run.taskId) {
    return { schemaVersion: 1, status: "invalid", errors: unique(errors) };
  }

  const recentExactConversation = selectRecentExactConversation(
    sourceRecords,
    limits.recentExchangeLimit,
  );
  const exactConversationTokens = estimateTextTokens(JSON.stringify(recentExactConversation));
  if (exactConversationTokens > limits.maxExactConversationTokens) {
    errors.push(
      `recent exact conversation uses ${exactConversationTokens} tokens, exceeding the ${limits.maxExactConversationTokens}-token limit`,
    );
  }

  const pendingUserInput = input.run.status === "needs_user_input"
    ? findPendingUserInput(sourceRecords)
    : undefined;
  if (input.run.status === "needs_user_input" && !pendingUserInput) {
    errors.push("needs_user_input task run must end with an exact assistant question");
  }
  if (errors.length > 0) {
    return { schemaVersion: 1, status: "invalid", errors: unique(errors) };
  }

  const sourceHash = hashTaskRunCheckpointSource(sourceRecords);
  const run = toRunContext(input.run);
  return {
    schemaVersion: 1,
    status: "ready",
    checkpointId: buildCheckpointId(input.sessionId, run.taskId, run.runId, sourceHash),
    sessionId: input.sessionId,
    coverage: {
      fromSeq,
      toSeq: input.coveredToSeq,
      sourceEventCount: sourceRecords.length,
      sourceHash,
    },
    run,
    sourceRecords,
    recentExactConversation,
    ...(pendingUserInput ? { pendingUserInput } : {}),
    exactConversationTokens,
    limits,
  };
}

export function validateTaskRunCheckpointAgainstPlan(
  checkpoint: TaskRunCheckpoint,
  plan: TaskRunCheckpointPlan,
): string[] {
  if (plan.status !== "ready") {
    return [`task-run checkpoint plan is ${plan.status}`];
  }

  const errors: string[] = [];
  if (checkpoint.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (checkpoint.checkpointId !== plan.checkpointId) errors.push("checkpointId does not match the plan");
  if (checkpoint.sessionId !== plan.sessionId) errors.push("sessionId does not match the plan");
  if (!isDeepStrictEqual(checkpoint.coverage, plan.coverage)) errors.push("coverage does not match the plan");
  if (!isDeepStrictEqual(checkpoint.run, plan.run)) errors.push("run context does not match the plan");
  if (!isDeepStrictEqual(checkpoint.recentExactConversation, plan.recentExactConversation)) {
    errors.push("recent exact conversation does not match the plan");
  }
  if (!isDeepStrictEqual(checkpoint.pendingUserInput, plan.pendingUserInput)) {
    errors.push("pending user input does not match the plan");
  }
  if (hashTaskRunCheckpointSource(plan.sourceRecords) !== plan.coverage.sourceHash) {
    errors.push("plan source records no longer match the source hash");
  }
  if (!checkpoint.sessionInterval.summary.trim()) {
    errors.push("session interval summary must not be empty");
  }

  const sourceSeqs = new Set(plan.sourceRecords.map((record) => record.seq));
  for (const statement of sessionIntervalStatements(checkpoint.sessionInterval)) {
    if (!statement.text.trim()) errors.push(`checkpoint statement at seq ${statement.seq} is empty`);
    if (!sourceSeqs.has(statement.seq)) {
      errors.push(`checkpoint statement seq ${statement.seq} is not in the covered conversation`);
    }
  }

  const checkpointTokens = estimateTextTokens(JSON.stringify(checkpoint));
  if (checkpointTokens > plan.limits.maxCheckpointTokens) {
    errors.push(
      `checkpoint uses ${checkpointTokens} tokens, exceeding the ${plan.limits.maxCheckpointTokens}-token limit`,
    );
  }
  return unique(errors);
}

export function assembleTaskRunCheckpoint(
  plan: ReadyTaskRunCheckpointPlan,
  sessionInterval: TaskRunCheckpointSessionInterval,
): TaskRunCheckpoint {
  return {
    schemaVersion: 1,
    checkpointId: plan.checkpointId,
    sessionId: plan.sessionId,
    coverage: { ...plan.coverage },
    run: {
      ...plan.run,
      completed: [...plan.run.completed],
      open: [...plan.run.open],
      blockers: [...plan.run.blockers],
    },
    sessionInterval: structuredClone(sessionInterval),
    recentExactConversation: plan.recentExactConversation.map(cloneConversationRecord),
    ...(plan.pendingUserInput ? {
      pendingUserInput: {
        ...plan.pendingUserInput,
        ...(plan.pendingUserInput.options ? { options: [...plan.pendingUserInput.options] } : {}),
      },
    } : {}),
  };
}

export function hashTaskRunCheckpointSource(records: GitMemoryConversationRecord[]): string {
  const canonical = [...records].sort((left, right) => left.seq - right.seq).map((record) => ({
    seq: record.seq,
    role: record.role,
    kind: record.kind ?? null,
    at: record.at,
    text: record.text ?? null,
    contentRef: record.contentRef ?? null,
    sha256: record.sha256 ?? null,
    taskId: record.taskId ?? null,
    runId: record.runId ?? null,
    branch: record.branch ?? null,
  }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function validateIdentityAndBounds(input: PlanTaskRunCheckpointInput): string[] {
  const errors: string[] = [];
  if (!input.sessionId.trim()) errors.push("sessionId must not be empty");
  if (!input.run.taskId?.trim()) errors.push("taskId must not be empty");
  if (!input.run.runId.trim()) errors.push("runId must not be empty");
  if (!input.run.summary.trim()) errors.push("run summary must not be empty");
  if (!Number.isInteger(input.coveredToSeq) || input.coveredToSeq < 1) {
    errors.push("coveredToSeq must be a positive integer");
  }
  if (
    input.previousCoveredUntilSeq !== undefined
    && (!Number.isInteger(input.previousCoveredUntilSeq) || input.previousCoveredUntilSeq < 0)
  ) {
    errors.push("previousCoveredUntilSeq must be a non-negative integer");
  }
  if (
    input.previousCoveredUntilSeq !== undefined
    && input.previousCoveredUntilSeq >= input.coveredToSeq
  ) {
    errors.push("coveredToSeq must be greater than previousCoveredUntilSeq");
  }
  return errors;
}

function validateSourceRecords(
  records: GitMemoryConversationRecord[],
  fromSeq: number | undefined,
  toSeq: number,
): string[] {
  if (fromSeq === undefined || records.length === 0) {
    return ["checkpoint conversation interval must not be empty"];
  }
  const errors: string[] = [];
  const seen = new Set<number>();
  for (const record of records) {
    if (seen.has(record.seq)) errors.push(`conversation sequence ${record.seq} is duplicated`);
    seen.add(record.seq);
  }
  if (records[0]?.seq !== fromSeq) errors.push(`conversation interval must start at sequence ${fromSeq}`);
  if (records.at(-1)?.seq !== toSeq) errors.push(`conversation interval must end at sequence ${toSeq}`);
  for (let seq = fromSeq; seq <= toSeq; seq++) {
    if (!seen.has(seq)) errors.push(`conversation interval is missing sequence ${seq}`);
  }
  if (!records.some((record) => record.role === "user")) {
    errors.push("checkpoint conversation interval must contain a user message");
  }
  if (records.at(-1)?.role !== "assistant") {
    errors.push("checkpoint conversation interval must end with the final assistant message");
  }
  return errors;
}

function selectRecentExactConversation(
  records: GitMemoryConversationRecord[],
  exchangeLimit: number,
): GitMemoryConversationRecord[] {
  const userIndexes = records
    .map((record, index) => ({ record, index }))
    .filter(({ record }) => record.role === "user")
    .map(({ index }) => index);
  const firstExchangeIndex = userIndexes[Math.max(0, userIndexes.length - exchangeLimit)] ?? 0;
  return records.slice(firstExchangeIndex).map(cloneConversationRecord);
}

function findPendingUserInput(
  records: GitMemoryConversationRecord[],
): TaskRunCheckpointPendingUserInput | undefined {
  const assistant = [...records].reverse().find(
    (record) => record.role === "assistant" && record.kind === "feedback_question",
  );
  const question = assistant?.text;
  if (!assistant || !question?.trim()) {
    return undefined;
  }
  return {
    question,
    sourceSeq: assistant.seq,
  };
}

function toRunContext(source: TaskRunCheckpointRunSource): TaskRunCheckpointRunContext {
  return {
    taskId: source.taskId!,
    runId: source.runId,
    status: source.status as GitMemoryRunStatus,
    summary: source.summary,
    ...(source.outcome ? { outcome: source.outcome } : {}),
    completed: [...(source.completed ?? [])],
    open: [...(source.open ?? [])],
    blockers: [...(source.blockers ?? [])],
    ...(source.next ? { next: source.next } : {}),
  };
}

function buildCheckpointId(sessionId: string, taskId: string, runId: string, sourceHash: string): string {
  const hash = createHash("sha256")
    .update(JSON.stringify({ sessionId, taskId, runId, sourceHash }))
    .digest("hex");
  return `task-run-checkpoint-${hash}`;
}

function isFinalizedTaskRunStatus(status: GitMemorySessionRunStatus): status is GitMemoryRunStatus {
  return status === "completed"
    || status === "failed"
    || status === "blocked"
    || status === "needs_user_input";
}

function sessionIntervalStatements(interval: TaskRunCheckpointSessionInterval): TaskRunCheckpointStatement[] {
  return [
    ...interval.userRequests,
    ...interval.assistantCommitments,
    ...interval.decisions,
    ...interval.corrections,
    ...interval.constraints,
    ...interval.importantFacts,
    ...interval.unresolvedQuestions,
    ...interval.references,
  ];
}

function normalizeLimits(input: Partial<TaskRunCheckpointLimits> | undefined): TaskRunCheckpointLimits {
  return {
    recentExchangeLimit: positiveInteger(input?.recentExchangeLimit, DEFAULT_TASK_RUN_CHECKPOINT_LIMITS.recentExchangeLimit),
    maxExactConversationTokens: positiveInteger(
      input?.maxExactConversationTokens,
      DEFAULT_TASK_RUN_CHECKPOINT_LIMITS.maxExactConversationTokens,
    ),
    maxCheckpointTokens: positiveInteger(input?.maxCheckpointTokens, DEFAULT_TASK_RUN_CHECKPOINT_LIMITS.maxCheckpointTokens),
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value !== undefined && value > 0 ? value : fallback;
}

function cloneConversationRecord(record: GitMemoryConversationRecord): GitMemoryConversationRecord {
  return { ...record };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
