import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ContextEngineObservabilityEvent } from "../src/observability.js";
import {
  startContextEngineHost,
  type ContextEngineHost,
} from "../src/runtime.js";
import { ContextEngineWriterLock } from "../src/writer-lock.js";

describe("Context Engine writer ownership", () => {
  it("allows only one live database writer and releases its durable lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "ayati-context-engine-lock-"));
    const databasePath = join(root, "context.sqlite");
    const lockPath = databasePath + ".writer-lock";
    const lock = await ContextEngineWriterLock.acquire({ path: lockPath, databasePath });

    await expect(access(join(lockPath, "owner.json"))).resolves.toBeUndefined();
    await expect(ContextEngineWriterLock.acquire({ path: lockPath, databasePath }))
      .rejects.toThrow(/live writer/);

    await lock.release();
    await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("in-process Context Engine host", () => {
  const hosts: ContextEngineHost[] = [];

  afterEach(async () => {
    await Promise.all(hosts.splice(0).map(async (host) => await host.stop()));
  });

  it("owns the database writer lock and exposes the service directly", async () => {
    const root = await mkdtemp(join(tmpdir(), "ayati-context-engine-runtime-"));
    const databasePath = join(root, "store", "context.sqlite");
    const events: ContextEngineObservabilityEvent[] = [];
    const host = await startContextEngineHost({
      databasePath,
      rootDirectory: root,
      observabilitySink: (event) => events.push(event),
    });
    hosts.push(host);

    await expect(host.service.getHealth()).resolves.toMatchObject({
      service: "ayati-context-engine",
      ready: true,
    });
    await expect(access(databasePath + ".writer-lock/owner.json")).resolves.toBeUndefined();
    expect(events.every((event) => event.pid === process.pid)).toBe(true);

    await expect(startContextEngineHost({
      databasePath,
      rootDirectory: root,
    })).rejects.toThrow(/live writer/);

    await host.stop();
    hosts.splice(hosts.indexOf(host), 1);
    await expect(access(databasePath + ".writer-lock")).rejects.toMatchObject({ code: "ENOENT" });
    expect(events.map((event) => event.event)).toEqual(expect.arrayContaining([
      "engine_starting",
      "writer_lock_acquired",
      "startup_recovery_completed",
      "engine_ready",
      "shutdown_completed",
    ]));
  });

  it("reopens the same version-6 catalog after a full daemon-style restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "ayati-context-engine-restart-"));
    const databasePath = join(root, "store", "context.sqlite");
    const first = await startContextEngineHost({ databasePath, rootDirectory: root });
    hosts.push(first);
    await first.stop();
    hosts.splice(hosts.indexOf(first), 1);

    const restarted = await startContextEngineHost({ databasePath, rootDirectory: root });
    hosts.push(restarted);

    await expect(restarted.service.getHealth()).resolves.toMatchObject({
      service: "ayati-context-engine",
      ready: true,
      capabilities: expect.arrayContaining(["agent_streams", "recovery", "workstreams"]),
    });
  });
});
