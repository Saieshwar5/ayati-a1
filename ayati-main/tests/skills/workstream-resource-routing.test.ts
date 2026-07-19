import type { GitContextService, WorkstreamResourceBinding } from "ayati-git-context";
import { describe, expect, it, vi } from "vitest";
import { createGitContextSkill } from "../../src/skills/builtins/git-context/index.js";

const NOW = "2026-07-17T20:00:00+05:30";
const WORKSTREAM_ID = "W-20260717-0001";
const RESOURCE_ID = `RES-${"A".repeat(24)}`;

describe("model-facing workstream and resource routing", () => {
  it("creates durable context and a managed output resource on the prepared run", async () => {
    const selected = selectedResponse("initial", true);
    const createWorkstreamForRun = vi.fn(async () => selected);
    const service = {
      getActiveContext: vi.fn()
        .mockResolvedValueOnce(activeContext(false))
        .mockResolvedValueOnce(activeContext(true)),
      createWorkstreamForRun,
    } as unknown as GitContextService;
    const tool = createGitContextSkill({ service }).tools
      .find((candidate) => candidate.name === "git_context_create_workstream")!;

    const result = await tool.execute({
      title: "Durable research notes",
      objective: "Continue the research across sessions.",
      reason: "No existing workstream owns this subject.",
    }, executionContext("create-workstream"));

    expect(result.ok).toBe(true);
    expect(result.v2?.structuredContent).toMatchObject({
      status: "ready",
      mode: "created",
      workstreamId: WORKSTREAM_ID,
      contextRepositoryPath: workstream().contextRepositoryPath,
      requestDecision: "initial",
      requestId: "R-0001",
      resources: [expect.objectContaining({
        resource: expect.objectContaining({
          resourceId: RESOURCE_ID,
          locator: { kind: "filesystem", path: "/ayati/workspace/durable-research-notes" },
        }),
      })],
    });
    expect(createWorkstreamForRun).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "RUN-1:create-workstream:create-workstream",
      sessionId: "S-1",
      conversationId: "C-1",
      runId: "RUN-1",
      title: "Durable research notes",
      objective: "Continue the research across sessions.",
      at: NOW,
    }));
  });

  it("activates existing durable context with an explicit new-request decision", async () => {
    const activateWorkstreamForRun = vi.fn(async () => selectedResponse("create", false));
    const service = {
      getActiveContext: vi.fn()
        .mockResolvedValueOnce(activeContext(false))
        .mockResolvedValueOnce(activeContext(true)),
      activateWorkstreamForRun,
    } as unknown as GitContextService;
    const tool = createGitContextSkill({ service }).tools
      .find((candidate) => candidate.name === "git_context_activate_workstream")!;

    const result = await tool.execute({
      workstreamId: WORKSTREAM_ID,
      reason: "This is the next outcome for the same website.",
      requestDecision: {
        kind: "create",
        title: "Add menu",
        request: "Add the menu page.",
        acceptance: ["The menu page is verified."],
        constraints: ["Keep the existing design."],
      },
    }, executionContext("activate-workstream"));

    expect(result.ok).toBe(true);
    expect(result.v2?.structuredContent).toMatchObject({
      mode: "activated",
      workstreamId: WORKSTREAM_ID,
      requestDecision: "create",
      requestId: "R-0002",
      requestCreated: true,
    });
    expect(activateWorkstreamForRun).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "RUN-1:activate-workstream:activate-workstream",
      workstreamId: WORKSTREAM_ID,
      runId: "RUN-1",
      route: {
        kind: "create_active_request",
        reason: "This is the next outcome for the same website.",
        title: "Add menu",
        request: "Add the menu page.",
        acceptance: ["The menu page is verified."],
        constraints: ["Keep the existing design."],
      },
      at: NOW,
    }));
  });

  it("finds and opens durable work without binding the run", async () => {
    const candidate = workstreamCandidate();
    const findWorkstreams = vi.fn(async () => ({ workstreams: [candidate] }));
    const readWorkstream = vi.fn(async () => ({
      workstream: workstream(),
      context: workstreamContext(),
      opened: true as const,
    }));
    const service = { findWorkstreams, readWorkstream } as unknown as GitContextService;
    const tools = createGitContextSkill({ service }).tools;

    const found = await tools.find((tool) => tool.name === "git_context_find_workstreams")!
      .execute({ query: "website" }, executionContext("find"));
    const opened = await tools.find((tool) => tool.name === "git_context_read_workstream")!
      .execute({ workstreamId: WORKSTREAM_ID }, executionContext("open"));

    expect(found.ok).toBe(true);
    expect(found.v2?.structuredContent).toMatchObject({ count: 1, workstreams: [candidate] });
    expect(opened.ok).toBe(true);
    expect(findWorkstreams).toHaveBeenCalledWith(expect.objectContaining({
      query: "website",
      sessionId: "S-1",
    }));
    expect(readWorkstream).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "RUN-1:open:open-workstream",
      workstreamId: WORKSTREAM_ID,
      sessionId: "S-1",
      runId: "RUN-1",
    }));
  });

  it("registers an existing path as a resource without selecting ownership", async () => {
    const inspectResourceForRun = vi.fn(async () => ({
      resource: resourceBinding().resource,
      existing: false,
      mutationEligible: true,
      warnings: [],
    }));
    const service = { inspectResourceForRun } as unknown as GitContextService;
    const tool = createGitContextSkill({ service }).tools
      .find((candidate) => candidate.name === "git_context_inspect_resource")!;

    const result = await tool.execute({
      path: "/home/user/existing-project",
      kind: "directory",
      displayName: "Existing project",
      description: "Project referenced by the user.",
      aliases: ["website source"],
    }, executionContext("inspect-resource"));

    expect(result.ok).toBe(true);
    expect(inspectResourceForRun).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "RUN-1:inspect-resource:inspect-resource",
      sessionId: "S-1",
      runId: "RUN-1",
      locator: { kind: "filesystem", path: "/home/user/existing-project" },
      kind: "directory",
      origin: "user_reference",
      displayName: "Existing project",
      description: "Project referenced by the user.",
      aliases: ["website source"],
    }));
  });

  it("binds exact resources only after the run owns a workstream", async () => {
    const bindResourcesForRun = vi.fn(async () => ({
      workstreamId: WORKSTREAM_ID,
      runId: "RUN-1",
      bindings: [resourceBinding()],
    }));
    const service = {
      getActiveContext: vi.fn(async () => activeContext(true)),
      bindResourcesForRun,
    } as unknown as GitContextService;
    const tool = createGitContextSkill({ service }).tools
      .find((candidate) => candidate.name === "git_context_bind_resources")!;

    const result = await tool.execute({
      bindings: [{
        resourceId: RESOURCE_ID,
        role: "primary",
        access: "mutate",
        primary: true,
      }],
    }, executionContext("bind-resources"));

    expect(result.ok).toBe(true);
    expect(bindResourcesForRun).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "RUN-1:bind-resources:bind-resources",
      workstreamId: WORKSTREAM_ID,
      runId: "RUN-1",
      bindings: [{
        resourceId: RESOURCE_ID,
        role: "primary",
        access: "mutate",
        primary: true,
      }],
    }));
  });

  it("changes a star only when the current user explicitly requests it", async () => {
    const setWorkstreamStar = vi.fn(async () => ({ workstreamId: WORKSTREAM_ID, starred: true }));
    const explicit = activeContext(false, "Star this workstream.");
    const service = {
      getActiveContext: vi.fn(async () => explicit),
      setWorkstreamStar,
    } as unknown as GitContextService;
    const tool = createGitContextSkill({ service }).tools
      .find((candidate) => candidate.name === "git_context_set_workstream_star")!;

    const result = await tool.execute({
      workstreamId: WORKSTREAM_ID,
      starred: true,
      reason: "The user explicitly asked to star this workstream.",
    }, executionContext("star"));

    expect(result.ok).toBe(true);
    expect(setWorkstreamStar).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "RUN-1:star:set-star",
      workstreamId: WORKSTREAM_ID,
      starred: true,
      sessionId: "S-1",
      runId: "RUN-1",
    }));

    const autonomousService = {
      getActiveContext: vi.fn(async () => activeContext(false, "Continue the website.")),
      setWorkstreamStar: vi.fn(),
    } as unknown as GitContextService;
    const autonomousTool = createGitContextSkill({ service: autonomousService }).tools
      .find((candidate) => candidate.name === "git_context_set_workstream_star")!;
    const refused = await autonomousTool.execute({
      workstreamId: WORKSTREAM_ID,
      starred: true,
      reason: "This workstream looks important.",
    }, executionContext("star-autonomously"));

    expect(refused.ok).toBe(false);
    expect(autonomousService.setWorkstreamStar).not.toHaveBeenCalled();
  });
});

function executionContext(callId: string) {
  return { sessionId: "S-1", runId: "RUN-1", callId };
}

function workstream() {
  return {
    workstreamId: WORKSTREAM_ID,
    contextRepositoryPath: `/ayati/workstreams/${WORKSTREAM_ID}`,
    branch: "main",
    head: "a".repeat(40),
    title: "Website",
    objective: "Build and improve the website.",
    status: "active" as const,
    createdSessionId: "S-1",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function workstreamContext() {
  return {
    workstream: workstream(),
    title: "Website",
    objective: "Build and improve the website.",
    summary: "Continue the website.",
    recentCommits: [],
    workstreamStatus: "in_progress" as const,
    lifecycleStatus: "active" as const,
    repositoryHealth: "ready" as const,
    blockers: [],
    currentRequest: {
      id: "R-0002",
      title: "Add menu",
      status: "active" as const,
      request: "Add the menu page.",
      acceptance: ["The menu page is verified."],
      constraints: [],
    },
    resources: [resourceBinding()],
  };
}

function resourceBinding(): WorkstreamResourceBinding {
  return {
    resource: {
      resourceId: RESOURCE_ID,
      kind: "directory",
      origin: "agent_created",
      displayName: "Durable research notes",
      description: "User-visible output directory.",
      aliases: ["research output"],
      locator: { kind: "filesystem", path: "/ayati/workspace/durable-research-notes" },
      version: {
        key: "directory:test",
        observedAt: NOW,
        exists: true,
        kind: "directory",
        entryCount: 0,
      },
      availability: "available",
      metadataStatus: "enriched",
      createdAt: NOW,
      updatedAt: NOW,
    },
    role: "primary",
    access: "mutate",
    primary: true,
    requestIds: ["R-0002"],
    boundAt: NOW,
  };
}

function workstreamCandidate() {
  return {
    workstreamId: WORKSTREAM_ID,
    title: "Website",
    objective: "Build and improve the website.",
    status: "active" as const,
    lifecycleStatus: "active" as const,
    repositoryHealth: "ready" as const,
    currentRequest: { id: "R-0002", title: "Add menu", status: "active" as const },
    head: "a".repeat(40),
    primaryResources: [resourceBinding().resource],
    updatedAt: NOW,
    discovery: { tier: "probable" as const, reasons: ["text_match" as const] },
    starred: false,
    boundRunsLast30Days: 2,
  };
}

function selectedResponse(decision: "initial" | "create", created: boolean) {
  return {
    workstream: workstream(),
    run: {
      runId: "RUN-1",
      sessionId: "S-1",
      conversationId: "C-1",
      workstreamBinding: {
        workstreamId: WORKSTREAM_ID,
        requestId: decision === "initial" ? "R-0001" : "R-0002",
        boundAt: NOW,
      },
    },
    context: workstreamContext(),
    workstreamCreated: created,
    workstreamRequestDecision: decision,
    workstreamRequestStatus: "active" as const,
    workstreamRequestCreated: true,
    headBeforeSelection: "a".repeat(40),
    resourceBindings: [resourceBinding()],
  };
}

function activeContext(selected: boolean, userText = "Add the menu.") {
  return {
    contextRevision: "sha256:test",
    session: {
      session: {
        sessionId: "S-1",
        repositoryPath: "/ayati/.ayati/sessions/S-1",
        head: "b".repeat(40),
        date: "2026-07-17",
        timezone: "Asia/Kolkata",
        status: "open" as const,
      },
      summary: "",
      pendingConversation: [{
        conversationId: "C-1",
        sessionId: "S-1",
        sequence: 1,
        filePath: "conversation.md",
        status: "active" as const,
      }],
      pendingConversationContext: [{
        conversation: {
          conversationId: "C-1",
          sessionId: "S-1",
          sequence: 1,
          filePath: "conversation.md",
          status: "active" as const,
        },
        messages: [{
          messageId: "M-1",
          conversationId: "C-1",
          sessionSequence: 1,
          segmentSequence: 1,
          role: "user" as const,
          content: userText,
          at: NOW,
        }],
        contentHash: "sha256:test",
      }],
      pendingDigest: "",
      recentCommits: [],
      resources: { count: 1, recent: [resourceBinding().resource] },
    },
    run: {
      run: {
        runId: "RUN-1",
        sessionId: "S-1",
        conversationId: "C-1",
        status: "running" as const,
        trigger: "user" as const,
        startedAt: NOW,
        stepCount: 0,
        ...(selected ? {
          workstreamBinding: {
            workstreamId: WORKSTREAM_ID,
            requestId: "R-0002",
            boundAt: NOW,
          },
        } : {}),
      },
      workState: {
        runId: "RUN-1",
        revision: 0,
        afterStep: 0,
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
    ...(selected ? { activeWorkstream: workstreamContext() } : {}),
    workstreamCandidates: [],
    ingressResources: [],
    warnings: [],
  };
}
