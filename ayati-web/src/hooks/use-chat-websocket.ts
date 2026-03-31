"use client";

import { useCallback, useEffect, useRef } from "react";
import { getChatWebSocketUrl } from "@/lib/chat/config";
import {
  parseServerMessage,
  type ChatRequestMessage,
  type ChatRequestAttachment,
} from "@/lib/chat/types";
import { useChatStore } from "@/stores/chat-store";

const RECONNECT_DELAY_MS = 2_000;
const DISCONNECTED_MESSAGE = "Ayati is disconnected right now. Reconnect to keep chatting.";

export function useChatWebSocket() {
  const socketRef = useRef<WebSocket | null>(null);

  const socketUrl = getChatWebSocketUrl();
  const addServerMessage = useChatStore((state) => state.addServerMessage);
  const addUserMessage = useChatStore((state) => state.addUserMessage);
  const clearError = useChatStore((state) => state.clearError);
  const markConnected = useChatStore((state) => state.markConnected);
  const markConnecting = useChatStore((state) => state.markConnecting);
  const markDisconnected = useChatStore((state) => state.markDisconnected);

  useEffect(() => {
    let reconnectTimerId: number | null = null;
    let active = true;

    const clearReconnectTimer = () => {
      if (reconnectTimerId !== null) {
        window.clearTimeout(reconnectTimerId);
        reconnectTimerId = null;
      }
    };

    const connect = () => {
      clearReconnectTimer();
      markConnecting();

      const socket = new WebSocket(socketUrl);
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        clearReconnectTimer();
        markConnected();
      });

      socket.addEventListener("message", (event) => {
        try {
          const parsed = JSON.parse(event.data) as unknown;
          const message = parseServerMessage(parsed);
          if (message) {
            addServerMessage(message);
          }
        } catch {
          // Ignore non-JSON payloads.
        }
      });

      socket.addEventListener("close", () => {
        if (socketRef.current === socket) {
          socketRef.current = null;
        }

        markDisconnected();

        if (active) {
          reconnectTimerId = window.setTimeout(() => {
            connect();
          }, RECONNECT_DELAY_MS);
        }
      });

      socket.addEventListener("error", () => {
        // The close handler owns state updates and reconnect behavior.
      });
    };

    connect();

    return () => {
      active = false;
      clearReconnectTimer();
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [addServerMessage, markConnected, markConnecting, markDisconnected, socketUrl]);

  const sendMessage = useCallback((content: string, attachments: ChatRequestAttachment[] = []): boolean => {
    const trimmed = content.trim();
    if (!trimmed) {
      return false;
    }

    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      markDisconnected(DISCONNECTED_MESSAGE);
      return false;
    }

    const payload: ChatRequestMessage = {
      type: "chat",
      content: trimmed,
      ...(attachments.length > 0 ? { attachments } : {}),
    };

    clearError();
    addUserMessage(trimmed, attachments.map((attachment) =>
      attachment.source === "web" ? attachment.originalName : (attachment.name ?? attachment.path)
    ));
    socket.send(JSON.stringify(payload));
    return true;
  }, [addUserMessage, clearError, markDisconnected]);

  return {
    sendMessage,
    socketUrl,
  };
}
