import { once } from "node:events";
import { describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import {
  DaemonClient,
  resolveDaemonWebSocketUrl,
} from "../../src/main/daemon-client.js";
import type { DesktopEvent } from "../../src/shared/contracts.js";
import { canBindTcpSocket } from "../fixtures/runtime-capabilities.js";

describe("DaemonClient", () => {
  it.runIf(canBindTcpSocket())(
    "announces a streaming desktop client and exchanges the chat protocol",
    async () => {
      const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("WebSocket test server did not bind a TCP address.");
      }

      const received: unknown[] = [];
      let peer: WebSocket | null = null;
      server.on("connection", (socket) => {
        peer = socket;
        socket.on("message", (raw) => {
          received.push(JSON.parse(raw.toString()) as unknown);
        });
      });

      const events: DesktopEvent[] = [];
      const client = new DaemonClient({
        url: `ws://127.0.0.1:${address.port}`,
        initialRetryMs: 10,
        maxRetryMs: 10,
      });
      client.subscribe((event) => events.push(event));
      client.start();

      await waitFor(() => received.length >= 1);
      expect(received[0]).toEqual({
        type: "client_hello",
        clientKind: "desktop",
        capabilities: { replyStreaming: true },
      });
      expect(client.getConnectionState().status).toBe("connected");

      client.sendChat("message-1", "Hello from Electron.");
      await waitFor(() => received.length >= 2);
      expect(received[1]).toEqual({
        type: "chat",
        messageId: "message-1",
        content: "Hello from Electron.",
      });

      peer?.send(JSON.stringify({
        type: "reply_done",
        turnId: "turn-1",
        content: "Hello back.",
        commitStatus: "not_required",
      }));
      await waitFor(() => events.some((event) => (
        event.type === "server_message" && event.message.type === "reply_done"
      )));

      client.acknowledgeReplyRendered("turn-1", "2026-08-06T12:00:00.000Z");
      await waitFor(() => received.length >= 3);
      expect(received[2]).toEqual({
        type: "reply_rendered",
        turnId: "turn-1",
        renderedAt: "2026-08-06T12:00:00.000Z",
      });

      client.stop();
      await closeServer(server);
    },
  );

  it.runIf(canBindTcpSocket())(
    "reconnects after the daemon listener restarts",
    async () => {
      let server: WebSocketServer | null = new WebSocketServer({
        host: "127.0.0.1",
        port: 0,
      });
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("WebSocket test server did not bind a TCP address.");
      }

      const statuses: string[] = [];
      const client = new DaemonClient({
        url: `ws://127.0.0.1:${address.port}`,
        initialRetryMs: 10,
        maxRetryMs: 10,
      });
      client.subscribe((event) => {
        if (event.type === "connection_state") {
          statuses.push(event.state.status);
        }
      });

      try {
        client.start();
        await waitFor(() => statuses.includes("connected"));

        await closeServer(server);
        server = null;
        await waitFor(() => statuses.includes("disconnected"));

        server = new WebSocketServer({
          host: "127.0.0.1",
          port: address.port,
        });
        await once(server, "listening");
        await waitFor(() => statuses.filter((status) => status === "connected").length >= 2);

        expect(statuses).toContain("disconnected");
        expect(client.getConnectionState().status).toBe("connected");
      } finally {
        client.stop();
        if (server) {
          await closeServer(server);
        }
      }
    },
  );

  it("permits plaintext only for loopback daemon URLs", () => {
    expect(resolveDaemonWebSocketUrl()).toBe("ws://127.0.0.1:8080/");
    expect(resolveDaemonWebSocketUrl("ws://localhost:9000/chat")).toBe("ws://localhost:9000/chat");
    expect(resolveDaemonWebSocketUrl("wss://agent.example.test/ws")).toBe("wss://agent.example.test/ws");
    expect(() => resolveDaemonWebSocketUrl("ws://agent.example.test/ws")).toThrow(/loopback/);
    expect(() => resolveDaemonWebSocketUrl("http://127.0.0.1:8080")).toThrow(/ws:/);
    expect(() => resolveDaemonWebSocketUrl("ws://user:secret@127.0.0.1:8080")).toThrow(/credentials/);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for WebSocket test condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function closeServer(server: WebSocketServer): Promise<void> {
  for (const socket of server.clients) {
    socket.close();
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
