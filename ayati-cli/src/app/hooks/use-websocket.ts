import { useState, useEffect, useRef, useCallback } from "react";
import WebSocket from "ws";
import type { ChatRequestMessage, ServerMessage } from "../types.js";

const WS_URL = "ws://localhost:8080";

type UseWebSocketOptions = {
  onMessage: (data: ServerMessage | Record<string, unknown>) => void;
};

type UseWebSocketReturn = {
  send: (data: ChatRequestMessage) => void;
  connected: boolean;
};

export function useWebSocket({
  onMessage,
}: UseWebSocketOptions): UseWebSocketReturn {
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  useEffect(() => {
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.on("open", () => setConnected(true));

    ws.on("message", (raw) => {
      try {
        const parsed = JSON.parse(raw.toString()) as ServerMessage | Record<string, unknown>;
        onMessageRef.current(parsed);
      } catch {
        // ignore non-JSON messages
      }
    });

    ws.on("close", () => setConnected(false));
    ws.on("error", () => {
      // error fires before close; close handler updates state
    });

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, []);

  const send = useCallback((data: ChatRequestMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }, []);

  return { send, connected };
}
