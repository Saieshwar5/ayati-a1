import { describe, expect, it } from "vitest";
import { buildContextEngineEventSummary } from "../../src/ivec/context-engine-event-summary.js";
import { contextEngineFixture } from "../fixtures/agent-context.js";

describe("Context Engine event summary", () => {
  it("returns no summary when no Context Engine facts are available", () => {
    expect(buildContextEngineEventSummary({})).toBeUndefined();
  });

  it("projects the current route, focus, request, and resource count", () => {
    const context = boundContext();

    expect(buildContextEngineEventSummary({
      context,
      routeStatus: "ready",
      routeMode: "activated",
      routeSource: "deterministic_gate",
      finalizationStatus: "not_started",
      committed: false,
    })).toMatchObject({
      pendingTurnStatus: "bound",
      pendingTurnRange: { fromSeq: 1, toSeq: 1 },
      routeStatus: "ready",
      routeMode: "activated",
      routeSource: "deterministic_gate",
      workstreamId: "W-1",
      branch: "main",
      runId: "run-3",
      committed: false,
      resourceCount: 1,
      workstreamLifecycle: {
        repository: {
          workstreamId: "W-1",
        },
        run: {
          runId: "run-3",
          workstreamBound: true,
        },
      },
    });
  });

  it("merges explicit lifecycle evidence and deduplicates warning codes", () => {
    expect(buildContextEngineEventSummary({
      context: boundContext(),
      warningCodes: ["MODE_REPAIR", "MODE_REPAIR", ""],
      workstreamLifecycle: {
        repository: { headAfter: "def456" },
        finalization: {
          status: "committed",
          outcome: "done",
          validation: "passed",
          commit: "def456",
          commitCreated: true,
        },
      },
    })).toMatchObject({
      warningCodes: ["MODE_REPAIR"],
      workstreamLifecycle: {
        repository: {
          workstreamId: "W-1",
          headAfter: "def456",
        },
        finalization: {
          status: "committed",
          outcome: "done",
          validation: "passed",
          commit: "def456",
          commitCreated: true,
        },
      },
    });
  });
});

function boundContext(): ReturnType<typeof contextEngineFixture> {
  const context = contextEngineFixture({
    runId: "run-3",
    message: "continue upload UI",
  });
  context.current.routing = {
    status: "bound",
    workstreamId: "W-1",
    requestId: "R-0001",
    branch: "main",
  };
  context.focus = {
    status: "active",
    ref: "refs/heads/main",
    workstreamId: "W-1",
  };
  context.workstream = {
    ref: "refs/heads/main",
    workstreamId: "W-1",
    title: "Upload UI",
    objective: "Improve upload UI",
    summary: "Upload UI remains in progress.",
    workstreamStatus: "in_progress",
    lifecycleStatus: "active",
    repositoryHealth: "ready",
    blockers: [],
    resources: [{
      resource: {
        resourceId: "RES-0123456789ABCDEF01234567",
        kind: "file",
        origin: "user_reference",
        displayName: "mock.png",
        description: "Upload UI mockup",
        aliases: ["mockup"],
        locator: { kind: "filesystem", path: "/ayati/workspace/mock.png" },
        version: {
          key: "sha256:mock",
          observedAt: "2026-06-23T09:00:00.000Z",
          exists: true,
          kind: "file",
          sha256: "mock",
        },
        availability: "available",
        metadataStatus: "enriched",
        createdAt: "2026-06-23T09:00:00.000Z",
        updatedAt: "2026-06-23T09:00:00.000Z",
      },
      role: "input",
      access: "read",
      primary: false,
      requestIds: ["R-0001"],
      boundAt: "2026-06-23T09:00:00.000Z",
    }],
  };
  return context;
}
