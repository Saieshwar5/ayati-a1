import { contextBridge, ipcRenderer } from "electron";
import type {
  AyatiDesktopApi,
  DaemonConnectionState,
  DesktopEvent,
  ReplyRenderedInput,
  SendChatInput,
  SendChatReceipt,
} from "../shared/contracts.js";

const DESKTOP_EVENT_CHANNEL = "ayati:desktop-event";
const GET_CONNECTION_STATE_CHANNEL = "ayati:get-connection-state";
const SEND_CHAT_CHANNEL = "ayati:send-chat";
const REPLY_RENDERED_CHANNEL = "ayati:reply-rendered";
const MAX_PENDING_EVENTS = 100;
const eventListeners = new Set<(event: DesktopEvent) => void>();
const pendingEvents: DesktopEvent[] = [];

ipcRenderer.on(DESKTOP_EVENT_CHANNEL, (_event, value: unknown): void => {
  if (!isDesktopEvent(value)) return;
  if (eventListeners.size === 0) {
    pendingEvents.push(value);
    if (pendingEvents.length > MAX_PENDING_EVENTS) {
      pendingEvents.shift();
    }
    return;
  }
  for (const listener of eventListeners) {
    notifyListener(listener, value);
  }
});

const api: AyatiDesktopApi = Object.freeze({
  getConnectionState: async (): Promise<DaemonConnectionState> => (
    await ipcRenderer.invoke(GET_CONNECTION_STATE_CHANNEL) as DaemonConnectionState
  ),
  sendChat: async (input: SendChatInput): Promise<SendChatReceipt> => (
    await ipcRenderer.invoke(SEND_CHAT_CHANNEL, input) as SendChatReceipt
  ),
  acknowledgeReplyRendered: async (input: ReplyRenderedInput): Promise<void> => {
    await ipcRenderer.invoke(REPLY_RENDERED_CHANNEL, input);
  },
  onEvent: (listener: (event: DesktopEvent) => void): (() => void) => {
    eventListeners.add(listener);
    const bufferedEvents = pendingEvents.splice(0);
    for (const event of bufferedEvents) {
      notifyListener(listener, event);
    }
    return () => {
      eventListeners.delete(listener);
    };
  },
});

contextBridge.exposeInMainWorld("ayati", api);

function isDesktopEvent(value: unknown): value is DesktopEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (record["type"] === "connection_state" && isRecord(record["state"]))
    || (record["type"] === "server_message" && isRecord(record["message"]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function notifyListener(listener: (event: DesktopEvent) => void, event: DesktopEvent): void {
  try {
    listener(event);
  } catch (error) {
    console.error("Ayati desktop renderer event listener failed:", error);
  }
}
