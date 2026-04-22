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
    registry.register(makeAdapter("agentmail"));

    expect(registry.listManifests()).toEqual([
      expect.objectContaining({
        sourceId: "agentmail",
        displayName: "agentmail",
      }),
    ]);
  });

  it("resolves adapters by source", () => {
    const registry = new AdapterRegistry();
    const agentmail = makeAdapter("agentmail");
    registry.register(agentmail);

    const resolved = registry.resolve({
      source: "agentmail",
      clientId: "local",
    });

    expect(resolved).toBe(agentmail);
  });

  it("rejects duplicate source registration", () => {
    const registry = new AdapterRegistry();
    registry.register(makeAdapter("agentmail"));

    expect(() => registry.register(makeAdapter("agentmail"))).toThrow(
      "System adapter already registered for source agentmail.",
    );
  });
});
