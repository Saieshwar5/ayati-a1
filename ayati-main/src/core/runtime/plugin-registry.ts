import type { AyatiPlugin, PluginRuntimeContext } from "../contracts/plugin.js";

export class PluginRegistry {
  private plugins: AyatiPlugin[] = [];

  register(plugin: AyatiPlugin): void {
    this.plugins.push(plugin);
  }

  async startAll(context: PluginRuntimeContext): Promise<void> {
    for (const plugin of this.plugins) {
      await plugin.start(context);
    }
  }

  async stopAll(context?: PluginRuntimeContext): Promise<void> {
    for (const plugin of [...this.plugins].reverse()) {
      await plugin.stop(context);
    }
  }

  getPlugin(name: string): AyatiPlugin | undefined {
    return this.plugins.find((p) => p.name === name);
  }

  list(): string[] {
    return this.plugins.map((p) => p.name);
  }
}
