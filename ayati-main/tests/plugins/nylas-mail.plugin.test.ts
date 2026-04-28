import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntimeContext } from "../../src/core/contracts/plugin.js";
import { computeNylasSignature } from "../../src/plugins/nylas-mail/helpers.js";
import { NylasMailPlugin } from "../../src/plugins/nylas-mail/index.js";

async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((err) => {
        if (err) {
          rejectPort(err);
          return;
        }
        resolvePort(port);
      });
    });
  });
}

function createRuntimeContext(tempDir: string, ingestExternalRequest = vi.fn()): PluginRuntimeContext & {
  ingestExternalRequest: ReturnType<typeof vi.fn>;
} {
  return {
    clientId: "local",
    dataDir: tempDir,
    projectRoot: tempDir,
    publishSystemEvent: vi.fn(),
    emitSystemEvent: vi.fn(),
    registerSystemAdapter: vi.fn(),
    ingestExternalRequest,
  } as unknown as PluginRuntimeContext & {
    ingestExternalRequest: ReturnType<typeof vi.fn>;
  };
}

describe("NylasMailPlugin", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("returns the raw challenge response for webhook verification", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "ayati-nylas-plugin-"));
    tempDirs.push(tempDir);
    const port = await getFreePort();
    const plugin = new NylasMailPlugin({
      enabled: true,
      host: "127.0.0.1",
      port,
      webhookPath: "/webhooks/nylas-test",
      listenerPath: "/webhooks/nylas-test",
      verifySignature: false,
    });

    await plugin.start(createRuntimeContext(tempDir));
    try {
      const response = await fetch(`http://127.0.0.1:${port}/webhooks/nylas-test?challenge=abc123`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("abc123");
      expect(response.headers.get("content-length")).toBe("6");
    } finally {
      await plugin.stop();
    }
  });

  it("accepts valid signed webhook posts and forwards them to ingress with 200 OK", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "ayati-nylas-plugin-"));
    tempDirs.push(tempDir);
    const port = await getFreePort();
    const ingestExternalRequest = vi.fn().mockResolvedValue({
      accepted: false,
      source: "nylas-mail",
      queuedCount: 0,
      duplicateCount: 0,
      receipts: [],
      reason: "No events accepted.",
    });
    const plugin = new NylasMailPlugin({
      enabled: true,
      host: "127.0.0.1",
      port,
      webhookPath: "/webhooks/nylas-test",
      listenerPath: "/webhooks/nylas-test",
      webhookSecret: "secret",
      verifySignature: true,
    });

    await plugin.start(createRuntimeContext(tempDir, ingestExternalRequest));
    try {
      const payload = {
        deltas: [{
          id: "evt_123",
          type: "message.created",
          object_data: {
            id: "msg_123",
            grant_id: "grant_123",
            subject: "Need help",
            from: [{ email: "jane@example.com" }],
          },
        }],
      };
      const body = JSON.stringify(payload);
      const response = await fetch(`http://127.0.0.1:${port}/webhooks/nylas-test`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-nylas-signature": computeNylasSignature("secret", body),
        },
        body,
      });

      expect(response.status).toBe(200);
      expect(ingestExternalRequest).toHaveBeenCalledWith(expect.objectContaining({
        source: "nylas-mail",
        method: "POST",
        path: "/webhooks/nylas-test",
        body,
        payload,
      }));
      expect(await response.json()).toEqual({
        ok: true,
        accepted: false,
        queued: 0,
        duplicates: 0,
        reason: "No events accepted.",
      });
    } finally {
      await plugin.stop();
    }
  });

  it("rejects invalid signatures before ingress", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "ayati-nylas-plugin-"));
    tempDirs.push(tempDir);
    const port = await getFreePort();
    const ingestExternalRequest = vi.fn();
    const plugin = new NylasMailPlugin({
      enabled: true,
      host: "127.0.0.1",
      port,
      webhookPath: "/webhooks/nylas-test",
      listenerPath: "/webhooks/nylas-test",
      webhookSecret: "secret",
      verifySignature: true,
    });

    await plugin.start(createRuntimeContext(tempDir, ingestExternalRequest));
    try {
      const body = JSON.stringify({ deltas: [] });
      const response = await fetch(`http://127.0.0.1:${port}/webhooks/nylas-test`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-nylas-signature": "deadbeef",
        },
        body,
      });

      expect(response.status).toBe(401);
      expect(ingestExternalRequest).not.toHaveBeenCalled();
      expect(await response.json()).toEqual({
        ok: false,
        error: "Invalid webhook signature.",
      });
    } finally {
      await plugin.stop();
    }
  });
});
