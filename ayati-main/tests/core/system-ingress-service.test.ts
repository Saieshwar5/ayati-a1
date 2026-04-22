import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AdapterRegistry } from "../../src/core/runtime/adapter-registry.js";
import { InboundQueueStore } from "../../src/core/runtime/inbound-queue-store.js";
import { SystemIngressService } from "../../src/core/runtime/system-ingress-service.js";
import type { ExternalSystemRequest, SourceManifest, SystemAdapter } from "../../src/core/contracts/system-ingress.js";

let tempDir = "";

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "system-ingress-service-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function makeExternalAdapter(): SystemAdapter {
  return {
    manifest(): SourceManifest {
      return {
        sourceId: "demo-webhook",
        displayName: "Demo Webhook",
        sourceType: "external",
        transport: "webhook",
        authMode: "none",
        defaultEnabled: true,
        supportsRawPersistence: true,
      };
    },
    canHandle(input: ExternalSystemRequest): boolean {
      return input.source === "demo-webhook";
    },
    normalize(input: ExternalSystemRequest) {
      return [{
        source: "demo-webhook",
        eventName: "thing.created",
        eventId: String((input.payload as Record<string, unknown>)["eventId"]),
        receivedAt: "2026-04-21T08:00:00.000Z",
        summary: "Thing created",
        payload: input.payload as Record<string, unknown>,
        intent: {
          kind: "notification",
          eventClass: "state_changed",
          trustTier: "trusted_system",
          effectLevel: "observe",
          createdBy: "system",
          requestedAction: "review_thing",
        },
      }];
    },
  };
}

describe("SystemIngressService", () => {
  it("queues internal events and uses occurrence ids for dedupe when present", async () => {
    const adapterRegistry = new AdapterRegistry();
    const queueStore = new InboundQueueStore({ dataDir: tempDir });
    queueStore.start();

    try {
      const service = new SystemIngressService({ adapterRegistry, queueStore });
      const first = await service.ingestInternalEvent("local", {
        source: "pulse",
        eventName: "reminder_due",
        eventId: "evt-1",
        receivedAt: "2026-04-21T06:30:00.000Z",
        summary: "Morning reminder",
        payload: {
          occurrenceId: "rem_1:2026-04-21T06:30:00.000Z",
        },
      });
      const second = await service.ingestInternalEvent("local", {
        source: "pulse",
        eventName: "reminder_due",
        eventId: "evt-2",
        receivedAt: "2026-04-21T06:30:10.000Z",
        summary: "Morning reminder duplicate",
        payload: {
          occurrenceId: "rem_1:2026-04-21T06:30:00.000Z",
        },
      });

      expect(first.queued).toBe(true);
      expect(first.dedupeKey).toBe("pulse:occurrence:rem_1:2026-04-21T06:30:00.000Z");
      expect(second.queued).toBe(false);
    } finally {
      queueStore.stop();
    }
  });

  it("normalizes external requests through adapters and deduplicates repeated deliveries", async () => {
    const adapterRegistry = new AdapterRegistry();
    adapterRegistry.register(makeExternalAdapter());
    const queueStore = new InboundQueueStore({ dataDir: tempDir });
    queueStore.start();

    try {
      const service = new SystemIngressService({ adapterRegistry, queueStore });
      const request: ExternalSystemRequest = {
        source: "demo-webhook",
        clientId: "local",
        body: JSON.stringify({ eventId: "evt-demo-1" }),
        payload: { eventId: "evt-demo-1" },
      };

      const first = await service.ingestExternalRequest(request);
      const second = await service.ingestExternalRequest(request);

      expect(first).toEqual(expect.objectContaining({
        accepted: true,
        queuedCount: 1,
        duplicateCount: 0,
      }));
      expect(second).toEqual(expect.objectContaining({
        accepted: true,
        queuedCount: 0,
        duplicateCount: 1,
      }));
      expect(first.receipts[0]?.event.source).toBe("demo-webhook");
    } finally {
      queueStore.stop();
    }
  });
});
