import { readFile } from "node:fs/promises";
import type { LlmProvider } from "../core/contracts/provider.js";
import type { StaticContext } from "../context/static-context-cache.js";
import type { ManagedDocumentManifest } from "../documents/types.js";
import type { DocumentStore } from "../documents/document-store.js";
import { PreparedAttachmentRegistry } from "../documents/prepared-attachment-registry.js";
import type { DirectoryLibrary } from "../files/directory-library.js";
import type { FileLibrary } from "../files/file-library.js";
import type { DirectoryAttachmentRecord, ManagedFileRecord } from "../files/types.js";
import type { SessionMemory, MemoryRunHandle, SessionInputHandle, AgentResponseKind } from "../memory/types.js";
import {
  appendPulseProposalQuestion,
  PulseProposalReflectionService,
} from "../pulse/proposal-reflection.js";
import type { SkillActivationManager } from "../skills/activation-manager.js";
import type { ToolExecutor } from "../skills/tool-executor.js";
import type { ToolDefinition } from "../skills/types.js";
import { devError, devLog, devWarn } from "../shared/index.js";
import { agentLoop } from "../ivec/agent-loop.js";
import type { AgentFeedbackLedger } from "../ivec/feedback-ledger.js";
import type { ChatContextPreparedTurn, ChatContextRuntime } from "../ivec/chat-context-runtime.js";
import type { ChatTurnRuntime, ChatTurnRuntimeInput } from "../ivec/chat-turn-runtime.js";
import type { RotationPolicyConfig } from "../ivec/session-rotation-policy.js";
import type { ToolWorkingSetManager } from "../ivec/agent-runner/tool-working-set.js";
import type {
  AgentArtifact,
  AgentLoopResult,
  ChatAttachmentInput,
  DirectoryChatAttachmentInput,
  LoopConfig,
} from "../ivec/types.js";
import { buildStaticSystemContext } from "./static-prompt.js";
import { rotateSessionBeforeRunIfNeeded } from "./session-rotation.js";
import { completeSessionLifecycle } from "./session-lifecycle.js";

export interface CreateChatTurnRuntimeOptions {
  onReply?: (clientId: string, data: unknown) => void;
  provider?: LlmProvider;
  staticContext?: StaticContext;
  sessionMemory: SessionMemory;
  toolExecutor?: ToolExecutor;
  skillActivationManager?: SkillActivationManager;
  toolWorkingSetManager?: ToolWorkingSetManager;
  chatContextRuntime: ChatContextRuntime;
  loopConfig?: Partial<LoopConfig>;
  rotationPolicyConfig?: Partial<RotationPolicyConfig>;
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

export function createChatTurnRuntime(options: CreateChatTurnRuntimeOptions): ChatTurnRuntime {
  return new AppChatTurnRuntime(options);
}

class AppChatTurnRuntime implements ChatTurnRuntime {
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
  private readonly feedbackLedger?: AgentFeedbackLedger;
  private readonly chatContextRuntime: ChatContextRuntime;
  private readonly pulseProposalReflectionService = new PulseProposalReflectionService();

  constructor(options: CreateChatTurnRuntimeOptions) {
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
    let chatContextTurn: ChatContextPreparedTurn | null = null;
    let runStatus: "completed" | "failed" | "stuck" | null = null;

    try {
      this.rotateSessionBeforeRunIfNeeded(input.clientId);
      inputHandle = this.sessionMemory.recordUserMessage(input.clientId, input.content);
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

      chatContextTurn = await this.prepareChatContextTurn(input.clientId, input.content);
      if (chatContextTurn?.status === "ambiguous") {
        await this.dispatchChatContextAmbiguity(input.clientId, inputHandle, chatContextTurn);
        runStatus = "completed";
        return;
      }

      if (this.provider) {
        if (input.attachments.length > 0) {
          runHandle = this.createWorkRun(input.clientId, inputHandle);
          this.recordTurnStatus(input.clientId, runHandle, "processing_started");
        }
        const registeredAttachments = runHandle
          ? await this.registerIncomingDocuments(input.attachments, runHandle.runId)
          : { documents: [], warnings: [], managedFiles: [], managedDirectories: [] };
        const toolDefinitions = this.toolExecutor?.definitions({
          clientId: input.clientId,
          runId: runHandle?.runId ?? this.inputScopeId(inputHandle),
          sessionId: inputHandle.sessionId,
        }) ?? [];
        let result = await agentLoop({
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
            this.recordTurnStatus(input.clientId, created, "processing_started");
            this.feedbackLedger?.record({
              clientId: input.clientId,
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
          clientId: input.clientId,
          uiContext: input.uiContext,
          initialUserMessage: input.content,
          config: this.loopConfig,
          dataDir: this.dataDir ?? "data",
          systemContext: buildStaticSystemContext(this.staticContext),
          ...(chatContextTurn?.context ? { harnessContext: { contextEngine: chatContextTurn.context } } : {}),
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
            devLog(`[${input.clientId}] ${log}`);
            if (runHandle) {
              this.sessionMemory.recordAgentStep(input.clientId, {
                runId: runHandle.runId,
                sessionId: runHandle.sessionId,
                step: 0,
                phase: "progress",
                summary: `${log} | runPath: ${runPath}`,
              });
              this.sendProgress(input.clientId, runHandle, log);
            }
          },
        });
        result = await this.applyPulseProposalReflection(input.clientId, input.content, result, toolDefinitions);
        this.dispatchAgentResponse(input.clientId, inputHandle, runHandle, result);
        await this.completeChatContextRun(input.clientId, chatContextTurn, result);
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
        runStatus = result.status;
      } else {
        const echoContent = `Received: "${input.content}"`;
        this.dispatchAgentResponse(input.clientId, inputHandle, null, {
          type: "reply",
          content: echoContent,
        });
        await this.recordChatContextAssistantMessage(input.clientId, chatContextTurn, echoContent);
        runStatus = "completed";
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
        this.sessionMemory.recordRunFailure(
          input.clientId,
          runHandle.runId,
          runHandle.sessionId,
          message,
        );
        this.recordTurnStatus(input.clientId, runHandle, "response_failed", message);
        runStatus = "failed";
      }
      this.onReply?.(input.clientId, {
        type: "error",
        content: "Failed to generate a response.",
      });
    } finally {
      await completeSessionLifecycle({
        clientId: input.clientId,
        sessionMemory: this.sessionMemory,
        runHandle,
        status: runStatus,
      });
    }
  }

  private async prepareChatContextTurn(
    clientId: string,
    userMessage: string,
  ): Promise<ChatContextPreparedTurn> {
    const turn = await this.chatContextRuntime.prepareUserTurn({
      clientId,
      userMessage,
      at: this.nowProvider().toISOString(),
    });

    this.feedbackLedger?.record({
      clientId,
      sessionId: turn.sessionId,
      ...(turn.status === "ready" ? { runId: turn.runId } : {}),
      stage: "context_engine",
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
  }

  private async dispatchChatContextAmbiguity(
    clientId: string,
    inputHandle: SessionInputHandle,
    turn: Extract<ChatContextPreparedTurn, { status: "ambiguous" }>,
  ): Promise<void> {
    await this.recordChatContextAssistantMessage(clientId, turn, turn.message);
    this.dispatchAgentResponse(clientId, inputHandle, null, {
      type: "feedback",
      content: turn.message,
    });
  }

  private async completeChatContextRun(
    clientId: string,
    turn: ChatContextPreparedTurn | null,
    result: AgentLoopResult,
  ): Promise<void> {
    if (turn?.status !== "ready") {
      return;
    }

    const completed = await this.chatContextRuntime.completePreparedRun({
      clientId,
      turn,
      result,
      at: this.nowProvider().toISOString(),
    });
    if (!completed) {
      return;
    }

    this.feedbackLedger?.record({
      clientId,
      sessionId: turn.sessionId,
      runId: turn.runId,
      stage: "context_engine",
      event: "committed",
      data: {
        workId: completed.workId,
        workCommit: completed.workCommit,
        runRef: completed.runRef,
      },
    });
  }

  private async recordChatContextAssistantMessage(
    clientId: string,
    turn: ChatContextPreparedTurn | null,
    message: string,
  ): Promise<void> {
    if (!turn) {
      return;
    }
    await this.chatContextRuntime.recordAssistantMessage({
      clientId,
      turn,
      message,
      at: this.nowProvider().toISOString(),
    });
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

  private inputScopeId(inputHandle: SessionInputHandle): string {
    return `input:${inputHandle.sessionId}:${inputHandle.seq}`;
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

  private dispatchAgentResponse(
    clientId: string,
    inputHandle: SessionInputHandle,
    runHandle: MemoryRunHandle | null,
    result: {
      type: AgentResponseKind;
      content: string;
      artifacts?: AgentArtifact[];
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
        this.sendAssistantNotification(clientId, inputHandle, runHandle, result.content, result.artifacts);
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
