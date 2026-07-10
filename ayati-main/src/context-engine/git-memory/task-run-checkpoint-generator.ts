import { estimateTextTokens } from "../../prompt/token-estimator.js";
import {
  validateTaskRunCheckpointAgainstPlan,
} from "./task-run-checkpoint.js";
import type {
  ReadyTaskRunCheckpointPlan,
  TaskRunCheckpoint,
  TaskRunCheckpointPlan,
  TaskRunCheckpointSessionInterval,
  TaskRunCheckpointStatement,
} from "./task-run-checkpoint.js";

export interface DeterministicTaskRunCheckpointContext {
  decisions?: string[];
  importantFacts?: string[];
  references?: string[];
}

export interface TaskRunCheckpointOmission {
  field: "userRequests" | "decisions" | "importantFacts" | "references" | "sessionIntervalSummary";
  count: number;
  reason: "checkpoint_token_budget";
}

export type DeterministicTaskRunCheckpointGenerationResult =
  | {
      status: "success";
      strategy: "deterministic";
      checkpoint: TaskRunCheckpoint;
      errors: [];
      omitted: TaskRunCheckpointOmission[];
      estimatedTokens: number;
    }
  | {
      status: "failed";
      strategy: "deterministic";
      errors: string[];
      omitted: TaskRunCheckpointOmission[];
      estimatedTokens?: number;
    };

export function generateDeterministicTaskRunCheckpoint(input: {
  plan: TaskRunCheckpointPlan;
  context?: DeterministicTaskRunCheckpointContext;
}): DeterministicTaskRunCheckpointGenerationResult {
  if (input.plan.status !== "ready") {
    return {
      status: "failed",
      strategy: "deterministic",
      errors: [`task-run checkpoint plan is ${input.plan.status}`],
      omitted: [],
    };
  }

  const checkpoint = buildCheckpoint(input.plan, input.context);
  const omissions = new Map<TaskRunCheckpointOmission["field"], number>();
  reduceCheckpointToBudget(checkpoint, input.plan, omissions);
  const estimatedTokens = estimateCheckpointTokens(checkpoint);
  const errors = validateTaskRunCheckpointAgainstPlan(checkpoint, input.plan);
  if (errors.length > 0) {
    return {
      status: "failed",
      strategy: "deterministic",
      errors,
      omitted: toOmissionRecords(omissions),
      estimatedTokens,
    };
  }

  return {
    status: "success",
    strategy: "deterministic",
    checkpoint,
    errors: [],
    omitted: toOmissionRecords(omissions),
    estimatedTokens,
  };
}

function buildCheckpoint(
  plan: ReadyTaskRunCheckpointPlan,
  context: DeterministicTaskRunCheckpointContext | undefined,
): TaskRunCheckpoint {
  const finalSeq = plan.coverage.toSeq;
  const sessionInterval: TaskRunCheckpointSessionInterval = {
    summary: buildIntervalSummary(plan),
    userRequests: userRequestStatements(plan),
    assistantCommitments: [],
    decisions: sourceStatements(context?.decisions, finalSeq),
    corrections: [],
    constraints: [],
    importantFacts: sourceStatements(context?.importantFacts, finalSeq),
    unresolvedQuestions: plan.pendingUserInput
      ? [{ seq: plan.pendingUserInput.sourceSeq, text: plan.pendingUserInput.question }]
      : [],
    references: referenceStatements(plan, context?.references),
  };
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
    sessionInterval,
    recentExactConversation: plan.recentExactConversation.map((record) => ({ ...record })),
    ...(plan.pendingUserInput ? {
      pendingUserInput: {
        ...plan.pendingUserInput,
        ...(plan.pendingUserInput.options ? { options: [...plan.pendingUserInput.options] } : {}),
      },
    } : {}),
  };
}

function buildIntervalSummary(plan: ReadyTaskRunCheckpointPlan): string {
  const summary = plan.run.summary.trim();
  const outcome = plan.run.outcome?.trim();
  if (!outcome || outcome.toLowerCase() === summary.toLowerCase()) {
    return `${runStatusLabel(plan.run.status)}: ${summary}`;
  }
  return `${runStatusLabel(plan.run.status)}: ${summary} Outcome: ${outcome}`;
}

function userRequestStatements(plan: ReadyTaskRunCheckpointPlan): TaskRunCheckpointStatement[] {
  return plan.sourceRecords
    .filter((record) => record.role === "user")
    .map((record) => ({
      seq: record.seq,
      text: recordText(record.text, record.contentRef),
    }))
    .filter((statement) => statement.text.length > 0);
}

function sourceStatements(values: string[] | undefined, seq: number): TaskRunCheckpointStatement[] {
  return uniqueStrings(values).map((text) => ({ seq, text }));
}

function referenceStatements(
  plan: ReadyTaskRunCheckpointPlan,
  explicitReferences: string[] | undefined,
): TaskRunCheckpointStatement[] {
  const statements: TaskRunCheckpointStatement[] = [];
  for (const record of plan.sourceRecords) {
    const reference = record.contentRef?.trim();
    if (reference) statements.push({ seq: record.seq, text: reference });
  }
  for (const reference of uniqueStrings(explicitReferences)) {
    statements.push({ seq: plan.coverage.toSeq, text: reference });
  }
  return uniqueStatements(statements);
}

function reduceCheckpointToBudget(
  checkpoint: TaskRunCheckpoint,
  plan: ReadyTaskRunCheckpointPlan,
  omissions: Map<TaskRunCheckpointOmission["field"], number>,
): void {
  const recentSeqs = new Set(plan.recentExactConversation.map((record) => record.seq));
  removeWhileOverBudget(
    checkpoint,
    plan.limits.maxCheckpointTokens,
    "userRequests",
    omissions,
    () => removeFirstMatching(
      checkpoint.sessionInterval.userRequests,
      (statement) => !recentSeqs.has(statement.seq),
    ),
  );
  removeWhileOverBudget(
    checkpoint,
    plan.limits.maxCheckpointTokens,
    "references",
    omissions,
    () => removeFirst(checkpoint.sessionInterval.references),
  );
  removeWhileOverBudget(
    checkpoint,
    plan.limits.maxCheckpointTokens,
    "importantFacts",
    omissions,
    () => removeFirst(checkpoint.sessionInterval.importantFacts),
  );
  removeWhileOverBudget(
    checkpoint,
    plan.limits.maxCheckpointTokens,
    "decisions",
    omissions,
    () => removeFirst(checkpoint.sessionInterval.decisions),
  );
  removeWhileOverBudget(
    checkpoint,
    plan.limits.maxCheckpointTokens,
    "userRequests",
    omissions,
    () => removeFirst(checkpoint.sessionInterval.userRequests),
  );
  if (estimateCheckpointTokens(checkpoint) > plan.limits.maxCheckpointTokens) {
    const compactSummary = `${runStatusLabel(plan.run.status)}: ${plan.run.summary.trim()}`;
    if (checkpoint.sessionInterval.summary !== compactSummary) {
      checkpoint.sessionInterval.summary = compactSummary;
      omissions.set("sessionIntervalSummary", 1);
    }
  }
}

function removeWhileOverBudget(
  checkpoint: TaskRunCheckpoint,
  maxTokens: number,
  field: TaskRunCheckpointOmission["field"],
  omissions: Map<TaskRunCheckpointOmission["field"], number>,
  remove: () => boolean,
): void {
  while (estimateCheckpointTokens(checkpoint) > maxTokens && remove()) {
    omissions.set(field, (omissions.get(field) ?? 0) + 1);
  }
}

function removeFirst<T>(values: T[]): boolean {
  if (values.length === 0) return false;
  values.shift();
  return true;
}

function removeFirstMatching<T>(values: T[], predicate: (value: T) => boolean): boolean {
  const index = values.findIndex(predicate);
  if (index < 0) return false;
  values.splice(index, 1);
  return true;
}

function estimateCheckpointTokens(checkpoint: TaskRunCheckpoint): number {
  return estimateTextTokens(JSON.stringify(checkpoint));
}

function toOmissionRecords(
  omissions: Map<TaskRunCheckpointOmission["field"], number>,
): TaskRunCheckpointOmission[] {
  return [...omissions.entries()].map(([field, count]) => ({
    field,
    count,
    reason: "checkpoint_token_budget",
  }));
}

function uniqueStatements(statements: TaskRunCheckpointStatement[]): TaskRunCheckpointStatement[] {
  const seen = new Set<string>();
  return statements.filter((statement) => {
    const key = statement.text.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueStrings(values: string[] | undefined): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values ?? []) {
    const normalized = value.replace(/\s+/g, " ").trim();
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function recordText(text: string | null | undefined, contentRef: string | null | undefined): string {
  const normalizedText = text?.trim();
  if (normalizedText) return normalizedText;
  const normalizedReference = contentRef?.trim();
  return normalizedReference ? `[content: ${normalizedReference}]` : "";
}

function runStatusLabel(status: ReadyTaskRunCheckpointPlan["run"]["status"]): string {
  switch (status) {
    case "completed":
      return "Run completed";
    case "failed":
      return "Run failed";
    case "blocked":
      return "Run blocked";
    case "needs_user_input":
      return "Run needs user input";
  }
}
