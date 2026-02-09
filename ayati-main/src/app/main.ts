import { AgentEngine } from "../engine/index.js";
import { WsServer } from "../server/index.js";
import pluginFactories from "../config/plugins.js";
import providerFactory from "../config/provider.js";
import { PluginRegistry, loadPlugins, loadProvider } from "../core/index.js";
import { loadStaticContext } from "../context/static-context-cache.js";
import { SessionManager } from "../memory/session-manager.js";
import { createToolExecutor } from "../skills/tool-executor.js";
import { loadSkillsWhitelist } from "../context/loaders/skills-whitelist-loader.js";
import { builtInSkillsProvider } from "../skills/provider.js";
import { loadToolAccessConfig, startConfigWatcher, stopConfigWatcher } from "../skills/tool-access-config.js";

const CLIENT_ID = "local";

export async function main(): Promise<void> {
  const provider = await loadProvider(providerFactory);
  await loadToolAccessConfig();
  startConfigWatcher();
  const enabledSkillIds = await loadSkillsWhitelist();
  const enabledTools = await builtInSkillsProvider.getEnabledTools(enabledSkillIds);
  const toolExecutor = createToolExecutor(enabledTools);

  const staticContext = await loadStaticContext();
  const sessionMemory = new SessionManager();
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
