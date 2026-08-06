import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { LlmProvider } from "../core/contracts/provider.js";
import { isProviderEmptyResponseError } from "../core/contracts/provider-errors.js";
import type { StaticContext } from "../context/static-context-cache.js";
import type { DirectoryLibrary } from "../files/directory-library.js";
import type { FileLibrary } from "../files/file-library.js";
import type { DirectoryAttachmentRecord, ManagedFileRecord } from "../files/types.js";
import type {
  AgentResponseKind,
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
import type { ToolExecutor } from "../skills/tool-executor.js";
import {
  createInitialHarnessContext,
  type HarnessContextInput,
} from "../ivec/harness-context.js";
import { devError, devLog, devWarn } from "../shared/index.js";
import { agentLoop } from "../ivec/agent-loop.js";
import type { AgentEventSink } from "../ivec/agent-event-sink.js";
import { buildContextEngineEventSummary } from "../ivec/context-engine-event-summary.js";
import type { ChatTurnRuntime, ChatTurnRuntimeInput } from "../ivec/chat-turn-runtime.js";
import type { CapabilitySurfaceManager } from "../ivec/agent-runner/capabilities/surface-manager.js";
import type { HotContextRuntime } from "../ivec/hot-context/index.js";
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
import {
  createChatReplyChannel,
  type ChatReplyChannel,
} from "./chat-reply-channel.js";
import { buildStaticSystemContext } from "./static-prompt.js";
import type {
  ContextEnginePreparedTurn,
  ContextEngineRuntime,
} from "./context-engine-runtime.js";
import {
  finalizeAgentRun,
  isWorkstreamBoundRun,
} from "./run-finalization-coordinator.js";

export interface CreateChatTurnRuntimeOptions {
  onReply?: (clientId: string, data: unknown) => void;
  clientSupportsReplyStreaming?: (clientId: string) => boolean;
  provider?: LlmProvider;
  workspaceRoot: string;
  staticContext?: StaticContext;
  toolExecutor?: ToolExecutor;
  capabilitySurfaceManager?: CapabilitySurfaceManager;
  hotContextRuntime?: HotContextRuntime;
  chatContextRuntime: ContextEngineRuntime;
  contextEngineService?: ContextEngineService;
  loopConfig?: Partial<LoopConfig>;
  now?: () => Date;
  dataDir?: string;
  fileLibrary?: FileLibrary;
  directoryLibrary?: DirectoryLibrary;
  eventSink?: AgentEventSink;
}

interface RegisteredChatAttachments {
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

export function createChatTurnRuntime(options: CreateChatTurnRuntimeOptions): ChatTurnRuntime {
  return new AppChatTurnRuntime(options);
}

class AppChatTurnRuntime implements ChatTurnRuntime {
  private readonly onReply?: (clientId: string, data: unknown) => void;
  private readonly clientSupportsReplyStreaming: (clientId: string) => boolean;
  private readonly provider?: LlmProvider;
  private readonly workspaceRoot: string;
  private readonly staticContext?: StaticContext;
  private readonly toolExecutor?: ToolExecutor;
  private readonly capabilitySurfaceManager?: CapabilitySurfaceManager;
  private readonly hotContextRuntime?: HotContextRuntime;
  private readonly loopConfig?: Partial<LoopConfig>;
  private readonly nowProvider: () => Date;
  private readonly dataDir?: string;
  private readonly fileLibrary?: FileLibrary;
  private readonly directoryLibrary?: DirectoryLibrary;
  private readonly eventSink?: AgentEventSink;
  private readonly chatContextRuntime: ContextEngineRuntime;
  private readonly contextEngineService?: ContextEngineService;
  constructor(options: CreateChatTurnRuntimeOptions) {
    this.onReply = options.onReply;
    this.clientSupportsReplyStreaming = options.clientSupportsReplyStreaming ?? (() => false);
    this.provider = options.provider;
    this.workspaceRoot = options.workspaceRoot;
    this.staticContext = options.staticContext;
    this.toolExecutor = options.toolExecutor;
    this.capabilitySurfaceManager = options.capabilitySurfaceManager;
    this.hotContextRuntime = options.hotContextRuntime;
    this.loopConfig = options.loopConfig;
    this.nowProvider = options.now ?? (() => new Date());
    this.dataDir = options.dataDir;
    this.fileLibrary = options.fileLibrary;
    this.directoryLibrary = options.directoryLibrary;
    this.eventSink = options.eventSink;
    this.chatContextRuntime = options.chatContextRuntime;
    this.contextEngineService = options.contextEngineService;
  }

  async processChat(input: ChatTurnRuntimeInput): Promise<void> {
    const replyChannel = createChatReplyChannel({
      input,
      onReply: this.onReply,
      clientSupportsReplyStreaming: this.clientSupportsReplyStreaming,
    });
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
        input.messageId,
      );
      inputHandle = this.inputHandleFromChatContextTurn(chatContextTurn);
      runHandle = chatContextTurn.run;
      this.eventSink?.record({
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
        },
      });

      if (this.provider) {
        await this.associateRegisteredAttachmentsWithRun(registeredAttachments, runHandle.runId);
        const harnessContext = this.harnessContextFromPreparedTurn(chatContextTurn);
        const toolDefinitions = this.toolExecutor?.definitions({
          clientId: input.clientId,
          runId: runHandle.runId,
          sessionId: inputHandle.sessionId,
        }) ?? [];
        let result = await agentLoop({
          provider: this.provider,
          workspaceRoot: this.workspaceRoot,
          toolExecutor: this.toolExecutor,
          capabilitySurfaceManager: this.capabilitySurfaceManager,
          hotContextRuntime: this.hotContextRuntime,
          toolDefinitions,
          inputHandle,
          runHandle,
          recordRunStep: async (record) => {
            const context = await this.chatContextRuntime.recordRunStep({
              turn: chatContextTurn,
              record,
            });
            return context ? { contextEngine: context } : undefined;
          },
          checkpointWorkState: async (checkpoint) => {
            const result = await this.chatContextRuntime.checkpointRunWorkState({
              turn: chatContextTurn,
              ...checkpoint,
            });
            return {
              ...(result ? { context: { contextEngine: result.context } } : {}),
              runtime: result?.runtime ?? checkpoint.runtime,
            };
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
          initialUserMessage: input.content,
          config: this.loopConfig,
          dataDir: this.dataDir ?? "data",
          systemContext: buildStaticSystemContext(this.staticContext),
          harnessContext,
          eventSink: this.eventSink,
          attachmentWarnings: registeredAttachments.warnings,
          managedFiles: registeredAttachments.managedFiles,
          managedDirectories: registeredAttachments.managedDirectories,
          fileLibrary: this.fileLibrary,
          directoryLibrary: this.directoryLibrary,
          onProgress: (log, _runPath) => {
            devLog(`[${input.clientId}] ${log}`);
            this.sendProgress(replyChannel, runHandle!, log);
          },
          ...(replyChannel.supportsStreaming
            ? {
                onFinalResponseStream: (event: FinalResponseStreamEvent) => {
                  liveFinalResponseStream = this.handleLiveFinalResponseStreamEvent(
                    replyChannel,
                    runHandle,
                    liveFinalResponseStream,
                    event,
                  );
                },
              }
            : {}),
        });
        finalizationAttempted = true;
        const commitStatus = await this.finalizeChatContextRun(
          input.clientId,
          chatContextTurn,
          result,
        );
        this.dispatchAgentResponse(replyChannel, runHandle, result, commitStatus, liveFinalResponseStream);
        this.eventSink?.record({
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
        this.eventSink?.scheduleCheckpoint?.(runHandle.runId);
      } else {
        const echoContent = `Received: "${input.content}"`;
        const result = directReplyResult(runHandle.runId, echoContent);
        finalizationAttempted = true;
        const commitStatus = await this.finalizeChatContextRun(
          input.clientId,
          chatContextTurn,
          result,
        );
        this.dispatchAgentResponse(replyChannel, runHandle, {
          type: "reply",
          content: echoContent,
        }, commitStatus);
        this.eventSink?.record({
          clientId: input.clientId,
          sessionId: inputHandle.sessionId,
          seq: inputHandle.seq,
          runId: runHandle.runId,
          stage: "final",
          event: "dispatched",
          data: { type: "reply", status: result.status, stopReason: result.stopReason, content: echoContent },
        });
        this.eventSink?.scheduleCheckpoint?.(runHandle.runId);
      }
    } catch (err) {
      devError("Provider error:", err);
      this.eventSink?.record({
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
        this.eventSink?.record({
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
        this.finishLiveFinalResponseStream(replyChannel, runHandle, failedLiveStream, {
          kind: failedLiveStream.kind,
          content: failedLiveStream.content,
          commitStatus: "failed",
        });
        liveFinalResponseStream = null;
      }
      replyChannel.send({
        type: "error",
        content: formatChatRuntimeError(err),
        ...(runHandle ? { runId: runHandle.runId } : {}),
      });
      if (runHandle) this.eventSink?.scheduleCheckpoint?.(runHandle.runId);
    }
  }

  private async prepareChatContextTurn(
    clientId: string,
    userMessage: string,
    resources: ResourceAdmission[],
    at: string,
    messageId?: string,
  ): Promise<ContextEnginePreparedTurn> {
    const turn = await this.chatContextRuntime.prepareUserTurn({
      clientId,
      userMessage,
      ...(resources.length > 0 ? { resources } : {}),
      ...(messageId ? { ingressMessageId: messageId } : {}),
      at,
    });
    const contextEngine = turn.context;

    this.eventSink?.record({
      clientId,
      sessionId: turn.streamId,
      seq: turn.messageSequence,
      stage: "context_engine",
      event: "prepared",
      data: {
        status: turn.status,
        messageSequence: turn.messageSequence,
        contextEngine: buildContextEngineEventSummary({
          context: contextEngine,
          routeSource: "runtime",
        }),
        pendingTurnStatus: contextEngine.current.routing?.status ?? "none",
        context: summarizeHarnessContext({ contextEngine }),
      },
    });
    this.eventSink?.record({
      clientId,
      sessionId: turn.streamId,
      seq: turn.messageSequence,
      stage: "context_engine",
      event: "pending_turn_snapshot",
      data: {
        status: contextEngine.current.routing?.status ?? "none",
        routing: contextEngine.current.routing,
        contextEngine: buildContextEngineEventSummary({
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
    this.eventSink?.record({
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
    this.eventSink?.record({
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
        content: `Runtime failed before the run could complete: ${message}`,
        status: "failed",
        totalIterations: 0,
        totalToolCalls: 0,
        runPath: "",
        workState: {
          status: "in_progress",
          summary: "Run failed before completion.",
          plan: [],
          importantContext: [{ kind: "constraint", value: message }],
          nextAction: "Retry the request from the latest verified state.",
        },
        completedSteps: [],
        harnessContext: createInitialHarnessContext(this.harnessContextFromPreparedTurn(prepared)),
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
    turn: ContextEnginePreparedTurn | null,
  ): HarnessContextInput {
    if (!turn) {
      return {};
    }
    return {
      contextEngine: turn.context,
    };
  }

  private dispatchAgentResponse(
    replyChannel: ChatReplyChannel,
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
        this.sendAssistantReply(replyChannel, runHandle, result.content, commitStatus, result.artifacts, liveStream);
        return;
      case "feedback":
        this.sendAssistantFeedback(replyChannel, runHandle, result.content, commitStatus, result.artifacts, liveStream);
        return;
      case "notification":
        this.sendAssistantNotification(replyChannel, runHandle, result.content, commitStatus, result.artifacts, liveStream);
        return;
      case "none":
        return;
    }
  }

  private sendAssistantReply(
    replyChannel: ChatReplyChannel,
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
      this.finishLiveFinalResponseStream(replyChannel, runHandle, liveStream, {
        kind: "reply",
        content,
        commitStatus,
        extraPayload: terminalPayload,
      });
      return;
    }
    if (replyChannel.supportsStreaming) {
      this.sendStreamedAssistantResponse(replyChannel, runHandle, "reply", content, commitStatus, terminalPayload);
      return;
    }
    replyChannel.send({
      type: "reply",
      content,
      ...terminalPayload,
    });
  }

  private sendAssistantFeedback(
    replyChannel: ChatReplyChannel,
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
      this.finishLiveFinalResponseStream(replyChannel, runHandle, liveStream, {
        kind: "feedback",
        content,
        commitStatus,
        extraPayload: terminalPayload,
      });
      return;
    }
    if (replyChannel.supportsStreaming) {
      this.sendStreamedAssistantResponse(replyChannel, runHandle, "feedback", content, commitStatus, terminalPayload);
      return;
    }
    replyChannel.send({
      type: "feedback",
      content,
      ...terminalPayload,
    });
  }

  private sendAssistantNotification(
    replyChannel: ChatReplyChannel,
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
      this.finishLiveFinalResponseStream(replyChannel, runHandle, liveStream, {
        kind: "notification",
        content,
        commitStatus,
        extraPayload: terminalPayload,
      });
      return;
    }
    if (replyChannel.supportsStreaming) {
      this.sendStreamedAssistantResponse(replyChannel, runHandle, "notification", content, commitStatus, terminalPayload);
      return;
    }
    replyChannel.send({
      type: "notification",
      content,
      final: true,
      ...terminalPayload,
    });
  }

  private handleLiveFinalResponseStreamEvent(
    replyChannel: ChatReplyChannel,
    runHandle: AgentRunHandle | null,
    current: LiveReplyStream | null,
    event: FinalResponseStreamEvent,
  ): LiveReplyStream | null {
    if (!replyChannel.supportsStreaming) {
      return current;
    }
    if (event.type === "start") {
      const turnId = randomUUID();
      replyChannel.send({
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

    const stream = current ?? this.handleLiveFinalResponseStreamEvent(replyChannel, runHandle, null, {
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
    replyChannel.send({
      type: "reply_delta",
      turnId: next.turnId,
      seq: next.seq,
      delta: event.delta,
    });
    return next;
  }

  private finishLiveFinalResponseStream(
    replyChannel: ChatReplyChannel,
    runHandle: AgentRunHandle | null,
    stream: LiveReplyStream,
    result: {
      kind: "reply" | "feedback" | "notification";
      content: string;
      commitStatus: ReplyCommitStatus;
      extraPayload?: Record<string, unknown>;
    },
  ): void {
    replyChannel.send({
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
    replyChannel: ChatReplyChannel,
    runHandle: AgentRunHandle | null,
    kind: "reply" | "feedback" | "notification",
    content: string,
    commitStatus: ReplyCommitStatus,
    extraPayload: Record<string, unknown>,
  ): void {
    const turnId = randomUUID();
    const runPayload = runHandle ? { runId: runHandle.runId } : {};
    replyChannel.send({
      type: "reply_started",
      turnId,
      kind,
      ...runPayload,
    });
    let seq = 0;
    for (const delta of chunkReplyContent(content)) {
      seq++;
      replyChannel.send({
        type: "reply_delta",
        turnId,
        seq,
        delta,
      });
    }
    replyChannel.send({
      type: "reply_done",
      turnId,
      kind,
      content,
      commitStatus,
      ...runPayload,
      ...extraPayload,
    });
  }

  private sendProgress(replyChannel: ChatReplyChannel, runHandle: AgentRunHandle, content: string): void {
    replyChannel.send({
      type: "progress",
      content,
      runId: runHandle.runId,
    });
  }

  private async registerIncomingDocuments(
    attachments: ChatAttachmentInput[],
  ): Promise<RegisteredChatAttachments> {
    if (attachments.length === 0) {
      return { warnings: [], managedFiles: [], managedDirectories: [] };
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
        warnings,
        managedFiles,
        managedDirectories,
      };
    }

    return {
      warnings: ["Attachments were provided but the managed file library is not configured."],
      managedFiles: [],
      managedDirectories: [],
    };
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
  return [...managedFiles, ...directories];
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
      plan: [],
      importantContext: [],
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
