import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { LlmProvider } from "../core/contracts/provider.js";
import { noopSessionMemory } from "../memory/provider.js";
import type { SessionMemory, MemoryRunHandle, SessionInputHandle } from "../memory/types.js";
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
import type { ToolWorkingSetManager } from "./agent-runner/tool-working-set.js";
import { devLog, devWarn, devError } from "../shared/index.js";
import type { ManagedDocumentManifest } from "../documents/types.js";
import type { DocumentStore } from "../documents/document-store.js";
import type { DocumentContextBackend } from "../documents/document-context-backend.js";
import { PreparedAttachmentRegistry } from "../documents/prepared-attachment-registry.js";
import type { DirectoryLibrary } from "../files/directory-library.js";
import type { FileLibrary } from "../files/file-library.js";
import type { DirectoryAttachmentRecord, ManagedFileRecord } from "../files/types.js";
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
import type { AgentFeedbackLedger } from "./feedback-ledger.js";
import {
  buildDailySessionRunCommitInput,
  type ContextEnginePreparedTurn,
  type ContextEngineRuntime,
} from "../context-engine/index.js";
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
  toolWorkingSetManager?: ToolWorkingSetManager;
  loopConfig?: Partial<LoopConfig>;
  rotationPolicyConfig?: Partial<RotationPolicyConfig>;
  now?: () => Date;
  dataDir?: string;
  documentStore?: DocumentStore;
  preparedAttachmentRegistry?: PreparedAttachmentRegistry;
  documentContextBackend?: DocumentContextBackend;
  fileLibrary?: FileLibrary;
  directoryLibrary?: DirectoryLibrary;
  systemEventPolicy?: SystemEventPolicyConfig;
  feedbackLedger?: AgentFeedbackLedger;
  dailySessionRuntime?: ContextEngineRuntime;
}

export class IVecEngine {
  private readonly onReply?: (clientId: string, data: unknown) => void;
  private readonly provider?: LlmProvider;
  private readonly staticContext?: StaticContext;
  private readonly toolExecutor?: ToolExecutor;
  private readonly skillActivationManager?: SkillActivationManager;
  private readonly toolWorkingSetManager?: ToolWorkingSetManager;
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
  private readonly systemEventPolicy?: SystemEventPolicyConfig;
  private readonly feedbackLedger?: AgentFeedbackLedger;
  private readonly dailySessionRuntime?: ContextEngineRuntime;
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
    this.toolWorkingSetManager = options?.toolWorkingSetManager;
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
    this.systemEventPolicy = options?.systemEventPolicy;
    this.feedbackLedger = options?.feedbackLedger;
    this.dailySessionRuntime = options?.dailySessionRuntime;
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
    let inputHandle: SessionInputHandle | null = null;
    let runHandle: MemoryRunHandle | null = null;
    let dailySessionTurn: ContextEnginePreparedTurn | null = null;
    let runStatus: "completed" | "failed" | "stuck" | null = null;
    try {
      this.rotateSessionBeforeRunIfNeeded(clientId, content);
      inputHandle = this.sessionMemory.recordUserMessage(clientId, content);
      this.feedbackLedger?.record({
        clientId,
        sessionId: inputHandle.sessionId,
        seq: inputHandle.seq,
        stage: "message",
        event: "received",
        data: {
          kind: "chat",
          content,
          attachments: attachments.map((attachment) => summarizeChatAttachment(attachment)),
          uiContext,
        },
      });
      dailySessionTurn = await this.prepareDailySessionTurn(clientId, content);
      if (dailySessionTurn?.status === "ambiguous") {
        await this.dispatchDailySessionAmbiguity(clientId, inputHandle, dailySessionTurn);
        runStatus = "completed";
        return;
      }

      if (this.provider) {
        if (attachments.length > 0) {
          runHandle = this.createWorkRun(clientId, inputHandle);
          this.recordTurnStatus(clientId, runHandle, "processing_started");
        }
        const registeredAttachments = runHandle
          ? await this.registerIncomingDocuments(attachments, runHandle.runId)
          : { documents: [], warnings: [], managedFiles: [], managedDirectories: [] };
        const toolDefs = this.toolExecutor?.definitions({
          clientId,
          runId: runHandle?.runId ?? this.inputScopeId(inputHandle),
          sessionId: inputHandle.sessionId,
        }) ?? [];
        const system = await this.buildSystemContext(clientId);
        let result = await agentLoop({
          provider: this.provider,
          toolExecutor: this.toolExecutor,
          skillActivationManager: this.skillActivationManager,
          toolWorkingSetManager: this.toolWorkingSetManager,
          toolDefinitions: toolDefs,
          sessionMemory: this.sessionMemory,
          inputHandle,
          ...(runHandle ? { runHandle } : {}),
          onWorkRunCreated: (created) => {
            runHandle = created;
            this.recordTurnStatus(clientId, created, "processing_started");
            this.feedbackLedger?.record({
              clientId,
              sessionId: created.sessionId,
              seq: inputHandle?.seq,
              runId: created.runId,
              stage: "run",
              event: "created",
              data: {
                source: "engine",
              },
            });
          },
          clientId,
          uiContext,
          initialUserMessage: content,
          config: this.loopConfig,
          dataDir: this.dataDir ?? "data",
          systemContext: system.decisionSystemContext || system.systemContext || undefined,
          dailySessionContext: dailySessionTurn?.context,
          feedbackLedger: this.feedbackLedger,
          attachedDocuments: registeredAttachments.documents,
          attachmentWarnings: registeredAttachments.warnings,
          managedFiles: registeredAttachments.managedFiles,
          managedDirectories: registeredAttachments.managedDirectories,
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
        result = await this.applyPulseProposalReflection(clientId, content, result, toolDefs);
        this.dispatchAgentResponse(clientId, inputHandle, runHandle, result);
        await this.completeDailySessionRun(clientId, dailySessionTurn, result);
        this.feedbackLedger?.record({
          clientId,
          sessionId: inputHandle.sessionId,
          seq: inputHandle.seq,
          ...(runHandle ? { runId: runHandle.runId } : {}),
          stage: "final",
          event: "dispatched",
          data: {
            type: result.type,
            status: result.status,
            content: result.content,
            artifacts: result.artifacts,
            runPath: result.runPath,
          },
        });
        this.queueTaskSummaryPublication(clientId, inputHandle, result.taskSummary);
        runStatus = result.status;
      } else {
        const echoContent = `Received: "${content}"`;
        this.dispatchAgentResponse(clientId, inputHandle, null, {
          type: "reply",
          content: echoContent,
        });
        await this.recordDailySessionAssistantMessage(clientId, dailySessionTurn, echoContent);
        runStatus = "completed";
      }
    } catch (err) {
      devError("Provider error:", err);
      this.feedbackLedger?.record({
        clientId,
        ...(inputHandle ? { sessionId: inputHandle.sessionId, seq: inputHandle.seq } : {}),
        ...(runHandle ? { runId: runHandle.runId } : {}),
        stage: "final",
        event: "error",
        data: {
          message: err instanceof Error ? err.message : String(err),
        },
      });
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

  private async prepareDailySessionTurn(
    clientId: string,
    userMessage: string,
  ): Promise<ContextEnginePreparedTurn | null> {
    if (!this.dailySessionRuntime) {
      return null;
    }
    try {
      const turn = await this.dailySessionRuntime.prepareUserTurn({
        userMessage,
        at: this.nowProvider().toISOString(),
      });
      this.feedbackLedger?.record({
        clientId,
        sessionId: turn.sessionId,
        ...(turn.status === "ready" ? { runId: turn.runId } : {}),
        stage: "git_context",
        event: "prepared",
        data: {
          status: turn.status,
          ...(turn.status === "ready" ? {
            workId: turn.workId,
            ref: turn.ref,
          } : {
            candidateCount: turn.candidateCount,
          }),
        },
      });
      return turn;
    } catch (err) {
      devWarn("Daily session git context preparation failed:", err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  private async dispatchDailySessionAmbiguity(
    clientId: string,
    inputHandle: SessionInputHandle,
    turn: Extract<ContextEnginePreparedTurn, { status: "ambiguous" }>,
  ): Promise<void> {
    await this.recordDailySessionAssistantMessage(clientId, turn, turn.message);
    this.dispatchAgentResponse(clientId, inputHandle, null, {
      type: "feedback",
      content: turn.message,
    });
  }

  private async completeDailySessionRun(
    clientId: string,
    turn: ContextEnginePreparedTurn | null,
    result: AgentLoopResult,
  ): Promise<void> {
    if (!this.dailySessionRuntime || turn?.status !== "ready") {
      return;
    }
    try {
      const completed = await this.dailySessionRuntime.completePreparedRun(buildDailySessionRunCommitInput({
        sessionId: turn.sessionId,
        workId: turn.workId,
        runId: turn.runId,
        result,
        at: this.nowProvider().toISOString(),
      }));
      this.feedbackLedger?.record({
        clientId,
        sessionId: turn.sessionId,
        runId: turn.runId,
        stage: "git_context",
        event: "committed",
        data: {
          workId: turn.workId,
          workCommit: completed.run.workCommit,
          runRef: completed.run.runRef,
        },
      });
    } catch (err) {
      devWarn("Daily session git context write-back failed:", err instanceof Error ? err.message : String(err));
    }
  }

  private async recordDailySessionAssistantMessage(
    clientId: string,
    turn: ContextEnginePreparedTurn | null,
    message: string,
  ): Promise<void> {
    if (!this.dailySessionRuntime || !turn) {
      return;
    }
    try {
      await this.dailySessionRuntime.recordAssistantMessage({
        sessionId: turn.sessionId,
        text: message,
        at: this.nowProvider().toISOString(),
      });
    } catch (err) {
      devWarn(
        `[${clientId}] daily session assistant conversation write failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async processSystemEvent(clientId: string, event: AyatiSystemEvent): Promise<void> {
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
      this.rotateSessionBeforeRunIfNeeded(clientId, incomingMessage);
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

      const toolDefs = systemEventPlan.toolDefinitions;
      if (toolDefs.length > 0) {
        runHandle = this.createWorkRun(clientId, inputHandle);
        this.recordTurnStatus(
          clientId,
          runHandle,
          "processing_started",
          `system_event:${event.source}/${event.eventName} mode=${systemEventPlan.policy.mode}`,
        );
      }
      const system = await this.buildSystemContext(clientId);
      devLog(
        `[${clientId}] system_event entering agentLoop eventId=${event.eventId} mode=${systemEventPlan.policy.mode} intent=${systemEventPlan.classification.intentKind} approval=${systemEventPlan.policy.approvalRequired ? "required" : "not_required"} tools=${toolDefs.length} payloadKeys=${Object.keys(event.payload).join(",") || "none"}`,
      );
      const result = await agentLoop({
        provider: this.provider,
        toolExecutor: this.toolExecutor,
        skillActivationManager: this.skillActivationManager,
        toolWorkingSetManager: this.toolWorkingSetManager,
        toolDefinitions: toolDefs,
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
        systemContext: system.decisionSystemContext || system.systemContext || undefined,
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
      this.queueTaskSummaryPublication(clientId, inputHandle, result.taskSummary);
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
      await this.completeSessionLifecycle(clientId, runHandle, runStatus);
    }
  }

  private async buildSystemContext(_clientId: string): Promise<SystemContextBuildResult> {
    if (!this.staticContext) {
      return { systemContext: "", decisionSystemContext: "", dynamicSystemTokens: 0 };
    }

    this.ensureStaticTokenCache();

    const staticSections = this.getStaticPromptSections();
    const decisionSystemContext = joinPromptSections([
      staticSections.head,
      staticSections.tail,
    ]);

    return {
      systemContext: decisionSystemContext,
      decisionSystemContext,
      dynamicSystemTokens: 0,
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

  private createWorkRun(clientId: string, inputHandle: SessionInputHandle): MemoryRunHandle {
    const createWorkRun = this.sessionMemory.createWorkRun;
    if (!createWorkRun) {
      throw new Error("Session memory does not support work run creation.");
    }
    return createWorkRun.call(this.sessionMemory, clientId, inputHandle);
  }

  private inputScopeId(inputHandle: SessionInputHandle): string {
    return `input:${inputHandle.sessionId}:${inputHandle.seq}`;
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
    inputHandle: SessionInputHandle,
    taskSummary: AgentLoopResult["taskSummary"] | undefined,
  ): void {
    if (!taskSummary) {
      return;
    }

    this.feedbackLedger?.record({
      clientId,
      sessionId: inputHandle.sessionId,
      seq: inputHandle.seq,
      runId: taskSummary.runId,
      stage: "memory",
      event: "task_summary_queued",
      data: {
        runStatus: taskSummary.runStatus,
        taskStatus: taskSummary.taskStatus,
        summary: taskSummary.summary,
        assistantResponseKind: taskSummary.assistantResponseKind,
        attachmentNames: taskSummary.attachmentNames,
      },
    });

    const payload = {
      ...taskSummary,
      sessionId: inputHandle.sessionId,
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

function renderToolDirectorySection(toolDirectory: string | undefined, includeToolDirectory: boolean): string {
  if (!includeToolDirectory) return "";
  if (!toolDirectory || toolDirectory.trim().length === 0) return "";
  return `# Available Tools\n\n${toolDirectory}`;
}

function summarizeChatAttachment(attachment: ChatAttachmentInput): Record<string, unknown> {
  if ("uploadedPath" in attachment) {
    return {
      type: attachment.type ?? "upload",
      source: attachment.source,
      originalName: attachment.originalName,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      fileId: attachment.fileId,
    };
  }
  if ("fileId" in attachment) {
    return {
      type: attachment.type ?? "managed_file",
      source: attachment.source,
      fileId: attachment.fileId,
    };
  }
  if (attachment.type === "directory") {
    return {
      type: attachment.type,
      source: attachment.source,
      path: attachment.path,
      name: attachment.name,
      maxDepth: attachment.maxDepth,
      maxFiles: attachment.maxFiles,
    };
  }
  return {
    type: attachment.type ?? "file",
    source: attachment.source,
    path: attachment.path,
    name: attachment.name,
  };
}

export { IVecEngine as AgentEngine };
export type AgentEngineOptions = IVecEngineOptions;
