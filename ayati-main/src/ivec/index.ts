import type { LlmProvider } from "../core/contracts/provider.js";
import { noopSessionMemory } from "../memory/provider.js";
import type { SessionMemory, MemoryRunHandle } from "../memory/types.js";
import type { PulseReminderDueEvent } from "../pulse/types.js";
import type { StaticContext } from "../context/static-context-cache.js";
import { assemblePromptInput } from "../context/load-system-prompt-input.js";
import { buildSystemPrompt } from "../prompt/builder.js";
import { renderConversationSection } from "../prompt/sections/conversation.js";
import { renderMemorySection } from "../prompt/sections/memory.js";
import { estimateTextTokens } from "../prompt/token-estimator.js";
import type { ToolExecutor } from "../skills/tool-executor.js";
import { devLog, devWarn, devError } from "../shared/index.js";
import type { DocumentProcessor } from "../documents/document-processor.js";
import type { RecursiveContextAgent } from "../subagents/context-extractor/recursive-context-agent.js";
import { buildContextEnvelope } from "../subagents/context-extractor/context-envelope.js";
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

type EngineSystemEvent = PulseReminderDueEvent;

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
  documentProcessor?: DocumentProcessor;
  contextAgent?: RecursiveContextAgent;
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
  private readonly documentProcessor?: DocumentProcessor;
  private readonly contextAgent?: RecursiveContextAgent;
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
    this.documentProcessor = options?.documentProcessor;
    this.contextAgent = options?.contextAgent;
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

<<<<<<< HEAD
    const msg = data as {
      type?: string;
      content?: string;
    };
    if (msg.type === "chat" && typeof msg.content === "string") {
      void this.processChat(clientId, msg.content);
      return;
    }

    if (msg.type === "system_event") {
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
  }

  async handleSystemEvent(clientId: string, event: EngineSystemEvent): Promise<void> {
    await this.processSystemEvent(clientId, event);
=======
    const msg = parseChatInboundMessage(data);
    if (!msg) return;

    void this.processChat(clientId, msg.content, msg.attachments ?? []);
>>>>>>> context-retrieval-agent
  }

  private async processChat(clientId: string, content: string, attachments: ChatAttachmentInput[]): Promise<void> {
    let runHandle: MemoryRunHandle | null = null;
    try {
      this.rotateSessionBeforeRunIfNeeded(clientId, content);
      runHandle = this.sessionMemory.beginRun(clientId, content);
      this.recordTurnStatus(clientId, runHandle, "processing_started");

      if (this.provider) {
        const contextMessage = await this.buildContextAwareUserMessage(content, attachments);
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
          userMessageOverride: contextMessage,
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

<<<<<<< HEAD
  private async processSystemEvent(clientId: string, event: EngineSystemEvent): Promise<void> {
    let runHandle: MemoryRunHandle | null = null;
    const incomingMessage = this.buildSystemEventUserMessage(event);

    try {
      this.rotateSessionBeforeRunIfNeeded(clientId, incomingMessage);
      runHandle = this.sessionMemory.beginSystemRun?.(clientId, {
        source: event.source,
        event: event.event,
        eventId: event.eventId,
        occurrenceId: event.occurrenceId,
        reminderId: event.reminderId,
        instruction: event.instruction,
        scheduledFor: event.scheduledFor,
        triggeredAt: event.triggeredAt,
        payload: {
          title: event.title,
          timezone: event.timezone,
          metadata: event.metadata,
          originRunId: event.originRunId,
          originSessionId: event.originSessionId,
        },
      }) ?? this.sessionMemory.beginRun(clientId, incomingMessage);

      this.recordTurnStatus(clientId, runHandle, "processing_started", `system_event:${event.source}/${event.event}`);

      if (!this.provider) {
        this.sendAssistantReply(clientId, runHandle, `Pulse reminder: ${event.instruction}`);
        this.sessionMemory.recordSystemEventOutcome?.(clientId, {
          runId: runHandle.runId,
          eventId: event.eventId,
          source: event.source,
          event: event.event,
          status: "completed",
          note: "echo_mode",
        });
        return;
      }

      const toolDefs = this.toolExecutor?.definitions() ?? [];
      const system = await this.buildSystemContext();
      const result = await agentLoop({
        provider: this.provider,
        toolExecutor: this.toolExecutor,
        toolDefinitions: toolDefs,
        sessionMemory: this.sessionMemory,
        runHandle,
        clientId,
        initialUserMessage: incomingMessage,
        config: this.loopConfig,
        dataDir: this.dataDir ?? "data",
        systemContext: system.systemContext || undefined,
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
        event: event.event,
        status: result.status === "completed" ? "completed" : "failed",
        note: result.content,
      });
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
          event: event.event,
          status: "failed",
          note: message,
        });
      }
      this.onReply?.(clientId, {
        type: "error",
        content: "Failed to process system reminder event.",
      });
      throw err;
=======
  private async buildContextAwareUserMessage(content: string, attachments: ChatAttachmentInput[]): Promise<string> {
    if (attachments.length === 0 || !this.documentProcessor || !this.contextAgent) {
      return content;
    }

    try {
      const processing = await this.documentProcessor.processAttachments(attachments);
      if (processing.documents.length === 0) {
        const warningLines = processing.errors.map((entry) => `- ${entry.path}: ${entry.message}`);
        if (warningLines.length === 0) {
          return content;
        }

        return [
          content,
          "",
          "[Document Context Sub-Agent]",
          "No document text could be extracted from attachments.",
          "Attachment errors:",
          ...warningLines,
        ].join("\n");
      }

      const contextResult = await this.contextAgent.extractContext({
        query: content,
        documents: processing.documents,
      });

      const warnings = [
        ...processing.errors.map((entry) => `${entry.path}: ${entry.message}`),
        ...contextResult.warnings,
      ];
      const contextEnvelope = buildContextEnvelope(content, contextResult.contextBundle);
      if (warnings.length === 0) {
        return contextEnvelope;
      }

      return [
        contextEnvelope,
        "",
        "[Attachment Processing Warnings]",
        ...warnings.map((warning) => `- ${warning}`),
      ].join("\n");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      devWarn(`Document context extraction failed: ${message}`);
      return [
        content,
        "",
        "[Document Context Sub-Agent]",
        `Context extraction failed: ${message}`,
      ].join("\n");
>>>>>>> context-retrieval-agent
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
      includeToolDirectory: this.shouldIncludeToolDirectoryInPrompt(),
    }).systemPrompt;

    const dynamicContext = [
      renderConversationSection(memoryContext.conversationTurns ?? []),
      renderMemorySection(memoryContext.previousSessionSummary ?? ""),
    ]
      .filter((block) => block.trim().length > 0)
      .join("\n\n")
      .trim();

    return {
      systemContext,
      dynamicSystemTokens: estimateTextTokens(dynamicContext),
    };
  }

  private toSystemEvent(data: unknown): EngineSystemEvent | null {
    if (!data || typeof data !== "object") return null;
    const value = data as Record<string, unknown>;
    if (value["type"] !== "system_event") return null;
    if (value["source"] !== "pulse") return null;
    if (value["event"] !== "reminder_due") return null;
    if (typeof value["eventId"] !== "string") return null;
    if (typeof value["occurrenceId"] !== "string") return null;
    if (typeof value["reminderId"] !== "string") return null;
    if (typeof value["title"] !== "string") return null;
    if (typeof value["instruction"] !== "string") return null;
    if (typeof value["scheduledFor"] !== "string") return null;
    if (typeof value["triggeredAt"] !== "string") return null;
    if (typeof value["timezone"] !== "string") return null;

    return {
      type: "system_event",
      source: "pulse",
      event: "reminder_due",
      eventId: value["eventId"],
      occurrenceId: value["occurrenceId"],
      reminderId: value["reminderId"],
      title: value["title"],
      instruction: value["instruction"],
      scheduledFor: value["scheduledFor"],
      triggeredAt: value["triggeredAt"],
      timezone: value["timezone"],
      metadata: (typeof value["metadata"] === "object" && value["metadata"] !== null)
        ? (value["metadata"] as Record<string, unknown>)
        : {},
      originRunId: typeof value["originRunId"] === "string" ? value["originRunId"] : undefined,
      originSessionId: typeof value["originSessionId"] === "string" ? value["originSessionId"] : undefined,
    };
  }

  private buildSystemEventUserMessage(event: EngineSystemEvent): string {
    const payload = {
      source: event.source,
      event: event.event,
      reminderId: event.reminderId,
      title: event.title,
      instruction: event.instruction,
      scheduledFor: event.scheduledFor,
      triggeredAt: event.triggeredAt,
      timezone: event.timezone,
      metadata: event.metadata,
      originRunId: event.originRunId,
      originSessionId: event.originSessionId,
    };

    return [
      "System event received from Pulse.",
      "You must handle this reminder now.",
      `Event payload: ${JSON.stringify(payload)}`,
      "Reply to the user with a helpful reminder message and perform any requested action if needed.",
    ].join("\n");
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
