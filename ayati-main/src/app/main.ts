import { AgentEngine } from "../engine/index.js";
import { WsServer } from "../server/index.js";
import pluginFactories from "../config/plugins.js";
import providerFactory from "../config/provider.js";
import { PluginRegistry, loadPlugins, loadProvider } from "../core/index.js";
import { loadSkillsWhitelist } from "../context/loaders/skills-whitelist-loader.js";
import { loadSystemPromptInput } from "../context/load-system-prompt-input.js";
import { buildSystemPrompt } from "../prompt/builder.js";
import { builtInSkillsProvider } from "../skills/provider.js";
import { createToolExecutor } from "../skills/tool-executor.js";

export async function main(): Promise<void> {
  const provider = await loadProvider(providerFactory);
  const promptInput = await loadSystemPromptInput();
  const { systemPrompt } = buildSystemPrompt(promptInput);
  const enabledSkillIds = await loadSkillsWhitelist();
  const enabledTools = await builtInSkillsProvider.getEnabledTools(enabledSkillIds);
  const toolExecutor = createToolExecutor(enabledTools);

  const wsServer = new WsServer({
    onMessage: (clientId, data) => engine.handleMessage(clientId, data),
  });
  const engine = new AgentEngine({
    onReply: wsServer.send.bind(wsServer),
    provider,
    context: systemPrompt,
    toolExecutor,
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
