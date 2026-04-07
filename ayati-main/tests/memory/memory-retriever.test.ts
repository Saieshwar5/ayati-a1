import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryGraphStore } from "../../src/memory/retrieval/memory-graph-store.js";
import { LanceMemoryStore } from "../../src/memory/retrieval/lance-memory-store.js";
import { MemoryRetriever } from "../../src/memory/retrieval/memory-retriever.js";
import type { SummaryEmbeddingProvider } from "../../src/memory/retrieval/types.js";

class FakeEmbedder implements SummaryEmbeddingProvider {
  readonly modelName = "fake-memory-model";

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
    const graphStore = new MemoryGraphStore({
      dataDir: root,
      sessionDataDir: root,
    });
    graphStore.start();
    await store.upsert({
      id: "run:s1:r1",
      clientId: "local",
      nodeType: "run",
      sourceType: "run",
      sessionId: "s1",
      sessionPath: "sessions/s1.md",
      sessionFilePath: join(root, "sessions", "s1.md"),
      runId: "r1",
      runPath: join(root, "runs", "r1"),
      runStatePath: join(root, "runs", "r1", "state.json"),
      createdAt: "2026-02-08T14:20:00.000Z",
      status: "completed",
      summaryText: "Completed auth migration and updated login flow",
      retrievalText: "User asked: fix auth login. Assistant outcome: Completed auth migration and updated login flow",
      userMessage: "fix auth login",
      assistantResponse: "Completed auth migration and updated login flow",
      embeddingModel: "fake-memory-model",
      embedding: [1, 0, 1],
    });
    await store.upsert({
      id: "run:s2:r2",
      clientId: "local",
      nodeType: "run",
      sourceType: "run",
      sessionId: "s2",
      sessionPath: "sessions/s2.md",
      sessionFilePath: join(root, "sessions", "s2.md"),
      runId: "r2",
      runPath: join(root, "runs", "r2"),
      runStatePath: join(root, "runs", "r2", "state.json"),
      createdAt: "2026-02-10T09:00:00.000Z",
      status: "completed",
      summaryText: "Completed deployment checklist",
      retrievalText: "User asked: run deployment. Assistant outcome: Completed deployment checklist",
      userMessage: "run deployment",
      assistantResponse: "Completed deployment checklist",
      embeddingModel: "fake-memory-model",
      embedding: [0, 1, 0],
    });

    const retriever = new MemoryRetriever({
      embedder: new FakeEmbedder(),
      store,
      graphStore,
    });

    const matches = await retriever.recall({
      clientId: "local",
      query: "auth login",
    });

    expect(matches[0]?.sessionId).toBe("s1");
    expect(matches[0]?.summaryText).toContain("auth migration");
    expect(matches[1]?.sessionId).toBe("s2");
    graphStore.stop();
  });

  it("supports date-only filtering without a semantic query", async () => {
    const root = mkdtempSync(join(tmpdir(), "ayati-recall-"));
    dirs.push(root);

    const store = new LanceMemoryStore({ dataDir: root });
    const graphStore = new MemoryGraphStore({
      dataDir: root,
      sessionDataDir: root,
    });
    graphStore.start();
    await store.upsert({
      id: "handoff:s1:1",
      clientId: "local",
      nodeType: "handoff",
      sessionId: "s1",
      sessionPath: "sessions/s1.md",
      sessionFilePath: join(root, "sessions", "s1.md"),
      createdAt: "2026-02-08T14:20:00.000Z",
      sourceType: "handoff",
      summaryText: "Auth work handoff",
      retrievalText: "Source: session handoff\nHandoff summary: Auth work handoff",
      embeddingModel: "fake-memory-model",
      embedding: [1, 0, 0],
    });
    await store.upsert({
      id: "handoff:s2:2",
      clientId: "local",
      nodeType: "handoff",
      sessionId: "s2",
      sessionPath: "sessions/s2.md",
      sessionFilePath: join(root, "sessions", "s2.md"),
      createdAt: "2026-02-10T09:00:00.000Z",
      sourceType: "handoff",
      summaryText: "Deployment handoff",
      retrievalText: "Source: session handoff\nHandoff summary: Deployment handoff",
      embeddingModel: "fake-memory-model",
      embedding: [0, 1, 0],
    });

    const retriever = new MemoryRetriever({
      embedder: new FakeEmbedder(),
      store,
      graphStore,
    });

    const matches = await retriever.recall({
      clientId: "local",
      dateFrom: "2026-02-10",
      dateTo: "2026-02-10",
    });

    expect(matches).toHaveLength(1);
    expect(matches[0]?.sessionId).toBe("s2");
    graphStore.stop();
  });
});
