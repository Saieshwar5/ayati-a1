import { randomUUID } from "node:crypto";
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import {
  parseReplyRenderedInput,
  parseSendChatInput,
  type SendChatReceipt,
} from "../shared/contracts.js";
import { isTrustedDesktopUrl } from "./desktop-protocol.js";
import type { DaemonClient } from "./daemon-client.js";

export const DESKTOP_EVENT_CHANNEL = "ayati:desktop-event";
const GET_CONNECTION_STATE_CHANNEL = "ayati:get-connection-state";
const SEND_CHAT_CHANNEL = "ayati:send-chat";
const REPLY_RENDERED_CHANNEL = "ayati:reply-rendered";

export interface DesktopIpcOptions {
  client: DaemonClient;
  getWindow: () => BrowserWindow | null;
  now?: () => Date;
}

export function registerDesktopIpc(options: DesktopIpcOptions): () => void {
  const now = options.now ?? (() => new Date());
  ipcMain.handle(GET_CONNECTION_STATE_CHANNEL, (event) => {
    assertTrustedSender(event, options.getWindow());
    return options.client.getConnectionState();
  });
  ipcMain.handle(SEND_CHAT_CHANNEL, (event, value: unknown): SendChatReceipt => {
    assertTrustedSender(event, options.getWindow());
    const input = parseSendChatInput(value);
    if (!input) {
      throw new Error("Chat content must contain between 1 and 100000 characters.");
    }
    const messageId = randomUUID();
    const submittedAt = now().toISOString();
    options.client.sendChat(messageId, input.content);
    return { messageId, submittedAt };
  });
  ipcMain.handle(REPLY_RENDERED_CHANNEL, (event, value: unknown): void => {
    assertTrustedSender(event, options.getWindow());
    const input = parseReplyRenderedInput(value);
    if (!input) {
      throw new Error("Reply-rendered acknowledgement is invalid.");
    }
    options.client.acknowledgeReplyRendered(input.turnId, input.renderedAt);
  });

  return () => {
    ipcMain.removeHandler(GET_CONNECTION_STATE_CHANNEL);
    ipcMain.removeHandler(SEND_CHAT_CHANNEL);
    ipcMain.removeHandler(REPLY_RENDERED_CHANNEL);
  };
}

function assertTrustedSender(event: IpcMainInvokeEvent, window: BrowserWindow | null): void {
  const senderUrl = event.senderFrame?.url;
  if (
    !window
    || event.sender !== window.webContents
    || !senderUrl
    || !isTrustedDesktopUrl(senderUrl)
  ) {
    throw new Error("Rejected IPC from an untrusted renderer.");
  }
}
