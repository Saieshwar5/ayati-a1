import { randomUUID } from "node:crypto";
import type { LlmProvider } from "../core/contracts/provider.js";
import { noopSessionMemory } from "../memory/provider.js";
import type { SessionMemory, MemoryRunHandle } from "../memory/types.js";
import type { StaticContext } from "../context/static-context-cache.js";
import { assemblePromptInput } from "../context/load-system-prompt-input.js";
import { buildSystemPrompt } from "../prompt/builder.js";
import { renderConversationSection } from "../prompt/sections/conversation.js";
import { renderCurrentSessionSection } from "../prompt/sections/current-session.js";
import { renderMemorySection } from "../prompt/sections/memory.js";
import { renderRecentRunsSection } from "../prompt/sections/recent-runs.js";
import { estimateTextTokens } from "../prompt/token-estimator.js";
import type { ToolExecutor } from "../skills/tool-executor.js";
import { devLog, devWarn, devError } from "../shared/index.js";
import type { ManagedDocumentManifest } from "../documents/types.js";
import type { DocumentStore } from "../documents/document-store.js";
import type { DocumentContextBackend } from "../documents/document-context-backend.js";
import type { AyatiSystemEvent } from "../core/contracts/plugin.js";
import { agentLoop } from "./agent-loop.js";
import {
  evaluateSessionRotation,
  type RotationPolicyConfig,
  type PendingMidnightRollover,
} from "./session-rotation-policy.js";
import type { ChatAttachmentInput, ChatInboundMessage, LoopConfig } from "./types.js";

interface SystemContextBuildResult {
  systemContext: string;
  dynamicSystemTokens: number;
}

export interface IVecEngineOptions {
  onReply?: (clientId: string, data: unknown) => void;
  provider?: LlmProvider;
  staticContext?: StaticContext;
  sessionMemory?: SessionMemory;
  toolExecutor?: ToolExecutor;
  loopConfig?: Partial<LoopConfig>;
  rotationPolicyConfig?: Partial<RotationPolicyConfig>;
  now?: () => Date;
  dataDir?: string;
  documentStore?: DocumentStore;
  documentContextBackend?: DocumentContextBackend;
}

export class IVecEngine {
  private readonly onReply?: (clientId: string, data: unknown) => void;
  private readonly provider?: LlmProvider;
  private readonly staticContext?: StaticContext;
  private readonly toolExecutor?: ToolExecutor;
  private sessionMemory: SessionMemory;
  private readonly loopConfig?: Partial<LoopConfig>;
  private readonly rotationPolicyConfig?: Partial<RotationPolicyConfig>;
  private readonly nowProvider: () => Date;
  private readonly dataDir?: string;
  private readonly documentStore?: DocumentStore;
  private readonly documentContextBackend?: DocumentContextBackend;
  private staticSystemTokens = 0;
  private staticTokensReady = false;
  private readonly pendingMidnightByClient = new Map<string, PendingMidnightRollover>();

  constructor(options?: IVecEngineOptions) {
    this.onReply = options?.onReply;
    this.provider = options?.provider;
    this.staticContext = options?.staticContext;
    this.toolExecutor = options?.toolExecutor;
    this.sessionMemory = options?.sessionMemory ?? noopSessionMemory;
    this.loopConfig = options?.loopConfig;
    this.rotationPolicyConfig = options?.rotationPolicyConfig;
    this.nowProvider = options?.now ?? (() => new Date());
    this.dataDir = options?.dataDir;
    this.documentStore = options?.documentStore;
    this.documentContextBackend = options?.documentContextBackend;
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
    try {
      this.rotateSessionBeforeRunIfNeeded(clientId, content);
      runHandle = this.sessionMemory.beginRun(clientId, content);
      this.recordTurnStatus(clientId, runHandle, "processing_started");

      if (this.provider) {
        const registeredAttachments = await this.registerIncomingDocuments(attachments);
        const toolDefs = this.toolExecutor?.definitions() ?? [];
        const system = await this.buildSystemContext();
        const result = await agentLoop({
          provider: this.provider,
          toolExecutor: this.toolExecutor,
          toolDefinitions: toolDefs,
          sessionMemory: this.sessionMemory,
          runHandle,
          clientId,
          config: this.loopConfig,
          dataDir: this.dataDir ?? "data",
          systemContext: system.systemContext || undefined,
          controllerPrompts: this.staticContext?.controllerPrompts,
          attachedDocuments: registeredAttachments.documents,
          attachmentWarnings: registeredAttachments.warnings,
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
        this.sessionMemory.recordTaskSummary?.(clientId, {
          runId: runHandle.runId,
          sessionId: runHandle.sessionId,
          runPath: result.runPath,
          status: result.status,
          summary: result.content,
        });
        this.sendAssistantReply(clientId, runHandle, result.content);
      } else {
        const reply = `Received: "${content}"`;
        this.sendAssistantReply(clientId, runHandle, reply);
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
      }
      this.onReply?.(clientId, {
        type: "error",
        content: "Failed to generate a response.",
      });
    }
  }

  private async processSystemEvent(clientId: string, event: AyatiSystemEvent): Promise<void> {
    let runHandle: MemoryRunHandle | null = null;
    const incomingMessage = event.summary;

    try {
      devLog(
        `[${clientId}] system_event start source=${event.source} eventName=${event.eventName} eventId=${event.eventId} summary=${event.summary}`,
      );
      this.rotateSessionBeforeRunIfNeeded(clientId, incomingMessage);
      runHandle = this.sessionMemory.beginSystemRun?.(clientId, {
        source: event.source,
        event: event.eventName,
        eventId: event.eventId,
        triggeredAt: event.receivedAt,
        payload: event.payload,
      }) ?? this.sessionMemory.beginRun(clientId, incomingMessage);

      this.recordTurnStatus(clientId, runHandle, "processing_started", `system_event:${event.source}/${event.eventName}`);

      if (!this.provider) {
        devLog(`[${clientId}] system_event echo_mode eventId=${event.eventId}`);
        this.sendAssistantReply(clientId, runHandle, event.summary);
        this.sessionMemory.recordSystemEventOutcome?.(clientId, {
          runId: runHandle.runId,
          eventId: event.eventId,
          source: event.source,
          event: event.eventName,
          status: "completed",
          note: "echo_mode",
        });
        return;
      }

      const toolDefs = this.toolExecutor?.definitions() ?? [];
      const system = await this.buildSystemContext();
      devLog(
        `[${clientId}] system_event entering agentLoop eventId=${event.eventId} tools=${toolDefs.length} payloadKeys=${Object.keys(event.payload).join(",") || "none"}`,
      );
      const result = await agentLoop({
        provider: this.provider,
        toolExecutor: this.toolExecutor,
        toolDefinitions: toolDefs,
        sessionMemory: this.sessionMemory,
        runHandle,
        clientId,
        inputKind: "system_event",
        systemEvent: event,
        initialUserMessage: incomingMessage,
        config: this.loopConfig,
        dataDir: this.dataDir ?? "data",
        systemContext: system.systemContext || undefined,
        controllerPrompts: this.staticContext?.controllerPrompts,
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
      this.sessionMemory.recordTaskSummary?.(clientId, {
        runId: runHandle.runId,
        sessionId: runHandle.sessionId,
        runPath: result.runPath,
        status: result.status,
        summary: result.content,
      });
      this.sessionMemory.recordSystemEventOutcome?.(clientId, {
        runId: runHandle.runId,
        eventId: event.eventId,
        source: event.source,
        event: event.eventName,
        status: result.status === "completed" ? "completed" : "failed",
        note: result.content,
      });
      devLog(
        `[${clientId}] system_event agentLoop completed eventId=${event.eventId} status=${result.status} runPath=${result.runPath}`,
      );
      this.sendAssistantReply(clientId, runHandle, result.content);
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
          status: "failed",
          note: message,
        });
      }
      this.onReply?.(clientId, {
        type: "error",
        content: "Failed to process system event.",
      });
      throw err;
    }
  }

  private async buildSystemContext(): Promise<SystemContextBuildResult> {
    if (!this.staticContext) {
      return { systemContext: "", dynamicSystemTokens: 0 };
    }

    this.ensureStaticTokenCache();

    const memoryContext = this.sessionMemory.getPromptMemoryContext();
    const sessionStatus = this.sessionMemory.getSessionStatus?.() ?? null;

    const promptInput = assemblePromptInput(this.staticContext, memoryContext, sessionStatus);
    const systemContext = buildSystemPrompt({
      ...promptInput,
      toolDirectory: this.staticContext.toolDirectory,
      includeToolDirectory: this.shouldIncludeToolDirectoryInPrompt(),
    }).systemPrompt;

    const dynamicContext = [
      renderConversationSection(memoryContext.conversationTurns ?? []),
      renderMemorySection(memoryContext.previousSessionSummary ?? ""),
      renderCurrentSessionSection(memoryContext.activeSessionPath ?? ""),
      renderRecentRunsSection(memoryContext.recentRunLedgers ?? []),
    ]
      .filter((block) => block.trim().length > 0)
      .join("\n\n")
      .trim();

    return {
      systemContext,
      dynamicSystemTokens: estimateTextTokens(dynamicContext),
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

    return {
      type: "system_event",
      eventId,
      source,
      eventName,
      receivedAt,
      summary,
      payload,
    };
  }

  private rotateSessionBeforeRunIfNeeded(clientId: string, incomingMessage: string): void {
    const createSession = this.sessionMemory.createSession;
    if (!createSession) {
      return;
    }

    const memoryContext = this.sessionMemory.getPromptMemoryContext();
    const sessionStatus = this.sessionMemory.getSessionStatus?.() ?? null;

    const rotationDecision = evaluateSessionRotation({
      now: this.nowProvider(),
      userMessage: incomingMessage,
      contextPercent: sessionStatus?.contextPercent ?? 0,
      turns: memoryContext.conversationTurns,
      previousSessionSummary: memoryContext.previousSessionSummary,
      pendingMidnight: this.pendingMidnightByClient.get(clientId) ?? null,
      config: this.rotationPolicyConfig,
    });

    if (rotationDecision.pendingMidnight) {
      this.pendingMidnightByClient.set(clientId, rotationDecision.pendingMidnight);
    } else {
      this.pendingMidnightByClient.delete(clientId);
    }

    if (!rotationDecision.rotate) {
      return;
    }

    createSession.call(this.sessionMemory, clientId, {
      runId: `pre-run-rotation-${Date.now()}`,
      reason: rotationDecision.reason ?? "policy_rotation",
      source: "system",
      handoffSummary: rotationDecision.handoffSummary,
    });
    this.pendingMidnightByClient.delete(clientId);

    devWarn(
      `Pre-run session rotation triggered (${rotationDecision.reason ?? "unknown"}) at ${Math.round(sessionStatus?.contextPercent ?? 0)}% context`,
    );
  }

  private ensureStaticTokenCache(): void {
    if (this.staticTokensReady) return;
    if (!this.staticContext) {
      this.staticSystemTokens = 0;
      this.staticTokensReady = true;
      this.sessionMemory.setStaticTokenBudget(0);
      return;
    }

    const staticOnlyPrompt = buildSystemPrompt({
      basePrompt: this.staticContext.basePrompt,
      soul: this.staticContext.soul,
      userProfile: this.staticContext.userProfile,
      conversationTurns: [],
      previousSessionSummary: "",
      skillBlocks: this.staticContext.skillBlocks,
      toolDirectory: this.staticContext.toolDirectory,
      includeToolDirectory: this.shouldIncludeToolDirectoryInPrompt(),
    }).systemPrompt;

    const promptTokens = estimateTextTokens(staticOnlyPrompt);

    this.staticSystemTokens = promptTokens;
    this.staticTokensReady = true;
    this.sessionMemory.setStaticTokenBudget(this.staticSystemTokens);
    devLog(`Static context tokens cached: ${this.staticSystemTokens} (prompt=${promptTokens})`);
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
      reminderId: value["reminderId"],
      title: value["title"],
      instruction: value["instruction"],
      scheduledFor: value["scheduledFor"],
      triggeredAt: value["triggeredAt"],
      timezone: value["timezone"],
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

  private shouldIncludeToolDirectoryInPrompt(): boolean {
    return process.env["PROMPT_INCLUDE_TOOL_DIRECTORY"] === "1";
  }

  private sendAssistantReply(clientId: string, runHandle: MemoryRunHandle, content: string): void {
    this.recordTurnStatus(clientId, runHandle, "response_started");
    this.sessionMemory.recordAssistantFinal(
      clientId,
      runHandle.runId,
      runHandle.sessionId,
      content,
    );
    this.recordTurnStatus(clientId, runHandle, "response_completed");
    this.onReply?.(clientId, { type: "reply", content });
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

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function parseChatInboundMessage(data: unknown): ChatInboundMessage | null {
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
    if (!row || typeof row !== "object") {
      continue;
    }

    const value = row as Record<string, unknown>;
    const path = typeof value["path"] === "string" ? value["path"].trim() : "";
    if (path.length === 0) {
      continue;
    }

    const name = typeof value["name"] === "string" ? value["name"].trim() : undefined;
    attachments.push({
      path,
      ...(name ? { name } : {}),
    });
  }

  return {
    type: "chat",
    content,
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

export { IVecEngine as AgentEngine };
export type AgentEngineOptions = IVecEngineOptions;
