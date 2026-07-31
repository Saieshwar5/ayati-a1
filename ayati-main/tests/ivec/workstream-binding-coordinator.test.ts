import {
  ContextEngineServiceError,
  type ContextEngineService,
} from "ayati-context-engine";
import { describe, expect, it, vi } from "vitest";
import { createWorkstreamBindingCoordinator } from "../../src/ivec/workstream-binding/coordinator.js";

const NOW = "2026-07-22T12:00:00.000Z";
const WORKSTREAM_ID = "W-20260722-0001";
const RESOURCE_ID = "RES-0123456789ABCDEF01234567";
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
      getWorkstream: vi.fn(async () => mutableResourceContext()),
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
      workspaceTargets: [],
      routingEvidence: [],
      expectedWorkstreamHead: HEAD,
      expectedContextRevision: "ctx:unbound",
      proposal: {
        kind: "activate",
        workstreamId: WORKSTREAM_ID,
        requestDecision: {
          kind: "continue_current",
          requestId: "R-0001",
          reason: "The user explicitly continued the active request.",
        },
        resourceIds: [RESOURCE_ID],
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
        kind: "continue_current",
        requestId: "R-0001",
        reason: "The user explicitly continued the active request.",
      },
      at: NOW,
    });
  });

  it("rejects a routed resource that is no longer mutable before activation", async () => {
    const activateWorkstreamForRun = vi.fn();
    const service = {
      getAgentContext: vi.fn(async () => agentContext(false)),
      findWorkstreams: vi.fn(async () => ({ workstreams: [candidate("definite")] })),
      getWorkstream: vi.fn(async () => ({
        context: {
          resources: [{
            resource: {
              resourceId: RESOURCE_ID,
              availability: "available",
            },
            access: "read",
          }],
        },
      })),
      activateWorkstreamForRun,
    } as unknown as ContextEngineService;
    const coordinator = createWorkstreamBindingCoordinator({
      service,
      runId: "RUN-1",
      streamId: "S-1",
      currentInput: `Update ${WORKSTREAM_ID}.`,
    });

    const result = await coordinator.bind({
      purpose: "Update the exact routed resource.",
      workspaceTargets: [],
      routingEvidence: ["run:RUN-1:step:1:call:find-resource"],
      expectedWorkstreamHead: HEAD,
      expectedContextRevision: "ctx:unbound",
      proposal: {
        kind: "activate",
        workstreamId: WORKSTREAM_ID,
        requestDecision: {
          kind: "continue_current",
          requestId: "R-0001",
          reason: "Continue the active request.",
        },
        resourceIds: [RESOURCE_ID],
      },
    });

    expect(result).toMatchObject({
      status: "failed",
      code: "WORKSTREAM_BINDING_RESOURCE_NOT_MUTABLE",
    });
    expect(activateWorkstreamForRun).not.toHaveBeenCalled();
  });

  it("maps an explicit switch to the exact active request and binds the new request", async () => {
    const activateWorkstreamForRun = vi.fn(async () => ({
      run: {
        runId: "RUN-1",
        streamId: "S-1",
        workstreamBinding: {
          workstreamId: WORKSTREAM_ID,
          requestId: "R-0002",
          boundAt: NOW,
        },
      },
    }));
    const service = {
      getAgentContext: vi.fn()
        .mockResolvedValueOnce(agentContext(false))
        .mockResolvedValueOnce(agentContext(true, "R-0002")),
      findWorkstreams: vi.fn(async () => ({ workstreams: [candidate("definite")] })),
      getWorkstream: vi.fn(async () => mutableResourceContext()),
      activateWorkstreamForRun,
    } as unknown as ContextEngineService;
    const coordinator = createWorkstreamBindingCoordinator({
      service,
      runId: "RUN-1",
      streamId: "S-1",
      currentInput: "Pause the website update and add the contact form now.",
      now: () => new Date(NOW),
    });

    const result = await coordinator.bind({
      purpose: "Switch to the explicitly prioritized website request.",
      workspaceTargets: [],
      routingEvidence: [],
      expectedWorkstreamHead: HEAD,
      expectedContextRevision: "ctx:unbound",
      proposal: {
        kind: "activate",
        workstreamId: WORKSTREAM_ID,
        requestDecision: {
          kind: "defer_current_and_create",
          currentRequestId: "R-0001",
          title: "Add contact form",
          request: "Add a verified contact form.",
          acceptance: ["The contact form works."],
          constraints: ["Preserve the existing design."],
          reason: "The user explicitly prioritized the contact form.",
        },
        resourceIds: [RESOURCE_ID],
      },
    });

    expect(result).toMatchObject({
      status: "resolved",
      kind: "activated_workstream",
      requestId: "R-0002",
    });
    expect(activateWorkstreamForRun).toHaveBeenCalledWith(expect.objectContaining({
      workstreamId: WORKSTREAM_ID,
      expectedWorkstreamHead: HEAD,
      route: {
        kind: "defer_current_and_create",
        currentRequestId: "R-0001",
        title: "Add contact form",
        request: "Add a verified contact form.",
        acceptance: ["The contact form works."],
        constraints: ["Preserve the existing design."],
        reason: "The user explicitly prioritized the contact form.",
      },
    }));
  });

  it("marks a rejected request route as a retryable no-change attempt", async () => {
    const activateWorkstreamForRun = vi.fn(async () => {
      throw new ContextEngineServiceError({
        code: "WORKSTREAM_CURRENT_REQUEST_INVALID",
        message: "Request route is not valid for the current lifecycle state.",
        retryable: true,
        details: {
          attemptDisposition: "retryable_no_change",
        },
      });
    });
    const service = {
      getAgentContext: vi.fn(async () => agentContext(false)),
      findWorkstreams: vi.fn(async () => ({ workstreams: [candidate("definite")] })),
      getWorkstream: vi.fn(async () => mutableResourceContext()),
      activateWorkstreamForRun,
    } as unknown as ContextEngineService;
    const coordinator = createWorkstreamBindingCoordinator({
      service,
      runId: "RUN-1",
      streamId: "S-1",
      currentInput: "Add testimonials to the website.",
      now: () => new Date(NOW),
    });

    const result = await coordinator.bind({
      purpose: "Apply the requested website update.",
      workspaceTargets: [],
      routingEvidence: [],
      expectedWorkstreamHead: HEAD,
      expectedContextRevision: "ctx:unbound",
      proposal: {
        kind: "activate",
        workstreamId: WORKSTREAM_ID,
        requestDecision: {
          kind: "activate_existing",
          requestId: "R-0001",
          reason: "Attempt to activate the already active request.",
        },
        resourceIds: [RESOURCE_ID],
      },
    });

    expect(result).toEqual({
      status: "failed",
      code: "WORKSTREAM_CURRENT_REQUEST_INVALID",
      message: "Request route is not valid for the current lifecycle state.",
      retryable: true,
      attemptDisposition: "retryable_no_change",
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
      workspaceTargets: [workspaceTarget("website", "/tmp/website", "directory")],
      routingEvidence: ["run:RUN-1:step:1:call:find-owner"],
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
      },
    });

    expect(result).toMatchObject({
      status: "needs_user_input",
      candidateIds: [WORKSTREAM_ID],
      question: expect.stringContaining("new independent workstream"),
    });
    expect(createWorkstreamForRun).not.toHaveBeenCalled();
  });

  it("honors an explicit create-new choice without pre-registering missing resources", async () => {
    const findWorkstreams = vi.fn(async () => ({ workstreams: [candidate("definite")] }));
    const inspectResourceForRun = vi.fn(async () => ({
      mutationEligible: true,
      resource: {
        resourceId: "RES-0123456789ABCDEF01234567",
        version: { exists: false, kind: "unversioned" },
      },
    }));
    const createWorkstreamForRun = vi.fn(async () => ({
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
      findWorkstreams,
      inspectResourceForRun,
      createWorkstreamForRun,
    } as unknown as ContextEngineService;
    const coordinator = createWorkstreamBindingCoordinator({
      service,
      runId: "RUN-1",
      streamId: "S-1",
      currentInput: "Create a new independent workstream for this website.",
      now: () => new Date(NOW),
    });

    const result = await coordinator.bind({
      purpose: "Create independent website ownership.",
      workspaceTargets: [workspaceTarget("site", "/tmp/site", "directory")],
      routingEvidence: ["run:RUN-1:step:1:call:find-owner"],
      expectedContextRevision: "ctx:unbound",
      proposal: {
        kind: "create",
        title: "Independent website",
        objective: "Build the website independently.",
        initialRequest: {
          title: "Build website",
          request: "Build the website in /tmp/site.",
          acceptance: ["The website is verified."],
          constraints: ["Do not modify anything outside /tmp/site."],
        },
      },
    });

    expect(result).toMatchObject({
      status: "resolved",
      kind: "created_workstream",
    });
    expect(findWorkstreams).not.toHaveBeenCalled();
    expect(inspectResourceForRun).not.toHaveBeenCalled();
    expect(createWorkstreamForRun).toHaveBeenCalledOnce();
    expect(createWorkstreamForRun.mock.calls[0]?.[0]).not.toHaveProperty("resources");
  });

  it("uses a typed workspace target as execution authority without registering it as a resource", async () => {
    const createWorkstreamForRun = vi.fn(async () => ({
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
      inspectResourceForRun: vi.fn(),
      createWorkstreamForRun,
    } as unknown as ContextEngineService;
    const coordinator = createWorkstreamBindingCoordinator({
      service,
      runId: "RUN-1",
      streamId: "S-1",
      currentInput: "Create a new independent workstream for this resource.",
      now: () => new Date(NOW),
    });

    const result = await coordinator.bind({
      purpose: "Create independent resource ownership.",
      workspaceTargets: [workspaceTarget("notes.md", "/tmp/notes.md", "file")],
      routingEvidence: ["run:RUN-1:step:1:call:find-owner"],
      expectedContextRevision: "ctx:unbound",
      proposal: {
        kind: "create",
        title: "Independent resource work",
        objective: "Update the requested resource.",
        initialRequest: {
          title: "Update resource",
          request: "Update the requested resource.",
          acceptance: ["The resource update is verified."],
          constraints: [],
        },
      },
    });

    expect(result).toMatchObject({ status: "resolved", kind: "created_workstream" });
    expect(createWorkstreamForRun).toHaveBeenCalledOnce();
    expect(createWorkstreamForRun.mock.calls[0]?.[0]).not.toHaveProperty("resources");
    expect(service.inspectResourceForRun).not.toHaveBeenCalled();
  });

  it("carries a create-new answer across runs from the durable exact conversation", async () => {
    const unbound = agentContext(false);
    unbound.stream.recentMessages = [
      ...unbound.stream.recentMessages,
      {
        messageId: "M-2",
        streamId: "S-1",
        sequence: 2,
        role: "assistant",
        content: "Should I create a new independent workstream, or use the existing match “Website”?",
        responseKind: "feedback",
        feedbackKind: "clarification",
        runId: "RUN-PRIOR",
        at: NOW,
      },
      {
        messageId: "M-3",
        streamId: "S-1",
        sequence: 3,
        role: "user",
        content: "Use the new one.",
        runId: "RUN-1",
        at: NOW,
      },
    ];
    const findWorkstreams = vi.fn(async () => ({ workstreams: [candidate("definite")] }));
    const createWorkstreamForRun = vi.fn(async () => ({
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
        .mockResolvedValueOnce(unbound)
        .mockResolvedValueOnce(agentContext(true)),
      findWorkstreams,
      inspectResourceForRun: vi.fn(async () => ({
        mutationEligible: true,
        resource: {
          resourceId: "RES-ABCDEF0123456789ABCDEF01",
          version: { exists: false, kind: "unversioned" },
        },
      })),
      createWorkstreamForRun,
    } as unknown as ContextEngineService;
    const coordinator = createWorkstreamBindingCoordinator({
      service,
      runId: "RUN-1",
      streamId: "S-1",
      currentInput: "Use the new one.",
      now: () => new Date(NOW),
    });

    const result = await coordinator.bind({
      purpose: "Apply the user's pending ownership choice.",
      workspaceTargets: [workspaceTarget("site", "/tmp/site", "directory")],
      routingEvidence: ["run:RUN-1:step:1:call:find-owner"],
      expectedContextRevision: "ctx:unbound",
      proposal: {
        kind: "create",
        title: "New website",
        objective: "Build the website in a separate workstream.",
        initialRequest: {
          title: "Build website",
          request: "Build the website.",
          acceptance: ["The website is verified."],
          constraints: [],
        },
      },
    });

    expect(result).toMatchObject({ status: "resolved", kind: "created_workstream" });
    expect(findWorkstreams).not.toHaveBeenCalled();
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
      workspaceTargets: [workspaceTarget("notes.md", "/tmp/notes.md", "file")],
      routingEvidence: ["run:RUN-1:step:1:call:find-owner"],
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

function workspaceTarget(
  relativePath: string,
  absolutePath: string,
  kind: "file" | "directory",
) {
  return { kind, relativePath, absolutePath };
}

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

function mutableResourceContext() {
  return {
    context: {
      resources: [{
        resource: {
          resourceId: RESOURCE_ID,
          availability: "available",
        },
        access: "mutate",
      }],
    },
  };
}

function agentContext(bound: boolean, requestId = "R-0001") {
  return {
    contextRevision: bound ? "ctx:bound" : "ctx:unbound",
    streamRevision: "stream:1",
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
      recentWorkstreams: [],
      recentFiles: [],
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
                requestId,
                boundAt: NOW,
              },
            }
          : {}),
      },
      workState: {
        runId: "RUN-1",
        revision: 1,
        afterStep: 1,
        status: "in_progress" as const,
        summary: "Run started.",
        plan: [],
        importantContext: [],
        nextAction: null,
        updateReason: "initial" as const,
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
              id: requestId,
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
    warnings: [],
  };
}
