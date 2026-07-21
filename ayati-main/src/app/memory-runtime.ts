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
import type { LlmProvider } from "../core/contracts/provider.js";
import type {
  ContextCheckpointPlan,
  ContextCheckpointRecord,
} from "ayati-context-engine";
import { MemoryConsolidator } from "../memory/personal/memory-consolidator.js";
import type { MemoryConsolidationJobPayload } from "../memory/personal/types.js";

export interface MemoryRuntimeOptions {
  projectRoot: string;
  clientId: string;
  provider: LlmProvider;
  embeddingProvider?: EmbeddingProvider;
}

export interface PersonalMemoryCheckpointInput {
  userId: string;
  streamId: string;
  checkpoint: ContextCheckpointRecord;
  plan: ContextCheckpointPlan;
}

export type PersonalMemoryCheckpointPayload = MemoryConsolidationJobPayload & {
  checkpointId: string;
  coveredFromSeq: number;
  coveredToSeq: number;
};

export interface MemoryRuntime {
  personalMemoryStore: PersonalMemoryStore;
  personalMemorySnapshotCache: PersonalMemorySnapshotCache;
  memoryIndexer: EpisodicMemoryIndexer;
  memoryRetriever: EpisodicMemoryRetriever;
  episodicMemoryController: EpisodicMemoryController;
  enqueuePersonalMemoryCheckpoint(input: PersonalMemoryCheckpointInput): void;
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
  const personalMemoryConsolidator = new MemoryConsolidator({
    provider: options.provider,
    store: personalMemoryStore,
    projectRoot,
    onSnapshotRegenerated: async (userId, snapshot, result) => {
      personalMemorySnapshotCache.setSnapshot(
        userId,
        snapshot,
        "agent_stream_checkpoint",
        result,
      );
    },
  });
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
    enqueuePersonalMemoryCheckpoint(input): void {
      const payload = buildPersonalMemoryCheckpointPayload(input);
      if (payload) personalMemoryConsolidator.enqueueCheckpoint(payload);
    },
    async stop(): Promise<void> {
      await personalMemoryConsolidator.shutdown();
      personalMemoryStore.stop();
      await memoryIndexer.shutdown();
    },
  };
}

export function buildPersonalMemoryCheckpointPayload(
  input: PersonalMemoryCheckpointInput,
): PersonalMemoryCheckpointPayload | undefined {
  const memoryMessages = input.plan.selectedMessages.filter(
    (message) => message.role === "user" || message.role === "assistant",
  );
  const coveredFromSeq = memoryMessages[0]?.sequence;
  const coveredToSeq = memoryMessages.at(-1)?.sequence;
  if (coveredFromSeq === undefined || coveredToSeq === undefined) return undefined;
  const sessionPath = `agent-stream:${input.streamId}`;
  return {
    userId: input.userId,
    sessionId: input.streamId,
    sessionPath,
    checkpointId: input.checkpoint.checkpointId,
    coveredFromSeq,
    coveredToSeq,
    reason: "context_pressure_checkpoint",
    turns: memoryMessages.map((message) => ({
      role: message.role as "user" | "assistant",
      content: message.content,
      timestamp: message.at,
      sessionPath,
      workRunId: message.runId,
    })),
  };
}
