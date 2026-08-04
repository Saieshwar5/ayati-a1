import { describe, expect, it } from "vitest";
import { buildInitialState } from "../../src/ivec/agent-runner/runner-state.js";
import {
  VIRTUAL_MODE_GRAPH,
  allowedVirtualModeTransitions,
  applyVirtualModeTransition,
  buildVirtualModeCard,
  createEntryVirtualModeState,
  enterContextMaintainMode,
  enterRunMaintainMode,
  identicalVirtualModeRequest,
  isVirtualModeTransitionAllowed,
  restoreVirtualModeAfterContextRetrieval,
  restoreVirtualModeAfterContextMaintenance,
  restoreVirtualModeAfterRunMaintenance,
  type VirtualModeName,
  type VirtualModeState,
  type VirtualModeTransitionTarget,
} from "../../src/ivec/agent-runner/virtual-mode.js";
import { DEFAULT_LOOP_CONFIG, type AgentLoopDeps } from "../../src/ivec/types.js";

const TARGETS: VirtualModeTransitionTarget[] = [
  "context.retrieve",
  "observe.locate",
  "observe.investigate",
  "workstream.route",
  "resolve",
  "execute",
  "validation",
];

describe("virtual mode graph", () => {
  it("accepts every declared edge and rejects every undeclared edge", () => {
    const states: Array<["ENTRY" | VirtualModeName, VirtualModeState]> = [
      ["ENTRY", createEntryVirtualModeState()],
      ["context.maintain", enterContextMaintainMode(createEntryVirtualModeState(), {
        protectFromSeq: 3,
        continuityMaxTokens: 4_000,
        unloadedRanges: [{ fromSeq: 1, toSeq: 2 }],
      }, 1)],
      ["run.maintain", enterRunMaintainMode(mode("execute"), maintenancePlan(), 2)],
      ["context.retrieve", mode("context.retrieve")],
      ["observe.locate", mode("observe.locate")],
      ["observe.investigate", mode("observe.investigate")],
      ["workstream.route", mode("workstream.route")],
      ["execute", mode("execute")],
      ["validation", mode("validation")],
    ];

    for (const [source, state] of states) {
      for (const target of TARGETS) {
        expect(isVirtualModeTransitionAllowed(state, target, {
          workstreamBound: false,
          routingObserved: true,
        }))
          .toBe(VIRTUAL_MODE_GRAPH[source].includes(target)
            || (source === "ENTRY" && target === "workstream.route"));
      }
    }
  });

  it("lets a bound repair observation return to execute without resolving again", () => {
    expect(allowedVirtualModeTransitions(createEntryVirtualModeState(), {
      workstreamBound: true,
    })).toEqual([
      "context.retrieve",
      "observe.locate",
      "observe.investigate",
      "execute",
    ]);
    for (const source of ["observe.locate", "observe.investigate"] as const) {
      expect(allowedVirtualModeTransitions(mode(source), { workstreamBound: true })).toEqual([
        "context.retrieve",
        "observe.locate",
        "observe.investigate",
        "validation",
        "execute",
      ]);
    }
    expect(isVirtualModeTransitionAllowed(mode("execute"), "resolve", {
      workstreamBound: true,
    })).toBe(false);
  });

  it("builds a compact card with ENTRY-only direct reply and active-mode validation", () => {
    expect(buildVirtualModeCard(createEntryVirtualModeState(), { workstreamBound: false })).toEqual({
      active: "ENTRY",
      revision: 0,
      capabilities: [],
      targets: [],
      allowedNext: [
        "normal_reply",
        "context.retrieve",
        "observe.locate",
        "observe.investigate",
      ],
    });

    expect(buildVirtualModeCard(mode("observe.investigate"), { workstreamBound: false }))
      .toMatchObject({
        active: "observe.investigate",
        allowedNext: [
          "context.retrieve",
          "observe.locate",
          "observe.investigate",
          "validation",
          "stop",
        ],
      });
    expect(buildVirtualModeCard(mode("observe.investigate"), {
      workstreamBound: false,
      routingObserved: true,
    }).allowedNext).toContain("workstream.route");

    expect(buildVirtualModeCard(createEntryVirtualModeState(), {
      workstreamBound: false,
      hotContextAvailable: false,
    }).allowedNext).toEqual([
      "normal_reply",
      "observe.locate",
      "observe.investigate",
    ]);
    expect(buildVirtualModeCard(createEntryVirtualModeState(), {
      workstreamBound: false,
      routingObserved: true,
      hotContextAvailable: false,
    }).allowedNext).toContain("workstream.route");
  });

  it("unlocks control-only routing after observation and offers resolve only while evidence exists", () => {
    expect(buildVirtualModeCard(mode("observe.locate"), {
      workstreamBound: false,
      routingObserved: false,
    }).allowedNext).not.toContain("workstream.route");
    expect(buildVirtualModeCard(mode("observe.locate"), {
      workstreamBound: false,
      routingObserved: true,
    }).allowedNext).toContain("workstream.route");

    const routing = mode("workstream.route");

    expect(buildVirtualModeCard(routing, {
      workstreamBound: false,
      routingObserved: false,
    }).allowedNext).toEqual([
      "context.retrieve",
      "observe.locate",
      "observe.investigate",
      "stop",
    ]);

    expect(buildVirtualModeCard(routing, {
      workstreamBound: false,
      routingObserved: true,
    }).allowedNext).toEqual([
      "context.retrieve",
      "observe.locate",
      "observe.investigate",
      "resolve",
      "stop",
    ]);
  });

  it("returns from context retrieval without activating final validation", () => {
    const enteredFromEntry = applyVirtualModeTransition(
      createEntryVirtualModeState(),
      {
        to: "context.retrieve",
        purpose: "Load relevant personal memory.",
        capabilities: ["context:load"],
      },
      "context.retrieve",
      1,
    );

    expect(buildVirtualModeCard(enteredFromEntry, { workstreamBound: false }))
      .toMatchObject({
        active: "context.retrieve",
        allowedNext: [],
        contextRetrieve: { returnTo: "ENTRY" },
      });
    expect(enteredFromEntry.operational).toBe(false);
    expect(restoreVirtualModeAfterContextRetrieval(enteredFromEntry)).toMatchObject({
      active: null,
      revision: 2,
      operational: false,
      capabilities: [],
      targets: [],
      mutationScopes: [],
    });

    const executing = mode("execute");
    const enteredFromExecute = applyVirtualModeTransition(
      executing,
      {
        to: "context.retrieve",
        purpose: "Load relevant personal memory.",
        capabilities: ["context:load"],
      },
      "context.retrieve",
      2,
    );
    expect(restoreVirtualModeAfterContextRetrieval(enteredFromExecute)).toMatchObject({
      active: "execute",
      operational: true,
      capabilities: ["file:write"],
      targets: ["known.txt"],
    });
  });

  it("suspends and restores the exact task mode during runtime-only context maintenance", () => {
    const executing = mode("execute");
    const maintaining = enterContextMaintainMode(executing, {
      protectFromSeq: 7,
      continuityMaxTokens: 4_000,
      unloadedRanges: [{ fromSeq: 1, toSeq: 6 }],
    }, 5);

    expect(buildVirtualModeCard(maintaining, { workstreamBound: true })).toMatchObject({
      active: "context.maintain",
      revision: 2,
      capabilities: [],
      targets: [],
      allowedNext: [],
      contextMaintain: {
        reason: "continuity_budget",
        returnTo: "execute",
        protectFromSeq: 7,
        continuityMaxTokens: 4_000,
        unloadedRanges: [{ fromSeq: 1, toSeq: 6 }],
      },
    });
    expect(maintaining.operational).toBe(true);
    expect(restoreVirtualModeAfterContextMaintenance(maintaining)).toMatchObject({
      active: "execute",
      revision: 3,
      operational: true,
      purpose: "Use execute.",
      capabilities: ["file:write"],
      targets: ["known.txt"],
    });

    const fromEntry = enterContextMaintainMode(createEntryVirtualModeState(), {
      protectFromSeq: 3,
      continuityMaxTokens: 4_000,
      unloadedRanges: [{ fromSeq: 1, toSeq: 2 }],
    }, 1);
    expect(restoreVirtualModeAfterContextMaintenance(fromEntry)).toMatchObject({
      active: null,
      revision: 2,
      operational: false,
    });
  });

  it("uses a separate control-only run maintenance mode and restores execute exactly", () => {
    const maintaining = enterRunMaintainMode(mode("execute"), maintenancePlan(), 7);

    expect(buildVirtualModeCard(maintaining, { workstreamBound: true })).toMatchObject({
      active: "run.maintain",
      capabilities: [],
      targets: [],
      allowedNext: [],
      runMaintain: {
        reason: "run_context_pressure",
        maintenanceId: "RUNCTX-1",
        returnTo: "execute",
        expectedWorkStateRevision: 3,
        sourceThroughStep: 8,
        requiredSavingsTokens: 12_000,
      },
    });
    expect(restoreVirtualModeAfterRunMaintenance(maintaining)).toMatchObject({
      active: "execute",
      operational: true,
      purpose: "Use execute.",
      capabilities: ["file:write"],
      targets: ["known.txt"],
    });
  });

  it("detects identical self-transitions and resets every new run to ENTRY", () => {
    const request = {
      to: "execute" as const,
      purpose: "Write the verified file.",
      capabilities: ["file:write"],
      mutationScopes: [{ kind: "filesystem" as const, path: "result.txt" }],
    };
    const executing = applyVirtualModeTransition(
      createEntryVirtualModeState(),
      request,
      "execute",
      4,
    );

    expect(identicalVirtualModeRequest(executing, request)).toBe(true);
    expect(identicalVirtualModeRequest(executing, {
      ...request,
      capabilities: ["file:write", "file:verify"],
    })).toBe(false);
    expect(createEntryVirtualModeState()).toEqual({
      active: null,
      revision: 0,
      operational: false,
      capabilities: [],
      targets: [],
      mutationScopes: [],
    });
  });

  it("does not restore execute after an interrupted run", () => {
    const deps = {
      provider: {} as AgentLoopDeps["provider"],
      toolDefinitions: [],
      runHandle: { runId: "RUN-1", streamId: "S-1", triggerSeq: 1 },
      clientId: "c1",
      dataDir: "/tmp/ayati-test",
    } satisfies AgentLoopDeps;
    const first = buildInitialState(
      deps,
      DEFAULT_LOOP_CONFIG,
      { sessionId: "S-1", seq: 1 },
      deps.runHandle,
    );
    first.virtualMode = mode("execute");
    first.interrupted = true;

    const nextRunHandle = { runId: "RUN-2", streamId: "S-1", triggerSeq: 2 };
    const next = buildInitialState(
      { ...deps, runHandle: nextRunHandle },
      DEFAULT_LOOP_CONFIG,
      { sessionId: "S-1", seq: 2 },
      nextRunHandle,
    );

    expect(next.virtualMode).toEqual(createEntryVirtualModeState());
    expect(next.interrupted).toBeUndefined();
  });
});

function mode(active: VirtualModeName): VirtualModeState {
  return {
    active,
    revision: 1,
    operational: active !== "context.retrieve",
    purpose: `Use ${active}.`,
    capabilities: active === "execute"
      ? ["file:write"]
      : active === "context.retrieve"
        ? ["context:load"]
        : active === "workstream.route"
          ? []
        : ["file:read"],
    targets: active === "context.retrieve" || active === "workstream.route"
      ? []
      : ["known.txt"],
    mutationScopes: [],
    enteredAtIteration: 1,
  };
}

function maintenancePlan() {
  return {
    schemaVersion: 1 as const,
    maintenanceId: "RUNCTX-1",
    sourceHash: "sha256:source",
    sourceThroughStep: 8,
    expectedWorkStateRevision: 3,
    candidateInputTokens: 72_000,
    recoveryTargetTokens: 60_000,
    requiredSavingsTokens: 12_000,
    inventory: [],
    omittedCandidateCount: 0,
    protectedRefs: ["call:latest"],
    entries: [],
  };
}
