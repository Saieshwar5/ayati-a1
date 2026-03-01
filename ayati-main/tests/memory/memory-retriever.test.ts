import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LanceMemoryStore } from "../../src/memory/retrieval/lance-memory-store.js";
import { MemoryRetriever } from "../../src/memory/retrieval/memory-retriever.js";
import type { SummaryEmbeddingProvider } from "../../src/memory/retrieval/types.js";

class FakeEmbedder implements SummaryEmbeddingProvider {
  async embed(text: string): Promise<number[]> {
    const normalized = text.toLowerCase();
    return [
      normalized.includes("auth") ? 1 : 0,
      normalized.includes("deploy") ? 1 : 0,
      normalized.includes("login") ? 1 : 0,
    ];
  }
}

describe("MemoryRetriever", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0, dirs.length)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns the best semantic match from persisted summaries", async () => {
    const root = mkdtempSync(join(tmpdir(), "ayati-recall-"));
    dirs.push(root);

    const store = new LanceMemoryStore({ dataDir: root });
    await store.upsert({
      id: "task:s1:r1",
      clientId: "local",
      sessionId: "s1",
      sessionPath: "data/memory/sessions/s1.md",
      runId: "r1",
      runPath: "data/runs/r1",
      createdAt: "2026-02-08T14:20:00.000Z",
      sourceType: "task_summary",
      summaryText: "Completed auth migration and updated login flow",
      dayKey: "2026-02-08",
      hourKey: "2026-02-08T14",
      embedding: [1, 0, 1],
    });
    await store.upsert({
      id: "task:s2:r2",
      clientId: "local",
      sessionId: "s2",
      sessionPath: "data/memory/sessions/s2.md",
      runId: "r2",
      runPath: "data/runs/r2",
      createdAt: "2026-02-10T09:00:00.000Z",
      sourceType: "task_summary",
      summaryText: "Completed deployment checklist",
      dayKey: "2026-02-10",
      hourKey: "2026-02-10T09",
      embedding: [0, 1, 0],
    });

    const retriever = new MemoryRetriever({
      embedder: new FakeEmbedder(),
      store,
    });

    const matches = await retriever.recall({
      clientId: "local",
      query: "auth login",
    });

    expect(matches[0]?.sessionId).toBe("s1");
    expect(matches[0]?.summaryText).toContain("auth migration");
    expect(matches[1]?.sessionId).toBe("s2");
  });

  it("supports date-only filtering without a semantic query", async () => {
    const root = mkdtempSync(join(tmpdir(), "ayati-recall-"));
    dirs.push(root);

    const store = new LanceMemoryStore({ dataDir: root });
    await store.upsert({
      id: "handoff:s1:1",
      clientId: "local",
      sessionId: "s1",
      sessionPath: "data/memory/sessions/s1.md",
      createdAt: "2026-02-08T14:20:00.000Z",
      sourceType: "handoff",
      summaryText: "Auth work handoff",
      dayKey: "2026-02-08",
      hourKey: "2026-02-08T14",
      embedding: [1, 0, 0],
    });
    await store.upsert({
      id: "handoff:s2:2",
      clientId: "local",
      sessionId: "s2",
      sessionPath: "data/memory/sessions/s2.md",
      createdAt: "2026-02-10T09:00:00.000Z",
      sourceType: "handoff",
      summaryText: "Deployment handoff",
      dayKey: "2026-02-10",
      hourKey: "2026-02-10T09",
      embedding: [0, 1, 0],
    });

    const retriever = new MemoryRetriever({
      embedder: new FakeEmbedder(),
      store,
    });

    const matches = await retriever.recall({
      clientId: "local",
      dateFrom: "2026-02-10",
      dateTo: "2026-02-10",
    });

    expect(matches).toHaveLength(1);
    expect(matches[0]?.sessionId).toBe("s2");
  });
});
