import { describe, expect, it } from "vitest";
import { buildInitialState } from "../../src/ivec/agent-runner/runner-state.js";
import {
  VIRTUAL_MODE_GRAPH,
  allowedVirtualModeTransitions,
  applyVirtualModeTransition,
  buildVirtualModeCard,
  createEntryVirtualModeState,
  identicalVirtualModeRequest,
  isVirtualModeTransitionAllowed,
  restoreVirtualModeAfterContextRetrieval,
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
          .toBe(VIRTUAL_MODE_GRAPH[source].includes(target));
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
        "workstream.route",
      ],
    });

    expect(buildVirtualModeCard(mode("observe.investigate"), { workstreamBound: false }))
      .toMatchObject({
        active: "observe.investigate",
        allowedNext: [
          "context.retrieve",
          "observe.locate",
          "observe.investigate",
          "workstream.route",
          "validation",
          "stop",
        ],
      });

    expect(buildVirtualModeCard(createEntryVirtualModeState(), {
      workstreamBound: false,
      hotContextAvailable: false,
    }).allowedNext).toEqual([
      "normal_reply",
      "observe.locate",
      "observe.investigate",
      "workstream.route",
    ]);
  });

  it("offers resolve from workstream routing only after current-run routing evidence exists", () => {
    const routing = mode("workstream.route");

    expect(buildVirtualModeCard(routing, {
      workstreamBound: false,
      routingObserved: false,
    }).allowedNext).toEqual([
      "context.retrieve",
      "workstream.route",
      "stop",
    ]);

    expect(buildVirtualModeCard(routing, {
      workstreamBound: false,
      routingObserved: true,
    }).allowedNext).toEqual([
      "context.retrieve",
      "workstream.route",
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

  it("detects identical self-transitions and resets every new run to ENTRY", () => {
    const request = {
      to: "execute" as const,
      purpose: "Write the verified file.",
      capabilities: ["file:write"],
      targets: ["result.txt"],
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
          ? ["workstream:search"]
        : ["file:read"],
    targets: active === "context.retrieve" ? [] : ["known.txt"],
    enteredAtIteration: 1,
  };
}
