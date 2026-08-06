import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, session } from "electron";
import { DaemonClient } from "./daemon-client.js";
import {
  desktopUrl,
  registerDesktopProtocol,
  registerDesktopScheme,
} from "./desktop-protocol.js";
import { registerDesktopIpc } from "./ipc-router.js";
import { WindowManager } from "./window-manager.js";

registerDesktopScheme();

if (process.platform === "linux" && process.env["WAYLAND_DISPLAY"]) {
  app.disableHardwareAcceleration();
}

const thisDirectory = dirname(fileURLToPath(import.meta.url));
const rendererRoot = resolve(thisDirectory, "..", "renderer");
const preloadPath = resolve(thisDirectory, "..", "preload", "index.cjs");
const trayIconPath = resolve(thisDirectory, "..", "assets", "tray.png");
const hasSingleInstanceLock = app.requestSingleInstanceLock();

let client: DaemonClient | null = null;
let windowManager: WindowManager | null = null;
let unregisterIpc: (() => void) | null = null;
let unsubscribeClient: (() => void) | null = null;

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => windowManager?.show());
  app.on("activate", () => windowManager?.show());
  app.on("before-quit", () => windowManager?.prepareToQuit());
  app.on("window-all-closed", () => {
    if (!windowManager?.hasTray() && process.platform !== "darwin") {
      app.quit();
    }
  });
  app.on("will-quit", () => {
    unsubscribeClient?.();
    unsubscribeClient = null;
    unregisterIpc?.();
    unregisterIpc = null;
    client?.stop();
    client = null;
    windowManager?.dispose();
    windowManager = null;
  });

  void startDesktop().catch((error: unknown) => {
    console.error("Ayati desktop failed to start:", error);
    app.exit(1);
  });
}

async function startDesktop(): Promise<void> {
  await app.whenReady();
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);
  await registerDesktopProtocol(rendererRoot);

  client = new DaemonClient({
    url: process.env["AYATI_DESKTOP_WS_URL"],
  });
  windowManager = new WindowManager({
    preloadPath,
    rendererUrl: desktopUrl(),
    trayIconPath,
    initialConnectionState: client.getConnectionState(),
  });
  unregisterIpc = registerDesktopIpc({
    client,
    getWindow: () => windowManager?.getWindow() ?? null,
  });
  unsubscribeClient = client.subscribe((event) => {
    if (event.type === "connection_state") {
      console.info(`[Ayati desktop] daemon ${event.state.status}.`);
    }
    windowManager?.sendEvent(event);
  });
  await windowManager.create();
  console.info("[Ayati desktop] renderer ready.");
  client.start();
}
