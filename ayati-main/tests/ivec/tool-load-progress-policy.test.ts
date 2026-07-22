import { describe, expect, it } from "vitest";
import {
  createToolLoadProgressState,
  evaluateToolLoadProgress,
} from "../../src/ivec/agent-runner/tool-load-progress-policy.js";
import type { ToolLoadResult } from "../../src/ivec/agent-runner/tool-working-set.js";

describe("tool load progress policy", () => {
  it("stops after the same unavailable capability is requested twice", () => {
    const result = loadResult({
      status: "unavailable",
      unavailable: [{
        tool: "write_files",
        reason: "requires_workstream_binding",
      }],
    });

    const first = evaluateToolLoadProgress(createToolLoadProgressState(), result);
    const second = evaluateToolLoadProgress(first.state, result);

    expect(first).toMatchObject({ madeProgress: false, shouldStop: false });
    expect(second).toMatchObject({
      madeProgress: false,
      shouldStop: true,
      repeatedTargets: ["write_files"],
    });
    expect(second.message).toContain("deterministic resolve gate");
  });

  it("tracks overlapping unavailable targets across differently shaped requests", () => {
    const first = evaluateToolLoadProgress(createToolLoadProgressState(), loadResult({
      status: "unavailable",
      unavailable: [
        { tool: "file_register_path", reason: "requires_workstream_binding" },
        { tool: "write_files", reason: "requires_workstream_binding" },
      ],
    }));
    const second = evaluateToolLoadProgress(first.state, loadResult({
      status: "unavailable",
      unavailable: [{ tool: "file_register_path", reason: "requires_workstream_binding" }],
    }));

    expect(second).toMatchObject({
      shouldStop: true,
      repeatedTargets: ["file_register_path"],
    });
  });

  it("resets no-progress attempts when a tool becomes newly active", () => {
    const unavailable = evaluateToolLoadProgress(createToolLoadProgressState(), loadResult({
      status: "unavailable",
      unavailable: [{ tool: "write_files", reason: "requires_workstream_binding" }],
    }));
    const loaded = evaluateToolLoadProgress(unavailable.state, loadResult({
      status: "loaded",
      loaded: ["inspect_paths"],
    }));
    const afterProgress = evaluateToolLoadProgress(loaded.state, loadResult({
      status: "unavailable",
      unavailable: [{ tool: "write_files", reason: "requires_workstream_binding" }],
    }));

    expect(loaded).toMatchObject({ madeProgress: true, shouldStop: false });
    expect(afterProgress).toMatchObject({ madeProgress: false, shouldStop: false });
  });
});

function loadResult(overrides: Partial<ToolLoadResult>): ToolLoadResult {
  return {
    status: "no_match",
    requested: { toolNames: [], groups: [] },
    loaded: [],
    alreadyActive: [],
    evicted: [],
    missing: [],
    unavailable: [],
    message: "",
    ...overrides,
  };
}
