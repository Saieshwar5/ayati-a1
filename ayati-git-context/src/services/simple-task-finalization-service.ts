import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  FinalizeTaskRunRequest,
  FinalizeTaskRunResponse,
  MutationProvenance,
  SessionRef,
  TaskRunOutcome,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import {
  beginRecoverableIdempotent,
  completeRecoverableIdempotent,
  markRecoverableIdempotencyFailed,
} from "../database/idempotency.js";
import { GitContextServiceError } from "../errors.js";
import { checkpointPaths, assertCheckpointablePaths } from "../git/task-checkpoint.js";
import { readMutationProvenance } from "../git/mutation-provenance.js";
import {
  commitSimpleTaskPlan,
  contentHash,
  recognizeCommittedSimpleTaskPlan,
  readSimpleTaskMutationState,
} from "../git/simple-task-repository-transaction.js";
import { conversationContentHash, renderConversation } from "../conversations/conversation-renderer.js";
import {
  closeTaskConversationWithAssistant,
  readConversationMessages,
  updateConversationContentHash,
} from "../repositories/conversation-records.js";
import {
  readMutationAuthorityForRun,
  releaseVerifiedMutationAuthority,
  type MutationAuthorityRecord,
} from "../repositories/mutation-authority-records.js";
import {
  completeTaskRun,
  readRunEvidence,
} from "../repositories/run-records.js";
import {
  readRunWorkState,
  replaceRunWorkState,
} from "../repositories/run-work-state-records.js";
import {
  insertSimpleTaskFinalization,
  readRecoverableSimpleTaskFinalizations,
  readSimpleTaskFinalization,
  updateSimpleTaskFinalization,
  type SimpleTaskCommitPlan,
  type SimpleTaskFinalizationRecord,
} from "../repositories/simple-task-finalization-records.js";
import {
  readTaskInitialization,
  updateTaskHead,
} from "../repositories/task-records.js";
import { renderTaskRunCommit, type TaskRunCommitOutcome } from "../tasks/task-commit-metadata.js";
import { reduceSimpleTaskContext } from "../tasks/simple-task-context-reducer.js";
import { validateTaskRepository } from "../tasks/task-repository-validator.js";

export type SimpleTaskFinalizationHook = (
  phase: "plan_persisted" | "commit_created",
  record: SimpleTaskFinalizationRecord,
) => void | Promise<void>;

export class SimpleTaskFinalizationService {
  constructor(private readonly options: {
    database: ContextDatabase;
    taskRoot: string;
    hook?: SimpleTaskFinalizationHook;
  }) {}

  async finalize(
    input: FinalizeTaskRunRequest,
    session: SessionRef,
  ): Promise<FinalizeTaskRunResponse> {
    const existing = readSimpleTaskFinalization(this.options.database, input.runId);
    if (existing) {
      assertMatchingRetry(existing, input);
      const pending = beginRecoverableIdempotent<FinalizeTaskRunResponse | { runId: string }>({
        database: this.options.database,
        requestId: input.requestId,
        operation: "finalize_task_run",
        payload: input,
        now: input.at,
        execute: () => ({ runId: input.runId }),
      });
      if (pending.completed && "taskHeadAfter" in pending.result) return pending.result;
      if (existing.phase === "completed" && existing.commitHead) {
        return completeRecoverableIdempotent({
          database: this.options.database,
          requestId: input.requestId,
          result: response(existing, existing.commitHead),
          now: input.at,
        });
      }
      return await this.execute(existing, input);
    }

    const prepared = await this.prepare(input, session);
    const pending = beginRecoverableIdempotent<FinalizeTaskRunResponse | { runId: string }>({
      database: this.options.database,
      requestId: input.requestId,
      operation: "finalize_task_run",
      payload: input,
      now: input.at,
      execute: () => {
        const conversation = closeTaskConversationWithAssistant(this.options.database, {
          requestId: input.requestId,
          sessionId: input.sessionId,
          conversationId: prepared.run.conversationId,
          runId: input.runId,
          taskId: input.taskId,
          content: input.assistantResponse,
          at: input.at,
        });
        const conversationHash = conversationContentHash(renderConversation(
          conversation,
          readConversationMessages(this.options.database, conversation.conversationId),
        ));
        updateConversationContentHash(
          this.options.database,
          conversation.conversationId,
          conversationHash,
        );
        const plan: SimpleTaskCommitPlan = {
          ...prepared.plan,
          commitMessage: renderTaskRunCommit({
            subject: "finalize " + prepared.authority.taskRequestId!.toLowerCase() + " task run",
            taskId: input.taskId,
            requestId: prepared.authority.taskRequestId!,
            runId: input.runId,
            sessionId: input.sessionId,
            outcome: commitOutcome(input.outcome),
            validation: input.validation,
            ...(input.next ? { next: normalize(input.next) } : {}),
            conversationId: conversation.conversationId,
            conversationHash,
          }),
        };
        insertSimpleTaskFinalization(this.options.database, {
          runId: input.runId,
          requestId: input.requestId,
          authorityId: prepared.authority.authorityId,
          sessionId: input.sessionId,
          taskId: input.taskId,
          taskRequestId: prepared.authority.taskRequestId!,
          conversationId: conversation.conversationId,
          outcome: input.outcome,
          validation: input.validation,
          summary: prepared.finalSummary,
          ...(input.next ? { next: normalize(input.next) } : {}),
          completion: input.completion,
          assistantResponse: input.assistantResponse,
          baseHead: prepared.authority.beforeHead,
          conversationHash,
          plan,
          at: input.at,
        });
        return { runId: input.runId };
      },
    });
    if (pending.completed && "taskHeadAfter" in pending.result) return pending.result;
    const record = readSimpleTaskFinalization(this.options.database, input.runId);
    if (!record) throw new Error("Prepared V1 finalization could not be read.");
    await this.options.hook?.("plan_persisted", record);
    return await this.execute(record, input);
  }

  async recoverCommittedFinalizations(at: string): Promise<void> {
    for (const record of readRecoverableSimpleTaskFinalizations(this.options.database)) {
      const task = readTaskInitialization(this.options.database, record.taskId);
      if (!task?.head || task.layoutVersion !== "simple_repository_v1") continue;
      try {
        const head = await recognizeCommittedSimpleTaskPlan({
          repositoryPath: task.repositoryPath,
          branch: task.branch,
          baseHead: record.baseHead,
          plan: record.plan,
        });
        if (!head) continue;
        await this.validateCommittedContext(record, task.repositoryPath, head);
        this.acknowledge(record, { head, created: true }, at);
        const completed = readSimpleTaskFinalization(this.options.database, record.runId);
        if (!completed) throw new Error("Recovered V1 finalization journal is missing.");
        completeRecoverableIdempotent({
          database: this.options.database,
          requestId: record.requestId,
          result: response(completed, head),
          now: at,
        });
      } catch (error) {
        updateSimpleTaskFinalization(this.options.database, {
          runId: record.runId,
          phase: "recovery_required",
          error: error instanceof Error ? error.message : String(error),
          at,
        });
      }
    }
  }

  private async prepare(input: FinalizeTaskRunRequest, session: SessionRef) {
    const run = readRunEvidence(this.options.database, input.runId);
    if (!run || run.status !== "running" || run.runClass !== "task"
      || run.sessionId !== input.sessionId || run.taskId !== input.taskId) {
      throw invalid("V1 finalization requires the matching active task run.");
    }
    const task = readTaskInitialization(this.options.database, input.taskId);
    if (!task?.head || task.layoutVersion !== "simple_repository_v1") {
      throw invalid("V1 finalization requires an active simple task repository.");
    }
    const authority = readMutationAuthorityForRun(this.options.database, input.runId);
    if (!authority || authority.repositoryLayout !== "simple_repository_v1"
      || authority.sessionId !== input.sessionId || authority.taskId !== input.taskId
      || !authority.taskRequestId || run.taskRequestId !== authority.taskRequestId) {
      throw recovery("V1 finalization is missing matching task/request mutation authority.");
    }
    if (authority.status !== "verified"
      && !(authority.status === "released" && input.outcome === "failed")) {
      throw recovery("V1 finalization requires verified mutation state.", {
        authorityId: authority.authorityId,
        authorityStatus: authority.status,
      });
    }
    if (task.head !== authority.beforeHead) {
      throw headMismatch(input.taskId, authority.beforeHead, task.head);
    }
    const validation = await validateTaskRepository({
      taskRoot: this.options.taskRoot,
      repositoryPath: task.repositoryPath,
      expectedTaskId: input.taskId,
      requestReadMode: "current",
    });
    if (validation.head !== authority.beforeHead || validation.branch !== authority.branch) {
      throw headMismatch(input.taskId, authority.beforeHead, validation.head);
    }
    if (validation.currentRequest?.id !== authority.taskRequestId) {
      throw recovery("V1 finalization request no longer matches committed task context.");
    }
    const provenance = await readMutationProvenance(
      authority.repositoryPath,
      authority.targets,
      "head",
      {
        excludedPathPrefixes: [".ayati/inbox/"],
        includedPaths: [".ayati/inbox/.gitkeep"],
      },
    );
    const verifiedState = await requireExpectedProvenance(authority, provenance);
    const workState = readRunWorkState(this.options.database, input.runId);
    if (!workState) throw recovery("V1 finalization requires persisted WorkState.");
    const verifiedPaths = checkpointPaths(provenance);
    assertCheckpointablePaths(verifiedPaths);
    await verifyCompletionAssets(authority.repositoryPath, input.completion);
    const context = reduceSimpleTaskContext({
      taskCard: validation.taskCard,
      taskRequest: validation.currentRequest,
      workState,
      outcome: input.outcome,
      validation: input.validation,
      summary: input.summary,
      ...(input.next ? { next: input.next } : {}),
      completion: input.completion,
      hasVerifiedChanges: verifiedPaths.length > 0,
    });
    const stagedPaths = [...new Set([
      ...verifiedPaths,
      ...context.contextWrites.map((write) => write.path),
    ])].sort();
    const contextBefore = await Promise.all(context.contextWrites.map(async (write) => ({
      path: write.path,
      sha256: contentHash(await readFile(resolve(authority.repositoryPath, write.path), "utf8")),
    })));
    return {
      run,
      task,
      authority,
      plan: {
        commitRequired: context.commitRequired || verifiedPaths.length > 0,
        verifiedPaths,
        verifiedState,
        contextWrites: context.contextWrites,
        contextBefore,
        stagedPaths,
        commitMessage: "",
      },
      finalSummary: context.commitRequired
        ? context.taskCard.currentSnapshot
        : normalize(input.summary),
      session,
    };
  }

  private async execute(
    record: SimpleTaskFinalizationRecord,
    input: FinalizeTaskRunRequest,
  ): Promise<FinalizeTaskRunResponse> {
    const task = readTaskInitialization(this.options.database, record.taskId);
    if (!task?.head || task.layoutVersion !== "simple_repository_v1") {
      throw recovery("Journaled V1 task repository is unavailable.");
    }
    try {
      const committed = await commitSimpleTaskPlan({
        repositoryPath: task.repositoryPath,
        branch: task.branch,
        baseHead: record.baseHead,
        plan: record.plan,
        at: record.createdAt,
      });
      if (committed.created) await this.options.hook?.("commit_created", record);
      updateSimpleTaskFinalization(this.options.database, {
        runId: record.runId,
        phase: "committed",
        commitHead: committed.head,
        commitCreated: committed.created,
        at: input.at,
      });
      await this.validateCommittedContext(record, task.repositoryPath, committed.head);
      this.acknowledge(record, committed, input.at);
      const completed = readSimpleTaskFinalization(this.options.database, record.runId);
      if (!completed) throw new Error("Completed V1 finalization journal is missing.");
      const result = response(completed, committed.head);
      return completeRecoverableIdempotent({
        database: this.options.database,
        requestId: input.requestId,
        result,
        now: input.at,
      });
    } catch (error) {
      updateSimpleTaskFinalization(this.options.database, {
        runId: record.runId,
        phase: "recovery_required",
        error: error instanceof Error ? error.message : String(error),
        at: input.at,
      });
      markRecoverableIdempotencyFailed({
        database: this.options.database,
        requestId: input.requestId,
      });
      throw error;
    }
  }

  private async validateCommittedContext(
    record: SimpleTaskFinalizationRecord,
    repositoryPath: string,
    head: string,
  ): Promise<void> {
    if (!record.plan.commitRequired) return;
    const validation = await validateTaskRepository({
      taskRoot: this.options.taskRoot,
      repositoryPath,
      expectedTaskId: record.taskId,
      requestReadMode: "all",
    });
    if (validation.head !== head || validation.health !== "ready") {
      throw recovery("Committed V1 task repository did not validate cleanly.");
    }
    const request = validation.requests.find((entry) => entry.id === record.taskRequestId);
    if (!request) throw recovery("Committed V1 task request is missing.");
    if (record.outcome === "done" && request.status !== "done") {
      throw recovery("Completed V1 run did not persist a completed request.");
    }
    if ((record.outcome === "blocked" || record.outcome === "needs_user_input")
      && request.status !== "blocked") {
      throw recovery("Blocked V1 run did not persist a blocked request.");
    }
  }

  private acknowledge(
    record: SimpleTaskFinalizationRecord,
    commit: { head: string; created: boolean },
    at: string,
  ): void {
    this.options.database.transaction(() => {
      if (commit.created) {
        const task = readTaskInitialization(this.options.database, record.taskId);
        if (task?.head === record.baseHead) {
          updateTaskHead(this.options.database, record.taskId, record.baseHead, commit.head, at);
        } else if (task?.head !== commit.head) {
          throw new Error("V1 task catalog HEAD cannot acknowledge the finalization commit.");
        }
      }
      persistFinalWorkState(this.options.database, record, at);
      const run = readRunEvidence(this.options.database, record.runId);
      if (run?.status === "running") {
        completeTaskRun(this.options.database, {
          runId: record.runId,
          outcome: record.outcome,
          at,
        });
      }
      const authority = readMutationAuthorityForRun(this.options.database, record.runId);
      if (authority?.status === "verified") {
        releaseVerifiedMutationAuthority(
          this.options.database,
          authority.authorityId,
          at,
        );
      }
      updateSimpleTaskFinalization(this.options.database, {
        runId: record.runId,
        phase: "completed",
        commitHead: commit.head,
        commitCreated: commit.created,
        at,
      });
    });
  }
}

async function requireExpectedProvenance(
  authority: MutationAuthorityRecord,
  actual: MutationProvenance,
): Promise<string> {
  const verification = authority.verification as {
    provenance?: MutationProvenance;
    stateFingerprint?: string;
  } | undefined;
  const expected = verification?.provenance;
  if (authority.status === "released") {
    if (checkpointPaths(actual).length === 0) {
      return await readSimpleTaskMutationState(authority.repositoryPath, []);
    }
    throw recovery("Released V1 authority unexpectedly has repository changes.");
  }
  if (!expected || expected.unexpectedPaths.length > 0
    || JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw recovery("V1 task changes no longer match verified mutation provenance.", {
      authorityId: authority.authorityId,
    });
  }
  const actualState = await readSimpleTaskMutationState(
    authority.repositoryPath,
    checkpointPaths(actual),
  );
  if (!verification?.stateFingerprint || verification.stateFingerprint !== actualState) {
    throw recovery("Verified V1 task content changed after mutation verification.", {
      authorityId: authority.authorityId,
    });
  }
  return verification.stateFingerprint;
}

async function verifyCompletionAssets(
  repositoryPath: string,
  completion: FinalizeTaskRunRequest["completion"],
): Promise<void> {
  const root = await realpath(repositoryPath);
  for (const asset of completion.assets.filter((entry) => entry.verified)) {
    if (isAbsolute(asset.path)) {
      throw invalid("V1 completion assets must be task-relative before finalization.", {
        path: asset.path,
      });
    }
    const target = resolve(root, asset.path);
    const canonical = await realpath(target).catch(() => undefined);
    const stat = await lstat(target).catch(() => undefined);
    const contained = canonical
      && (canonical === root || canonical.startsWith(root + sep))
      && !relative(root, canonical).startsWith("..");
    if (!stat || !canonical || !contained
      || (asset.kind === "file" && !stat.isFile())
      || (asset.kind === "directory" && !stat.isDirectory())) {
      throw invalid("Verified completion asset is unavailable or outside the task repository.", {
        path: asset.path,
      });
    }
  }
}

function persistFinalWorkState(
  database: ContextDatabase,
  record: SimpleTaskFinalizationRecord,
  at: string,
): void {
  const current = readRunWorkState(database, record.runId);
  const run = readRunEvidence(database, record.runId);
  if (!current || !run) throw new Error("V1 finalization WorkState is unavailable.");
  const done = record.outcome === "done";
  const blocked = record.outcome === "blocked" || record.outcome === "needs_user_input";
  replaceRunWorkState(database, {
    runId: record.runId,
    afterStep: run.stepCount,
    state: {
      status: done ? "done" : blocked
        ? record.outcome === "needs_user_input" ? "needs_user_input" : "blocked"
        : "not_done",
      summary: record.summary,
      openWork: done ? [] : unique([...current.openWork, ...record.completion.missing]),
      blockers: blocked ? unique([...current.blockers, ...record.completion.failures]) : [],
      facts: current.facts,
      evidence: current.evidence,
      artifacts: unique([
        ...current.artifacts,
        ...record.completion.assets.filter((asset) => asset.verified).map((asset) => asset.path),
      ]),
      nextStep: done ? null : record.next ?? current.nextStep,
      userInputNeeded: record.outcome === "needs_user_input"
        ? current.userInputNeeded
        : [],
    },
    at,
  });
}

function response(
  record: SimpleTaskFinalizationRecord,
  head: string,
): FinalizeTaskRunResponse {
  return {
    runId: record.runId,
    taskId: record.taskId,
    outcome: record.outcome,
    taskHeadBefore: record.baseHead,
    taskHeadAfter: head,
    taskFinalizationCommit: head,
    taskCommitCreated: record.commitCreated,
    conversationHash: record.conversationHash,
  };
}

function assertMatchingRetry(
  record: SimpleTaskFinalizationRecord,
  input: FinalizeTaskRunRequest,
): void {
  const matches = record.sessionId === input.sessionId
    && record.taskId === input.taskId
    && record.runId === input.runId
    && record.outcome === input.outcome
    && record.validation === input.validation
    && record.summary === normalize(input.summary)
    && (record.next ?? null) === (input.next ? normalize(input.next) : null)
    && record.assistantResponse === input.assistantResponse
    && JSON.stringify(record.completion) === JSON.stringify(input.completion);
  if (!matches) {
    throw new GitContextServiceError({
      code: "IDEMPOTENCY_CONFLICT",
      message: "V1 finalization retry does not match its persisted run journal.",
      details: { runId: input.runId },
    });
  }
}

function commitOutcome(outcome: TaskRunOutcome): TaskRunCommitOutcome {
  if (outcome === "done") return "completed";
  if (outcome === "needs_user_input") return "blocked";
  return outcome;
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function invalid(message: string, details?: Record<string, unknown>): GitContextServiceError {
  return new GitContextServiceError({
    code: "INVALID_REQUEST",
    message,
    ...(details ? { details } : {}),
  });
}

function recovery(message: string, details?: Record<string, unknown>): GitContextServiceError {
  return new GitContextServiceError({
    code: "RECOVERY_REQUIRED",
    message,
    ...(details ? { details } : {}),
  });
}

function headMismatch(taskId: string, expected: string, actual: string): GitContextServiceError {
  return new GitContextServiceError({
    code: "TASK_HEAD_MISMATCH",
    message: "V1 task HEAD changed during finalization.",
    details: { taskId, expectedHead: expected, actualHead: actual },
  });
}
