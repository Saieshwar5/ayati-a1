import { describe, expect, it } from "vitest";
import { buildVerifiedResourceEffects } from "../../src/ivec/agent-runner/verified-resource-effects.js";
import type { LoopState, RunToolCallContext } from "../../src/ivec/types.js";

describe("verified resource effects", () => {
  it("collects verified mutations without depending on task validation", () => {
    const root = "/var/tmp/resource-effects";
    const calls: RunToolCallContext[] = [
      call(1, "write_files", "write", [{
        kind: "path_state",
        path: root + "/index.html",
        exists: true,
        actualKind: "file",
        change: "mutated",
        operation: "write",
        beforeKind: "missing",
        afterKind: "file",
        afterSha256: "created-hash",
        writeStatus: "created",
        tool: "write_files",
        step: 1,
        callId: "write",
      }]),
      call(2, "patch_files", "patch", [{
        kind: "path_state",
        path: root + "/index.html",
        exists: true,
        actualKind: "file",
        change: "mutated",
        operation: "patch",
        tool: "patch_files",
        step: 2,
        callId: "patch",
      }]),
      call(3, "copy", "copy", [{
        kind: "path_state",
        path: root + "/index.html",
        exists: true,
        actualKind: "file",
        change: "observed",
        operation: "inspect",
        tool: "copy",
        step: 3,
        callId: "copy",
      }, {
        kind: "path_state",
        path: root + "/index-copy.html",
        exists: true,
        actualKind: "file",
        change: "mutated",
        operation: "copy",
        tool: "copy",
        step: 3,
        callId: "copy",
      }]),
      call(4, "move", "move", [{
        kind: "path_state",
        path: root + "/index-copy.html",
        exists: false,
        actualKind: "file",
        change: "mutated",
        operation: "move",
        tool: "move",
        step: 4,
        callId: "move",
      }, {
        kind: "path_state",
        path: root + "/archive.html",
        exists: true,
        actualKind: "file",
        change: "mutated",
        operation: "move",
        tool: "move",
        step: 4,
        callId: "move",
      }]),
      call(5, "delete", "delete", [{
        kind: "path_state",
        path: root + "/archive.html",
        exists: false,
        actualKind: "file",
        change: "mutated",
        operation: "delete",
        tool: "delete",
        step: 5,
        callId: "delete",
      }]),
    ];
    const state = {
      runId: "RUN-RESOURCE-EFFECTS",
      toolContext: { recent: [], toolCalls: calls },
      harnessContext: {},
      virtualMode: {
        active: "execute",
        revision: 1,
        operational: true,
        capabilities: [],
        targets: [],
        mutationScopes: [root],
      },
    } as unknown as LoopState;

    const effects = buildVerifiedResourceEffects(state);

    expect(effects.map((effect) => effect.operation)).toEqual([
      "created",
      "modified",
      "copied",
      "moved",
      "deleted",
    ]);
    expect(effects[0]).toMatchObject({
      path: root + "/index.html",
      kind: "file",
      before: { exists: false },
      after: { exists: true, kind: "file", sha256: "created-hash" },
    });
    expect(effects[2]).toMatchObject({
      sourcePath: root + "/index.html",
      destinationPath: root + "/index-copy.html",
    });
    expect(effects.every((effect) => /^FRE-[0-9A-F]{24}$/.test(effect.effectId)))
      .toBe(true);
  });

  it("ignores unchanged, failed, transient, and unverified calls", () => {
    const unchanged = call(1, "write_files", "unchanged", [{
      kind: "path_state",
      path: "/var/tmp/existing.txt",
      exists: true,
      actualKind: "file",
      change: "observed",
      operation: "write",
      writeStatus: "unchanged",
      tool: "write_files",
      step: 1,
      callId: "unchanged",
    }]);
    const unverified = call(2, "delete", "unverified", [{
      kind: "path_state",
      path: "/var/tmp/deleted.txt",
      exists: false,
      actualKind: "file",
      change: "mutated",
      operation: "delete",
      tool: "delete",
      step: 2,
      callId: "unverified",
    }]);
    unverified.verificationPassed = false;
    const transient = call(3, "create_directory", "transient", [{
      kind: "path_state",
      path: "/var/tmp/transient",
      exists: true,
      actualKind: "directory",
      change: "mutated",
      operation: "create",
      tool: "create_directory",
      step: 3,
      callId: "transient",
    }]);
    transient.stepKind = "transient_context";

    const effects = buildVerifiedResourceEffects({
      runId: "RUN-NO-EFFECTS",
      toolContext: {
        recent: [],
        toolCalls: [unchanged, unverified, transient],
      },
      harnessContext: {},
    } as unknown as LoopState);

    expect(effects).toEqual([]);
  });
});

function call(
  step: number,
  tool: string,
  callId: string,
  completionEvidence: NonNullable<RunToolCallContext["completionEvidence"]>,
): RunToolCallContext {
  return {
    step,
    callId,
    tool,
    input: {},
    status: "success",
    output: "",
    verificationPassed: true,
    completionEvidence,
  };
}
