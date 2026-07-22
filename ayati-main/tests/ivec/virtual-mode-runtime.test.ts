import { describe, expect, it, vi } from "vitest";
import type { ContextEngineMachineContext } from "../../src/context-engine/index.js";
import {
  buildVirtualCapabilitySummary,
  collectVirtualModeTargetEvidence,
  directResponseRepair,
  dispatchVirtualModeTransition,
  dispatchVirtualValidation,
} from "../../src/ivec/agent-runner/virtual-mode-runtime.js";
import {
  createEntryVirtualModeState,
  type ModeTransitionRequest,
} from "../../src/ivec/agent-runner/virtual-mode.js";
import { deriveTurnMutationConstraints } from "../../src/ivec/agent-runner/turn-intent-policy.js";
import type { LoopState } from "../../src/ivec/types.js";
import { isObservationalTool } from "../../src/skills/tool-taxonomy.js";
import type { ToolDefinition } from "../../src/skills/types.js";
import { contextEngineFixture } from "../fixtures/agent-context.js";

const READ_TOOL = tool("read_files");
const FIND_TOOL = tool("find_files");
const SEARCH_TOOL = tool("search_in_files");
const PATCH_TOOL = tool("patch_files");
const WRITE_TOOL = tool("write_files");

describe("virtual mode runtime", () => {
  it("builds a compact exact capability catalog without a working-set manager", () => {
    expect(buildVirtualCapabilitySummary([READ_TOOL, WRITE_TOOL])).toBe(
      "Available capability groups: file:create, file:read, file:refactor, file:verify, file:write.",
    );
  });

  it("accepts exact current-input targets and rejects invented investigation targets", async () => {
    const known = state("Read /tmp/known.md and summarize it.");
    const accepted = await transition(known, {
      to: "observe.investigate",
      purpose: "Read the exact requested file.",
      capabilities: ["file:read"],
      targets: ["/tmp/known.md"],
    }, [READ_TOOL]);
    expect(accepted).toMatchObject({ kind: "applied", active: "observe.investigate" });

    const invented = await transition(state("Read /tmp/known.md and summarize it."), {
      to: "observe.investigate",
      purpose: "Read an invented file.",
      capabilities: ["file:read"],
      targets: ["/tmp/invented.md"],
    }, [READ_TOOL]);
    expect(invented).toMatchObject({
      kind: "rejected",
      repair: {
        code: "MODE_TARGET_UNVERIFIED",
        blockedTargets: ["/tmp/invented.md"],
      },
    });
  });

  it("allows successful locate evidence to ground a later investigation target", async () => {
    const current = state("Find the requested notes file in the workspace.");
    current.virtualMode = {
      active: "observe.locate",
      revision: 1,
      purpose: "Find the notes file.",
      capabilities: ["file:search"],
      targets: [],
      enteredAtIteration: 1,
    };
    current.toolContext = {
      recent: [],
      toolCalls: [{
        step: 1,
        callId: "find-1",
        tool: "find_files",
        purpose: "Find the notes file",
        input: { query: "notes" },
        status: "success",
        output: "/tmp/discovered-notes.md",
      }],
    };

    expect(collectVirtualModeTargetEvidence(current)).toContain("/tmp/discovered-notes.md");
    await expect(transition(current, {
      to: "observe.investigate",
      purpose: "Read the located notes file.",
      capabilities: ["file:read"],
      targets: ["/tmp/discovered-notes.md"],
    }, [READ_TOOL])).resolves.toMatchObject({
      kind: "applied",
      active: "observe.investigate",
    });
  });

  it("filters mixed capabilities to read-only tools in observation modes", async () => {
    const current = state("Find config.ts before changing it.");
    const result = await transition(current, {
      to: "observe.locate",
      purpose: "Locate the configuration source.",
      capabilities: ["file:refactor"],
    }, [FIND_TOOL, SEARCH_TOOL, READ_TOOL, PATCH_TOOL, WRITE_TOOL]);

    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") return;
    expect(result.toolNames).toEqual(expect.arrayContaining(["find_files", "search_in_files", "read_files"]));
    expect(result.toolNames.every(isObservationalTool)).toBe(true);
    expect(result.toolNames).not.toContain("patch_files");
    expect(result.toolNames).not.toContain("write_files");
  });

  it("requires mutation intent and a binding-required capability at resolve", async () => {
    const readOnly = await transition(state("Inspect /tmp/output.txt; do not modify anything."), {
      to: "resolve",
      purpose: "Try to write despite the read-only request.",
      capabilities: ["file:write"],
      targets: ["/tmp/output.txt"],
    }, [WRITE_TOOL]);
    expect(readOnly).toMatchObject({
      kind: "rejected",
      repair: { code: "MODE_MUTATION_INTENT_REQUIRED" },
    });

    const observationalCapability = await transition(state("Create /tmp/output.txt."), {
      to: "resolve",
      purpose: "Resolve with a read-only capability.",
      capabilities: ["file:read"],
      targets: ["/tmp/output.txt"],
    }, [READ_TOOL]);
    expect(observationalCapability).toMatchObject({
      kind: "rejected",
      repair: { code: "MODE_BINDING_REQUIRED" },
    });
  });

  it("resolves once and enters execute mechanically after authoritative binding", async () => {
    const current = state("Create /tmp/output.txt.");
    current.toolContext = {
      recent: [],
      toolCalls: [{
        step: 1,
        callId: "routing-1",
        tool: "git_context_find_workstreams",
        purpose: "Check existing ownership before creating a workstream.",
        input: { query: "Create /tmp/output.txt", paths: ["/tmp/output.txt"] },
        status: "success",
        output: JSON.stringify({ workstreams: [], count: 0 }),
        evidenceRef: "evidence:routing-1",
      }],
    };
    const bound = boundContext(current.harnessContext.contextEngine!);
    const coordinator = {
      bind: vi.fn(async () => ({
        status: "resolved" as const,
        kind: "created_workstream" as const,
        workstreamId: "W-20260722-0001",
        requestId: "R-1",
        context: bound,
      })),
    };

    const result = await dispatchVirtualModeTransition({
      state: current,
      request: {
        to: "resolve",
        purpose: "Bind the exact output before writing.",
        capabilities: ["file:write"],
        targets: ["/tmp/output.txt"],
        binding: {
          kind: "create",
          title: "Create output file",
          objective: "Create the exact output requested by the user.",
          initialRequest: {
            title: "Create output",
            request: "Create /tmp/output.txt.",
            acceptance: ["The requested file exists."],
            constraints: [],
          },
          resources: [],
          evidence: ["evidence:routing-1"],
        },
      },
      iteration: 1,
      toolDefinitions: [WRITE_TOOL],
      toolContext: { runId: "RUN-1", stepNumber: 1 },
      workstreamBinding: coordinator,
      bindingAlreadyAttempted: false,
      applyContext(context) {
        current.harnessContext.contextEngine = context;
      },
    });

    expect(result).toMatchObject({
      kind: "resolved",
      active: "execute",
      toolNames: ["write_files"],
    });
    expect(coordinator.bind).toHaveBeenCalledOnce();
    expect(current.virtualMode).toMatchObject({
      active: "execute",
      revision: 2,
      capabilities: ["file:write"],
      targets: ["/tmp/output.txt"],
    });
  });

  it("enters execute from ENTRY when the run is already authoritatively bound", async () => {
    const current = state("Update /tmp/output.txt.");
    current.harnessContext.contextEngine = boundContext(current.harnessContext.contextEngine!);

    const result = await transition(current, {
      to: "resolve",
      purpose: "Use the existing authoritative binding before updating the file.",
      capabilities: ["file:write"],
      targets: ["/tmp/output.txt"],
    }, [WRITE_TOOL]);

    expect(result).toMatchObject({
      kind: "resolved",
      active: "execute",
      binding: { kind: "not_required", attempted: false },
      toolNames: ["write_files"],
    });
    expect(current.virtualMode.active).toBe("execute");
  });

  it("preserves mode and WorkState when validation is rejected", async () => {
    const current = observationState();
    const beforeMode = structuredClone(current.virtualMode);
    const beforeWorkState = structuredClone(current.workState);

    const result = await dispatchVirtualValidation(current, {
      outcome: "completed",
      summary: "Claimed completion without evidence.",
      response: "The file says hello.",
    });

    expect(result).toMatchObject({
      accepted: false,
      repair: { code: "VALIDATION_EVIDENCE_MISSING" },
    });
    expect(current.virtualMode).toEqual(beforeMode);
    expect(current.workState).toEqual(beforeWorkState);
  });

  it("accepts evidence-backed completed, needs-input, blocked, and failed outcomes", async () => {
    const completed = observationState();
    completed.completedSteps.push(successfulReadStep());
    await expect(dispatchVirtualValidation(completed, {
      outcome: "completed",
      summary: "Read the requested file.",
      response: "The file contains the verified value.",
    })).resolves.toMatchObject({
      accepted: true,
      outcome: "completed",
      nextWorkState: { status: "done" },
    });

    const needsInput = state("Find the requested configuration.");
    needsInput.virtualMode = {
      active: "observe.locate",
      revision: 1,
      purpose: "Locate the configuration.",
      capabilities: ["file:search"],
      targets: [],
    };
    await expect(dispatchVirtualValidation(needsInput, {
      outcome: "needs_user_input",
      summary: "The target is ambiguous.",
      response: "Which configuration file should I inspect?",
    })).resolves.toMatchObject({
      accepted: true,
      outcome: "needs_user_input",
      nextWorkState: { status: "needs_user_input" },
    });

    const blocked = observationState();
    blocked.failureHistory.push({
      step: 1,
      failureType: "permission",
      reason: "Permission denied.",
      blockedTargets: ["/tmp/known.md"],
    });
    await expect(dispatchVirtualValidation(blocked, {
      outcome: "blocked",
      summary: "Access is blocked.",
      response: "I cannot read the file without access.",
    })).resolves.toMatchObject({
      accepted: true,
      outcome: "blocked",
      nextWorkState: { status: "blocked" },
    });

    const failed = observationState();
    failed.failureHistory.push({
      step: 1,
      failureType: "tool_error",
      reason: "Read failed.",
      blockedTargets: ["/tmp/known.md"],
    });
    await expect(dispatchVirtualValidation(failed, {
      outcome: "failed",
      summary: "The read failed.",
      response: "I could not read the requested file.",
    })).resolves.toMatchObject({
      accepted: true,
      outcome: "failed",
      nextWorkState: { status: "not_done" },
    });
  });

  it("allows tool-free conversation while guarding explicit unperformed work", () => {
    expect(directResponseRepair(state("Hello!"))).toBeUndefined();
    expect(directResponseRepair(state("What is Newton's first law?"))).toBeUndefined();
    expect(directResponseRepair(state("What is a file descriptor?"))).toBeUndefined();
    expect(directResponseRepair(state("How do I create a file in TypeScript?"))).toBeUndefined();
    expect(directResponseRepair(state("Where is France?"))).toBeUndefined();
    expect(directResponseRepair(state("Where is upload handling?"))).toMatchObject({
      code: "DIRECT_RESPONSE_REQUIRES_MODE",
    });
    expect(directResponseRepair(state("Read /tmp/known.md."))).toMatchObject({
      code: "DIRECT_RESPONSE_REQUIRES_MODE",
    });
    expect(directResponseRepair(state("Create /tmp/output.txt."))).toMatchObject({
      code: "DIRECT_RESPONSE_REQUIRES_MODE",
    });

    const active = observationState();
    expect(directResponseRepair(active)).toMatchObject({
      code: "TERMINAL_REQUIRES_VALIDATION",
    });
  });

  it("retains explicit no-change language as an authoritative constraint", () => {
    expect(deriveTurnMutationConstraints("Inspect this file but do not modify anything.")).toEqual({
      mutationForbidden: true,
      observationalOnly: true,
      mutationRequested: false,
      observationRequested: true,
    });
    expect(deriveTurnMutationConstraints("Read the file, then edit the heading.")).toMatchObject({
      mutationForbidden: false,
      mutationRequested: true,
      observationRequested: true,
    });
  });
});

async function transition(
  current: LoopState,
  request: ModeTransitionRequest,
  toolDefinitions: ToolDefinition[],
) {
  return await dispatchVirtualModeTransition({
    state: current,
    request,
    iteration: current.iteration + 1,
    toolDefinitions,
    toolContext: { runId: current.runId, stepNumber: current.iteration + 1 },
    bindingAlreadyAttempted: false,
    applyContext(context) {
      current.harnessContext.contextEngine = context;
    },
  });
}

function tool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} fixture`,
    inputSchema: { type: "object", properties: {} },
    async execute() {
      return { ok: true, output: `${name}-ok` };
    },
  };
}

function state(message: string): LoopState {
  const contextEngine = contextEngineFixture({ runId: "RUN-1", message });
  return {
    runId: "RUN-1",
    currentSeq: 1,
    inputKind: "user_message",
    userMessage: message,
    workState: {
      status: "not_done",
      summary: "",
      verifiedFacts: [],
      evidence: [],
    },
    status: "running",
    finalOutput: "",
    iteration: 0,
    maxIterations: 20,
    consecutiveFailures: 0,
    completedSteps: [],
    runPath: "",
    failureHistory: [],
    virtualMode: createEntryVirtualModeState(),
    harnessContext: {
      personalMemorySnapshot: "",
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

function observationState(): LoopState {
  const current = state("Read /tmp/known.md.");
  current.virtualMode = {
    active: "observe.investigate",
    revision: 1,
    purpose: "Read the exact file.",
    capabilities: ["file:read"],
    targets: ["/tmp/known.md"],
    enteredAtIteration: 1,
  };
  return current;
}

function successfulReadStep(): LoopState["completedSteps"][number] {
  return {
    step: 1,
    outcome: "success",
    summary: "Read /tmp/known.md.",
    newFacts: ["The file contains the verified value."],
    artifacts: [],
    toolsUsed: ["read_files"],
    toolSuccessCount: 1,
    toolFailureCount: 0,
    expectationCheckStatus: "passed",
    validationStatus: "passed",
  };
}

function boundContext(context: ContextEngineMachineContext): ContextEngineMachineContext {
  return {
    ...context,
    contextRevision: "ctx:bound",
    current: {
      ...context.current,
      routing: {
        status: "bound",
        workstreamId: "W-20260722-0001",
        requestId: "R-1",
      },
    },
  };
}
