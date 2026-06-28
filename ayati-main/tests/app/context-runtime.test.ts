import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAppContextRuntime,
  createContextEngineRuntime,
} from "../../src/app/context-runtime.js";
import type { AyatiRuntimeConfig } from "../../src/config/runtime-config.js";

describe("createContextEngineRuntime", () => {
  it("creates a context engine runtime by default", () => {
    const storeDir = mkdtempSync(join(tmpdir(), "ayati-context-runtime-"));
    try {
      const runtime = createContextEngineRuntime({
        config: createConfig({ storeDir }),
      });

      expect(runtime).toBeDefined();
      expect(typeof runtime.prepareUserTurn).toBe("function");
      expect(typeof runtime.completePreparedRun).toBe("function");
      expect(typeof runtime.recordAssistantMessage).toBe("function");
    } finally {
      rmSync(storeDir, { recursive: true, force: true });
    }
  });

  it("keeps the app-level context runtime on daily-session by default", () => {
    const storeDir = mkdtempSync(join(tmpdir(), "ayati-context-runtime-"));
    try {
      const runtime = createAppContextRuntime({
        config: createConfig({ storeDir }),
      });

      expect(runtime.kind).toBe("daily_session");
      if (runtime.kind !== "daily_session") {
        throw new Error("Expected daily-session context runtime.");
      }
      expect(typeof runtime.contextEngineRuntime.prepareUserTurn).toBe("function");
    } finally {
      rmSync(storeDir, { recursive: true, force: true });
    }
  });

  it("creates the git-memory runtime when explicitly configured", async () => {
    const storeDir = mkdtempSync(join(tmpdir(), "ayati-git-memory-runtime-"));
    try {
      const runtime = createAppContextRuntime({
        config: createConfig({
          storeDir,
          engine: "git_memory",
          agentId: "test-agent",
        }),
      });

      expect(runtime.kind).toBe("git_memory");
      if (runtime.kind !== "git_memory") {
        throw new Error("Expected git-memory context runtime.");
      }

      const prepared = await runtime.gitMemoryRuntime.prepareUserTurn({
        userMessage: "Record this in git memory.",
        at: "2026-06-28T09:00:00+05:30",
      });
      expect(prepared.sessionId).toBe("S-20260628-test-agent");
      expect(prepared.context.session.conversationTail).toMatchObject([{
        role: "user",
        text: "Record this in git memory.",
      }]);
    } finally {
      rmSync(storeDir, { recursive: true, force: true });
    }
  });
});

function createConfig(gitContext: Partial<AyatiRuntimeConfig["gitContext"]>): AyatiRuntimeConfig {
  return {
    http: {
      host: "127.0.0.1",
      port: 8081,
      allowOrigin: "*",
      maxUploadBytes: 1024,
    },
    documents: {
      vectorEnabled: false,
      embedBatchSize: 32,
      vectorMinChunks: 40,
    },
    python: {},
    agent: {
      loopConfig: {},
    },
    workspace: {
      root: "/tmp/ayati-workspace",
    },
    gitContext: {
      storeDir: "/tmp/ayati-context",
      timezone: "Asia/Kolkata",
      engine: "daily_session",
      agentId: "local",
      ...gitContext,
    },
  };
}
