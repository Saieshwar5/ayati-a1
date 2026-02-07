import type { AyatiPlugin } from "../contracts/plugin.js";

export type PluginFactory = () => Promise<{ default: AyatiPlugin }>;

export async function loadPlugins(factories: PluginFactory[]): Promise<AyatiPlugin[]> {
  const plugins: AyatiPlugin[] = [];

  for (const factory of factories) {
    const loaded = await factory();
    if (!loaded?.default) {
      throw new Error("Invalid plugin module: expected a default export.");
    }
    plugins.push(loaded.default);
  }

  return plugins;
}
