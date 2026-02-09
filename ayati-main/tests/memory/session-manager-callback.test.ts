import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "../../src/memory/session-manager.js";
import type { SessionCloseData } from "../../src/memory/session-manager.js";

function createTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "sm-cb-test-"));
}

describe("SessionManager onSessionClose callback", () => {
  let tmpDir: string;
  let dataDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
    dataDir = join(tmpDir, "data");
    dbPath = join(tmpDir, "test.sqlite");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("fires callback on shutdown with enough turns", () => {
    const callback = vi.fn();
    let time = new Date("2025-01-01T00:00:00Z");

    const sm = new SessionManager({
      dataDir,
      dbPath,
      now: () => time,
      onSessionClose: callback,
    });

    sm.initialize("client1");

    const run1 = sm.beginRun("client1", "Hello");
    sm.recordAssistantFinal("client1", run1.runId, run1.sessionId, "Hi there!");

    const run2 = sm.beginRun("client1", "How are you?");
    sm.recordAssistantFinal("client1", run2.runId, run2.sessionId, "I'm good!");

    sm.shutdown();

    expect(callback).toHaveBeenCalledTimes(1);
    const data: SessionCloseData = callback.mock.calls[0]![0]!;
    expect(data.clientId).toBe("client1");
    expect(data.reason).toBe("shutdown");
    expect(data.turns.length).toBe(4);
  });

  it("fires callback on idle-timeout close (session expiry)", () => {
    const callback = vi.fn();
    let time = new Date("2025-01-01T00:00:00Z");

    const sm = new SessionManager({
      dataDir,
      dbPath,
      now: () => time,
      onSessionClose: callback,
    });

    sm.initialize("client1");

    sm.beginRun("client1", "Hello");

    time = new Date("2025-01-01T00:01:00Z");
    const run = sm.beginRun("client1", "More");
    sm.recordAssistantFinal("client1", run.runId, run.sessionId, "Reply");

    // Jump forward past idle timeout (rare tier = 180 min)
    time = new Date("2025-01-02T00:00:00Z");
    sm.beginRun("client1", "New session after idle");

    expect(callback).toHaveBeenCalledTimes(1);
    const data: SessionCloseData = callback.mock.calls[0]![0]!;
    expect(data.reason).toBe("expired");
    expect(data.turns.length).toBeGreaterThanOrEqual(2);

    sm.shutdown();
  });

  it("does not fire callback when fewer than 2 turns", () => {
    const callback = vi.fn();
    let time = new Date("2025-01-01T00:00:00Z");

    const sm = new SessionManager({
      dataDir,
      dbPath,
      now: () => time,
      onSessionClose: callback,
    });

    sm.initialize("client1");

    // Only 1 user message, no assistant reply → 1 turn total
    sm.beginRun("client1", "Hello");

    sm.shutdown();

    expect(callback).not.toHaveBeenCalled();
  });
});
