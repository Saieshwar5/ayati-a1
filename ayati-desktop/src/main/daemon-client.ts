import WebSocket, { type RawData } from "ws";
import {
  parseDaemonServerMessage,
  type DaemonConnectionState,
  type DesktopEvent,
} from "../shared/contracts.js";

const DEFAULT_DAEMON_URL = "ws://127.0.0.1:8080";
const INITIAL_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;
const CONNECTION_TIMEOUT_MS = 10_000;
const MAX_SERVER_MESSAGE_BYTES = 4 * 1024 * 1024;

export interface DaemonClientOptions {
  url?: string;
  initialRetryMs?: number;
  maxRetryMs?: number;
  now?: () => Date;
}

export class DaemonClient {
  private readonly url: string;
  private readonly initialRetryMs: number;
  private readonly maxRetryMs: number;
  private readonly now: () => Date;
  private readonly listeners = new Set<(event: DesktopEvent) => void>();
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private stopped = true;
  private connectionState: DaemonConnectionState;

  constructor(options: DaemonClientOptions = {}) {
    this.url = resolveDaemonWebSocketUrl(options.url);
    this.initialRetryMs = positiveInteger(options.initialRetryMs) ?? INITIAL_RETRY_MS;
    this.maxRetryMs = Math.max(
      this.initialRetryMs,
      positiveInteger(options.maxRetryMs) ?? MAX_RETRY_MS,
    );
    this.now = options.now ?? (() => new Date());
    this.connectionState = {
      status: "disconnected",
      changedAt: this.now().toISOString(),
      detail: "Desktop connection has not started.",
    };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.reconnectAttempt = 0;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < WebSocket.CLOSING) {
      socket.close(1000, "Ayati desktop is stopping");
    }
    this.updateConnectionState({
      status: "disconnected",
      changedAt: this.now().toISOString(),
      detail: "Desktop connection stopped.",
    });
  }

  subscribe(listener: (event: DesktopEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getConnectionState(): DaemonConnectionState {
    return { ...this.connectionState };
  }

  sendChat(messageId: string, content: string): void {
    this.send({
      type: "chat",
      messageId,
      content,
    });
  }

  acknowledgeReplyRendered(turnId: string, renderedAt: string): void {
    this.send({
      type: "reply_rendered",
      turnId,
      renderedAt,
    });
  }

  private connect(): void {
    if (this.stopped) return;
    this.updateConnectionState({
      status: "connecting",
      changedAt: this.now().toISOString(),
      detail: "Connecting to the Ayati daemon…",
    });

    const socket = new WebSocket(this.url, {
      handshakeTimeout: CONNECTION_TIMEOUT_MS,
      maxPayload: MAX_SERVER_MESSAGE_BYTES,
      perMessageDeflate: false,
    });
    this.socket = socket;
    let latestError: string | undefined;

    socket.once("open", () => {
      if (this.socket !== socket || this.stopped) {
        socket.close();
        return;
      }
      this.reconnectAttempt = 0;
      this.updateConnectionState({
        status: "connected",
        changedAt: this.now().toISOString(),
        detail: "Connected to the Ayati daemon.",
      });
      socket.send(JSON.stringify({
        type: "client_hello",
        clientKind: "desktop",
        capabilities: {
          replyStreaming: true,
        },
      }));
    });

    socket.on("message", (data) => this.handleMessage(data));
    socket.once("error", (error) => {
      latestError = error.message;
    });
    socket.once("close", () => {
      if (this.socket === socket) {
        this.socket = null;
      }
      if (this.stopped) return;
      this.scheduleReconnect(latestError);
    });
  }

  private handleMessage(data: RawData): void {
    const bytes = toBuffer(data);
    if (bytes.byteLength > MAX_SERVER_MESSAGE_BYTES) {
      console.warn("Ignored oversized Ayati daemon message.");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    } catch {
      console.warn("Ignored non-JSON Ayati daemon message.");
      return;
    }
    const message = parseDaemonServerMessage(parsed);
    if (!message) {
      console.warn("Ignored unsupported Ayati daemon message.");
      return;
    }
    this.emit({ type: "server_message", message });
  }

  private scheduleReconnect(errorMessage?: string): void {
    const retryInMs = Math.min(
      this.initialRetryMs * 2 ** this.reconnectAttempt,
      this.maxRetryMs,
    );
    this.reconnectAttempt += 1;
    this.updateConnectionState({
      status: "disconnected",
      changedAt: this.now().toISOString(),
      detail: errorMessage
        ? `Daemon connection failed: ${errorMessage}`
        : "Daemon connection closed.",
      retryInMs,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, retryInMs);
  }

  private send(value: unknown): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Ayati daemon is not connected.");
    }
    socket.send(JSON.stringify(value));
  }

  private updateConnectionState(state: DaemonConnectionState): void {
    this.connectionState = state;
    this.emit({ type: "connection_state", state: { ...state } });
  }

  private emit(event: DesktopEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("Ayati desktop event listener failed:", error);
      }
    }
  }
}

export function resolveDaemonWebSocketUrl(configured?: string): string {
  const raw = configured?.trim() || DEFAULT_DAEMON_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("AYATI_DESKTOP_WS_URL must be a valid WebSocket URL.");
  }
  if (url.username || url.password) {
    throw new Error("AYATI_DESKTOP_WS_URL must not contain credentials.");
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("AYATI_DESKTOP_WS_URL must use ws: or wss:.");
  }
  if (url.protocol === "ws:" && !isLoopbackHostname(url.hostname)) {
    throw new Error("Unencrypted Ayati desktop WebSockets must use a loopback host.");
  }
  return url.toString();
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function positiveInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function toBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return data;
}
