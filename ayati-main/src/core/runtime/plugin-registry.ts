import type { AyatiPlugin } from "../contracts/plugin.js";

export class PluginRegistry {
  private plugins: AyatiPlugin[] = [];

  register(plugin: AyatiPlugin): void {
    this.plugins.push(plugin);
  }

  async startAll(): Promise<void> {
    for (const plugin of this.plugins) {
      await plugin.start();
    }
  }

  async stopAll(): Promise<void> {
    for (const plugin of [...this.plugins].reverse()) {
      await plugin.stop();
    }
  }

  getPlugin(name: string): AyatiPlugin | undefined {
    return this.plugins.find((p) => p.name === name);
  }

  list(): string[] {
    return this.plugins.map((p) => p.name);
  }
}
