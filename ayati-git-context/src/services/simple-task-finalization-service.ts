import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  FinalizeRunRequest,
  FinalizeRunResponse,
  MutationProvenance,
  RunOutcome,
  RunWorkState,
  SessionRef,
  TaskCompletionRecord,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import {
  beginRecoverableIdempotent,
  completeRecoverableIdempotent,
  markRecoverableIdempotencyFailed,
} from "../database/idempotency.js";
import { GitContextServiceError } from "../errors.js";
import { readMutationProvenance } from "../git/mutation-provenance.js";
import {
  commitSimpleTaskPlan,
  contentHash,
  readSimpleTaskMutationState,
} from "../git/simple-task-repository-transaction.js";
import {
  assertCommittableMutationPaths,
  verifiedMutationPaths,
} from "../mutations/verified-mutation-paths.js";
import { conversationContentHash, renderConversation } from "../conversations/conversation-renderer.js";
import {
  closeRunConversationWithAssistant,
  closeRunConversationWithoutAssistant,
  readConversation,
  readConversationMessages,
  updateConversationContentHash,
} from "../repositories/conversation-records.js";
import { readConversationPersistenceState } from "../repositories/conversation-persistence-records.js";
import {
  readMutationAuthorityForRun,
  releaseVerifiedMutationAuthority,
  type MutationAuthorityRecord,
} from "../repositories/mutation-authority-records.js";
import {
  finalizeRunRecord,
  markRunRecoveryRequired,
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
  markRunTaskAttachmentsCommitted,
  markRunTaskAttachmentsRecoveryRequired,
  readRunTaskAttachmentBindings,
} from "../repositories/task-attachment-records.js";
import {
  readTaskInitialization,
  updateTaskHead,
} from "../repositories/task-records.js";
import { writeTaskDiscoveryProjection } from "../repositories/task-discovery-records.js";
import {
  readTaskRequestRoutePlan,
  updateTaskRequestRoutePlan,
} from "../repositories/task-request-route-plan-records.js";
import { resolvePlannedTaskRequestState } from "../tasks/planned-task-request.js";
import { renderTaskCommit, type TaskCommitOutcome } from "../tasks/task-commit-metadata.js";
import { reduceSimpleTaskContext } from "../tasks/simple-task-context-reducer.js";
import { renderTaskReferences } from "../tasks/task-references.js";
import { TASK_REFERENCES_PATH } from "../tasks/task-repository-layout.js";
import {
  validateTaskRepository,
  type TaskRepositoryValidation,
} from "../tasks/task-repository-validator.js";
import type { MutationBoundaryService } from "./mutation-boundary-service.js";

export type SimpleTaskFinalizationHook = (
  phase: "plan_persisted" | "commit_created",
  record: SimpleTaskFinalizationRecord,
) => void | Promise<void>;

interface TaskFinalizeInput extends Omit<FinalizeRunRequest, "task"> {
  taskId: string;
  taskRequestId: string;
  completion: TaskCompletionRecord;
}

export class SimpleTaskFinalizationService {
  constructor(private readonly options: {
    database: ContextDatabase;
    taskRoot: string;
    mutationBoundary: MutationBoundaryService;
    hook?: SimpleTaskFinalizationHook;
  }) {}

  async finalize(
    request: FinalizeRunRequest,
    session: SessionRef,
  ): Promise<FinalizeRunResponse> {
    const input = this.normalize(request);
    const existing = readSimpleTaskFinalization(this.options.database, input.runId);
    if (existing) {
      assertMatchingRetry(existing, input);
      const pending = beginRecoverableIdempotent<FinalizeRunResponse | { runId: string }>({
        database: this.options.database,
        requestId: input.requestId,
        operation: "finalize_run",
        payload: request,
        now: input.at,
        execute: () => ({ runId: input.runId }),
      });
      if (pending.completed && "run" in pending.result) return pending.result;
      if (existing.phase === "completed" && existing.commitHead) {
        return completeRecoverableIdempotent({
          database: this.options.database,
          requestId: input.requestId,
          result: response(this.options.database, existing, existing.commitHead),
          now: input.at,
        });
      }
      return await this.execute(existing, input);
    }

    let prepared: Awaited<ReturnType<SimpleTaskFinalizationService["prepare"]>>;
    try {
      prepared = await this.prepare(input, session);
    } catch (error) {
      if (error instanceof GitContextServiceError && error.code === "RECOVERY_REQUIRED") {
        this.markPreflightRecoveryRequired(input.runId, error, input.at);
      }
      throw error;
    }
    const pending = beginRecoverableIdempotent<FinalizeRunResponse | { runId: string }>({
      database: this.options.database,
      requestId: input.requestId,
      operation: "finalize_run",
      payload: request,
      now: input.at,
      execute: () => {
        const conversation = closeConversation(this.options.database, input, prepared.run.conversationId);
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
          commitMessage: renderTaskCommit({
            subject: "finalize " + input.taskRequestId.toLowerCase() + " run",
            taskId: input.taskId,
            requestId: input.taskRequestId,
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
          ...(prepared.authority ? { authorityId: prepared.authority.authorityId } : {}),
          sessionId: input.sessionId,
          taskId: input.taskId,
          taskRequestId: input.taskRequestId,
          conversationId: conversation.conversationId,
          outcome: input.outcome,
          stopReason: input.stopReason,
          validation: input.validation,
          summary: prepared.finalSummary,
          ...(input.next ? { next: normalize(input.next) } : {}),
          completion: input.completion,
          assistantResponse: input.assistantResponse,
          baseHead: prepared.baseHead,
          conversationHash,
          plan,
          at: input.at,
        });
        replaceRunWorkState(this.options.database, {
          runId: input.runId,
          afterStep: prepared.run.stepCount,
          state: input.workState,
          at: input.at,
        });
        return { runId: input.runId };
      },
    });
    if (pending.completed && "run" in pending.result) return pending.result;
    const record = readSimpleTaskFinalization(this.options.database, input.runId);
    if (!record) throw new Error("Prepared V1 finalization could not be read.");
    await this.options.hook?.("plan_persisted", record);
    return await this.execute(record, input);
  }

  async recover(at: string): Promise<void> {
    for (const record of readRecoverableSimpleTaskFinalizations(this.options.database)) {
      try {
        await this.executeRecord(record, at);
        const completed = readSimpleTaskFinalization(this.options.database, record.runId);
        if (!completed?.commitHead) throw new Error("Recovered task finalization is incomplete.");
        completeRecoverableIdempotent({
          database: this.options.database,
          requestId: record.requestId,
          result: response(this.options.database, completed, completed.commitHead),
          now: at,
        });
      } catch (error) {
        this.markRecoveryRequired(record, error, at);
      }
    }
  }

  private normalize(input: FinalizeRunRequest): TaskFinalizeInput {
    const run = readRunEvidence(this.options.database, input.runId);
    const binding = run?.taskBinding;
    const completion = input.task?.completion;
    if (!run
      || run.sessionId !== input.sessionId
      || !binding
      || !completion) {
      throw invalid("Task-bound finalization requires the run binding and completion evidence.");
    }
    if (input.outcome === "done" && !completion.accepted) {
      throw invalid("A done task-bound run requires accepted completion evidence.");
    }
    return {
      ...input,
      taskId: binding.taskId,
      taskRequestId: binding.taskRequestId,
      completion,
    };
  }

  private async prepare(input: TaskFinalizeInput, _session: SessionRef) {
    const run = readRunEvidence(this.options.database, input.runId);
    if (!run
      || run.status !== "running"
      || run.sessionId !== input.sessionId
      || run.taskBinding?.taskId !== input.taskId
      || run.taskBinding.taskRequestId !== input.taskRequestId) {
      throw invalid("V1 finalization requires the matching active task-bound run.");
    }
    const task = readTaskInitialization(this.options.database, input.taskId);
    if (!task?.head) {
      throw invalid("V1 finalization requires an active simple task repository.");
    }
    const validation = await validateTaskRepository({
      taskRoot: this.options.taskRoot,
      repositoryPath: task.repositoryPath,
      expectedTaskId: input.taskId,
      placement: task.placement,
      trustedRoot: task.trustedRoot,
      requestReadMode: "all",
    });
    if (validation.head !== task.head || validation.branch !== task.branch) {
      throw headMismatch(input.taskId, task.head, validation.head);
    }
    const routePlan = readTaskRequestRoutePlan(this.options.database, input.runId);
    if (routePlan?.phase === "recovery_required" || routePlan?.phase === "discarded"
      || routePlan?.phase === "committed") {
      throw recovery("V1 finalization request plan is not active.", {
        routePlanPhase: routePlan.phase,
      });
    }
    const planned = routePlan
      ? resolvePlannedTaskRequestState(routePlan, validation)
      : validation.currentRequest
        ? {
            taskCard: validation.taskCard,
            taskRequest: validation.currentRequest,
            requestCreated: false,
          }
        : undefined;
    if (!planned || planned.taskRequest.id !== input.taskRequestId) {
      throw recovery("V1 finalization request no longer matches the run binding.");
    }

    let authority = readMutationAuthorityForRun(this.options.database, input.runId);
    assertAuthorityIdentity(authority, input, task.repositoryPath);
    const mutation = await this.readVerifiedMutation(authority, task.repositoryPath);
    if (validation.health !== "ready" && mutation.paths.length === 0) {
      throw recovery("Task finalization found repository changes without verified mutation authority.", {
        taskId: input.taskId,
        workingTreeChanges: validation.workingTreeChanges,
      });
    }
    const currentWorkState = readRunWorkState(this.options.database, input.runId);
    if (!currentWorkState) throw recovery("V1 finalization requires persisted WorkState.");
    const finalWorkState: RunWorkState = {
      ...input.workState,
      runId: input.runId,
      revision: currentWorkState.revision + 1,
      afterStep: run.stepCount,
      updatedAt: input.at,
    };
    await verifyCompletionAssets(task.repositoryPath, input.completion);
    const context = reduceSimpleTaskContext({
      taskCard: planned.taskCard,
      taskRequest: planned.taskRequest,
      workState: finalWorkState,
      outcome: input.outcome,
      validation: input.validation,
      summary: input.summary,
      ...(input.next ? { next: input.next } : {}),
      completion: input.completion,
      hasVerifiedChanges: mutation.paths.length > 0,
    });
    const attachmentBindings = readRunTaskAttachmentBindings(
      this.options.database,
      input.runId,
    );
    const invalidBinding = attachmentBindings.find((binding) =>
      binding.taskId !== input.taskId
      || binding.taskRequestId !== input.taskRequestId
      || binding.phase === "recovery_required"
    );
    if (invalidBinding) {
      throw recovery("V1 finalization found an invalid task attachment binding.", {
        referenceId: invalidBinding.referenceId,
        phase: invalidBinding.phase,
      });
    }
    const references = new Map(
      validation.references.map((reference) => [reference.id, reference]),
    );
    for (const binding of attachmentBindings) references.set(binding.referenceId, binding.reference);
    const renderedReferences = renderTaskReferences(
      [...references.values()].sort((left, right) => left.id.localeCompare(right.id)),
    );
    const referenceWrites = renderedReferences === renderTaskReferences(validation.references)
      ? []
      : [{ path: TASK_REFERENCES_PATH, content: renderedReferences }];
    const applyRoutePlan = Boolean(routePlan?.changePlan)
      && !(input.outcome === "failed" && mutation.paths.length === 0);
    const desiredWrites = new Map<string, string>();
    if (applyRoutePlan) {
      for (const write of routePlan!.changePlan!.writes) desiredWrites.set(write.path, write.content);
    }
    for (const write of [...context.contextWrites, ...referenceWrites]) {
      desiredWrites.set(write.path, write.content);
    }
    const contextWrites = [...desiredWrites.entries()]
      .map(([path, content]) => ({ path, content }))
      .sort((left, right) => left.path.localeCompare(right.path));
    const commitRequired = contextWrites.length > 0 || mutation.paths.length > 0;

    if (commitRequired && (!authority || authority.status === "released")) {
      authority = await this.acquireContextAuthority(input, task.head);
      const refreshedMutation = await this.readVerifiedMutation(authority, task.repositoryPath);
      if (refreshedMutation.paths.length > 0) {
        throw recovery("Context-only authority unexpectedly observed repository changes.");
      }
    }
    if (commitRequired && authority?.status !== "verified") {
      throw recovery("Committing task state requires verified mutation authority.");
    }

    const stagedPaths = [...new Set([
      ...mutation.paths,
      ...contextWrites.map((write) => write.path),
    ])].sort();
    const contextBefore = await Promise.all(contextWrites.map(async (write) => ({
      path: write.path,
      sha256: await readContextHash(task.repositoryPath, write.path),
    })));
    return {
      run,
      task,
      baseHead: task.head,
      authority,
      plan: {
        commitRequired,
        verifiedPaths: mutation.paths,
        verifiedState: mutation.state,
        contextWrites,
        contextBefore,
        stagedPaths,
        commitMessage: "",
      },
      finalSummary: context.contextWrites.length > 0
        ? context.taskCard.currentSnapshot
        : normalize(input.summary),
    };
  }

  private async acquireContextAuthority(
    input: TaskFinalizeInput,
    head: string,
  ): Promise<MutationAuthorityRecord> {
    const acquired = await this.options.mutationBoundary.acquire({
      requestId: input.runId + ":finalization-authority",
      sessionId: input.sessionId,
      runId: input.runId,
      taskId: input.taskId,
      taskRequestId: input.taskRequestId,
      expectedTaskHead: head,
      targets: [],
      at: input.at,
    });
    await this.options.mutationBoundary.verify({
      requestId: input.runId + ":finalization-verification",
      authorityId: acquired.authority.authorityId,
      lockToken: acquired.authority.lockToken,
      toolStatus: "completed",
      at: input.at,
    });
    const authority = readMutationAuthorityForRun(this.options.database, input.runId);
    if (!authority || authority.status !== "verified") {
      throw recovery("Context-only authority could not be verified.");
    }
    return authority;
  }

  private async readVerifiedMutation(
    authority: MutationAuthorityRecord | undefined,
    repositoryPath: string,
  ): Promise<{ paths: string[]; state: string }> {
    if (!authority || authority.status === "released") {
      return { paths: [], state: await readSimpleTaskMutationState(repositoryPath, []) };
    }
    if (authority.status !== "verified") {
      throw recovery("V1 finalization requires verified mutation state.", {
        authorityId: authority.authorityId,
        authorityStatus: authority.status,
      });
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
    const state = await requireExpectedProvenance(authority, provenance);
    const paths = verifiedMutationPaths(provenance);
    assertCommittableMutationPaths(paths);
    return { paths, state };
  }

  private async execute(
    record: SimpleTaskFinalizationRecord,
    input: TaskFinalizeInput,
  ): Promise<FinalizeRunResponse> {
    try {
      await this.executeRecord(record, input.at);
      const completed = readSimpleTaskFinalization(this.options.database, record.runId);
      if (!completed?.commitHead) throw new Error("Completed task finalization is missing.");
      const result = response(this.options.database, completed, completed.commitHead);
      return completeRecoverableIdempotent({
        database: this.options.database,
        requestId: input.requestId,
        result,
        now: input.at,
      });
    } catch (error) {
      this.markRecoveryRequired(record, error, input.at);
      markRecoverableIdempotencyFailed({
        database: this.options.database,
        requestId: input.requestId,
      });
      throw error;
    }
  }

  private async executeRecord(record: SimpleTaskFinalizationRecord, at: string): Promise<void> {
    const task = readTaskInitialization(this.options.database, record.taskId);
    if (!task?.head) throw recovery("Journaled V1 task repository is unavailable.");
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
      at,
    });
    const validation = await this.validateCommittedContext(
      record,
      task.repositoryPath,
      committed.head,
    );
    this.acknowledge(record, committed, validation, at);
  }

  private async validateCommittedContext(
    record: SimpleTaskFinalizationRecord,
    repositoryPath: string,
    head: string,
  ): Promise<TaskRepositoryValidation | undefined> {
    if (!record.plan.commitRequired) return undefined;
    const task = readTaskInitialization(this.options.database, record.taskId);
    if (!task) throw recovery("Committed task is missing from the catalog.");
    const validation = await validateTaskRepository({
      taskRoot: this.options.taskRoot,
      repositoryPath,
      expectedTaskId: record.taskId,
      placement: task.placement,
      trustedRoot: task.trustedRoot,
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
    return validation;
  }

  private acknowledge(
    record: SimpleTaskFinalizationRecord,
    commit: { head: string; created: boolean },
    validation: TaskRepositoryValidation | undefined,
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
      if (validation) {
        const current = validation.currentRequest;
        writeTaskDiscoveryProjection(this.options.database, {
          taskId: record.taskId,
          expectedHead: commit.head,
          title: validation.taskCard.title,
          objective: validation.taskCard.purpose,
          lifecycleStatus: validation.taskCard.status,
          repositoryHealth: validation.health,
          ...(current ? {
              currentRequest: {
                id: current.id,
                title: current.title,
                status: current.status,
                searchText: [current.title, current.request].join("\n"),
              },
            } : {}),
        });
      }
      const run = readRunEvidence(this.options.database, record.runId);
      if (run?.status === "running" || run?.status === "recovery_required") {
        finalizeRunRecord(this.options.database, {
          runId: record.runId,
          outcome: record.outcome,
          stopReason: record.stopReason,
          at,
        });
      }
      const authority = readMutationAuthorityForRun(this.options.database, record.runId);
      if (authority?.status === "verified") {
        releaseVerifiedMutationAuthority(this.options.database, authority.authorityId, at);
      }
      markRunTaskAttachmentsCommitted(this.options.database, record.runId, commit.head, at);
      const routePlan = readTaskRequestRoutePlan(this.options.database, record.runId);
      if (routePlan) {
        updateTaskRequestRoutePlan(this.options.database, {
          runId: record.runId,
          phase: record.plan.commitRequired ? "committed" : "discarded",
          commitHead: commit.head,
          at,
        });
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

  private markRecoveryRequired(
    record: SimpleTaskFinalizationRecord,
    error: unknown,
    at: string,
  ): void {
    const message = error instanceof Error ? error.message : String(error);
    this.options.database.transaction(() => {
      markRunRecoveryRequired(this.options.database, record.runId);
      updateSimpleTaskFinalization(this.options.database, {
        runId: record.runId,
        phase: "recovery_required",
        error: message,
        at,
      });
      markRunTaskAttachmentsRecoveryRequired(this.options.database, record.runId, message, at);
      const routePlan = readTaskRequestRoutePlan(this.options.database, record.runId);
      if (routePlan) {
        updateTaskRequestRoutePlan(this.options.database, {
          runId: record.runId,
          phase: "recovery_required",
          error: message,
          at,
        });
      }
    });
  }

  private markPreflightRecoveryRequired(runId: string, error: Error, at: string): void {
    this.options.database.transaction(() => {
      markRunRecoveryRequired(this.options.database, runId);
      markRunTaskAttachmentsRecoveryRequired(this.options.database, runId, error.message, at);
      const routePlan = readTaskRequestRoutePlan(this.options.database, runId);
      if (routePlan) {
        updateTaskRequestRoutePlan(this.options.database, {
          runId,
          phase: "recovery_required",
          error: error.message,
          at,
        });
      }
    });
  }
}

function assertAuthorityIdentity(
  authority: MutationAuthorityRecord | undefined,
  input: TaskFinalizeInput,
  repositoryPath: string,
): void {
  if (!authority) return;
  if (authority.sessionId !== input.sessionId
    || authority.taskId !== input.taskId
    || authority.taskRequestId !== input.taskRequestId
    || authority.repositoryPath !== repositoryPath) {
    throw recovery("V1 finalization authority does not match the run binding.");
  }
}

function closeConversation(
  database: ContextDatabase,
  input: TaskFinalizeInput,
  conversationId: string,
) {
  const common = {
    sessionId: input.sessionId,
    conversationId,
    runId: input.runId,
    taskId: input.taskId,
    at: input.at,
  };
  return input.assistantResponse
    ? closeRunConversationWithAssistant(database, {
        ...common,
        content: input.assistantResponse,
      })
    : closeRunConversationWithoutAssistant(database, common);
}

async function readContextHash(repositoryPath: string, path: string): Promise<string> {
  try {
    return contentHash(await readFile(resolve(repositoryPath, path), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
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
  if (!expected || expected.unexpectedPaths.length > 0
    || JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw recovery("V1 task changes no longer match verified mutation provenance.", {
      authorityId: authority.authorityId,
    });
  }
  const actualState = await readSimpleTaskMutationState(
    authority.repositoryPath,
    verifiedMutationPaths(actual),
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
  completion: TaskCompletionRecord,
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

function response(
  database: ContextDatabase,
  record: SimpleTaskFinalizationRecord,
  head: string,
): FinalizeRunResponse {
  const run = readRunEvidence(database, record.runId);
  const conversation = readConversation(database, record.conversationId);
  const persistence = readConversationPersistenceState(database, record.conversationId);
  if (!run || !conversation || !persistence) {
    throw new Error("Finalized task-bound run response cannot be reconstructed.");
  }
  const identity = {
    taskId: record.taskId,
    taskRequestId: record.taskRequestId,
    headBefore: record.baseHead,
    headAfter: head,
  };
  return {
    run,
    conversation,
    persistence,
    materialization: { status: "not_requested" },
    commit: !record.plan.commitRequired
      ? { status: "not_required" }
      : record.commitCreated
        ? { status: "committed", ...identity, commit: head }
        : { status: "no_change", ...identity },
  };
}

function assertMatchingRetry(
  record: SimpleTaskFinalizationRecord,
  input: TaskFinalizeInput,
): void {
  const matches = record.requestId === input.requestId
    && record.sessionId === input.sessionId
    && record.taskId === input.taskId
    && record.taskRequestId === input.taskRequestId
    && record.runId === input.runId
    && record.outcome === input.outcome
    && record.stopReason === input.stopReason
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

function commitOutcome(outcome: RunOutcome): TaskCommitOutcome {
  if (outcome === "done") return "completed";
  if (outcome === "needs_user_input") return "blocked";
  return outcome;
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, " ");
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
