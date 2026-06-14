import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { LlmProvider } from "../core/contracts/provider.js";
import { noopSessionMemory } from "../memory/provider.js";
import type { SessionMemory, MemoryRunHandle } from "../memory/types.js";
import type { StaticContext } from "../context/static-context-cache.js";
import { renderBasePromptSection } from "../prompt/sections/base.js";
import { renderSkillsSection } from "../prompt/sections/skills.js";
import { renderSoulSection } from "../prompt/sections/soul.js";
import { estimateTextTokens } from "../prompt/token-estimator.js";
import {
  appendPulseProposalQuestion,
  PulseProposalReflectionService,
} from "../pulse/proposal-reflection.js";
import type { ToolExecutor } from "../skills/tool-executor.js";
import type { ToolDefinition } from "../skills/types.js";
import type { SkillActivationManager } from "../skills/activation-manager.js";
import { devLog, devWarn, devError } from "../shared/index.js";
import type { ManagedDocumentManifest } from "../documents/types.js";
import type { DocumentStore } from "../documents/document-store.js";
import type { DocumentContextBackend } from "../documents/document-context-backend.js";
import { PreparedAttachmentRegistry } from "../documents/prepared-attachment-registry.js";
import type { DirectoryLibrary } from "../files/directory-library.js";
import type { FileLibrary } from "../files/file-library.js";
import type { DirectoryAttachmentRecord, ManagedFileRecord } from "../files/types.js";
import type { CourseStore } from "../learning/course-store.js";
import { LearningFileStore, shouldLoadLearningContext } from "../learning/file-store.js";
import type { ActiveLearningContext } from "../learning/types.js";
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
  DirectoryChatAttachmentInput,
  LoopConfig,
  SystemEventApprovalState,
} from "./types.js";

interface SystemContextBuildResult {
  systemContext: string;
  decisionSystemContext: string;
  dynamicSystemTokens: number;
  activeLearningContext?: string;
}

interface StaticPromptSectionsCache {
  head: string;
  tail: string;
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
  skillActivationManager?: SkillActivationManager;
  loopConfig?: Partial<LoopConfig>;
  rotationPolicyConfig?: Partial<RotationPolicyConfig>;
  now?: () => Date;
  dataDir?: string;
  documentStore?: DocumentStore;
  preparedAttachmentRegistry?: PreparedAttachmentRegistry;
  documentContextBackend?: DocumentContextBackend;
  fileLibrary?: FileLibrary;
  directoryLibrary?: DirectoryLibrary;
  courseStore?: CourseStore;
  learningFileStore?: LearningFileStore;
  systemEventPolicy?: SystemEventPolicyConfig;
}

export class IVecEngine {
  private readonly onReply?: (clientId: string, data: unknown) => void;
  private readonly provider?: LlmProvider;
  private readonly staticContext?: StaticContext;
  private readonly toolExecutor?: ToolExecutor;
  private readonly skillActivationManager?: SkillActivationManager;
  private sessionMemory: SessionMemory;
  private readonly loopConfig?: Partial<LoopConfig>;
  private readonly rotationPolicyConfig?: Partial<RotationPolicyConfig>;
  private readonly nowProvider: () => Date;
  private readonly dataDir?: string;
  private readonly documentStore?: DocumentStore;
  private readonly preparedAttachmentRegistry?: PreparedAttachmentRegistry;
  private readonly documentContextBackend?: DocumentContextBackend;
  private readonly fileLibrary?: FileLibrary;
  private readonly directoryLibrary?: DirectoryLibrary;
  private readonly courseStore?: CourseStore;
  private readonly learningFileStore?: LearningFileStore;
  private readonly systemEventPolicy?: SystemEventPolicyConfig;
  private readonly pulseProposalReflectionService = new PulseProposalReflectionService();
  private staticSystemTokens = 0;
  private staticTokensReady = false;
  private staticPromptSections?: StaticPromptSectionsCache;

  constructor(options?: IVecEngineOptions) {
    this.onReply = options?.onReply;
    this.provider = options?.provider;
    this.staticContext = options?.staticContext;
    this.toolExecutor = options?.toolExecutor;
    this.skillActivationManager = options?.skillActivationManager;
    this.sessionMemory = options?.sessionMemory ?? noopSessionMemory;
    this.loopConfig = options?.loopConfig;
    this.rotationPolicyConfig = options?.rotationPolicyConfig;
    this.nowProvider = options?.now ?? (() => new Date());
    this.dataDir = options?.dataDir;
    this.documentStore = options?.documentStore;
    this.preparedAttachmentRegistry = options?.preparedAttachmentRegistry
      ?? (this.documentStore ? new PreparedAttachmentRegistry() : undefined);
    this.documentContextBackend = options?.documentContextBackend;
    this.fileLibrary = options?.fileLibrary;
    this.directoryLibrary = options?.directoryLibrary;
    this.courseStore = options?.courseStore;
    this.learningFileStore = options?.learningFileStore;
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

    void this.processChat(clientId, msg.content, msg.attachments ?? [], msg.uiContext);
  }

  async handleSystemEvent(clientId: string, event: AyatiSystemEvent): Promise<void> {
    await this.processSystemEvent(clientId, event);
  }

  private async processChat(
    clientId: string,
    content: string,
    attachments: ChatAttachmentInput[],
    uiContext?: ChatInboundMessage["uiContext"],
  ): Promise<void> {
    let runHandle: MemoryRunHandle | null = null;
    let runStatus: "completed" | "failed" | "stuck" | null = null;
    try {
      this.rotateSessionBeforeRunIfNeeded(clientId, content);
      runHandle = this.sessionMemory.beginRun(clientId, content);
      this.recordTurnStatus(clientId, runHandle, "processing_started");

      if (this.provider) {
        const registeredAttachments = await this.registerIncomingDocuments(attachments, runHandle.runId);
        const toolDefs = this.toolExecutor?.definitions({
          clientId,
          runId: runHandle.runId,
          sessionId: runHandle.sessionId,
        }) ?? [];
        const system = await this.buildSystemContext(clientId, content);
        let result = await agentLoop({
          provider: this.provider,
          toolExecutor: this.toolExecutor,
          skillActivationManager: this.skillActivationManager,
          toolDefinitions: toolDefs,
          sessionMemory: this.sessionMemory,
          runHandle,
          clientId,
          uiContext,
          initialUserMessage: content,
          config: this.loopConfig,
          dataDir: this.dataDir ?? "data",
          systemContext: system.decisionSystemContext || system.systemContext || undefined,
          activeLearningContext: system.activeLearningContext,
          attachedDocuments: registeredAttachments.documents,
          attachmentWarnings: registeredAttachments.warnings,
          managedFiles: registeredAttachments.managedFiles,
          managedDirectories: registeredAttachments.managedDirectories,
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
            this.sendProgress(clientId, runHandle!, log);
          },
        });
        result = await this.applyPulseProposalReflection(clientId, content, result, toolDefs);
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
      const system = await this.buildSystemContext(clientId, event.summary);
      devLog(
        `[${clientId}] system_event entering agentLoop eventId=${event.eventId} mode=${systemEventPlan.policy.mode} intent=${systemEventPlan.classification.intentKind} approval=${systemEventPlan.policy.approvalRequired ? "required" : "not_required"} tools=${toolDefs.length} payloadKeys=${Object.keys(event.payload).join(",") || "none"}`,
      );
      const result = await agentLoop({
        provider: this.provider,
        toolExecutor: this.toolExecutor,
        skillActivationManager: this.skillActivationManager,
        toolDefinitions: toolDefs,
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
        systemContext: system.decisionSystemContext || system.systemContext || undefined,
        activeLearningContext: system.activeLearningContext,
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
          this.sendProgress(clientId, runHandle!, log);
        },
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

  private async buildSystemContext(clientId: string, userMessage = ""): Promise<SystemContextBuildResult> {
    if (!this.staticContext) {
      return { systemContext: "", decisionSystemContext: "", dynamicSystemTokens: 0 };
    }

    this.ensureStaticTokenCache();

    const staticSections = this.getStaticPromptSections();
    const activeLearningSection = await this.renderActiveLearningContextSection(clientId, userMessage);
    const decisionSystemContext = joinPromptSections([
      staticSections.head,
      staticSections.tail,
    ]);

    return {
      systemContext: decisionSystemContext,
      decisionSystemContext,
      dynamicSystemTokens: 0,
      activeLearningContext: activeLearningSection || undefined,
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
      timezone: null,
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
        timezone: null,
        status,
      });
      await this.sessionMemory.flushPersistence?.();
    } catch (err) {
      devWarn("Session lifecycle update failed:", err instanceof Error ? err.message : String(err));
    }
  }

  private async renderActiveLearningContextSection(clientId: string, userMessage: string): Promise<string> {
    if (this.learningFileStore) {
      try {
        const context = await this.learningFileStore.renderPromptContext(userMessage);
        if (context.included) {
          return context.context;
        }
      } catch (err) {
        devWarn("Learning V2 context unavailable:", err instanceof Error ? err.message : String(err));
      }
    }

    if (!this.courseStore) {
      return "";
    }
    try {
      const activeCourse = await this.courseStore.getActiveCourse(clientId);
      if (!activeCourse) {
        return "";
      }
      const fallbackStatus = {
        schemaVersion: 2 as const,
        rootPath: "",
        systemDir: "",
        interestsDir: "",
        protocolPath: "",
        preferencesPath: "",
        activePath: "",
        activeState: {
          schemaVersion: 2 as const,
          activeInterestId: activeCourse.courseId,
          learningMode: "inactive" as const,
          updatedAt: activeCourse.updatedAt,
        },
        interests: [{
          interestId: activeCourse.courseId,
          title: activeCourse.title,
          rootPath: "",
          coursePath: "",
          indexPath: "",
          feedbackPath: "",
          logPath: "",
          lessonsDir: "",
          lessons: [],
        }],
        activeInterest: {
          interestId: activeCourse.courseId,
          title: activeCourse.title,
          rootPath: "",
          coursePath: "",
          indexPath: "",
          feedbackPath: "",
          logPath: "",
          lessonsDir: "",
          lessons: [],
        },
      };
      if (!shouldLoadLearningContext(fallbackStatus, userMessage).load) {
        return "";
      }
      const context = await this.courseStore.getActiveLearningContext(clientId);
      if (!context) {
        return "";
      }
      return renderActiveLearningContext(context);
    } catch (err) {
      devWarn("Active learning context unavailable:", err instanceof Error ? err.message : String(err));
      return "";
    }
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
    const sections = this.getStaticPromptSections();
    return joinPromptSections([sections.head, sections.tail]);
  }

  private getStaticPromptSections(): StaticPromptSectionsCache {
    if (this.staticPromptSections) {
      return this.staticPromptSections;
    }

    if (!this.staticContext) {
      this.staticPromptSections = {
        head: "",
        tail: "",
      };
      return this.staticPromptSections;
    }

    const head = joinPromptSections([
      renderBasePromptSection(this.staticContext.basePrompt),
      renderSoulSection(this.staticContext.soul),
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

  private async applyPulseProposalReflection(
    clientId: string,
    userMessage: string,
    result: AgentLoopResult,
    toolDefinitions: ToolDefinition[],
  ): Promise<AgentLoopResult> {
    if (!this.provider || result.type !== "reply" || result.status !== "completed" || result.runClass !== "task" || !result.taskSummary) {
      return result;
    }

    try {
      const reflection = await this.pulseProposalReflectionService.reflect({
        provider: this.provider,
        currentUserMessage: userMessage,
        assistantResponse: result.content,
        taskSummary: result.taskSummary,
        memoryContext: this.sessionMemory.getPromptMemoryContext(),
        toolDefinitions,
        now: this.nowProvider(),
      });

      if (reflection.action !== "ask_user") {
        if (reflection.reason) {
          devLog(`[${clientId}] pulse proposal reflection skipped: ${reflection.reason}`);
        }
        return result;
      }

      devLog(
        `[${clientId}] pulse proposal reflection asking confidence=${reflection.confidence.toFixed(2)} reason=${reflection.reason}`,
      );
      const content = appendPulseProposalQuestion(result.content, reflection.question);
      return {
        ...result,
        type: "feedback",
        content,
        taskSummary: {
          ...result.taskSummary,
          assistantResponse: content,
          assistantResponseKind: "feedback",
        },
      };
    } catch (err) {
      devWarn("Pulse proposal reflection failed:", err instanceof Error ? err.message : String(err));
      return result;
    }
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
      final: true,
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

  private async registerIncomingDocuments(
    attachments: ChatAttachmentInput[],
    runId: string,
  ): Promise<{
    documents: ManagedDocumentManifest[];
    warnings: string[];
    managedFiles: ManagedFileRecord[];
    managedDirectories: DirectoryAttachmentRecord[];
  }> {
    if (attachments.length === 0) {
      return { documents: [], warnings: [], managedFiles: [], managedDirectories: [] };
    }

    if (this.fileLibrary) {
      const managedFiles: ManagedFileRecord[] = [];
      const managedDirectories: DirectoryAttachmentRecord[] = [];
      const warnings: string[] = [];
      for (const attachment of attachments) {
        try {
          if (isDirectoryChatAttachment(attachment)) {
            if (!this.directoryLibrary) {
              warnings.push(`${formatAttachmentLabel(attachment)}: Directory attachments are not configured.`);
              continue;
            }
            managedDirectories.push(await this.directoryLibrary.registerPath({
              path: attachment.path,
              name: attachment.name,
              runId,
              include: attachment.include,
              exclude: attachment.exclude,
              maxDepth: attachment.maxDepth,
              maxFiles: attachment.maxFiles,
            }));
            continue;
          }

          managedFiles.push(await this.registerIncomingManagedFile(attachment, runId));
        } catch (err) {
          warnings.push(`${formatAttachmentLabel(attachment)}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      return {
        documents: managedFiles.map(managedFileToDocumentManifest),
        warnings,
        managedFiles,
        managedDirectories,
      };
    }

    if (!this.documentStore) {
      return {
        documents: [],
        warnings: ["Attachments were provided but no document store is configured."],
        managedFiles: [],
        managedDirectories: [],
      };
    }

    const registered = await this.documentStore.registerAttachments(attachments.filter(isLegacyDocumentAttachment));
    return { ...registered, managedFiles: [], managedDirectories: [] };
  }

  private async registerIncomingManagedFile(
    attachment: ChatAttachmentInput,
    runId: string,
  ): Promise<ManagedFileRecord> {
    if ("fileId" in attachment && typeof attachment.fileId === "string" && attachment.fileId.trim().length > 0) {
      await this.fileLibrary!.touchRunFile(runId, attachment.fileId, "attached");
      return this.fileLibrary!.getFile(attachment.fileId);
    }

    if (attachment.source === "upload") {
      const bytes = await readFile(attachment.uploadedPath);
      return this.fileLibrary!.registerUpload({
        originalName: attachment.originalName,
        bytes,
        origin: "user_upload",
        mimeType: attachment.mimeType,
        runId,
        runRole: "attached",
        originalPath: attachment.uploadedPath,
      });
    }

    if ("path" in attachment) {
      return this.fileLibrary!.registerPath({
        path: attachment.path,
        name: attachment.name,
        runId,
        runRole: "attached",
      });
    }

    throw new Error("Attachment is missing a usable fileId or path.");
  }
}

function managedFileToDocumentManifest(file: ManagedFileRecord): ManagedDocumentManifest {
  return {
    documentId: file.sha256.slice(0, 16),
    name: file.safeName,
    displayName: file.originalName,
    source: file.origin === "local_path" ? "cli" : "upload",
    originalPath: file.originalPath ?? file.sourceUri ?? file.storagePath,
    storedPath: file.storagePath,
    kind: file.kind,
    ...(file.mimeType ? { mimeType: file.mimeType } : {}),
    sizeBytes: file.sizeBytes,
    checksum: file.sha256,
  };
}

function isDirectoryChatAttachment(attachment: ChatAttachmentInput): attachment is DirectoryChatAttachmentInput {
  return attachment.type === "directory";
}

function isLegacyDocumentAttachment(
  attachment: ChatAttachmentInput,
): attachment is Exclude<ChatAttachmentInput, { fileId: string } | DirectoryChatAttachmentInput> {
  return !("fileId" in attachment) && !isDirectoryChatAttachment(attachment);
}

function formatAttachmentLabel(attachment: ChatAttachmentInput): string {
  if ("fileId" in attachment && typeof attachment.fileId === "string") {
    return attachment.fileId;
  }
  if (attachment.source === "upload") {
    return attachment.uploadedPath;
  }
  if (isDirectoryChatAttachment(attachment)) {
    return attachment.path;
  }
  return "path" in attachment ? attachment.path : "attachment";
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

function asOptionalPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function asOptionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value
    .map((entry) => typeof entry === "string" ? entry.trim() : "")
    .filter((entry) => entry.length > 0);
  return strings.length > 0 ? strings : undefined;
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

  const uiContext = parseAgentUiContext(payload["uiContext"]);
  const attachmentsRaw = payload["attachments"];
  if (!Array.isArray(attachmentsRaw)) {
    return {
      type: "chat",
      content,
      ...(uiContext ? { uiContext } : {}),
    };
  }

  const attachments: ChatAttachmentInput[] = [];
  for (const row of attachmentsRaw) {
    const value = asRecord(row);
    if (!value) {
      continue;
    }

    const fileId = typeof value["fileId"] === "string" ? value["fileId"].trim() : "";
    if (fileId.length > 0) {
      attachments.push({
        source: "file",
        fileId,
      });
      continue;
    }

    const attachmentType = typeof value["type"] === "string" ? value["type"].trim().toLowerCase() : undefined;
    const source = typeof value["source"] === "string" ? value["source"].trim().toLowerCase() : undefined;
    if (attachmentType === "directory") {
      if (source !== undefined && source !== "cli") {
        continue;
      }
      const path = typeof value["path"] === "string" ? value["path"].trim() : "";
      if (path.length === 0) {
        continue;
      }

      const name = typeof value["name"] === "string" ? value["name"].trim() : undefined;
      const include = asOptionalStringArray(value["include"]);
      const exclude = asOptionalStringArray(value["exclude"]);
      const maxDepth = asOptionalPositiveNumber(value["maxDepth"]);
      const maxFiles = asOptionalPositiveNumber(value["maxFiles"]);
      attachments.push({
        type: "directory",
        source: "cli",
        path,
        ...(name ? { name } : {}),
        ...(include ? { include } : {}),
        ...(exclude ? { exclude } : {}),
        ...(maxDepth !== undefined ? { maxDepth } : {}),
        ...(maxFiles !== undefined ? { maxFiles } : {}),
      });
      continue;
    }

    if (attachmentType !== "upload" && (source === undefined || source === "cli")) {
      const path = typeof value["path"] === "string" ? value["path"].trim() : "";
      if (path.length === 0) {
        continue;
      }

      const name = typeof value["name"] === "string" ? value["name"].trim() : undefined;
      attachments.push({
        ...(attachmentType === "file" ? { type: "file" as const } : {}),
        source: "cli",
        path,
        ...(name ? { name } : {}),
      });
      continue;
    }

    if (source !== "upload" && attachmentType !== "upload") {
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
      source: "upload",
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
    ...(uiContext ? { uiContext } : {}),
  };
}

function parseAgentUiContext(raw: unknown): ChatInboundMessage["uiContext"] | undefined {
  const value = asRecord(raw);
  if (!value || value["source"] !== "agent-cli") {
    return undefined;
  }

  const processTreePids = Array.isArray(value["processTreePids"])
    ? value["processTreePids"].flatMap((entry) => (
      typeof entry === "number" && Number.isInteger(entry) && entry > 0 ? [entry] : []
    ))
    : undefined;
  const terminalPid = asOptionalPositiveInteger(value["terminalPid"]);
  const processPid = asOptionalPositiveInteger(value["processPid"]);
  const workspaceId = asOptionalPositiveInteger(value["workspaceId"]);
  const windowAddress = asOptionalString(value["windowAddress"]);
  const windowClass = asOptionalString(value["windowClass"]);
  const windowTitle = asOptionalString(value["windowTitle"]);
  const workspaceName = asOptionalString(value["workspaceName"]);
  const monitor = asOptionalString(value["monitor"]);
  const detectedAt = asOptionalString(value["detectedAt"]);

  if (!windowAddress && !workspaceName && !workspaceId && !terminalPid && !processPid) {
    return undefined;
  }

  return {
    source: "agent-cli",
    ...(terminalPid !== undefined ? { terminalPid } : {}),
    ...(processPid !== undefined ? { processPid } : {}),
    ...(processTreePids && processTreePids.length > 0 ? { processTreePids: [...new Set(processTreePids)] } : {}),
    ...(windowAddress ? { windowAddress } : {}),
    ...(windowClass ? { windowClass } : {}),
    ...(windowTitle ? { windowTitle } : {}),
    ...(workspaceId !== undefined ? { workspaceId } : {}),
    ...(workspaceName ? { workspaceName } : {}),
    ...(monitor ? { monitor } : {}),
    ...(detectedAt ? { detectedAt } : {}),
  };
}

function joinPromptSections(sections: string[]): string {
  return sections.filter((section) => section.trim().length > 0).join("\n\n").trim();
}

function renderActiveLearningContext(context: ActiveLearningContext): string {
  const lesson = context.activeLesson;
  const lines = [
    "# Active Learning Context",
    "Use this section when the user is learning, continuing a course, or asking a doubt about the visible lesson. Do not generate duplicate core lessons; plan the next step from the course map and learning index.",
    `- active_course: ${context.course.title} (${context.course.courseId})`,
    `- topic: ${context.course.topic}`,
    `- status: ${context.course.status}`,
    ...(context.course.purpose ? [`- purpose: ${context.course.purpose}`] : []),
    ...(context.course.targetOutcome ? [`- target_outcome: ${context.course.targetOutcome}`] : []),
    ...(context.learnerProfile ? [`- learner_profile: ${formatInlineObject(context.learnerProfile)}`] : []),
    `- preferences: ${formatInlineObject(context.preferences)}`,
    ...(context.currentPosition ? [`- current_position: ${context.currentPosition}`] : []),
    `- learned_concepts: ${formatPromptValues(context.learnedConcepts)}`,
    `- weak_concepts: ${formatPromptValues(context.weakConcepts)}`,
    `- open_questions: ${formatPromptValues(context.openQuestions)}`,
    `- next_likely_topics: ${formatPromptValues(context.nextLikelyTopics)}`,
    `- course_next_candidates: ${formatPromptValues(context.courseMap.nextCandidates)}`,
    `- avoid_for_now: ${formatPromptValues(context.courseMap.avoidForNow)}`,
    `- direction_warnings: ${formatPromptValues(context.courseMap.wrongDirectionWarnings)}`,
    ...(lesson
      ? [
        "## Visible Lesson",
        `- lesson: ${lesson.title} (${lesson.lessonId})`,
        ...(lesson.purpose ? [`- lesson_purpose: ${lesson.purpose}`] : []),
        `- summary_for_agent: ${lesson.summaryForAgent}`,
        `- primitives: ${formatPromptValues(lesson.primitiveIdeas)}`,
        `- first_principles: ${formatPromptValues(lesson.firstPrinciples)}`,
        `- concepts_introduced: ${formatPromptValues(lesson.conceptsIntroduced)}`,
        `- concepts_practiced: ${formatPromptValues(lesson.conceptsPracticed)}`,
        `- examples_used: ${formatPromptValues(lesson.examplesUsed)}`,
        `- common_doubts: ${formatPromptValues(lesson.commonDoubts)}`,
        `- next_suggested_concepts: ${formatPromptValues(lesson.nextSuggestedConcepts)}`,
      ]
      : []),
  ];
  return lines.join("\n");
}

function formatPromptValues(values: string[]): string {
  return values.length > 0 ? values.join("; ") : "(none)";
}

function formatInlineObject(value: object): string {
  const entries = Object.entries(value)
    .filter(([, entry]) => {
      if (Array.isArray(entry)) {
        return entry.length > 0;
      }
      return entry !== undefined && entry !== null && String(entry).trim().length > 0;
    })
    .map(([key, entry]) => `${key}=${Array.isArray(entry) ? entry.join("|") : String(entry)}`);
  return entries.length > 0 ? entries.join("; ") : "(none)";
}

function renderToolDirectorySection(toolDirectory: string | undefined, includeToolDirectory: boolean): string {
  if (!includeToolDirectory) return "";
  if (!toolDirectory || toolDirectory.trim().length === 0) return "";
  return `# Available Tools\n\n${toolDirectory}`;
}

export { IVecEngine as AgentEngine };
export type AgentEngineOptions = IVecEngineOptions;
