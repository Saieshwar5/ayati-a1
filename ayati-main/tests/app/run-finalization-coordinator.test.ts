import { describe, expect, it, vi } from "vitest";
import type { FinalizeRunResponse } from "ayati-context-engine";
import {
  finalizeAgentRun,
  isWorkstreamBoundRun,
} from "../../src/app/run-finalization-coordinator.js";
import { buildAgentRunFinalizationProjection } from "../../src/app/run-finalization-projection.js";
import type {
  ContextEnginePreparedTurn,
  ContextEngineRuntime,
} from "../../src/app/context-engine-runtime.js";
import type { AgentLoopResult } from "../../src/ivec/types.js";
import { contextEngineFixture } from "../fixtures/agent-context.js";

describe("run finalization coordinator", () => {
  it("finalizes a direct zero-step run through the single durable path", async () => {
    const finalizeRun = vi.fn(async () => finalizationResponse("R-direct"));
    const result = directResult("R-direct");

    const response = await finalizeAgentRun({
      runtime: runtime(finalizeRun),
      turn: preparedTurn("R-direct", false),
      result,
      at: "2026-07-19T10:01:00.000Z",
    });

    expect(response.run.runId).toBe("R-direct");
    expect(finalizeRun).toHaveBeenCalledTimes(1);
    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({
      turn: expect.objectContaining({ run: expect.objectContaining({ runId: "R-direct" }) }),
      outcome: "done",
      stopReason: "completed",
      assistantResponse: "A direct answer.",
      validation: "not_applicable",
    }));
    expect(finalizeRun.mock.calls[0]?.[0]).not.toHaveProperty("workstreamCompletion");
  });

  it("loads workstream ownership from run context and sends accepted resource evidence", async () => {
    const finalizeRun = vi.fn(async () => finalizationResponse("R-workstream", true));
    const result = workstreamResult("R-workstream");

    await finalizeAgentRun({
      runtime: runtime(finalizeRun),
      turn: preparedTurn("R-workstream", true),
      result,
      at: "2026-07-19T10:01:00.000Z",
    });

    expect(isWorkstreamBoundRun(preparedTurn("R-workstream", true), result)).toBe(true);
    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "done",
      validation: "passed",
      workstreamCompletion: expect.objectContaining({
        accepted: true,
        resources: [{
          locator: { kind: "filesystem", path: "/ayati/workspace/site/index.html" },
          kind: "file",
          role: "deliverable",
          description: "Generated homepage",
          aliases: ["homepage"],
          verified: true,
        }],
      }),
    }));
  });

  it("preserves the assistant reply while compacting its durable finalization projection", async () => {
    const finalizeRun = vi.fn(async () => finalizationResponse("R-clarification", true));
    const question = "Which durable resource should own this output? " + "detail ".repeat(400);
    const result = clarificationResult("R-clarification", question);

    await finalizeAgentRun({
      runtime: runtime(finalizeRun),
      turn: preparedTurn("R-clarification", true),
      result,
      at: "2026-07-19T10:01:00.000Z",
    });

    const request = finalizeRun.mock.calls[0]?.[0];
    expect(request).toBeDefined();
    expect(request?.assistantResponse).toBe(question);
    expect(request?.streamSummary.length).toBeLessThanOrEqual(2_000);
    expect(request?.summary.length).toBeLessThanOrEqual(2_000);
    expect(request?.next.length).toBeLessThanOrEqual(1_000);
    expect(request?.workState.userInputNeeded.length).toBeLessThanOrEqual(500);
    expect(request?.workstreamCompletion.criteria[0]?.evidence?.length).toBeLessThanOrEqual(2_000);
  });

  it("omits a redundant primary directory when exact child deliverables are present", () => {
    const result = workstreamResult("R-specific-deliverables");
    result.verifiedCompletionResources = [{
      resourceId: "RES-PRIMARY",
      role: "deliverable",
      kind: "directory",
      origin: "agent_created",
      displayName: "site",
      description: "Primary website directory",
      aliases: ["site"],
      locator: { kind: "filesystem", path: "/ayati/workspace/site" },
    }, ...result.verifiedCompletionResources!];

    const projection = buildAgentRunFinalizationProjection({
      result,
      workstreamBound: true,
    });

    expect(projection.workstreamCompletion?.resources).toEqual([expect.objectContaining({
      locator: { kind: "filesystem", path: "/ayati/workspace/site/index.html" },
      kind: "file",
      role: "deliverable",
    })]);
  });

  it("does not acknowledge a run when durable finalization fails", async () => {
    const finalizeRun = vi.fn(async () => {
      throw new Error("final commit failed");
    });

    await expect(finalizeAgentRun({
      runtime: runtime(finalizeRun),
      turn: preparedTurn("R-failed", false),
      result: directResult("R-failed"),
      at: "2026-07-19T10:01:00.000Z",
    })).rejects.toThrow("final commit failed");
    expect(finalizeRun).toHaveBeenCalledTimes(1);
  });
});

function runtime(finalizeRun: ReturnType<typeof vi.fn>): ContextEngineRuntime {
  return { finalizeRun } as unknown as ContextEngineRuntime;
}

function preparedTurn(runId: string, bound: boolean): ContextEnginePreparedTurn {
  const contextEngine = contextEngineFixture({ runId, message: "Build the page" });
  return {
    status: "ready",
    streamId: "S-1",
    streamCreated: false,
    messageSequence: 1,
    currentMessageId: "M-1",
    inputRole: "user",
    run: {
      runId,
      streamId: "S-1",
      triggerSeq: 1,
    },
    context: {
      ...contextEngine,
      current: {
        ...contextEngine.current,
        routing: {
          status: bound ? "bound" : "unbound",
          ...(bound ? {
            workstreamId: "W-1",
            requestId: "REQ-1",
            branch: "main",
          } : {}),
        },
      },
      ...(bound ? {
        workstream: workstreamContext(),
      } : {}),
      focus: bound
        ? { status: "active", ref: "refs/heads/main", workstreamId: "W-1" }
        : { status: "none" },
    },
  };
}

function workstreamContext() {
  return {
    ref: "refs/heads/main",
    workstreamId: "W-1",
    title: "Website",
    objective: "Build the website.",
    summary: "The website is in progress.",
    workstreamStatus: "in_progress" as const,
    lifecycleStatus: "active" as const,
    repositoryHealth: "ready" as const,
    blockers: [],
    currentRequest: {
      id: "REQ-1",
      title: "Build website",
      status: "active" as const,
      request: "Build the website.",
      acceptance: [],
      constraints: [],
    },
    resources: [{
      resource: {
        resourceId: "RES-PRIMARY",
        kind: "directory" as const,
        origin: "agent_created" as const,
        displayName: "site",
        description: "Primary website directory",
        aliases: ["site"],
        locator: { kind: "filesystem" as const, path: "/ayati/workspace/site" },
        version: {
          key: "directory:test",
          observedAt: "2026-07-19T10:00:00.000Z",
          exists: true,
          kind: "directory" as const,
          entryCount: 1,
        },
        availability: "available" as const,
        metadataStatus: "enriched" as const,
        createdAt: "2026-07-19T10:00:00.000Z",
        updatedAt: "2026-07-19T10:00:00.000Z",
      },
      role: "primary" as const,
      access: "mutate" as const,
      primary: true,
      requestIds: ["REQ-1"],
      boundAt: "2026-07-19T10:00:00.000Z",
    }],
  };
}

function directResult(runId: string): AgentLoopResult {
  return {
    type: "reply",
    runId,
    outcome: "done",
    stopReason: "completed",
    content: "A direct answer.",
    status: "completed",
    totalIterations: 1,
    totalToolCalls: 0,
    runPath: "",
    workState: {
      status: "done",
      summary: "Answered directly.",
      openWork: [],
      blockers: [],
      verifiedFacts: [],
      evidence: [],
    },
  };
}

function workstreamResult(runId: string): AgentLoopResult {
  const result = directResult(runId);
  return {
    ...result,
    content: "Created the page.",
    workState: {
      ...result.workState!,
      summary: "Created the page.",
    },
    verifiedCompletionResources: [{
      resourceId: "RES-HOMEPAGE",
      role: "deliverable",
      kind: "file",
      origin: "agent_created",
      displayName: "index.html",
      description: "Generated homepage",
      aliases: ["homepage"],
      locator: { kind: "filesystem", path: "/ayati/workspace/site/index.html" },
    }],
    harnessContext: {
      personalMemorySnapshot: "",
      contextEngine: preparedTurn(runId, true).context,
    },
  };
}

function clarificationResult(runId: string, question: string): AgentLoopResult {
  const result = workstreamResult(runId);
  return {
    ...result,
    outcome: "needs_user_input",
    stopReason: "needs_user_input",
    content: question,
    workState: {
      ...result.workState!,
      status: "needs_user_input",
      summary: question,
      nextStep: question,
      userInputNeeded: question,
    },
    workstreamSummary: {
      runId,
      runPath: "",
      runStatus: "completed",
      workstreamStatus: "needs_user_input",
      summary: question,
      assistantResponse: question,
    },
  };
}

function finalizationResponse(runId: string, bound = false): FinalizeRunResponse {
  return {
    run: {
      runId,
      streamId: "S-1",
      trigger: "user",
      status: "done",
      stopReason: "completed",
      stepCount: 0,
      startedAt: "2026-07-19T10:00:00.000Z",
      completedAt: "2026-07-19T10:01:00.000Z",
      ...(bound ? {
        workstreamBinding: {
          workstreamId: "W-1",
          requestId: "REQ-1",
          boundAt: "2026-07-19T10:00:10.000Z",
        },
      } : {}),
    },
    observationRevision: "observations:empty",
    resourceEffects: { status: "none", events: [] },
    workstreamContextCommit: { status: "not_required" },
  };
}
