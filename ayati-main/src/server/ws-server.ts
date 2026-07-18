import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { devLog, devWarn, devError } from "../shared/index.js";

const DEFAULT_PORT = 8080;
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
const MAX_RETRIES = 10;
const MAX_PENDING_REPLY_RENDERS = 100;

export interface WsServerOptions {
  port?: number;
  onMessage: (clientId: string, data: unknown) => void;
  onDisconnect?: (clientId: string) => void;
  onReplyRendered?: (clientId: string, acknowledgement: ReplyRenderedAcknowledgement) => void;
}

export interface ReplyRenderedAcknowledgement {
  turnId: string;
  renderedAt: string;
  receivedAt: string;
  latencyMs: number;
}

interface ClientCapabilities {
  replyStreaming: boolean;
}

export class WsServer {
  private readonly port: number;
  private readonly onMessage: (clientId: string, data: unknown) => void;
  private readonly onDisconnect?: (clientId: string) => void;
  private readonly onReplyRendered?: WsServerOptions["onReplyRendered"];
  private wss: WebSocketServer | null = null;
  private clients = new Map<string, WebSocket>();
  private clientCapabilities = new Map<string, ClientCapabilities>();
  private pendingReplyRenders = new Map<string, Map<string, number>>();
  private defaultClientId: string | null = null;
  private retryCount = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping = false;

  constructor(options: WsServerOptions) {
    this.port = options.port ?? DEFAULT_PORT;
    this.onMessage = options.onMessage;
    this.onDisconnect = options.onDisconnect;
    this.onReplyRendered = options.onReplyRendered;
  }

  async start(): Promise<void> {
    this.stopping = false;
    this.retryCount = 0;
    return this.bind();
  }

  private bind(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.wss = new WebSocketServer({ port: this.port });

      this.wss.on("listening", () => {
        devLog(`WebSocket server listening on port ${this.port}`);
        this.retryCount = 0;
        resolve();
      });

      this.wss.on("connection", (ws) => {
        const clientId = randomUUID();
        this.clients.set(clientId, ws);
        this.clientCapabilities.set(clientId, { replyStreaming: false });
        this.defaultClientId = clientId;
        devLog(`Client connected: ${clientId}`);

        ws.on("message", (raw) => {
          const text = raw.toString();
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            devWarn(`Invalid JSON from ${clientId}: ${text}`);
            ws.send(JSON.stringify({ type: "error", content: "Invalid JSON" }));
            return;
          }
          if (this.recordClientHello(clientId, parsed)) {
            return;
          }
          if (this.recordReplyRendered(clientId, parsed)) {
            return;
          }
          this.onMessage(clientId, parsed);
        });

        ws.on("close", () => {
          this.clients.delete(clientId);
          this.clientCapabilities.delete(clientId);
          this.pendingReplyRenders.delete(clientId);
          if (this.defaultClientId === clientId) {
            const first = this.clients.keys().next();
            this.defaultClientId = first.done ? null : first.value;
          }
          devLog(`Client disconnected: ${clientId}`);
          this.onDisconnect?.(clientId);
        });

        ws.on("error", (err) => {
          devError(`Client error (${clientId}):`, err.message);
        });
      });

      this.wss.on("error", (err: NodeJS.ErrnoException) => {
        devError(`WebSocket server error: ${err.message}`);

        if (this.retryCount === 0) {
          // First attempt failed — reject the start() promise, then schedule retry
          this.scheduleRetry();
          reject(err);
        } else {
          this.scheduleRetry();
        }
      });
    });
  }

  private scheduleRetry(): void {
    if (this.stopping) return;

    if (this.retryCount >= MAX_RETRIES) {
      devError(`Max retries (${MAX_RETRIES}) reached. Giving up.`);
      return;
    }

    const backoff = Math.min(
      INITIAL_BACKOFF_MS * 2 ** this.retryCount,
      MAX_BACKOFF_MS,
    );
    this.retryCount++;
    devWarn(`Retrying in ${backoff}ms (attempt ${this.retryCount}/${MAX_RETRIES})...`);

    this.retryTimer = setTimeout(() => {
      if (this.stopping) return;
      devLog("Attempting to restart WebSocket server...");
      void this.bind().catch(() => {
        // Error already handled by the "error" event
      });
    }, backoff);
  }

  send(clientId: string, data: unknown): void {
    let ws = this.clients.get(clientId);
    let resolvedClientId = clientId;
    if (!ws && clientId === "local") {
      if (this.defaultClientId) {
        resolvedClientId = this.defaultClientId;
        ws = this.clients.get(this.defaultClientId);
      }
      if (!ws) {
        const first = this.clients.entries().next();
        if (!first.done) {
          resolvedClientId = first.value[0];
          ws = first.value[1];
        }
      }
    }
    if (!ws) {
      devWarn(`send(): unknown client ${clientId}`);
      return;
    }
    ws.send(JSON.stringify(data));
    const turnId = readReplyDoneTurnId(data);
    if (turnId) {
      const pending = this.pendingReplyRenders.get(resolvedClientId) ?? new Map<string, number>();
      if (!pending.has(turnId) && pending.size >= MAX_PENDING_REPLY_RENDERS) {
        const oldestTurnId = pending.keys().next().value;
        if (oldestTurnId) {
          pending.delete(oldestTurnId);
        }
      }
      pending.set(turnId, Date.now());
      this.pendingReplyRenders.set(resolvedClientId, pending);
    }
  }

  clientSupportsReplyStreaming(clientId: string): boolean {
    const direct = this.clientCapabilities.get(clientId);
    if (direct) {
      return direct.replyStreaming;
    }
    if (clientId !== "local") {
      return false;
    }
    if (this.defaultClientId) {
      return this.clientCapabilities.get(this.defaultClientId)?.replyStreaming === true;
    }
    return false;
  }

  async stop(): Promise<void> {
    this.stopping = true;

    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }

    for (const client of this.clients.values()) {
      client.close(1001, "Server shutting down");
    }
    this.clients.clear();
    this.clientCapabilities.clear();
    this.pendingReplyRenders.clear();

    return new Promise<void>((resolve) => {
      if (!this.wss) {
        resolve();
        return;
      }
      this.wss.close(() => {
        devLog("WebSocket server stopped");
        this.wss = null;
        resolve();
      });
    });
  }

  private recordClientHello(clientId: string, data: unknown): boolean {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return false;
    }
    const record = data as Record<string, unknown>;
    if (record["type"] !== "client_hello") {
      return false;
    }
    const capabilities = readObject(record["capabilities"]);
    this.clientCapabilities.set(clientId, {
      replyStreaming: capabilities?.["replyStreaming"] === true,
    });
    return true;
  }

  private recordReplyRendered(clientId: string, data: unknown): boolean {
    const record = readObject(data);
    if (record?.["type"] !== "reply_rendered") {
      return false;
    }
    const turnId = readBoundedString(record["turnId"], 128);
    const renderedAt = readBoundedString(record["renderedAt"], 64);
    if (!turnId || !renderedAt || !Number.isFinite(Date.parse(renderedAt))) {
      return true;
    }
    const pending = this.pendingReplyRenders.get(clientId);
    if (!pending) {
      return true;
    }
    const sentAt = pending.get(turnId);
    if (sentAt === undefined) {
      return true;
    }
    pending.delete(turnId);
    if (pending.size === 0) {
      this.pendingReplyRenders.delete(clientId);
    }
    const receivedAtMs = Date.now();
    this.onReplyRendered?.(clientId, {
      turnId,
      renderedAt,
      receivedAt: new Date(receivedAtMs).toISOString(),
      latencyMs: Math.max(0, receivedAtMs - sentAt),
    });
    return true;
  }
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readReplyDoneTurnId(value: unknown): string | undefined {
  const record = readObject(value);
  if (record?.["type"] !== "reply_done") {
    return undefined;
  }
  return readBoundedString(record["turnId"], 128);
}

function readBoundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : undefined;
}
