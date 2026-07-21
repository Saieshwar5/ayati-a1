import type {
  AgentContextProjection,
  ContextEngineService,
  WorkstreamCandidate,
  WorkstreamResolutionUsage,
} from "ayati-context-engine";
import type { LlmProvider } from "../../core/contracts/provider.js";
import type { LlmTurnOutput } from "../../core/contracts/llm-protocol.js";
import { buildContextEngineProjection } from "../../context-engine/index.js";
import {
  callWorkstreamResolutionDecision,
  ResolutionDecisionError,
  type ResolutionDecisionContext,
} from "./decision.js";
import { executeResolutionDecision } from "./executor.js";
import { reduceResolutionWorkState } from "./reducer.js";
import type {
  ResolutionDecisionRecord,
  ResolutionStepHistory,
  ResolutionToolCallRecord,
  ResolutionWorkState,
  WorkstreamResolutionCoordinator,
  WorkstreamResolutionOutcome,
} from "./types.js";

const LIMITS = {
  maxTurns: 6,
  maxToolCalls: 16,
  maxParallelCalls: 4,
  maxFailedSteps: 2,
};

export interface WorkstreamResolutionCoordinatorOptions {
  provider: LlmProvider;
  service: ContextEngineService;
  runId: string;
  streamId: string;
  currentInput: string;
  inputContextRevision: string;
  now?: () => Date;
}

export function createWorkstreamResolutionCoordinator(
  options: WorkstreamResolutionCoordinatorOptions,
): WorkstreamResolutionCoordinator {
  return {
    resolve: async (request) => await runWorkstreamResolution({ ...options, request }),
  };
}

async function runWorkstreamResolution(
  input: WorkstreamResolutionCoordinatorOptions & {
    request: Parameters<WorkstreamResolutionCoordinator["resolve"]>[0];
  },
): Promise<WorkstreamResolutionOutcome> {
  const now = input.now ?? (() => new Date());
  const initialContext = await input.service.getAgentContext({
    streamId: input.streamId,
    currentText: input.currentInput,
  });
  if (initialContext.contextRevision !== input.inputContextRevision) {
    throw new Error(
      `WORKSTREAM_RESOLUTION_CONTEXT_STALE: expected ${input.inputContextRevision}, received ${initialContext.contextRevision}.`,
    );
  }
  const priorActivityId = initialContext.workstreamResolution?.status === "needs_user_input"
    ? initialContext.workstreamResolution.activityId
    : undefined;
  const startedAt = now().toISOString();
  const started = await input.service.startWorkstreamResolution({
    requestId: `${input.runId}:workstream-resolution:start`,
    runId: input.runId,
    streamId: input.streamId,
    input: {
      purpose: normalizePurpose(input.request.purpose),
      currentInput: input.currentInput,
      hints: input.request.hints.slice(0, 8),
      limits: {
        maxTurns: LIMITS.maxTurns,
        maxToolCalls: LIMITS.maxToolCalls,
        maxParallelCalls: LIMITS.maxParallelCalls,
      },
    },
    inputContextRevision: input.inputContextRevision,
    ...(priorActivityId ? { priorActivityId } : {}),
    at: startedAt,
  });
  const activityId = started.activity.activityId;
  let state = initialResolutionState(
    input.request.purpose,
    initialCandidates(initialContext),
  );
  const history: ResolutionStepHistory[] = [];
  let toolCallCount = 0;
  let failedSteps = 0;

  for (let turn = 1; turn <= LIMITS.maxTurns; turn++) {
    const snapshot = resolutionContextSnapshot({
      activityId,
      currentInput: input.currentInput,
      hints: input.request.hints,
      context: initialContext,
      state,
      history,
      remaining: {
        turns: LIMITS.maxTurns - turn + 1,
        toolCalls: LIMITS.maxToolCalls - toolCallCount,
      },
    });
    let raw: LlmTurnOutput | undefined;
    let decision: ResolutionDecisionRecord;
    let records: ResolutionToolCallRecord[];
    let terminal: WorkstreamResolutionOutcome | undefined;

    try {
      const selected = await callWorkstreamResolutionDecision({
        provider: input.provider,
        context: snapshot,
        maxParallelCalls: LIMITS.maxParallelCalls,
      });
      raw = selected.raw;
      decision = selected.decision;
      if (toolCallCount + decision.calls.length > LIMITS.maxToolCalls) {
        throw new ResolutionDecisionError(
          "RESOLUTION_TOOL_CALL_LIMIT",
          "Resolver decision exceeds the remaining private tool-call budget.",
        );
      }
      const executed = await executeResolutionDecision({
        service: input.service,
        activityId,
        runId: input.runId,
        streamId: input.streamId,
        currentInput: input.currentInput,
        state,
        decision,
        at: now().toISOString(),
      });
      records = executed.records;
      terminal = executed.terminal;
    } catch (error) {
      if (error instanceof ResolutionDecisionError) raw = error.raw;
      decision = { calls: [] };
      records = [decisionFailureRecord(turn, error)];
    }

    toolCallCount += decision.calls.length;
    state = reduceResolutionWorkState(state, records);
    const passed = records.length > 0 && records.every((record) => record.status === "completed");
    const verification = {
      passed,
      summary: passed
        ? "All resolver calls completed and returned typed results."
        : records.map((record) => record.error?.message).filter(Boolean).join(" ")
          || "Resolver decision failed deterministic validation.",
    };
    const step: ResolutionStepHistory = {
      step: turn,
      decision,
      toolCalls: records,
      verification,
      stateAfter: structuredClone(state),
    };
    const usage = resolutionUsage(raw);
    const persisted = await input.service.recordWorkstreamResolutionStep({
      requestId: `${activityId}:step:${turn}`,
      activityId,
      record: {
        version: 1,
        step: turn,
        status: passed ? "completed" : "failed",
        context: snapshot,
        decision,
        toolCalls: records,
        verification,
        stateAfter: state,
        ...(usage ? { usage } : {}),
        createdAt: now().toISOString(),
      },
    });
    history.push(step);

    if (terminal) {
      const latest = await input.service.getAgentContext({
        streamId: input.streamId,
        currentText: input.currentInput,
      });
      return refreshTerminalOutcome(terminal, latest, persisted.activity.stepCount);
    }

    if (!passed) {
      failedSteps++;
      if (failedSteps >= LIMITS.maxFailedSteps) {
        return await finishFailedResolution({
          service: input.service,
          activityId,
          runId: input.runId,
          streamId: input.streamId,
          state,
          stepCount: persisted.activity.stepCount,
          code: "WORKSTREAM_RESOLUTION_REPEATED_FAILURE",
          message: verification.summary,
          retryable: records.some((record) => record.error?.retryable),
          at: now().toISOString(),
        });
      }
    }
  }

  return await finishFailedResolution({
    service: input.service,
    activityId,
    runId: input.runId,
    streamId: input.streamId,
    state,
    stepCount: history.length,
    code: "WORKSTREAM_RESOLUTION_TURN_LIMIT",
    message: "Workstream resolution reached its six-turn limit without a safe binding or clarification.",
    retryable: true,
    at: now().toISOString(),
  });
}

function resolutionContextSnapshot(input: {
  activityId: string;
  currentInput: string;
  hints: ResolutionDecisionContext["hints"];
  context: AgentContextProjection;
  state: ResolutionWorkState;
  history: ResolutionStepHistory[];
  remaining: ResolutionDecisionContext["remaining"];
}): ResolutionDecisionContext {
  const messages = input.context.stream?.recentMessages ?? [];
  const previousConversation = messages
    .filter((message) => message.runId !== input.context.run?.run.runId)
    .slice(-2)
    .map((message) => ({ role: message.role, content: truncate(message.content, 2_000) }));
  return {
    activityId: input.activityId,
    currentInput: input.currentInput,
    hints: input.hints,
    previousConversation,
    ingressResources: input.context.ingressResources ?? [],
    initialCandidates: (input.context.workstreamCandidates ?? []).slice(0, 5),
    ...(input.context.workstreamResolution
      ? { priorResolution: input.context.workstreamResolution }
      : {}),
    state: input.state,
    history: input.history,
    remaining: input.remaining,
  };
}

function initialResolutionState(
  purpose: string,
  candidates: WorkstreamCandidate[],
): ResolutionWorkState {
  return {
    status: candidates.length > 0 ? "candidates_found" : "searching",
    purpose: normalizePurpose(purpose),
    searches: [],
    candidates: candidates.map((candidate) => ({
      candidate,
      inspected: false,
      possibleRequestIds: candidate.currentRequest ? [candidate.currentRequest.id] : [],
    })),
    resourceOwnership: [],
    failures: [],
    nextOperation: candidates.length > 0
      ? "Inspect the strongest candidate and verify request continuity."
      : "Search by exact hints, resource ownership, and current-input meaning.",
  };
}

function initialCandidates(context: AgentContextProjection): WorkstreamCandidate[] {
  const current = context.workstreamCandidates ?? [];
  const prior = context.workstreamResolution?.result?.status === "needs_user_input"
    ? context.workstreamResolution.result.candidates
    : [];
  const byId = new Map<string, WorkstreamCandidate>();
  for (const candidate of [...prior, ...current]) {
    if (!byId.has(candidate.workstreamId)) byId.set(candidate.workstreamId, candidate);
  }
  return [...byId.values()].slice(0, 5);
}

function decisionFailureRecord(turn: number, error: unknown): ResolutionToolCallRecord {
  const code = error instanceof ResolutionDecisionError
    ? error.code
    : "WORKSTREAM_RESOLUTION_DECISION_FAILED";
  return {
    id: `resolution-decision-${turn}`,
    tool: "resolution_decision",
    input: {},
    status: "failed",
    error: {
      code,
      message: error instanceof Error ? error.message : String(error),
      retryable: true,
    },
  };
}

function resolutionUsage(raw: LlmTurnOutput | undefined): WorkstreamResolutionUsage | undefined {
  if (!raw?.usage) return undefined;
  return {
    provider: raw.usage.provider,
    model: raw.usage.model,
    inputTokens: raw.usage.inputTokens,
    outputTokens: raw.usage.outputTokens,
    totalTokens: raw.usage.totalTokens,
    ...(raw.usage.cachedInputTokens !== undefined
      ? { cachedInputTokens: raw.usage.cachedInputTokens }
      : {}),
    ...(raw.cost ? { costUsd: raw.cost.totalCostUsd } : {}),
  };
}

async function finishFailedResolution(input: {
  service: ContextEngineService;
  activityId: string;
  runId: string;
  streamId: string;
  state: ResolutionWorkState;
  stepCount: number;
  code: string;
  message: string;
  retryable: boolean;
  at: string;
}): Promise<WorkstreamResolutionOutcome> {
  const result = {
    status: "failed" as const,
    code: input.code,
    message: input.message,
    retryable: input.retryable,
  };
  const response = await input.service.finishWorkstreamResolution({
    requestId: `${input.activityId}:failed`,
    activityId: input.activityId,
    runId: input.runId,
    result,
    finalState: {
      ...input.state,
      status: "failed",
      failures: [
        ...input.state.failures,
        { code: input.code, message: input.message, retryable: input.retryable },
      ].slice(-8),
    },
    at: input.at,
  });
  return {
    receipt: {
      status: "failed",
      activityId: input.activityId,
      code: input.code,
      retryable: input.retryable,
      stepCount: input.stepCount,
      contextRevision: response.context.contextRevision,
    },
    context: buildContextEngineProjection(response.context),
  };
}

function refreshTerminalOutcome(
  outcome: WorkstreamResolutionOutcome,
  context: AgentContextProjection,
  stepCount: number,
): WorkstreamResolutionOutcome {
  const receipt = outcome.receipt.status === "resolved"
    ? { ...outcome.receipt, stepCount, contextRevision: context.contextRevision }
    : outcome.receipt.status === "needs_user_input"
      ? { ...outcome.receipt, stepCount, contextRevision: context.contextRevision }
      : { ...outcome.receipt, stepCount, contextRevision: context.contextRevision };
  return { receipt, context: buildContextEngineProjection(context) };
}

function normalizePurpose(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length === 0 || normalized.length > 500) {
    throw new Error("workstream_resolve purpose must contain between 1 and 500 characters.");
  }
  return normalized;
}

function truncate(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  return value.slice(0, maximum - 3).trimEnd() + "...";
}
