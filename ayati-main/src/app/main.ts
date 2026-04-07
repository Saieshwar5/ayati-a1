import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { IVecEngine } from "../ivec/index.js";
import { loadTelegramRuntimeConfig, TelegramServer, UploadServer, WsServer } from "../server/index.js";
import pluginFactories from "../config/plugins.js";
import providerFactory from "../config/provider.js";
import { initializeLlmRuntimeConfig } from "../config/llm-runtime-config.js";
import {
  PluginRegistry,
  loadPlugins,
  loadProvider,
  normalizeSystemEvent,
  type PluginRuntimeContext,
} from "../core/index.js";
import { loadStaticContext, type StaticContext } from "../context/static-context-cache.js";
import { UserWikiStore } from "../context/wiki-store.js";
import { WikiEvolver } from "../context/wiki-evolution.js";
import { MemoryManager } from "../memory/session-manager.js";
import { LanceMemoryStore } from "../memory/retrieval/lance-memory-store.js";
import { MemoryIndexer } from "../memory/retrieval/memory-indexer.js";
import { MemoryRetriever } from "../memory/retrieval/memory-retriever.js";
import { MemoryGraphStore } from "../memory/retrieval/memory-graph-store.js";
import { OpenAiMemoryEmbedder } from "../memory/retrieval/openai-memory-embedder.js";
import { devLog, devWarn } from "../shared/index.js";
import { createToolExecutor } from "../skills/tool-executor.js";
import type { ToolExecutor } from "../skills/tool-executor.js";
import { builtInSkillsProvider } from "../skills/provider.js";
import { createIdentitySkill } from "../skills/builtins/identity/index.js";
import { createRecallSkill } from "../skills/builtins/recall/index.js";
import { createWikiSkill } from "../skills/builtins/wiki/index.js";
import { createPythonSkill } from "../skills/builtins/python/index.js";
import { createAttachmentSkill } from "../skills/builtins/attachments/index.js";
import { createDatasetSkill } from "../skills/builtins/datasets/index.js";
import { createDocumentSkill } from "../skills/builtins/documents/index.js";
import { PulseScheduler, PulseStore } from "../pulse/index.js";
import { scanExternalSkills, stopExternalSkills, buildExternalSkillsBlock } from "../skills/external/index.js";
import { DocumentStore } from "../documents/document-store.js";
import { DocumentContextBackend } from "../documents/document-context-backend.js";
import { OpenAiDocumentEmbedder } from "../documents/openai-document-embedder.js";
import { LanceDocumentVectorStore } from "../documents/document-vector-store.js";
import { DocumentIndexer } from "../documents/document-indexer.js";
import { DocumentRetriever } from "../documents/document-retriever.js";
import { PreparedAttachmentRegistry } from "../documents/prepared-attachment-registry.js";
import { PreparedAttachmentService } from "../documents/prepared-attachment-service.js";
import { SessionAttachmentService } from "../documents/session-attachment-service.js";
import { loadSystemEventPolicy } from "../ivec/system-event-policy.js";

const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(thisDir, "..", "..");

const CLIENT_ID = "local";
const TELEGRAM_CLIENT_ID = "telegram-shared";
const DEFAULT_UPLOAD_PORT = 8081;
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
  let wikiEvolver: WikiEvolver | null = null;
  const wikiStore = new UserWikiStore({
    contextDir: resolve(projectRoot, "context"),
    historyDir: resolve(projectRoot, "data", "context-history"),
  });

  const recallStore = new LanceMemoryStore({
    dataDir: resolve(projectRoot, "data", "memory", "retrieval"),
  });
  const memoryGraphStore = new MemoryGraphStore({
    dataDir: resolve(projectRoot, "data", "memory", "retrieval"),
    sessionDataDir: resolve(projectRoot, "data", "memory"),
  });
  let memoryIndexer: MemoryIndexer | null = null;
  let memoryRetriever: MemoryRetriever;
  try {
    const embedder = new OpenAiMemoryEmbedder();
    memoryIndexer = new MemoryIndexer({
      embedder,
      store: recallStore,
      graphStore: memoryGraphStore,
    });
    memoryIndexer.start();
    memoryRetriever = new MemoryRetriever({
      embedder,
      store: recallStore,
      graphStore: memoryGraphStore,
    });
    devLog(`Memory recall enabled with model=${embedder.modelName}`);
  } catch (err) {
    devWarn(`Memory recall disabled: ${err instanceof Error ? err.message : String(err)}`);
    memoryRetriever = {
      recall: async () => [],
    } as unknown as MemoryRetriever;
  }

  const sessionMemory = new MemoryManager({
    onTaskSummaryIndexed: (data) => memoryIndexer?.indexTaskSummary(data),
    onHandoffSummaryIndexed: (data) => memoryIndexer?.indexHandoffSummary(data),
    onSessionClose: async (data) => {
      await wikiEvolver?.evolveFromSession(data.turns, data.handoffSummary);
    },
  });
  sessionMemory.initialize(CLIENT_ID);

  const pulseStore = new PulseStore();
  const externalSkills = await scanExternalSkills([
    { skillsDir: resolve(projectRoot, "data", "skills"), source: "project" },
    { skillsDir: resolve(homedir(), ".agents", "skills"), source: "global" },
  ]);

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
  });
  const wikiSkill = createWikiSkill({
    wikiStore,
    onProfileUpdated: (userProfile) => {
      if (!staticContext) {
        return;
      }
      staticContext.userProfile = userProfile;
      engine?.invalidateStaticTokenCache();
    },
  });
  const pythonSkill = createPythonSkill({
    dataDir: resolve(projectRoot, "data"),
    interpreterPath: process.env["AYATI_PYTHON_INTERPRETER"]?.trim() || undefined,
  });

  let toolExecutor: ToolExecutor;

  const wsServer = new WsServer({
    onMessage: (_transportClientId, data) => engine?.handleMessage(CLIENT_ID, data),
  });

  const pulseScheduler = new PulseScheduler({
    clientId: CLIENT_ID,
    store: pulseStore,
    onReminderDue: async (event) => {
      if (!engine) {
        throw new Error("Engine is not initialized");
      }
      await engine.handleSystemEvent(CLIENT_ID, normalizeSystemEvent(event));
    },
  });
  const documentStore = new DocumentStore({
    dataDir: resolve(projectRoot, "data", "documents"),
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

  const allToolDefs = [
    ...enabledTools,
    ...identitySkill.tools,
    ...recallSkill.tools,
    ...wikiSkill.tools,
    ...pythonSkill.tools,
    ...attachmentSkill.tools,
    ...datasetSkill.tools,
    ...documentSkill.tools,
  ];
  toolExecutor = createToolExecutor(allToolDefs);

  staticContext = await loadStaticContext({ toolDefinitions: allToolDefs });
  staticContext.userProfile = await wikiStore.syncProfileFromWiki(staticContext.userProfile);
  staticContext.skillBlocks.push({ id: identitySkill.id, content: identitySkill.promptBlock });
  staticContext.skillBlocks.push({ id: recallSkill.id, content: recallSkill.promptBlock });
  staticContext.skillBlocks.push({ id: wikiSkill.id, content: wikiSkill.promptBlock });
  staticContext.skillBlocks.push({ id: pythonSkill.id, content: pythonSkill.promptBlock });
  staticContext.skillBlocks.push({ id: attachmentSkill.id, content: attachmentSkill.promptBlock });
  staticContext.skillBlocks.push({ id: datasetSkill.id, content: datasetSkill.promptBlock });
  staticContext.skillBlocks.push({ id: documentSkill.id, content: documentSkill.promptBlock });

  wikiEvolver = new WikiEvolver({
    provider,
    wikiStore,
    currentProfile: staticContext.userProfile,
    onProfileUpdated: (userProfile) => {
      if (!staticContext) {
        return;
      }
      staticContext.userProfile = userProfile;
      engine?.invalidateStaticTokenCache();
    },
  });

  if (externalSkills.length > 0) {
    staticContext.skillBlocks.push(buildExternalSkillsBlock(externalSkills));
  }

  const uploadServer = new UploadServer({
    uploadsDir: documentStore.uploadsDir,
    runsDir: resolve(projectRoot, "data", "runs"),
    host: process.env["AYATI_UPLOAD_HOST"]?.trim() || "0.0.0.0",
    port: parsePositiveInt(process.env["AYATI_UPLOAD_PORT"], DEFAULT_UPLOAD_PORT),
    maxUploadBytes: parsePositiveInt(process.env["AYATI_UPLOAD_MAX_BYTES"], DEFAULT_UPLOAD_MAX_BYTES),
    allowOrigin: process.env["AYATI_UPLOAD_ALLOW_ORIGIN"]?.trim() || "*",
  });
  const telegramConfig = loadTelegramRuntimeConfig(process.env);
  const telegramServer = telegramConfig
    ? new TelegramServer({
      ...telegramConfig,
      clientId: telegramConfig.clientId || TELEGRAM_CLIENT_ID,
      uploadsDir: documentStore.uploadsDir,
      stateDir: resolve(projectRoot, "data", "telegram"),
      onMessage: (clientId, data) => engine?.handleMessage(clientId, data),
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
    sessionMemory,
    dataDir: resolve(projectRoot, "data"),
    documentStore,
    preparedAttachmentRegistry,
    documentContextBackend,
    systemEventPolicy,
  });
  const registry = new PluginRegistry();
  const publishSystemEvent: PluginRuntimeContext["publishSystemEvent"] = async (event) => {
    if (!engine) {
      throw new Error("Engine is not initialized");
    }
    devLog(
      `System event ingress received: source=${event.source} eventName=${event.eventName} eventId=${event.eventId ?? "generated"} summary=${event.summary}`,
    );
    const normalized = normalizeSystemEvent(event);
    devLog(
      `System event normalized: source=${normalized.source} eventName=${normalized.eventName} eventId=${normalized.eventId} receivedAt=${normalized.receivedAt}`,
    );
    await engine.handleSystemEvent(CLIENT_ID, normalized);
    devLog(`System event handed to engine: eventId=${normalized.eventId} source=${normalized.source}/${normalized.eventName}`);
    return {
      accepted: true,
      event: normalized,
    };
  };
  const pluginRuntimeContext: PluginRuntimeContext = {
    clientId: CLIENT_ID,
    dataDir: resolve(projectRoot, "data"),
    projectRoot,
    publishSystemEvent,
    emitSystemEvent: publishSystemEvent,
  };

  const plugins = await loadPlugins(pluginFactories);
  for (const plugin of plugins) {
    registry.register(plugin);
  }

  await engine.start();
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
    if (telegramServer) {
      await telegramServer.stop();
    }
    await uploadServer.stop();
    await wsServer.stop();
    await sessionMemory.shutdown();
    await memoryIndexer?.shutdown();
    await engine.stop();
    await stopExternalSkills(externalSkills);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
