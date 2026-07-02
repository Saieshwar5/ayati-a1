import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { LlmProvider } from "../core/contracts/provider.js";
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
  MemoryRunHandle,
  PromptMemoryContext,
  RunRecorder,
  SessionInputHandle,
} from "../memory/types.js";
import {
  appendPulseProposalQuestion,
  PulseProposalReflectionService,
} from "../pulse/proposal-reflection.js";
import type { SkillActivationManager } from "../skills/activation-manager.js";
import type { ToolExecutor } from "../skills/tool-executor.js";
import type { ToolDefinition } from "../skills/types.js";
import {
  buildGitMemoryHarnessContextPack,
  type GitMemorySessionAttachmentRecord,
  type GitMemoryConversationSeqRange,
} from "../context-engine/index.js";
import type { HarnessContextInput } from "../ivec/harness-context.js";
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
  LoopConfig,
} from "../ivec/types.js";
import { buildStaticSystemContext } from "./static-prompt.js";
import type {
  GitMemoryChatContextPreparedTurn,
  GitMemoryChatContextRoutedTurn,
  GitMemoryChatContextRuntime,
} from "./git-memory-chat-context-runtime.js";

export interface CreateChatTurnRuntimeOptions {
  onReply?: (clientId: string, data: unknown) => void;
  provider?: LlmProvider;
  staticContext?: StaticContext;
  toolExecutor?: ToolExecutor;
  skillActivationManager?: SkillActivationManager;
  toolWorkingSetManager?: ToolWorkingSetManager;
  chatContextRuntime: GitMemoryChatContextRuntime;
  loopConfig?: Partial<LoopConfig>;
  now?: () => Date;
  dataDir?: string;
  documentStore?: DocumentStore;
  preparedAttachmentRegistry?: PreparedAttachmentRegistry;
  fileLibrary?: FileLibrary;
  directoryLibrary?: DirectoryLibrary;
  feedbackLedger?: AgentFeedbackLedger;
}

interface RegisteredChatAttachments {
  documents: ManagedDocumentManifest[];
  warnings: string[];
  managedFiles: ManagedFileRecord[];
  managedDirectories: DirectoryAttachmentRecord[];
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
  private readonly chatContextRuntime: GitMemoryChatContextRuntime;
  private readonly pulseProposalReflectionService = new PulseProposalReflectionService();

  constructor(options: CreateChatTurnRuntimeOptions) {
    this.onReply = options.onReply;
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
  }

  async processChat(input: ChatTurnRuntimeInput): Promise<void> {
    let inputHandle: SessionInputHandle | null = null;
    let runHandle: MemoryRunHandle | null = null;
    let chatContextTurn: GitMemoryChatContextPreparedTurn | null = null;
    let routedContextTurn: GitMemoryChatContextRoutedTurn | null = null;

    try {
      chatContextTurn = await this.prepareChatContextTurn(input.clientId, input.content);
      inputHandle = this.inputHandleFromChatContextTurn(chatContextTurn);
      this.feedbackLedger?.record({
        clientId: input.clientId,
        sessionId: inputHandle.sessionId,
        seq: inputHandle.seq,
        stage: "message",
        event: "received",
        data: {
          kind: "chat",
          content: input.content,
          attachments: input.attachments.map((attachment) => summarizeChatAttachment(attachment)),
          uiContext: input.uiContext,
        },
      });

      routedContextTurn = await this.routeChatContextTurn(input.clientId, chatContextTurn, input.content);
      if (routedContextTurn?.status === "ambiguous") {
        await this.dispatchChatContextAmbiguity(input.clientId, chatContextTurn, routedContextTurn);
        return;
      }

      if (this.provider) {
        runHandle = routedContextTurn?.status === "ready"
          ? this.runHandleFromRoutedTurn(inputHandle, routedContextTurn)
          : null;
        const attachmentRunId = runHandle?.runId ?? this.inputScopeId(inputHandle);
        const registeredAttachments = await this.registerIncomingDocuments(input.attachments, attachmentRunId);
        let harnessContext = routedContextTurn?.status === "ready"
          ? routedContextTurn.harnessContext
          : this.harnessContextFromPreparedTurn(chatContextTurn);
        const recordedAttachments = await this.recordChatContextSessionAttachments(
          input.clientId,
          chatContextTurn,
          registeredAttachments,
        );
        if (recordedAttachments && chatContextTurn) {
          harnessContext = {
            contextEngine: buildGitMemoryHarnessContextPack(
              await this.chatContextRuntime.buildActiveContext(chatContextTurn.sessionId),
            ),
          };
        }
        const toolDefinitions = this.toolExecutor?.definitions({
          clientId: input.clientId,
          runId: attachmentRunId,
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
          ...(runHandle ? { runHandle } : {}),
          onWorkRunCreated: (created) => {
            runHandle = created;
          },
          createWorkRun: this.failMissingGitMemoryRun,
          clientId: input.clientId,
          uiContext: input.uiContext,
          initialUserMessage: input.content,
          config: this.loopConfig,
          dataDir: this.dataDir ?? "data",
          systemContext: buildStaticSystemContext(this.staticContext),
          harnessContext,
          feedbackLedger: this.feedbackLedger,
          attachedDocuments: runHandle ? registeredAttachments.documents : [],
          attachmentWarnings: registeredAttachments.warnings,
          managedFiles: registeredAttachments.managedFiles,
          managedDirectories: registeredAttachments.managedDirectories,
          fileLibrary: this.fileLibrary,
          directoryLibrary: this.directoryLibrary,
          documentStore: this.documentStore,
          preparedAttachmentRegistry: this.preparedAttachmentRegistry,
          onProgress: (log, _runPath) => {
            devLog(`[${input.clientId}] ${log}`);
            if (runHandle) {
              this.sendProgress(input.clientId, runHandle, log);
            }
          },
        });
        result = await this.applyPulseProposalReflection(
          input.clientId,
          input.content,
          result,
          toolDefinitions,
          routedContextTurn,
        );
        this.dispatchAgentResponse(input.clientId, runHandle, result);
        await this.completeChatContextRun(input.clientId, chatContextTurn, routedContextTurn, result);
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
            content: result.content,
            artifacts: result.artifacts,
            runPath: result.runPath,
          },
        });
      } else {
        const echoContent = `Received: "${input.content}"`;
        this.dispatchAgentResponse(input.clientId, null, {
          type: "reply",
          content: echoContent,
        });
        await this.recordChatContextAssistantMessage(input.clientId, chatContextTurn, echoContent, {
          taskId: routedContextTurn?.status === "ready" ? routedContextTurn.taskId : undefined,
        });
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
          message: err instanceof Error ? err.message : String(err),
        },
      });
      if (runHandle) {
        const message = err instanceof Error ? err.message : "Unknown runtime failure";
        this.feedbackLedger?.record({
          clientId: input.clientId,
          sessionId: runHandle.sessionId,
          runId: runHandle.runId,
          stage: "run",
          event: "failed",
          data: { message },
        });
      }
      this.onReply?.(input.clientId, {
        type: "error",
        content: "Failed to generate a response.",
      });
    }
  }

  private async prepareChatContextTurn(
    clientId: string,
    userMessage: string,
  ): Promise<GitMemoryChatContextPreparedTurn> {
    const turn = await this.chatContextRuntime.prepareUserTurn({
      clientId,
      userMessage,
      at: this.nowProvider().toISOString(),
    });
    const contextEngine = buildGitMemoryHarnessContextPack(turn.context);

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

  private async routeChatContextTurn(
    clientId: string,
    turn: GitMemoryChatContextPreparedTurn | null,
    userMessage: string,
  ): Promise<GitMemoryChatContextRoutedTurn | null> {
    if (!turn) {
      return null;
    }
    this.feedbackLedger?.record({
      clientId,
      sessionId: turn.sessionId,
      seq: turn.messageSeq,
      stage: "context_engine",
      event: "auto_route_started",
      data: {
        autoOnly: true,
        messagePreview: userMessage,
        context: summarizeHarnessContext({
          contextEngine: buildGitMemoryHarnessContextPack(turn.context),
        }),
      },
    });
    const routed = await this.chatContextRuntime.routeTaskTurn({
      clientId,
      turn,
      userMessage,
      at: this.nowProvider().toISOString(),
      autoOnly: true,
    });
    if (!routed) {
      this.feedbackLedger?.record({
        clientId,
        sessionId: turn.sessionId,
        seq: turn.messageSeq,
        stage: "context_engine",
        event: "auto_route_result",
        data: {
          status: "skipped",
          reason: "auto_only_no_route",
          contextEngine: buildContextEngineFeedbackSummary({
            context: buildGitMemoryHarnessContextPack(turn.context),
            routeSource: "auto",
          }),
        },
      });
      return null;
    }

    this.feedbackLedger?.record({
      clientId,
      sessionId: turn.sessionId,
      seq: turn.messageSeq,
      ...(routed.status === "ready" ? { runId: routed.runId } : {}),
      stage: "context_engine",
      event: "auto_route_result",
      data: routed.status === "ready"
        ? {
            status: routed.status,
            mode: routed.mode,
            taskId: routed.taskId,
            branch: routed.branch,
            ref: routed.ref,
            runId: routed.runId,
            conversationRefs: routed.conversationRefs,
            contextEngine: buildContextEngineFeedbackSummary({
              context: routed.harnessContext.contextEngine,
              routeStatus: routed.status,
              routeMode: routed.mode,
              routeSource: "auto",
              taskId: routed.taskId,
              branch: routed.branch,
              ref: routed.ref,
              runId: routed.runId,
              conversationRefs: routed.conversationRefs,
            }),
          }
        : {
            status: routed.status,
            reason: routed.reason,
            candidateCount: routed.candidates.length,
            contextEngine: buildContextEngineFeedbackSummary({
              context: routed.harnessContext.contextEngine,
              routeStatus: routed.status,
              routeSource: "deterministic_router",
              pendingTurnStatus: "clarifying",
            }),
          },
    });

    this.feedbackLedger?.record({
      clientId,
      sessionId: turn.sessionId,
      seq: turn.messageSeq,
      ...(routed.status === "ready" ? { runId: routed.runId } : {}),
      stage: "context_engine",
      event: "routed",
      data: routed.status === "ready"
        ? {
            status: routed.status,
            mode: routed.mode,
            taskId: routed.taskId,
            branch: routed.branch,
            ref: routed.ref,
            runId: routed.runId,
            conversationRefs: routed.conversationRefs,
            contextEngine: buildContextEngineFeedbackSummary({
              context: routed.harnessContext.contextEngine,
              routeStatus: routed.status,
              routeMode: routed.mode,
              routeSource: "auto",
              taskId: routed.taskId,
              branch: routed.branch,
              ref: routed.ref,
              runId: routed.runId,
              conversationRefs: routed.conversationRefs,
            }),
          }
        : {
            status: routed.status,
            reason: routed.reason,
            candidateCount: routed.candidates.length,
            contextEngine: buildContextEngineFeedbackSummary({
              context: routed.harnessContext.contextEngine,
              routeStatus: routed.status,
              routeSource: "deterministic_router",
              pendingTurnStatus: "clarifying",
            }),
          },
    });
    return routed;
  }

  private async dispatchChatContextAmbiguity(
    clientId: string,
    prepared: GitMemoryChatContextPreparedTurn | null,
    routed: Extract<GitMemoryChatContextRoutedTurn, { status: "ambiguous" }>,
  ): Promise<void> {
    const message = formatGitMemoryAmbiguityMessage(routed);
    await this.recordChatContextAssistantMessage(clientId, prepared, message);
    this.dispatchAgentResponse(clientId, null, {
      type: "feedback",
      content: message,
    });
  }

  private async completeChatContextRun(
    clientId: string,
    prepared: GitMemoryChatContextPreparedTurn | null,
    routed: GitMemoryChatContextRoutedTurn | null,
    result: AgentLoopResult,
  ): Promise<void> {
    const binding = this.taskRunBindingFromRoutedOrResult(routed, result);
    if (!prepared || !binding) {
      if (prepared && result.content.trim()) {
        await this.recordChatContextAssistantMessage(clientId, prepared, result.content);
      }
      if (prepared) {
        this.feedbackLedger?.record({
          clientId,
          sessionId: prepared.sessionId,
          seq: prepared.messageSeq,
          stage: "context_engine",
          event: "finalization_skipped",
          data: {
            reason: !binding ? "no_task_run_binding" : "missing_prepared_turn",
            contextEngine: buildContextEngineFeedbackSummary({
              context: result.harnessContext?.contextEngine,
              finalizationStatus: "skipped",
              committed: false,
            }),
          },
        });
      }
      return;
    }

    const completedAt = this.nowProvider().toISOString();
    this.feedbackLedger?.record({
      clientId,
      sessionId: prepared.sessionId,
      seq: prepared.messageSeq,
      runId: binding.runId,
      stage: "context_engine",
      event: "finalization_started",
      data: {
        taskId: binding.taskId,
        runId: binding.runId,
        conversationRefs: binding.conversationRefs,
        resultStatus: result.status,
        resultType: result.type,
        contextEngine: buildContextEngineFeedbackSummary({
          context: result.harnessContext?.contextEngine,
          finalizationStatus: "started",
          committed: false,
          taskId: binding.taskId,
          runId: binding.runId,
          conversationRefs: binding.conversationRefs,
        }),
      },
    });
    const completed = await this.chatContextRuntime.completeTaskRun({
      clientId,
      turn: prepared,
      taskId: binding.taskId,
      runId: binding.runId,
      result,
      conversationRefs: binding.conversationRefs,
      at: completedAt,
      assistantMessage: result.content,
      assistantMessageKind: result.workState?.status === "needs_user_input" ? "feedback_question" : "message",
      assistantAt: this.nowProvider().toISOString(),
    });
    if (!completed) {
      this.feedbackLedger?.record({
        clientId,
        sessionId: prepared.sessionId,
        seq: prepared.messageSeq,
        runId: binding.runId,
        stage: "context_engine",
        event: "finalization_failed",
        data: {
          taskId: binding.taskId,
          reason: "complete_task_run_returned_null",
          contextEngine: buildContextEngineFeedbackSummary({
            context: result.harnessContext?.contextEngine,
            finalizationStatus: "failed",
            committed: false,
            taskId: binding.taskId,
            runId: binding.runId,
            conversationRefs: binding.conversationRefs,
          }),
        },
      });
      return;
    }

    this.feedbackLedger?.record({
      clientId,
      sessionId: prepared.sessionId,
      seq: prepared.messageSeq,
      runId: completed.runId,
      stage: "context_engine",
      event: "committed",
      data: {
        taskId: completed.taskId,
        taskCommit: completed.taskCommit,
        ref: completed.ref,
        contextEngine: buildContextEngineFeedbackSummary({
          context: result.harnessContext?.contextEngine,
          finalizationStatus: "committed",
          committed: true,
          taskId: completed.taskId,
          runId: completed.runId,
          ref: completed.ref,
          commit: completed.taskCommit,
          conversationRefs: binding.conversationRefs,
        }),
      },
    });
  }

  private async recordChatContextAssistantMessage(
    clientId: string,
    turn: GitMemoryChatContextPreparedTurn | null,
    message: string,
    ids: {
      taskId?: string;
      runId?: string;
      kind?: "message" | "feedback_question";
    } = {},
  ): Promise<void> {
    if (!turn) {
      return;
    }
    await this.chatContextRuntime.recordAssistantMessage({
      clientId,
      turn,
      message,
      kind: ids.kind,
      at: this.nowProvider().toISOString(),
      taskId: ids.taskId,
      runId: ids.runId,
    });
  }

  private async recordChatContextSessionAttachments(
    clientId: string,
    turn: GitMemoryChatContextPreparedTurn | null,
    registered: RegisteredChatAttachments,
  ): Promise<boolean> {
    if (!turn) {
      return false;
    }
    const at = this.nowProvider().toISOString();
    const attachments = buildGitMemorySessionAttachmentRecords(turn.sessionId, registered, at);
    if (attachments.length === 0) {
      return false;
    }
    if (typeof this.chatContextRuntime.recordSessionAttachments !== "function") {
      return false;
    }
    const file = await this.chatContextRuntime.recordSessionAttachments({
      clientId,
      turn,
      attachments,
      at,
    });
    this.feedbackLedger?.record({
      clientId,
      sessionId: turn.sessionId,
      seq: turn.messageSeq,
      stage: "context_engine",
      event: "session_attachments_recorded",
      data: {
        recorded: Boolean(file),
        count: attachments.length,
        sessionAssetIds: attachments.map((attachment) => attachment.sessionAssetId),
      },
    });
    return Boolean(file);
  }

  private inputHandleFromChatContextTurn(turn: GitMemoryChatContextPreparedTurn): SessionInputHandle {
    return {
      sessionId: turn.sessionId,
      seq: turn.messageSeq,
    };
  }

  private runHandleFromRoutedTurn(
    inputHandle: SessionInputHandle,
    turn: Extract<GitMemoryChatContextRoutedTurn, { status: "ready" }>,
  ): MemoryRunHandle {
    return {
      sessionId: inputHandle.sessionId,
      runId: turn.runId,
      triggerSeq: inputHandle.seq,
    };
  }

  private inputScopeId(inputHandle: SessionInputHandle): string {
    return `input:${inputHandle.sessionId}:${inputHandle.seq}`;
  }

  private failMissingGitMemoryRun(_inputHandle: SessionInputHandle): MemoryRunHandle {
    throw new Error("Git-memory routed run is required before chat tool execution.");
  }

  private harnessContextFromPreparedTurn(
    turn: GitMemoryChatContextPreparedTurn | null,
  ): HarnessContextInput {
    if (!turn) {
      return {};
    }
    return {
      contextEngine: buildGitMemoryHarnessContextPack(turn.context),
    };
  }

  private taskRunBindingFromRoutedOrResult(
    routed: GitMemoryChatContextRoutedTurn | null,
    result: AgentLoopResult,
  ): {
    taskId: string;
    runId: string;
    conversationRefs: GitMemoryConversationSeqRange[];
  } | null {
    if (routed?.status === "ready") {
      return {
        taskId: routed.taskId,
        runId: routed.runId,
        conversationRefs: routed.conversationRefs,
      };
    }
    const pendingTurn = result.harnessContext?.contextEngine?.pendingTurn;
    if (!pendingTurn?.workId || !pendingTurn.runId || pendingTurn.routingStatus !== "bound") {
      return null;
    }
    return {
      taskId: pendingTurn.workId,
      runId: pendingTurn.runId,
      conversationRefs: [{
        fromSeq: pendingTurn.fromSeq,
        toSeq: pendingTurn.toSeq,
      }],
    };
  }

  private async applyPulseProposalReflection(
    clientId: string,
    userMessage: string,
    result: AgentLoopResult,
    toolDefinitions: ToolDefinition[],
    routedContextTurn: GitMemoryChatContextRoutedTurn | null,
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
        memoryContext: promptMemoryContextFromGitMemory(routedContextTurn),
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

  private dispatchAgentResponse(
    clientId: string,
    runHandle: MemoryRunHandle | null,
    result: {
      type: AgentResponseKind;
      content: string;
      artifacts?: AgentArtifact[];
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
        this.sendAssistantNotification(clientId, runHandle, result.content, result.artifacts);
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

  private async registerIncomingDocuments(
    attachments: ChatAttachmentInput[],
    runId: string,
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

function buildGitMemorySessionAttachmentRecords(
  sessionId: string,
  registered: RegisteredChatAttachments,
  at: string,
): GitMemorySessionAttachmentRecord[] {
  const records: GitMemorySessionAttachmentRecord[] = [
    ...registered.managedFiles.map((file) => managedFileToSessionAttachment(sessionId, file, at)),
    ...registered.managedDirectories.map((directory) => managedDirectoryToSessionAttachment(sessionId, directory, at)),
  ];
  if (registered.managedFiles.length === 0) {
    records.push(...registered.documents.map((document) => documentManifestToSessionAttachment(sessionId, document, at)));
  }
  return records;
}

function managedFileToSessionAttachment(
  sessionId: string,
  file: ManagedFileRecord,
  at: string,
): GitMemorySessionAttachmentRecord {
  return {
    sessionAssetId: stableSessionAssetId(sessionId, "file", file.fileId),
    kind: "file",
    name: file.originalName,
    source: file.origin,
    status: toSessionAttachmentStatus(file.processingStatus),
    fileId: file.fileId,
    documentId: file.sha256.slice(0, 16),
    originalPath: file.originalPath ?? file.sourceUri ?? file.storagePath,
    storedPath: file.storagePath,
    ...(file.mimeType ? { mimeType: file.mimeType } : {}),
    sizeBytes: file.sizeBytes,
    checksum: file.sha256,
    createdAt: file.createdAt || at,
    lastUsedAt: file.lastUsedAt ?? at,
  };
}

function managedDirectoryToSessionAttachment(
  sessionId: string,
  directory: DirectoryAttachmentRecord,
  at: string,
): GitMemorySessionAttachmentRecord {
  return {
    sessionAssetId: stableSessionAssetId(sessionId, "directory", directory.directoryId),
    kind: "directory",
    name: directory.name,
    source: directory.source,
    status: toSessionAttachmentStatus(directory.status),
    directoryId: directory.directoryId,
    originalPath: directory.rootPath,
    storedPath: directory.rootPath,
    sizeBytes: directory.totalSizeBytes,
    createdAt: directory.createdAt || at,
    lastUsedAt: directory.lastUsedAt ?? at,
  };
}

function documentManifestToSessionAttachment(
  sessionId: string,
  document: ManagedDocumentManifest,
  at: string,
): GitMemorySessionAttachmentRecord {
  return {
    sessionAssetId: stableSessionAssetId(sessionId, "document", document.documentId),
    kind: document.kind === "csv" || document.kind === "xlsx" ? "dataset" : "document",
    name: document.displayName,
    source: document.source,
    status: "ready",
    documentId: document.documentId,
    originalPath: document.originalPath,
    storedPath: document.storedPath,
    ...(document.mimeType ? { mimeType: document.mimeType } : {}),
    sizeBytes: document.sizeBytes,
    checksum: document.checksum,
    createdAt: at,
    lastUsedAt: at,
  };
}

function toSessionAttachmentStatus(
  status: string,
): GitMemorySessionAttachmentRecord["status"] {
  if (status === "partial" || status === "failed" || status === "unsupported") {
    return status;
  }
  return "ready";
}

function stableSessionAssetId(sessionId: string, kind: string, value: string): string {
  const digest = createHash("sha256")
    .update(`${sessionId}\0${kind}\0${value}`)
    .digest("hex")
    .slice(0, 16);
  return `SA-${digest}`;
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

function promptMemoryContextFromGitMemory(
  routed: GitMemoryChatContextRoutedTurn | null,
): PromptMemoryContext {
  const conversationTurns: ConversationTurn[] = (routed?.context.session.conversationTail ?? [])
    .filter(isUserAssistantGitMemoryMessage)
    .map((message) => ({
      role: message.role,
      content: message.text ?? "",
      timestamp: message.at,
      sessionPath: `git-memory:${routed?.context.session.sessionId ?? ""}`,
      seq: message.seq,
      ...(message.runId ? { workRunId: message.runId } : {}),
    }));

  return {
    recentExchanges: [],
    recentSystemEvents: [],
    conversationTurns,
    personalMemorySnapshot: "",
    personalMemories: [],
  };
}

function isUserAssistantGitMemoryMessage(
  message: NonNullable<GitMemoryChatContextRoutedTurn["context"]["session"]["conversationTail"]>[number],
): message is NonNullable<GitMemoryChatContextRoutedTurn["context"]["session"]["conversationTail"]>[number] & {
  role: "user" | "assistant";
} {
  return message.role === "user" || message.role === "assistant";
}

function formatGitMemoryAmbiguityMessage(
  routed: Extract<GitMemoryChatContextRoutedTurn, { status: "ambiguous" }>,
): string {
  if (routed.candidates.length === 0) {
    return `I could not find the task you referenced. ${routed.reason}. Please mention the task id or describe the task again.`;
  }
  const candidates = routed.candidates
    .slice(0, 5)
    .map((candidate) => `- ${candidate.taskId}: ${candidate.title}`)
    .join("\n");
  return `I found multiple matching tasks. Please mention the task id you want to continue.\n${candidates}`;
}
