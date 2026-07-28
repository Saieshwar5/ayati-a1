import { describe, expect, it, vi } from "vitest";
import {
  bindingRequiredToolNames,
  dispatchDeterministicResolveGate,
} from "../../src/ivec/agent-runner/deterministic-resolve.js";
import { createEntryVirtualModeState } from "../../src/ivec/agent-runner/virtual-mode.js";
import type { LoopState } from "../../src/ivec/types.js";
import { contextEngineFixture } from "../fixtures/agent-context.js";

const ROUTING_REF = "run:RUN-1:step:1:call:find-owner";

describe("deterministic resolve gate", () => {
  it("uses taxonomy metadata to identify binding-required capabilities", () => {
    expect(bindingRequiredToolNames(["find_files", "patch_files", "write_files", "patch_files"]))
      .toEqual(["patch_files", "write_files"]);
  });

  it("rejects mutation when the user explicitly requested observation only", async () => {
    const coordinator = { bind: vi.fn() };
    const result = await dispatchDeterministicResolveGate({
      state: state("Inspect notes.md; do not modify anything."),
      request: resolveRequest(),
      toolNames: ["patch_files"],
      coordinator,
      alreadyAttempted: false,
    });

    expect(result).toMatchObject({
      kind: "rejected",
      repair: { code: "MODE_MUTATION_INTENT_REQUIRED" },
    });
    expect(coordinator.bind).not.toHaveBeenCalled();
  });

  it("enforces a scoped mutation boundary without treating it as a global mutation ban", async () => {
    const message = "Build the site in /tmp/site. Do not modify anything outside /tmp/site.";
    const coordinator = {
      bind: vi.fn(async () => ({
        status: "failed" as const,
        code: "FIXTURE_STOP",
        message: "Reached the coordinator.",
        retryable: false,
      })),
    };
    const inside = await dispatchDeterministicResolveGate({
      state: state(message, true),
      request: {
        ...resolveRequest(),
        mutationScopes: [{ kind: "filesystem", path: "/tmp/site/index.html" }],
      },
      toolNames: ["write_files"],
      coordinator,
      alreadyAttempted: false,
    });
    expect(inside).toMatchObject({ kind: "failed", attempted: true });
    expect(coordinator.bind).toHaveBeenCalledOnce();

    coordinator.bind.mockClear();
    const outside = await dispatchDeterministicResolveGate({
      state: state(message, true),
      request: {
        ...resolveRequest(),
        mutationScopes: [{ kind: "filesystem", path: "/tmp/other/index.html" }],
      },
      toolNames: ["write_files"],
      coordinator,
      alreadyAttempted: false,
    });
    expect(outside).toMatchObject({
      kind: "rejected",
      repair: {
        code: "MODE_MUTATION_INTENT_REQUIRED",
        blockedTargets: ["/tmp/other/index.html"],
      },
    });
    expect(coordinator.bind).not.toHaveBeenCalled();
  });

  it("requires current-run routing evidence and rejects invented evidence references", async () => {
    const coordinator = { bind: vi.fn() };
    const missing = await dispatchDeterministicResolveGate({
      state: state("Create notes.md."),
      request: resolveRequest(),
      toolNames: ["write_files"],
      coordinator,
      alreadyAttempted: false,
    });
    expect(missing).toMatchObject({
      kind: "rejected",
      repair: { code: "MODE_BINDING_PROPOSAL_UNVERIFIED" },
    });

    const observed = state("Create notes.md.", true);
    const invented = await dispatchDeterministicResolveGate({
      state: observed,
      request: {
        ...resolveRequest(),
        binding: {
          ...createProposal(),
          evidence: ["invented:evidence"],
        },
      },
      toolNames: ["write_files"],
      coordinator,
      alreadyAttempted: false,
    });
    expect(invented).toMatchObject({
      kind: "rejected",
      repair: {
        code: "MODE_BINDING_PROPOSAL_UNVERIFIED",
        blockedTargets: ["invented:evidence"],
      },
    });
    expect(coordinator.bind).not.toHaveBeenCalled();
  });

  it("passes one verified proposal to the coordinator and returns its bound context", async () => {
    const current = state("Create notes.md.", true);
    const context = {
      ...current.harnessContext.contextEngine!,
      contextRevision: "ctx:bound",
      current: {
        ...current.harnessContext.contextEngine!.current,
        routing: {
          status: "bound" as const,
          workstreamId: "W-20260722-0001",
          requestId: "R-0001",
        },
      },
    };
    const coordinator = {
      bind: vi.fn(async () => ({
        status: "resolved" as const,
        kind: "created_workstream" as const,
        workstreamId: "W-20260722-0001",
        requestId: "R-0001",
        context,
      })),
    };

    const result = await dispatchDeterministicResolveGate({
      state: current,
      request: resolveRequest(),
      toolNames: ["write_files"],
      coordinator,
      alreadyAttempted: false,
    });

    expect(result).toMatchObject({
      kind: "resolved",
      attempted: true,
      toolNames: ["write_files"],
      outcome: {
        workstreamId: "W-20260722-0001",
        requestId: "R-0001",
      },
    });
    expect(coordinator.bind).toHaveBeenCalledOnce();
    expect(coordinator.bind).toHaveBeenCalledWith(expect.objectContaining({
      purpose: "Bind the requested output.",
      referenceTargets: [],
      mutationScopes: ["notes.md"],
      proposal: createProposal(),
      expectedContextRevision: current.harnessContext.contextEngine?.contextRevision,
    }));
  });

  it("does not consume the binding attempt when ownership remains ambiguous", async () => {
    const coordinator = {
      bind: vi.fn(async () => ({
        status: "needs_user_input" as const,
        question: "Use the existing workstream or create a new independent one?",
        candidateIds: ["W-20260722-0001"],
      })),
    };

    const result = await dispatchDeterministicResolveGate({
      state: state("Create notes.md.", true),
      request: resolveRequest(),
      toolNames: ["write_files"],
      coordinator,
      alreadyAttempted: false,
    });

    expect(result).toMatchObject({
      kind: "needs_user_input",
      attempted: false,
      outcome: {
        candidateIds: ["W-20260722-0001"],
      },
    });
  });

  it("accepts activation only when the selected workstream and HEAD were observed", async () => {
    const current = state("Update files in W-20260722-0001.", true);
    current.toolContext!.toolCalls![0]!.output = JSON.stringify({
      workstreams: [{
        workstreamId: "W-20260722-0001",
        head: "a".repeat(40),
        currentRequest: { id: "R-0001", status: "active" },
        discovery: { tier: "definite", reasons: ["exact_workstream_id"] },
      }],
      count: 1,
    });
    const coordinator = {
      bind: vi.fn(async () => ({
        status: "failed" as const,
        code: "FIXTURE_STOP",
        message: "The proposal reached the deterministic coordinator.",
        retryable: false,
      })),
    };

    const result = await dispatchDeterministicResolveGate({
      state: current,
      request: {
        to: "resolve",
        purpose: "Continue the exact observed workstream.",
        capabilities: ["file:write"],
        targets: ["W-20260722-0001"],
        binding: {
          kind: "activate",
          workstreamId: "W-20260722-0001",
          expectedWorkstreamHead: "a".repeat(40),
          requestDecision: {
            kind: "continue_current",
            requestId: "R-0001",
            reason: "Continue the exact active request returned by discovery.",
          },
          evidence: [ROUTING_REF],
        },
      },
      toolNames: ["write_files"],
      coordinator,
      alreadyAttempted: false,
    });

    expect(result).toMatchObject({ kind: "failed", attempted: true });
    expect(coordinator.bind).toHaveBeenCalledOnce();

    coordinator.bind.mockClear();
    const switched = await dispatchDeterministicResolveGate({
      state: current,
      request: {
        to: "resolve",
        purpose: "Switch from the exact observed active request.",
        capabilities: ["file:write"],
        targets: ["W-20260722-0001"],
        binding: {
          kind: "activate",
          workstreamId: "W-20260722-0001",
          expectedWorkstreamHead: "a".repeat(40),
          requestDecision: {
            kind: "defer_current_and_create",
            currentRequestId: "R-0001",
            title: "Add contact form",
            request: "Add a verified contact form.",
            acceptance: ["The contact form works."],
            constraints: [],
            reason: "The user explicitly prioritized a separate request.",
          },
          evidence: [ROUTING_REF],
        },
      },
      toolNames: ["write_files"],
      coordinator,
      alreadyAttempted: false,
    });
    expect(switched).toMatchObject({ kind: "failed", attempted: true });
    expect(coordinator.bind).toHaveBeenCalledOnce();

    coordinator.bind.mockClear();
    const unobserved = await dispatchDeterministicResolveGate({
      state: current,
      request: {
        to: "resolve",
        purpose: "Attempt to switch an unobserved request.",
        capabilities: ["file:write"],
        targets: ["W-20260722-0001"],
        binding: {
          kind: "activate",
          workstreamId: "W-20260722-0001",
          expectedWorkstreamHead: "a".repeat(40),
          requestDecision: {
            kind: "defer_current_and_create",
            currentRequestId: "R-0002",
            title: "Add contact form",
            request: "Add a verified contact form.",
            acceptance: ["The contact form works."],
            constraints: [],
            reason: "Attempt to switch without observing the current request.",
          },
          evidence: [ROUTING_REF],
        },
      },
      toolNames: ["write_files"],
      coordinator,
      alreadyAttempted: false,
    });
    expect(unobserved).toMatchObject({
      kind: "rejected",
      repair: {
        code: "MODE_BINDING_PROPOSAL_UNVERIFIED",
        blockedTargets: ["R-0002"],
        message: expect.stringContaining("exact active request"),
        allowedNextActions: [
          expect.stringContaining("Inspect the exact request"),
        ],
      },
    });
    expect(coordinator.bind).not.toHaveBeenCalled();
  });

  it("never invokes the coordinator after the run has attempted binding", async () => {
    const coordinator = { bind: vi.fn() };
    const result = await dispatchDeterministicResolveGate({
      state: state("Create notes.md.", true),
      request: resolveRequest(),
      toolNames: ["write_files"],
      coordinator,
      alreadyAttempted: true,
    });

    expect(result).toMatchObject({
      kind: "rejected",
      repair: { code: "MODE_RESOLUTION_UNAVAILABLE" },
    });
    expect(coordinator.bind).not.toHaveBeenCalled();
  });
});

function resolveRequest() {
  return {
    to: "resolve" as const,
    purpose: "Bind the requested output.",
    capabilities: ["file:write"],
    targets: ["notes.md"],
    binding: createProposal(),
  };
}

function createProposal() {
  return {
    kind: "create" as const,
    title: "Create notes",
    objective: "Create and verify the requested notes file.",
    initialRequest: {
      title: "Create notes",
      request: "Create notes.md.",
      acceptance: ["notes.md exists and is verified."],
      constraints: [],
    },
    resources: [],
    evidence: [ROUTING_REF],
  };
}

function state(message: string, observed = false): LoopState {
  const contextEngine = contextEngineFixture({ runId: "RUN-1", message });
  return {
    runId: "RUN-1",
    currentSeq: 1,
    inputKind: "user_message",
    userMessage: message,
    workState: {
      status: "in_progress",
      summary: "Run started.",
      plan: [],
      importantContext: [],
    },
    workStateRuntime: {
      revision: 0,
      afterStep: 0,
      updateReason: "initial",
    },
    status: "running",
    finalOutput: "",
    iteration: observed ? 2 : 0,
    maxIterations: 20,
    consecutiveFailures: 0,
    completedSteps: [],
    runPath: "",
    failureHistory: [],
    virtualMode: createEntryVirtualModeState(),
    ...(observed
      ? {
          toolContext: {
            recent: [],
            toolCalls: [{
              step: 1,
              callId: "find-owner",
              tool: "git_context_find_workstreams",
              purpose: "Find the current owner.",
              input: { query: "notes.md" },
              status: "success" as const,
              output: JSON.stringify({ workstreams: [], count: 0 }),
              evidenceRef: ROUTING_REF,
              stepRef: { runId: "RUN-1", step: 1, callId: "find-owner" },
            }],
          },
        }
      : {}),
    harnessContext: {
      contextEngine: {
        ...contextEngine,
        current: {
          ...contextEngine.current,
          runId: "RUN-1",
          routing: { status: "unbound" },
        },
      },
    },
  };
}
