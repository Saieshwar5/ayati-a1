import { useState, useEffect, useRef, useCallback } from "react";
import WebSocket from "ws";

const WS_URL = "ws://localhost:8080";

type UseWebSocketOptions = {
  onMessage: (data: unknown) => void;
};

type UseWebSocketReturn = {
  send: (data: unknown) => void;
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
        const parsed: unknown = JSON.parse(raw.toString());
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

  const send = useCallback((data: unknown) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }, []);

  return { send, connected };
}
