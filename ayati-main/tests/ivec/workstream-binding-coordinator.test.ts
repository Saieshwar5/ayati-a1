import type { ContextEngineService } from "ayati-context-engine";
import { describe, expect, it, vi } from "vitest";
import { createWorkstreamBindingCoordinator } from "../../src/ivec/workstream-binding/coordinator.js";

const NOW = "2026-07-22T12:00:00.000Z";
const WORKSTREAM_ID = "W-20260722-0001";
const HEAD = "a".repeat(40);

describe("workstream binding coordinator", () => {
  it("rechecks an exact candidate HEAD and activates it without a model dependency", async () => {
    const activateWorkstreamForRun = vi.fn(async () => ({
      run: {
        runId: "RUN-1",
        streamId: "S-1",
        workstreamBinding: {
          workstreamId: WORKSTREAM_ID,
          requestId: "R-0001",
          boundAt: NOW,
        },
      },
    }));
    const service = {
      getAgentContext: vi.fn()
        .mockResolvedValueOnce(agentContext(false))
        .mockResolvedValueOnce(agentContext(true)),
      findWorkstreams: vi.fn(async () => ({ workstreams: [candidate("definite")] })),
      activateWorkstreamForRun,
    } as unknown as ContextEngineService;
    const coordinator = createWorkstreamBindingCoordinator({
      service,
      runId: "RUN-1",
      streamId: "S-1",
      currentInput: `Continue ${WORKSTREAM_ID}.`,
      now: () => new Date(NOW),
    });

    const result = await coordinator.bind({
      purpose: "Continue the exact workstream.",
      targets: [WORKSTREAM_ID],
      expectedContextRevision: "ctx:unbound",
      proposal: {
        kind: "activate",
        workstreamId: WORKSTREAM_ID,
        expectedWorkstreamHead: HEAD,
        requestDecision: {
          kind: "continue",
          requestId: "R-0001",
          reason: "The user explicitly continued the active request.",
        },
        evidence: ["run:RUN-1:step:1:call:read-owner"],
      },
    });

    expect(result).toMatchObject({
      status: "resolved",
      kind: "activated_workstream",
      workstreamId: WORKSTREAM_ID,
      requestId: "R-0001",
      context: {
        current: {
          runId: "RUN-1",
          routing: { status: "bound", workstreamId: WORKSTREAM_ID },
        },
      },
    });
    expect(activateWorkstreamForRun).toHaveBeenCalledWith({
      requestId: "RUN-1:deterministic-bind",
      runId: "RUN-1",
      workstreamId: WORKSTREAM_ID,
      expectedWorkstreamHead: HEAD,
      route: {
        kind: "continue_active_request",
        requestId: "R-0001",
        reason: "The user explicitly continued the active request.",
      },
      at: NOW,
    });
  });

  it("returns ambiguity instead of creating when authoritative ownership is strong", async () => {
    const createWorkstreamForRun = vi.fn();
    const service = {
      getAgentContext: vi.fn(async () => agentContext(false)),
      findWorkstreams: vi.fn(async () => ({ workstreams: [candidate("probable")] })),
      createWorkstreamForRun,
    } as unknown as ContextEngineService;
    const coordinator = createWorkstreamBindingCoordinator({
      service,
      runId: "RUN-1",
      streamId: "S-1",
      currentInput: "Update the website.",
    });

    const result = await coordinator.bind({
      purpose: "Bind website ownership.",
      targets: ["website"],
      expectedContextRevision: "ctx:unbound",
      proposal: {
        kind: "create",
        title: "Website",
        objective: "Update the website.",
        initialRequest: {
          title: "Update website",
          request: "Update the website.",
          acceptance: ["The website update is verified."],
          constraints: [],
        },
        resources: [],
        evidence: ["run:RUN-1:step:1:call:find-owner"],
      },
    });

    expect(result).toMatchObject({
      status: "needs_user_input",
      candidateIds: [WORKSTREAM_ID],
      question: expect.stringContaining(WORKSTREAM_ID),
    });
    expect(createWorkstreamForRun).not.toHaveBeenCalled();
  });

  it("fails before lifecycle mutation when the authoritative revision changed", async () => {
    const findWorkstreams = vi.fn();
    const service = {
      getAgentContext: vi.fn(async () => agentContext(false)),
      findWorkstreams,
    } as unknown as ContextEngineService;
    const coordinator = createWorkstreamBindingCoordinator({
      service,
      runId: "RUN-1",
      streamId: "S-1",
      currentInput: "Create notes.md.",
    });

    const result = await coordinator.bind({
      purpose: "Bind notes output.",
      targets: ["notes.md"],
      expectedContextRevision: "ctx:stale",
      proposal: {
        kind: "create",
        title: "Notes",
        objective: "Create notes.md.",
        initialRequest: {
          title: "Create notes",
          request: "Create notes.md.",
          acceptance: ["notes.md exists."],
          constraints: [],
        },
        resources: [],
        evidence: ["run:RUN-1:step:1:call:find-owner"],
      },
    });

    expect(result).toMatchObject({
      status: "failed",
      code: "WORKSTREAM_BINDING_CONTEXT_STALE",
      retryable: true,
    });
    expect(findWorkstreams).not.toHaveBeenCalled();
  });
});

function candidate(tier: "probable" | "definite") {
  return {
    workstreamId: WORKSTREAM_ID,
    title: "Website",
    objective: "Build and maintain the website.",
    status: "active" as const,
    lifecycleStatus: "active" as const,
    repositoryHealth: "ready" as const,
    currentRequest: { id: "R-0001", title: "Update website", status: "active" as const },
    head: HEAD,
    primaryResources: [],
    updatedAt: NOW,
    discovery: { tier, reasons: ["exact_workstream_id" as const] },
    starred: false,
    boundRunsLast30Days: 1,
  };
}

function agentContext(bound: boolean) {
  return {
    contextRevision: bound ? "ctx:bound" : "ctx:unbound",
    streamRevision: "stream:1",
    observationRevision: "observations:empty",
    stream: {
      stream: {
        streamId: "S-1",
        agentId: "local",
        scopeKey: "default",
        lastMessageSequence: 1,
        lastRunSequence: 1,
        createdAt: NOW,
        updatedAt: NOW,
      },
      recentMessages: [{
        messageId: "M-1",
        streamId: "S-1",
        sequence: 1,
        role: "user" as const,
        content: "Continue the website.",
        runId: "RUN-1",
        at: NOW,
      }],
      recentWork: [],
      resources: { count: 0, recent: [] },
    },
    run: {
      run: {
        runId: "RUN-1",
        streamId: "S-1",
        status: "running" as const,
        trigger: "user" as const,
        startedAt: NOW,
        stepCount: 1,
        ...(bound
          ? {
              workstreamBinding: {
                workstreamId: WORKSTREAM_ID,
                requestId: "R-0001",
                boundAt: NOW,
              },
            }
          : {}),
      },
      workState: {
        runId: "RUN-1",
        revision: 1,
        afterStep: 1,
        status: "not_done" as const,
        summary: "",
        openWork: [],
        blockers: [],
        facts: [],
        evidence: [],
        artifacts: [],
        nextStep: null,
        userInputNeeded: [],
        updatedAt: NOW,
      },
      steps: [],
    },
    ...(bound
      ? {
          activeWorkstream: {
            workstream: {
              workstreamId: WORKSTREAM_ID,
              contextRepositoryPath: `/workstreams/${WORKSTREAM_ID}`,
              branch: "main",
              head: HEAD,
              title: "Website",
              objective: "Build and maintain the website.",
              status: "active" as const,
              createdByRunId: "RUN-1",
              createdAt: NOW,
              updatedAt: NOW,
            },
            title: "Website",
            objective: "Build and maintain the website.",
            summary: "Continue the website.",
            recentCommits: [],
            workstreamStatus: "in_progress" as const,
            lifecycleStatus: "active" as const,
            repositoryHealth: "ready" as const,
            blockers: [],
            currentRequest: {
              id: "R-0001",
              title: "Update website",
              status: "active" as const,
              request: "Update the website.",
              acceptance: ["The update is verified."],
              constraints: [],
            },
            resources: [],
          },
        }
      : {}),
    workstreamCandidates: [],
    ingressResources: [],
    observations: {
      revision: "observations:empty",
      inventory: [],
      discovery: [],
      evidence: [],
    },
    warnings: [],
  };
}
