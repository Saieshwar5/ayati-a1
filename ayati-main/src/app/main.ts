import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentEngine } from "../engine/index.js";
import { WsServer } from "../server/index.js";
import pluginFactories from "../config/plugins.js";
import providerFactory from "../config/provider.js";
import { PluginRegistry, loadPlugins, loadProvider } from "../core/index.js";
import { loadStaticContext } from "../context/static-context-cache.js";
import { ContextEvolver } from "../context/context-evolver.js";
import { SessionManager } from "../memory/session-manager.js";
import { createToolExecutor } from "../skills/tool-executor.js";
import { builtInSkillsProvider } from "../skills/provider.js";
import { loadToolAccessConfig, startConfigWatcher, stopConfigWatcher } from "../skills/tool-access-config.js";
import { createIdentitySkill } from "../skills/builtins/identity/index.js";

const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(thisDir, "..", "..");

const CLIENT_ID = "local";

export async function main(): Promise<void> {
  const provider = await loadProvider(providerFactory);
  await loadToolAccessConfig();
  startConfigWatcher();
  const enabledTools = await builtInSkillsProvider.getAllTools();

  const staticContext = await loadStaticContext();

  const identitySkill = createIdentitySkill({
    onSoulUpdated: (updatedSoul) => { staticContext.soul = updatedSoul; },
  });
  staticContext.skillBlocks.push({ id: identitySkill.id, content: identitySkill.promptBlock });

  const toolExecutor = createToolExecutor([...enabledTools, ...identitySkill.tools]);

  const contextEvolver = new ContextEvolver({
    provider,
    contextDir: resolve(projectRoot, "context"),
    historyDir: resolve(projectRoot, "data", "context-history"),
    currentProfile: staticContext.userProfile,
    onContextUpdated: (updated) => {
      staticContext.userProfile = updated.userProfile;
    },
  });

  const sessionMemory = new SessionManager({
    onSessionClose: (data) => {
      void contextEvolver.evolveFromSession(data.turns);
    },
  });
  sessionMemory.initialize(CLIENT_ID);

  const wsServer = new WsServer({
    onMessage: (clientId, data) => engine.handleMessage(clientId, data),
  });
  const engine = new AgentEngine({
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

  console.log(`Ayati ready — plugins: [${registry.list().join(", ")}]`);

  const shutdown = async (): Promise<void> => {
    stopConfigWatcher();
    await registry.stopAll();
    await wsServer.stop();
    await engine.stop();
    sessionMemory.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
