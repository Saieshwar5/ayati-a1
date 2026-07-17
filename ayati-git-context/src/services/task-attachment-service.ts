import { lstat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type {
  AdoptTaskReferenceRequest,
  AdoptTaskReferenceResponse,
  BindTaskAttachmentsRequest,
  BindTaskAttachmentsResponse,
  RecordSessionAttachmentsRequest,
  RecordSessionAttachmentsResponse,
  SessionAttachmentsProjection,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import { executeIdempotent, readCompletedIdempotent } from "../database/idempotency.js";
import { GitContextServiceError } from "../errors.js";
import { readConversation } from "../repositories/conversation-records.js";
import { readMutationAuthority } from "../repositories/mutation-authority-records.js";
import { readRunEvidence } from "../repositories/run-records.js";
import { readTaskRequestRoutePlan } from "../repositories/task-request-route-plan-records.js";
import {
  countSessionAttachments,
  readConversationAttachments,
  readRecentSessionAttachments,
  readTaskAttachmentBinding,
  readTaskAttachmentBindingByReference,
  readTaskAttachmentBindings,
  toBoundTaskReference,
  updateTaskAttachmentReference,
  upsertSessionAttachments,
  upsertTaskAttachmentBinding,
} from "../repositories/task-attachment-records.js";
import { readTaskInitialization } from "../repositories/task-records.js";
import { verifyMutationLockToken } from "./mutation-boundary-service.js";
import {
  adoptTaskReferenceFile,
  placeTaskInboxAttachment,
  resolveTaskReferenceAvailability,
  sha256File,
} from "../tasks/task-reference-files.js";
import { nextReferenceId } from "../tasks/task-references.js";
import type { TaskReference } from "../tasks/task-references.js";
import { normalizePortableTaskPath } from "../tasks/task-repository-layout.js";
import { validateTaskRepository } from "../tasks/task-repository-validator.js";
import { resolvePlannedTaskRequestState } from "../tasks/planned-task-request.js";

export class TaskAttachmentService {
  constructor(private readonly options: {
    database: ContextDatabase;
    taskRoot: string;
  }) {}

  async record(
    input: RecordSessionAttachmentsRequest,
  ): Promise<RecordSessionAttachmentsResponse> {
    const completed = readCompletedIdempotent<RecordSessionAttachmentsResponse>({
      database: this.options.database,
      requestId: input.requestId,
      operation: "record_session_attachments",
      payload: input,
    });
    if (completed) return completed;
    const conversation = readConversation(this.options.database, input.conversationId);
    if (!conversation || conversation.sessionId !== input.sessionId) {
      throw invalid("Attachment retention requires the matching session conversation.");
    }
    for (const attachment of input.attachments) {
      await validateRetainedAttachment(attachment);
    }
    return executeIdempotent({
      database: this.options.database,
      requestId: input.requestId,
      operation: "record_session_attachments",
      payload: input,
      now: input.at,
      execute: () => {
        upsertSessionAttachments(this.options.database, input);
        return {
          recorded: input.attachments.length,
          sessionAssetIds: input.attachments.map((attachment) => attachment.sessionAssetId),
        };
      },
    });
  }

  async bind(
    input: BindTaskAttachmentsRequest,
  ): Promise<BindTaskAttachmentsResponse> {
    const completed = readCompletedIdempotent<BindTaskAttachmentsResponse>({
      database: this.options.database,
      requestId: input.requestId,
      operation: "bind_task_attachments",
      payload: input,
    });
    if (completed) return completed;
    const run = readRunEvidence(this.options.database, input.runId);
    if (!run || run.status !== "running" || run.runClass !== "task"
      || run.sessionId !== input.sessionId || run.taskId !== input.taskId
      || run.conversationId !== input.conversationId) {
      throw invalid("Attachment binding requires the matching active task run.");
    }
    const task = readTaskInitialization(this.options.database, input.taskId);
    if (!task?.head || task.layoutVersion !== "simple_repository_v1") {
      return executeIdempotent({
        database: this.options.database,
        requestId: input.requestId,
        operation: "bind_task_attachments",
        payload: input,
        now: input.at,
        execute: () => ({ taskId: input.taskId, runId: input.runId, references: [] }),
      });
    }
    const validation = await validateTaskRepository({
      taskRoot: this.options.taskRoot,
      repositoryPath: task.repositoryPath,
      expectedTaskId: task.taskId,
      requestReadMode: "all",
    });
    const routePlan = readTaskRequestRoutePlan(this.options.database, input.runId);
    if (routePlan && routePlan.phase !== "planned"
      && routePlan.phase !== "authority_acquired") {
      throw invalid("Attachment binding requires a mutation-ready task request plan.", {
        phase: routePlan.phase,
      });
    }
    const taskRequest = routePlan
      ? resolvePlannedTaskRequestState(routePlan, validation).taskRequest
      : validation.currentRequest;
    if (!taskRequest || taskRequest.status !== "active"
      || run.taskRequestId !== taskRequest.id) {
      throw invalid("Attachment binding requires an active V1 task request.");
    }
    const attachments = readConversationAttachments(
      this.options.database,
      input.sessionId,
      input.conversationId,
    );
    const allocatedIds = new Set([
      ...validation.references.map((reference) => reference.id),
      ...readTaskAttachmentBindings(this.options.database, input.taskId)
        .map((binding) => binding.referenceId),
    ]);
    const bound = [];
    for (const attachment of attachments) {
      const existing = readTaskAttachmentBinding(
        this.options.database,
        input.taskId,
        attachment.sessionAssetId,
      );
      if (existing) {
        const requestIds = unique([...existing.reference.requestIds, taskRequest.id]);
        const availability = await resolveTaskReferenceAvailability(
          task.repositoryPath,
          existing.reference,
        );
        if (existing.phase === "committed"
          && existing.reference.requestIds.includes(taskRequest.id)
          && availability === existing.reference.availability) {
          bound.push(existing);
          continue;
        }
        bound.push(updateTaskAttachmentReference(this.options.database, {
          taskId: input.taskId,
          sessionAssetId: attachment.sessionAssetId,
          runId: input.runId,
          taskRequestId: taskRequest.id,
          reference: { ...existing.reference, requestIds, availability },
          at: input.at,
        }));
        continue;
      }
      const referenceId = nextReferenceId(allocatedIds);
      allocatedIds.add(referenceId);
      const reference = await this.createReference({
        attachment,
        taskRepositoryPath: task.repositoryPath,
        referenceId,
        requestId: taskRequest.id,
        at: input.at,
      });
      bound.push(upsertTaskAttachmentBinding(this.options.database, {
        taskId: input.taskId,
        sessionAssetId: attachment.sessionAssetId,
        referenceId,
        runId: input.runId,
        taskRequestId: taskRequest.id,
        conversationId: input.conversationId,
        reference,
        at: input.at,
      }));
    }
    const response: BindTaskAttachmentsResponse = {
      taskId: input.taskId,
      runId: input.runId,
      references: bound.map(toBoundTaskReference),
    };
    return executeIdempotent({
      database: this.options.database,
      requestId: input.requestId,
      operation: "bind_task_attachments",
      payload: input,
      now: input.at,
      execute: () => response,
    });
  }

  async adopt(
    input: AdoptTaskReferenceRequest,
  ): Promise<AdoptTaskReferenceResponse> {
    const completed = readCompletedIdempotent<AdoptTaskReferenceResponse>({
      database: this.options.database,
      requestId: input.requestId,
      operation: "adopt_task_reference",
      payload: input,
    });
    if (completed) return completed;
    const authority = readMutationAuthority(this.options.database, input.authorityId);
    if (!authority || authority.repositoryLayout !== "simple_repository_v1"
      || authority.status !== "active" || !authority.taskRequestId) {
      throw invalid("Reference adoption requires an active V1 mutation authority.");
    }
    if (hasExpired(authority.expiresAt, input.at)) {
      throw invalid("Reference adoption requires an unexpired mutation authority.", {
        expiresAt: authority.expiresAt,
      });
    }
    verifyMutationLockToken(authority, input.lockToken);
    const destinationPath = normalizePortableTaskPath(input.destinationPath);
    if (!authority.targets.some((target) => target.kind === "directory"
      ? destinationPath === target.path || destinationPath.startsWith(target.path + "/")
      : destinationPath === target.path)) {
      throw invalid("Reference adoption destination is outside the mutation authority.", {
        destinationPath,
      });
    }
    const binding = readTaskAttachmentBindingByReference(
      this.options.database,
      authority.taskId,
      input.referenceId,
    );
    if (!binding || binding.reference.kind !== "attachment" || !binding.reference.sha256) {
      throw invalid("Reference adoption requires a bound file attachment.");
    }
    if (binding.reference.availability !== "available") {
      throw invalid("Reference adoption requires an available attachment.");
    }
    const sourcePath = resolve(authority.repositoryPath, binding.reference.location);
    if (await resolveTaskReferenceAvailability(authority.repositoryPath, binding.reference) !== "available") {
      throw invalid("Reference attachment is missing or changed; reattach it before adoption.");
    }
    const adopted = await adoptTaskReferenceFile({
      repositoryPath: authority.repositoryPath,
      sourcePath,
      destinationPath,
      sha256: binding.reference.sha256,
    });
    const reference = {
      ...binding.reference,
      adoptedPath: adopted.destinationPath,
      requestIds: unique([...binding.reference.requestIds, authority.taskRequestId]),
    };
    updateTaskAttachmentReference(this.options.database, {
      taskId: authority.taskId,
      sessionAssetId: binding.sessionAssetId,
      runId: authority.runId,
      taskRequestId: authority.taskRequestId,
      reference,
      at: input.at,
    });
    const response: AdoptTaskReferenceResponse = {
      taskId: authority.taskId,
      runId: authority.runId,
      referenceId: input.referenceId,
      sourcePath: binding.reference.location,
      destinationPath: adopted.destinationPath,
      sha256: adopted.sha256,
    };
    return executeIdempotent({
      database: this.options.database,
      requestId: input.requestId,
      operation: "adopt_task_reference",
      payload: input,
      now: input.at,
      execute: () => response,
    });
  }

  sessionProjection(sessionId: string): SessionAttachmentsProjection | undefined {
    const count = countSessionAttachments(this.options.database, sessionId);
    if (count === 0) return undefined;
    const recent = readRecentSessionAttachments(this.options.database, sessionId);
    return {
      count,
      recent,
      ...(recent[0]?.lastUsedAt || recent[0]?.createdAt
        ? { updatedAt: recent[0]?.lastUsedAt ?? recent[0]!.createdAt }
        : {}),
    };
  }

  private async createReference(input: {
    attachment: ReturnType<typeof readConversationAttachments>[number];
    taskRepositoryPath: string;
    referenceId: string;
    requestId: string;
    at: string;
  }): Promise<TaskReference> {
    if (input.attachment.kind === "directory") {
      const location = input.attachment.originalPath ?? input.attachment.storedPath;
      if (!location || !isAbsolute(location)) {
        throw invalid("Directory attachment is missing an absolute retained location.");
      }
      const available = (await lstat(location).catch(() => undefined))?.isDirectory() ?? false;
      return {
        id: input.referenceId,
        kind: "external_directory",
        label: singleLine(input.attachment.name),
        location,
        sha256: null,
        availability: available ? "available" : "missing",
        addedAt: input.at,
        requestIds: [input.requestId],
        adoptedPath: null,
        notes: "User-provided directory reference; external bytes remain read-only.",
      };
    }
    if (!input.attachment.storedPath || !input.attachment.checksum) {
      throw invalid("File attachment is missing retained bytes or checksum identity.");
    }
    const sha256 = normalizeSha256(input.attachment.checksum);
    const location = await placeTaskInboxAttachment({
      repositoryPath: input.taskRepositoryPath,
      referenceId: input.referenceId,
      label: input.attachment.name,
      sourcePath: input.attachment.storedPath,
      sha256,
    });
    return {
      id: input.referenceId,
      kind: "attachment",
      label: singleLine(input.attachment.name),
      location,
      sha256,
      availability: "available",
      addedAt: input.at,
      requestIds: [input.requestId],
      adoptedPath: null,
      notes: "User-provided task input; preserve original inbox bytes.",
    };
  }
}

async function validateRetainedAttachment(
  attachment: RecordSessionAttachmentsRequest["attachments"][number],
): Promise<void> {
  if (attachment.kind === "directory") {
    if (!attachment.originalPath && !attachment.storedPath) {
      throw invalid("Directory attachment is missing a retained location.");
    }
    return;
  }
  if (!attachment.storedPath || !isAbsolute(attachment.storedPath) || !attachment.checksum) {
    throw invalid("File attachment is missing managed storage or checksum identity.");
  }
  if (await sha256File(attachment.storedPath) !== normalizeSha256(attachment.checksum)) {
    throw invalid("Managed attachment checksum does not match its retained bytes.");
  }
}

function normalizeSha256(value: string): string {
  const normalized = value.startsWith("sha256:") ? value : "sha256:" + value;
  if (!/^sha256:[a-f0-9]{64}$/.test(normalized)) {
    throw invalid("Attachment checksum must be a lowercase SHA-256 identity.");
  }
  return normalized;
}

function singleLine(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > 240 || /[\r\n`]/.test(normalized)) {
    throw invalid("Attachment label is empty or unsafe for task context.");
  }
  return normalized;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function hasExpired(expiresAt: string, at: string): boolean {
  const expires = Date.parse(expiresAt);
  const current = Date.parse(at);
  return Number.isFinite(expires) && Number.isFinite(current) && current >= expires;
}

function invalid(message: string, details?: Record<string, unknown>): GitContextServiceError {
  return new GitContextServiceError({
    code: "INVALID_REQUEST",
    message,
    ...(details ? { details } : {}),
  });
}
