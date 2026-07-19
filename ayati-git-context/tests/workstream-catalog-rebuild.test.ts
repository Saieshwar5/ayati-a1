import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContextDatabase } from "../src/database/database.js";
import { insertSession } from "../src/repositories/session-records.js";
import { WorkstreamDiscoveryService } from "../src/services/workstream-discovery-service.js";
import { rebuildWorkstreamCatalog } from "../src/services/workstream-catalog-rebuild-service.js";
import {
  createBoundWorkstream,
  createWorkstreamServiceFixture,
  workState,
  type WorkstreamServiceFixture,
} from "./simple-workstream-repository-fixtures.js";

const NOW = "2026-07-19T12:00:00.000Z";
const fixtures: WorkstreamServiceFixture[] = [];
const databases: ContextDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(fixtures.splice(0).map(async (fixture) => await fixture.dispose()));
});

describe("workstream catalog rebuild", () => {
  it("previews and reconstructs workstreams, resources, and relationships from context Git", async () => {
    const source = await createRebuildSource("reconstruct");
    const database = await createEmptyCatalog(source.fixture, "reconstructed.db");

    const preview = await rebuildWorkstreamCatalog({
      workstreamRoot: join(source.fixture.root, "workstreams"),
      now: NOW,
      confirm: false,
    });

    expect(preview).toMatchObject({
      scannedDirectories: 1,
      repositories: [{
        workstreamId: source.workstreamId,
        contextRepositoryPath: source.contextRepositoryPath,
        repositoryHealth: "ready",
        resources: [{
          resourceId: source.resourceId,
          origin: "agent_created",
          role: "primary",
          access: "mutate",
          primary: true,
          locator: { kind: "filesystem" },
          version: { exists: true, kind: "directory" },
        }],
      }],
      failures: [],
      applied: false,
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM workstreams").get()).toEqual({ count: 0 });

    const rebuilt = await rebuildWorkstreamCatalog({
      workstreamRoot: join(source.fixture.root, "workstreams"),
      now: NOW,
      database,
      confirm: true,
    });

    expect(rebuilt.applied).toBe(true);
    expect(database.prepare([
      "SELECT workstream_id, repository_path, lifecycle_status, repository_health",
      "FROM workstreams",
    ].join(" ")).get()).toEqual({
      workstream_id: source.workstreamId,
      repository_path: source.contextRepositoryPath,
      lifecycle_status: "active",
      repository_health: "ready",
    });
    expect(database.prepare([
      "SELECT wr.workstream_id, wr.resource_id, wr.role, wr.access, wr.is_primary,",
      "r.origin, r.locator_kind FROM workstream_resources wr",
      "JOIN resources r ON r.resource_id = wr.resource_id",
    ].join(" ")).get()).toEqual({
      workstream_id: source.workstreamId,
      resource_id: source.resourceId,
      role: "primary",
      access: "mutate",
      is_primary: 1,
      origin: "agent_created",
      locator_kind: "filesystem",
    });
    expect(new WorkstreamDiscoveryService(database, () => NOW)
      .find({ query: "primary output" }).workstreams[0]).toMatchObject({
      workstreamId: source.workstreamId,
      discovery: { reasons: expect.arrayContaining(["resource_match"]) },
    });
  });

  it("refuses to merge a rebuild into a non-empty workstream or resource catalog", async () => {
    const source = await createRebuildSource("non-empty");
    const database = await createEmptyCatalog(source.fixture, "non-empty.db");
    const input = {
      workstreamRoot: join(source.fixture.root, "workstreams"),
      now: NOW,
      database,
      confirm: true,
    } as const;

    await rebuildWorkstreamCatalog(input);
    await expect(rebuildWorkstreamCatalog(input))
      .rejects.toThrow("empty workstream and resource catalog");
  });
});

async function createRebuildSource(name: string): Promise<{
  fixture: WorkstreamServiceFixture;
  workstreamId: string;
  contextRepositoryPath: string;
  resourceId: string;
}> {
  const fixture = await createWorkstreamServiceFixture(name, "Create a durable analysis workspace.");
  fixtures.push(fixture);
  const selected = await createBoundWorkstream(fixture, {
    title: "Solar Research",
    objective: "Analyze home solar options and retain durable evidence.",
  });
  const resource = selected.resourceBindings.find((binding) => binding.primary)?.resource;
  if (!resource) throw new Error("Expected managed primary output resource.");
  await fixture.service.finalizeRun({
    requestId: `REQ-${name}-finalize`,
    sessionId: fixture.prepared.session.sessionId,
    runId: fixture.prepared.run.runId,
    outcome: "incomplete",
    stopReason: "run_limit",
    assistantResponse: "The solar analysis remains in progress.",
    conversationSummary: "Started a durable solar analysis.",
    summary: "The workstream and its output resource are initialized.",
    validation: "not_applicable",
    next: "Collect the first source set.",
    workState: workState({ summary: "The workstream remains in progress." }),
    workstream: {
      completion: { accepted: false, resources: [], missing: [], failures: [], criteria: [] },
    },
    at: "2026-07-19T10:02:00+05:30",
  });
  return {
    fixture,
    workstreamId: selected.workstream.workstreamId,
    contextRepositoryPath: selected.workstream.contextRepositoryPath,
    resourceId: resource.resourceId,
  };
}

async function createEmptyCatalog(
  fixture: WorkstreamServiceFixture,
  name: string,
): Promise<ContextDatabase> {
  const database = await ContextDatabase.open({ path: join(fixture.root, ".ayati", name) });
  databases.push(database);
  insertSession(database, {
    sessionId: "S-20260719-rebuild",
    date: "2026-07-19",
    timezone: "UTC",
    agentId: "rebuild",
    repositoryPath: join(fixture.root, ".ayati", "sessions", "S-20260719-rebuild"),
    createdAt: NOW,
  });
  return database;
}
