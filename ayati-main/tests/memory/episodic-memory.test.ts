import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EpisodicMemoryIndexer,
  EpisodicMemoryJobStore,
  EpisodicMemoryRetriever,
  EpisodicMemorySettingsStore,
  extractEpisodicEpisodesFromSessionFile,
} from "../../src/memory/episodic/index.js";
import type {
  EpisodicMemoryRecord,
  EpisodicRecallMatch,
  EpisodicVectorSearchInput,
  EpisodicVectorStore,
} from "../../src/memory/episodic/index.js";
import { serializeEvent, type SessionEvent } from "../../src/memory/session-events.js";
import type { SummaryEmbeddingProvider } from "../../src/memory/embedding-provider.js";

class FakeEmbedder implements SummaryEmbeddingProvider {
  readonly modelName = "fake-episodic-model";

  async embed(text: string): Promise<number[]> {
    const normalized = text.toLowerCase();
    return [
      normalized.includes("auth") ? 1 : 0,
      normalized.includes("login") ? 1 : 0,
      normalized.includes("deploy") ? 1 : 0,
      normalized.includes("brief") ? 1 : 0,
    ];
  }
}

class InMemoryEpisodicVectorStore implements EpisodicVectorStore {
  readonly records = new Map<string, EpisodicMemoryRecord>();

  async upsertEpisodes(records: EpisodicMemoryRecord[]): Promise<void> {
    for (const record of records) {
      this.records.set(`${record.episodeId}:${record.embeddingModel}`, record);
    }
  }

  async search(input: EpisodicVectorSearchInput): Promise<EpisodicRecallMatch[]> {
    const lower = normalizeLowerBound(input.dateFrom);
    const upper = normalizeUpperBound(input.dateTo);
    const episodeTypes = input.episodeTypes ? new Set(input.episodeTypes) : null;
    return [...this.records.values()]
      .filter((record) => record.clientId === input.clientId)
      .filter((record) => record.embeddingModel === input.embeddingModel)
      .filter((record) => (lower ? record.createdAt >= lower : true))
      .filter((record) => (upper ? record.createdAt <= upper : true))
      .filter((record) => (episodeTypes ? episodeTypes.has(record.episodeType) : true))
      .map((record) => ({
        episodeId: record.episodeId,
        episodeType: record.episodeType,
        createdAt: record.createdAt,
        summary: record.summary,
        matchedText: record.sourceText,
        score: input.vector ? cosineSimilarity(input.vector, record.vector) : 1,
        sessionId: record.sessionId,
        sessionPath: record.sessionPath,
        sessionFilePath: record.sessionFilePath,
        ...(record.runId ? { runId: record.runId } : {}),
        eventStartIndex: record.eventStartIndex,
        eventEndIndex: record.eventEndIndex,
        contentHash: record.contentHash,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, input.limit);
  }
}

describe("episodic memory", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0, dirs.length)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("extracts clean episodes from a closed session file", () => {
    const root = mkdtempSync(join(tmpdir(), "ayati-episodic-"));
    dirs.push(root);
    const sessionFilePath = join(root, "sessions", "s1.md");
    mkdirSync(dirname(sessionFilePath), { recursive: true });
    writeFileSync(sessionFilePath, renderSession(events()), "utf8");

    const episodes = extractEpisodicEpisodesFromSessionFile({
      clientId: "local",
      sessionId: "s1",
      sessionPath: "sessions/s1.md",
      sessionFilePath,
      reason: "session_switch:test",
      handoffSummary: "Auth work finished; user prefers brief updates.",
    });

    expect(episodes.some((episode) => episode.episodeType === "conversation_exchange")).toBe(true);
    expect(episodes.some((episode) => episode.episodeType === "task_outcome")).toBe(true);
    expect(episodes.some((episode) => episode.episodeType === "session_summary")).toBe(true);
    expect(episodes.map((episode) => episode.embeddingText).join("\n")).not.toContain("tool output should stay out");
    expect(episodes.map((episode) => episode.embeddingText).join("\n")).not.toContain("sk-secret");
    expect(episodes[0]?.sessionFilePath).toBe(sessionFilePath);
  });

  it("does not enqueue or embed when episodic memory is disabled", async () => {
    const root = mkdtempSync(join(tmpdir(), "ayati-episodic-"));
    dirs.push(root);
    const settingsStore = new EpisodicMemorySettingsStore({ dataDir: root });
    const jobStore = new EpisodicMemoryJobStore({ dataDir: root });
    const vectorStore = new InMemoryEpisodicVectorStore();
    const indexer = new EpisodicMemoryIndexer({
      settingsStore,
      jobStore,
      vectorStore,
      embedder: new FakeEmbedder(),
    });

    await indexer.enqueueClosedSession({
      clientId: "local",
      sessionId: "s1",
      sessionPath: "sessions/s1.md",
      sessionFilePath: join(root, "missing.md"),
      reason: "session_switch:test",
    });

    expect(jobStore.counts().pending).toBe(0);
    expect(vectorStore.records.size).toBe(0);
  });

  it("indexes enabled sessions idempotently and recalls simple prior conversations", async () => {
    const root = mkdtempSync(join(tmpdir(), "ayati-episodic-"));
    dirs.push(root);
    const sessionFilePath = join(root, "s1.md");
    writeFileSync(sessionFilePath, renderSession(events()), "utf8");
    const settingsStore = new EpisodicMemorySettingsStore({ dataDir: root });
    settingsStore.setEnabled("local", true, "2026-02-09T00:00:00.000Z");
    const jobStore = new EpisodicMemoryJobStore({ dataDir: root });
    const vectorStore = new InMemoryEpisodicVectorStore();
    const embedder = new FakeEmbedder();
    const indexer = new EpisodicMemoryIndexer({
      settingsStore,
      jobStore,
      vectorStore,
      embedder,
    });

    const payload = {
      clientId: "local",
      sessionId: "s1",
      sessionPath: "sessions/s1.md",
      sessionFilePath,
      reason: "session_switch:test",
      handoffSummary: "Auth work finished; user prefers brief updates.",
    };
    await indexer.enqueueClosedSession(payload);
    const firstCount = vectorStore.records.size;
    await indexer.enqueueClosedSession(payload);

    expect(firstCount).toBeGreaterThan(0);
    expect(vectorStore.records.size).toBe(firstCount);
    expect(jobStore.counts().done).toBe(1);

    const retriever = new EpisodicMemoryRetriever({
      settingsStore,
      vectorStore,
      embedder,
    });
    const matches = await retriever.recall({
      clientId: "local",
      query: "auth login",
      episodeTypes: ["conversation_exchange"],
    });

    expect(matches[0]?.episodeType).toBe("conversation_exchange");
    expect(matches[0]?.sessionFilePath).toBe(sessionFilePath);
    expect(matches[0]?.matchedText).toContain("auth login");
    expect(matches[0]?.eventStartIndex).toBeGreaterThanOrEqual(0);
  });

  it("records a retryable failed job when embedding fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "ayati-episodic-"));
    dirs.push(root);
    const sessionFilePath = join(root, "s1.md");
    writeFileSync(sessionFilePath, renderSession(events()), "utf8");
    const settingsStore = new EpisodicMemorySettingsStore({ dataDir: root });
    settingsStore.setEnabled("local", true);
    const jobStore = new EpisodicMemoryJobStore({ dataDir: root });
    const vectorStore = new InMemoryEpisodicVectorStore();
    const indexer = new EpisodicMemoryIndexer({
      settingsStore,
      jobStore,
      vectorStore,
      embedder: {
        modelName: "broken",
        embed: async () => {
          throw new Error("embedding service unavailable");
        },
      },
    });

    await indexer.enqueueClosedSession({
      clientId: "local",
      sessionId: "s1",
      sessionPath: "sessions/s1.md",
      sessionFilePath,
      reason: "session_switch:test",
    });

    expect(jobStore.counts().failed).toBe(1);
    expect(jobStore.list()[0]?.lastError).toContain("embedding service unavailable");
    expect(vectorStore.records.size).toBe(0);
  });
});

function events(): SessionEvent[] {
  return [
    {
      v: 2,
      ts: "2026-02-08T14:00:00.000Z",
      type: "session_open",
      sessionId: "s1",
      sessionPath: "sessions/s1.md",
      clientId: "local",
    },
    {
      v: 2,
      ts: "2026-02-08T14:01:00.000Z",
      type: "user_message",
      sessionId: "s1",
      sessionPath: "sessions/s1.md",
      runId: "r1",
      content: "Please fix auth login. api_key=sk-secretsecretsecretsecret",
    },
    {
      v: 2,
      ts: "2026-02-08T14:01:10.000Z",
      type: "tool_result",
      sessionId: "s1",
      sessionPath: "sessions/s1.md",
      stepId: 1,
      toolCallId: "t1",
      toolName: "shell",
      status: "success",
      output: "tool output should stay out of embeddings",
    },
    {
      v: 2,
      ts: "2026-02-08T14:02:00.000Z",
      type: "assistant_message",
      sessionId: "s1",
      sessionPath: "sessions/s1.md",
      runId: "r1",
      content: "I fixed the auth login flow and kept the reply brief.",
      responseKind: "reply",
    },
    {
      v: 2,
      ts: "2026-02-08T14:03:00.000Z",
      type: "task_summary",
      sessionId: "s1",
      sessionPath: "sessions/s1.md",
      runId: "r1",
      runPath: "runs/r1",
      status: "completed",
      taskStatus: "done",
      objective: "Fix auth login",
      summary: "Completed auth login fix",
      keyFacts: ["User prefers brief updates"],
      nextAction: "No follow-up required",
    },
    {
      v: 2,
      ts: "2026-02-08T14:04:00.000Z",
      type: "session_close",
      sessionId: "s1",
      sessionPath: "sessions/s1.md",
      reason: "session_switch:test",
      tokenAtClose: 100,
      eventCount: 2,
      handoffSummary: "Auth work finished; user prefers brief updates.",
    },
  ];
}

function renderSession(sessionEvents: SessionEvent[]): string {
  return [
    "# Ayati Session",
    "",
    "## Events",
    "",
    ...sessionEvents.map((event) => `<!-- AYATI_EVENT ${serializeEvent(event)} -->`),
  ].join("\n");
}

function normalizeLowerBound(value?: string): string | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return `${value}T00:00:00.000Z`;
  }
  return value;
}

function normalizeUpperBound(value?: string): string | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return `${value}T23:59:59.999Z`;
  }
  return value;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
