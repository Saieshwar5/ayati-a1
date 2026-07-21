import type {
  AgentContextProjection,
  ReusableObservationProjection,
  RunContextProjection,
  StreamMessage,
} from "ayati-context-engine";
import {
  buildContextEngineProjection,
  type ContextEngineMachineContext,
} from "../../src/context-engine/index.js";

const AT = "2026-07-19T10:00:00.000Z";

export interface AgentContextFixtureOptions {
  contextRevision?: string;
  streamId?: string;
  runId?: string;
  message?: string;
  observations?: ReusableObservationProjection;
  includeRun?: boolean;
}

export function agentContextFixture(
  options: AgentContextFixtureOptions = {},
): AgentContextProjection {
  const streamId = options.streamId ?? "S-1";
  const runId = options.runId ?? "RUN-1";
  const includeRun = options.includeRun ?? true;
  const messages: StreamMessage[] = includeRun
    ? [{
        messageId: "M-1",
        streamId,
        runId,
        sequence: 1,
        role: "user",
        content: options.message ?? "Current request",
        contentHash: "sha256:message",
        at: AT,
      }]
    : [];
  return {
    contextRevision: options.contextRevision ?? "revision-1",
    streamRevision: "stream-revision-1",
    ...(includeRun ? { runRevision: "run-revision-1" } : {}),
    observationRevision: options.observations?.revision ?? "observations:empty",
    stream: {
      stream: {
        streamId,
        agentId: "local",
        scopeKey: "default",
        lastMessageSequence: messages.length,
        lastRunSequence: includeRun ? 1 : 0,
        createdAt: AT,
        updatedAt: AT,
      },
      recentMessages: messages,
      recentWork: [],
      resources: { count: 0, recent: [] },
    },
    ...(includeRun ? { run: runFixture(runId, streamId) } : {}),
    observations: options.observations ?? emptyObservations(),
    warnings: [],
  };
}

export function contextEngineFixture(
  options: AgentContextFixtureOptions = {},
): ContextEngineMachineContext {
  return buildContextEngineProjection(agentContextFixture(options));
}

export function emptyObservations(): ReusableObservationProjection {
  return {
    revision: "observations:empty",
    inventory: [],
    discovery: [],
    evidence: [],
  };
}

function runFixture(runId: string, streamId: string): RunContextProjection {
  return {
    run: {
      runId,
      streamId,
      status: "running",
      trigger: "user",
      startedAt: AT,
      stepCount: 0,
    },
    workState: {
      runId,
      revision: 0,
      afterStep: 0,
      status: "not_done",
      summary: "",
      openWork: [],
      blockers: [],
      facts: [],
      evidence: [],
      artifacts: [],
      nextStep: null,
      userInputNeeded: [],
      updatedAt: AT,
    },
    steps: [],
  };
}
