import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { devError, devLog, devWarn } from "../shared/index.js";
import { persistManagedUpload, type ManagedUploadRecord } from "./upload-storage.js";

const DEFAULT_API_BASE_URL = "https://api.telegram.org";
const DEFAULT_POLL_TIMEOUT_SECONDS = 30;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024;
const DEFAULT_CLIENT_ID = "telegram-shared";
const DEFAULT_DOCUMENT_PROMPT = "Please analyze this document.";
const DEFAULT_SEND_MESSAGE_MAX_CHARS = 4_000;

interface TelegramApiEnvelope<T> {
  ok?: boolean;
  description?: string;
  result?: T;
}

interface TelegramUpdate {
  update_id?: number;
  message?: TelegramMessage;
}

interface TelegramMessage {
  chat?: {
    id?: number | string;
  };
  text?: string;
  caption?: string;
  document?: TelegramDocument;
  photo?: TelegramPhotoSize[];
}

interface TelegramDocument {
  file_id?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramPhotoSize {
  file_id?: string;
  file_size?: number;
  width?: number;
  height?: number;
}

interface TelegramFileResult {
  file_path?: string;
}

export interface TelegramRuntimeConfig {
  botToken: string;
  allowedChatId: string;
  apiBaseUrl: string;
  fileBaseUrl: string;
  clientId: string;
  pollTimeoutSeconds: number;
  pollIntervalMs: number;
  maxFileBytes: number;
  defaultDocumentPrompt: string;
  sendMessageMaxChars: number;
}

export interface TelegramServerOptions extends TelegramRuntimeConfig {
  uploadsDir: string;
  stateDir: string;
  onMessage: (clientId: string, data: unknown) => void;
  fetchImpl?: typeof fetch;
}

export function loadTelegramRuntimeConfig(env: NodeJS.ProcessEnv = process.env): TelegramRuntimeConfig | null {
  const botToken = env["AYATI_TELEGRAM_BOT_TOKEN"]?.trim() || "";
  const allowedChatId = env["AYATI_TELEGRAM_ALLOWED_CHAT_ID"]?.trim() || "";
  const explicitEnabled = env["AYATI_TELEGRAM_ENABLED"];
  const inferredEnabled = botToken.length > 0 && allowedChatId.length > 0;
  const enabled = explicitEnabled === undefined ? inferredEnabled : isTruthyEnv(explicitEnabled);

  if (!enabled) {
    return null;
  }

  if (botToken.length === 0) {
    throw new Error("Telegram is enabled but AYATI_TELEGRAM_BOT_TOKEN is missing.");
  }

  if (allowedChatId.length === 0) {
    throw new Error("Telegram is enabled but AYATI_TELEGRAM_ALLOWED_CHAT_ID is missing.");
  }

  return {
    botToken,
    allowedChatId,
    apiBaseUrl: normalizeBaseUrl(env["AYATI_TELEGRAM_API_BASE_URL"], DEFAULT_API_BASE_URL),
    fileBaseUrl: normalizeBaseUrl(env["AYATI_TELEGRAM_FILE_BASE_URL"], DEFAULT_API_BASE_URL),
    clientId: env["AYATI_TELEGRAM_CLIENT_ID"]?.trim() || DEFAULT_CLIENT_ID,
    pollTimeoutSeconds: parsePositiveInt(env["AYATI_TELEGRAM_POLL_TIMEOUT_SECONDS"], DEFAULT_POLL_TIMEOUT_SECONDS),
    pollIntervalMs: parsePositiveInt(env["AYATI_TELEGRAM_POLL_INTERVAL_MS"], DEFAULT_POLL_INTERVAL_MS),
    maxFileBytes: parsePositiveInt(env["AYATI_TELEGRAM_MAX_FILE_BYTES"], DEFAULT_MAX_FILE_BYTES),
    defaultDocumentPrompt: env["AYATI_TELEGRAM_DOCUMENT_PROMPT"]?.trim() || DEFAULT_DOCUMENT_PROMPT,
    sendMessageMaxChars: parsePositiveInt(
      env["AYATI_TELEGRAM_SEND_MESSAGE_MAX_CHARS"],
      DEFAULT_SEND_MESSAGE_MAX_CHARS,
    ),
  };
}

export class TelegramServer {
  readonly clientId: string;

  private readonly uploadsDir: string;
  private readonly stateDir: string;
  private readonly onMessage: (clientId: string, data: unknown) => void;
  private readonly fetchImpl: typeof fetch;
  private readonly botToken: string;
  private readonly allowedChatId: string;
  private readonly apiBaseUrl: string;
  private readonly fileBaseUrl: string;
  private readonly pollTimeoutSeconds: number;
  private readonly pollIntervalMs: number;
  private readonly maxFileBytes: number;
  private readonly defaultDocumentPrompt: string;
  private readonly sendMessageMaxChars: number;
  private readonly offsetFilePath: string;

  private nextUpdateId = 0;
  private pollLoop: Promise<void> | null = null;
  private sleepTimer: ReturnType<typeof setTimeout> | null = null;
  private sleepResolver: (() => void) | null = null;
  private readonly activeRequests = new Set<AbortController>();
  private stopping = false;

  constructor(options: TelegramServerOptions) {
    this.clientId = options.clientId;
    this.uploadsDir = resolve(options.uploadsDir);
    this.stateDir = resolve(options.stateDir);
    this.onMessage = options.onMessage;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.botToken = options.botToken;
    this.allowedChatId = options.allowedChatId;
    this.apiBaseUrl = options.apiBaseUrl;
    this.fileBaseUrl = options.fileBaseUrl;
    this.pollTimeoutSeconds = Math.max(1, options.pollTimeoutSeconds);
    this.pollIntervalMs = Math.max(50, options.pollIntervalMs);
    this.maxFileBytes = Math.max(1_024, options.maxFileBytes);
    this.defaultDocumentPrompt = options.defaultDocumentPrompt.trim() || DEFAULT_DOCUMENT_PROMPT;
    this.sendMessageMaxChars = Math.max(32, options.sendMessageMaxChars);
    this.offsetFilePath = join(this.stateDir, "telegram-offset.json");
  }

  async start(): Promise<void> {
    if (this.pollLoop) {
      return;
    }

    this.stopping = false;
    this.nextUpdateId = await this.loadOffset();
    this.pollLoop = this.runPollLoop();
    devLog(`Telegram server started for chat ${this.allowedChatId}`);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const controller of this.activeRequests) {
      controller.abort();
    }
    this.activeRequests.clear();

    if (this.sleepTimer) {
      clearTimeout(this.sleepTimer);
      this.sleepTimer = null;
    }
    this.sleepResolver?.();
    this.sleepResolver = null;

    await this.pollLoop?.catch((err) => {
      devWarn(`Telegram poll loop stopped with error: ${err instanceof Error ? err.message : String(err)}`);
    });
    this.pollLoop = null;
    devLog("Telegram server stopped");
  }

  send(clientId: string, data: unknown): void {
    if (clientId !== this.clientId) {
      return;
    }

    const text = this.buildOutgoingText(data);
    if (!text) {
      return;
    }

    void this.sendText(text).catch((err) => {
      devError(`Telegram send failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  private async runPollLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.pollOnce();
      } catch (err) {
        if (this.stopping && isAbortError(err)) {
          break;
        }
        devWarn(`Telegram polling failed: ${err instanceof Error ? err.message : String(err)}`);
        await this.sleep(this.pollIntervalMs);
      }
    }
  }

  private async pollOnce(): Promise<void> {
    const envelope = await this.callTelegramApi<TelegramUpdate[]>("getUpdates", {
      offset: this.nextUpdateId,
      timeout: this.pollTimeoutSeconds,
      allowed_updates: ["message"],
    });
    const updates = envelope.result ?? [];

    for (const update of updates) {
      const updateId = typeof update.update_id === "number" ? update.update_id : undefined;
      if (updateId !== undefined && updateId >= this.nextUpdateId) {
        this.nextUpdateId = updateId + 1;
        await this.persistOffset(this.nextUpdateId);
      }

      await this.handleUpdate(update);
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    if (!message) {
      return;
    }

    const chatId = message.chat?.id;
    if (chatId === undefined || String(chatId) !== this.allowedChatId) {
      if (chatId !== undefined) {
        devWarn(`Ignoring Telegram message from unauthorized chat ${String(chatId)}`);
      }
      return;
    }

    try {
      const normalized = await this.normalizeMessage(message);
      if (!normalized) {
        return;
      }

      this.onMessage(this.clientId, normalized);
    } catch (err) {
      const messageText = err instanceof Error ? err.message : String(err);
      devWarn(`Telegram message rejected: ${messageText}`);
      await this.sendText(`I couldn't process that message: ${messageText}`);
    }
  }

  private async normalizeMessage(message: TelegramMessage): Promise<{
    type: "chat";
    content: string;
    attachments?: Array<ManagedUploadRecord & { source: "web" }>;
  } | null> {
    const text = typeof message.text === "string" ? message.text.trim() : "";
    const caption = typeof message.caption === "string" ? message.caption.trim() : "";
    const document = message.document;
    const photo = Array.isArray(message.photo) ? message.photo : [];

    if (!document && photo.length === 0) {
      if (text.length === 0) {
        return null;
      }
      return {
        type: "chat",
        content: text,
      };
    }

    const attachment = document
      ? await this.downloadDocument(document)
      : await this.downloadPhoto(photo);
    const content = text || caption || this.defaultDocumentPrompt;

    return {
      type: "chat",
      content,
      attachments: [{ source: "web", ...attachment }],
    };
  }

  private async downloadDocument(document: TelegramDocument): Promise<ManagedUploadRecord> {
    const fileId = document.file_id?.trim();
    if (!fileId) {
      throw new Error("document is missing a Telegram file id.");
    }

    const expectedSize = document.file_size;
    if (typeof expectedSize === "number" && expectedSize > this.maxFileBytes) {
      throw new Error(`document exceeds ${this.maxFileBytes} bytes.`);
    }

    const fileEnvelope = await this.callTelegramApi<TelegramFileResult>("getFile", { file_id: fileId });
    const filePath = fileEnvelope.result?.file_path?.trim();
    if (!filePath) {
      throw new Error("Telegram did not return a file path for the document.");
    }

    return this.persistTelegramFile({
      filePath,
      originalName: document.file_name?.trim() || `telegram-${fileId}`,
      mimeType: document.mime_type?.trim() || undefined,
    });
  }

  private async downloadPhoto(photoSizes: TelegramPhotoSize[]): Promise<ManagedUploadRecord> {
    const selected = selectLargestPhotoSize(photoSizes);
    if (!selected) {
      throw new Error("photo is missing a Telegram file id.");
    }

    const fileId = selected.file_id?.trim();
    if (!fileId) {
      throw new Error("photo is missing a Telegram file id.");
    }

    const expectedSize = selected.file_size;
    if (typeof expectedSize === "number" && expectedSize > this.maxFileBytes) {
      throw new Error(`photo exceeds ${this.maxFileBytes} bytes.`);
    }

    const fileEnvelope = await this.callTelegramApi<TelegramFileResult>("getFile", { file_id: fileId });
    const filePath = fileEnvelope.result?.file_path?.trim();
    if (!filePath) {
      throw new Error("Telegram did not return a file path for the photo.");
    }

    return this.persistTelegramFile({
      filePath,
      originalName: buildTelegramPhotoName(fileId, filePath),
      mimeType: inferTelegramPhotoMimeType(filePath),
    });
  }

  private async persistTelegramFile(input: {
    filePath: string;
    originalName: string;
    mimeType?: string;
  }): Promise<ManagedUploadRecord> {
    const downloadUrl = `${this.fileBaseUrl}/file/bot${this.botToken}/${input.filePath}`;
    const response = await this.fetchWithAbort(downloadUrl);
    if (!response.ok) {
      throw new Error(`Telegram file download failed with status ${response.status}.`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    return persistManagedUpload({
      uploadsDir: this.uploadsDir,
      originalName: input.originalName,
      mimeType: input.mimeType?.trim() || undefined,
      bytes,
      maxUploadBytes: this.maxFileBytes,
    });
  }

  private async sendText(text: string): Promise<void> {
    for (const chunk of splitTelegramMessage(text, this.sendMessageMaxChars)) {
      await this.callTelegramApi("sendMessage", {
        chat_id: this.allowedChatId,
        text: chunk,
      });
    }
  }

  private buildOutgoingText(data: unknown): string | null {
    if (!data || typeof data !== "object") {
      return null;
    }

    const payload = data as Record<string, unknown>;
    const type = typeof payload["type"] === "string" ? payload["type"] : "";
    if (!["reply", "feedback", "notification", "error"].includes(type)) {
      return null;
    }

    const content = typeof payload["content"] === "string" ? payload["content"].trim() : "";
    if (content.length === 0) {
      return null;
    }

    const artifacts = Array.isArray(payload["artifacts"]) ? payload["artifacts"] : [];
    if (artifacts.length === 0) {
      return content;
    }

    return `${content}\n\nNote: this reply includes ${artifacts.length} generated artifact${artifacts.length === 1 ? "" : "s"}, but Telegram artifact delivery is not supported yet.`;
  }

  private async callTelegramApi<T>(method: string, body: Record<string, unknown>): Promise<TelegramApiEnvelope<T>> {
    const url = `${this.apiBaseUrl}/bot${this.botToken}/${method}`;
    const response = await this.fetchWithAbort(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Telegram API ${method} failed with status ${response.status}.`);
    }

    const envelope = await response.json() as TelegramApiEnvelope<T>;
    if (!envelope.ok) {
      throw new Error(envelope.description?.trim() || `Telegram API ${method} returned an error.`);
    }

    return envelope;
  }

  private async fetchWithAbort(input: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    this.activeRequests.add(controller);
    try {
      return await this.fetchImpl(input, {
        ...init,
        signal: controller.signal,
      });
    } finally {
      this.activeRequests.delete(controller);
    }
  }

  private async loadOffset(): Promise<number> {
    try {
      const raw = await readFile(this.offsetFilePath, "utf-8");
      const parsed = JSON.parse(raw) as { nextUpdateId?: number };
      return typeof parsed.nextUpdateId === "number" && parsed.nextUpdateId >= 0
        ? parsed.nextUpdateId
        : 0;
    } catch {
      return 0;
    }
  }

  private async persistOffset(nextUpdateId: number): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
    await writeFile(this.offsetFilePath, JSON.stringify({ nextUpdateId }, null, 2), "utf-8");
  }

  private async sleep(ms: number): Promise<void> {
    if (this.stopping) {
      return;
    }

    await new Promise<void>((resolveSleep) => {
      this.sleepResolver = resolveSleep;
      this.sleepTimer = setTimeout(() => {
        this.sleepTimer = null;
        this.sleepResolver = null;
        resolveSleep();
      }, ms);
    });
  }
}

function parsePositiveInt(rawValue: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(rawValue ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isTruthyEnv(rawValue: string): boolean {
  const normalized = rawValue.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function normalizeBaseUrl(rawValue: string | undefined, fallback: string): string {
  const value = rawValue?.trim() || fallback;
  return value.replace(/\/+$/, "");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function splitTelegramMessage(text: string, maxChars: number): string[] {
  const normalized = text.trim();
  if (normalized.length <= maxChars) {
    return [normalized];
  }

  const chunks: string[] = [];
  let remaining = normalized;

  while (remaining.length > maxChars) {
    const splitAt = findSplitIndex(remaining, maxChars);
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

function findSplitIndex(text: string, maxChars: number): number {
  const slice = text.slice(0, maxChars + 1);
  const newlineIndex = slice.lastIndexOf("\n");
  if (newlineIndex >= Math.floor(maxChars / 2)) {
    return newlineIndex;
  }

  const spaceIndex = slice.lastIndexOf(" ");
  if (spaceIndex >= Math.floor(maxChars / 2)) {
    return spaceIndex;
  }

  return maxChars;
}

function selectLargestPhotoSize(photoSizes: TelegramPhotoSize[]): TelegramPhotoSize | null {
  if (photoSizes.length === 0) {
    return null;
  }

  return photoSizes.slice(1).reduce<TelegramPhotoSize>((largest, current) => {
    return getPhotoVariantScore(current) >= getPhotoVariantScore(largest) ? current : largest;
  }, photoSizes[0]!);
}

function getPhotoVariantScore(photo: TelegramPhotoSize): number {
  if (typeof photo.file_size === "number" && Number.isFinite(photo.file_size)) {
    return photo.file_size;
  }

  const width = typeof photo.width === "number" && Number.isFinite(photo.width) ? photo.width : 0;
  const height = typeof photo.height === "number" && Number.isFinite(photo.height) ? photo.height : 0;
  return width * height;
}

function buildTelegramPhotoName(fileId: string, filePath: string): string {
  return `telegram-photo-${fileId}${normalizeTelegramImageExtension(extname(filePath))}`;
}

function inferTelegramPhotoMimeType(filePath: string): string {
  switch (normalizeTelegramImageExtension(extname(filePath))) {
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      return "image/jpeg";
  }
}

function normalizeTelegramImageExtension(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === ".png" || normalized === ".webp" || normalized === ".gif" || normalized === ".jpg") {
    return normalized;
  }
  if (normalized === ".jpeg") {
    return ".jpg";
  }
  return ".jpg";
}
