import {
  buildGitMemoryTaskRunCommitInput,
  type BuildGitMemoryTaskRunCommitInput,
} from "./harness-result-mapper.js";
import type {
  CommitGitMemoryTaskRunResult,
} from "./session-store.js";
import { GitMemoryDailySessionStore } from "./session-store.js";
import {
  prepareTaskRunFinalization,
  resolveTaskRunSessionUpdate,
  taskRunFinalizationSourceIsCurrent,
  type PreparedTaskRunFinalization,
  type ResolvedTaskRunSessionUpdate,
  type TaskRunSessionUpdateGenerator,
} from "./task-run-finalization.js";
import type {
  GitMemoryConversationRecord,
  GitMemoryRunId,
  GitMemoryTaskId,
} from "./schema.js";
import type { GitMemoryWriteQueueRunner } from "./write-queue.js";

export interface FinalizeGitMemoryTaskRunInput extends BuildGitMemoryTaskRunCommitInput {
  assistantMessage?: string;
  assistantMessageKind?: GitMemoryConversationRecord["kind"];
  assistantAt?: string;
}

export interface FinalizeGitMemoryTaskRunResult extends CommitGitMemoryTaskRunResult {
  alreadyFinalized: boolean;
  requestedRunStatus?: CommitGitMemoryTaskRunResult["runStatus"];
  assistantMessage?: GitMemoryConversationRecord;
}

export interface GitMemoryTaskRunFinalizerOptions {
  store: GitMemoryDailySessionStore;
  writeQueue: GitMemoryWriteQueueRunner;
  sessionUpdateGenerator?: TaskRunSessionUpdateGenerator;
}

export class GitMemoryTaskRunFinalizer {
  constructor(private readonly options: GitMemoryTaskRunFinalizerOptions) {}

  async finalize(input: FinalizeGitMemoryTaskRunInput): Promise<FinalizeGitMemoryTaskRunResult> {
    const baseCommitInput = buildGitMemoryTaskRunCommitInput(input);
    const preparation = await this.options.writeQueue.enqueue({
      sessionId: baseCommitInput.sessionId,
      type: "task_run_committed",
      label: "prepare_task_run_finalization",
      createdAt: baseCommitInput.completedAt,
    }, async () => {
      const existing = await this.readExistingRun(baseCommitInput);
      if (existing) {
        return {
          status: "already_finalized" as const,
          result: existing,
          requestedRunStatus: baseCommitInput.status,
        };
      }
      const currentConversation = await this.options.store.readSessionConversationRecords(baseCommitInput.sessionId);
      const assistantMessage = await this.appendOrReuseAssistantMessage(input, currentConversation);
      const commitInput = assistantMessage
        ? {
            ...baseCommitInput,
            conversationRefs: includeConversationRecordInRefs(baseCommitInput.conversationRefs, assistantMessage),
          }
        : baseCommitInput;
      const [conversation, previousSummary, previousBoundary, routing] = await Promise.all([
        this.options.store.readSessionConversationRecords(commitInput.sessionId),
        this.options.store.readSessionSummary(commitInput.sessionId),
        this.options.store.readLatestTaskRunCheckpointBoundary(commitInput.sessionId),
        this.options.store.readTaskRoutingSnapshot(commitInput.sessionId),
      ]);
      return {
        status: "prepared" as const,
        assistantMessage,
        prepared: prepareTaskRunFinalization({
          commitInput,
          conversation,
          coveredToSeq: assistantMessage?.seq
            ?? Math.max(0, ...commitInput.conversationRefs.map((ref) => ref.toSeq)),
          previousCoveredUntilSeq: previousBoundary?.coveredUntilSeq,
          previousSummary,
          knownTaskIds: routing.tasks.map((task) => task.taskId),
          knownRunIds: commitInput.runId ? [commitInput.runId] : [],
        }),
      };
    });
    if (preparation.status === "already_finalized") {
      return {
        ...preparation.result,
        alreadyFinalized: true,
        requestedRunStatus: preparation.requestedRunStatus,
      };
    }

    const sessionUpdate = await resolveTaskRunSessionUpdate(
      preparation.prepared,
      this.options.sessionUpdateGenerator,
    );
    return await this.commitPrepared(preparation, sessionUpdate);
  }

  private async commitPrepared(
    preparation: {
      status: "prepared";
      assistantMessage?: GitMemoryConversationRecord;
      prepared: PreparedTaskRunFinalization;
    },
    sessionUpdate: ResolvedTaskRunSessionUpdate,
  ): Promise<FinalizeGitMemoryTaskRunResult> {
    const commitInput = preparation.prepared.commitInput;
    return await this.options.writeQueue.enqueue({
      sessionId: commitInput.sessionId,
      type: "task_run_committed",
      label: "commit_prepared_task_run",
      createdAt: commitInput.completedAt,
    }, async () => {
      const existing = await this.readExistingRun(commitInput);
      if (existing) {
        return {
          ...existing,
          alreadyFinalized: true,
          requestedRunStatus: commitInput.status,
        };
      }
      if (
        sessionUpdate.status === "ready"
        && !taskRunFinalizationSourceIsCurrent(
          preparation.prepared,
          await this.options.store.readSessionConversationRecords(commitInput.sessionId),
        )
      ) {
        throw new Error(`Task-run finalization source changed before commit: ${commitInput.runId ?? "unknown"}`);
      }
      const snapshot = await this.options.store.commitSessionStoreSnapshot({
        sessionId: commitInput.sessionId,
        at: commitInput.completedAt,
        summary: `Snapshot conversation for task run ${commitInput.runId ?? "unknown"}.`,
        ...(sessionUpdate.status === "ready" ? {
          taskRunCheckpoint: {
            checkpoint: sessionUpdate.checkpoint,
            strategy: sessionUpdate.strategy,
          },
        } : {}),
        ...(sessionUpdate.status === "ready" && sessionUpdate.summaryMarkdown ? {
          sessionSummary: buildFinalizationSessionSummary(
            preparation.prepared,
            sessionUpdate,
            sessionUpdate.summaryMarkdown,
          ),
        } : {}),
      });
      const result = await this.options.store.commitTaskRun({
        ...commitInput,
        sessionStoreCommit: snapshot.sessionStoreCommit,
      });
      return {
        ...result,
        alreadyFinalized: false,
        requestedRunStatus: commitInput.status,
        ...(preparation.assistantMessage ? { assistantMessage: preparation.assistantMessage } : {}),
      };
    });
  }

  private async readExistingRun(input: {
    sessionId: string;
    taskId: string;
    runId?: string;
  }): Promise<CommitGitMemoryTaskRunResult | null> {
    return input.runId
      ? await this.options.store.readCommittedTaskRun({
          sessionId: input.sessionId,
          taskId: input.taskId,
          runId: input.runId,
        })
      : null;
  }

  private async appendOrReuseAssistantMessage(
    input: FinalizeGitMemoryTaskRunInput,
    records: GitMemoryConversationRecord[],
  ): Promise<GitMemoryConversationRecord | undefined> {
    if (!input.assistantMessage?.trim()) {
      return undefined;
    }
    return findTaskRunAssistantMessage(records, input.taskId, input.runId, input.assistantMessage)
      ?? await this.options.store.appendConversationMessage({
        sessionId: input.sessionId,
        text: input.assistantMessage,
        ...(input.assistantMessageKind ? { kind: input.assistantMessageKind } : {}),
        at: input.assistantAt ?? input.at,
        taskId: input.taskId,
        ...(input.runId ? { runId: input.runId } : {}),
        role: "assistant",
      });
  }
}

function includeConversationRecordInRefs(
  refs: Array<{ fromSeq: number; toSeq: number }>,
  record: GitMemoryConversationRecord,
): Array<{ fromSeq: number; toSeq: number }> {
  if (refs.length === 0) {
    return [{ fromSeq: record.seq, toSeq: record.seq }];
  }
  const next = refs.map((ref) => ({ ...ref }));
  const containing = next.find((ref) => record.seq >= ref.fromSeq && record.seq <= ref.toSeq);
  if (containing) {
    return next;
  }
  const last = next[next.length - 1]!;
  if (record.seq >= last.fromSeq) {
    last.toSeq = Math.max(last.toSeq, record.seq);
    return next;
  }
  next.push({ fromSeq: record.seq, toSeq: record.seq });
  return next.sort((left, right) => left.fromSeq - right.fromSeq);
}

function findTaskRunAssistantMessage(
  records: GitMemoryConversationRecord[],
  taskId: GitMemoryTaskId,
  runId: GitMemoryRunId | undefined,
  text: string,
): GitMemoryConversationRecord | undefined {
  return [...records].reverse().find((record) => (
    record.role === "assistant"
    && record.taskId === taskId
    && (!runId || record.runId === runId)
    && record.text === text
  ));
}

function buildFinalizationSessionSummary(
  prepared: PreparedTaskRunFinalization,
  update: Extract<ResolvedTaskRunSessionUpdate, { status: "ready" }>,
  text: string,
) {
  return {
    text,
    strategy: update.strategy,
    coveredUntilSeq: update.checkpoint.coverage.toSeq,
    messageCount: update.checkpoint.coverage.sourceEventCount,
    sourceFromSeq: update.checkpoint.coverage.fromSeq,
    sourceToSeq: update.checkpoint.coverage.toSeq,
    ...(typeof prepared.previousSummary?.coveredUntilSeq === "number"
      ? { previousCoveredUntilSeq: prepared.previousSummary.coveredUntilSeq }
      : {}),
  };
}
