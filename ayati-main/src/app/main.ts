import { AgentEngine } from "../engine/index.js";
import { WsServer } from "../server/index.js";
import pluginFactories from "../config/plugins.js";
import { PluginRegistry, loadPlugins } from "../core/index.js";

export async function main(): Promise<void> {
  const wsServer = new WsServer({
    onMessage: (clientId, data) => engine.handleMessage(clientId, data),
  });
  const engine = new AgentEngine({
    onReply: wsServer.send.bind(wsServer),
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
    await registry.stopAll();
    await wsServer.stop();
    await engine.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
