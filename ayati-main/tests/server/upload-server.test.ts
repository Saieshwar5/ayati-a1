import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import WebSocket from "ws";
import { UploadServer, WsServer } from "../../src/server/index.js";
import { IVecEngine } from "../../src/ivec/index.js";
import { DocumentStore } from "../../src/documents/document-store.js";
import { DocumentContextBackend } from "../../src/documents/document-context-backend.js";
import { pulseTool } from "../../src/skills/builtins/pulse/index.js";
import type { LlmProvider } from "../../src/core/contracts/provider.js";
import type { LlmTurnInput } from "../../src/core/contracts/llm-protocol.js";

let nextPort = 9200;

function getPort(): number {
  return nextPort++;
}

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "ayati-upload-server-"));
}

function uploadUrl(port: number): string {
  return `http://127.0.0.1:${port}/api/uploads`;
}

function pulseUrl(port: number): string {
  return `http://127.0.0.1:${port}/api/pulse`;
}

function websocketUrl(port: number): string {
  return `ws://127.0.0.1:${port}`;
}

async function postFile(port: number, name: string, body: string, type = "text/plain"): Promise<Response> {
  const formData = new FormData();
  formData.set("file", new Blob([body], { type }), name);
  return fetch(uploadUrl(port), {
    method: "POST",
    body: formData,
  });
}

async function postPulse(port: number, body: unknown, token?: string): Promise<Response> {
  return fetch(pulseUrl(port), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function connectClient(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(websocketUrl(port));
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

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

function messageContentToText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (!part || typeof part !== "object") {
        return "";
      }
      const value = part as Record<string, unknown>;
      if (value["type"] === "text") {
        return String(value["text"] ?? "");
      }
      if (value["type"] === "image") {
        return `[image:${String(value["mimeType"] ?? "")}]`;
      }
      return "";
    })
    .join("\n");
}

describe("UploadServer", () => {
  it("saves multipart uploads and returns saved-file metadata", async () => {
    const dataDir = makeTmpDir();
    const port = getPort();
    const server = new UploadServer({
      uploadsDir: join(dataDir, "documents", "uploads"),
      host: "127.0.0.1",
      port,
    });

    try {
      await server.start();
      const response = await postFile(port, "policy.txt", "Policy body.");
      const payload = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(201);
      expect(payload["uploadId"]).toEqual(expect.any(String));
      expect(payload["originalName"]).toBe("policy.txt");
      expect(payload["mimeType"]).toBe("text/plain");
      expect(payload["sizeBytes"]).toBe(Buffer.byteLength("Policy body."));
      expect(typeof payload["uploadedPath"]).toBe("string");
      expect(existsSync(String(payload["uploadedPath"]))).toBe(true);
      expect(readFileSync(String(payload["uploadedPath"]), "utf-8")).toBe("Policy body.");
    } finally {
      await server.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("handles pulse create, list, update, and delete over HTTP", async () => {
    const dataDir = makeTmpDir();
    const port = getPort();
    const previousPathEnv = process.env["PULSE_STORE_FILE_PATH"];
    const previousTzEnv = process.env["PULSE_TIMEZONE"];
    process.env["PULSE_STORE_FILE_PATH"] = join(dataDir, "pulse", "reminders.json");
    process.env["PULSE_TIMEZONE"] = "UTC";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T12:00:00.000Z"));

    const server = new UploadServer({
      uploadsDir: join(dataDir, "documents", "uploads"),
      host: "127.0.0.1",
      port,
      pulseTool,
      pulseClientId: "local",
    });

    try {
      await server.start();

      const create = await postPulse(port, {
        action: "create",
        instruction: "Check system health",
        every: "every one hour",
        timezone: "UTC",
      });
      const createPayload = await create.json() as Record<string, unknown>;
      const createdData = createPayload["data"] as Record<string, unknown>;
      const createdItem = createdData["item"] as Record<string, unknown>;
      const itemId = String(createdItem["id"]);

      expect(create.status).toBe(201);
      expect(createPayload["ok"]).toBe(true);
      expect(createdItem["nextDueAt"]).toBe("2026-03-01T13:00:00.000Z");

      const listBefore = await postPulse(port, { action: "list", status: "active" });
      const listBeforePayload = await listBefore.json() as Record<string, unknown>;
      expect(listBefore.status).toBe(200);
      expect((listBeforePayload["data"] as Record<string, unknown>)["total"]).toBe(1);

      const update = await postPulse(port, {
        action: "update",
        id: itemId,
        instruction: "Check system health deeply",
        every: "every two hours",
        timezone: "UTC",
      });
      const updatePayload = await update.json() as Record<string, unknown>;
      const updatedItem = ((updatePayload["data"] as Record<string, unknown>)["item"] as Record<string, unknown>);
      expect(update.status).toBe(200);
      expect(updatedItem["instruction"]).toBe("Check system health deeply");
      expect(updatedItem["nextDueAt"]).toBe("2026-03-01T14:00:00.000Z");

      const deleted = await postPulse(port, { action: "delete", id: itemId });
      expect(deleted.status).toBe(200);
      expect((await deleted.json() as Record<string, unknown>)["ok"]).toBe(true);

      const listAfter = await postPulse(port, { action: "list", status: "active" });
      const listAfterPayload = await listAfter.json() as Record<string, unknown>;
      expect((listAfterPayload["data"] as Record<string, unknown>)["total"]).toBe(0);
    } finally {
      await server.stop();
      vi.useRealTimers();
      if (previousPathEnv === undefined) {
        delete process.env["PULSE_STORE_FILE_PATH"];
      } else {
        process.env["PULSE_STORE_FILE_PATH"] = previousPathEnv;
      }
      if (previousTzEnv === undefined) {
        delete process.env["PULSE_TIMEZONE"];
      } else {
        process.env["PULSE_TIMEZONE"] = previousTzEnv;
      }
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("protects pulse HTTP commands with bearer auth when configured", async () => {
    const dataDir = makeTmpDir();
    const port = getPort();
    const previousPathEnv = process.env["PULSE_STORE_FILE_PATH"];
    process.env["PULSE_STORE_FILE_PATH"] = join(dataDir, "pulse", "reminders.json");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T12:00:00.000Z"));

    const server = new UploadServer({
      uploadsDir: join(dataDir, "documents", "uploads"),
      host: "127.0.0.1",
      port,
      pulseTool,
      pulseClientId: "local",
      pulseApiToken: "secret-token",
    });

    try {
      await server.start();

      const missing = await postPulse(port, { action: "now", timezone: "UTC" });
      expect(missing.status).toBe(401);

      const invalid = await postPulse(port, { action: "now", timezone: "UTC" }, "wrong-token");
      expect(invalid.status).toBe(403);

      const valid = await postPulse(port, { action: "now", timezone: "UTC" }, "secret-token");
      const validPayload = await valid.json() as Record<string, unknown>;
      const snapshot = ((validPayload["data"] as Record<string, unknown>)["snapshot"] as Record<string, unknown>);
      expect(valid.status).toBe(200);
      expect(validPayload["ok"]).toBe(true);
      expect(snapshot["nowUtc"]).toBe("2026-03-01T12:00:00.000Z");
    } finally {
      await server.stop();
      vi.useRealTimers();
      if (previousPathEnv === undefined) {
        delete process.env["PULSE_STORE_FILE_PATH"];
      } else {
        process.env["PULSE_STORE_FILE_PATH"] = previousPathEnv;
      }
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid pulse HTTP requests", async () => {
    const dataDir = makeTmpDir();
    const port = getPort();
    const server = new UploadServer({
      uploadsDir: join(dataDir, "documents", "uploads"),
      host: "127.0.0.1",
      port,
      pulseTool,
      pulseClientId: "local",
    });

    try {
      await server.start();

      const getResponse = await fetch(pulseUrl(port));
      expect(getResponse.status).toBe(405);

      const invalidJson = await fetch(pulseUrl(port), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      });
      expect(invalidJson.status).toBe(400);

      const unsupportedType = await fetch(pulseUrl(port), {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "plain",
      });
      expect(unsupportedType.status).toBe(415);
    } finally {
      await server.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("rejects unsupported uploads", async () => {
    const dataDir = makeTmpDir();
    const port = getPort();
    const server = new UploadServer({
      uploadsDir: join(dataDir, "documents", "uploads"),
      host: "127.0.0.1",
      port,
    });

    try {
      await server.start();
      const response = await postFile(port, "payload.bin", "binary-ish", "application/octet-stream");
      const payload = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(415);
      expect(payload["error"]).toBe("unsupported file type.");
    } finally {
      await server.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("rejects empty uploads", async () => {
    const dataDir = makeTmpDir();
    const port = getPort();
    const server = new UploadServer({
      uploadsDir: join(dataDir, "documents", "uploads"),
      host: "127.0.0.1",
      port,
    });

    try {
      await server.start();
      const response = await postFile(port, "policy.txt", "", "text/plain");
      const payload = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(400);
      expect(payload["error"]).toBe("uploaded file is empty.");
    } finally {
      await server.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("uploads over HTTP and makes the saved document visible to the agent over WebSocket chat", async () => {
    const dataDir = makeTmpDir();
    const wsPort = getPort();
    const uploadPort = getPort();
    const documentStore = new DocumentStore({
      dataDir: join(dataDir, "documents"),
      preferCli: false,
    });
    const documentContextBackend = new DocumentContextBackend({ store: documentStore });
      const provider: LlmProvider = {
        name: "mock",
        version: "1.0.0",
        capabilities: { nativeToolCalling: true },
        start: vi.fn(),
        stop: vi.fn(),
        generateTurn: vi.fn().mockImplementation(async (input: LlmTurnInput) => {
          const prompt = input.messages.map((message) => messageContentToText(message.content)).join("\n");
          expect(prompt).toContain("Prepared attachments available (1)");
          expect(prompt).toContain("policy.txt");
          return {
            type: "assistant",
            content: JSON.stringify({
              done: true,
              summary: "I can see the attached policy document.",
              status: "completed",
            }),
          };
        }),
    };

    let wsServer: WsServer | null = null;
    let uploadServer: UploadServer | null = null;
    let engine: IVecEngine | null = null;
    let client: WebSocket | null = null;

    try {
      engine = new IVecEngine({
        onReply: (clientId, data) => wsServer?.send(clientId, data),
        provider,
        dataDir,
        documentStore,
        documentContextBackend,
      });
      wsServer = new WsServer({
        port: wsPort,
        onMessage: (clientId, data) => engine?.handleMessage(clientId, data),
      });
      uploadServer = new UploadServer({
        uploadsDir: documentStore.uploadsDir,
        host: "127.0.0.1",
        port: uploadPort,
      });

      await engine.start();
      await wsServer.start();
      await uploadServer.start();

      const uploadResponse = await postFile(uploadPort, "policy.txt", "Termination requires 30 days written notice.");
      const uploadPayload = await uploadResponse.json() as Record<string, unknown>;
      expect(uploadResponse.status).toBe(201);

      client = await connectClient(wsPort);
      const connectedClient = client;
      const replyPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
        connectedClient.on("message", (raw) => {
          const parsed = JSON.parse(raw.toString()) as Record<string, unknown>;
          if (parsed["type"] === "reply") {
            resolve(parsed);
          }
        });
        connectedClient.on("error", reject);
      });

      connectedClient.send(JSON.stringify({
        type: "chat",
        content: "Can you see the attachment?",
        attachments: [
          {
            source: "web",
            uploadedPath: String(uploadPayload["uploadedPath"]),
            originalName: String(uploadPayload["originalName"]),
            mimeType: typeof uploadPayload["mimeType"] === "string" ? uploadPayload["mimeType"] : undefined,
            sizeBytes: Number(uploadPayload["sizeBytes"]),
          },
        ],
      }));

      const response = await replyPromise;
      expect(response).toEqual({
        type: "reply",
        content: "I can see the attached policy document.",
      });
      expect(provider.generateTurn).toHaveBeenCalled();
    } finally {
      if (client) {
        await closeClient(client);
      }
      if (uploadServer) {
        await uploadServer.stop();
      }
      if (wsServer) {
        await wsServer.stop();
      }
      if (engine) {
        await engine.stop();
      }
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("uploads an image over HTTP and passes it into the agent as multimodal input", async () => {
    const dataDir = makeTmpDir();
    const wsPort = getPort();
    const uploadPort = getPort();
    const documentStore = new DocumentStore({
      dataDir: join(dataDir, "documents"),
      preferCli: false,
    });
    const documentContextBackend = new DocumentContextBackend({ store: documentStore });
    const provider: LlmProvider = {
      name: "mock",
      version: "1.0.0",
      capabilities: { nativeToolCalling: true, imageInput: true },
      start: vi.fn(),
      stop: vi.fn(),
      generateTurn: vi.fn().mockImplementation(async (input: LlmTurnInput) => {
        const userMessage = input.messages.find((message) => message.role === "user");
        expect(Array.isArray(userMessage?.content)).toBe(true);
        expect(userMessage?.content).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: "text" }),
            expect.objectContaining({ type: "image", mimeType: "image/png" }),
          ]),
        );
        return {
          type: "assistant",
          content: JSON.stringify({
            done: true,
            summary: "I can see the attached image.",
            status: "completed",
          }),
        };
      }),
    };

    let wsServer: WsServer | null = null;
    let uploadServer: UploadServer | null = null;
    let engine: IVecEngine | null = null;
    let client: WebSocket | null = null;

    try {
      engine = new IVecEngine({
        onReply: (clientId, data) => wsServer?.send(clientId, data),
        provider,
        dataDir,
        documentStore,
        documentContextBackend,
      });
      wsServer = new WsServer({
        port: wsPort,
        onMessage: (clientId, data) => engine?.handleMessage(clientId, data),
      });
      uploadServer = new UploadServer({
        uploadsDir: documentStore.uploadsDir,
        host: "127.0.0.1",
        port: uploadPort,
      });

      await engine.start();
      await wsServer.start();
      await uploadServer.start();

      const uploadResponse = await postFile(uploadPort, "photo.png", "png-binary-ish", "image/png");
      const uploadPayload = await uploadResponse.json() as Record<string, unknown>;
      expect(uploadResponse.status).toBe(201);

      client = await connectClient(wsPort);
      const connectedClient = client;
      const replyPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
        connectedClient.on("message", (raw) => {
          const parsed = JSON.parse(raw.toString()) as Record<string, unknown>;
          if (parsed["type"] === "reply") {
            resolve(parsed);
          }
        });
        connectedClient.on("error", reject);
      });

      connectedClient.send(JSON.stringify({
        type: "chat",
        content: "What is in this image?",
        attachments: [
          {
            source: "web",
            uploadedPath: String(uploadPayload["uploadedPath"]),
            originalName: String(uploadPayload["originalName"]),
            mimeType: typeof uploadPayload["mimeType"] === "string" ? uploadPayload["mimeType"] : undefined,
            sizeBytes: Number(uploadPayload["sizeBytes"]),
          },
        ],
      }));

      const response = await replyPromise;
      expect(response).toEqual({
        type: "reply",
        content: "I can see the attached image.",
      });
      expect(provider.generateTurn).toHaveBeenCalled();
    } finally {
      if (client) {
        await closeClient(client);
      }
      if (uploadServer) {
        await uploadServer.stop();
      }
      if (wsServer) {
        await wsServer.stop();
      }
      if (engine) {
        await engine.stop();
      }
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
