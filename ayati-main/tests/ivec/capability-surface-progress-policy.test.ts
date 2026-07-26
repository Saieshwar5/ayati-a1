import { describe, expect, it } from "vitest";
import {
  createCapabilitySurfaceProgressState,
  evaluateCapabilitySurfaceProgress,
} from "../../src/ivec/agent-runner/capability-surface-progress-policy.js";
import type { CapabilitySurfaceResult } from "../../src/ivec/agent-runner/capabilities/contracts.js";

describe("capability surface progress policy", () => {
  it("stops after the same unavailable capability is requested twice", () => {
    const result = loadResult({
      status: "unavailable",
      unavailable: [{
        tool: "write_files",
        reason: "requires_workstream_binding",
      }],
    });

    const first = evaluateCapabilitySurfaceProgress(createCapabilitySurfaceProgressState(), result);
    const second = evaluateCapabilitySurfaceProgress(first.state, result);

    expect(first).toMatchObject({ madeProgress: false, shouldStop: false });
    expect(second).toMatchObject({
      madeProgress: false,
      shouldStop: true,
      repeatedTargets: ["write_files"],
    });
    expect(second.message).toContain("deterministic resolve gate");
  });

  it("tracks overlapping unavailable targets across differently shaped requests", () => {
    const first = evaluateCapabilitySurfaceProgress(createCapabilitySurfaceProgressState(), loadResult({
      status: "unavailable",
      unavailable: [
        { tool: "file_register_path", reason: "requires_workstream_binding" },
        { tool: "write_files", reason: "requires_workstream_binding" },
      ],
    }));
    const second = evaluateCapabilitySurfaceProgress(first.state, loadResult({
      status: "unavailable",
      unavailable: [{ tool: "file_register_path", reason: "requires_workstream_binding" }],
    }));

    expect(second).toMatchObject({
      shouldStop: true,
      repeatedTargets: ["file_register_path"],
    });
  });

  it("resets no-progress attempts when a tool becomes newly active", () => {
    const unavailable = evaluateCapabilitySurfaceProgress(createCapabilitySurfaceProgressState(), loadResult({
      status: "unavailable",
      unavailable: [{ tool: "write_files", reason: "requires_workstream_binding" }],
    }));
    const loaded = evaluateCapabilitySurfaceProgress(unavailable.state, loadResult({
      status: "loaded",
      loaded: ["inspect_paths"],
    }));
    const afterProgress = evaluateCapabilitySurfaceProgress(loaded.state, loadResult({
      status: "unavailable",
      unavailable: [{ tool: "write_files", reason: "requires_workstream_binding" }],
    }));

    expect(loaded).toMatchObject({ madeProgress: true, shouldStop: false });
    expect(afterProgress).toMatchObject({ madeProgress: false, shouldStop: false });
  });
});

function loadResult(overrides: Partial<CapabilitySurfaceResult>): CapabilitySurfaceResult {
  return {
    status: "no_match",
    requested: [],
    capabilities: [],
    loaded: [],
    alreadyActive: [],
    evicted: [],
    missing: [],
    unavailable: [],
    unavailableCapabilities: [],
    omittedOptionalTools: [],
    coverage: [],
    message: "",
    ...overrides,
  };
}
