import { resolve } from "node:path";
import type { LlmProvider } from "../core/index.js";
import { MemoryManager } from "../memory/session-manager.js";
import { loadMemoryPolicy } from "../memory/personal/memory-policy.js";
import { PersonalMemoryStore } from "../memory/personal/personal-memory-store.js";
import { PersonalMemorySnapshotCache } from "../memory/personal/personal-memory-snapshot-cache.js";
import { MemoryConsolidator } from "../memory/personal/memory-consolidator.js";
import { OpenAiMemoryEmbedder } from "../memory/openai-memory-embedder.js";
import {
  EpisodicMemoryController,
  EpisodicMemoryIndexer,
  EpisodicMemoryJobStore,
  EpisodicMemoryRetriever,
  EpisodicMemorySettingsStore,
  LanceEpisodicVectorStore,
} from "../memory/episodic/index.js";
import { devLog, devWarn } from "../shared/index.js";

export interface MemoryRuntimeOptions {
  projectRoot: string;
  clientId: string;
  provider: LlmProvider;
}

export interface MemoryRuntime {
  sessionMemory: MemoryManager;
  personalMemoryStore: PersonalMemoryStore;
  personalMemorySnapshotCache: PersonalMemorySnapshotCache;
  personalMemoryConsolidator: MemoryConsolidator;
  memoryIndexer: EpisodicMemoryIndexer;
  memoryRetriever: EpisodicMemoryRetriever;
  episodicMemoryController: EpisodicMemoryController;
  stop(): Promise<void>;
}

export async function createMemoryRuntime(options: MemoryRuntimeOptions): Promise<MemoryRuntime> {
  const { projectRoot, clientId, provider } = options;
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

  let memoryEmbedder: OpenAiMemoryEmbedder | undefined;
  try {
    memoryEmbedder = new OpenAiMemoryEmbedder();
    devLog(`Episodic memory embeddings available with model=${memoryEmbedder.modelName}`);
  } catch (err) {
    devWarn(`Episodic memory embeddings unavailable: ${err instanceof Error ? err.message : String(err)}`);
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

  let personalMemoryConsolidator: MemoryConsolidator | null = null;
  const sessionMemory = new MemoryManager({
    personalMemorySnapshotProvider: (snapshotClientId) => personalMemorySnapshotCache.getSnapshot(snapshotClientId),
    onSessionClose: (data) => {
      personalMemoryConsolidator?.enqueueSession({
        userId: data.clientId,
        sessionId: data.sessionId,
        sessionPath: data.sessionPath,
        handoffSummary: data.handoffSummary,
        reason: data.reason,
        turns: data.turns.map((turn) => ({
          role: turn.role,
          content: turn.content,
          timestamp: turn.timestamp,
          sessionPath: turn.sessionPath,
          ...(turn.runId ? { runId: turn.runId } : {}),
        })),
      });
      void memoryIndexer.enqueueClosedSession({
        clientId: data.clientId,
        sessionId: data.sessionId,
        sessionPath: data.sessionPath,
        sessionFilePath: data.sessionFilePath,
        reason: data.reason,
        handoffSummary: data.handoffSummary,
      });
    },
  });
  sessionMemory.initialize(clientId);

  personalMemoryConsolidator = new MemoryConsolidator({
    provider,
    store: personalMemoryStore,
    projectRoot,
    onSnapshotRegenerated: (userId, snapshot, result) => {
      personalMemorySnapshotCache.setSnapshot(userId, snapshot, "evolution", result);
    },
  });
  personalMemoryConsolidator.scheduleProcessing();

  return {
    sessionMemory,
    personalMemoryStore,
    personalMemorySnapshotCache,
    personalMemoryConsolidator,
    memoryIndexer,
    memoryRetriever,
    episodicMemoryController,
    async stop(): Promise<void> {
      await sessionMemory.shutdown();
      await personalMemoryConsolidator?.shutdown();
      personalMemoryStore.stop();
      await memoryIndexer.shutdown();
    },
  };
}
