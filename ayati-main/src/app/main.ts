import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { IVecEngine } from "../ivec/index.js";
import { WsServer } from "../server/index.js";
import pluginFactories from "../config/plugins.js";
import providerFactory from "../config/provider.js";
import { PluginRegistry, loadPlugins, loadProvider } from "../core/index.js";
import { loadStaticContext } from "../context/static-context-cache.js";
import { MemoryManager } from "../memory/session-manager.js";
import { LocalTextEmbedder } from "../memory/retrieval/local-embedder.js";
import { LanceMemoryStore } from "../memory/retrieval/lance-memory-store.js";
import { MemoryIndexer } from "../memory/retrieval/memory-indexer.js";
import { MemoryRetriever } from "../memory/retrieval/memory-retriever.js";
import { createToolExecutor } from "../skills/tool-executor.js";
import { builtInSkillsProvider } from "../skills/provider.js";
import { createIdentitySkill } from "../skills/builtins/identity/index.js";
import { createRecallSkill } from "../skills/builtins/recall/index.js";

import { devLog } from "../shared/index.js";

const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(thisDir, "..", "..");

const CLIENT_ID = "local";

export async function main(): Promise<void> {
  const provider = await loadProvider(providerFactory);
  const enabledTools = await builtInSkillsProvider.getAllTools();
  let engine: IVecEngine | null = null;

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
  });
  sessionMemory.initialize(CLIENT_ID);

  const identitySkill = createIdentitySkill({
    onSoulUpdated: (updatedSoul) => {
      staticContext.soul = updatedSoul;
      engine?.invalidateStaticTokenCache();
    },
  });
  const recallSkill = createRecallSkill({
    retriever: memoryRetriever,
  });

  const allToolDefs = [...enabledTools, ...identitySkill.tools, ...recallSkill.tools];
  const toolExecutor = createToolExecutor(allToolDefs);

  const staticContext = await loadStaticContext({ toolDefinitions: allToolDefs });
  staticContext.skillBlocks.push({ id: identitySkill.id, content: identitySkill.promptBlock });
  staticContext.skillBlocks.push({ id: recallSkill.id, content: recallSkill.promptBlock });

  const wsServer = new WsServer({
    onMessage: (clientId, data) => engine?.handleMessage(clientId, data),
  });
  engine = new IVecEngine({
    onReply: wsServer.send.bind(wsServer),
    provider,
    staticContext,
    toolExecutor,
    sessionMemory,
    dataDir: resolve(projectRoot, "data"),
  });
  const registry = new PluginRegistry();

  const plugins = await loadPlugins(pluginFactories);
  for (const plugin of plugins) {
    registry.register(plugin);
  }

  await engine.start();
  await wsServer.start();
  await registry.startAll();

  console.log(`Ayati i-vec ready — plugins: [${registry.list().join(", ")}]`);

  const shutdown = async (): Promise<void> => {
  
    await registry.stopAll();
    await wsServer.stop();
    await engine.stop();
    await sessionMemory.shutdown();
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
