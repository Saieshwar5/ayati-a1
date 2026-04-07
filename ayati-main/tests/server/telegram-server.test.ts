import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramServer, loadTelegramRuntimeConfig } from "../../src/server/telegram-server.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "ayati-telegram-server-"));
}

function okJson(value: unknown): Response {
  return new Response(JSON.stringify({ ok: true, ...value }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function abortablePending(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise<Response>((_, reject) => {
    if (!signal) {
      return;
    }

    signal.addEventListener("abort", () => {
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

async function waitFor(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  while (!check()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("loadTelegramRuntimeConfig", () => {
  it("returns null when Telegram is not configured", () => {
    expect(loadTelegramRuntimeConfig({})).toBeNull();
  });

  it("parses enabled Telegram config from env", () => {
    const config = loadTelegramRuntimeConfig({
      AYATI_TELEGRAM_BOT_TOKEN: "bot-token",
      AYATI_TELEGRAM_ALLOWED_CHAT_ID: "123456",
      AYATI_TELEGRAM_POLL_INTERVAL_MS: "250",
    });

    expect(config).toMatchObject({
      botToken: "bot-token",
      allowedChatId: "123456",
      clientId: "telegram-shared",
      pollIntervalMs: 250,
    });
  });

  it("throws when enabled without the required chat allowlist", () => {
    expect(() => loadTelegramRuntimeConfig({
      AYATI_TELEGRAM_ENABLED: "true",
      AYATI_TELEGRAM_BOT_TOKEN: "bot-token",
    })).toThrow("AYATI_TELEGRAM_ALLOWED_CHAT_ID");
  });
});

describe("TelegramServer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("polls Telegram, saves a document, and forwards the normalized chat payload", async () => {
    const dataDir = makeTmpDir();
    const onMessage = vi.fn();
    let getUpdatesCalls = 0;

    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/getUpdates")) {
        getUpdatesCalls++;
        if (getUpdatesCalls === 1) {
          return okJson({
            result: [
              {
                update_id: 42,
                message: {
                  chat: { id: "123456" },
                  caption: "Summarize this file",
                  document: {
                    file_id: "file-1",
                    file_name: "policy.txt",
                    mime_type: "text/plain",
                    file_size: 12,
                  },
                },
              },
            ],
          });
        }

        return abortablePending(init?.signal);
      }

      if (url.endsWith("/getFile")) {
        return okJson({
          result: {
            file_path: "documents/policy.txt",
          },
        });
      }

      if (url.includes("/file/bot")) {
        return new Response("Policy body.", {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        });
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    }) as typeof fetch;

    const server = new TelegramServer({
      botToken: "bot-token",
      allowedChatId: "123456",
      apiBaseUrl: "https://api.telegram.org",
      fileBaseUrl: "https://api.telegram.org",
      clientId: "telegram-shared",
      pollTimeoutSeconds: 1,
      pollIntervalMs: 50,
      maxFileBytes: 1_024,
      defaultDocumentPrompt: "Please analyze this document.",
      sendMessageMaxChars: 4_000,
      uploadsDir: join(dataDir, "documents", "uploads"),
      stateDir: join(dataDir, "state"),
      onMessage,
      fetchImpl,
    });

    try {
      await server.start();
      await waitFor(() => onMessage.mock.calls.length === 1);

      expect(onMessage).toHaveBeenCalledWith("telegram-shared", {
        type: "chat",
        content: "Summarize this file",
        attachments: [
          expect.objectContaining({
            source: "web",
            originalName: "policy.txt",
            mimeType: "text/plain",
            sizeBytes: Buffer.byteLength("Policy body."),
          }),
        ],
      });

      const attachment = onMessage.mock.calls[0]?.[1] as {
        attachments: Array<{ uploadedPath: string }>;
      };
      expect(existsSync(attachment.attachments[0]?.uploadedPath ?? "")).toBe(true);
      expect(readFileSync(join(dataDir, "state", "telegram-offset.json"), "utf-8")).toContain("\"nextUpdateId\": 43");
    } finally {
      await server.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("polls Telegram photo messages, picks the largest variant, and forwards them as image attachments", async () => {
    const dataDir = makeTmpDir();
    const onMessage = vi.fn();
    let getUpdatesCalls = 0;
    const requestedFileIds: string[] = [];

    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/getUpdates")) {
        getUpdatesCalls++;
        if (getUpdatesCalls === 1) {
          return okJson({
            result: [
              {
                update_id: 52,
                message: {
                  chat: { id: "123456" },
                  caption: "What is in this image?",
                  photo: [
                    {
                      file_id: "photo-small",
                      file_size: 100,
                      width: 90,
                      height: 90,
                    },
                    {
                      file_id: "photo-large",
                      file_size: 400,
                      width: 400,
                      height: 400,
                    },
                  ],
                },
              },
            ],
          });
        }

        return abortablePending(init?.signal);
      }

      if (url.endsWith("/getFile")) {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) as { file_id?: string } : {};
        requestedFileIds.push(body.file_id ?? "");
        return okJson({
          result: {
            file_path: "photos/telegram-image.jpg",
          },
        });
      }

      if (url.includes("/file/bot")) {
        return new Response("jpeg-bytes", {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        });
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    }) as typeof fetch;

    const server = new TelegramServer({
      botToken: "bot-token",
      allowedChatId: "123456",
      apiBaseUrl: "https://api.telegram.org",
      fileBaseUrl: "https://api.telegram.org",
      clientId: "telegram-shared",
      pollTimeoutSeconds: 1,
      pollIntervalMs: 50,
      maxFileBytes: 1_024,
      defaultDocumentPrompt: "Please analyze this document.",
      sendMessageMaxChars: 4_000,
      uploadsDir: join(dataDir, "documents", "uploads"),
      stateDir: join(dataDir, "state"),
      onMessage,
      fetchImpl,
    });

    try {
      await server.start();
      await waitFor(() => onMessage.mock.calls.length === 1);

      expect(requestedFileIds).toEqual(["photo-large"]);
      expect(onMessage).toHaveBeenCalledWith("telegram-shared", {
        type: "chat",
        content: "What is in this image?",
        attachments: [
          expect.objectContaining({
            source: "web",
            originalName: "telegram-photo-photo-large.jpg",
            mimeType: "image/jpeg",
            sizeBytes: Buffer.byteLength("jpeg-bytes"),
          }),
        ],
      });

      const attachment = onMessage.mock.calls[0]?.[1] as {
        attachments: Array<{ uploadedPath: string }>;
      };
      expect(existsSync(attachment.attachments[0]?.uploadedPath ?? "")).toBe(true);
    } finally {
      await server.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("uses the default prompt when a Telegram photo has no caption", async () => {
    const dataDir = makeTmpDir();
    const onMessage = vi.fn();
    let getUpdatesCalls = 0;

    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/getUpdates")) {
        getUpdatesCalls++;
        if (getUpdatesCalls === 1) {
          return okJson({
            result: [
              {
                update_id: 61,
                message: {
                  chat: { id: "123456" },
                  photo: [
                    {
                      file_id: "photo-no-caption",
                      width: 200,
                      height: 200,
                    },
                  ],
                },
              },
            ],
          });
        }

        return abortablePending(init?.signal);
      }

      if (url.endsWith("/getFile")) {
        return okJson({
          result: {
            file_path: "photos/no-caption.png",
          },
        });
      }

      if (url.includes("/file/bot")) {
        return new Response("png-bytes", {
          status: 200,
          headers: { "Content-Type": "image/png" },
        });
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    }) as typeof fetch;

    const server = new TelegramServer({
      botToken: "bot-token",
      allowedChatId: "123456",
      apiBaseUrl: "https://api.telegram.org",
      fileBaseUrl: "https://api.telegram.org",
      clientId: "telegram-shared",
      pollTimeoutSeconds: 1,
      pollIntervalMs: 50,
      maxFileBytes: 1_024,
      defaultDocumentPrompt: "Please analyze this document.",
      sendMessageMaxChars: 4_000,
      uploadsDir: join(dataDir, "documents", "uploads"),
      stateDir: join(dataDir, "state"),
      onMessage,
      fetchImpl,
    });

    try {
      await server.start();
      await waitFor(() => onMessage.mock.calls.length === 1);

      expect(onMessage).toHaveBeenCalledWith("telegram-shared", {
        type: "chat",
        content: "Please analyze this document.",
        attachments: [
          expect.objectContaining({
            source: "web",
            originalName: "telegram-photo-photo-no-caption.png",
            mimeType: "image/png",
          }),
        ],
      });
    } finally {
      await server.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("resumes polling from the persisted update offset after restart", async () => {
    const dataDir = makeTmpDir();
    const firstOnMessage = vi.fn();
    let firstGetUpdatesCalls = 0;

    const firstFetch: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/getUpdates")) {
        firstGetUpdatesCalls++;
        if (firstGetUpdatesCalls === 1) {
          return okJson({
            result: [
              {
                update_id: 7,
                message: {
                  chat: { id: "123456" },
                  text: "hello from telegram",
                },
              },
            ],
          });
        }

        return abortablePending(init?.signal);
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    }) as typeof fetch;

    const firstServer = new TelegramServer({
      botToken: "bot-token",
      allowedChatId: "123456",
      apiBaseUrl: "https://api.telegram.org",
      fileBaseUrl: "https://api.telegram.org",
      clientId: "telegram-shared",
      pollTimeoutSeconds: 1,
      pollIntervalMs: 50,
      maxFileBytes: 1_024,
      defaultDocumentPrompt: "Please analyze this document.",
      sendMessageMaxChars: 4_000,
      uploadsDir: join(dataDir, "documents", "uploads"),
      stateDir: join(dataDir, "state"),
      onMessage: firstOnMessage,
      fetchImpl: firstFetch,
    });

    try {
      await firstServer.start();
      await waitFor(() => firstOnMessage.mock.calls.length === 1);
      await firstServer.stop();

      const offsets: number[] = [];
      const secondFetch: typeof fetch = vi.fn(async (input, init) => {
        const url = String(input);
        if (url.endsWith("/getUpdates")) {
          const body = typeof init?.body === "string" ? JSON.parse(init.body) as { offset?: number } : {};
          offsets.push(body.offset ?? -1);
          return abortablePending(init?.signal);
        }

        throw new Error(`Unexpected fetch URL: ${url}`);
      }) as typeof fetch;

      const secondServer = new TelegramServer({
        botToken: "bot-token",
        allowedChatId: "123456",
        apiBaseUrl: "https://api.telegram.org",
        fileBaseUrl: "https://api.telegram.org",
        clientId: "telegram-shared",
        pollTimeoutSeconds: 1,
        pollIntervalMs: 50,
        maxFileBytes: 1_024,
        defaultDocumentPrompt: "Please analyze this document.",
        sendMessageMaxChars: 4_000,
        uploadsDir: join(dataDir, "documents", "uploads"),
        stateDir: join(dataDir, "state"),
        onMessage: vi.fn(),
        fetchImpl: secondFetch,
      });

      try {
        await secondServer.start();
        await waitFor(() => offsets.length > 0);
        expect(offsets[0]).toBe(8);
      } finally {
        await secondServer.stop();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("ignores messages from chats outside the configured allowlist", async () => {
    const dataDir = makeTmpDir();
    const onMessage = vi.fn();
    let getUpdatesCalls = 0;

    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/getUpdates")) {
        getUpdatesCalls++;
        if (getUpdatesCalls === 1) {
          return okJson({
            result: [
              {
                update_id: 12,
                message: {
                  chat: { id: "999999" },
                  text: "should be ignored",
                },
              },
            ],
          });
        }

        return abortablePending(init?.signal);
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    }) as typeof fetch;

    const server = new TelegramServer({
      botToken: "bot-token",
      allowedChatId: "123456",
      apiBaseUrl: "https://api.telegram.org",
      fileBaseUrl: "https://api.telegram.org",
      clientId: "telegram-shared",
      pollTimeoutSeconds: 1,
      pollIntervalMs: 50,
      maxFileBytes: 1_024,
      defaultDocumentPrompt: "Please analyze this document.",
      sendMessageMaxChars: 4_000,
      uploadsDir: join(dataDir, "documents", "uploads"),
      stateDir: join(dataDir, "state"),
      onMessage,
      fetchImpl,
    });

    try {
      await server.start();
      await waitFor(() => existsSync(join(dataDir, "state", "telegram-offset.json")));
      expect(onMessage).not.toHaveBeenCalled();
    } finally {
      await server.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("sends user-facing errors when a Telegram document cannot be processed", async () => {
    const dataDir = makeTmpDir();
    const onMessage = vi.fn();
    const sentMessages: string[] = [];
    let getUpdatesCalls = 0;

    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/getUpdates")) {
        getUpdatesCalls++;
        if (getUpdatesCalls === 1) {
          return okJson({
            result: [
              {
                update_id: 19,
                message: {
                  chat: { id: "123456" },
                  document: {
                    file_id: "file-2",
                    file_name: "payload.bin",
                    mime_type: "application/octet-stream",
                    file_size: 5,
                  },
                },
              },
            ],
          });
        }

        return abortablePending(init?.signal);
      }

      if (url.endsWith("/getFile")) {
        return okJson({
          result: {
            file_path: "documents/payload.bin",
          },
        });
      }

      if (url.includes("/file/bot")) {
        return new Response("abcde", { status: 200 });
      }

      if (url.endsWith("/sendMessage")) {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) as { text?: string } : {};
        sentMessages.push(body.text ?? "");
        return okJson({ result: { message_id: 1 } });
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    }) as typeof fetch;

    const server = new TelegramServer({
      botToken: "bot-token",
      allowedChatId: "123456",
      apiBaseUrl: "https://api.telegram.org",
      fileBaseUrl: "https://api.telegram.org",
      clientId: "telegram-shared",
      pollTimeoutSeconds: 1,
      pollIntervalMs: 50,
      maxFileBytes: 1_024,
      defaultDocumentPrompt: "Please analyze this document.",
      sendMessageMaxChars: 4_000,
      uploadsDir: join(dataDir, "documents", "uploads"),
      stateDir: join(dataDir, "state"),
      onMessage,
      fetchImpl,
    });

    try {
      await server.start();
      await waitFor(() => sentMessages.length === 1);
      expect(onMessage).not.toHaveBeenCalled();
      expect(sentMessages[0]).toContain("unsupported file type.");
    } finally {
      await server.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("splits long replies and appends the artifact-delivery note", async () => {
    const sentMessages: string[] = [];
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (!url.endsWith("/sendMessage")) {
        throw new Error(`Unexpected fetch URL: ${url}`);
      }

      const body = typeof init?.body === "string" ? JSON.parse(init.body) as { text?: string } : {};
      sentMessages.push(body.text ?? "");
      return okJson({ result: { message_id: sentMessages.length } });
    }) as typeof fetch;

    const dataDir = makeTmpDir();
    const server = new TelegramServer({
      botToken: "bot-token",
      allowedChatId: "123456",
      apiBaseUrl: "https://api.telegram.org",
      fileBaseUrl: "https://api.telegram.org",
      clientId: "telegram-shared",
      pollTimeoutSeconds: 1,
      pollIntervalMs: 50,
      maxFileBytes: 1_024,
      defaultDocumentPrompt: "Please analyze this document.",
      sendMessageMaxChars: 60,
      uploadsDir: join(dataDir, "documents", "uploads"),
      stateDir: join(dataDir, "state"),
      onMessage: vi.fn(),
      fetchImpl,
    });

    try {
      server.send("telegram-shared", {
        type: "reply",
        content: "A".repeat(100),
        artifacts: [{ kind: "image", name: "chart.png" }],
      });

      await waitFor(() => sentMessages.length >= 2);
      expect(sentMessages.join(" ")).toContain("Telegram artifact delivery is not supported yet.");
      expect(sentMessages.every((message) => message.length <= 60)).toBe(true);
    } finally {
      await server.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
