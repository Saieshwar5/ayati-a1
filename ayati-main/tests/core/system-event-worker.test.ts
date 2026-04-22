import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AdapterRegistry } from "../../src/core/runtime/adapter-registry.js";
import { InboundQueueStore } from "../../src/core/runtime/inbound-queue-store.js";
import { SystemIngressService } from "../../src/core/runtime/system-ingress-service.js";
import { SystemEventWorker } from "../../src/core/runtime/system-event-worker.js";

let tempDir = "";

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "system-event-worker-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("SystemEventWorker", () => {
  it("processes queued events one by one in order", async () => {
    const queueStore = new InboundQueueStore({ dataDir: tempDir });
    queueStore.start();

    try {
      const ingress = new SystemIngressService({
        adapterRegistry: new AdapterRegistry(),
        queueStore,
      });

      await ingress.ingestInternalEvent("local", {
        source: "pulse",
        eventName: "reminder_due",
        eventId: "evt-1",
        receivedAt: "2026-04-21T06:30:00.000Z",
        summary: "First",
        payload: {},
      });
      await ingress.ingestInternalEvent("local", {
        source: "pulse",
        eventName: "reminder_due",
        eventId: "evt-2",
        receivedAt: "2026-04-21T06:31:00.000Z",
        summary: "Second",
        payload: {},
      });

      const processed: string[] = [];
      const worker = new SystemEventWorker({
        queueStore,
        pollIntervalMs: 20,
        processEvent: async (_clientId, event) => {
          processed.push(event.eventId);
        },
      });

      worker.start();
      await waitFor(() => processed.length === 2);
      await worker.stop();

      expect(processed).toEqual(["evt-1", "evt-2"]);
    } finally {
      queueStore.stop();
    }
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for condition.");
}
