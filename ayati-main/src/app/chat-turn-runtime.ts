import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { LlmProvider } from "../core/contracts/provider.js";
import { isProviderEmptyResponseError } from "../core/contracts/provider-errors.js";
import type { StaticContext } from "../context/static-context-cache.js";
import type { ManagedDocumentManifest } from "../documents/types.js";
import type { DocumentStore } from "../documents/document-store.js";
import { PreparedAttachmentRegistry } from "../documents/prepared-attachment-registry.js";
import type { DirectoryLibrary } from "../files/directory-library.js";
import type { FileLibrary } from "../files/file-library.js";
import type { DirectoryAttachmentRecord, ManagedFileRecord } from "../files/types.js";
import type {
  AgentResponseKind,
  ConversationTurn,
  PromptMemoryContext,
  RunRecorder,
  SessionInputHandle,
} from "../memory/types.js";
import {
  ContextEngineServiceError,
  type AgentRunHandle,
  type ContextEngineService,
  type FinalizeRunResponse,
  type ResourceAdmission,
  type ResourceKind,
} from "ayati-context-engine";
import {
  appendPulseProposalQuestion,
  PulseProposalReflectionService,
} from "../pulse/proposal-reflection.js";
import type { SkillActivationManager } from "../skills/activation-manager.js";
import type { ToolExecutor } from "../skills/tool-executor.js";
import type { ToolDefinition } from "../skills/types.js";
import type { ContextEngineMachineContext } from "../context-engine/index.js";
import {
  createInitialHarnessContext,
  type HarnessContextInput,
} from "../ivec/harness-context.js";
import { devError, devLog, devWarn } from "../shared/index.js";
import { agentLoop } from "../ivec/agent-loop.js";
import {
  buildContextEngineFeedbackSummary,
  type AgentFeedbackLedger,
} from "../ivec/feedback-ledger.js";
import type { ChatTurnRuntime, ChatTurnRuntimeInput } from "../ivec/chat-turn-runtime.js";
import type { ToolWorkingSetManager } from "../ivec/agent-runner/tool-working-set.js";
import { summarizeHarnessContext } from "../ivec/agent-runner/feedback-summary.js";
import type {
  AgentArtifact,
  AgentLoopResult,
  ChatAttachmentInput,
  DirectoryChatAttachmentInput,
  FinalResponseStreamEvent,
  FinalResponseStreamKind,
  LoopConfig,
} from "../ivec/types.js";
import { createWorkstreamBindingCoordinator } from "../ivec/workstream-binding/coordinator.js";
import { withEvaluationContext } from "../evaluation/capture-runtime.js";
import { buildStaticSystemContext } from "./static-prompt.js";
import type {
  ContextEnginePreparedTurn,
  ContextEngineRuntime,
} from "./context-engine-runtime.js";
import {
  finalizeAgentRun,
  isWorkstreamBoundResult,
  isWorkstreamBoundRun,
} from "./run-finalization-coordinator.js";

export interface CreateChatTurnRuntimeOptions {
  onReply?: (clientId: string, data: unknown) => void;
  clientSupportsReplyStreaming?: (clientId: string) => boolean;
  provider?: LlmProvider;
  staticContext?: StaticContext;
  toolExecutor?: ToolExecutor;
  skillActivationManager?: SkillActivationManager;
  toolWorkingSetManager?: ToolWorkingSetManager;
  chatContextRuntime: ContextEngineRuntime;
  contextEngineService?: ContextEngineService;
  loopConfig?: Partial<LoopConfig>;
  now?: () => Date;
  dataDir?: string;
  documentStore?: DocumentStore;
  preparedAttachmentRegistry?: PreparedAttachmentRegistry;
  fileLibrary?: FileLibrary;
  directoryLibrary?: DirectoryLibrary;
  feedbackLedger?: AgentFeedbackLedger;
  personalMemorySnapshot?: (clientId: string) => string;
}

interface RegisteredChatAttachments {
  documents: ManagedDocumentManifest[];
  warnings: string[];
  managedFiles: ManagedFileRecord[];
  managedDirectories: DirectoryAttachmentRecord[];
}

type ReplyCommitStatus = "not_required" | "no_change" | "committed" | "failed";

interface LiveReplyStream {
  turnId: string;
  kind: FinalResponseStreamKind;
  content: string;
  seq: number;
}

const chatRunRecorder: RunRecorder = {
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

export function createChatTurnRuntime(options: CreateChatTurnRuntimeOptions): ChatTurnRuntime {
  return new AppChatTurnRuntime(options);
}

class AppChatTurnRuntime implements ChatTurnRuntime {
  private readonly onReply?: (clientId: string, data: unknown) => void;
  private readonly clientSupportsReplyStreaming: (clientId: string) => boolean;
  private readonly provider?: LlmProvider;
  private readonly staticContext?: StaticContext;
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
  private readonly feedbackLedger?: AgentFeedbackLedger;
  private readonly chatContextRuntime: ContextEngineRuntime;
  private readonly contextEngineService?: ContextEngineService;
  private readonly personalMemorySnapshot?: (clientId: string) => string;
  private readonly pulseProposalReflectionService = new PulseProposalReflectionService();
  private readonly turnSerializer = new AsyncKeySerializer();

  constructor(options: CreateChatTurnRuntimeOptions) {
    this.onReply = options.onReply;
    this.clientSupportsReplyStreaming = options.clientSupportsReplyStreaming ?? (() => false);
    this.provider = options.provider;
    this.staticContext = options.staticContext;
    this.toolExecutor = options.toolExecutor;
    this.skillActivationManager = options.skillActivationManager;
    this.toolWorkingSetManager = options.toolWorkingSetManager;
    this.loopConfig = options.loopConfig;
    this.nowProvider = options.now ?? (() => new Date());
    this.dataDir = options.dataDir;
    this.documentStore = options.documentStore;
    this.preparedAttachmentRegistry = options.preparedAttachmentRegistry
      ?? (this.documentStore ? new PreparedAttachmentRegistry() : undefined);
    this.fileLibrary = options.fileLibrary;
    this.directoryLibrary = options.directoryLibrary;
    this.feedbackLedger = options.feedbackLedger;
    this.chatContextRuntime = options.chatContextRuntime;
    this.contextEngineService = options.contextEngineService;
    this.personalMemorySnapshot = options.personalMemorySnapshot;
  }

  async processChat(input: ChatTurnRuntimeInput): Promise<void> {
    const serializationKey = this.chatTurnSerializationKey(input);
    const queued = this.turnSerializer.isBusy(serializationKey);
    if (queued) {
      this.feedbackLedger?.record({
        clientId: input.clientId,
        stage: "runtime",
        event: "chat_turn_queued",
        data: {
          serializationKey,
          reason: "A previous chat turn is still running for this session key.",
        },
      });
    }
    return await this.turnSerializer.enqueue(serializationKey, async () => {
      if (queued) {
        this.feedbackLedger?.record({
          clientId: input.clientId,
          stage: "runtime",
          event: "chat_turn_started_after_queue",
          data: {
            serializationKey,
          },
        });
      }
      await this.processChatUnlocked(input);
    });
  }

  async drain(): Promise<void> {
    return;
  }

  private async processChatUnlocked(input: ChatTurnRuntimeInput): Promise<void> {
    let inputHandle: SessionInputHandle | null = null;
    let runHandle: AgentRunHandle | null = null;
    let chatContextTurn: ContextEnginePreparedTurn | null = null;
    let liveFinalResponseStream: LiveReplyStream | null = null;
    let finalizationAttempted = false;

    try {
      const ingressAt = this.nowProvider().toISOString();
      const registeredAttachments = await this.registerIncomingDocuments(input.attachments);
      chatContextTurn = await this.prepareChatContextTurn(
        input.clientId,
        input.content,
        resourceAdmissions(registeredAttachments),
        ingressAt,
      );
      inputHandle = this.inputHandleFromChatContextTurn(chatContextTurn);
      runHandle = chatContextTurn.run;
      this.feedbackLedger?.record({
        clientId: input.clientId,
        sessionId: inputHandle.sessionId,
        seq: inputHandle.seq,
        runId: runHandle.runId,
        stage: "message",
        event: "received",
        data: {
          kind: "chat",
          content: input.content,
          attachments: input.attachments.map((attachment) => summarizeChatAttachment(attachment)),
          uiContext: input.uiContext,
        },
      });

      if (this.provider) {
        await this.associateRegisteredAttachmentsWithRun(registeredAttachments, runHandle.runId);
        const harnessContext = this.harnessContextFromPreparedTurn(input.clientId, chatContextTurn);
        const toolDefinitions = this.toolExecutor?.definitions({
          clientId: input.clientId,
          runId: runHandle.runId,
          sessionId: inputHandle.sessionId,
        }) ?? [];
        let result = await agentLoop({
          provider: this.provider,
          toolExecutor: this.toolExecutor,
          skillActivationManager: this.skillActivationManager,
          toolWorkingSetManager: this.toolWorkingSetManager,
          toolDefinitions,
          runRecorder: chatRunRecorder,
          inputHandle,
          runHandle,
          recordRunStep: async (record) => {
            const context = await this.chatContextRuntime.recordRunStep({
              turn: chatContextTurn,
              record,
            });
            return context ? { contextEngine: context } : undefined;
          },
          contextCheckpoint: this.chatContextRuntime.contextCheckpointCoordinator(chatContextTurn),
          ...(this.contextEngineService
            ? {
                workstreamBinding: createWorkstreamBindingCoordinator({
                  service: this.contextEngineService,
                  runId: runHandle.runId,
                  streamId: inputHandle.sessionId,
                  currentInput: input.content,
                  now: this.nowProvider,
                }),
              }
            : {}),
          clientId: input.clientId,
          uiContext: input.uiContext,
          initialUserMessage: input.content,
          config: this.loopConfig,
          dataDir: this.dataDir ?? "data",
          systemContext: buildStaticSystemContext(this.staticContext),
          harnessContext,
          feedbackLedger: this.feedbackLedger,
          attachedDocuments: registeredAttachments.documents,
          attachmentWarnings: registeredAttachments.warnings,
          managedFiles: registeredAttachments.managedFiles,
          managedDirectories: registeredAttachments.managedDirectories,
          fileLibrary: this.fileLibrary,
          directoryLibrary: this.directoryLibrary,
          documentStore: this.documentStore,
          preparedAttachmentRegistry: this.preparedAttachmentRegistry,
          onProgress: (log, _runPath) => {
            devLog(`[${input.clientId}] ${log}`);
            this.sendProgress(input.clientId, runHandle!, log);
          },
          ...(this.clientSupportsReplyStreaming(input.clientId)
            ? {
                onFinalResponseStream: (event: FinalResponseStreamEvent) => {
                  liveFinalResponseStream = this.handleLiveFinalResponseStreamEvent(
                    input.clientId,
                    runHandle,
                    liveFinalResponseStream,
                    event,
                  );
                },
              }
            : {}),
        });
        result = await withEvaluationContext({
          runId: runHandle.runId,
          sessionId: inputHandle.sessionId,
          laneId: `main:${runHandle.runId}`,
          attribution: "foreground",
        }, async () => await this.applyPulseProposalReflection(
            input.clientId,
            input.content,
            result,
            toolDefinitions,
          ));
        finalizationAttempted = true;
        const commitStatus = await this.finalizeChatContextRun(
          input.clientId,
          chatContextTurn,
          result,
        );
        this.dispatchAgentResponse(input.clientId, runHandle, result, commitStatus, liveFinalResponseStream);
        this.feedbackLedger?.record({
          clientId: input.clientId,
          sessionId: inputHandle.sessionId,
          seq: inputHandle.seq,
          ...(runHandle ? { runId: runHandle.runId } : {}),
          stage: "final",
          event: "dispatched",
          data: {
            type: result.type,
            status: result.status,
            stopReason: result.stopReason,
            content: result.content,
            artifacts: result.artifacts,
            runPath: result.runPath,
          },
        });
        this.feedbackLedger?.scheduleCheckpoint?.(runHandle.runId);
      } else {
        const echoContent = `Received: "${input.content}"`;
        const result = directReplyResult(runHandle.runId, echoContent);
        finalizationAttempted = true;
        const commitStatus = await this.finalizeChatContextRun(
          input.clientId,
          chatContextTurn,
          result,
        );
        this.dispatchAgentResponse(input.clientId, runHandle, {
          type: "reply",
          content: echoContent,
        }, commitStatus);
        this.feedbackLedger?.record({
          clientId: input.clientId,
          sessionId: inputHandle.sessionId,
          seq: inputHandle.seq,
          runId: runHandle.runId,
          stage: "final",
          event: "dispatched",
          data: { type: "reply", status: result.status, stopReason: result.stopReason, content: echoContent },
        });
        this.feedbackLedger?.scheduleCheckpoint?.(runHandle.runId);
      }
    } catch (err) {
      devError("Provider error:", err);
      this.feedbackLedger?.record({
        clientId: input.clientId,
        ...(inputHandle ? { sessionId: inputHandle.sessionId, seq: inputHandle.seq } : {}),
        ...(runHandle ? { runId: runHandle.runId } : {}),
        stage: "final",
        event: "error",
        data: {
          type: "error",
          status: "failed",
          stopReason: "runtime_error",
          content: formatChatRuntimeError(err),
          message: err instanceof Error ? err.message : String(err),
        },
      });
      if (runHandle) {
        const message = err instanceof Error ? err.message : "Unknown runtime failure";
        this.feedbackLedger?.record({
          clientId: input.clientId,
          sessionId: runHandle.streamId,
          runId: runHandle.runId,
          stage: "run",
          event: "failed",
          data: { message },
        });
      }
      if (runHandle && chatContextTurn && !finalizationAttempted) {
        await this.completeFailedChatContextRun(
          input.clientId,
          chatContextTurn,
          runHandle,
          err,
        );
      }
      const failedLiveStream = liveFinalResponseStream as LiveReplyStream | null;
      if (failedLiveStream) {
        this.finishLiveFinalResponseStream(input.clientId, runHandle, failedLiveStream, {
          kind: failedLiveStream.kind,
          content: failedLiveStream.content,
          commitStatus: "failed",
        });
        liveFinalResponseStream = null;
      }
      this.onReply?.(input.clientId, {
        type: "error",
        content: formatChatRuntimeError(err),
        ...(runHandle ? { runId: runHandle.runId } : {}),
      });
      if (runHandle) this.feedbackLedger?.scheduleCheckpoint?.(runHandle.runId);
    }
  }

  private chatTurnSerializationKey(input: ChatTurnRuntimeInput): string {
    return chatTurnSerializationKeyForClient(input.clientId);
  }

  private async prepareChatContextTurn(
    clientId: string,
    userMessage: string,
    resources: ResourceAdmission[],
    at: string,
  ): Promise<ContextEnginePreparedTurn> {
    const turn = await this.chatContextRuntime.prepareUserTurn({
      clientId,
      userMessage,
      ...(resources.length > 0 ? { resources } : {}),
      at,
    });
    const contextEngine = turn.context;

    this.feedbackLedger?.record({
      clientId,
      sessionId: turn.streamId,
      seq: turn.messageSequence,
      stage: "context_engine",
      event: "prepared",
      data: {
        status: turn.status,
        messageSequence: turn.messageSequence,
        contextEngine: buildContextEngineFeedbackSummary({
          context: contextEngine,
          routeSource: "runtime",
        }),
        pendingTurnStatus: contextEngine.current.routing?.status ?? "none",
        context: summarizeHarnessContext({ contextEngine }),
      },
    });
    this.feedbackLedger?.record({
      clientId,
      sessionId: turn.streamId,
      seq: turn.messageSequence,
      stage: "context_engine",
      event: "pending_turn_snapshot",
      data: {
        status: contextEngine.current.routing?.status ?? "none",
        routing: contextEngine.current.routing,
        contextEngine: buildContextEngineFeedbackSummary({
          context: contextEngine,
          routeSource: "runtime",
        }),
      },
    });
    return turn;
  }

  private async finalizeChatContextRun(
    clientId: string,
    prepared: ContextEnginePreparedTurn,
    result: AgentLoopResult,
  ): Promise<ReplyCommitStatus> {
    const workstreamBound = isWorkstreamBoundRun(prepared, result);
    this.feedbackLedger?.record({
      clientId,
      sessionId: prepared.streamId,
      seq: prepared.messageSequence,
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
      runtime: this.chatContextRuntime,
      turn: prepared,
      result,
      at: this.nowProvider().toISOString(),
    });
    this.recordFinalizationCompleted(clientId, prepared, finalized);
    return replyCommitStatus(finalized);
  }

  private recordFinalizationCompleted(
    clientId: string,
    prepared: ContextEnginePreparedTurn,
    finalized: FinalizeRunResponse,
  ): void {
    this.feedbackLedger?.record({
      clientId,
      sessionId: prepared.streamId,
      seq: prepared.messageSequence,
      runId: finalized.run.runId,
      stage: "context_engine",
      event: "run_finalization_completed",
      data: {
        outcome: finalized.run.status,
        stopReason: finalized.run.stopReason,
        workstreamBinding: finalized.run.workstreamBinding,
        assistantMessageId: finalized.assistantMessage?.messageId,
        observationRevision: finalized.observationRevision,
        resourceEffects: finalized.resourceEffects,
        workstreamContextCommit: finalized.workstreamContextCommit,
      },
    });
  }

  private async completeFailedChatContextRun(
    clientId: string,
    prepared: ContextEnginePreparedTurn,
    runHandle: AgentRunHandle,
    error: unknown,
  ): Promise<void> {
    const message = errMessage(error);
    try {
      await this.finalizeChatContextRun(clientId, prepared, {
        type: "reply",
        runId: runHandle.runId,
        outcome: "failed",
        stopReason: "failed",
        content: `Runtime failed before the workstream-bound run could complete: ${message}`,
        status: "failed",
        totalIterations: 0,
        totalToolCalls: 0,
        runPath: "",
        workState: {
          status: "blocked",
          summary: "Run failed before completion.",
          openWork: ["Retry or continue the workstream after resolving the runtime failure."],
          blockers: [message],
          verifiedFacts: [],
          evidence: [],
          nextStep: "Retry or continue the workstream.",
        },
        completedSteps: [],
        harnessContext: createInitialHarnessContext(this.harnessContextFromPreparedTurn(clientId, prepared)),
      });
    } catch (finalizationError) {
      devWarn(`[${clientId}] git memory failed-run finalization failed: ${errMessage(finalizationError)}`);
    }
  }

  private inputHandleFromChatContextTurn(turn: ContextEnginePreparedTurn): SessionInputHandle {
    return {
      sessionId: turn.streamId,
      seq: turn.messageSequence,
      ...(turn.currentMessageId ? { currentMessageId: turn.currentMessageId } : {}),
    };
  }

  private harnessContextFromPreparedTurn(
    clientId: string,
    turn: ContextEnginePreparedTurn | null,
  ): HarnessContextInput {
    if (!turn) {
      return {};
    }
    return {
      contextEngine: turn.context,
      ...(this.personalMemorySnapshot
        ? { personalMemorySnapshot: this.personalMemorySnapshot(clientId) }
        : {}),
    };
  }

  private async applyPulseProposalReflection(
    clientId: string,
    userMessage: string,
    result: AgentLoopResult,
    toolDefinitions: ToolDefinition[],
  ): Promise<AgentLoopResult> {
    if (!this.provider || result.type !== "reply" || result.outcome !== "done" || !isWorkstreamBoundResult(result) || !result.workstreamSummary) {
      return result;
    }

    try {
      const reflection = await this.pulseProposalReflectionService.reflect({
        provider: this.provider,
        currentUserMessage: userMessage,
        assistantResponse: result.content,
        workstreamSummary: result.workstreamSummary,
        memoryContext: promptMemoryContextFromContextEngine(result.harnessContext?.contextEngine),
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
        workstreamSummary: {
          ...result.workstreamSummary,
          assistantResponse: content,
          assistantResponseKind: "feedback",
        },
      };
    } catch (err) {
      devWarn("Pulse proposal reflection failed:", err instanceof Error ? err.message : String(err));
      return result;
    }
  }

  private dispatchAgentResponse(
    clientId: string,
    runHandle: AgentRunHandle | null,
    result: {
      type: AgentResponseKind;
      content: string;
      artifacts?: AgentArtifact[];
    },
    commitStatus: ReplyCommitStatus,
    liveStream?: LiveReplyStream | null,
  ): void {
    switch (result.type) {
      case "reply":
        this.sendAssistantReply(clientId, runHandle, result.content, commitStatus, result.artifacts, liveStream);
        return;
      case "feedback":
        this.sendAssistantFeedback(clientId, runHandle, result.content, commitStatus, result.artifacts, liveStream);
        return;
      case "notification":
        this.sendAssistantNotification(clientId, runHandle, result.content, commitStatus, result.artifacts, liveStream);
        return;
      case "none":
        return;
    }
  }

  private sendAssistantReply(
    clientId: string,
    runHandle: AgentRunHandle | null,
    content: string,
    commitStatus: ReplyCommitStatus,
    artifacts?: AgentArtifact[],
    liveStream?: LiveReplyStream | null,
  ): void {
    const terminalPayload = {
      ...(runHandle ? { runId: runHandle.runId } : {}),
      commitStatus,
      ...(artifacts && artifacts.length > 0 ? { artifacts } : {}),
    };
    if (liveStream) {
      this.finishLiveFinalResponseStream(clientId, runHandle, liveStream, {
        kind: "reply",
        content,
        commitStatus,
        extraPayload: terminalPayload,
      });
      return;
    }
    if (this.clientSupportsReplyStreaming(clientId)) {
      this.sendStreamedAssistantResponse(clientId, runHandle, "reply", content, commitStatus, terminalPayload);
      return;
    }
    this.onReply?.(clientId, {
      type: "reply",
      content,
      ...terminalPayload,
    });
  }

  private sendAssistantFeedback(
    clientId: string,
    runHandle: AgentRunHandle | null,
    content: string,
    commitStatus: ReplyCommitStatus,
    artifacts?: AgentArtifact[],
    liveStream?: LiveReplyStream | null,
  ): void {
    const terminalPayload = {
      ...(runHandle ? { runId: runHandle.runId } : {}),
      commitStatus,
      ...(artifacts && artifacts.length > 0 ? { artifacts } : {}),
    };
    if (liveStream) {
      this.finishLiveFinalResponseStream(clientId, runHandle, liveStream, {
        kind: "feedback",
        content,
        commitStatus,
        extraPayload: terminalPayload,
      });
      return;
    }
    if (this.clientSupportsReplyStreaming(clientId)) {
      this.sendStreamedAssistantResponse(clientId, runHandle, "feedback", content, commitStatus, terminalPayload);
      return;
    }
    this.onReply?.(clientId, {
      type: "feedback",
      content,
      ...terminalPayload,
    });
  }

  private sendAssistantNotification(
    clientId: string,
    runHandle: AgentRunHandle | null,
    content: string,
    commitStatus: ReplyCommitStatus,
    artifacts?: AgentArtifact[],
    liveStream?: LiveReplyStream | null,
  ): void {
    const terminalPayload = {
      ...(runHandle ? { runId: runHandle.runId } : {}),
      commitStatus,
      ...(artifacts && artifacts.length > 0 ? { artifacts } : {}),
    };
    if (liveStream) {
      this.finishLiveFinalResponseStream(clientId, runHandle, liveStream, {
        kind: "notification",
        content,
        commitStatus,
        extraPayload: terminalPayload,
      });
      return;
    }
    if (this.clientSupportsReplyStreaming(clientId)) {
      this.sendStreamedAssistantResponse(clientId, runHandle, "notification", content, commitStatus, terminalPayload);
      return;
    }
    this.onReply?.(clientId, {
      type: "notification",
      content,
      final: true,
      ...terminalPayload,
    });
  }

  private handleLiveFinalResponseStreamEvent(
    clientId: string,
    runHandle: AgentRunHandle | null,
    current: LiveReplyStream | null,
    event: FinalResponseStreamEvent,
  ): LiveReplyStream | null {
    if (!this.clientSupportsReplyStreaming(clientId)) {
      return current;
    }
    if (event.type === "start") {
      const turnId = randomUUID();
      this.onReply?.(clientId, {
        type: "reply_started",
        turnId,
        kind: event.kind,
        ...(runHandle ? { runId: runHandle.runId } : {}),
      });
      return {
        turnId,
        kind: event.kind,
        content: "",
        seq: 0,
      };
    }

    const stream = current ?? this.handleLiveFinalResponseStreamEvent(clientId, runHandle, null, {
      type: "start",
      kind: "reply",
    });
    if (!stream) {
      return null;
    }
    if (event.delta.length === 0) {
      return stream;
    }
    const next = {
      ...stream,
      content: `${stream.content}${event.delta}`,
      seq: stream.seq + 1,
    };
    this.onReply?.(clientId, {
      type: "reply_delta",
      turnId: next.turnId,
      seq: next.seq,
      delta: event.delta,
    });
    return next;
  }

  private finishLiveFinalResponseStream(
    clientId: string,
    runHandle: AgentRunHandle | null,
    stream: LiveReplyStream,
    result: {
      kind: "reply" | "feedback" | "notification";
      content: string;
      commitStatus: ReplyCommitStatus;
      extraPayload?: Record<string, unknown>;
    },
  ): void {
    this.onReply?.(clientId, {
      type: "reply_done",
      turnId: stream.turnId,
      kind: result.kind,
      content: result.content,
      commitStatus: result.commitStatus,
      ...(runHandle ? { runId: runHandle.runId } : {}),
      ...(result.extraPayload ?? {}),
    });
  }

  private sendStreamedAssistantResponse(
    clientId: string,
    runHandle: AgentRunHandle | null,
    kind: "reply" | "feedback" | "notification",
    content: string,
    commitStatus: ReplyCommitStatus,
    extraPayload: Record<string, unknown>,
  ): void {
    const turnId = randomUUID();
    const runPayload = runHandle ? { runId: runHandle.runId } : {};
    this.onReply?.(clientId, {
      type: "reply_started",
      turnId,
      kind,
      ...runPayload,
    });
    let seq = 0;
    for (const delta of chunkReplyContent(content)) {
      seq++;
      this.onReply?.(clientId, {
        type: "reply_delta",
        turnId,
        seq,
        delta,
      });
    }
    this.onReply?.(clientId, {
      type: "reply_done",
      turnId,
      kind,
      content,
      commitStatus,
      ...runPayload,
      ...extraPayload,
    });
  }

  private sendProgress(clientId: string, runHandle: AgentRunHandle, content: string): void {
    this.onReply?.(clientId, {
      type: "progress",
      content,
      runId: runHandle.runId,
    });
  }

  private async registerIncomingDocuments(
    attachments: ChatAttachmentInput[],
  ): Promise<RegisteredChatAttachments> {
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
              include: attachment.include,
              exclude: attachment.exclude,
              maxDepth: attachment.maxDepth,
              maxFiles: attachment.maxFiles,
            }));
            continue;
          }

          managedFiles.push(await this.registerIncomingManagedFile(attachment));
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
  ): Promise<ManagedFileRecord> {
    if ("fileId" in attachment && typeof attachment.fileId === "string" && attachment.fileId.trim().length > 0) {
      return this.fileLibrary!.getFile(attachment.fileId);
    }

    if (attachment.source === "upload") {
      const bytes = await readFile(attachment.uploadedPath);
      return this.fileLibrary!.registerUpload({
        originalName: attachment.originalName,
        bytes,
        origin: "user_upload",
        mimeType: attachment.mimeType,
        originalPath: attachment.uploadedPath,
      });
    }

    if ("path" in attachment) {
      return this.fileLibrary!.registerPath({
        path: attachment.path,
        name: attachment.name,
      });
    }

    throw new Error("Attachment is missing a usable fileId or path.");
  }

  private async associateRegisteredAttachmentsWithRun(
    registered: RegisteredChatAttachments,
    runId: string,
  ): Promise<void> {
    await Promise.all([
      ...registered.managedFiles.map((file) =>
        this.fileLibrary?.touchRunFile(runId, file.fileId, "attached")),
      ...registered.managedDirectories.map((directory) =>
        this.directoryLibrary?.touchRunDirectory(runId, directory.directoryId, "attached")),
    ]);
  }
}

class AsyncKeySerializer {
  private readonly tails = new Map<string, Promise<void>>();

  isBusy(key: string): boolean {
    return this.tails.has(key);
  }

  async enqueue<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const current = previous.then(work);
    const tail = current.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    tail.finally(() => {
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    });
    return await current;
  }
}

function chatTurnSerializationKeyForClient(clientId: string): string {
  const normalized = clientId.trim();
  return normalized.length > 0 ? normalized : "local";
}

function summarizeChatAttachment(attachment: ChatAttachmentInput): Record<string, unknown> {
  if ("fileId" in attachment) {
    return {
      source: attachment.source,
      fileId: attachment.fileId,
    };
  }
  if (isDirectoryChatAttachment(attachment)) {
    return {
      source: attachment.source,
      type: attachment.type,
      path: attachment.path,
      name: attachment.name,
      include: attachment.include,
      exclude: attachment.exclude,
      maxDepth: attachment.maxDepth,
      maxFiles: attachment.maxFiles,
    };
  }
  if (attachment.source === "upload") {
    return {
      source: attachment.source,
      uploadedPath: attachment.uploadedPath,
      originalName: attachment.originalName,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
    };
  }
  return {
    source: attachment.source,
    path: attachment.path,
    name: attachment.name,
    type: attachment.type,
  };
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

function resourceAdmissions(registered: RegisteredChatAttachments): ResourceAdmission[] {
  const managedFiles = registered.managedFiles.map((file): ResourceAdmission => ({
    admissionId: "file:" + file.fileId,
    kind: resourceKindForManagedFile(file),
    origin: "user_attachment",
    locator: { kind: "filesystem", path: file.storagePath },
    displayName: file.originalName,
    aliases: [file.safeName],
    role: "attachment",
    mediaType: file.mimeType,
  }));
  const directories = registered.managedDirectories.map((directory): ResourceAdmission => ({
    admissionId: "directory:" + directory.directoryId,
    kind: "directory",
    origin: "user_reference",
    locator: { kind: "filesystem", path: directory.rootPath },
    displayName: directory.name,
    aliases: [directory.name],
    role: "attachment",
  }));
  const documents = registered.managedFiles.length > 0
    ? []
    : registered.documents.map((document): ResourceAdmission => ({
        admissionId: "document:" + document.documentId,
        kind: document.kind === "csv" || document.kind === "xlsx" ? "dataset" : "document",
        origin: "user_attachment",
        locator: { kind: "filesystem", path: document.storedPath },
        displayName: document.displayName,
        aliases: [document.name],
        role: "attachment",
        mediaType: document.mimeType,
      }));
  return [...managedFiles, ...directories, ...documents];
}

function resourceKindForManagedFile(file: ManagedFileRecord): ResourceKind {
  if (file.kind === "image") return "image";
  if (file.kind === "csv" || file.kind === "xlsx") return "dataset";
  if (file.kind === "pdf" || file.kind === "docx" || file.kind === "pptx"
    || file.kind === "txt" || file.kind === "markdown") return "document";
  return "file";
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

function promptMemoryContextFromContextEngine(
  context: ContextEngineMachineContext | undefined,
): PromptMemoryContext {
  const streamId = context?.agentStream.meta.streamId;
  const conversationTurns: ConversationTurn[] = (context?.agentStream.recentMessages ?? [])
    .filter(isUserAssistantContextEngineMessage)
    .map((message) => ({
      role: message.role,
      content: message.content,
      timestamp: message.at,
      sessionPath: `agent-stream:${streamId ?? ""}`,
      seq: message.sequence,
    }));

  return {
    recentExchanges: [],
    recentSystemEvents: [],
    conversationTurns,
    personalMemorySnapshot: "",
    personalMemories: [],
  };
}

function isUserAssistantContextEngineMessage(
  message: ContextEngineMachineContext["agentStream"]["recentMessages"][number],
): message is ContextEngineMachineContext["agentStream"]["recentMessages"][number] & {
  role: "user" | "assistant";
} {
  return message.role === "user" || message.role === "assistant";
}

function formatChatRuntimeError(error: unknown): string {
  if (error instanceof ContextEngineServiceError && error.code === "RUN_ALREADY_ACTIVE") {
    const runId = typeof error.details?.["runId"] === "string"
      ? ` (${error.details["runId"]})`
      : "";
    return `A previous Ayati run${runId} is still active or requires recovery, so this message was not accepted.`;
  }
  if (error instanceof ContextEngineServiceError && error.code === "RECOVERY_REQUIRED") {
    return "Ayati has unfinished recovery work from a previous run, so this message was not accepted.";
  }
  if (isProviderEmptyResponseError(error)) {
    return "I could not get a valid response from the model provider. Please retry.";
  }
  return "Failed to generate a response.";
}

function replyCommitStatus(response: FinalizeRunResponse): ReplyCommitStatus {
  return response.workstreamContextCommit.status;
}

function directReplyResult(runId: string, content: string): AgentLoopResult {
  return {
    type: "reply",
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
      summary: content,
      openWork: [],
      blockers: [],
      verifiedFacts: [],
      evidence: [],
    },
    completedSteps: [],
  };
}

function chunkReplyContent(content: string): string[] {
  if (content.length === 0) {
    return [];
  }
  const chunks: string[] = [];
  const chunkSize = 96;
  for (let index = 0; index < content.length; index += chunkSize) {
    chunks.push(content.slice(index, index + chunkSize));
  }
  return chunks;
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
