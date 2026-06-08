import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { devLog, devWarn } from "../shared/index.js";
import type { WorkspaceOrchestrator } from "./workspace-orchestrator.js";

export type HyprlandEventSocketFactory = (path: string) => Socket;

export interface WorkspaceFocusWatcherOptions {
  clientId: string;
  orchestrator: WorkspaceOrchestrator;
  eventSocketPath?: string;
  hyprlandEnabled?: boolean;
  reconnectDelayMs?: number;
  socketFactory?: HyprlandEventSocketFactory;
}

export class WorkspaceFocusWatcher {
  private readonly clientId: string;
  private readonly orchestrator: WorkspaceOrchestrator;
  private readonly eventSocketPath: string | null;
  private readonly hyprlandEnabled: boolean;
  private readonly reconnectDelayMs: number;
  private readonly socketFactory: HyprlandEventSocketFactory;
  private socket: Socket | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private started = false;
  private buffer = "";
  private lastActiveAddress: string | undefined;
  private handlingFocusChange: Promise<void> = Promise.resolve();

  constructor(options: WorkspaceFocusWatcherOptions) {
    this.clientId = options.clientId;
    this.orchestrator = options.orchestrator;
    this.eventSocketPath = options.eventSocketPath ?? defaultHyprlandEventSocketPath();
    this.hyprlandEnabled = options.hyprlandEnabled ?? Boolean(process.env["HYPRLAND_INSTANCE_SIGNATURE"]);
    this.reconnectDelayMs = Math.max(250, options.reconnectDelayMs ?? 1500);
    this.socketFactory = options.socketFactory ?? ((path) => createConnection(path));
  }

  start(): void {
    if (this.started || !this.hyprlandEnabled || !this.eventSocketPath) {
      return;
    }
    this.started = true;
    this.connect();
  }

  stop(): void {
    this.started = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.socket?.removeAllListeners();
    this.socket?.destroy();
    this.socket = undefined;
    this.buffer = "";
  }

  private connect(): void {
    if (!this.started || !this.eventSocketPath) {
      return;
    }

    const socket = this.socketFactory(this.eventSocketPath);
    this.socket = socket;

    socket.on("connect", () => {
      devLog("Workspace focus watcher connected to Hyprland event socket.");
    });

    socket.on("data", (chunk) => {
      this.consume(chunk.toString("utf8"));
    });

    socket.on("error", (err) => {
      devWarn(`Workspace focus watcher socket error: ${err instanceof Error ? err.message : String(err)}`);
    });

    socket.on("close", () => {
      if (this.socket === socket) {
        this.socket = undefined;
      }
      if (this.started) {
        this.scheduleReconnect();
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.started) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, this.reconnectDelayMs);
    this.reconnectTimer.unref();
  }

  private consume(input: string): void {
    this.buffer += input;
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      this.handleEventLine(line);
      newlineIndex = this.buffer.indexOf("\n");
    }
  }

  private handleEventLine(line: string): void {
    const activeAddress = parseHyprlandActiveWindowAddress(line);
    if (!activeAddress || activeAddress === this.lastActiveAddress) {
      return;
    }

    this.lastActiveAddress = activeAddress;
    this.handlingFocusChange = this.handlingFocusChange
      .then(async () => {
        if (!this.started) {
          return;
        }
        await this.orchestrator.handleInteractionEvent({
          clientId: this.clientId,
          event: "visual_surface_focused",
          windowAddress: activeAddress,
        });
      })
      .catch((err: unknown) => {
        devWarn(`Workspace visual focus handling failed: ${err instanceof Error ? err.message : String(err)}`);
      });
  }
}

export function defaultHyprlandEventSocketPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const runtimeDir = env["XDG_RUNTIME_DIR"];
  const signature = env["HYPRLAND_INSTANCE_SIGNATURE"];
  if (!runtimeDir || !signature) {
    return null;
  }
  return join(runtimeDir, "hypr", signature, ".socket2.sock");
}

export function parseHyprlandActiveWindowAddress(line: string): string | null {
  const separatorIndex = line.indexOf(">>");
  if (separatorIndex < 0) {
    return null;
  }

  const eventName = line.slice(0, separatorIndex).trim();
  if (eventName !== "activewindowv2") {
    return null;
  }

  return normalizeHyprlandAddress(line.slice(separatorIndex + 2));
}

function normalizeHyprlandAddress(value: string): string | null {
  const address = value.trim();
  if (!address || address === "0" || address === "0x0") {
    return null;
  }
  if (address.startsWith("0x")) {
    return address.toLowerCase();
  }
  return /^[0-9a-f]+$/i.test(address) ? `0x${address.toLowerCase()}` : address;
}
