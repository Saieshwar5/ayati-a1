import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { IVecEngine } from "../ivec/index.js";
import { WsServer } from "../server/index.js";
import pluginFactories from "../config/plugins.js";
import providerFactory from "../config/provider.js";
import { PluginRegistry, loadPlugins, loadProvider } from "../core/index.js";
import { loadStaticContext } from "../context/static-context-cache.js";
import { MemoryManager } from "../memory/session-manager.js";
import { createToolExecutor } from "../skills/tool-executor.js";
import { builtInSkillsProvider } from "../skills/provider.js";
import { createIdentitySkill } from "../skills/builtins/identity/index.js";
import { startStoreWatcher } from "../ayati-store/watcher.js";
import { devLog } from "../shared/index.js";

const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(thisDir, "..", "..");

const CLIENT_ID = "local";

export async function main(): Promise<void> {
  const provider = await loadProvider(providerFactory);
  const storeWatcher = await startStoreWatcher(resolve(projectRoot, "src", "ayati-store"));
  storeWatcher.on("skill-added", (meta) => devLog(`Skill detected: ${meta.id} v${meta.version}`));
  storeWatcher.on("skill-removed", (meta) => devLog(`Skill removed: ${meta.id}`));
  const enabledTools = await builtInSkillsProvider.getAllTools();
  let engine: IVecEngine | null = null;

  const identitySkill = createIdentitySkill({
    onSoulUpdated: (updatedSoul) => {
      staticContext.soul = updatedSoul;
      engine?.invalidateStaticTokenCache();
    },
  });

  const allToolDefs = [...enabledTools, ...identitySkill.tools];
  const toolExecutor = createToolExecutor(allToolDefs);

  const staticContext = await loadStaticContext({ toolDefinitions: allToolDefs });
  staticContext.skillBlocks.push({ id: identitySkill.id, content: identitySkill.promptBlock });

  const sessionMemory = new MemoryManager();
  sessionMemory.initialize(CLIENT_ID);

  const wsServer = new WsServer({
    onMessage: (clientId, data) => engine?.handleMessage(clientId, data),
  });
  engine = new IVecEngine({
    onReply: wsServer.send.bind(wsServer),
    provider,
    staticContext,
    toolExecutor,
    sessionMemory,
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
    storeWatcher.stop();
    await registry.stopAll();
    await wsServer.stop();
    await engine.stop();
    await sessionMemory.shutdown();
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
