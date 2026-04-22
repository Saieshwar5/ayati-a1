import type { ExternalSystemRequest, SourceManifest, SystemAdapter } from "../contracts/system-ingress.js";

export class AdapterRegistry {
  private readonly adapters = new Map<string, SystemAdapter>();

  register(adapter: SystemAdapter): void {
    const manifest = adapter.manifest();
    const sourceId = manifest.sourceId.trim();
    if (sourceId.length === 0) {
      throw new Error("System adapter sourceId is required.");
    }
    if (this.adapters.has(sourceId)) {
      throw new Error(`System adapter already registered for source ${sourceId}.`);
    }
    this.adapters.set(sourceId, adapter);
  }

  get(source: string): SystemAdapter | undefined {
    return this.adapters.get(source);
  }

  resolve(input: ExternalSystemRequest): SystemAdapter | undefined {
    const direct = this.adapters.get(input.source);
    if (direct && direct.canHandle(input)) {
      return direct;
    }

    for (const adapter of this.adapters.values()) {
      if (adapter.canHandle(input)) {
        return adapter;
      }
    }

    return direct;
  }

  listManifests(): SourceManifest[] {
    return [...this.adapters.values()].map((adapter) => adapter.manifest());
  }
}
