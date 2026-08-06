import {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  Notification,
  Tray,
  type Event,
} from "electron";
import type {
  DaemonConnectionState,
  DaemonServerMessage,
  DesktopEvent,
} from "../shared/contracts.js";
import { isTrustedDesktopUrl } from "./desktop-protocol.js";

const MAX_NOTIFICATION_CHARS = 180;

export interface WindowManagerOptions {
  preloadPath: string;
  rendererUrl: string;
  trayIconPath: string;
  initialConnectionState: DaemonConnectionState;
}

export class WindowManager {
  private window: BrowserWindow | null = null;
  private tray: Tray | null = null;
  private quitting = false;
  private connectionState: DaemonConnectionState;

  constructor(private readonly options: WindowManagerOptions) {
    this.connectionState = options.initialConnectionState;
  }

  async create(): Promise<void> {
    if (this.window && !this.window.isDestroyed()) {
      this.show();
      return;
    }
    const window = new BrowserWindow({
      width: 1_120,
      height: 780,
      minWidth: 760,
      minHeight: 560,
      show: false,
      title: "Ayati",
      backgroundColor: "#0a0a0d",
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        devTools: !app.isPackaged,
      },
    });
    this.window = window;

    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, url) => {
      if (!isTrustedDesktopUrl(url)) {
        event.preventDefault();
      }
    });
    window.on("ready-to-show", () => window.show());
    window.on("close", (event) => this.handleWindowClose(event));
    window.on("closed", () => {
      if (this.window === window) this.window = null;
    });

    this.createTray();
    await window.loadURL(this.options.rendererUrl);
  }

  getWindow(): BrowserWindow | null {
    return this.window && !this.window.isDestroyed() ? this.window : null;
  }

  hasTray(): boolean {
    return this.tray !== null && !this.tray.isDestroyed();
  }

  show(): void {
    const window = this.getWindow();
    if (!window) {
      void this.create().catch((error: unknown) => {
        console.error("Could not recreate Ayati desktop window:", error);
      });
      return;
    }
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  sendEvent(event: DesktopEvent): void {
    const window = this.getWindow();
    if (window) {
      window.webContents.send("ayati:desktop-event", event);
    }
    if (event.type === "connection_state") {
      this.connectionState = event.state;
      this.refreshTrayMenu();
      return;
    }
    this.maybeNotify(event.message);
  }

  prepareToQuit(): void {
    this.quitting = true;
  }

  dispose(): void {
    this.quitting = true;
    if (this.tray && !this.tray.isDestroyed()) {
      this.tray.destroy();
    }
    this.tray = null;
  }

  private handleWindowClose(event: Event): void {
    if (!this.quitting && this.hasTray()) {
      event.preventDefault();
      this.window?.hide();
    }
  }

  private createTray(): void {
    if (this.hasTray()) return;
    try {
      const icon = nativeImage.createFromPath(this.options.trayIconPath);
      if (icon.isEmpty()) {
        throw new Error("The bundled tray icon could not be decoded.");
      }
      this.tray = new Tray(icon);
      this.tray.setToolTip("Ayati desktop");
      this.tray.on("click", () => this.show());
      this.refreshTrayMenu();
    } catch (error) {
      this.tray = null;
      console.warn("Ayati tray is unavailable; closing the window will quit the desktop client.", error);
    }
  }

  private refreshTrayMenu(): void {
    if (!this.tray || this.tray.isDestroyed()) return;
    const label = this.connectionState.status === "connected"
      ? "Daemon connected"
      : this.connectionState.status === "connecting"
        ? "Connecting to daemon…"
        : "Daemon disconnected";
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: "Open Ayati", click: () => this.show() },
      { label, enabled: false },
      { type: "separator" },
      {
        label: "Quit desktop",
        click: () => {
          this.prepareToQuit();
          app.quit();
        },
      },
    ]));
  }

  private maybeNotify(message: DaemonServerMessage): void {
    const window = this.getWindow();
    if (window?.isVisible() && window.isFocused()) return;
    const notification = notificationContent(message);
    if (!notification || !Notification.isSupported()) return;
    new Notification(notification).show();
  }
}

function notificationContent(
  message: DaemonServerMessage,
): { title: string; body: string } | undefined {
  if (message.type === "reply_done") {
    return {
      title: message.kind === "feedback" ? "Ayati needs your input" : "Ayati replied",
      body: truncate(message.content),
    };
  }
  if (
    message.type === "reply"
    || message.type === "feedback"
    || (message.type === "notification" && message.final === true)
    || message.type === "error"
  ) {
    return {
      title: message.type === "feedback"
        ? "Ayati needs your input"
        : message.type === "error"
          ? "Ayati error"
          : "Ayati",
      body: truncate(message.content),
    };
  }
  return undefined;
}

function truncate(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length <= MAX_NOTIFICATION_CHARS
    ? normalized
    : `${normalized.slice(0, MAX_NOTIFICATION_CHARS - 1)}…`;
}
