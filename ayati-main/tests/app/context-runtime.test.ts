import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContextEngineRuntime } from "../../src/app/context-runtime.js";
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
      ...gitContext,
    },
  };
}
