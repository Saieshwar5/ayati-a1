import { describe, expect, it } from "vitest";
import { AdapterRegistry } from "../../src/core/runtime/adapter-registry.js";
import type { ExternalSystemRequest, SourceManifest, SystemAdapter } from "../../src/core/contracts/system-ingress.js";

function makeAdapter(sourceId: string): SystemAdapter {
  return {
    manifest(): SourceManifest {
      return {
        sourceId,
        displayName: sourceId,
        sourceType: "external",
        transport: "webhook",
        authMode: "none",
        defaultEnabled: true,
      };
    },
    canHandle(input: ExternalSystemRequest): boolean {
      return input.source === sourceId;
    },
    normalize(): [] {
      return [];
    },
  };
}

describe("AdapterRegistry", () => {
  it("registers and lists manifests", () => {
    const registry = new AdapterRegistry();
    registry.register(makeAdapter("test-adapter"));

    expect(registry.listManifests()).toEqual([
      expect.objectContaining({
        sourceId: "test-adapter",
        displayName: "test-adapter",
      }),
    ]);
  });

  it("resolves adapters by source", () => {
    const registry = new AdapterRegistry();
    const adapter = makeAdapter("test-adapter");
    registry.register(adapter);

    const resolved = registry.resolve({
      source: "test-adapter",
      clientId: "local",
    });

    expect(resolved).toBe(adapter);
  });

  it("rejects duplicate source registration", () => {
    const registry = new AdapterRegistry();
    registry.register(makeAdapter("test-adapter"));

    expect(() => registry.register(makeAdapter("test-adapter"))).toThrow(
      "System adapter already registered for source test-adapter.",
    );
  });
});
