import type { AgentContextProjection, ResourceRef } from "ayati-context-engine";
import { describe, expect, it } from "vitest";
import { buildContextEngineProjection } from "../../src/context-engine/index.js";
import type { AgentContextPack } from "../../src/ivec/agent-runner/context-pack.js";
import {
  projectAgentPromptContext,
  projectAgentStateViewForPrompt,
} from "../../src/ivec/agent-runner/prompt-context.js";
import { buildPromptToolCallsForRun } from "../../src/ivec/agent-runner/run-tool-call-context.js";
import { agentContextFixture } from "../fixtures/agent-context.js";

describe("context engine projection", () => {
  it("projects native workstream state and exact resource bindings", () => {
    const source = activeWorkstreamContext();
    const projection = buildContextEngineProjection(source);

    expect(projection).not.toHaveProperty("task");
    expect(projection).not.toHaveProperty("session");
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

  it("keeps workstream candidates and deterministic discovery reasons unchanged", () => {
    const source = agentContextFixture({ streamId: "S-20260714-local" });
    source.workstreamCandidates = Array.from({ length: 7 }, (_, index) => ({
      workstreamId: `W-20260714-000${index + 2}`,
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
    }));

    const projection = buildContextEngineProjection(source);

    expect(projection.workstreamCandidates?.[0]).toMatchObject({
      workstreamId: "W-20260714-0002",
      discovery: { reasons: ["exact_resource_id", "owned_resource"] },
      starred: true,
    });
    expect(projection.workstreamCandidates).toHaveLength(5);
    expect(projection.workstream).toBeUndefined();
  });

  it("mounts compact resolver metadata and suppresses candidates after binding", () => {
    const source = activeWorkstreamContext();
    source.workstreamCandidates = [{
      workstreamId: "W-20260714-0002",
      title: "Different workstream",
      objective: "Should not remain mounted after binding.",
      status: "active",
      head: "e".repeat(40),
      primaryResources: [],
      updatedAt: "2026-07-14T11:00:00.000Z",
      discovery: { tier: "candidate", reasons: ["recent"] },
      starred: false,
      boundRunsLast30Days: 0,
    }];
    source.workstreamResolution = {
      activityId: "WR-0123456789ABCDEF01234567",
      runId: source.run!.run.runId,
      status: "resolved",
      purpose: "Resolve the Aurora Coffee workstream.",
      stepCount: 2,
      result: {
        status: "resolved",
        kind: "continued_request",
        workstreamId: "W-20260714-0001",
        requestId: "REQ-1",
      },
      updatedAt: "2026-07-14T11:00:00.000Z",
    };

    const machine = buildContextEngineProjection(source);
    const pack = contextPack(machine);

    expect(machine.workstreamCandidates).toBeUndefined();
    expect(pack.work.candidates).toEqual([]);
    expect(pack.work.active?.workstreamId).toBe("W-20260714-0001");
    expect(pack.work.resolution).toMatchObject({
      status: "resolved",
      stepCount: 2,
      result: { requestId: "REQ-1" },
    });
  });

  it("separates temporal, stream, work, resource, observation, and run prompt lanes", () => {
    const source = activeWorkstreamContext();
    source.observations = {
      revision: "observations:read-1",
      inventory: [],
      discovery: [],
      evidence: [{
        observationId: "OBS-1",
        streamId: "S-20260714-local",
        sourceRunId: "RUN-1",
        sourceStep: 1,
        sourceCallId: "read-brief",
        kind: "evidence",
        queryKey: "read_files:brief",
        purpose: "Read the brief.",
        preview: "brief",
        retention: "evidence_only",
        resources: [{
          resourceId: "RES-0123456789ABCDEF01234567",
          versionKey: "version-1",
        }],
        createdAt: "2026-07-14T10:00:02.000Z",
      }],
    };
    const machine = buildContextEngineProjection(source);
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
        context: contextPack(machine),
        run: { toolCalls },
      }),
    });

    expect(Object.keys(prompt.context)).toEqual(expect.arrayContaining([
      "temporal",
      "current",
      "stream",
      "work",
      "resources",
      "observations",
      "run",
    ]));
    expect(prompt.context.resources.activeWorkstream[0]?.resource.locator).toEqual({
      kind: "filesystem",
      path: "/workspace/aurora-coffee-site",
    });
    expect(prompt.context.observations.evidence[0]).not.toHaveProperty("streamId");
    expect(prompt.context.observations.evidence[0]).not.toHaveProperty("sourceRunId");
    expect(prompt.context.run?.toolCalls?.[0]?.stepRef).toEqual({ step: 1, callId: "read-brief" });
  });

  it("never exposes context repository paths or an action-history lane to the model", () => {
    const machine = buildContextEngineProjection(activeWorkstreamContext());
    const prompt = projectAgentPromptContext({ context: contextPack(machine) });
    const encoded = JSON.stringify(prompt);

    expect(prompt).not.toHaveProperty("actions");
    expect(prompt.stream).not.toHaveProperty("repositoryPath");
    expect(encoded).not.toContain("/internal/workstreams/");
    expect(encoded).not.toContain("conversationId");
    expect(encoded).not.toContain("sessionId");
  });
});

function contextPack(context: ReturnType<typeof buildContextEngineProjection>): AgentContextPack {
  const recent = context.agentStream.recentMessages.map((message) => ({
    kind: message.role === "system_event" ? "system" as const : message.role,
    seq: message.sequence,
    timestamp: message.at,
    content: message.content,
    ...(message.runId === context.run?.run.runId && message.role !== "assistant"
      ? { current: true as const }
      : {}),
  }));
  return {
    temporal: { recent },
    current: {
      inputSeq: context.current.inputSeq ?? 1,
      runId: context.current.runId ?? "RUN-1",
      ...(context.current.routing ? {
        routing: {
          status: context.current.routing.status,
          ...(context.current.routing.workstreamId
            ? { workstreamId: context.current.routing.workstreamId }
            : {}),
          ...(context.current.routing.requestId
            ? { requestId: context.current.routing.requestId }
            : {}),
        },
      } : {}),
    },
    stream: {
      agentId: context.agentStream.meta.agentId,
      scopeKey: context.agentStream.meta.scopeKey,
      recentWork: context.agentStream.recentWork,
    },
    work: {
      candidates: context.workstreamCandidates ?? [],
      ...(context.workstream ? { active: context.workstream } : {}),
      ...(context.workstreamResolution ? { resolution: context.workstreamResolution } : {}),
    },
    resources: {
      stream: context.agentStream.resources,
      ingress: context.ingressResources ?? [],
      activeWorkstream: context.workstream?.resources ?? [],
    },
    observations: context.observations,
  };
}

function activeWorkstreamContext(): AgentContextProjection {
  const boundResource = resource("/workspace/aurora-coffee-site");
  const source = agentContextFixture({ streamId: "S-20260714-local" });
  return {
    ...source,
    stream: {
      ...source.stream!,
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
      ...source.run!,
      run: {
        ...source.run!.run,
        workstreamBinding: {
          workstreamId: "W-20260714-0001",
          requestId: "REQ-1",
          boundAt: "2026-07-14T10:00:01.000Z",
        },
      },
    },
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
