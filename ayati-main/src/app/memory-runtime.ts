import { resolve } from "node:path";
import { loadMemoryPolicy } from "../memory/personal/memory-policy.js";
import { PersonalMemoryStore } from "../memory/personal/personal-memory-store.js";
import { PersonalMemorySnapshotCache } from "../memory/personal/personal-memory-snapshot-cache.js";
import type { SummaryEmbeddingProvider } from "../memory/embedding-provider.js";
import {
  EpisodicMemoryController,
  EpisodicMemoryIndexer,
  EpisodicMemoryJobStore,
  EpisodicMemoryRetriever,
  EpisodicMemorySettingsStore,
  LanceEpisodicVectorStore,
} from "../memory/episodic/index.js";
import { devLog, devWarn } from "../shared/index.js";
import type { EmbeddingProvider } from "../embeddings/contracts.js";

export interface MemoryRuntimeOptions {
  projectRoot: string;
  clientId: string;
  embeddingProvider?: EmbeddingProvider;
}

export interface MemoryRuntime {
  personalMemoryStore: PersonalMemoryStore;
  personalMemorySnapshotCache: PersonalMemorySnapshotCache;
  memoryIndexer: EpisodicMemoryIndexer;
  memoryRetriever: EpisodicMemoryRetriever;
  episodicMemoryController: EpisodicMemoryController;
  stop(): Promise<void>;
}

export async function createMemoryRuntime(options: MemoryRuntimeOptions): Promise<MemoryRuntime> {
  const { projectRoot, clientId } = options;
  const memoryDataDir = resolve(projectRoot, "data", "memory");
  const episodicDataDir = resolve(memoryDataDir, "episodic");

  const personalMemoryStore = new PersonalMemoryStore({
    dataDir: memoryDataDir,
  });
  personalMemoryStore.start(loadMemoryPolicy(projectRoot));

  const personalMemorySnapshotCache = new PersonalMemorySnapshotCache({
    store: personalMemoryStore,
    projectRoot,
  });
  await personalMemorySnapshotCache.refresh(clientId, "startup");
  const episodicSettingsStore = new EpisodicMemorySettingsStore({
    dataDir: episodicDataDir,
  });
  const episodicJobStore = new EpisodicMemoryJobStore({
    dataDir: episodicDataDir,
  });
  const episodicVectorStore = new LanceEpisodicVectorStore({
    dataDir: resolve(memoryDataDir, "episodic-vectors"),
  });

  let memoryEmbedder: SummaryEmbeddingProvider | undefined;
  if (options.embeddingProvider) {
    try {
      await options.embeddingProvider.start();
      memoryEmbedder = options.embeddingProvider;
      devLog(`Episodic memory embeddings available with model=${memoryEmbedder.modelName}`);
    } catch (err) {
      devWarn(`Episodic memory embeddings unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const memoryIndexer = new EpisodicMemoryIndexer({
    settingsStore: episodicSettingsStore,
    jobStore: episodicJobStore,
    vectorStore: episodicVectorStore,
    ...(memoryEmbedder ? { embedder: memoryEmbedder } : {}),
  });
  memoryIndexer.start();

  const memoryRetriever = new EpisodicMemoryRetriever({
    settingsStore: episodicSettingsStore,
    vectorStore: episodicVectorStore,
    ...(memoryEmbedder ? { embedder: memoryEmbedder } : {}),
  });

  const episodicMemoryController = new EpisodicMemoryController({
    settingsStore: episodicSettingsStore,
    jobStore: episodicJobStore,
    embeddingAvailable: () => memoryEmbedder !== undefined,
    embeddingModel: () => memoryEmbedder?.modelName ?? episodicSettingsStore.get(clientId).embeddingModel,
  });

  return {
    personalMemoryStore,
    personalMemorySnapshotCache,
    memoryIndexer,
    memoryRetriever,
    episodicMemoryController,
    async stop(): Promise<void> {
      personalMemoryStore.stop();
      await memoryIndexer.shutdown();
    },
  };
}
