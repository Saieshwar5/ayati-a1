import type { AyatiPlugin, PluginRuntimeContext } from "../contracts/plugin.js";

export class PluginRegistry {
  private plugins: AyatiPlugin[] = [];
  private readonly started = new Set<string>();

  register(plugin: AyatiPlugin): void {
    this.plugins.push(plugin);
  }

  async startAll(context: PluginRuntimeContext): Promise<void> {
    for (const plugin of this.plugins) {
      await plugin.start(context);
      this.started.add(plugin.name);
    }
  }

  async stopAll(context?: PluginRuntimeContext): Promise<void> {
    for (const plugin of [...this.plugins].reverse()) {
      await plugin.stop(context);
      this.started.delete(plugin.name);
    }
  }

  getPlugin(name: string): AyatiPlugin | undefined {
    return this.plugins.find((p) => p.name === name);
  }

  list(): string[] {
    return this.plugins.map((p) => p.name);
  }

  status(name: string): { name: string; loaded: boolean; started: boolean } {
    const plugin = this.getPlugin(name);
    return {
      name,
      loaded: Boolean(plugin),
      started: Boolean(plugin) && this.started.has(name),
    };
  }
}
