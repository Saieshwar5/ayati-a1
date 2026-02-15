import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { SubsessionStore } from "../../src/ivec/max-mode/subsession-store.js";

describe("SubsessionStore", () => {
  let rootDir = "";
  let store: SubsessionStore;

  beforeEach(async () => {
    rootDir = await mkdtemp(resolve(tmpdir(), "ayati-subsession-store-"));
    store = new SubsessionStore({ rootDir });
    await store.ensureRoot();
  });

  afterEach(async () => {
    if (rootDir) {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("creates subsession directory and core files", async () => {
    const snapshot = await store.createSubsession({
      clientId: "c1",
      parentSessionId: "s1",
      parentRunId: "r1",
      goalSummary: "Build feature",
      maxAttemptsPerTask: 3,
      maxTotalSteps: 60,
      maxNoProgressCycles: 2,
    });

    expect(snapshot.meta.id).toBeTruthy();

    const loaded = await store.loadSubsession(snapshot.meta.id);
    expect(loaded).not.toBeNull();
    expect(loaded?.meta.clientId).toBe("c1");
    expect(loaded?.state.maxTotalSteps).toBe(60);
  });

  it("supports global active lock lifecycle", async () => {
    const one = await store.createSubsession({
      clientId: "c1",
      parentSessionId: "s1",
      parentRunId: "r1",
      goalSummary: "Task one",
      maxAttemptsPerTask: 3,
      maxTotalSteps: 60,
      maxNoProgressCycles: 2,
    });
    const two = await store.createSubsession({
      clientId: "c1",
      parentSessionId: "s1",
      parentRunId: "r2",
      goalSummary: "Task two",
      maxAttemptsPerTask: 3,
      maxTotalSteps: 60,
      maxNoProgressCycles: 2,
    });

    const acquired = await store.acquireActiveLock(one.meta.id);
    expect(acquired.ok).toBe(true);

    const blocked = await store.acquireActiveLock(two.meta.id);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.activeId).toBe(one.meta.id);
    }

    await store.releaseActiveLock(one.meta.id);
    const retry = await store.acquireActiveLock(two.meta.id);
    expect(retry.ok).toBe(true);
  });

  it("writes progress and log events as ndjson", async () => {
    const snapshot = await store.createSubsession({
      clientId: "c1",
      parentSessionId: "s1",
      parentRunId: "r1",
      goalSummary: "Track logs",
      maxAttemptsPerTask: 3,
      maxTotalSteps: 60,
      maxNoProgressCycles: 2,
    });

    await store.appendProgress(snapshot.meta.id, {
      ts: "2026-02-14T00:00:00.000Z",
      subsessionId: snapshot.meta.id,
      type: "subsession_started",
      message: "Started",
    });

    await store.appendLog(snapshot.meta.id, {
      ts: "2026-02-14T00:00:01.000Z",
      subsessionId: snapshot.meta.id,
      event: "state_write",
      details: { step: 1 },
    });

    const progressPath = resolve(rootDir, snapshot.meta.id, "progress.ndjson");
    const logPath = resolve(rootDir, snapshot.meta.id, "subsession.log.ndjson");

    const progressContent = await readFile(progressPath, "utf8");
    const logContent = await readFile(logPath, "utf8");

    expect(progressContent).toContain("\"type\":\"subsession_started\"");
    expect(logContent).toContain("\"event\":\"state_write\"");
  });
});

