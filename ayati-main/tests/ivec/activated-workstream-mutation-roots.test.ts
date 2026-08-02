import { describe, expect, it } from "vitest";
import type { ContextEngineMachineContext } from "../../src/context-engine/index.js";
import { deriveActivatedWorkstreamMutationRoots } from "../../src/ivec/agent-runner/activated-workstream-mutation-roots.js";
import { contextEngineFixture } from "../fixtures/agent-context.js";

const WORKSTREAM_ID = "W-20260731-0001";

describe("deriveActivatedWorkstreamMutationRoots", () => {
  it("derives only selected usable absolute filesystem roots with mutate access", () => {
    const context = activatedContext([
      resourceBinding(1, "/workspace/project", "mutate", "available"),
      resourceBinding(2, "/workspace/project", "mutate", "changed"),
      resourceBinding(3, "/workspace/unchecked", "mutate", "unverified"),
      resourceBinding(4, "/workspace/reference", "read", "available"),
      resourceBinding(5, "/workspace/missing", "mutate", "missing"),
      resourceBinding(6, "/workspace/deleted", "mutate", "deleted"),
      resourceBinding(7, "relative/path", "mutate", "available"),
      resourceBinding(
        8,
        { kind: "url", url: "https://example.com/resource" },
        "mutate",
        "available",
      ),
      resourceBinding(9, "/workspace/unselected", "mutate", "available"),
    ]);

    expect(deriveActivatedWorkstreamMutationRoots({
      context,
      workstreamId: WORKSTREAM_ID,
      resourceIds: [1, 2, 3, 4, 5, 6, 7, 8].map(resourceId),
    })).toEqual([
      "/workspace/project",
      "/workspace/unchecked",
    ]);
  });

  it("fails closed when the bound workstream projection is absent or mismatched", () => {
    const context = contextEngineFixture();

    expect(deriveActivatedWorkstreamMutationRoots({
      context,
      workstreamId: WORKSTREAM_ID,
      resourceIds: [resourceId(1)],
    })).toEqual([]);

    context.workstream = activatedContext([]).workstream;
    expect(deriveActivatedWorkstreamMutationRoots({
      context,
      workstreamId: "W-OTHER",
      resourceIds: [resourceId(1)],
    })).toEqual([]);
  });

  it("fails closed without an exact selected resource", () => {
    const context = activatedContext([
      resourceBinding(1, "/workspace/project", "mutate", "available"),
    ]);

    expect(deriveActivatedWorkstreamMutationRoots({
      context,
      workstreamId: WORKSTREAM_ID,
      resourceIds: [],
    })).toEqual([]);
    expect(deriveActivatedWorkstreamMutationRoots({
      context,
      workstreamId: WORKSTREAM_ID,
      resourceIds: [resourceId(2)],
    })).toEqual([]);
  });
});

type WorkstreamResource = NonNullable<
  ContextEngineMachineContext["workstream"]
>["resources"][number];

function activatedContext(
  resources: WorkstreamResource[],
): ContextEngineMachineContext {
  const context = contextEngineFixture();
  context.workstream = {
    ref: `workstream:${WORKSTREAM_ID}`,
    workstreamId: WORKSTREAM_ID,
    title: "Test workstream",
    objective: "Exercise activated resource authority.",
    summary: "The workstream is active.",
    workstreamStatus: "in_progress",
    lifecycleStatus: "active",
    repositoryHealth: "ready",
    blockers: [],
    currentRequest: {
      id: "R-0001",
      title: "Update the project",
      status: "active",
      request: "Update the project.",
      acceptance: ["The project is updated."],
      constraints: [],
    },
    selectedRequest: {
      id: "R-0001",
      title: "Update the project",
      status: "active",
      request: "Update the project.",
      acceptance: ["The project is updated."],
      constraints: [],
    },
    recentProgress: [],
    resources,
  };
  return context;
}

function resourceBinding(
  index: number,
  locator: WorkstreamResource["resource"]["locator"] | string,
  access: WorkstreamResource["access"],
  availability: WorkstreamResource["resource"]["availability"],
): WorkstreamResource {
  const publicLocator = typeof locator === "string"
    ? { kind: "filesystem" as const, path: locator }
    : locator;
  return {
    resource: {
      resourceId: `RES-${String(index).padStart(24, "0")}`,
      kind: publicLocator.kind === "url" ? "url" : "directory",
      origin: "agent_created",
      displayName: `Resource ${index}`,
      description: `Resource ${index}.`,
      aliases: [],
      locator: publicLocator,
      version: {
        key: `resource:${index}`,
        observedAt: "2026-07-31T10:00:00.000Z",
        exists: availability !== "missing" && availability !== "deleted",
        kind: publicLocator.kind === "url" ? "url" : "directory",
      },
      availability,
      metadataStatus: "enriched",
      createdAt: "2026-07-31T10:00:00.000Z",
      updatedAt: "2026-07-31T10:00:00.000Z",
    },
    role: "supporting",
    access,
    primary: index === 1,
    requestIds: ["R-0001"],
    boundAt: "2026-07-31T10:00:00.000Z",
  };
}

function resourceId(index: number): string {
  return `RES-${String(index).padStart(24, "0")}`;
}
