import type {
  FinalizeTaskRunRequest,
  FinalizeTaskRunResponse,
  SessionRef,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import {
  beginRecoverableIdempotent,
  completeRecoverableIdempotent,
  markRecoverableIdempotencyFailed,
} from "../database/idempotency.js";
import { materializeTaskConversationWindow } from "../conversations/conversation-synchronizer.js";
import { GitContextServiceError } from "../errors.js";
import { commitTaskRunSession } from "../git/session-finalization.js";
import {
  createTaskFinalizationCommit,
  persistTaskFinalization,
} from "../git/task-finalization.js";
import { stageTaskGitlink } from "../git/task-submodule.js";
import {
  closeTaskConversationWithAssistant,
  markPendingConversationsCommitted,
  readConversation,
  readConversationContentHash,
} from "../repositories/conversation-records.js";
import {
  readTaskHeadRange,
  readUncheckpointedMutationStatus,
} from "../repositories/run-evidence-records.js";
import {
  completeTaskRun,
  readRunEvidence,
  readRunStepEvidence,
} from "../repositories/run-records.js";
import {
  readRunWorkState,
  replaceRunWorkState,
} from "../repositories/run-work-state-records.js";
import { updateSessionHead } from "../repositories/session-records.js";
import { readTaskMount, updateTaskMountHead } from "../repositories/task-mount-records.js";
import { readTaskInitialization, updateTaskHead } from "../repositories/task-records.js";
import {
  insertTaskRunFinalization,
  readTaskRunFinalization,
  updateTaskRunFinalization,
  type TaskRunFinalizationRecord,
} from "../repositories/task-run-finalization-records.js";
import {
  taskRunEvidencePaths,
  writeAndStageRunEvidence,
} from "../runs/run-evidence-files.js";
import { renderRunEvidence, renderStepEvidence } from "../runs/run-evidence-renderer.js";
import { SimpleTaskFinalizationService } from "./simple-task-finalization-service.js";

export class TaskRunFinalizationService {
  private readonly simpleTaskFinalization?: SimpleTaskFinalizationService;

  constructor(
    private readonly database: ContextDatabase,
    taskRoot?: string,
  ) {
    this.simpleTaskFinalization = taskRoot
      ? new SimpleTaskFinalizationService({ database, taskRoot })
      : undefined;
  }

  async finalize(
    input: FinalizeTaskRunRequest,
    session: SessionRef,
  ): Promise<FinalizeTaskRunResponse> {
    const layoutTask = readTaskInitialization(this.database, input.taskId);
    if (layoutTask?.layoutVersion === "simple_repository_v1") {
      if (!this.simpleTaskFinalization) {
        throw new GitContextServiceError({
          code: "SERVICE_NOT_READY",
          message: "V1 finalization requires the configured task root.",
        });
      }
      return await this.simpleTaskFinalization.finalize(input, session);
    }
    const existing = readTaskRunFinalization(this.database, input.runId);
    const run = readRunEvidence(this.database, input.runId);
    if (!run || run.sessionId !== input.sessionId || run.taskId !== input.taskId
      || run.runClass !== "task" || (!existing && run.status !== "running")) {
      throw new GitContextServiceError({
        code: "RUN_NOT_ACTIVE",
        message: "Task-run finalization requires the matching active task run.",
        details: { sessionId: input.sessionId, runId: input.runId, taskId: input.taskId },
      });
    }
    if (!session.head) {
      throw new GitContextServiceError({
        code: "REPOSITORY_UNAVAILABLE",
        message: "Session repository has no durable HEAD.",
      });
    }
    if (!existing && input.expectedHead && input.expectedHead !== session.head) {
      throw new GitContextServiceError({
        code: "SESSION_HEAD_MISMATCH",
        message: "Session HEAD does not match the task-run finalization expectation.",
        retryable: true,
        details: { expectedHead: input.expectedHead, actualHead: session.head },
      });
    }
    const sessionHead = session.head;
    const task = readTaskInitialization(this.database, input.taskId);
    const mount = readTaskMount(this.database, input.sessionId, input.taskId);
    if (!task?.head || !mount?.mountedHead || mount.status !== "ready") {
      throw new GitContextServiceError({
        code: "RECOVERY_REQUIRED",
        message: "Task-run finalization is missing durable task checkout state.",
        details: { runId: input.runId, taskId: input.taskId },
      });
    }
    const headRange = readTaskHeadRange(this.database, run.runId)
      ?? { before: task.head, after: task.head };
    const taskCheckpointHead = task.head;
    const uncheckpointed = readUncheckpointedMutationStatus(this.database, input.runId);
    if (uncheckpointed) {
      throw new GitContextServiceError({
        code: "RECOVERY_REQUIRED",
        message: "Task run contains uncheckpointed mutation state.",
        details: { runId: input.runId, mutationStatus: uncheckpointed },
      });
    }
    type Pending = { runId: string } | FinalizeTaskRunResponse;
    const pending = beginRecoverableIdempotent<Pending>({
      database: this.database,
      requestId: input.requestId,
      operation: "finalize_task_run",
      payload: input,
      now: input.at,
      execute: () => {
        if (!existing) {
          insertTaskRunFinalization(this.database, {
            runId: run.runId,
            requestId: input.requestId,
            sessionId: input.sessionId,
            taskId: input.taskId,
            conversationId: run.conversationId,
            outcome: input.outcome,
            conversationSummary: normalize(input.conversationSummary),
            summary: normalize(input.summary),
            validation: input.validation,
            ...(input.next ? { next: normalize(input.next) } : {}),
            completion: input.completion,
            assistantResponse: input.assistantResponse,
            sessionHeadBefore: sessionHead,
            taskHeadBefore: headRange.before,
            taskCheckpointHead,
            at: input.at,
          });
          closeTaskConversationWithAssistant(this.database, {
            requestId: input.requestId,
            sessionId: input.sessionId,
            conversationId: run.conversationId,
            runId: run.runId,
            taskId: input.taskId,
            content: input.assistantResponse,
            at: input.at,
          });
          updateTaskRunFinalization(this.database, {
            runId: run.runId,
            phase: "conversation_closed",
            at: input.at,
          });
        }
        return { runId: run.runId };
      },
    });
    if (pending.completed && "sessionCommit" in pending.result) return pending.result;
    const completedRecord = requireFinalization(this.database, run.runId);
    if (completedRecord.phase === "completed"
      && completedRecord.taskFinalizationHead
      && completedRecord.sessionCommit) {
      return completeRecoverableIdempotent({
        database: this.database,
        requestId: input.requestId,
        result: finalizationResponse(
          completedRecord,
          completedRecord.taskFinalizationHead,
          completedRecord.sessionCommit,
        ),
        now: input.at,
      });
    }

    try {
      await materializeTaskConversationWindow({
        database: this.database,
        sessionId: completedRecord.sessionId,
        taskId: input.taskId,
        runId: input.runId,
        targetConversationId: run.conversationId,
        previousSessionHead: completedRecord.sessionHeadBefore,
      });
      let record = requireFinalization(this.database, run.runId);
      const conversationHash = readConversationContentHash(this.database, run.conversationId);
      if (!conversationHash) throw new Error("Final task conversation has no content hash.");
      if (!record.conversationHash) {
        record = updateTaskRunFinalization(this.database, {
          runId: run.runId,
          phase: "conversation_closed",
          conversationHash,
          at: input.at,
        });
      }
      const taskFinalizationHead = await this.finalizeTask(record, task, mount, input.at);
      record = requireFinalization(this.database, run.runId);
      await this.persistTask(record, task, mount, taskFinalizationHead, input.at);
      record = requireFinalization(this.database, run.runId);
      const sessionCommit = await this.finalizeSession(
        record, run, session, task, taskFinalizationHead, input.at,
      );
      const response = finalizationResponse(record, taskFinalizationHead, sessionCommit);
      this.database.transaction(() => {
        persistFinalWorkState(this.database, run.runId, run.stepCount, record, input.at);
        completeTaskRun(this.database, { runId: run.runId, outcome: record.outcome, at: input.at });
        markPendingConversationsCommitted(this.database, session.sessionId, sessionCommit);
        updateSessionHead(this.database, session.sessionId, sessionCommit);
        updateTaskRunFinalization(this.database, {
          runId: run.runId,
          phase: "completed",
          sessionCommit,
          at: input.at,
        });
      });
      return completeRecoverableIdempotent({
        database: this.database,
        requestId: input.requestId,
        result: response,
        now: input.at,
      });
    } catch (error) {
      markRecoverableIdempotencyFailed({ database: this.database, requestId: input.requestId });
      throw error;
    }
  }

  async recoverSimpleTaskFinalizations(at: string): Promise<void> {
    await this.simpleTaskFinalization?.recoverCommittedFinalizations(at);
  }

  private async finalizeTask(
    record: TaskRunFinalizationRecord,
    task: NonNullable<ReturnType<typeof readTaskInitialization>>,
    mount: NonNullable<ReturnType<typeof readTaskMount>>,
    at: string,
  ): Promise<string> {
    if (record.taskFinalizationHead) return record.taskFinalizationHead;
    if (!record.conversationHash) throw new Error("Conversation hash is unavailable.");
    const head = await createTaskFinalizationCommit({
      checkoutPath: mount.workingPath,
      canonicalRepository: task.repositoryPath,
      branch: task.branch,
      taskId: task.taskId,
      taskTitle: task.title,
      sessionId: record.sessionId,
      runId: record.runId,
      conversationId: record.conversationId,
      conversationHash: record.conversationHash,
      checkpointHead: record.taskCheckpointHead,
      outcome: record.outcome,
      validation: record.validation,
      summary: record.summary,
      ...(record.next ? { next: record.next } : {}),
      at,
    });
    updateTaskRunFinalization(this.database, {
      runId: record.runId, phase: "task_finalized", taskFinalizationHead: head, at,
    });
    return head;
  }

  private async persistTask(
    record: TaskRunFinalizationRecord,
    task: NonNullable<ReturnType<typeof readTaskInitialization>>,
    mount: NonNullable<ReturnType<typeof readTaskMount>>,
    head: string,
    at: string,
  ): Promise<void> {
    if (["task_persisted", "session_staged", "session_committed", "completed"].includes(record.phase)) return;
    await persistTaskFinalization({
      checkoutPath: mount.workingPath,
      canonicalRepository: task.repositoryPath,
      branch: task.branch,
      finalizationHead: head,
    });
    await stageTaskGitlink({
      sessionRepository: readSessionPath(this.database, record.sessionId),
      taskId: record.taskId,
      checkpointHead: head,
    });
    this.database.transaction(() => {
      updateTaskHead(this.database, record.taskId, record.taskCheckpointHead, head, at);
      updateTaskMountHead(
        this.database, record.sessionId, record.taskId, record.taskCheckpointHead, head, at,
      );
      updateTaskRunFinalization(this.database, {
        runId: record.runId, phase: "task_persisted", taskFinalizationHead: head, at,
      });
    });
  }

  private async finalizeSession(
    record: TaskRunFinalizationRecord,
    run: NonNullable<ReturnType<typeof readRunEvidence>>,
    session: SessionRef,
    task: NonNullable<ReturnType<typeof readTaskInitialization>>,
    taskHead: string,
    at: string,
  ): Promise<string> {
    if (record.sessionCommit) return record.sessionCommit;
    const steps = readRunStepEvidence(this.database, run.runId);
    const paths = taskRunEvidencePaths(session.repositoryPath, run.runId);
    await writeAndStageRunEvidence({
      sessionRepository: session.repositoryPath,
      runFile: paths.runFile,
      stepsFile: paths.stepsFile,
      runContent: renderRunEvidence({
        run,
        taskHeadBefore: record.taskHeadBefore,
        taskHeadAfter: taskHead,
        stepCount: steps.length,
        snapshotAt: at,
        final: {
          outcome: record.outcome,
          summary: record.summary,
          validation: record.validation,
          ...(record.next ? { next: record.next } : {}),
          completion: record.completion,
          completedAt: at,
        },
      }),
      stepsContent: renderStepEvidence(steps),
      expectedSessionHead: record.sessionHeadBefore,
    });
    const conversation = readConversation(this.database, record.conversationId);
    if (!conversation) throw new Error("Final task conversation is missing.");
    const commitPaths = [
      ".gitmodules",
      "tasks/" + record.taskId,
      paths.runRelative,
      paths.stepsRelative,
      conversation.filePath,
    ];
    updateTaskRunFinalization(this.database, {
      runId: run.runId, phase: "session_staged", at,
    });
    const commit = await commitTaskRunSession({
      repositoryPath: session.repositoryPath,
      sessionId: session.sessionId,
      conversationId: run.conversationId,
      taskId: record.taskId,
      workingDirectory: task.workingPath,
      runId: run.runId,
      outcome: record.outcome,
      validation: record.validation,
      conversationSummary: record.conversationSummary,
      workSummary: record.summary,
      assets: record.completion.assets,
      taskHeadBefore: record.taskHeadBefore,
      taskHeadAfter: taskHead,
      expectedSessionHead: record.sessionHeadBefore,
      paths: commitPaths,
      at,
    });
    updateTaskRunFinalization(this.database, {
      runId: run.runId, phase: "session_committed", sessionCommit: commit, at,
    });
    return commit;
  }
}

function persistFinalWorkState(
  database: ContextDatabase,
  runId: string,
  afterStep: number,
  record: TaskRunFinalizationRecord,
  at: string,
): void {
  const current = readRunWorkState(database, runId);
  if (!current) throw new Error("Run WorkState is missing: " + runId);
  const done = record.outcome === "done";
  const blocked = record.outcome === "blocked";
  const needsUserInput = record.outcome === "needs_user_input";
  const completionWork = uniqueStrings([
    ...record.completion.missing,
    ...record.completion.failures,
  ]);
  replaceRunWorkState(database, {
    runId,
    afterStep,
    state: {
      status: done
        ? "done"
        : blocked
          ? "blocked"
          : needsUserInput
            ? "needs_user_input"
            : "not_done",
      summary: record.summary,
      openWork: done ? [] : uniqueStrings([...current.openWork, ...completionWork]),
      blockers: blocked
        ? uniqueStrings([...current.blockers, ...record.completion.failures])
        : [],
      facts: current.facts,
      evidence: current.evidence,
      artifacts: uniqueStrings([
        ...current.artifacts,
        ...record.completion.assets.filter((asset) => asset.verified).map((asset) => asset.path),
      ]),
      nextStep: done ? null : record.next ?? current.nextStep,
      userInputNeeded: needsUserInput ? current.userInputNeeded : [],
    },
    at,
  });
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function requireFinalization(database: ContextDatabase, runId: string): TaskRunFinalizationRecord {
  const record = readTaskRunFinalization(database, runId);
  if (!record) throw new Error("Task-run finalization record is missing: " + runId);
  return record;
}

function readSessionPath(database: ContextDatabase, sessionId: string): string {
  const row = database.prepare("SELECT repository_path FROM sessions WHERE session_id = ?")
    .get(sessionId) as { repository_path: string } | undefined;
  if (!row) throw new Error("Task-run session is missing: " + sessionId);
  return row.repository_path;
}

function finalizationResponse(
  record: TaskRunFinalizationRecord,
  taskHead: string,
  sessionCommit: string,
): FinalizeTaskRunResponse {
  if (!record.conversationHash) throw new Error("Final conversation hash is missing.");
  return {
    runId: record.runId,
    taskId: record.taskId,
    outcome: record.outcome,
    taskHeadBefore: record.taskHeadBefore,
    taskHeadAfter: taskHead,
    taskFinalizationCommit: taskHead,
    sessionCommit,
    conversationHash: record.conversationHash,
    runFile: "runs/" + record.runId + "/run.json",
    stepsFile: "runs/" + record.runId + "/steps.jsonl",
  };
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}
