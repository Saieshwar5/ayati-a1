import type { LlmProvider } from "../core/contracts/provider.js";
import type { AyatiSystemEvent } from "../core/contracts/plugin.js";
import type { StaticContext } from "../context/static-context-cache.js";
import type { DocumentStore } from "../documents/document-store.js";
import type { PreparedAttachmentRegistry } from "../documents/prepared-attachment-registry.js";
import type { DirectoryLibrary } from "../files/directory-library.js";
import type { FileLibrary } from "../files/file-library.js";
import type { AgentResponseKind, RunRecorder, SessionInputHandle } from "../memory/types.js";
import type { AgentRunHandle, FinalizeRunResponse } from "ayati-git-context";
import type { SkillActivationManager } from "../skills/activation-manager.js";
import type { ToolExecutor } from "../skills/tool-executor.js";
import type { ToolDefinition } from "../skills/types.js";
import { devError, devLog } from "../shared/index.js";
import { agentLoop } from "../ivec/agent-loop.js";
import type { ToolWorkingSetManager } from "../ivec/agent-runner/tool-working-set.js";
import { summarizeHarnessContext } from "../ivec/agent-runner/feedback-summary.js";
import {
  buildContextEngineFeedbackSummary,
  type AgentFeedbackLedger,
} from "../ivec/feedback-ledger.js";
import {
  classifySystemEvent,
  resolveSystemEventPolicy,
  type ResolvedSystemEventPolicy,
  type SystemEventClassification,
  type SystemEventHandlingMode,
  type SystemEventPolicyConfig,
} from "../ivec/system-event-policy.js";
import type { SystemEventRuntime, SystemEventRuntimeInput } from "../ivec/system-event-runtime.js";
import type {
  AgentArtifact,
  AgentLoopResult,
  LoopConfig,
  SystemEventApprovalState,
} from "../ivec/types.js";
import { buildStaticSystemContext } from "./static-prompt.js";
import type {
  GitContextPreparedTurn,
  GitContextRuntime,
} from "./git-context-runtime.js";
import { finalizeAgentRun, isWorkstreamBoundRun } from "./run-finalization-coordinator.js";

export interface CreateSystemEventRuntimeOptions {
  onReply?: (clientId: string, data: unknown) => void;
  provider?: LlmProvider;
  staticContext?: StaticContext;
  systemEventContextRuntime: GitContextRuntime;
  toolExecutor?: ToolExecutor;
  skillActivationManager?: SkillActivationManager;
  toolWorkingSetManager?: ToolWorkingSetManager;
  loopConfig?: Partial<LoopConfig>;
  now?: () => Date;
  dataDir?: string;
  documentStore?: DocumentStore;
  preparedAttachmentRegistry?: PreparedAttachmentRegistry;
  fileLibrary?: FileLibrary;
  directoryLibrary?: DirectoryLibrary;
  systemEventPolicy?: SystemEventPolicyConfig;
  feedbackLedger?: AgentFeedbackLedger;
}

interface SystemEventExecutionPlan {
  classification: SystemEventClassification;
  policy: ResolvedSystemEventPolicy;
  preferredResponseKind: AgentResponseKind;
  approvalState: SystemEventApprovalState;
  toolDefinitions: ToolDefinition[];
}

const systemEventRunRecorder: RunRecorder = {
  recordToolCall(): void {
    return;
  },
  recordToolResult(): void {
    return;
  },
  recordAssistantFinal(): void {
    return;
  },
  recordRunFailure(): void {
    return;
  },
  recordAgentStep(): void {
    return;
  },
};

export function createSystemEventRuntime(options: CreateSystemEventRuntimeOptions): SystemEventRuntime {
  return new AppSystemEventRuntime(options);
}

class AppSystemEventRuntime implements SystemEventRuntime {
  private readonly onReply?: (clientId: string, data: unknown) => void;
  private readonly provider?: LlmProvider;
  private readonly staticContext?: StaticContext;
  private readonly systemEventContextRuntime: GitContextRuntime;
  private readonly toolExecutor?: ToolExecutor;
  private readonly skillActivationManager?: SkillActivationManager;
  private readonly toolWorkingSetManager?: ToolWorkingSetManager;
  private readonly loopConfig?: Partial<LoopConfig>;
  private readonly nowProvider: () => Date;
  private readonly dataDir?: string;
  private readonly documentStore?: DocumentStore;
  private readonly preparedAttachmentRegistry?: PreparedAttachmentRegistry;
  private readonly fileLibrary?: FileLibrary;
  private readonly directoryLibrary?: DirectoryLibrary;
  private readonly systemEventPolicy?: SystemEventPolicyConfig;
  private readonly feedbackLedger?: AgentFeedbackLedger;

  constructor(options: CreateSystemEventRuntimeOptions) {
    this.onReply = options.onReply;
    this.provider = options.provider;
    this.staticContext = options.staticContext;
    this.systemEventContextRuntime = options.systemEventContextRuntime;
    this.toolExecutor = options.toolExecutor;
    this.skillActivationManager = options.skillActivationManager;
    this.toolWorkingSetManager = options.toolWorkingSetManager;
    this.loopConfig = options.loopConfig;
    this.nowProvider = options.now ?? (() => new Date());
    this.dataDir = options.dataDir;
    this.documentStore = options.documentStore;
    this.preparedAttachmentRegistry = options.preparedAttachmentRegistry;
    this.fileLibrary = options.fileLibrary;
    this.directoryLibrary = options.directoryLibrary;
    this.systemEventPolicy = options.systemEventPolicy;
    this.feedbackLedger = options.feedbackLedger;
  }

  async processSystemEvent(input: SystemEventRuntimeInput): Promise<void> {
    const { clientId, event } = input;
    let inputHandle: SessionInputHandle | null = null;
    let runHandle: AgentRunHandle | null = null;
    let preparedContextTurn: GitContextPreparedTurn | null = null;
    let finalizationAttempted = false;
    const incomingMessage = event.summary;
    const systemEventPlan = this.buildSystemEventExecutionPlan(event);
    const preferredResponseKind = systemEventPlan.preferredResponseKind;

    try {
      devLog(
        `[${clientId}] system_event start source=${event.source} eventName=${event.eventName} eventId=${event.eventId} summary=${event.summary}`,
      );
      preparedContextTurn = await this.prepareSystemEventContextTurn(clientId, event, systemEventPlan);
      inputHandle = this.inputHandleFromSystemContextTurn(preparedContextTurn);
      runHandle = preparedContextTurn.run;
      this.feedbackLedger?.record({
        clientId,
        sessionId: inputHandle.sessionId,
        seq: inputHandle.seq,
        stage: "message",
        event: "received",
        data: {
          kind: "system_event",
          source: event.source,
          eventName: event.eventName,
          eventId: event.eventId,
          summary: event.summary,
          policyMode: systemEventPlan.policy.mode,
        },
      });

      if (systemEventPlan.policy.mode === "log_only") {
        finalizationAttempted = true;
        await this.completeSystemEventContextRun(
          clientId,
          preparedContextTurn,
          systemEventResult(runHandle.runId, "none", ""),
        );
        return;
      }

      if (!this.provider) {
        devLog(`[${clientId}] system_event echo_mode eventId=${event.eventId}`);
        const result = systemEventResult(runHandle.runId, preferredResponseKind, event.summary);
        finalizationAttempted = true;
        const finalized = await this.completeSystemEventContextRun(clientId, preparedContextTurn, result);
        this.dispatchAgentResponse(clientId, runHandle, {
          type: preferredResponseKind,
          content: event.summary,
        }, {
          source: event.source,
          event: event.eventName,
          eventId: event.eventId,
        }, finalized);
        return;
      }

      const toolDefinitions = systemEventPlan.toolDefinitions;
      devLog(
        `[${clientId}] system_event entering agentLoop eventId=${event.eventId} mode=${systemEventPlan.policy.mode} intent=${systemEventPlan.classification.intentKind} approval=${systemEventPlan.policy.approvalRequired ? "required" : "not_required"} tools=${toolDefinitions.length} payloadKeys=${Object.keys(event.payload).join(",") || "none"}`,
      );
      const result = await agentLoop({
        provider: this.provider,
        toolExecutor: this.toolExecutor,
        skillActivationManager: this.skillActivationManager,
        toolWorkingSetManager: this.toolWorkingSetManager,
        toolDefinitions,
        runRecorder: systemEventRunRecorder,
        inputHandle,
        runHandle,
        recordRunStep: async (record, currentContext) => {
          const context = await this.systemEventContextRuntime.recordRunStep({
            clientId,
            turn: preparedContextTurn,
            record,
            currentContext: currentContext.contextEngine,
          });
          return context ? { contextEngine: context } : undefined;
        },
        clientId,
        inputKind: "system_event",
        systemEvent: event,
        systemEventIntentKind: systemEventPlan.classification.intentKind,
        systemEventRequestedAction: systemEventPlan.classification.requestedAction,
        systemEventCreatedBy: systemEventPlan.classification.createdBy,
        systemEventHandlingMode: systemEventPlan.policy.mode,
        systemEventApprovalRequired: systemEventPlan.policy.approvalRequired,
        systemEventApprovalState: systemEventPlan.approvalState,
        systemEventContextVisibility: systemEventPlan.policy.contextVisibility,
        preferredResponseKind,
        initialUserMessage: incomingMessage,
        config: this.loopConfig,
        dataDir: this.dataDir ?? "data",
        systemContext: buildStaticSystemContext(this.staticContext),
        harnessContext: { contextEngine: preparedContextTurn.context },
        feedbackLedger: this.feedbackLedger,
        fileLibrary: this.fileLibrary,
        directoryLibrary: this.directoryLibrary,
        documentStore: this.documentStore,
        preparedAttachmentRegistry: this.preparedAttachmentRegistry,
        onProgress: (log, _runPath) => {
          devLog(`[${clientId}] ${log}`);
          this.sendProgress(clientId, runHandle!, log);
        },
      });

      devLog(
        `[${clientId}] system_event agentLoop completed eventId=${event.eventId} status=${result.status} runPath=${result.runPath}`,
      );
      finalizationAttempted = true;
      const finalized = await this.completeSystemEventContextRun(clientId, preparedContextTurn, result);
      this.dispatchAgentResponse(clientId, runHandle, result, {
        source: event.source,
        event: event.eventName,
        eventId: event.eventId,
      }, finalized);
    } catch (err) {
      devError("System event processing error:", err);
      if (runHandle) {
        const message = err instanceof Error ? err.message : "Unknown runtime failure";
        this.feedbackLedger?.record({
          clientId,
          sessionId: runHandle.sessionId,
          runId: runHandle.runId,
          stage: "run",
          event: "failed",
          data: { message },
        });
      }
      if (runHandle && preparedContextTurn && !finalizationAttempted) {
        await this.completeSystemEventContextRun(
          clientId,
          preparedContextTurn,
          failedSystemEventResult(runHandle.runId, err),
        ).catch(() => undefined);
      }
      this.onReply?.(clientId, {
        type: "error",
        content: "Failed to process system event.",
      });
      throw err;
    }
  }

  private async prepareSystemEventContextTurn(
    clientId: string,
    event: AyatiSystemEvent,
    plan: SystemEventExecutionPlan,
  ): Promise<GitContextPreparedTurn> {
    const turn = await this.systemEventContextRuntime.prepareSystemEventTurn({
      clientId,
      systemMessage: this.formatSystemEventConversationMessage(event, plan),
      at: event.receivedAt,
    });
    const contextEngine = turn.context;
    this.feedbackLedger?.record({
      clientId,
      sessionId: turn.sessionId,
      seq: turn.messageSeq,
      stage: "context_engine",
      event: "prepared",
      data: {
        status: turn.status,
        messageSeq: turn.messageSeq,
        contextEngine: buildContextEngineFeedbackSummary({
          context: contextEngine,
          routeSource: "runtime",
        }),
        pendingTurnStatus: contextEngine.pendingTurn?.routingStatus ?? "none",
        context: summarizeHarnessContext({ contextEngine }),
      },
    });
    this.feedbackLedger?.record({
      clientId,
      sessionId: turn.sessionId,
      seq: turn.messageSeq,
      stage: "context_engine",
      event: "pending_turn_snapshot",
      data: {
        status: contextEngine.pendingTurn?.routingStatus ?? "none",
        pendingTurn: contextEngine.pendingTurn,
        contextEngine: buildContextEngineFeedbackSummary({
          context: contextEngine,
          routeSource: "runtime",
        }),
      },
    });
    return turn;
  }

  private async completeSystemEventContextRun(
    clientId: string,
    prepared: GitContextPreparedTurn,
    result: AgentLoopResult,
  ): Promise<FinalizeRunResponse> {
    const workstreamBound = isWorkstreamBoundRun(prepared, result);
    this.feedbackLedger?.record({
      clientId,
      sessionId: prepared.sessionId,
      seq: prepared.messageSeq,
      runId: prepared.run.runId,
      stage: "context_engine",
      event: "run_finalization_started",
      data: {
        outcome: result.outcome,
        stopReason: result.stopReason,
        workstreamBound,
      },
    });
    const finalized = await finalizeAgentRun({
      runtime: this.systemEventContextRuntime,
      turn: prepared,
      result,
      at: this.nowProvider().toISOString(),
      fallbackSummary: "System event recorded.",
    });
    this.feedbackLedger?.record({
      clientId,
      sessionId: prepared.sessionId,
      seq: prepared.messageSeq,
      runId: finalized.run.runId,
      stage: "context_engine",
      event: "run_finalization_completed",
      data: {
        outcome: finalized.run.status,
        stopReason: finalized.run.stopReason,
        workstreamBinding: finalized.run.workstreamBinding,
        materialization: finalized.materialization,
        resourceEffects: finalized.resourceEffects,
        workstreamContextCommit: finalized.workstreamContextCommit,
      },
    });
    return finalized;
  }

  private inputHandleFromSystemContextTurn(turn: GitContextPreparedTurn): SessionInputHandle {
    return {
      sessionId: turn.sessionId,
      seq: turn.messageSeq,
    };
  }

  private formatSystemEventConversationMessage(event: AyatiSystemEvent, plan: SystemEventExecutionPlan): string {
    return [
      `System event: ${event.source}/${event.eventName}`,
      `Event id: ${event.eventId}`,
      `Received at: ${event.receivedAt}`,
      `Summary: ${event.summary}`,
      `Mode: ${plan.policy.mode}`,
      `Intent: ${plan.classification.intentKind}`,
      `Event class: ${plan.classification.eventClass}`,
      `Trust: ${plan.classification.trustTier}`,
      `Effect: ${plan.classification.effectLevel}`,
      `Created by: ${plan.classification.createdBy}`,
      plan.classification.requestedAction
        ? `Requested action: ${plan.classification.requestedAction}`
        : undefined,
      event.payload && Object.keys(event.payload).length > 0
        ? `Payload: ${truncateText(safeJson(event.payload), 2_000)}`
        : undefined,
    ].filter((line): line is string => typeof line === "string" && line.length > 0).join("\n");
  }

  private buildSystemEventExecutionPlan(event: AyatiSystemEvent): SystemEventExecutionPlan {
    const classification = classifySystemEvent(event);
    const policy = resolveSystemEventPolicy(this.systemEventPolicy, event, classification);

    return {
      classification,
      policy,
      preferredResponseKind: policy.delivery,
      approvalState: policy.approvalRequired ? "pending" : "not_needed",
      toolDefinitions: this.resolveSystemEventToolDefinitions(policy.mode),
    };
  }

  private resolveSystemEventToolDefinitions(mode: SystemEventHandlingMode): ToolDefinition[] {
    const allToolDefinitions = this.toolExecutor?.definitions() ?? [];
    switch (mode) {
      case "auto_execute_notify":
      case "auto_execute_silent":
        return allToolDefinitions;
      case "log_only":
      case "analyze_notify":
      case "analyze_ask":
      case "draft_then_approve":
      case "approve_then_execute":
        return [];
    }
  }

  private dispatchAgentResponse(
    clientId: string,
    runHandle: AgentRunHandle,
    result: {
      type: AgentResponseKind;
      content: string;
      artifacts?: AgentArtifact[];
    },
    meta?: {
      source?: string;
      event?: string;
      eventId?: string;
    },
    finalized?: FinalizeRunResponse,
  ): void {
    const terminal = {
      runId: runHandle.runId,
      commitStatus: finalized?.workstreamContextCommit.status ?? "failed",
    };
    switch (result.type) {
      case "reply":
        this.sendAssistantReply(clientId, runHandle, result.content, result.artifacts, terminal);
        return;
      case "feedback":
        this.sendAssistantFeedback(clientId, runHandle, result.content, result.artifacts, terminal);
        return;
      case "notification":
        this.sendAssistantNotification(clientId, runHandle, result.content, result.artifacts, meta, terminal);
        return;
      case "none":
        return;
    }
  }

  private sendAssistantReply(
    clientId: string,
    runHandle: AgentRunHandle,
    content: string,
    artifacts?: AgentArtifact[],
    terminal?: Record<string, unknown>,
  ): void {
    const artifactPayload = artifacts && artifacts.length > 0 && runHandle
      ? { artifacts, runId: runHandle.runId }
      : {};
    this.onReply?.(clientId, {
      type: "reply",
      content,
      ...terminal,
      ...artifactPayload,
    });
  }

  private sendAssistantFeedback(
    clientId: string,
    runHandle: AgentRunHandle,
    content: string,
    artifacts?: AgentArtifact[],
    terminal?: Record<string, unknown>,
  ): void {
    const artifactPayload = artifacts && artifacts.length > 0 && runHandle
      ? { artifacts, runId: runHandle.runId }
      : {};
    this.onReply?.(clientId, {
      type: "feedback",
      content,
      ...terminal,
      ...artifactPayload,
    });
  }

  private sendAssistantNotification(
    clientId: string,
    runHandle: AgentRunHandle,
    content: string,
    artifacts?: AgentArtifact[],
    _meta?: {
      source?: string;
      event?: string;
      eventId?: string;
    },
    terminal?: Record<string, unknown>,
  ): void {
    const artifactPayload = artifacts && artifacts.length > 0 && runHandle
      ? { artifacts, runId: runHandle.runId }
      : {};
    this.onReply?.(clientId, {
      type: "notification",
      content,
      final: true,
      ...terminal,
      ...artifactPayload,
    });
  }

  private sendProgress(clientId: string, runHandle: AgentRunHandle, content: string): void {
    this.onReply?.(clientId, {
      type: "progress",
      content,
      runId: runHandle.runId,
    });
  }
}

function systemEventResult(
  runId: string,
  type: AgentResponseKind,
  content: string,
): AgentLoopResult {
  return {
    type,
    runId,
    outcome: "done",
    stopReason: "completed",
    content,
    status: "completed",
    totalIterations: 0,
    totalToolCalls: 0,
    runPath: "",
    workState: {
      status: "done",
      summary: content || "System event recorded.",
      openWork: [],
      blockers: [],
      verifiedFacts: [],
      evidence: [],
    },
    completedSteps: [],
  };
}

function failedSystemEventResult(runId: string, error: unknown): AgentLoopResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    type: "notification",
    runId,
    outcome: "failed",
    stopReason: "failed",
    content: "System event processing failed: " + message,
    status: "failed",
    totalIterations: 0,
    totalToolCalls: 0,
    runPath: "",
    workState: {
      status: "blocked",
      summary: "System event processing failed.",
      openWork: ["Retry the system event after resolving the failure."],
      blockers: [message],
      verifiedFacts: [],
      evidence: [],
      nextStep: "Retry the system event.",
    },
    completedSteps: [],
  };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return JSON.stringify({ error: "payload_serialization_failed" });
  }
}

function truncateText(value: string, maxChars: number): string {
  const normalized = value.trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}
