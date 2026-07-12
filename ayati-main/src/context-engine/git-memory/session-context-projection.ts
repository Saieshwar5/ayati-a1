import { estimateTextTokens } from "../../prompt/token-estimator.js";
import type {
  ContextSessionAttachments,
  ContextSessionProjectionMetrics,
  ContextSessionSummary,
  ContextSessionTaskRunCheckpoint,
} from "../contracts.js";
import { parseGitMemoryCommitTrailers } from "./commit-message.js";
import type { GitMemoryLogEntry } from "./git-driver.js";
import type {
  GitMemoryConversationRecord,
  GitMemoryRunStatus,
  GitMemorySessionAttachmentRecord,
} from "./schema.js";

export const DEFAULT_RECENT_TASK_RUN_CHECKPOINT_LIMIT = 5;
export const DEFAULT_SESSION_ATTACHMENT_PROJECTION_LIMIT = 10;

const RUN_STATUSES = new Set<GitMemoryRunStatus>([
  "completed",
  "incomplete",
  "failed",
  "blocked",
  "needs_user_input",
]);

export interface GitMemorySessionProjection {
  openTimeline: GitMemoryConversationRecord[];
  recentTaskRuns: ContextSessionTaskRunCheckpoint[];
  metrics: ContextSessionProjectionMetrics;
}

export function buildGitMemorySessionProjection(input: {
  conversation: GitMemoryConversationRecord[];
  checkpointLog: GitMemoryLogEntry[];
  sessionId: string;
  summary?: ContextSessionSummary;
  attachments?: ContextSessionAttachments;
  checkpointLimit?: number;
}): GitMemorySessionProjection {
  const recentTaskRuns = selectRecentTaskRunCheckpoints({
    entries: input.checkpointLog,
    sessionId: input.sessionId,
    limit: input.checkpointLimit,
  });
  const checkpointBoundarySeq = recentTaskRuns.at(-1)?.toSeq;
  const openTimeline = input.conversation
    .filter((record) => checkpointBoundarySeq === undefined || record.seq > checkpointBoundarySeq)
    .map((record) => ({ ...record }))
    .sort((left, right) => left.seq - right.seq);
  const summaryTokens = estimateSectionTokens(input.summary?.text);
  const checkpointTokens = estimateSectionTokens(recentTaskRuns);
  const timelineTokens = estimateSectionTokens(openTimeline);
  const attachmentTokens = estimateSectionTokens(input.attachments);
  const latestConversationSeq = input.conversation.reduce(
    (latest, record) => Math.max(latest, record.seq),
    0,
  );
  return {
    openTimeline,
    recentTaskRuns,
    metrics: {
      latestConversationSeq,
      ...(checkpointBoundarySeq !== undefined ? { checkpointBoundarySeq } : {}),
      summaryTokens,
      checkpointTokens,
      timelineTokens,
      attachmentTokens,
      totalSessionTokens: summaryTokens + checkpointTokens + timelineTokens + attachmentTokens,
    },
  };
}

export function projectSessionAttachments(input: {
  updatedAt?: string;
  attachments: GitMemorySessionAttachmentRecord[];
}): ContextSessionAttachments {
  const recent = input.attachments
    .slice()
    .sort(compareSessionAttachmentMostRecentFirst)
    .slice(0, DEFAULT_SESSION_ATTACHMENT_PROJECTION_LIMIT)
    .map((attachment) => ({
      sessionAssetId: attachment.sessionAssetId,
      kind: attachment.kind,
      name: attachment.name,
      source: attachment.source,
      status: attachment.status,
      ...(attachment.documentId ? { documentId: attachment.documentId } : {}),
      ...(attachment.fileId ? { fileId: attachment.fileId } : {}),
      ...(attachment.directoryId ? { directoryId: attachment.directoryId } : {}),
      ...(attachment.originalPath ? { originalPath: attachment.originalPath } : {}),
      ...(attachment.storedPath ? { storedPath: attachment.storedPath } : {}),
      ...(typeof attachment.sizeBytes === "number" ? { sizeBytes: attachment.sizeBytes } : {}),
      ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
      createdAt: attachment.createdAt,
      ...(attachment.lastUsedAt ? { lastUsedAt: attachment.lastUsedAt } : {}),
    }));
  return {
    count: input.attachments.length,
    recent,
    ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
  };
}

export function updateGitMemorySessionProjectionMetrics(
  metrics: ContextSessionProjectionMetrics | undefined,
  openTimeline: GitMemoryConversationRecord[],
): ContextSessionProjectionMetrics | undefined {
  if (!metrics) {
    return undefined;
  }
  const timelineTokens = estimateSectionTokens(openTimeline);
  return {
    ...metrics,
    latestConversationSeq: openTimeline.reduce(
      (latest, record) => Math.max(latest, record.seq),
      metrics.latestConversationSeq,
    ),
    timelineTokens,
    totalSessionTokens: metrics.summaryTokens
      + metrics.checkpointTokens
      + timelineTokens
      + metrics.attachmentTokens,
  };
}

export function selectRecentTaskRunCheckpoints(input: {
  entries: GitMemoryLogEntry[];
  sessionId: string;
  limit?: number;
}): ContextSessionTaskRunCheckpoint[] {
  const limit = positiveInteger(input.limit, DEFAULT_RECENT_TASK_RUN_CHECKPOINT_LIMIT);
  return input.entries
    .map((entry) => parseTaskRunCheckpoint(entry, input.sessionId))
    .filter((checkpoint): checkpoint is ContextSessionTaskRunCheckpoint => checkpoint !== null)
    .slice(0, limit)
    .reverse();
}

export function parseTaskRunCheckpoint(
  entry: GitMemoryLogEntry,
  sessionId: string,
): ContextSessionTaskRunCheckpoint | null {
  const trailers = parseGitMemoryCommitTrailers(entry.message);
  const status = trailers.status as GitMemoryRunStatus | undefined;
  const range = trailers.conversationSeq;
  const checkpointId = firstTrailer(trailers.raw, "Ayati-Checkpoint-Id");
  const sourceHash = firstTrailer(trailers.raw, "Ayati-Checkpoint-Source-Hash");
  const strategy = firstTrailer(trailers.raw, "Ayati-Checkpoint-Strategy");
  const summary = commitBody(entry.message);
  if (
    trailers.event !== "task_run_checkpointed"
    || trailers.sessionId !== sessionId
    || !trailers.taskId
    || !trailers.runId
    || !trailers.at
    || !status
    || !RUN_STATUSES.has(status)
    || !range
    || !checkpointId?.startsWith("task-run-checkpoint-")
    || !/^[a-f0-9]{64}$/.test(sourceHash ?? "")
    || (strategy !== "llm" && strategy !== "deterministic")
    || !summary
  ) {
    return null;
  }
  return {
    checkpointId,
    commit: entry.commit,
    workId: trailers.taskId,
    runId: trailers.runId,
    status,
    fromSeq: range.fromSeq,
    toSeq: range.toSeq,
    sourceHash: sourceHash!,
    strategy,
    at: trailers.at,
    summary,
  };
}

function commitBody(message: string): string {
  const body = message
    .split(/\r?\n/)
    .slice(1)
    .join("\n")
    .split(/^Ayati-/m)[0]
    ?.trim();
  return body ?? "";
}

function firstTrailer(raw: Record<string, string[]>, key: string): string | undefined {
  return raw[key]?.[0]?.trim() || undefined;
}

function estimateSectionTokens(value: unknown): number {
  if (value === undefined || value === null || value === "") {
    return 0;
  }
  return estimateTextTokens(typeof value === "string" ? value : JSON.stringify(value));
}

function compareSessionAttachmentMostRecentFirst(
  left: GitMemorySessionAttachmentRecord,
  right: GitMemorySessionAttachmentRecord,
): number {
  const leftTime = left.lastUsedAt ?? left.createdAt;
  const rightTime = right.lastUsedAt ?? right.createdAt;
  return rightTime.localeCompare(leftTime) || left.sessionAssetId.localeCompare(right.sessionAssetId);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value !== undefined && value > 0 ? value : fallback;
}
