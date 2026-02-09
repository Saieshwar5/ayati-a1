import { WebSocketServer, WebSocket } from "ws";
import { devLog, devWarn, devError } from "../shared/index.js";

const DEFAULT_PORT = 8080;
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
const MAX_RETRIES = 10;

export interface WsServerOptions {
  port?: number;
  onMessage: (clientId: string, data: unknown) => void;
}

export class WsServer {
  private readonly port: number;
  private readonly onMessage: (clientId: string, data: unknown) => void;
  private wss: WebSocketServer | null = null;
  private clients = new Map<string, WebSocket>();
  private retryCount = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping = false;

  constructor(options: WsServerOptions) {
    this.port = options.port ?? DEFAULT_PORT;
    this.onMessage = options.onMessage;
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
        const clientId = "local";
        this.clients.set(clientId, ws);
        devLog(`Client connected: ${clientId}`);

        ws.on("message", (raw) => {
          const text = raw.toString();
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            devWarn(`Invalid JSON from ${clientId}: ${text}`);
            ws.send(JSON.stringify({ error: "Invalid JSON" }));
            return;
          }
          this.onMessage(clientId, parsed);
        });

        ws.on("close", () => {
          this.clients.delete(clientId);
          devLog(`Client disconnected: ${clientId}`);
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
    const ws = this.clients.get(clientId);
    if (!ws) {
      devWarn(`send(): unknown client ${clientId}`);
      return;
    }
    ws.send(JSON.stringify(data));
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
}
