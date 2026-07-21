import { createHash } from "node:crypto";
import type {
  AgentRunHandle,
  ContextCheckpointPlan,
  ContextCheckpointRecord,
  FinalizeRunResponse,
  ContextEngineService,
  ResourceAdmission,
  RunOutcome,
  RunStepRecord,
  RunStopReason,
  RunWorkStateInput,
  WorkstreamCompletionRecord,
} from "ayati-context-engine";
import { ContextEngineObserver } from "ayati-context-engine";
import {
  buildContextEngineProjection,
  type ContextEngineMachineContext,
  type ContextRunStepRecord,
} from "../context-engine/index.js";
import { compactWorkState } from "../ivec/state-compaction.js";
import type { AgentContextCheckpointCoordinator } from "../ivec/types.js";
import { getToolTaxonomy } from "../skills/tool-taxonomy.js";

export interface ContextEnginePreparedTurn {
  status: "ready";
  streamId: string;
  streamCreated: boolean;
  messageSequence: number;
  currentMessageId: string;
  inputRole: "user" | "system_event";
  run: AgentRunHandle;
  context: ContextEngineMachineContext;
}

export interface ContextEngineFinalizeRunInput {
  turn: ContextEnginePreparedTurn | null;
  outcome: RunOutcome;
  stopReason: RunStopReason;
  assistantResponse: string;
  streamSummary: string;
  summary: string;
  validation: "passed" | "failed" | "not_applicable";
  next?: string;
  workState?: unknown;
  workstreamCompletion?: WorkstreamCompletionRecord;
  at: string;
}

export interface ContextEngineRuntimeOptions {
  service: ContextEngineService;
  timezone: string;
  agentId: string;
  scopeKey?: string;
  observer?: ContextEngineObserver;
  onContextCheckpointCommitted?: (input: {
    streamId: string;
    plan: ContextCheckpointPlan;
    checkpoint: ContextCheckpointRecord;
  }) => void | Promise<void>;
}

export interface ContextEngineRuntime {
  prepareUserTurn(input: {
    clientId: string;
    userMessage: string;
    resources?: ResourceAdmission[];
    at: string;
  }): Promise<ContextEnginePreparedTurn>;
  prepareSystemEventTurn(input: {
    clientId: string;
    systemMessage: string;
    at: string;
  }): Promise<ContextEnginePreparedTurn>;
  finalizeRun(input: ContextEngineFinalizeRunInput): Promise<FinalizeRunResponse | null>;
  recordRunStep(input: {
    turn: ContextEnginePreparedTurn | null;
    record: ContextRunStepRecord;
  }): Promise<ContextEngineMachineContext | null>;
  contextCheckpointCoordinator(turn: ContextEnginePreparedTurn): AgentContextCheckpointCoordinator;
}

export function createContextEngineRuntime(options: ContextEngineRuntimeOptions): ContextEngineRuntime {
  return new AppContextEngineRuntime(options);
}

class AppContextEngineRuntime implements ContextEngineRuntime {
  private readonly observer: ContextEngineObserver;

  constructor(private readonly options: ContextEngineRuntimeOptions) {
    this.observer = options.observer ?? new ContextEngineObserver("context-engine-harness");
  }

  async prepareUserTurn(input: {
    clientId: string;
    userMessage: string;
    resources?: ResourceAdmission[];
    at: string;
  }): Promise<ContextEnginePreparedTurn> {
    return await this.prepareInput(
      input.clientId,
      "user",
      input.userMessage,
      input.at,
      input.resources,
    );
  }

  async prepareSystemEventTurn(input: {
    clientId: string;
    systemMessage: string;
    at: string;
  }): Promise<ContextEnginePreparedTurn> {
    return await this.prepareInput(
      input.clientId,
      "system_event",
      input.systemMessage,
      input.at,
    );
  }

  async finalizeRun(input: ContextEngineFinalizeRunInput): Promise<FinalizeRunResponse | null> {
    if (!input.turn) return null;
    const turn = input.turn;
    const routing = turn.context.current.routing;
    this.observer.emit({
      level: "info",
      event: "run_finalization_started",
      streamId: turn.streamId,
      seq: turn.messageSequence,
      runId: turn.run.runId,
      workstreamId: routing?.workstreamId,
      data: {
        outcome: input.outcome,
        stopReason: input.stopReason,
        workstreamBound: routing?.status === "bound",
      },
    });
    try {
      const response = await this.options.service.finalizeRun({
        requestId: operationRequestId(turn.run.runId, "finalize"),
        runId: turn.run.runId,
        outcome: input.outcome,
        stopReason: input.stopReason,
        assistantResponse: input.assistantResponse,
        streamSummary: input.streamSummary,
        summary: input.summary,
        validation: input.validation,
        ...(input.next ? { next: input.next } : {}),
        workState: toRunWorkState(input.workState, input.outcome),
        ...(input.workstreamCompletion
          ? { workstream: { completion: input.workstreamCompletion } }
          : {}),
        at: input.at,
      });
      this.observer.emit({
        level: "info",
        event: "run_finalization_completed",
        streamId: turn.streamId,
        seq: turn.messageSequence,
        runId: response.run.runId,
        workstreamId: response.run.workstreamBinding?.workstreamId,
        outcome: "succeeded",
        data: {
          outcome: response.run.status,
          stopReason: response.run.stopReason,
          workstreamBinding: response.run.workstreamBinding,
          assistantMessageId: response.assistantMessage?.messageId,
          observationRevision: response.observationRevision,
          resourceEffects: response.resourceEffects,
          workstreamContextCommit: response.workstreamContextCommit,
        },
      });
      if (response.workstreamContextCommit.status === "committed") {
        this.observer.emit({
          level: "info",
          event: "workstream_context_commit_created",
          streamId: turn.streamId,
          seq: turn.messageSequence,
          runId: response.run.runId,
          workstreamId: response.workstreamContextCommit.workstreamId,
          outcome: "succeeded",
          data: response.workstreamContextCommit,
        });
      }
      return response;
    } catch (error) {
      this.observer.emit({
        level: "error",
        event: "run_finalization_failed",
        streamId: turn.streamId,
        seq: turn.messageSequence,
        runId: turn.run.runId,
        outcome: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async recordRunStep(input: {
    turn: ContextEnginePreparedTurn | null;
    record: ContextRunStepRecord;
  }): Promise<ContextEngineMachineContext | null> {
    if (!input.turn) return null;
    const turn = input.turn;
    const record = toRunStepRecord(input.record);
    this.observer.emit({
      level: "debug",
      event: "run_step_persistence_queued",
      streamId: turn.streamId,
      seq: turn.messageSequence,
      runId: turn.run.runId,
      step: record.step,
      data: { tools: record.toolCalls.map((call) => call.tool) },
    });
    try {
      const response = await this.options.service.recordRunStep({
        requestId: operationRequestId(turn.run.runId, "step-" + record.step),
        runId: turn.run.runId,
        record,
      });
      const projection = buildContextEngineProjection(response.context);
      turn.context = projection;
      this.observer.emit({
        level: "info",
        event: "run_step_persisted",
        streamId: turn.streamId,
        seq: turn.messageSequence,
        runId: turn.run.runId,
        step: record.step,
        outcome: "succeeded",
        data: {
          workStateRevision: response.run.workState.revision,
          afterStep: response.run.workState.afterStep,
          contextRevision: response.context.contextRevision,
          observationRevision: response.context.observationRevision,
          observationCounts: {
            inventory: response.context.observations.inventory.length,
            discovery: response.context.observations.discovery.length,
            evidence: response.context.observations.evidence.length,
            total: response.context.observations.inventory.length
              + response.context.observations.discovery.length
              + response.context.observations.evidence.length,
          },
        },
      });
      return projection;
    } catch (error) {
      this.observer.emit({
        level: "error",
        event: "run_step_persistence_failed",
        streamId: turn.streamId,
        seq: turn.messageSequence,
        runId: turn.run.runId,
        step: record.step,
        outcome: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  contextCheckpointCoordinator(turn: ContextEnginePreparedTurn): AgentContextCheckpointCoordinator {
    return {
      plan: async (input) => await this.options.service.planContextCheckpoint({
        requestId: operationRequestId(
          turn.run.runId,
          `checkpoint-plan-${input.protectFromSeq}-${input.requiredSavingsTokens}`,
        ),
        streamId: turn.streamId,
        protectFromSeq: input.protectFromSeq,
        requiredSavingsTokens: input.requiredSavingsTokens,
        estimatedCheckpointTokens: input.estimatedCheckpointTokens,
        at: new Date().toISOString(),
      }),
      commit: async (input): Promise<ContextCheckpointRecord> => {
        const response = await this.options.service.commitContextCheckpoint({
          requestId: operationRequestId(turn.run.runId, `checkpoint-commit-${input.plan.planId}`),
          plan: input.plan,
          summary: input.summary,
          tokenCount: input.tokenCount,
          provider: input.provider,
          model: input.model,
          at: new Date().toISOString(),
        });
        const projection = buildContextEngineProjection(response.context);
        turn.context = projection;
        if (this.options.onContextCheckpointCommitted) {
          void Promise.resolve(this.options.onContextCheckpointCommitted({
            streamId: turn.streamId,
            plan: input.plan,
            checkpoint: response.checkpoint,
          })).catch((error: unknown) => {
            this.observer.emit({
              level: "error",
              event: "checkpoint_memory_extraction_failed",
              streamId: turn.streamId,
              runId: turn.run.runId,
              outcome: "failed",
              message: error instanceof Error ? error.message : String(error),
            });
          });
        }
        return response.checkpoint;
      },
    };
  }

  private async prepareInput(
    clientId: string,
    role: "user" | "system_event",
    content: string,
    at: string,
    resources?: ResourceAdmission[],
  ): Promise<ContextEnginePreparedTurn> {
    const requestId = preparationRequestId(clientId, role, content, at);
    const prepared = await this.options.service.prepareAgentRun({
      requestId,
      timezone: this.options.timezone,
      agentId: this.options.agentId,
      scopeKey: this.options.scopeKey ?? "default",
      role,
      content,
      ...(resources && resources.length > 0 ? { resources } : {}),
      at,
    });
    const context = buildContextEngineProjection(prepared.context);
    const run: AgentRunHandle = {
      runId: prepared.run.runId,
      streamId: prepared.stream.streamId,
      triggerSeq: prepared.message.sequence,
    };
    this.observer.emit({
      level: "info",
      event: "run_started",
      requestId,
      streamId: prepared.stream.streamId,
      runId: run.runId,
      outcome: "succeeded",
      data: {
        contextRevision: prepared.context.contextRevision,
        messageSequence: prepared.message.sequence,
        streamCreated: prepared.streamCreated,
      },
    });
    return {
      status: "ready",
      streamId: prepared.stream.streamId,
      streamCreated: prepared.streamCreated,
      messageSequence: prepared.message.sequence,
      currentMessageId: prepared.message.messageId,
      inputRole: role,
      run,
      context,
    };
  }
}

function toRunStepRecord(record: ContextRunStepRecord): RunStepRecord {
  return {
    version: 1,
    step: record.step,
    status: record.status === "failed"
      ? "failed"
      : record.status === "skipped"
        ? "blocked"
        : "completed",
    summary: record.summary,
    ...(record.decision ? { decision: record.decision } : {}),
    ...(record.action ? { action: record.action } : {}),
    toolCalls: record.toolCalls.map((call) => {
      const taxonomy = getToolTaxonomy(call.tool);
      if (!taxonomy) {
        throw new Error("Unknown tool taxonomy for persisted run step: " + call.tool);
      }
      return {
        ...(call.callId ? { callId: call.callId } : {}),
        tool: call.tool,
        purpose: call.purpose?.trim() || "Execute " + call.tool + ".",
        toolPurpose: taxonomy.purpose,
        toolEffect: taxonomy.effect,
        status: call.status,
        input: call.input,
        ...(call.output !== undefined ? { output: call.output } : {}),
        ...(call.error !== undefined ? { error: call.error } : {}),
      };
    }),
    verification: record.verification,
    workStateAfter: toRunWorkState(record.workStateAfter),
    createdAt: record.completedAt,
  };
}

function toRunWorkState(value: unknown, outcome?: RunOutcome): RunWorkStateInput {
  const state = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const inferredStatus = outcome === "done"
    ? "done"
    : outcome === "blocked"
      ? "blocked"
      : outcome === "needs_user_input"
        ? "needs_user_input"
        : "not_done";
  const status = ["not_done", "done", "blocked", "needs_user_input"].includes(
    String(state["status"]),
  )
    ? state["status"] as RunWorkStateInput["status"]
    : inferredStatus;
  const fallbackSummary = outcome
    ? "Run ended with outcome " + outcome + "."
    : "Run in progress.";
  const summary = typeof state["summary"] === "string" && state["summary"].trim()
    ? state["summary"]
    : fallbackSummary;
  const userInputNeeded = typeof state["userInputNeeded"] === "string"
    ? state["userInputNeeded"]
    : strings(state["userInputNeeded"]).find((item) => item.trim().length > 0);
  const compacted = compactWorkState({
    status,
    summary,
    openWork: strings(state["openWork"]),
    blockers: strings(state["blockers"]),
    verifiedFacts: strings(state["verifiedFacts"] ?? state["facts"]),
    evidence: strings(state["evidence"]),
    artifacts: strings(state["artifacts"]),
    ...(typeof state["nextStep"] === "string" ? { nextStep: state["nextStep"] } : {}),
    ...(userInputNeeded ? { userInputNeeded } : {}),
  });
  return {
    status: compacted.status,
    summary: compacted.summary,
    openWork: compacted.openWork ?? [],
    blockers: compacted.blockers ?? [],
    facts: compacted.verifiedFacts,
    evidence: compacted.evidence,
    artifacts: compacted.artifacts ?? [],
    nextStep: compacted.nextStep ?? null,
    userInputNeeded: compacted.userInputNeeded ? [compacted.userInputNeeded] : [],
  };
}

function preparationRequestId(
  clientId: string,
  role: "user" | "system_event",
  content: string,
  at: string,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({ clientId, role, content, at }))
    .digest("hex")
    .slice(0, 24);
  return "prepare:" + digest;
}

function operationRequestId(runId: string, operation: string): string {
  return runId + ":" + operation;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
