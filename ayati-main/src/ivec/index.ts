import { randomUUID } from "node:crypto";
import { buildStaticSystemContext } from "../app/static-prompt.js";
import type { LlmProvider } from "../core/contracts/provider.js";
import type { StaticContext } from "../context/static-context-cache.js";
import { estimateTextTokens } from "../prompt/token-estimator.js";
import { devError, devLog, devWarn } from "../shared/index.js";
import { AgentRunQueue } from "./agent-run-queue.js";
import type { ChatTurnRuntime } from "./chat-turn-runtime.js";
import type { ChatAttachmentInput, ChatInboundMessage } from "./types.js";

export interface IVecEngineOptions {
  provider?: LlmProvider;
  staticContext?: StaticContext;
  chatTurnRuntime?: ChatTurnRuntime;
}

export interface ChatIngressReceipt {
  type: "chat_accepted";
  messageId: string;
  queued: boolean;
  queuePosition: number;
  duplicate?: true;
}

export interface ChatRunSettled {
  messageId: string;
  status: "completed" | "failed";
  error?: string;
}

export interface MessageIngressContext {
  replyClientId?: string;
  channel?: "cli" | "desktop" | "voice" | "unknown";
  onSettled?: (result: ChatRunSettled) => void;
}

const MAX_RECENT_CHAT_RECEIPTS = 2_048;

export class IVecEngine {
  private readonly provider?: LlmProvider;
  private readonly staticContext?: StaticContext;
  private readonly chatTurnRuntime?: ChatTurnRuntime;
  private readonly runQueue = new AgentRunQueue();
  private readonly recentChatReceipts = new Map<string, ChatIngressReceipt>();
  private staticSystemTokens = 0;
  private staticTokensReady = false;

  constructor(options?: IVecEngineOptions) {
    this.provider = options?.provider;
    this.staticContext = options?.staticContext;
    this.chatTurnRuntime = options?.chatTurnRuntime;
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
    await this.runQueue.drain();
    if (this.provider) {
      await this.provider.stop();
      devLog(`Provider "${this.provider.name}" stopped`);
    }
    devLog("IVecEngine stopped");
  }

  invalidateStaticTokenCache(): void {
    this.staticTokensReady = false;
  }

  handleMessage(
    clientId: string,
    data: unknown,
    ingress?: MessageIngressContext,
  ): ChatIngressReceipt | null {
    devLog(`Message from ${clientId}:`, JSON.stringify(data));
    const message = parseChatInboundMessage(data);
    if (!message) return null;
    if (!this.chatTurnRuntime) {
      devWarn("Ignored chat message because no chat turn runtime is configured.");
      return null;
    }

    const messageId = message.messageId ?? randomUUID();
    const receiptKey = `${clientId}:${messageId}`;
    const previousReceipt = this.recentChatReceipts.get(receiptKey);
    if (previousReceipt) return { ...previousReceipt, duplicate: true };

    const queued = this.runQueue.isBusy();
    const receipt: ChatIngressReceipt = {
      type: "chat_accepted",
      messageId,
      queued,
      queuePosition: this.runQueue.size() + 1,
    };
    this.rememberChatReceipt(receiptKey, receipt);

    void this.enqueueChat(clientId, async () => {
      await this.chatTurnRuntime!.processChat({
        clientId,
        ...(ingress?.replyClientId ? { replyClientId: ingress.replyClientId } : {}),
        messageId,
        ...(ingress?.channel ? { channel: ingress.channel } : {}),
        content: message.content,
        attachments: message.attachments ?? [],
      });
    }).then(
      () => this.notifyChatSettled(ingress?.onSettled, { messageId, status: "completed" }),
      (error: unknown) => {
        devError("Unhandled chat processing failure:", error);
        this.notifyChatSettled(ingress?.onSettled, {
          messageId,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );
    return receipt;
  }

  private async enqueueChat(clientId: string, work: () => Promise<void>): Promise<void> {
    const queued = this.runQueue.isBusy();
    const position = this.runQueue.size() + 1;
    if (queued) {
      devLog(`[${clientId}] chat queued behind an active agent run position=${position}`);
    }
    await this.runQueue.enqueue(async () => {
      if (queued) devLog(`[${clientId}] chat started after waiting for the global agent run queue`);
      await work();
    });
  }

  private rememberChatReceipt(key: string, receipt: ChatIngressReceipt): void {
    if (this.recentChatReceipts.size >= MAX_RECENT_CHAT_RECEIPTS) {
      const oldestKey = this.recentChatReceipts.keys().next().value;
      if (oldestKey) this.recentChatReceipts.delete(oldestKey);
    }
    this.recentChatReceipts.set(key, receipt);
  }

  private notifyChatSettled(
    callback: MessageIngressContext["onSettled"],
    result: ChatRunSettled,
  ): void {
    try {
      callback?.(result);
    } catch (error) {
      devWarn("Chat settlement callback failed:", error);
    }
  }

  private ensureStaticTokenCache(): void {
    if (this.staticTokensReady) return;
    if (!this.staticContext) {
      this.staticSystemTokens = 0;
      this.staticTokensReady = true;
      return;
    }
    const staticOnlyPrompt = buildStaticSystemContext(this.staticContext) ?? "";
    const promptTokens = estimateTextTokens(staticOnlyPrompt);
    this.staticSystemTokens = promptTokens;
    this.staticTokensReady = true;
    devLog(`Static context tokens cached: ${this.staticSystemTokens} (prompt=${promptTokens})`);
  }
}

function asOptionalPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function asOptionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value
    .map((entry) => typeof entry === "string" ? entry.trim() : "")
    .filter((entry) => entry.length > 0);
  return strings.length > 0 ? strings : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function parseChatInboundMessage(data: unknown): ChatInboundMessage | null {
  const payload = asRecord(data);
  if (!payload || payload["type"] !== "chat" || typeof payload["content"] !== "string") return null;

  const rawMessageId = payload["messageId"];
  const messageId = rawMessageId === undefined ? undefined : asBoundedString(rawMessageId, 128);
  if (rawMessageId !== undefined && !messageId) return null;
  const baseMessage: ChatInboundMessage = {
    type: "chat",
    ...(messageId ? { messageId } : {}),
    content: payload["content"],
  };

  if (!Array.isArray(payload["attachments"])) return baseMessage;
  const attachments: ChatAttachmentInput[] = [];
  for (const row of payload["attachments"]) {
    const value = asRecord(row);
    if (!value) continue;

    const fileId = typeof value["fileId"] === "string" ? value["fileId"].trim() : "";
    if (fileId) {
      attachments.push({ source: "file", fileId });
      continue;
    }

    const rawType = typeof value["type"] === "string"
      ? value["type"]
      : typeof value["kind"] === "string"
        ? value["kind"]
        : undefined;
    const attachmentType = rawType?.trim().toLowerCase();
    const source = typeof value["source"] === "string" ? value["source"].trim().toLowerCase() : undefined;
    if (attachmentType === "directory") {
      if (source !== undefined && source !== "cli") continue;
      const path = typeof value["path"] === "string" ? value["path"].trim() : "";
      if (!path) continue;
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
      if (!path) continue;
      const name = typeof value["name"] === "string" ? value["name"].trim() : undefined;
      attachments.push({
        ...(attachmentType === "file" ? { type: "file" as const } : {}),
        source: "cli",
        path,
        ...(name ? { name } : {}),
      });
      continue;
    }

    if (source !== "upload" && attachmentType !== "upload") continue;
    const uploadedPath = typeof value["uploadedPath"] === "string" ? value["uploadedPath"].trim() : "";
    const originalName = typeof value["originalName"] === "string" ? value["originalName"].trim() : "";
    if (!uploadedPath || !originalName) continue;
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

  return { ...baseMessage, ...(attachments.length > 0 ? { attachments } : {}) };
}

function asBoundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : undefined;
}

export { IVecEngine as AgentEngine };
export type AgentEngineOptions = IVecEngineOptions;
