import type { LlmProvider } from "../../core/contracts/provider.js";
import type { ContextSessionSummary } from "../contracts.js";
import { renderGitMemoryCommitMessage } from "./commit-message.js";
import type { CommitGitMemoryTaskRunInput } from "./session-store.js";
import {
  generateDeterministicTaskRunCheckpoint,
  type DeterministicTaskRunCheckpointContext,
} from "./task-run-checkpoint-generator.js";
import {
  hashTaskRunCheckpointSource,
  planTaskRunCheckpoint,
  type TaskRunCheckpoint,
  type TaskRunCheckpointPlan,
} from "./task-run-checkpoint.js";
import {
  createTaskRunSessionUpdateCache,
  type TaskRunSessionUpdateCacheState,
} from "./task-run-session-update-cache.js";
import {
  generateTaskRunSessionUpdate,
  type TaskRunSessionUpdateGenerationResult,
} from "./task-run-session-update-generator.js";
import type { GitMemoryConversationRecord } from "./schema.js";

export interface TaskRunSessionUpdateGeneratorInput {
  plan: TaskRunCheckpointPlan;
  previousSummary?: ContextSessionSummary;
  structuredContext?: DeterministicTaskRunCheckpointContext;
  knownTaskIds?: string[];
  knownRunIds?: string[];
}

export interface TaskRunSessionUpdateGenerator {
  generate(input: TaskRunSessionUpdateGeneratorInput): Promise<TaskRunSessionUpdateGenerationResult>;
}

export interface ProviderTaskRunSessionUpdateGeneratorOptions {
  provider: LlmProvider;
  cache?: TaskRunSessionUpdateCacheState;
  maxGeneratorInputTokens?: number;
  maxSnapshotTokens?: number;
}

export interface PrepareTaskRunFinalizationInput {
  commitInput: CommitGitMemoryTaskRunInput;
  conversation: GitMemoryConversationRecord[];
  coveredToSeq: number;
  previousCoveredUntilSeq?: number;
  previousSummary?: ContextSessionSummary;
  knownTaskIds?: string[];
  knownRunIds?: string[];
}

export interface PreparedTaskRunFinalization {
  commitInput: CommitGitMemoryTaskRunInput;
  plan: TaskRunCheckpointPlan;
  previousSummary?: ContextSessionSummary;
  structuredContext: DeterministicTaskRunCheckpointContext;
  knownTaskIds: string[];
  knownRunIds: string[];
}

export type ResolvedTaskRunSessionUpdate =
  | {
      status: "ready";
      checkpoint: TaskRunCheckpoint;
      strategy: "llm" | "deterministic";
      summaryMarkdown?: string;
      errors: string[];
    }
  | {
      status: "unavailable";
      errors: string[];
    };

export class ProviderTaskRunSessionUpdateGenerator implements TaskRunSessionUpdateGenerator {
  private readonly cache: TaskRunSessionUpdateCacheState;

  constructor(private readonly options: ProviderTaskRunSessionUpdateGeneratorOptions) {
    this.cache = options.cache ?? createTaskRunSessionUpdateCache();
  }

  async generate(input: TaskRunSessionUpdateGeneratorInput): Promise<TaskRunSessionUpdateGenerationResult> {
    return await generateTaskRunSessionUpdate({
      provider: this.options.provider,
      plan: input.plan,
      previousSummary: input.previousSummary,
      structuredContext: input.structuredContext,
      knownTaskIds: input.knownTaskIds,
      knownRunIds: input.knownRunIds,
      cache: this.cache,
      maxGeneratorInputTokens: this.options.maxGeneratorInputTokens,
      maxSnapshotTokens: this.options.maxSnapshotTokens,
    });
  }
}

export function prepareTaskRunFinalization(
  input: PrepareTaskRunFinalizationInput,
): PreparedTaskRunFinalization {
  const runId = input.commitInput.runId ?? "";
  const structuredContext: DeterministicTaskRunCheckpointContext = {
    decisions: cleanStrings(input.commitInput.decisions),
    importantFacts: cleanStrings([
      ...(input.commitInput.newFacts ?? []),
      ...(input.commitInput.state?.facts ?? []),
    ]),
    references: cleanStrings([
      ...(input.commitInput.changedFiles ?? []),
      ...(input.commitInput.assets ?? []).flatMap((asset) => [asset.path, asset.name]),
    ]),
  };
  return {
    commitInput: structuredClone(input.commitInput),
    plan: planTaskRunCheckpoint({
      sessionId: input.commitInput.sessionId,
      run: {
        runClass: "task",
        taskId: input.commitInput.taskId,
        runId,
        status: input.commitInput.status,
        summary: input.commitInput.summary,
        outcome: input.commitInput.outcome,
        completed: input.commitInput.state?.completed ?? input.commitInput.workPerformed,
        open: input.commitInput.state?.open,
        blockers: input.commitInput.state?.blockers ?? input.commitInput.blockers,
        next: input.commitInput.state?.next ?? input.commitInput.next,
      },
      conversation: input.conversation,
      coveredToSeq: input.coveredToSeq,
      previousCoveredUntilSeq: input.previousCoveredUntilSeq,
    }),
    previousSummary: input.previousSummary,
    structuredContext,
    knownTaskIds: sortedUnique([...(input.knownTaskIds ?? []), input.commitInput.taskId]),
    knownRunIds: sortedUnique([...(input.knownRunIds ?? []), runId]),
  };
}

export async function resolveTaskRunSessionUpdate(
  prepared: PreparedTaskRunFinalization,
  generator?: TaskRunSessionUpdateGenerator,
): Promise<ResolvedTaskRunSessionUpdate> {
  if (generator) {
    try {
      const generated = await generator.generate({
        plan: prepared.plan,
        previousSummary: prepared.previousSummary,
        structuredContext: prepared.structuredContext,
        knownTaskIds: prepared.knownTaskIds,
        knownRunIds: prepared.knownRunIds,
      });
      if (generated.status === "success") {
        return {
          status: "ready",
          checkpoint: generated.checkpoint,
          strategy: "llm",
          summaryMarkdown: generated.summaryMarkdown,
          errors: [],
        };
      }
      if (generated.status === "fallback") {
        return {
          status: "ready",
          checkpoint: generated.checkpoint,
          strategy: "deterministic",
          errors: generated.errors,
        };
      }
      return { status: "unavailable", errors: generated.errors };
    } catch (error) {
      const fallback = deterministicUpdate(prepared);
      if (fallback.status === "ready") {
        return {
          ...fallback,
          errors: [errorMessage(error), ...fallback.errors],
        };
      }
      return {
        status: "unavailable",
        errors: [errorMessage(error), ...fallback.errors],
      };
    }
  }
  return deterministicUpdate(prepared);
}

export function taskRunFinalizationSourceIsCurrent(
  prepared: PreparedTaskRunFinalization,
  conversation: GitMemoryConversationRecord[],
): boolean {
  if (prepared.plan.status !== "ready") {
    return false;
  }
  const plan = prepared.plan;
  const source = conversation.filter((record) => (
    record.seq >= plan.coverage.fromSeq
    && record.seq <= plan.coverage.toSeq
  ));
  return hashTaskRunCheckpointSource(source) === plan.coverage.sourceHash;
}

export function renderTaskRunCheckpointCommitMessage(
  checkpoint: TaskRunCheckpoint,
  strategy: "llm" | "deterministic",
  at: string,
): string {
  const interval = checkpoint.sessionInterval;
  const notes = [
    ...renderStatements("User request", interval.userRequests),
    ...renderStatements("Assistant commitment", interval.assistantCommitments),
    ...renderStatements("Decision", interval.decisions),
    ...renderStatements("Correction", interval.corrections),
    ...renderStatements("Constraint", interval.constraints),
    ...renderStatements("Important fact", interval.importantFacts),
    ...renderStatements("Unresolved question", interval.unresolvedQuestions),
    ...renderStatements("Reference", interval.references),
    ...checkpoint.recentExactConversation.map((record) => (
      `Exact conversation ${record.seq} (${record.role}): ${record.text ?? record.contentRef ?? "[empty]"}`
    )),
    ...(checkpoint.pendingUserInput
      ? [`Pending user input ${checkpoint.pendingUserInput.sourceSeq}: ${checkpoint.pendingUserInput.question}`]
      : []),
  ];
  return renderGitMemoryCommitMessage({
    subject: `ayati: checkpoint task run ${checkpoint.run.runId}`,
    summary: `Session interval: ${interval.summary}`,
    outcome: checkpoint.run.outcome ? `Task-run outcome: ${checkpoint.run.outcome}` : undefined,
    completed: checkpoint.run.completed,
    open: checkpoint.run.open,
    next: checkpoint.run.next,
    notes,
    trailers: {
      sessionId: checkpoint.sessionId,
      taskId: checkpoint.run.taskId,
      runId: checkpoint.run.runId,
      event: "task_run_checkpointed",
      status: checkpoint.run.status,
      at,
      conversationSeq: {
        fromSeq: checkpoint.coverage.fromSeq,
        toSeq: checkpoint.coverage.toSeq,
      },
      schemaVersion: 1,
      extras: {
        "Checkpoint-Id": checkpoint.checkpointId,
        "Checkpoint-Source-Hash": checkpoint.coverage.sourceHash,
        "Checkpoint-Strategy": strategy,
      },
    },
  });
}

function deterministicUpdate(prepared: PreparedTaskRunFinalization): ResolvedTaskRunSessionUpdate {
  const generated = generateDeterministicTaskRunCheckpoint({
    plan: prepared.plan,
    context: prepared.structuredContext,
  });
  if (generated.status === "failed") {
    return { status: "unavailable", errors: generated.errors };
  }
  return {
    status: "ready",
    checkpoint: generated.checkpoint,
    strategy: "deterministic",
    errors: [],
  };
}

function renderStatements(label: string, values: Array<{ seq: number; text: string }>): string[] {
  return values.map((value) => `${label} ${value.seq}: ${value.text}`);
}

function cleanStrings(values: Array<string | null | undefined> | undefined): string[] {
  return sortedUnique((values ?? []).map((value) => value?.trim() ?? "").filter(Boolean));
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
