import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/memory/session-manager.js";
import type { LlmProvider } from "../../src/core/contracts/provider.js";

function createTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "sm-drift-test-"));
}

function createProviderMock(responses: string[]): LlmProvider {
  const generateTurn = vi.fn(async () => {
    const next = responses.shift();
    if (!next) {
      return {
        type: "assistant" as const,
        content: JSON.stringify({
          is_drift: false,
          confidence: 0.6,
          reason: "default",
        }),
      };
    }
    return {
      type: "assistant" as const,
      content: next,
    };
  });

  return {
    name: "mock-memory",
    version: "1",
    capabilities: { nativeToolCalling: false },
    start: vi.fn(),
    stop: vi.fn(),
    generateTurn,
  };
}

function runExchange(sm: SessionManager, clientId: string, user: string, assistant: string): string {
  const run = sm.beginRun(clientId, user);
  sm.recordAssistantFinal(clientId, run.runId, run.sessionId, assistant);
  return run.sessionId;
}

describe("SessionManager drift checkpoints", () => {
  let tmpDir = "";

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = "";
    }
  });

  it("bootstraps topic profile at first checkpoint and enriches metadata at second checkpoint", async () => {
    tmpDir = createTmpDir();
    const provider = createProviderMock([
      JSON.stringify({
        title: "project planning",
        scope: "planning app features",
        keywords: ["planning", "feature", "roadmap"],
        anchors: ["roadmap"],
        topic_confidence: 0.8,
      }),
      JSON.stringify({
        is_drift: false,
        confidence: 0.86,
        reason: "same topic",
        updated_profile: {
          title: "project planning",
          scope: "planning app features and rollout",
          keywords: ["planning", "feature", "rollout"],
          anchors: ["roadmap", "release"],
          subtopics: ["release prep"],
          active_goals: ["define milestone"],
          constraints: ["keep cost low"],
          stable_entities: ["roadmap doc"],
          decision_log: ["ship v1 first"],
          open_loops: ["qa timeline"],
          topic_confidence: 0.87,
        },
      }),
    ]);

    const sm = new SessionManager({
      dataDir: tmpDir,
      dbPath: join(tmpDir, "memory.sqlite"),
      provider,
    });

    sm.initialize("u1");

    let firstSessionId = "";
    for (let i = 0; i < 10; i++) {
      firstSessionId = runExchange(sm, "u1", `plan step ${i}`, `ack ${i}`);
    }
    await sm.flushBackgroundTasks();

    const afterTen = sm.getPromptMemoryContext();
    expect(afterTen.activeTopicLabel).toBe("project planning");

    for (let i = 10; i < 20; i++) {
      const sid = runExchange(sm, "u1", `plan rollout ${i}`, `ack ${i}`);
      expect(sid).toBe(firstSessionId);
    }
    await sm.flushBackgroundTasks();

    const afterTwenty = sm.getPromptMemoryContext();
    expect(afterTwenty.activeTopicLabel).toBe("project planning");

    sm.shutdown();
  });

  it("creates a new session when checkpoint drift decision is positive", async () => {
    tmpDir = createTmpDir();
    const provider = createProviderMock([
      JSON.stringify({
        title: "typescript bugfixes",
        scope: "debugging code issue",
        keywords: ["typescript", "bug", "fix"],
        anchors: ["src/memory/session-manager.ts"],
        topic_confidence: 0.9,
      }),
      JSON.stringify({
        is_drift: true,
        confidence: 0.95,
        reason: "conversation moved to travel planning",
      }),
    ]);

    const sm = new SessionManager({
      dataDir: tmpDir,
      dbPath: join(tmpDir, "memory.sqlite"),
      provider,
    });

    sm.initialize("u2");

    let oldSessionId = "";
    for (let i = 0; i < 20; i++) {
      oldSessionId = runExchange(
        sm,
        "u2",
        i < 10 ? `debug issue ${i}` : `new topic trip idea ${i}`,
        `reply ${i}`,
      );
    }

    await sm.flushBackgroundTasks();

    const nextRun = sm.beginRun("u2", "continue new topic");
    expect(nextRun.sessionId).not.toBe(oldSessionId);
    expect(sm.getPromptMemoryContext().previousSessionSummary.length).toBeGreaterThan(0);

    sm.shutdown();
  });

  it("rotates session when context token limit is reached", () => {
    tmpDir = createTmpDir();
    const sm = new SessionManager({
      dataDir: tmpDir,
      dbPath: join(tmpDir, "memory.sqlite"),
      contextTokenLimit: 40,
    });

    sm.initialize("u3");

    const first = sm.beginRun("u3", "hello");
    sm.recordAssistantFinal("u3", first.runId, first.sessionId, "x".repeat(400));

    const second = sm.beginRun("u3", "next request");
    expect(second.sessionId).not.toBe(first.sessionId);
    sm.shutdown();
  });
});
