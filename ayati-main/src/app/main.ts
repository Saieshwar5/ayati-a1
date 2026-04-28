import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { IVecEngine } from "../ivec/index.js";
import { loadTelegramRuntimeConfig, TelegramServer, UploadServer, WsServer } from "../server/index.js";
import pluginFactories from "../config/plugins.js";
import providerFactory from "../config/provider.js";
import { initializeLlmRuntimeConfig } from "../config/llm-runtime-config.js";
import {
  AdapterRegistry,
  InboundQueueStore,
  PluginRegistry,
  SystemEventWorker,
  SystemIngressService,
  loadPlugins,
  loadProvider,
  normalizeSystemEvent,
  type PluginRuntimeContext,
} from "../core/index.js";
import { loadStaticContext, type StaticContext } from "../context/static-context-cache.js";
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
import { createToolExecutor } from "../skills/tool-executor.js";
import type { ToolExecutor } from "../skills/tool-executor.js";
import { builtInSkillsProvider } from "../skills/provider.js";
import { createIdentitySkill } from "../skills/builtins/identity/index.js";
import { createRecallSkill } from "../skills/builtins/recall/index.js";
import { createMemorySkill } from "../skills/builtins/memory/index.js";
import { createPythonSkill } from "../skills/builtins/python/index.js";
import { createAttachmentSkill } from "../skills/builtins/attachments/index.js";
import { createDatasetSkill } from "../skills/builtins/datasets/index.js";
import { createDocumentSkill } from "../skills/builtins/documents/index.js";
import { createFilesSkill } from "../skills/builtins/files/index.js";
import { PulseScheduler, PulseStore } from "../pulse/index.js";
import { pulseTool } from "../skills/builtins/pulse/index.js";
import { createSkillBrokerSkill } from "../skills/builtins/skill-broker/index.js";
import { createExternalSkillBroker, ExternalSkillRegistry } from "../skills/external/index.js";
import { DocumentStore } from "../documents/document-store.js";
import { DocumentContextBackend } from "../documents/document-context-backend.js";
import { OpenAiDocumentEmbedder } from "../documents/openai-document-embedder.js";
import { LanceDocumentVectorStore } from "../documents/document-vector-store.js";
import { DocumentIndexer } from "../documents/document-indexer.js";
import { DocumentRetriever } from "../documents/document-retriever.js";
import { PreparedAttachmentRegistry } from "../documents/prepared-attachment-registry.js";
import { PreparedAttachmentService } from "../documents/prepared-attachment-service.js";
import { SessionAttachmentService } from "../documents/session-attachment-service.js";
import { FileLibrary } from "../files/file-library.js";
import { loadSystemEventPolicy } from "../ivec/system-event-policy.js";

const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(thisDir, "..", "..");

const CLIENT_ID = "local";
const TELEGRAM_CLIENT_ID = "telegram-shared";
const DEFAULT_HTTP_PORT = 8081;
const DEFAULT_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

function parsePositiveInt(rawValue: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(rawValue ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function isEnvFalse(rawValue: string | undefined): boolean {
  return /^(?:0|false|no|off)$/i.test(rawValue ?? "");
}

export async function main(): Promise<void> {
  await initializeLlmRuntimeConfig({ projectRoot });
  const provider = await loadProvider(providerFactory);
  const enabledTools = await builtInSkillsProvider.getAllTools();
  const systemEventPolicy = loadSystemEventPolicy(projectRoot);
  let engine: IVecEngine | null = null;
  let staticContext: StaticContext | null = null;
  const personalMemoryStore = new PersonalMemoryStore({
    dataDir: resolve(projectRoot, "data", "memory"),
  });
  personalMemoryStore.start(loadMemoryPolicy(projectRoot));
  const personalMemorySnapshotCache = new PersonalMemorySnapshotCache({
    store: personalMemoryStore,
    projectRoot,
  });
  await personalMemorySnapshotCache.refresh(CLIENT_ID, "startup");

  const episodicSettingsStore = new EpisodicMemorySettingsStore({
    dataDir: resolve(projectRoot, "data", "memory", "episodic"),
  });
  const episodicJobStore = new EpisodicMemoryJobStore({
    dataDir: resolve(projectRoot, "data", "memory", "episodic"),
  });
  const episodicVectorStore = new LanceEpisodicVectorStore({
    dataDir: resolve(projectRoot, "data", "memory", "episodic-vectors"),
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
    embeddingModel: () => memoryEmbedder?.modelName ?? episodicSettingsStore.get(CLIENT_ID).embeddingModel,
  });

  let personalMemoryConsolidator: MemoryConsolidator | null = null;
  const sessionMemory = new MemoryManager({
    personalMemorySnapshotProvider: (clientId) => personalMemorySnapshotCache.getSnapshot(clientId),
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
  sessionMemory.initialize(CLIENT_ID);
  personalMemoryConsolidator = new MemoryConsolidator({
    provider,
    store: personalMemoryStore,
    projectRoot,
    onSnapshotRegenerated: (userId, snapshot, result) => {
      personalMemorySnapshotCache.setSnapshot(userId, snapshot, "evolution", result);
    },
  });
  personalMemoryConsolidator.scheduleProcessing();

  const adapterRegistry = new AdapterRegistry();
  const inboundQueueStore = new InboundQueueStore({
    dataDir: resolve(projectRoot, "data", "memory"),
  });
  inboundQueueStore.start();
  const systemIngress = new SystemIngressService({
    adapterRegistry,
    queueStore: inboundQueueStore,
  });

  const pulseStore = new PulseStore();

  const identitySkill = createIdentitySkill({
    onSoulUpdated: (updatedSoul) => {
      if (!staticContext) {
        return;
      }
      staticContext.soul = updatedSoul;
      engine?.invalidateStaticTokenCache();
    },
  });
  const recallSkill = createRecallSkill({
    retriever: memoryRetriever,
    controls: episodicMemoryController,
  });
  const memorySkill = createMemorySkill({
    store: personalMemoryStore,
    defaultUserId: CLIENT_ID,
  });
  const pythonSkill = createPythonSkill({
    dataDir: resolve(projectRoot, "data"),
    interpreterPath: process.env["AYATI_PYTHON_INTERPRETER"]?.trim() || undefined,
  });

  let toolExecutor: ToolExecutor;
  const registry = new PluginRegistry();

  const wsServer = new WsServer({
    onMessage: (_transportClientId, data) => engine?.handleMessage(CLIENT_ID, data),
  });

  const pulseScheduler = new PulseScheduler({
    clientId: CLIENT_ID,
    store: pulseStore,
    onReminderDue: async (event) => {
      await systemIngress.ingestInternalEvent(CLIENT_ID, event);
    },
  });
  const documentStore = new DocumentStore({
    dataDir: resolve(projectRoot, "data", "documents"),
  });
  const fileLibrary = new FileLibrary({
    dataDir: resolve(projectRoot, "data"),
    defaultMaxDownloadBytes: parsePositiveInt(process.env["AYATI_UPLOAD_MAX_BYTES"], DEFAULT_UPLOAD_MAX_BYTES),
  });
  let documentIndexer: DocumentIndexer | undefined;
  let documentRetriever: DocumentRetriever | undefined;
  if (!isEnvFalse(process.env["AYATI_DOCUMENT_VECTOR_ENABLED"])) {
    try {
      const documentEmbedder = new OpenAiDocumentEmbedder();
      const documentVectorStore = new LanceDocumentVectorStore({
        dataDir: resolve(projectRoot, "data", "documents", "vector"),
      });
      documentIndexer = new DocumentIndexer({
        embedder: documentEmbedder,
        store: documentVectorStore,
        documentsDir: documentStore.documentsDir,
        batchSize: parsePositiveInt(process.env["AYATI_DOCUMENT_EMBED_BATCH_SIZE"], 32),
      });
      documentRetriever = new DocumentRetriever({
        embedder: documentEmbedder,
        store: documentVectorStore,
      });
      devLog(`Document vector retrieval enabled with model=${documentEmbedder.modelName}`);
    } catch (err) {
      devWarn(`Document vector retrieval disabled: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const documentContextBackend = new DocumentContextBackend({
    store: documentStore,
    ...(documentIndexer ? { documentIndexer } : {}),
    ...(documentRetriever ? { documentRetriever } : {}),
    largeDocumentMinChunks: parsePositiveInt(process.env["AYATI_DOCUMENT_VECTOR_MIN_CHUNKS"], 40),
  });
  const preparedAttachmentRegistry = new PreparedAttachmentRegistry();
  const preparedAttachmentService = new PreparedAttachmentService({
    registry: preparedAttachmentRegistry,
    documentStore,
    provider,
    documentContextBackend,
  });
  const sessionAttachmentService = new SessionAttachmentService({
    sessionMemory,
    preparedAttachmentRegistry,
    dataDir: resolve(projectRoot, "data"),
  });
  const attachmentSkill = createAttachmentSkill({ sessionAttachmentService });
  const datasetSkill = createDatasetSkill({ preparedAttachmentService });
  const documentSkill = createDocumentSkill({ preparedAttachmentService });
  const filesSkill = createFilesSkill({ fileLibrary });

  const baseToolDefs = [
    ...enabledTools,
    ...identitySkill.tools,
    ...recallSkill.tools,
    ...memorySkill.tools,
    ...pythonSkill.tools,
    ...attachmentSkill.tools,
    ...datasetSkill.tools,
    ...documentSkill.tools,
    ...filesSkill.tools,
  ];
  toolExecutor = createToolExecutor(baseToolDefs);

  const externalSkillBroker = createExternalSkillBroker({
    roots: [
      { skillsDir: resolve(projectRoot, "data", "skills"), source: "project" },
    ],
    cachePath: resolve(projectRoot, "data", "skills", "catalog.json"),
    secretMappingPath: resolve(projectRoot, "context", "skill-secrets.json"),
    policyPath: resolve(projectRoot, "context", "skill-policy.json"),
    toolExecutor,
  });
  await externalSkillBroker.initialize();
  const skillBrokerSkill = createSkillBrokerSkill(externalSkillBroker);
  toolExecutor.mount?.("static:skill-broker", skillBrokerSkill.tools, {
    scope: "static",
    description: skillBrokerSkill.description,
  });
  const runtimeToolDefs = [...baseToolDefs, ...skillBrokerSkill.tools];

  const externalSkillRegistry = new ExternalSkillRegistry({
    roots: [
      { skillsDir: resolve(projectRoot, "data", "skills"), source: "project" },
    ],
    secretMappingPath: resolve(projectRoot, "context", "skill-secrets.json"),
    policyPath: resolve(projectRoot, "context", "skill-policy.json"),
  });
  await externalSkillRegistry.initialize();

  staticContext = await loadStaticContext({ toolDefinitions: runtimeToolDefs });
  staticContext.skillBlocks.push({ id: identitySkill.id, content: identitySkill.promptBlock });
  staticContext.skillBlocks.push({ id: recallSkill.id, content: recallSkill.promptBlock });
  staticContext.skillBlocks.push({ id: memorySkill.id, content: memorySkill.promptBlock });
  staticContext.skillBlocks.push({ id: pythonSkill.id, content: pythonSkill.promptBlock });
  staticContext.skillBlocks.push({ id: attachmentSkill.id, content: attachmentSkill.promptBlock });
  staticContext.skillBlocks.push({ id: datasetSkill.id, content: datasetSkill.promptBlock });
  staticContext.skillBlocks.push({ id: documentSkill.id, content: documentSkill.promptBlock });
  staticContext.skillBlocks.push({ id: filesSkill.id, content: filesSkill.promptBlock });
  staticContext.skillBlocks.push({ id: skillBrokerSkill.id, content: skillBrokerSkill.promptBlock });

  const uploadServer = new UploadServer({
    uploadsDir: documentStore.uploadsDir,
    runsDir: resolve(projectRoot, "data", "runs"),
    host: process.env["AYATI_HTTP_HOST"]?.trim() || process.env["AYATI_UPLOAD_HOST"]?.trim() || "127.0.0.1",
    port: parsePositiveInt(process.env["AYATI_HTTP_PORT"] ?? process.env["AYATI_UPLOAD_PORT"], DEFAULT_HTTP_PORT),
    maxUploadBytes: parsePositiveInt(process.env["AYATI_UPLOAD_MAX_BYTES"], DEFAULT_UPLOAD_MAX_BYTES),
    allowOrigin: process.env["AYATI_HTTP_ALLOW_ORIGIN"]?.trim() || process.env["AYATI_UPLOAD_ALLOW_ORIGIN"]?.trim() || "*",
    pulseTool,
    pulseClientId: CLIENT_ID,
    pulseApiToken: process.env["AYATI_HTTP_API_TOKEN"]?.trim() || undefined,
    fileLibrary,
  });
  const telegramConfig = loadTelegramRuntimeConfig(process.env);
  const telegramServer = telegramConfig
    ? new TelegramServer({
      ...telegramConfig,
      clientId: telegramConfig.clientId || TELEGRAM_CLIENT_ID,
      uploadsDir: documentStore.uploadsDir,
      stateDir: resolve(projectRoot, "data", "telegram"),
      onMessage: (clientId, data) => engine?.handleMessage(clientId, data),
      fileLibrary,
    })
    : null;

  engine = new IVecEngine({
    onReply: (clientId, data) => {
      if (telegramServer && clientId === telegramServer.clientId) {
        telegramServer.send(clientId, data);
        return;
      }
      wsServer.send(clientId, data);
    },
    provider,
    staticContext,
    toolExecutor,
    externalSkillBroker,
    externalSkillRegistry,
    sessionMemory,
    dataDir: resolve(projectRoot, "data"),
    documentStore,
    preparedAttachmentRegistry,
    documentContextBackend,
    fileLibrary,
    systemEventPolicy,
  });
  const systemEventWorker = new SystemEventWorker({
    queueStore: inboundQueueStore,
    processEvent: async (clientId, event) => {
      if (!engine) {
        throw new Error("Engine is not initialized");
      }
      await engine.handleSystemEvent(clientId, event);
    },
  });
  const publishSystemEvent: PluginRuntimeContext["publishSystemEvent"] = async (event) => {
    devLog(
      `System event ingress received: source=${event.source} eventName=${event.eventName} eventId=${event.eventId ?? "generated"} summary=${event.summary}`,
    );
    const normalized = normalizeSystemEvent(event);
    devLog(
      `System event normalized: source=${normalized.source} eventName=${normalized.eventName} eventId=${normalized.eventId} receivedAt=${normalized.receivedAt}`,
    );
    const result = await systemIngress.ingestInternalEvent(CLIENT_ID, normalized);
    devLog(
      `System event handed to ingress queue: eventId=${normalized.eventId} source=${normalized.source}/${normalized.eventName} queued=${result.queued !== false}`,
    );
    return result;
  };
  const pluginRuntimeContext: PluginRuntimeContext = {
    clientId: CLIENT_ID,
    dataDir: resolve(projectRoot, "data"),
    projectRoot,
    publishSystemEvent,
    emitSystemEvent: publishSystemEvent,
    registerSystemAdapter: (adapter) => adapterRegistry.register(adapter),
    ingestExternalRequest: async (request) => await systemIngress.ingestExternalRequest(request),
  };

  const plugins = await loadPlugins(pluginFactories);
  for (const plugin of plugins) {
    registry.register(plugin);
  }

  await engine.start();
  systemEventWorker.start();
  await wsServer.start();
  await uploadServer.start();
  if (telegramServer) {
    await telegramServer.start();
  }
  await pulseScheduler.start();
  await registry.startAll(pluginRuntimeContext);

  console.log(`Ayati i-vec ready — plugins: [${registry.list().join(", ")}]`);

  const shutdown = async (): Promise<void> => {
    await registry.stopAll(pluginRuntimeContext);
    await pulseScheduler.stop();
    pulseStore.close();
    if (telegramServer) {
      await telegramServer.stop();
    }
    await uploadServer.stop();
    await wsServer.stop();
    await systemEventWorker.stop();
    inboundQueueStore.stop();
    await sessionMemory.shutdown();
    await personalMemoryConsolidator?.shutdown();
    personalMemoryStore.stop();
    await memoryIndexer.shutdown();
    await engine.stop();
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
