import type { LlmProvider } from "../core/contracts/provider.js";
import type { AyatiSystemEvent } from "../core/contracts/plugin.js";
import type { StaticContext } from "../context/static-context-cache.js";
import type { DocumentStore } from "../documents/document-store.js";
import type { PreparedAttachmentRegistry } from "../documents/prepared-attachment-registry.js";
import type { DirectoryLibrary } from "../files/directory-library.js";
import type { FileLibrary } from "../files/file-library.js";
import type { AgentResponseKind, MemoryRunHandle, RunRecorder, SessionInputHandle } from "../memory/types.js";
import type { SkillActivationManager } from "../skills/activation-manager.js";
import type { ToolExecutor } from "../skills/tool-executor.js";
import type { ToolDefinition } from "../skills/types.js";
import { devError, devLog } from "../shared/index.js";
import { agentLoop } from "../ivec/agent-loop.js";
import type { ToolWorkingSetManager } from "../ivec/agent-runner/tool-working-set.js";
import type { AgentFeedbackLedger } from "../ivec/feedback-ledger.js";
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
  GitMemorySystemEventContextPreparedTurn,
  GitMemorySystemEventContextRoutedTurn,
  GitMemorySystemEventContextRuntime,
} from "./git-memory-system-event-context-runtime.js";

export interface CreateSystemEventRuntimeOptions {
  onReply?: (clientId: string, data: unknown) => void;
  provider?: LlmProvider;
  staticContext?: StaticContext;
  systemEventContextRuntime: GitMemorySystemEventContextRuntime;
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
  private readonly systemEventContextRuntime: GitMemorySystemEventContextRuntime;
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
    let runHandle: MemoryRunHandle | null = null;
    let preparedContextTurn: GitMemorySystemEventContextPreparedTurn | null = null;
    let routedContextTurn: GitMemorySystemEventContextRoutedTurn | null = null;
    const incomingMessage = event.summary;
    const systemEventPlan = this.buildSystemEventExecutionPlan(event);
    const preferredResponseKind = systemEventPlan.preferredResponseKind;

    try {
      devLog(
        `[${clientId}] system_event start source=${event.source} eventName=${event.eventName} eventId=${event.eventId} summary=${event.summary}`,
      );
      preparedContextTurn = await this.prepareSystemEventContextTurn(clientId, event, systemEventPlan);
      inputHandle = this.inputHandleFromSystemContextTurn(preparedContextTurn);
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
        return;
      }

      if (!this.provider) {
        devLog(`[${clientId}] system_event echo_mode eventId=${event.eventId}`);
        await this.recordSystemEventAssistantMessage(clientId, preparedContextTurn, event.summary);
        this.dispatchAgentResponse(clientId, null, {
          type: preferredResponseKind,
          content: event.summary,
        }, {
          source: event.source,
          event: event.eventName,
          eventId: event.eventId,
        });
        return;
      }

      const toolDefinitions = systemEventPlan.toolDefinitions;
      routedContextTurn = await this.routeSystemEventContextTurn(
        clientId,
        preparedContextTurn,
        event,
        systemEventPlan,
      );
      if (routedContextTurn?.status === "ambiguous") {
        await this.dispatchSystemEventContextAmbiguity(clientId, preparedContextTurn, routedContextTurn);
        return;
      }
      runHandle = routedContextTurn?.status === "ready"
        ? this.runHandleFromRoutedTurn(inputHandle, routedContextTurn)
        : null;

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
        ...(runHandle ? { runHandle } : {}),
        createWorkRun: this.failMissingGitMemoryRun,
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
        ...(routedContextTurn?.status === "ready" ? { harnessContext: routedContextTurn.harnessContext } : {}),
        feedbackLedger: this.feedbackLedger,
        fileLibrary: this.fileLibrary,
        directoryLibrary: this.directoryLibrary,
        documentStore: this.documentStore,
        preparedAttachmentRegistry: this.preparedAttachmentRegistry,
        onProgress: (log, _runPath) => {
          devLog(`[${clientId}] ${log}`);
          if (runHandle) {
            this.sendProgress(clientId, runHandle, log);
          }
        },
      });

      devLog(
        `[${clientId}] system_event agentLoop completed eventId=${event.eventId} status=${result.status} runPath=${result.runPath}`,
      );
      this.dispatchAgentResponse(clientId, runHandle, result, {
        source: event.source,
        event: event.eventName,
        eventId: event.eventId,
      });
      await this.completeSystemEventContextRun(clientId, preparedContextTurn, routedContextTurn, result);
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
  ): Promise<GitMemorySystemEventContextPreparedTurn> {
    return await this.systemEventContextRuntime.prepareSystemEventTurn({
      clientId,
      systemMessage: this.formatSystemEventConversationMessage(event, plan),
      at: event.receivedAt,
    });
  }

  private async routeSystemEventContextTurn(
    clientId: string,
    turn: GitMemorySystemEventContextPreparedTurn | null,
    event: AyatiSystemEvent,
    plan: SystemEventExecutionPlan,
  ): Promise<GitMemorySystemEventContextRoutedTurn | null> {
    const routed = await this.systemEventContextRuntime.routeTaskTurn({
      clientId,
      turn,
      userMessage: this.systemEventRoutingText(event, plan),
      title: this.systemEventTaskTitle(event),
      objective: this.systemEventTaskObjective(event, plan),
      at: this.nowProvider().toISOString(),
    });
    if (!turn || !routed) {
      return routed;
    }
    this.feedbackLedger?.record({
      clientId,
      sessionId: turn.sessionId,
      stage: "context_engine",
      event: "routed",
      data: routed.status === "ready"
        ? {
            status: routed.status,
            mode: routed.mode,
            taskId: routed.taskId,
            branch: routed.branch,
            ref: routed.ref,
            conversationRefs: routed.conversationRefs,
          }
        : {
            status: routed.status,
            reason: routed.reason,
            candidateCount: routed.candidates.length,
          },
    });
    return routed;
  }

  private async dispatchSystemEventContextAmbiguity(
    clientId: string,
    prepared: GitMemorySystemEventContextPreparedTurn | null,
    routed: Extract<GitMemorySystemEventContextRoutedTurn, { status: "ambiguous" }>,
  ): Promise<void> {
    const message = formatGitMemoryAmbiguityMessage(routed);
    await this.recordSystemEventAssistantMessage(clientId, prepared, message);
    this.dispatchAgentResponse(clientId, null, {
      type: "feedback",
      content: message,
    });
  }

  private async completeSystemEventContextRun(
    clientId: string,
    prepared: GitMemorySystemEventContextPreparedTurn | null,
    routed: GitMemorySystemEventContextRoutedTurn | null,
    result: AgentLoopResult,
  ): Promise<void> {
    if (!prepared || routed?.status !== "ready") {
      return;
    }

    const completedAt = this.nowProvider().toISOString();
    const completed = await this.systemEventContextRuntime.completeTaskRun({
      clientId,
      turn: prepared,
      taskId: routed.taskId,
      runId: routed.runId,
      result,
      conversationRefs: routed.conversationRefs,
      at: completedAt,
      assistantMessage: result.content,
      assistantAt: this.nowProvider().toISOString(),
    });
    if (!completed) {
      return;
    }

    this.feedbackLedger?.record({
      clientId,
      sessionId: prepared.sessionId,
      runId: completed.runId,
      stage: "context_engine",
      event: "committed",
      data: {
        taskId: completed.taskId,
        taskCommit: completed.taskCommit,
        ref: completed.ref,
      },
    });
  }

  private async recordSystemEventAssistantMessage(
    clientId: string,
    turn: GitMemorySystemEventContextPreparedTurn | null,
    message: string,
    ids?: {
      taskId?: string;
      runId?: string;
    },
  ): Promise<void> {
    await this.systemEventContextRuntime.recordAssistantMessage({
      clientId,
      turn,
      message,
      taskId: ids?.taskId,
      runId: ids?.runId,
      at: this.nowProvider().toISOString(),
    });
  }

  private inputHandleFromSystemContextTurn(turn: GitMemorySystemEventContextPreparedTurn): SessionInputHandle {
    return {
      sessionId: turn.sessionId,
      seq: turn.messageSeq,
    };
  }

  private runHandleFromRoutedTurn(
    inputHandle: SessionInputHandle,
    turn: Extract<GitMemorySystemEventContextRoutedTurn, { status: "ready" }>,
  ): MemoryRunHandle {
    return {
      sessionId: inputHandle.sessionId,
      runId: turn.runId,
      triggerSeq: inputHandle.seq,
    };
  }

  private failMissingGitMemoryRun(_inputHandle: SessionInputHandle): MemoryRunHandle {
    throw new Error("Git-memory routed run is required before system-event tool execution.");
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

  private systemEventRoutingText(event: AyatiSystemEvent, plan: SystemEventExecutionPlan): string {
    return [
      event.summary,
      plan.classification.requestedAction,
      `${event.source}/${event.eventName}`,
      optionalString(event.payload["title"]),
      optionalString(event.payload["instruction"]),
    ].filter((value): value is string => typeof value === "string" && value.trim().length > 0).join("\n");
  }

  private systemEventTaskTitle(event: AyatiSystemEvent): string {
    const title = optionalString(event.payload["title"]);
    return truncateText(title ?? `${event.source} ${event.eventName}: ${event.summary}`, 80);
  }

  private systemEventTaskObjective(event: AyatiSystemEvent, plan: SystemEventExecutionPlan): string {
    const requestedAction = plan.classification.requestedAction
      ? ` Requested action: ${plan.classification.requestedAction}.`
      : "";
    return truncateText(
      `Handle system event ${event.source}/${event.eventName}: ${event.summary}.${requestedAction} Mode: ${plan.policy.mode}.`,
      300,
    );
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
    runHandle: MemoryRunHandle | null,
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
  ): void {
    switch (result.type) {
      case "reply":
        this.sendAssistantReply(clientId, runHandle, result.content, result.artifacts);
        return;
      case "feedback":
        this.sendAssistantFeedback(clientId, runHandle, result.content, result.artifacts);
        return;
      case "notification":
        this.sendAssistantNotification(clientId, runHandle, result.content, result.artifacts, meta);
        return;
      case "none":
        return;
    }
  }

  private sendAssistantReply(
    clientId: string,
    runHandle: MemoryRunHandle | null,
    content: string,
    artifacts?: AgentArtifact[],
  ): void {
    const artifactPayload = artifacts && artifacts.length > 0 && runHandle
      ? { artifacts, runId: runHandle.runId }
      : {};
    this.onReply?.(clientId, {
      type: "reply",
      content,
      ...artifactPayload,
    });
  }

  private sendAssistantFeedback(
    clientId: string,
    runHandle: MemoryRunHandle | null,
    content: string,
    artifacts?: AgentArtifact[],
  ): void {
    const artifactPayload = artifacts && artifacts.length > 0 && runHandle
      ? { artifacts, runId: runHandle.runId }
      : {};
    this.onReply?.(clientId, {
      type: "feedback",
      content,
      ...artifactPayload,
    });
  }

  private sendAssistantNotification(
    clientId: string,
    runHandle: MemoryRunHandle | null,
    content: string,
    artifacts?: AgentArtifact[],
    _meta?: {
      source?: string;
      event?: string;
      eventId?: string;
    },
  ): void {
    const artifactPayload = artifacts && artifacts.length > 0 && runHandle
      ? { artifacts, runId: runHandle.runId }
      : {};
    this.onReply?.(clientId, {
      type: "notification",
      content,
      final: true,
      ...artifactPayload,
    });
  }

  private sendProgress(clientId: string, runHandle: MemoryRunHandle, content: string): void {
    this.onReply?.(clientId, {
      type: "progress",
      content,
      runId: runHandle.runId,
    });
  }
}

function formatGitMemoryAmbiguityMessage(
  routed: Extract<GitMemorySystemEventContextRoutedTurn, { status: "ambiguous" }>,
): string {
  if (routed.candidates.length === 0) {
    return `I could not find the task referenced by the system event. ${routed.reason}. Please mention the task id or describe the task again.`;
  }
  const candidates = routed.candidates
    .slice(0, 5)
    .map((candidate) => `- ${candidate.taskId}: ${candidate.title}`)
    .join("\n");
  return `I found multiple matching tasks for the system event. Please mention the task id to continue.\n${candidates}`;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
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
