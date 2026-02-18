import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/memory/session-manager.js";

function createTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "sm-simple-test-"));
}

function runExchange(sm: SessionManager, clientId: string, user: string, assistant: string): string {
  const run = sm.beginRun(clientId, user);
  sm.recordAssistantFinal(clientId, run.runId, run.sessionId, assistant);
  return run.sessionId;
}

describe("MemoryManager event-window flow", () => {
  let tmpDir = "";

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = "";
    }
  });

  it("keeps the same session even after 20 countable events", () => {
    tmpDir = createTmpDir();
    const sm = new SessionManager({
      dataDir: tmpDir,
      dbPath: join(tmpDir, "memory.sqlite"),
      contextTokenLimit: 1,
    });
    sm.initialize("u1");

    let firstSessionId = "";
    for (let i = 0; i < 10; i++) {
      const sessionId = runExchange(sm, "u1", `user ${i}`, `assistant ${i}`);
      if (!firstSessionId) firstSessionId = sessionId;
      expect(sessionId).toBe(firstSessionId);
    }

    const next = sm.beginRun("u1", "new run after full window");
    expect(next.sessionId).toBe(firstSessionId);

    const prompt = sm.getPromptMemoryContext();
    expect(prompt.previousSessionSummary).toBe("");
    expect(prompt.conversationTurns.length).toBeLessThanOrEqual(20);
    sm.shutdown();
  });

  it("does not rotate by token limit alone", () => {
    tmpDir = createTmpDir();
    const sm = new SessionManager({
      dataDir: tmpDir,
      dbPath: join(tmpDir, "memory.sqlite"),
      contextTokenLimit: 1,
    });

    sm.initialize("u2");

    const first = sm.beginRun("u2", "hello");
    sm.recordAssistantFinal("u2", first.runId, first.sessionId, "x".repeat(4000));

    const second = sm.beginRun("u2", "next request");
    expect(second.sessionId).toBe(first.sessionId);
    sm.shutdown();
  });
});
