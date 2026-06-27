import type { LlmProvider } from "../core/contracts/provider.js";
import type { AyatiSystemEvent } from "../core/contracts/plugin.js";
import type { StaticContext } from "../context/static-context-cache.js";
import type { DocumentStore } from "../documents/document-store.js";
import type { PreparedAttachmentRegistry } from "../documents/prepared-attachment-registry.js";
import type { DirectoryLibrary } from "../files/directory-library.js";
import type { FileLibrary } from "../files/file-library.js";
import type { AgentResponseKind, MemoryRunHandle, SessionInputHandle, SessionMemory } from "../memory/types.js";
import type { SkillActivationManager } from "../skills/activation-manager.js";
import type { ToolExecutor } from "../skills/tool-executor.js";
import type { ToolDefinition } from "../skills/types.js";
import { devError, devLog } from "../shared/index.js";
import { agentLoop } from "../ivec/agent-loop.js";
import type { ToolWorkingSetManager } from "../ivec/agent-runner/tool-working-set.js";
import type { AgentFeedbackLedger } from "../ivec/feedback-ledger.js";
import type { RotationPolicyConfig } from "../ivec/session-rotation-policy.js";
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
  LoopConfig,
  SystemEventApprovalState,
} from "../ivec/types.js";
import { buildStaticSystemContext } from "./static-prompt.js";
import { rotateSessionBeforeRunIfNeeded } from "./session-rotation.js";
import { completeSessionLifecycle } from "./session-lifecycle.js";

export interface CreateSystemEventRuntimeOptions {
  onReply?: (clientId: string, data: unknown) => void;
  provider?: LlmProvider;
  staticContext?: StaticContext;
  sessionMemory: SessionMemory;
  toolExecutor?: ToolExecutor;
  skillActivationManager?: SkillActivationManager;
  toolWorkingSetManager?: ToolWorkingSetManager;
  loopConfig?: Partial<LoopConfig>;
  rotationPolicyConfig?: Partial<RotationPolicyConfig>;
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

export function createSystemEventRuntime(options: CreateSystemEventRuntimeOptions): SystemEventRuntime {
  return new AppSystemEventRuntime(options);
}

class AppSystemEventRuntime implements SystemEventRuntime {
  private readonly onReply?: (clientId: string, data: unknown) => void;
  private readonly provider?: LlmProvider;
  private readonly staticContext?: StaticContext;
  private readonly sessionMemory: SessionMemory;
  private readonly toolExecutor?: ToolExecutor;
  private readonly skillActivationManager?: SkillActivationManager;
  private readonly toolWorkingSetManager?: ToolWorkingSetManager;
  private readonly loopConfig?: Partial<LoopConfig>;
  private readonly rotationPolicyConfig?: Partial<RotationPolicyConfig>;
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
    this.sessionMemory = options.sessionMemory;
    this.toolExecutor = options.toolExecutor;
    this.skillActivationManager = options.skillActivationManager;
    this.toolWorkingSetManager = options.toolWorkingSetManager;
    this.loopConfig = options.loopConfig;
    this.rotationPolicyConfig = options.rotationPolicyConfig;
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
    let runStatus: "completed" | "failed" | "stuck" | null = null;
    const incomingMessage = event.summary;
    const systemEventPlan = this.buildSystemEventExecutionPlan(event);
    const preferredResponseKind = systemEventPlan.preferredResponseKind;

    try {
      devLog(
        `[${clientId}] system_event start source=${event.source} eventName=${event.eventName} eventId=${event.eventId} summary=${event.summary}`,
      );
      this.rotateSessionBeforeRunIfNeeded(clientId);
      inputHandle = this.sessionMemory.recordSystemEvent?.(clientId, {
        source: event.source,
        event: event.eventName,
        eventId: event.eventId,
        summary: event.summary,
        eventClass: systemEventPlan.classification.eventClass,
        trustTier: systemEventPlan.classification.trustTier,
        effectLevel: systemEventPlan.classification.effectLevel,
        createdBy: systemEventPlan.classification.createdBy,
        requestedAction: systemEventPlan.classification.requestedAction,
        modeApplied: systemEventPlan.policy.mode,
        approvalState: systemEventPlan.approvalState,
        occurrenceId: asOptionalString(event.payload["occurrenceId"]),
        reminderId: asOptionalString(event.payload["reminderId"]),
        instruction: asOptionalString(event.payload["instruction"]),
        scheduledFor: asOptionalString(event.payload["scheduledFor"]),
        triggeredAt: event.receivedAt,
        payload: event.payload,
      }) ?? this.sessionMemory.recordUserMessage(clientId, incomingMessage);
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
        this.sessionMemory.recordSystemEventOutcome?.(clientId, {
          eventId: event.eventId,
          source: event.source,
          event: event.eventName,
          summary: event.summary,
          responseKind: "none",
          approvalState: systemEventPlan.approvalState,
          status: "completed",
          note: this.buildSystemEventOutcomeNote(systemEventPlan, event.summary, "none", "log_only"),
        });
        runStatus = "completed";
        return;
      }

      if (!this.provider) {
        devLog(`[${clientId}] system_event echo_mode eventId=${event.eventId}`);
        this.dispatchAgentResponse(clientId, inputHandle, null, {
          type: preferredResponseKind,
          content: event.summary,
        }, {
          source: event.source,
          event: event.eventName,
          eventId: event.eventId,
        });
        this.sessionMemory.recordSystemEventOutcome?.(clientId, {
          eventId: event.eventId,
          source: event.source,
          event: event.eventName,
          summary: event.summary,
          responseKind: preferredResponseKind,
          approvalState: systemEventPlan.approvalState,
          status: "completed",
          note: this.buildSystemEventOutcomeNote(systemEventPlan, event.summary, preferredResponseKind, "echo_mode"),
        });
        runStatus = "completed";
        return;
      }

      const toolDefinitions = systemEventPlan.toolDefinitions;
      if (toolDefinitions.length > 0) {
        runHandle = this.createWorkRun(clientId, inputHandle);
        this.recordTurnStatus(
          clientId,
          runHandle,
          "processing_started",
          `system_event:${event.source}/${event.eventName} mode=${systemEventPlan.policy.mode}`,
        );
      }
      devLog(
        `[${clientId}] system_event entering agentLoop eventId=${event.eventId} mode=${systemEventPlan.policy.mode} intent=${systemEventPlan.classification.intentKind} approval=${systemEventPlan.policy.approvalRequired ? "required" : "not_required"} tools=${toolDefinitions.length} payloadKeys=${Object.keys(event.payload).join(",") || "none"}`,
      );
      const result = await agentLoop({
        provider: this.provider,
        toolExecutor: this.toolExecutor,
        skillActivationManager: this.skillActivationManager,
        toolWorkingSetManager: this.toolWorkingSetManager,
        toolDefinitions,
        sessionMemory: this.sessionMemory,
        inputHandle,
        ...(runHandle ? { runHandle } : {}),
        onWorkRunCreated: (created) => {
          runHandle = created;
          this.recordTurnStatus(
            clientId,
            created,
            "processing_started",
            `system_event:${event.source}/${event.eventName} mode=${systemEventPlan.policy.mode}`,
          );
          this.feedbackLedger?.record({
            clientId,
            sessionId: created.sessionId,
            seq: inputHandle?.seq,
            runId: created.runId,
            stage: "run",
            event: "created",
            data: {
              source: "system_event",
              eventSource: event.source,
              eventName: event.eventName,
            },
          });
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
        feedbackLedger: this.feedbackLedger,
        fileLibrary: this.fileLibrary,
        directoryLibrary: this.directoryLibrary,
        documentStore: this.documentStore,
        preparedAttachmentRegistry: this.preparedAttachmentRegistry,
        onProgress: (log, runPath) => {
          devLog(`[${clientId}] ${log}`);
          if (runHandle) {
            this.sessionMemory.recordAgentStep(clientId, {
              runId: runHandle.runId,
              sessionId: runHandle.sessionId,
              step: 0,
              phase: "progress",
              summary: `${log} | runPath: ${runPath}`,
            });
            this.sendProgress(clientId, runHandle, log);
          }
        },
      });

      this.sessionMemory.recordSystemEventOutcome?.(clientId, {
        ...(runHandle ? { workRunId: runHandle.runId } : {}),
        eventId: event.eventId,
        source: event.source,
        event: event.eventName,
        summary: event.summary,
        responseKind: result.type,
        approvalState: systemEventPlan.approvalState,
        status: result.status === "completed" ? "completed" : "failed",
        note: this.buildSystemEventOutcomeNote(systemEventPlan, result.content, result.type),
      });
      devLog(
        `[${clientId}] system_event agentLoop completed eventId=${event.eventId} status=${result.status} runPath=${result.runPath}`,
      );
      this.dispatchAgentResponse(clientId, inputHandle, runHandle, result, {
        source: event.source,
        event: event.eventName,
        eventId: event.eventId,
      });
      runStatus = result.status;
    } catch (err) {
      devError("System event processing error:", err);
      if (runHandle) {
        const message = err instanceof Error ? err.message : "Unknown runtime failure";
        this.sessionMemory.recordRunFailure(
          clientId,
          runHandle.runId,
          runHandle.sessionId,
          message,
        );
        this.recordTurnStatus(clientId, runHandle, "response_failed", message);
        this.sessionMemory.recordSystemEventOutcome?.(clientId, {
          workRunId: runHandle.runId,
          eventId: event.eventId,
          source: event.source,
          event: event.eventName,
          summary: event.summary,
          responseKind: preferredResponseKind,
          approvalState: systemEventPlan.approvalState,
          status: "failed",
          note: this.buildSystemEventOutcomeNote(systemEventPlan, message, preferredResponseKind, "failed_before_dispatch"),
        });
        runStatus = "failed";
      }
      this.onReply?.(clientId, {
        type: "error",
        content: "Failed to process system event.",
      });
      throw err;
    } finally {
      await completeSessionLifecycle({
        clientId,
        sessionMemory: this.sessionMemory,
        runHandle,
        status: runStatus,
      });
    }
  }

  private rotateSessionBeforeRunIfNeeded(clientId: string): void {
    rotateSessionBeforeRunIfNeeded({
      clientId,
      sessionMemory: this.sessionMemory,
      now: this.nowProvider,
      rotationPolicyConfig: this.rotationPolicyConfig,
    });
  }

  private createWorkRun(clientId: string, inputHandle: SessionInputHandle): MemoryRunHandle {
    const createWorkRun = this.sessionMemory.createWorkRun;
    if (!createWorkRun) {
      throw new Error("Session memory does not support work run creation.");
    }
    return createWorkRun.call(this.sessionMemory, clientId, inputHandle);
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

  private buildSystemEventOutcomeNote(
    plan: SystemEventExecutionPlan,
    content: string,
    responseKind: AgentResponseKind,
    prefix?: string,
  ): string {
    const parts = [
      prefix,
      `mode=${plan.policy.mode}`,
      `delivery=${plan.policy.delivery}`,
      `intent=${plan.classification.intentKind}`,
      `eventClass=${plan.classification.eventClass}`,
      `trustTier=${plan.classification.trustTier}`,
      `effectLevel=${plan.classification.effectLevel}`,
      `createdBy=${plan.classification.createdBy}`,
      `approvalRequired=${plan.policy.approvalRequired ? "yes" : "no"}`,
      `response=${responseKind}`,
      `tools=${plan.toolDefinitions.length}`,
      plan.classification.requestedAction ? `requestedAction=${plan.classification.requestedAction}` : undefined,
      content ? `summary=${content}` : undefined,
    ].filter((part) => typeof part === "string" && part.length > 0);
    return parts.join(" | ");
  }

  private dispatchAgentResponse(
    clientId: string,
    inputHandle: SessionInputHandle,
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
        this.sendAssistantReply(clientId, inputHandle, runHandle, result.content, result.artifacts);
        return;
      case "feedback":
        this.sendAssistantFeedback(clientId, inputHandle, runHandle, result.content, result.artifacts);
        return;
      case "notification":
        this.sendAssistantNotification(clientId, inputHandle, runHandle, result.content, result.artifacts, meta);
        return;
      case "none":
        if (runHandle) {
          this.recordTurnStatus(clientId, runHandle, "response_completed", "delivery=none");
        }
        return;
    }
  }

  private sendAssistantReply(
    clientId: string,
    inputHandle: SessionInputHandle,
    runHandle: MemoryRunHandle | null,
    content: string,
    artifacts?: AgentArtifact[],
  ): void {
    if (runHandle) {
      this.recordTurnStatus(clientId, runHandle, "response_started");
    }
    this.sessionMemory.recordAssistantMessage(clientId, {
      sessionId: inputHandle.sessionId,
      ...(runHandle ? { workRunId: runHandle.runId } : {}),
      content,
      responseKind: "reply",
    });
    if (runHandle) {
      this.recordTurnStatus(clientId, runHandle, "response_completed");
    }
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
    inputHandle: SessionInputHandle,
    runHandle: MemoryRunHandle | null,
    content: string,
    artifacts?: AgentArtifact[],
  ): void {
    if (runHandle) {
      this.recordTurnStatus(clientId, runHandle, "response_started");
    }
    this.sessionMemory.recordAssistantMessage(clientId, {
      sessionId: inputHandle.sessionId,
      ...(runHandle ? { workRunId: runHandle.runId } : {}),
      content,
      responseKind: "feedback",
    });
    if (runHandle) {
      this.recordTurnStatus(clientId, runHandle, "response_completed");
    }
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
    inputHandle: SessionInputHandle,
    runHandle: MemoryRunHandle | null,
    content: string,
    artifacts?: AgentArtifact[],
    meta?: {
      source?: string;
      event?: string;
      eventId?: string;
    },
  ): void {
    if (runHandle) {
      this.recordTurnStatus(clientId, runHandle, "response_started");
    }
    this.sessionMemory.recordAssistantMessage(clientId, {
      sessionId: inputHandle.sessionId,
      ...(runHandle ? { workRunId: runHandle.runId } : {}),
      content,
      responseKind: "notification",
    });
    this.sessionMemory.recordAssistantNotification?.(clientId, {
      ...(runHandle ? { workRunId: runHandle.runId } : {}),
      sessionId: inputHandle.sessionId,
      message: content,
      source: meta?.source,
      event: meta?.event,
      eventId: meta?.eventId,
    });
    if (runHandle) {
      this.recordTurnStatus(clientId, runHandle, "response_completed");
    }
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

  private recordTurnStatus(
    clientId: string,
    runHandle: MemoryRunHandle,
    status: "processing_started" | "response_started" | "response_completed" | "response_failed",
    note?: string,
  ): void {
    this.sessionMemory.recordTurnStatus?.(clientId, {
      runId: runHandle.runId,
      sessionId: runHandle.sessionId,
      status,
      note,
    });
  }
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
