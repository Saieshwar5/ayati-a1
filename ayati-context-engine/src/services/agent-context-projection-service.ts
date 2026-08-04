import { createHash } from "node:crypto";
import type {
  AgentContextProjection,
  AgentStreamRef,
  GetAgentContextRequest,
  RunContextProjection,
  WorkstreamCandidate,
  WorkstreamContextProjection,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import {
  readAgentStream,
  readAgentStreamByScope,
  readLatestAgentStream,
} from "../repositories/agent-stream-records.js";
import { readActiveContextCheckpoint } from "../repositories/context-checkpoint-records.js";
import {
  readRecentStreamMessages,
  readRunIngressMessage,
} from "../repositories/message-records.js";
import {
  readAgentStreamResourcesProjection,
  readRunResources,
} from "../repositories/resource-records.js";
import {
  readActiveRun,
  readRunEvidence,
  readRunStepEvidence,
} from "../repositories/run-records.js";
import { readRecentFiles } from "../repositories/recent-file-records.js";
import { readRecentWorkStateHandoffs } from "../repositories/recent-work-state-records.js";
import { readRecentWorkstreams } from "../repositories/recent-workstream-records.js";
import { readRunWorkState } from "../repositories/run-work-state-records.js";
import { readSharedWorkstreamRepositoryState } from "../repositories/workstream-repository-state-records.js";

const MAX_EXACT_STREAM_MESSAGES = 10_000;

export interface AgentContextProjectionServiceOptions {
  database: ContextDatabase;
  loadActiveWorkstream?: (
    run: RunContextProjection,
  ) => Promise<WorkstreamContextProjection | undefined>;
  loadWorkstreamCandidates?: (input: {
    streamId: string;
    currentText?: string;
  }) => Promise<WorkstreamCandidate[]>;
  loadFocusedWorkstream?: (
    stream: AgentStreamRef,
  ) => Promise<WorkstreamContextProjection | undefined>;
}

export class AgentContextProjectionService {
  private readonly database: ContextDatabase;
  private readonly loadActiveWorkstream?: AgentContextProjectionServiceOptions["loadActiveWorkstream"];
  private readonly loadWorkstreamCandidates?: AgentContextProjectionServiceOptions["loadWorkstreamCandidates"];
  private readonly loadFocusedWorkstream?: AgentContextProjectionServiceOptions["loadFocusedWorkstream"];

  constructor(options: AgentContextProjectionServiceOptions) {
    this.database = options.database;
    this.loadActiveWorkstream = options.loadActiveWorkstream;
    this.loadWorkstreamCandidates = options.loadWorkstreamCandidates;
    this.loadFocusedWorkstream = options.loadFocusedWorkstream;
  }

  async build(
    input: GetAgentContextRequest & { currentText?: string },
  ): Promise<AgentContextProjection> {
    const stream = this.resolveStream(input);
    if (!stream) return emptyContext();
    const checkpoint = readActiveContextCheckpoint(this.database, stream.streamId);
    const recentMessages = readRecentStreamMessages(this.database, {
      streamId: stream.streamId,
      afterSeq: checkpoint?.coveredToSeq ?? 0,
      limit: MAX_EXACT_STREAM_MESSAGES,
    });
    const recentWorkstreams = readRecentWorkstreams(this.database);
    const recentFiles = readRecentFiles(this.database, {
      streamId: stream.streamId,
    });
    const recentWorkStates = readRecentWorkStateHandoffs(this.database, {
      streamId: stream.streamId,
    });
    const resources = readAgentStreamResourcesProjection(this.database, stream.streamId);
    const run = readActiveRunProjection(this.database, stream.streamId);
    const activeWorkstream = run && this.loadActiveWorkstream
      ? await this.loadActiveWorkstream(run)
      : undefined;
    const focusedWorkstream = stream.focusedWorkstreamId && stream.focusedRequestId
      ? activeWorkstream?.workstream.workstreamId === stream.focusedWorkstreamId
          && activeWorkstream.selectedRequest?.id === stream.focusedRequestId
        ? activeWorkstream
        : await this.loadFocusedWorkstream?.(stream)
      : undefined;
    const currentRunInputText = run
      ? requireRunInputText(this.database, run.run.runId)
      : input.currentText;
    const workstreamCandidates = !activeWorkstream && this.loadWorkstreamCandidates
      ? await this.loadWorkstreamCandidates({
          streamId: stream.streamId,
          ...(currentRunInputText ? { currentText: currentRunInputText } : {}),
        })
      : undefined;
    const ingressResources = run ? readRunResources(this.database, run.run.runId) : undefined;
    const repositoryState = readSharedWorkstreamRepositoryState(this.database);
    const workstreamRepository = repositoryState ? {
      path: repositoryState.repositoryPath,
      branch: repositoryState.branch,
      head: repositoryState.head,
      health: repositoryState.health,
      kind: "context_only_git" as const,
      access: "read_only" as const,
    } : undefined;
    const streamProjection = {
      stream,
      ...(checkpoint ? { checkpoint } : {}),
      ...(focusedWorkstream ? { focusedWorkstream } : {}),
      recentMessages,
      recentWorkstreams,
      recentFiles,
      recentWorkStates,
      ...(resources.count > 0 ? { resources } : {}),
    };
    const streamRevision = revision("stream", {
      streamId: stream.streamId,
      checkpointId: checkpoint?.checkpointId,
      focusedWorkstream: focusedWorkstream
        ? [
            focusedWorkstream.workstream.workstreamId,
            focusedWorkstream.workstream.head,
            focusedWorkstream.selectedRequest?.id,
            focusedWorkstream.selectedRequest?.status,
          ]
        : undefined,
      messages: recentMessages.map((message) => [
        message.messageId,
        message.sequence,
        message.contentHash,
        message.responseKind,
        message.feedbackKind,
        message.attachmentRefs?.map((resource) => resource.resourceId),
      ]),
      workstreams: recentWorkstreams,
      files: recentFiles,
      workStates: recentWorkStates,
      resources: resources.recent.map((resource) => [
        resource.resourceId,
        resource.version.key,
      ]),
    });
    const runRevision = run ? revision("run", run) : undefined;
    const firstExpectedSequence = (checkpoint?.coveredToSeq ?? 0) + 1;
    const warnings = recentMessages.length === MAX_EXACT_STREAM_MESSAGES
      && recentMessages[0]?.sequence !== firstExpectedSequence
      ? ["Exact stream tail exceeds the projection ceiling; checkpoint maintenance is required."]
      : [];
    if (stream.focusedWorkstreamId && stream.focusedRequestId && !focusedWorkstream) {
      warnings.push(
        `Focused workstream context is unavailable: ${stream.focusedWorkstreamId}/${stream.focusedRequestId}.`,
      );
    }
    const contextRevision = revision("context", {
      streamRevision,
      runRevision,
      workstreamHead: activeWorkstream?.workstream.head,
      candidateHeads: workstreamCandidates?.map((candidate) => [candidate.workstreamId, candidate.head]),
      workstreamRepository,
    });
    return {
      contextRevision,
      streamRevision,
      ...(runRevision ? { runRevision } : {}),
      ...(workstreamRepository ? { workstreamRepository } : {}),
      stream: streamProjection,
      ...(activeWorkstream ? { activeWorkstream } : {}),
      ...(workstreamCandidates && workstreamCandidates.length > 0 ? { workstreamCandidates } : {}),
      ...(ingressResources && ingressResources.length > 0 ? { ingressResources } : {}),
      ...(run ? { run } : {}),
      warnings,
    };
  }

  private resolveStream(input: GetAgentContextRequest): AgentStreamRef | undefined {
    if (input.streamId) return readAgentStream(this.database, input.streamId);
    if (input.agentId) {
      return readAgentStreamByScope(this.database, input.agentId, input.scopeKey ?? "default");
    }
    return readLatestAgentStream(this.database);
  }
}

function readActiveRunProjection(
  database: ContextDatabase,
  streamId: string,
): RunContextProjection | undefined {
  const ref = readActiveRun(database, streamId);
  if (!ref) return undefined;
  const run = readRunEvidence(database, ref.runId);
  const workState = readRunWorkState(database, ref.runId);
  if (!run || !workState) throw new Error("Active run context is incomplete: " + ref.runId);
  return {
    run,
    workState,
    steps: readRunStepEvidence(database, ref.runId),
  };
}

function requireRunInputText(database: ContextDatabase, runId: string): string {
  const message = readRunIngressMessage(database, runId);
  if (!message) {
    throw new Error("Active run ingress message is missing: " + runId);
  }
  return message.content;
}

function emptyContext(): AgentContextProjection {
  const streamRevision = revision("stream", null);
  return {
    contextRevision: revision("context", { streamRevision }),
    streamRevision,
    stream: null,
    warnings: [],
  };
}

function revision(namespace: string, value: unknown): string {
  return namespace + ":" + createHash("sha256")
    .update(canonicalJson(value))
    .digest("hex")
    .slice(0, 24);
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const record = value as Record<string, unknown>;
  return "{" + Object.keys(record).sort().map((key) =>
    JSON.stringify(key) + ":" + canonicalJson(record[key])
  ).join(",") + "}";
}
