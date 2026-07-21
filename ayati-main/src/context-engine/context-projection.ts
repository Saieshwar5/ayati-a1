import type { AgentContextProjection, StreamMessage } from "ayati-context-engine";
import type {
  ContextCurrentRouting,
  ContextEngineMachineContext,
  ContextWorkstreamProjection,
} from "./contracts.js";

export function buildContextEngineProjection(
  context: AgentContextProjection,
): ContextEngineMachineContext {
  const stream = context.stream;
  const run = context.run?.run;
  const input = currentInput(context);
  const activeWorkstream = context.activeWorkstream;
  const workstreamResolution = context.workstreamResolution;
  const workstreamBound = Boolean(
    activeWorkstream
      && run?.workstreamBinding?.workstreamId === activeWorkstream.workstream.workstreamId,
  );

  return {
    contextRevision: context.contextRevision,
    streamRevision: context.streamRevision,
    ...(context.runRevision ? { runRevision: context.runRevision } : {}),
    observationRevision: context.observationRevision,
    agentStream: stream
      ? {
          meta: {
            streamId: stream.stream.streamId,
            agentId: stream.stream.agentId,
            scopeKey: stream.stream.scopeKey,
            createdAt: stream.stream.createdAt,
            updatedAt: stream.stream.updatedAt,
            lastMessageSequence: stream.stream.lastMessageSequence,
            lastRunSequence: stream.stream.lastRunSequence,
            resourceCount: stream.resources?.count ?? 0,
          },
          ...(stream.checkpoint ? { checkpoint: stream.checkpoint } : {}),
          recentMessages: stream.recentMessages,
          recentWork: stream.recentWork,
          resources: stream.resources?.recent ?? [],
        }
      : emptyAgentStream(),
    current: {
      ...(input ? { inputSeq: input.sequence } : {}),
      ...(run ? { runId: run.runId } : {}),
      ...(run && stream ? {
        routing: currentRouting({
          binding: run.workstreamBinding,
          branch: workstreamBound ? activeWorkstream?.workstream.branch : undefined,
          resolutionStatus: workstreamResolution?.runId === run.runId
            ? workstreamResolution.status
            : undefined,
        }),
      } : {}),
    },
    focus: workstreamBound && activeWorkstream
      ? {
          status: "active",
          ref: "refs/heads/" + activeWorkstream.workstream.branch,
          workstreamId: activeWorkstream.workstream.workstreamId,
        }
      : { status: "none" },
    observations: context.observations,
    ...(context.run ? { run: context.run } : {}),
    ...(!workstreamBound && context.workstreamCandidates && context.workstreamCandidates.length > 0
      ? { workstreamCandidates: context.workstreamCandidates.slice(0, 5) }
      : {}),
    ...(workstreamResolution ? { workstreamResolution } : {}),
    ...(context.ingressResources && context.ingressResources.length > 0
      ? { ingressResources: context.ingressResources }
      : {}),
    ...(workstreamBound && activeWorkstream
      ? { workstream: projectWorkstream(activeWorkstream) }
      : {}),
    warnings: context.warnings,
  };
}

function emptyAgentStream(): ContextEngineMachineContext["agentStream"] {
  return {
    meta: {
      streamId: "unavailable",
      agentId: "local",
      scopeKey: "default",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      lastMessageSequence: 0,
      lastRunSequence: 0,
      resourceCount: 0,
    },
    recentMessages: [],
    recentWork: [],
    resources: [],
  };
}

function currentInput(context: AgentContextProjection): StreamMessage | undefined {
  const runId = context.run?.run.runId;
  if (!runId) return undefined;
  return [...(context.stream?.recentMessages ?? [])]
    .reverse()
    .find((message) => message.runId === runId && message.role !== "assistant");
}

function currentRouting(input: {
  binding?: { workstreamId: string; requestId: string };
  branch?: string;
  resolutionStatus?: string;
}): ContextCurrentRouting {
  return {
    status: input.binding
      ? "bound"
      : input.resolutionStatus === "needs_user_input"
        ? "clarifying"
        : "unbound",
    ...(input.binding ? {
      workstreamId: input.binding.workstreamId,
      requestId: input.binding.requestId,
    } : {}),
    ...(input.branch ? { branch: input.branch } : {}),
  };
}

function projectWorkstream(
  context: NonNullable<AgentContextProjection["activeWorkstream"]>,
): ContextWorkstreamProjection {
  return {
    ref: "refs/heads/" + context.workstream.branch,
    workstreamId: context.workstream.workstreamId,
    title: context.title,
    objective: context.objective,
    summary: context.summary,
    workstreamStatus: context.workstreamStatus
      ?? (context.latestOutcome === "done"
        ? "done"
        : context.latestOutcome === "blocked"
          ? "blocked"
          : "in_progress"),
    lifecycleStatus: context.lifecycleStatus ?? "active",
    repositoryHealth: context.repositoryHealth ?? "ready",
    ...(context.currentFocus ? { currentFocus: context.currentFocus } : {}),
    blockers: context.blockers ?? [],
    ...(context.next ? { next: context.next } : {}),
    ...(context.currentRequest ? { currentRequest: context.currentRequest } : {}),
    resources: context.resources ?? [],
  };
}
