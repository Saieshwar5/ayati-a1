import { describe, expect, it } from "vitest";
import type { ActiveContext, ResourceRef } from "ayati-git-context";
import { buildContextEngineProjection } from "../../src/context-engine/index.js";
import {
  projectAgentPromptContext,
  projectAgentStateViewForPrompt,
} from "../../src/ivec/agent-runner/prompt-context.js";
import { buildPromptToolCallsForRun } from "../../src/ivec/agent-runner/run-tool-call-context.js";

describe("context engine projection", () => {
  it("projects native workstream state and exact resource bindings", () => {
    const active = activeWorkstreamContext();
    const projection = buildContextEngineProjection(active);

    expect(projection).not.toHaveProperty("task");
    expect(projection).not.toHaveProperty("taskCandidates");
    expect(projection.workstream).toMatchObject({
      workstreamId: "W-20260714-0001",
      workstreamStatus: "in_progress",
      currentRequest: { id: "REQ-1", status: "active" },
    });
    expect(projection.workstream?.resources).toEqual([
      expect.objectContaining({
        resource: expect.objectContaining({
          resourceId: "RES-0123456789ABCDEF01234567",
          locator: { kind: "filesystem", path: "/workspace/aurora-coffee-site" },
        }),
        access: "mutate",
        primary: true,
      }),
    ]);
  });

  it("keeps workstream candidates and resource discovery reasons unchanged", () => {
    const active = activeWorkstreamContext();
    active.workstreamCandidates = [{
      workstreamId: "W-20260714-0002",
      title: "Machine learning course",
      objective: "Learn machine learning in bounded lessons.",
      status: "active",
      lifecycleStatus: "active",
      repositoryHealth: "ready",
      currentRequest: { id: "REQ-3", title: "Learn evaluation", status: "active" },
      head: "e".repeat(40),
      primaryResources: [resource("/workspace/learning/model-evaluation.md")],
      updatedAt: "2026-07-14T11:00:00.000Z",
      discovery: { tier: "definite", reasons: ["exact_resource_id", "owned_resource"] },
      starred: true,
      boundRunsLast30Days: 4,
    }];

    const projection = buildContextEngineProjection(active);

    expect(projection.workstreamCandidates?.[0]).toMatchObject({
      workstreamId: "W-20260714-0002",
      discovery: { reasons: ["exact_resource_id", "owned_resource"] },
      starred: true,
    });
  });

  it("exposes public resource locators while hiding run and storage identities from prompts", () => {
    const active = activeWorkstreamContext();
    active.readContext = {
      revision: "read-1",
      afterCommitRunId: "RUN-previous",
      inventory: [],
      discovery: [],
      evidence: [{
        key: "evidence:read_files:brief.md",
        runId: "RUN-1",
        step: 1,
        callId: "read-brief",
        tool: "read_files",
        purpose: "Read the brief.",
        resources: ["RES-0123456789ABCDEF01234567"],
        input: { path: "/workspace/aurora-coffee-site/brief.md" },
        output: "brief",
        verification: { passed: true },
        createdAt: "2026-07-14T10:00:02.000Z",
      }],
      actions: [],
    };
    const projection = buildContextEngineProjection(active);
    const toolCalls = buildPromptToolCallsForRun([{
      step: 1,
      callId: "read-brief",
      tool: "read_files",
      purpose: "Read the brief.",
      input: { path: "/workspace/aurora-coffee-site/brief.md" },
      status: "success",
      output: "brief",
      stepRef: { runId: "RUN-1", step: 1, callId: "read-brief" },
    }]);
    const prompt = projectAgentStateViewForPrompt({
      context: projectAgentPromptContext({
        context: { timeline: [], gitContext: projection },
        run: { toolCalls },
      }),
    });

    expect(prompt.context.git?.current.workstream?.resources[0]?.resource.locator).toEqual({
      kind: "filesystem",
      path: "/workspace/aurora-coffee-site",
    });
    expect(prompt.context.git?.current.workstream?.identity.workstreamId).toBe("W-20260714-0001");
    expect(prompt.context.git?.current.workstream).not.toHaveProperty("contextRepositoryPath");
    expect(prompt.context.git?.current.pendingTurn).not.toHaveProperty("runId");
    expect(prompt.context.git?.current.readContext).not.toHaveProperty("afterCommitRunId");
    expect(prompt.context.run?.toolCalls?.[0]?.stepRef).toEqual({ step: 1, callId: "read-brief" });
    expect(JSON.stringify(prompt.context)).not.toContain('"runId"');
    expect(JSON.stringify(prompt.context)).not.toContain("/internal/workstreams/");
  });

  it("does not reinterpret relative context-commit paths as deliverable paths", () => {
    const active = activeWorkstreamContext();
    if (!active.session) throw new Error("Expected a session fixture.");
    active.session.recentCommits = [{
      commit: "d".repeat(40),
      subject: "workstream: update context",
      committedAt: "2026-07-14T10:30:00.000Z",
      assets: [{ path: "index.html", description: "Relative legacy metadata" }],
      workstreamId: "W-20260714-0001",
      runId: "RUN-1",
    }];

    const prompt = projectAgentStateViewForPrompt({
      context: projectAgentPromptContext({
        context: { timeline: [], gitContext: buildContextEngineProjection(active) },
      }),
    });

    expect(prompt.context.git?.session.recentCommits?.[0]).toMatchObject({
      commit: "d".repeat(40),
      workstreamId: "W-20260714-0001",
    });
    expect(prompt.context.git?.session.recentCommits?.[0]).not.toHaveProperty("resources");
    expect(prompt.context.git?.session.recentCommits?.[0]).not.toHaveProperty("runId");
  });
});

function activeWorkstreamContext(): ActiveContext {
  const boundResource = resource("/workspace/aurora-coffee-site");
  return {
    contextRevision: "revision-1",
    session: {
      session: {
        sessionId: "S-20260714-local",
        repositoryPath: "/internal/sessions/2026-07-14",
        head: "a".repeat(40),
        date: "2026-07-14",
        timezone: "UTC",
        status: "open",
      },
      summary: "",
      pendingConversation: [{
        conversationId: "C-1",
        sessionId: "S-20260714-local",
        sequence: 1,
        filePath: "conversations/000001.pending.md",
        status: "active",
      }],
      pendingConversationContext: [{
        conversation: {
          conversationId: "C-1",
          sessionId: "S-20260714-local",
          sequence: 1,
          filePath: "conversations/000001.pending.md",
          status: "active",
        },
        messages: [],
        contentHash: "sha256:" + "b".repeat(64),
      }],
      pendingDigest: "digest",
      recentCommits: [],
      resources: { count: 1, recent: [boundResource] },
    },
    activeWorkstream: {
      workstream: {
        workstreamId: "W-20260714-0001",
        contextRepositoryPath: "/internal/workstreams/W-20260714-0001",
        branch: "main",
        head: "c".repeat(40),
      },
      title: "Aurora Coffee website",
      objective: "Build and maintain the website.",
      summary: "Homepage implementation is in progress.",
      recentCommits: [],
      workstreamStatus: "in_progress",
      lifecycleStatus: "active",
      repositoryHealth: "ready",
      currentFocus: "Build the homepage.",
      blockers: [],
      next: "Verify responsive styling.",
      currentRequest: {
        id: "REQ-1",
        title: "Build homepage",
        status: "active",
        request: "Create the Aurora Coffee homepage.",
        acceptance: ["Responsive homepage exists."],
        constraints: [],
      },
      resources: [{
        resource: boundResource,
        role: "primary",
        access: "mutate",
        primary: true,
        requestIds: ["REQ-1"],
        boundAt: "2026-07-14T10:00:01.000Z",
      }],
    },
    run: {
      run: {
        runId: "RUN-1",
        sessionId: "S-20260714-local",
        conversationId: "C-1",
        workstreamBinding: {
          workstreamId: "W-20260714-0001",
          requestId: "REQ-1",
          boundAt: "2026-07-14T10:00:01.000Z",
        },
        status: "running",
        trigger: "user",
        startedAt: "2026-07-14T10:00:00.000Z",
        stepCount: 0,
      },
      workState: {
        runId: "RUN-1",
        revision: 0,
        afterStep: 0,
        status: "not_done",
        summary: "Homepage implementation is in progress.",
        openWork: [],
        blockers: [],
        facts: [],
        evidence: [],
        artifacts: [],
        nextStep: null,
        userInputNeeded: [],
        updatedAt: "2026-07-14T10:00:00.000Z",
      },
      steps: [],
    },
    warnings: [],
  };
}

function resource(path: string): ResourceRef {
  return {
    resourceId: "RES-0123456789ABCDEF01234567",
    kind: path.endsWith(".md") ? "document" : "directory",
    origin: "agent_created",
    displayName: path.split("/").pop() ?? path,
    description: "Primary Aurora Coffee website resource.",
    aliases: ["aurora site"],
    locator: { kind: "filesystem", path },
    version: {
      key: "version-1",
      observedAt: "2026-07-14T10:00:00.000Z",
      exists: true,
      kind: path.endsWith(".md") ? "file" : "directory",
    },
    availability: "available",
    metadataStatus: "enriched",
    createdAt: "2026-07-14T10:00:00.000Z",
    updatedAt: "2026-07-14T10:00:00.000Z",
  };
}
