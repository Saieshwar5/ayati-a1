import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { IVecEngine } from "../ivec/index.js";
import { WsServer } from "../server/index.js";
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
import { ContextEvolver } from "../context/context-evolver.js";
import { loadStaticContext, type StaticContext } from "../context/static-context-cache.js";
import { MemoryManager } from "../memory/session-manager.js";
import { LocalTextEmbedder } from "../memory/retrieval/local-embedder.js";
import { LanceMemoryStore } from "../memory/retrieval/lance-memory-store.js";
import { MemoryIndexer } from "../memory/retrieval/memory-indexer.js";
import { MemoryRetriever } from "../memory/retrieval/memory-retriever.js";
import { devLog, devWarn } from "../shared/index.js";
import { createToolExecutor } from "../skills/tool-executor.js";
import { builtInSkillsProvider } from "../skills/provider.js";
import { createIdentitySkill } from "../skills/builtins/identity/index.js";
import { createRecallSkill } from "../skills/builtins/recall/index.js";
import { PulseScheduler, PulseStore } from "../pulse/index.js";
import { scanExternalSkills, stopExternalSkills, buildExternalSkillsBlock } from "../skills/external/index.js";
import { DocumentStore } from "../documents/document-store.js";
import { DocumentContextBackend } from "../documents/document-context-backend.js";

const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(thisDir, "..", "..");

const CLIENT_ID = "local";

export async function main(): Promise<void> {
  await initializeLlmRuntimeConfig({ projectRoot });
  const provider = await loadProvider(providerFactory);
  const enabledTools = await builtInSkillsProvider.getAllTools();
  let engine: IVecEngine | null = null;
  let staticContext: StaticContext | null = null;
  let contextEvolver: ContextEvolver | null = null;

  const embedder = new LocalTextEmbedder({
    cacheDir: resolve(projectRoot, "data", "models-cache"),
  });
  const recallStore = new LanceMemoryStore({
    dataDir: resolve(projectRoot, "data", "memory", "retrieval"),
  });
  const memoryIndexer = new MemoryIndexer({
    embedder,
    store: recallStore,
  });
  const memoryRetriever = new MemoryRetriever({
    embedder,
    store: recallStore,
  });

  const sessionMemory = new MemoryManager({
    onTaskSummaryIndexed: (data) => memoryIndexer.indexTaskSummary(data),
    onHandoffSummaryIndexed: (data) => memoryIndexer.indexHandoffSummary(data),
    onSessionClose: async (data) => {
      await contextEvolver?.evolveFromSession(data.turns, {
        trigger: "handoff",
        handoffSummary: data.handoffSummary,
      });
    },
  });
  sessionMemory.initialize(CLIENT_ID);

  const pulseStore = new PulseStore();
  const externalSkills = await scanExternalSkills(resolve(projectRoot, "data", "skills"));

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

  const allToolDefs = [...enabledTools, ...identitySkill.tools, ...recallSkill.tools];
  const toolExecutor = createToolExecutor(allToolDefs);

  staticContext = await loadStaticContext({ toolDefinitions: allToolDefs });
  staticContext.skillBlocks.push({ id: identitySkill.id, content: identitySkill.promptBlock });
  staticContext.skillBlocks.push({ id: recallSkill.id, content: recallSkill.promptBlock });

  contextEvolver = new ContextEvolver({
    provider,
    contextDir: resolve(projectRoot, "context"),
    historyDir: resolve(projectRoot, "data", "context-history"),
    currentProfile: staticContext.userProfile,
    onContextUpdated: ({ userProfile }) => {
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
  const documentContextBackend = new DocumentContextBackend({
    store: documentStore,
  });

  engine = new IVecEngine({
    onReply: wsServer.send.bind(wsServer),
    provider,
    staticContext,
    toolExecutor,
    sessionMemory,
    dataDir: resolve(projectRoot, "data"),
    documentStore,
    documentContextBackend,
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
  await pulseScheduler.start();
  await registry.startAll(pluginRuntimeContext);

  console.log(`Ayati i-vec ready — plugins: [${registry.list().join(", ")}]`);

  const shutdown = async (): Promise<void> => {
    await registry.stopAll(pluginRuntimeContext);
    await pulseScheduler.stop();
    await wsServer.stop();
    await sessionMemory.shutdown();
    await engine.stop();
    await stopExternalSkills(externalSkills);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
