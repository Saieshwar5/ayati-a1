import { describe, it, expect, vi, afterEach } from "vitest";
import { WsServer } from "../../src/server/index.js";
import WebSocket from "ws";

let server: WsServer | null = null;

/** Returns a free-ish port to avoid conflicts between tests. */
let nextPort = 9100;
function getPort(): number {
  return nextPort++;
}

/** Helper: open a client and wait for the connection to be established. */
function connectClient(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

/** Helper: close a client cleanly. */
function closeClient(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    ws.on("close", () => resolve());
    ws.close();
  });
}

afterEach(async () => {
  if (server) {
    await server.stop();
    server = null;
  }
});

describe("WsServer", () => {
  it("should start and listen on the given port", async () => {
    const port = getPort();
    const onMessage = vi.fn();
    server = new WsServer({ port, onMessage });

    await server.start();

    // Verify we can connect
    const client = await connectClient(port);
    expect(client.readyState).toBe(WebSocket.OPEN);
    await closeClient(client);
  });

  it("should accept multiple client connections", async () => {
    const port = getPort();
    const onMessage = vi.fn();
    server = new WsServer({ port, onMessage });
    await server.start();

    const client1 = await connectClient(port);
    const client2 = await connectClient(port);

    expect(client1.readyState).toBe(WebSocket.OPEN);
    expect(client2.readyState).toBe(WebSocket.OPEN);

    await closeClient(client1);
    await closeClient(client2);
  });

  it("should parse JSON messages and forward to the onMessage callback", async () => {
    const port = getPort();
    const onMessage = vi.fn();
    server = new WsServer({ port, onMessage });
    await server.start();

    const client = await connectClient(port);

    // Send a message and wait for it to be processed
    const messageReceived = new Promise<void>((resolve) => {
      onMessage.mockImplementation(() => resolve());
    });

    client.send(JSON.stringify({ type: "greeting", text: "hello engine" }));
    await messageReceived;

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(
      expect.any(String), // clientId (UUID)
      { type: "greeting", text: "hello engine" },
    );

    await closeClient(client);
  });

  it("should reject invalid JSON and send an error back to the client", async () => {
    const port = getPort();
    const onMessage = vi.fn();
    server = new WsServer({ port, onMessage });
    await server.start();

    const client = await connectClient(port);

    const errorReceived = new Promise<string>((resolve) => {
      client.on("message", (raw) => resolve(raw.toString()));
    });

    client.send("not valid json");
    const response = await errorReceived;

    expect(JSON.parse(response)).toEqual({ error: "Invalid JSON" });
    expect(onMessage).not.toHaveBeenCalled();

    await closeClient(client);
  });

  it("should stop gracefully and close all connected clients", async () => {
    const port = getPort();
    const onMessage = vi.fn();
    server = new WsServer({ port, onMessage });
    await server.start();

    const client = await connectClient(port);

    const clientClosed = new Promise<void>((resolve) => {
      client.on("close", () => resolve());
    });

    await server.stop();
    server = null; // Already stopped

    await clientClosed;
    expect(client.readyState).toBe(WebSocket.CLOSED);
  });

  it("should reject start() when the port is already in use", async () => {
    const port = getPort();
    const onMessage = vi.fn();

    // Start first server to occupy the port
    server = new WsServer({ port, onMessage });
    await server.start();

    // Try starting a second server on the same port
    const server2 = new WsServer({ port, onMessage });
    await expect(server2.start()).rejects.toThrow();

    // Clean up: stop the retry timer
    await server2.stop();
  });

  it("should send data back to a specific client via send()", async () => {
    const port = getPort();
    let capturedClientId = "";
    const onMessage = vi.fn((clientId: string) => {
      capturedClientId = clientId;
    });
    server = new WsServer({ port, onMessage });
    await server.start();

    const client = await connectClient(port);

    // Send a message so we can capture the clientId
    const messageReceived = new Promise<void>((resolve) => {
      onMessage.mockImplementation((clientId: string) => {
        capturedClientId = clientId;
        resolve();
      });
    });

    client.send(JSON.stringify({ type: "chat", content: "hello" }));
    await messageReceived;

    // Now use server.send() to push data back to that client
    const replyReceived = new Promise<string>((resolve) => {
      client.on("message", (raw) => resolve(raw.toString()));
    });

    server.send(capturedClientId, { type: "reply", content: "echo" });
    const reply = await replyReceived;

    expect(JSON.parse(reply)).toEqual({ type: "reply", content: "echo" });

    await closeClient(client);
  });

  it("should assign a unique clientId per connection", async () => {
    const port = getPort();
    const clientIds: string[] = [];
    const onMessage = vi.fn((clientId: string) => {
      clientIds.push(clientId);
    });
    server = new WsServer({ port, onMessage });
    await server.start();

    const client1 = await connectClient(port);
    const client2 = await connectClient(port);

    const msg1 = new Promise<void>((r) => {
      onMessage.mockImplementationOnce((id: string) => {
        clientIds.push(id);
        r();
      });
    });
    client1.send(JSON.stringify({ msg: "a" }));
    await msg1;

    const msg2 = new Promise<void>((r) => {
      onMessage.mockImplementationOnce((id: string) => {
        clientIds.push(id);
        r();
      });
    });
    client2.send(JSON.stringify({ msg: "b" }));
    await msg2;

    // Two different UUIDs
    expect(clientIds.length).toBe(2);
    expect(clientIds[0]).not.toBe(clientIds[1]);

    await closeClient(client1);
    await closeClient(client2);
  });
});
