import { randomUUID } from "node:crypto";
import type { LlmProvider } from "../core/contracts/provider.js";
import { noopSessionMemory } from "../memory/provider.js";
import type { ConversationTurn, SessionMemory, MemoryRunHandle, PromptMemoryContext, SessionStatus } from "../memory/types.js";
import type { StaticContext } from "../context/static-context-cache.js";
import { renderBasePromptSection } from "../prompt/sections/base.js";
import { renderConversationLines, renderConversationSection } from "../prompt/sections/conversation.js";
import { renderCurrentSessionSection } from "../prompt/sections/current-session.js";
import { renderMemorySection } from "../prompt/sections/memory.js";
import { renderRecentTasksSection } from "../prompt/sections/recent-tasks.js";
import { renderSessionStatusSection } from "../prompt/sections/session-status.js";
import { renderSkillsSection } from "../prompt/sections/skills.js";
import { renderSoulSection } from "../prompt/sections/soul.js";
import { renderSystemActivitySection } from "../prompt/sections/system-activity.js";
import { renderUserProfileSection } from "../prompt/sections/user-profile.js";
import { estimateTextTokens } from "../prompt/token-estimator.js";
import type { ToolExecutor } from "../skills/tool-executor.js";
import type { ToolDefinition } from "../skills/types.js";
import type { ExternalSkillBroker } from "../skills/external/broker.js";
import type { ExternalSkillRegistry } from "../skills/external/registry.js";
import { devLog, devWarn, devError } from "../shared/index.js";
import type { ManagedDocumentManifest } from "../documents/types.js";
import type { DocumentStore } from "../documents/document-store.js";
import type { DocumentContextBackend } from "../documents/document-context-backend.js";
import { PreparedAttachmentRegistry } from "../documents/prepared-attachment-registry.js";
import {
  normalizeSystemEvent,
  type AyatiSystemEvent,
  type SystemEventClass,
  type SystemEventCreatedBy,
  type SystemEventEffectLevel,
  type SystemEventIntentKind,
  type SystemEventIntentMetadata,
  type SystemEventTrustTier,
} from "../core/contracts/plugin.js";
import type { AgentResponseKind } from "../memory/types.js";
import { agentLoop } from "./agent-loop.js";
import {
  evaluateSessionRotation,
  type RotationPolicyConfig,
} from "./session-rotation-policy.js";
import {
  classifySystemEvent,
  resolveSystemEventPolicy,
  type ResolvedSystemEventPolicy,
  type SystemEventClassification,
  type SystemEventHandlingMode,
  type SystemEventPolicyConfig,
} from "./system-event-policy.js";
import type {
  AgentLoopResult,
  AgentArtifact,
  ChatAttachmentInput,
  ChatInboundMessage,
  LoopConfig,
  SystemEventApprovalState,
} from "./types.js";

interface SystemContextBuildResult {
  systemContext: string;
  controllerSystemContext: string;
  dynamicSystemTokens: number;
}

interface StaticPromptSectionsCache {
  head: string;
  tail: string;
  controllerSystemContext: string;
}

interface UnderstandContextCache {
  sessionKey: string;
  conversationTurns: ConversationTurn[];
  conversationSection: string;
  previousSessionSummary: string;
  memorySection: string;
  activeSessionPath: string;
  currentSessionSection: string;
  recentTasksFingerprint: string;
  recentTasksSection: string;
  recentSystemActivityFingerprint: string;
  recentSystemActivitySection: string;
  sessionStatusFingerprint: string;
  systemContextWithoutStatus: string;
  systemContext: string;
  dynamicContext: string;
  dynamicSystemTokens: number;
}

interface SystemEventExecutionPlan {
  classification: SystemEventClassification;
  policy: ResolvedSystemEventPolicy;
  preferredResponseKind: AgentResponseKind;
  approvalState: SystemEventApprovalState;
  toolDefinitions: ToolDefinition[];
}

export interface IVecEngineOptions {
  onReply?: (clientId: string, data: unknown) => void;
  provider?: LlmProvider;
  staticContext?: StaticContext;
  sessionMemory?: SessionMemory;
  toolExecutor?: ToolExecutor;
  externalSkillBroker?: ExternalSkillBroker;
  externalSkillRegistry?: ExternalSkillRegistry;
  loopConfig?: Partial<LoopConfig>;
  rotationPolicyConfig?: Partial<RotationPolicyConfig>;
  now?: () => Date;
  dataDir?: string;
  documentStore?: DocumentStore;
  preparedAttachmentRegistry?: PreparedAttachmentRegistry;
  documentContextBackend?: DocumentContextBackend;
  systemEventPolicy?: SystemEventPolicyConfig;
}

export class IVecEngine {
  private readonly onReply?: (clientId: string, data: unknown) => void;
  private readonly provider?: LlmProvider;
  private readonly staticContext?: StaticContext;
  private readonly toolExecutor?: ToolExecutor;
  private readonly externalSkillBroker?: ExternalSkillBroker;
  private readonly externalSkillRegistry?: ExternalSkillRegistry;
  private sessionMemory: SessionMemory;
  private readonly loopConfig?: Partial<LoopConfig>;
  private readonly rotationPolicyConfig?: Partial<RotationPolicyConfig>;
  private readonly nowProvider: () => Date;
  private readonly dataDir?: string;
  private readonly documentStore?: DocumentStore;
  private readonly preparedAttachmentRegistry?: PreparedAttachmentRegistry;
  private readonly documentContextBackend?: DocumentContextBackend;
  private readonly systemEventPolicy?: SystemEventPolicyConfig;
  private staticSystemTokens = 0;
  private staticTokensReady = false;
  private staticPromptSections?: StaticPromptSectionsCache;
  private understandContextCache?: UnderstandContextCache;

  constructor(options?: IVecEngineOptions) {
    this.onReply = options?.onReply;
    this.provider = options?.provider;
    this.staticContext = options?.staticContext;
    this.toolExecutor = options?.toolExecutor;
    this.externalSkillBroker = options?.externalSkillBroker;
    this.externalSkillRegistry = options?.externalSkillRegistry;
    this.sessionMemory = options?.sessionMemory ?? noopSessionMemory;
    this.loopConfig = options?.loopConfig;
    this.rotationPolicyConfig = options?.rotationPolicyConfig;
    this.nowProvider = options?.now ?? (() => new Date());
    this.dataDir = options?.dataDir;
    this.documentStore = options?.documentStore;
    this.preparedAttachmentRegistry = options?.preparedAttachmentRegistry
      ?? (this.documentStore ? new PreparedAttachmentRegistry() : undefined);
    this.documentContextBackend = options?.documentContextBackend;
    this.systemEventPolicy = options?.systemEventPolicy;
  }

  async start(): Promise<void> {
    if (this.provider) {
      await this.provider.start();
      devLog(`Provider "${this.provider.name}" started`);
    } else {
      devWarn("No LLM provider configured — running in echo mode");
    }

    this.ensureStaticTokenCache();
    devLog("IVecEngine started");
  }

  async stop(): Promise<void> {
    if (this.provider) {
      await this.provider.stop();
      devLog(`Provider "${this.provider.name}" stopped`);
    }
    devLog("IVecEngine stopped");
  }

  invalidateStaticTokenCache(): void {
    this.staticTokensReady = false;
    this.staticPromptSections = undefined;
    this.understandContextCache = undefined;
  }

  handleMessage(clientId: string, data: unknown): void {
    devLog(`Message from ${clientId}:`, JSON.stringify(data));

    const payload = data as { type?: string };
    if (payload?.type === "system_event") {
      const systemEvent = this.toSystemEvent(data);
      if (!systemEvent) {
        devWarn("Ignored invalid system_event payload");
        return;
      }
      void this.processSystemEvent(clientId, systemEvent).catch((err) => {
        devError("Unhandled system_event processing failure:", err);
      });
      return;
    }

    const msg = parseChatInboundMessage(data);
    if (!msg) return;

    void this.processChat(clientId, msg.content, msg.attachments ?? []);
  }

  async handleSystemEvent(clientId: string, event: AyatiSystemEvent): Promise<void> {
    await this.processSystemEvent(clientId, event);
  }

  private async processChat(clientId: string, content: string, attachments: ChatAttachmentInput[]): Promise<void> {
    let runHandle: MemoryRunHandle | null = null;
    let runStatus: "completed" | "failed" | "stuck" | null = null;
    try {
      this.rotateSessionBeforeRunIfNeeded(clientId, content);
      runHandle = this.sessionMemory.beginRun(clientId, content);
      this.recordTurnStatus(clientId, runHandle, "processing_started");

      if (this.provider) {
        const registeredAttachments = await this.registerIncomingDocuments(attachments);
        const toolDefs = this.toolExecutor?.definitions({
          clientId,
          runId: runHandle.runId,
          sessionId: runHandle.sessionId,
        }) ?? [];
        const system = await this.buildSystemContext();
        const result = await agentLoop({
          provider: this.provider,
          toolExecutor: this.toolExecutor,
          toolDefinitions: toolDefs,
          externalSkillBroker: this.externalSkillBroker,
          externalSkillRegistry: this.externalSkillRegistry,
          sessionMemory: this.sessionMemory,
          runHandle,
          clientId,
          config: this.loopConfig,
          dataDir: this.dataDir ?? "data",
          systemContext: system.systemContext || undefined,
          controllerSystemContext: system.controllerSystemContext || undefined,
          controllerPrompts: this.staticContext?.controllerPrompts,
          attachedDocuments: registeredAttachments.documents,
          attachmentWarnings: registeredAttachments.warnings,
          documentStore: this.documentStore,
          preparedAttachmentRegistry: this.preparedAttachmentRegistry,
          documentContextBackend: this.documentContextBackend,
          onProgress: (log, runPath) => {
            devLog(`[${clientId}] ${log}`);
            this.sessionMemory.recordAgentStep(clientId, {
              runId: runHandle!.runId,
              sessionId: runHandle!.sessionId,
              step: 0,
              phase: "progress",
              summary: `${log} | runPath: ${runPath}`,
            });
          },
        });
        this.sessionMemory.recordRunLedger?.(clientId, {
          runId: runHandle.runId,
          sessionId: runHandle.sessionId,
          runPath: result.runPath,
          state: "completed",
          status: result.status,
          summary: result.content,
        });
        this.dispatchAgentResponse(clientId, runHandle, result);
        this.queueTaskSummaryPublication(clientId, runHandle, result.taskSummary);
        runStatus = result.status;
      } else {
        this.dispatchAgentResponse(clientId, runHandle, {
          type: "reply",
          content: `Received: "${content}"`,
        });
        runStatus = "completed";
      }
    } catch (err) {
      devError("Provider error:", err);
      if (runHandle) {
        const message = err instanceof Error ? err.message : "Unknown runtime failure";
        this.sessionMemory.recordRunFailure(
          clientId,
          runHandle.runId,
          runHandle.sessionId,
          message,
        );
        this.recordTurnStatus(clientId, runHandle, "response_failed", message);
        runStatus = "failed";
      }
      this.onReply?.(clientId, {
        type: "error",
        content: "Failed to generate a response.",
      });
    } finally {
      await this.completeSessionLifecycle(clientId, runHandle, runStatus);
    }
  }

  private async processSystemEvent(clientId: string, event: AyatiSystemEvent): Promise<void> {
    let runHandle: MemoryRunHandle | null = null;
    let runStatus: "completed" | "failed" | "stuck" | null = null;
    const incomingMessage = event.summary;
    const systemEventPlan = this.buildSystemEventExecutionPlan(event);
    const preferredResponseKind = systemEventPlan.preferredResponseKind;

    try {
      devLog(
        `[${clientId}] system_event start source=${event.source} eventName=${event.eventName} eventId=${event.eventId} summary=${event.summary}`,
      );
      this.rotateSessionBeforeRunIfNeeded(clientId, incomingMessage);
      runHandle = this.sessionMemory.beginSystemRun?.(clientId, {
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
      }) ?? this.sessionMemory.beginRun(clientId, incomingMessage);

      this.recordTurnStatus(
        clientId,
        runHandle,
        "processing_started",
        `system_event:${event.source}/${event.eventName} mode=${systemEventPlan.policy.mode}`,
      );

      if (systemEventPlan.policy.mode === "log_only") {
        this.sessionMemory.recordSystemEventOutcome?.(clientId, {
          runId: runHandle.runId,
          eventId: event.eventId,
          source: event.source,
          event: event.eventName,
          summary: event.summary,
          responseKind: "none",
          approvalState: systemEventPlan.approvalState,
          status: "completed",
          note: this.buildSystemEventOutcomeNote(systemEventPlan, event.summary, "none", "log_only"),
        });
        this.recordTurnStatus(clientId, runHandle, "response_completed", "delivery=none");
        runStatus = "completed";
        return;
      }

      if (!this.provider) {
        devLog(`[${clientId}] system_event echo_mode eventId=${event.eventId}`);
        this.dispatchAgentResponse(clientId, runHandle, {
          type: preferredResponseKind,
          content: event.summary,
        }, {
          source: event.source,
          event: event.eventName,
          eventId: event.eventId,
        });
        this.sessionMemory.recordSystemEventOutcome?.(clientId, {
          runId: runHandle.runId,
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

      const toolDefs = systemEventPlan.toolDefinitions;
      const system = await this.buildSystemContext();
      devLog(
        `[${clientId}] system_event entering agentLoop eventId=${event.eventId} mode=${systemEventPlan.policy.mode} intent=${systemEventPlan.classification.intentKind} approval=${systemEventPlan.policy.approvalRequired ? "required" : "not_required"} tools=${toolDefs.length} payloadKeys=${Object.keys(event.payload).join(",") || "none"}`,
      );
      const result = await agentLoop({
        provider: this.provider,
        toolExecutor: this.toolExecutor,
        toolDefinitions: toolDefs,
        externalSkillBroker: this.externalSkillBroker,
        externalSkillRegistry: this.externalSkillRegistry,
        sessionMemory: this.sessionMemory,
        runHandle,
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
        systemContext: system.systemContext || undefined,
        controllerSystemContext: system.controllerSystemContext || undefined,
        controllerPrompts: this.staticContext?.controllerPrompts,
        documentStore: this.documentStore,
        preparedAttachmentRegistry: this.preparedAttachmentRegistry,
        onProgress: (log, runPath) => {
          devLog(`[${clientId}] ${log}`);
          this.sessionMemory.recordAgentStep(clientId, {
            runId: runHandle!.runId,
            sessionId: runHandle!.sessionId,
            step: 0,
            phase: "progress",
            summary: `${log} | runPath: ${runPath}`,
          });
        },
      });

      this.sessionMemory.recordRunLedger?.(clientId, {
        runId: runHandle.runId,
        sessionId: runHandle.sessionId,
        runPath: result.runPath,
        state: "completed",
        status: result.status,
        summary: result.content,
      });
      this.sessionMemory.recordSystemEventOutcome?.(clientId, {
        runId: runHandle.runId,
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
      this.dispatchAgentResponse(clientId, runHandle, result, {
        source: event.source,
        event: event.eventName,
        eventId: event.eventId,
      });
      this.queueTaskSummaryPublication(clientId, runHandle, result.taskSummary);
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
          runId: runHandle.runId,
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
      await this.completeSessionLifecycle(clientId, runHandle, runStatus);
    }
  }

  private async buildSystemContext(): Promise<SystemContextBuildResult> {
    if (!this.staticContext) {
      return { systemContext: "", controllerSystemContext: "", dynamicSystemTokens: 0 };
    }

    this.ensureStaticTokenCache();

    const memoryContext = this.sessionMemory.getPromptMemoryContext();
    const sessionStatus = this.sessionMemory.getSessionStatus?.() ?? null;
    const staticSections = this.getStaticPromptSections();
    const cached = this.understandContextCache;
    const sessionKey = buildSessionCacheKey(memoryContext);
    const sameSession = cached?.sessionKey === sessionKey;

    const conversationTurns = memoryContext.conversationTurns ?? [];
    const conversationSection = sameSession
      ? appendConversationSection(cached?.conversationTurns ?? [], cached?.conversationSection ?? "", conversationTurns)
      : renderConversationSection(conversationTurns);

    const previousSessionSummary = memoryContext.previousSessionSummary ?? "";
    const memorySection = sameSession && cached?.previousSessionSummary === previousSessionSummary
      ? cached.memorySection
      : renderMemorySection(previousSessionSummary);

    const activeSessionPath = memoryContext.activeSessionPath ?? "";
    const currentSessionSection = sameSession && cached?.activeSessionPath === activeSessionPath
      ? cached.currentSessionSection
      : renderCurrentSessionSection(activeSessionPath);

    const recentTasksFingerprint = JSON.stringify(memoryContext.recentTaskSummaries ?? []);
    const recentTasksSection = sameSession && cached?.recentTasksFingerprint === recentTasksFingerprint
      ? cached.recentTasksSection
      : renderRecentTasksSection(memoryContext.recentTaskSummaries ?? []);

    const recentSystemActivityFingerprint = JSON.stringify(memoryContext.recentSystemActivity ?? []);
    const recentSystemActivitySection = sameSession && cached?.recentSystemActivityFingerprint === recentSystemActivityFingerprint
      ? cached.recentSystemActivitySection
      : renderSystemActivitySection(memoryContext.recentSystemActivity ?? []);

    const dynamicContext = joinPromptSections([
      conversationSection,
      memorySection,
      currentSessionSection,
      recentTasksSection,
      recentSystemActivitySection,
    ]);
    const systemContextWithoutStatus = joinPromptSections([
      staticSections.head,
      dynamicContext,
      staticSections.tail,
    ]);

    const sessionStatusFingerprint = JSON.stringify(sessionStatus);
    const systemContext = sameSession
      && cached?.systemContextWithoutStatus === systemContextWithoutStatus
      && cached?.sessionStatusFingerprint === sessionStatusFingerprint
      ? cached.systemContext
      : joinPromptSections([
        systemContextWithoutStatus,
        renderSessionStatusSection(sessionStatus),
      ]);
    const dynamicSystemTokens = sameSession && cached?.dynamicContext === dynamicContext
      ? cached.dynamicSystemTokens
      : estimateTextTokens(dynamicContext);

    this.understandContextCache = {
      sessionKey,
      conversationTurns: cloneConversationTurns(conversationTurns),
      conversationSection,
      previousSessionSummary,
      memorySection,
      activeSessionPath,
      currentSessionSection,
      recentTasksFingerprint,
      recentTasksSection,
      recentSystemActivityFingerprint,
      recentSystemActivitySection,
      sessionStatusFingerprint,
      systemContextWithoutStatus,
      systemContext,
      dynamicContext,
      dynamicSystemTokens,
    };

    return {
      systemContext,
      controllerSystemContext: staticSections.controllerSystemContext,
      dynamicSystemTokens,
    };
  }

  private toSystemEvent(data: unknown): AyatiSystemEvent | null {
    if (!data || typeof data !== "object") return null;
    const value = data as Record<string, unknown>;
    if (value["type"] !== "system_event") return null;
    const source = asRequiredString(value["source"]);
    const eventName = asRequiredString(value["eventName"]) ?? asRequiredString(value["event"]);
    if (!source || !eventName) {
      return null;
    }

    const eventId = asOptionalString(value["eventId"]) ?? randomUUID();
    const receivedAt = asOptionalString(value["receivedAt"])
      ?? asOptionalString(value["occurredAt"])
      ?? asOptionalString(value["triggeredAt"])
      ?? asOptionalString(value["scheduledFor"])
      ?? this.nowProvider().toISOString();
    const summary = this.toSystemEventSummary(source, eventName, value);
    if (!summary) {
      return null;
    }
    const payload = this.toSystemEventPayload(value);
    const intent = this.toSystemEventIntent(value);

    return normalizeSystemEvent({
      eventId,
      source,
      eventName,
      receivedAt,
      summary,
      payload,
      ...(intent ? { intent } : {}),
    });
  }

  private rotateSessionBeforeRunIfNeeded(clientId: string, _incomingMessage: string): void {
    const createSession = this.sessionMemory.createSession;
    if (!createSession) {
      return;
    }

    const sessionStatus = this.sessionMemory.getSessionStatus?.() ?? null;
    if (!sessionStatus) {
      return;
    }

    const rotationDecision = evaluateSessionRotation({
      now: this.nowProvider(),
      contextPercent: sessionStatus.contextPercent,
      sessionStartedAt: sessionStatus.startedAt,
      timezone: this.resolveUserTimezone(),
      pendingRotationReason: sessionStatus.pendingRotationReason,
      config: this.rotationPolicyConfig,
    });

    if (!rotationDecision.rotate) {
      return;
    }

    createSession.call(this.sessionMemory, clientId, {
      runId: `pre-run-rotation-${Date.now()}`,
      reason: rotationDecision.reason ?? "policy_rotation",
      source: "system",
      timezone: rotationDecision.timezone,
    });

    devWarn(
      `Pre-run session rotation triggered (${rotationDecision.reason ?? "unknown"}) at ${Math.round(sessionStatus.contextPercent)}% context`,
    );
  }

  private async completeSessionLifecycle(
    clientId: string,
    runHandle: MemoryRunHandle | null,
    status: "completed" | "failed" | "stuck" | null,
  ): Promise<void> {
    if (!runHandle || !status) {
      return;
    }

    try {
      await this.sessionMemory.updateSessionLifecycle?.(clientId, {
        runId: runHandle.runId,
        sessionId: runHandle.sessionId,
        timezone: this.resolveUserTimezone(),
        status,
      });
      await this.sessionMemory.flushPersistence?.();
    } catch (err) {
      devWarn("Session lifecycle update failed:", err instanceof Error ? err.message : String(err));
    }
  }

  private resolveUserTimezone(): string | null {
    return this.staticContext?.userProfile.timezone ?? null;
  }

  private ensureStaticTokenCache(): void {
    if (this.staticTokensReady) return;
    if (!this.staticContext) {
      this.staticSystemTokens = 0;
      this.staticTokensReady = true;
      this.sessionMemory.setStaticTokenBudget(0);
      return;
    }

    const staticOnlyPrompt = this.buildStaticSystemContextText();

    const promptTokens = estimateTextTokens(staticOnlyPrompt);

    this.staticSystemTokens = promptTokens;
    this.staticTokensReady = true;
    this.sessionMemory.setStaticTokenBudget(this.staticSystemTokens);
    devLog(`Static context tokens cached: ${this.staticSystemTokens} (prompt=${promptTokens})`);
  }

  private buildStaticSystemContextText(): string {
    return this.getStaticPromptSections().controllerSystemContext;
  }

  private getStaticPromptSections(): StaticPromptSectionsCache {
    if (this.staticPromptSections) {
      return this.staticPromptSections;
    }

    if (!this.staticContext) {
      this.staticPromptSections = {
        head: "",
        tail: "",
        controllerSystemContext: "",
      };
      return this.staticPromptSections;
    }

    const head = joinPromptSections([
      renderBasePromptSection(this.staticContext.basePrompt),
      renderSoulSection(this.staticContext.soul),
      renderUserProfileSection(this.staticContext.userProfile),
    ]);
    const tail = joinPromptSections([
      renderSkillsSection(this.staticContext.skillBlocks),
      renderToolDirectorySection(
        this.staticContext.toolDirectory,
        this.shouldIncludeToolDirectoryInPrompt(),
      ),
    ]);
    this.staticPromptSections = {
      head,
      tail,
      controllerSystemContext: joinPromptSections([head, tail]),
    };
    return this.staticPromptSections;
  }

  private toSystemEventSummary(
    source: string,
    eventName: string,
    value: Record<string, unknown>,
  ): string | null {
    const summary = asOptionalString(value["summary"]);
    if (summary) {
      return summary;
    }

    const title = asOptionalString(value["title"]);
    const instruction = asOptionalString(value["instruction"]);
    if (source === "pulse" && eventName === "reminder_due") {
      return title
        ? `Reminder due: ${title}`
        : instruction
          ? `Reminder due: ${instruction}`
          : "Reminder due";
    }
    if (source === "pulse" && eventName === "task_due") {
      return title
        ? `Scheduled task due: ${title}`
        : instruction
          ? `Scheduled task due: ${instruction}`
          : "Scheduled task due";
    }

    const fallback = `${source} ${eventName}`.trim();
    return title ?? instruction ?? (fallback.length > 0 ? fallback : null);
  }

  private toSystemEventPayload(value: Record<string, unknown>): Record<string, unknown> {
    const directPayload = asRecord(value["payload"]);
    if (directPayload) {
      return directPayload;
    }

    const metadata = asRecord(value["metadata"]);
    const payload: Record<string, unknown> = {};
    const fieldMap = {
      occurrenceId: value["occurrenceId"],
      scheduledItemId: value["scheduledItemId"],
      reminderId: value["reminderId"],
      taskId: value["taskId"],
      title: value["title"],
      instruction: value["instruction"],
      scheduledFor: value["scheduledFor"],
      triggeredAt: value["triggeredAt"],
      timezone: value["timezone"],
      intentKind: value["intentKind"],
      requestedAction: value["requestedAction"],
      originRunId: value["originRunId"],
      originSessionId: value["originSessionId"],
    } satisfies Record<string, unknown>;

    for (const [key, fieldValue] of Object.entries(fieldMap)) {
      if (fieldValue !== undefined) {
        payload[key] = fieldValue;
      }
    }

    if (metadata) {
      payload["metadata"] = metadata;
    }

    return payload;
  }

  private toSystemEventIntent(value: Record<string, unknown>): SystemEventIntentMetadata | undefined {
    const nestedIntent = asRecord(value["intent"]);
    const kind = asSystemEventIntentKind(nestedIntent?.["kind"])
      ?? asSystemEventIntentKind(value["intentKind"]);
    const eventClass = asSystemEventClass(nestedIntent?.["eventClass"])
      ?? asSystemEventClass(value["eventClass"])
      ?? asSystemEventClass(value["event_class"]);
    const trustTier = asSystemEventTrustTier(nestedIntent?.["trustTier"])
      ?? asSystemEventTrustTier(value["trustTier"])
      ?? asSystemEventTrustTier(value["trust_tier"]);
    const effectLevel = asSystemEventEffectLevel(nestedIntent?.["effectLevel"])
      ?? asSystemEventEffectLevel(value["effectLevel"])
      ?? asSystemEventEffectLevel(value["effect_level"]);
    const requestedAction = asOptionalString(nestedIntent?.["requestedAction"])
      ?? asOptionalString(value["requestedAction"]);
    const createdBy = asSystemEventCreatedBy(nestedIntent?.["createdBy"])
      ?? asSystemEventCreatedBy(value["createdBy"]);

    if (!kind && !eventClass && !trustTier && !effectLevel && !requestedAction && !createdBy) {
      return undefined;
    }

    return {
      ...(kind ? { kind } : {}),
      ...(eventClass ? { eventClass } : {}),
      ...(trustTier ? { trustTier } : {}),
      ...(effectLevel ? { effectLevel } : {}),
      ...(requestedAction ? { requestedAction } : {}),
      ...(createdBy ? { createdBy } : {}),
    };
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

  private queueTaskSummaryPublication(
    clientId: string,
    runHandle: MemoryRunHandle,
    taskSummary: AgentLoopResult["taskSummary"] | undefined,
  ): void {
    if (!taskSummary) {
      return;
    }

    const payload = {
      ...taskSummary,
      sessionId: runHandle.sessionId,
    };

    if (this.sessionMemory.queueTaskSummary) {
      void Promise.resolve(this.sessionMemory.queueTaskSummary(clientId, payload)).catch((err) => {
        devWarn(`Task summary queue failed: ${err instanceof Error ? err.message : String(err)}`);
      });
      return;
    }

    this.sessionMemory.recordTaskSummary?.(clientId, payload);
  }

  private shouldIncludeToolDirectoryInPrompt(): boolean {
    return process.env["PROMPT_INCLUDE_TOOL_DIRECTORY"] === "1";
  }

  private sendAssistantReply(
    clientId: string,
    runHandle: MemoryRunHandle,
    content: string,
    artifacts?: AgentArtifact[],
  ): void {
    this.recordTurnStatus(clientId, runHandle, "response_started");
    this.sessionMemory.recordAssistantFinal(
      clientId,
      runHandle.runId,
      runHandle.sessionId,
      content,
      { responseKind: "reply" },
    );
    this.recordTurnStatus(clientId, runHandle, "response_completed");
    const artifactPayload = artifacts && artifacts.length > 0
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
    runHandle: MemoryRunHandle,
    content: string,
    artifacts?: AgentArtifact[],
  ): void {
    this.recordTurnStatus(clientId, runHandle, "response_started");
    this.sessionMemory.recordAssistantFinal(
      clientId,
      runHandle.runId,
      runHandle.sessionId,
      content,
      { responseKind: "feedback" },
    );
    this.recordTurnStatus(clientId, runHandle, "response_completed");
    const artifactPayload = artifacts && artifacts.length > 0
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
    runHandle: MemoryRunHandle,
    content: string,
    artifacts?: AgentArtifact[],
    meta?: {
      source?: string;
      event?: string;
      eventId?: string;
    },
  ): void {
    this.recordTurnStatus(clientId, runHandle, "response_started");
    this.sessionMemory.recordAssistantFinal(
      clientId,
      runHandle.runId,
      runHandle.sessionId,
      content,
      { responseKind: "notification" },
    );
    this.sessionMemory.recordAssistantNotification?.(clientId, {
      runId: runHandle.runId,
      sessionId: runHandle.sessionId,
      message: content,
      source: meta?.source,
      event: meta?.event,
      eventId: meta?.eventId,
    });
    this.recordTurnStatus(clientId, runHandle, "response_completed");
    const artifactPayload = artifacts && artifacts.length > 0
      ? { artifacts, runId: runHandle.runId }
      : {};
    this.onReply?.(clientId, {
      type: "notification",
      content,
      ...artifactPayload,
    });
  }

  private dispatchAgentResponse(
    clientId: string,
    runHandle: MemoryRunHandle,
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
        this.recordTurnStatus(clientId, runHandle, "response_completed", "delivery=none");
        return;
    }
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

  private async registerIncomingDocuments(
    attachments: ChatAttachmentInput[],
  ): Promise<{ documents: ManagedDocumentManifest[]; warnings: string[] }> {
    if (attachments.length === 0) {
      return { documents: [], warnings: [] };
    }

    if (!this.documentStore) {
      return {
        documents: [],
        warnings: ["Attachments were provided but no document store is configured."],
      };
    }

    return this.documentStore.registerAttachments(attachments);
  }
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function asRequiredString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asOptionalPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asSystemEventIntentKind(value: unknown): SystemEventIntentKind | undefined {
  return value === "reminder" || value === "task" || value === "notification" || value === "unknown"
    ? value
    : undefined;
}

function asSystemEventCreatedBy(value: unknown): SystemEventCreatedBy | undefined {
  return value === "user" || value === "agent" || value === "system" || value === "external" || value === "unknown"
    ? value
    : undefined;
}

function asSystemEventClass(value: unknown): SystemEventClass | undefined {
  return value === "message_received"
    || value === "trigger_fired"
    || value === "task_requested"
    || value === "state_changed"
    || value === "artifact_received"
    || value === "approval_response"
    ? value
    : undefined;
}

function asSystemEventTrustTier(value: unknown): SystemEventTrustTier | undefined {
  return value === "internal" || value === "trusted_system" || value === "external"
    ? value
    : undefined;
}

function asSystemEventEffectLevel(value: unknown): SystemEventEffectLevel | undefined {
  return value === "observe" || value === "assist" || value === "act" || value === "act_external"
    ? value
    : undefined;
}

export function parseChatInboundMessage(data: unknown): ChatInboundMessage | null {
  if (!data || typeof data !== "object") {
    return null;
  }

  const payload = data as Record<string, unknown>;
  if (payload["type"] !== "chat") {
    return null;
  }

  const content = payload["content"];
  if (typeof content !== "string") {
    return null;
  }

  const attachmentsRaw = payload["attachments"];
  if (!Array.isArray(attachmentsRaw)) {
    return { type: "chat", content };
  }

  const attachments: ChatAttachmentInput[] = [];
  for (const row of attachmentsRaw) {
    const value = asRecord(row);
    if (!value) {
      continue;
    }

    const source = typeof value["source"] === "string" ? value["source"].trim().toLowerCase() : undefined;
    if ((source === undefined || source === "cli")) {
      const path = typeof value["path"] === "string" ? value["path"].trim() : "";
      if (path.length === 0) {
        continue;
      }

      const name = typeof value["name"] === "string" ? value["name"].trim() : undefined;
      attachments.push({
        source: "cli",
        path,
        ...(name ? { name } : {}),
      });
      continue;
    }

    if (source !== "web") {
      continue;
    }

    const uploadedPath = typeof value["uploadedPath"] === "string" ? value["uploadedPath"].trim() : "";
    const originalName = typeof value["originalName"] === "string" ? value["originalName"].trim() : "";
    if (uploadedPath.length === 0 || originalName.length === 0) {
      continue;
    }

    const mimeType = typeof value["mimeType"] === "string" ? value["mimeType"].trim() : undefined;
    const sizeBytes = asOptionalPositiveNumber(value["sizeBytes"]);
    attachments.push({
      source: "web",
      uploadedPath,
      originalName,
      ...(mimeType ? { mimeType } : {}),
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    });
  }

  return {
    type: "chat",
    content,
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

function joinPromptSections(sections: string[]): string {
  return sections.filter((section) => section.trim().length > 0).join("\n\n").trim();
}

function renderToolDirectorySection(toolDirectory: string | undefined, includeToolDirectory: boolean): string {
  if (!includeToolDirectory) return "";
  if (!toolDirectory || toolDirectory.trim().length === 0) return "";
  return `# Available Tools\n\n${toolDirectory}`;
}

function buildSessionCacheKey(memoryContext: PromptMemoryContext): string {
  const activeSessionPath = memoryContext.activeSessionPath?.trim();
  return activeSessionPath && activeSessionPath.length > 0 ? activeSessionPath : "__no_active_session__";
}

function cloneConversationTurns(turns: ConversationTurn[]): ConversationTurn[] {
  return turns.map((turn) => ({ ...turn }));
}

function appendConversationSection(
  previousTurns: ConversationTurn[],
  previousSection: string,
  nextTurns: ConversationTurn[],
): string {
  if (nextTurns.length === 0) {
    return "";
  }

  if (previousTurns.length === 0 || !isConversationPrefix(previousTurns, nextTurns)) {
    return renderConversationSection(nextTurns);
  }

  if (previousTurns.length === nextTurns.length) {
    return previousSection;
  }

  const appendedLines = renderConversationLines(nextTurns.slice(previousTurns.length));
  if (appendedLines.length === 0) {
    return previousSection;
  }

  if (previousSection.trim().length === 0) {
    return renderConversationSection(nextTurns);
  }

  return `${previousSection}\n${appendedLines.join("\n")}`;
}

function isConversationPrefix(previousTurns: ConversationTurn[], nextTurns: ConversationTurn[]): boolean {
  if (previousTurns.length > nextTurns.length) {
    return false;
  }

  for (let index = 0; index < previousTurns.length; index++) {
    const previous = previousTurns[index];
    const next = nextTurns[index];
    if (!previous || !next) {
      return false;
    }
    if (
      previous.role !== next.role
      || previous.content !== next.content
      || previous.timestamp !== next.timestamp
      || previous.sessionPath !== next.sessionPath
      || previous.runId !== next.runId
      || previous.assistantResponseKind !== next.assistantResponseKind
    ) {
      return false;
    }
  }

  return true;
}

export { IVecEngine as AgentEngine };
export type AgentEngineOptions = IVecEngineOptions;
