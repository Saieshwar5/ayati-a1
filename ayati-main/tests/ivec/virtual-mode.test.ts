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
  type VirtualModeName,
  type VirtualModeState,
  type VirtualModeTransitionTarget,
} from "../../src/ivec/agent-runner/virtual-mode.js";
import { DEFAULT_LOOP_CONFIG, type AgentLoopDeps } from "../../src/ivec/types.js";

const TARGETS: VirtualModeTransitionTarget[] = [
  "observe.locate",
  "observe.investigate",
  "resolve",
  "execute",
];

describe("virtual mode graph", () => {
  it("accepts every declared edge and rejects every undeclared edge", () => {
    const states: Array<["ENTRY" | VirtualModeName, VirtualModeState]> = [
      ["ENTRY", createEntryVirtualModeState()],
      ["observe.locate", mode("observe.locate")],
      ["observe.investigate", mode("observe.investigate")],
      ["execute", mode("execute")],
    ];

    for (const [source, state] of states) {
      for (const target of TARGETS) {
        expect(isVirtualModeTransitionAllowed(state, target, { workstreamBound: false }))
          .toBe(VIRTUAL_MODE_GRAPH[source].includes(target));
      }
    }
  });

  it("lets a bound repair observation return to execute without resolving again", () => {
    for (const source of ["observe.locate", "observe.investigate"] as const) {
      expect(allowedVirtualModeTransitions(mode(source), { workstreamBound: true })).toEqual([
        "observe.locate",
        "observe.investigate",
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
      allowedNext: ["normal_reply", "observe.locate", "observe.investigate", "resolve"],
    });

    expect(buildVirtualModeCard(mode("observe.investigate"), { workstreamBound: false }))
      .toMatchObject({
        active: "observe.investigate",
        allowedNext: ["observe.locate", "observe.investigate", "resolve", "validate"],
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
    purpose: `Use ${active}.`,
    capabilities: active === "execute" ? ["file:write"] : ["file:read"],
    targets: ["known.txt"],
    enteredAtIteration: 1,
  };
}
