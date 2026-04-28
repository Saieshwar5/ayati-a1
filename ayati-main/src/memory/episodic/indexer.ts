import { existsSync } from "node:fs";
import { devWarn } from "../../shared/index.js";
import type { SummaryEmbeddingProvider } from "../embedding-provider.js";
import { extractEpisodicEpisodesFromSessionFile } from "./session-extractor.js";
import { EpisodicMemoryJobStore } from "./job-store.js";
import { EpisodicMemorySettingsStore } from "./settings-store.js";
import type {
  EpisodicMemoryRecord,
  EpisodicSessionIndexPayload,
  EpisodicVectorStore,
} from "./types.js";

export interface EpisodicMemoryIndexerOptions {
  settingsStore: EpisodicMemorySettingsStore;
  jobStore: EpisodicMemoryJobStore;
  vectorStore: EpisodicVectorStore;
  embedder?: SummaryEmbeddingProvider;
  now?: () => Date;
}

export class EpisodicMemoryIndexer {
  private readonly settingsStore: EpisodicMemorySettingsStore;
  private readonly jobStore: EpisodicMemoryJobStore;
  private readonly vectorStore: EpisodicVectorStore;
  private readonly embedder?: SummaryEmbeddingProvider;
  private readonly nowProvider: () => Date;
  private processing = false;
  private stopped = false;

  constructor(options: EpisodicMemoryIndexerOptions) {
    this.settingsStore = options.settingsStore;
    this.jobStore = options.jobStore;
    this.vectorStore = options.vectorStore;
    this.embedder = options.embedder;
    this.nowProvider = options.now ?? (() => new Date());
  }

  start(): void {
    this.stopped = false;
    this.jobStore.requeueRunning(this.nowIso());
    void this.processPending();
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    while (this.processing) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async enqueueClosedSession(payload: EpisodicSessionIndexPayload): Promise<void> {
    const settings = this.settingsStore.get(payload.clientId);
    if (!settings.episodicEnabled) {
      return;
    }

    this.jobStore.enqueueSession(payload, this.nowIso());
    await this.processPending();
  }

  async processPending(): Promise<void> {
    if (this.processing || this.stopped) {
      return;
    }
    if (!this.embedder) {
      return;
    }

    this.processing = true;
    try {
      while (!this.stopped) {
        const job = this.jobStore.claimNextPending();
        if (!job) {
          return;
        }

        const settings = this.settingsStore.get(job.clientId);
        if (!settings.episodicEnabled) {
          this.jobStore.markFailed(job.jobId, "Episodic memory is disabled for this client.", this.nowIso());
          continue;
        }

        try {
          if (!existsSync(job.sessionFilePath)) {
            throw new Error(`Session file does not exist: ${job.sessionFilePath}`);
          }
          const episodes = extractEpisodicEpisodesFromSessionFile(job);
          const records: EpisodicMemoryRecord[] = [];
          for (const episode of episodes) {
            const vector = normalizeVector(await this.embedder.embed(episode.embeddingText));
            records.push({
              ...episode,
              embeddingModel: this.embedder.modelName,
              vector,
              indexedAt: this.nowIso(),
            });
          }
          await this.vectorStore.upsertEpisodes(records);
          this.jobStore.markDone(job.jobId, this.nowIso());
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.jobStore.markFailed(job.jobId, message, this.nowIso());
          devWarn("Episodic memory indexing failed:", message);
        }
      }
    } finally {
      this.processing = false;
    }
  }

  private nowIso(): string {
    return this.nowProvider().toISOString();
  }
}

function normalizeVector(vector: number[]): number[] {
  let sum = 0;
  for (const value of vector) {
    sum += value * value;
  }
  if (sum === 0) {
    return vector;
  }
  const norm = Math.sqrt(sum);
  return vector.map((value) => value / norm);
}
