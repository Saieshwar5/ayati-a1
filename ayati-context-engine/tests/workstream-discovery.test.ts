import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createBoundWorkstream,
  createBoundWorkstreamWithMutableDirectory,
  createWorkstreamServiceFixture,
  workState,
  type WorkstreamServiceFixture,
} from "./simple-workstream-repository-fixtures.js";

interface DiscoveryFixture {
  fixture: WorkstreamServiceFixture;
  codingWorkstreamId: string;
  researchWorkstreamId: string;
  codingResourceId: string;
  researchResourceId: string;
  codingPath: string;
}

const fixtures: WorkstreamServiceFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (fixture) => await fixture.dispose()));
});

describe("autonomous workstream discovery", () => {
  it("distinguishes an empty catalog from a search with no matches", async () => {
    const empty = await createWorkstreamServiceFixture(
      "empty-discovery",
      "Create the first durable workstream.",
    );
    fixtures.push(empty);

    await expect(empty.service.findWorkstreams({
      query: "lumen finch website",
      limit: 10,
    })).resolves.toEqual({
      workstreams: [],
      outcome: "catalog_empty",
      catalogCount: 0,
    });

    const populated = await createDiscoveryFixture();
    await expect(populated.fixture.service.findWorkstreams({
      query: "unrelated lunar archive",
      limit: 10,
    })).resolves.toEqual({
      workstreams: [],
      outcome: "no_match",
      catalogCount: 2,
    });
  });

  it("ranks exact resource ownership ahead of star, recency, and frequency", async () => {
    const state = await createDiscoveryFixture();
    await state.fixture.service.setWorkstreamStar({
      requestId: "REQ-star-research-ranking",
      runId: state.fixture.prepared.run.runId,
      workstreamId: state.researchWorkstreamId,
      starred: true,
      at: "2026-07-19T10:08:00+05:30",
    });

    const found = await state.fixture.service.findWorkstreams({
      paths: [join(state.codingPath, "src", "app.ts")],
      limit: 10,
    });

    expect(found.workstreams[0]).toMatchObject({
      workstreamId: state.codingWorkstreamId,
      primaryResources: [{ resourceId: state.codingResourceId }],
      discovery: {
        tier: "definite",
        reasons: expect.arrayContaining(["owned_resource"]),
      },
    });
    expect(found).toMatchObject({
      outcome: "matches_found",
      catalogCount: 2,
    });
    expect(found.workstreams.find((item) => item.workstreamId === state.researchWorkstreamId))
      .toMatchObject({ starred: true, boundRunsLast30Days: 1 });
  });

  it("searches workstream and resource metadata with explained deterministic reasons", async () => {
    const state = await createDiscoveryFixture();

    const byWork = await state.fixture.service.findWorkstreams({
      query: "solar panel analysis",
      limit: 10,
    });
    const byResource = await state.fixture.service.findWorkstreams({
      query: "photovoltaic evidence",
      limit: 10,
    });

    expect(byWork.workstreams[0]).toMatchObject({
      workstreamId: state.researchWorkstreamId,
      discovery: {
        tier: "probable",
        reasons: expect.arrayContaining(["text_match"]),
      },
    });
    expect(byResource.workstreams[0]).toMatchObject({
      workstreamId: state.researchWorkstreamId,
      primaryResources: [{ resourceId: state.researchResourceId }],
      discovery: {
        tier: "probable",
        reasons: expect.arrayContaining(["resource_match"]),
      },
    });
  });

  it("finds a completed request through request FTS without reopening it", async () => {
    const fixture = await createWorkstreamServiceFixture("completed-request-search");
    fixtures.push(fixture);
    const selected = await createBoundWorkstreamWithMutableDirectory(fixture, {
      title: "Historical Audit",
      objective: "Maintain verified historical audit work.",
      initialRequest: {
        title: "Record nebula retention receipt",
        request: "Record the nebula retention receipt for later reference.",
        acceptance: ["The nebula retention receipt is verified."],
        constraints: ["Keep the receipt in durable context."],
      },
    });
    await fixture.service.finalizeRun({
      requestId: "REQ-complete-historical-request",
      runId: fixture.prepared.run.runId,
      outcome: "done",
      stopReason: "completed",
      assistantResponse: "The historical audit request is complete.",
      streamSummary: "Completed one historical audit request.",
      summary: "The historical audit request is verified and complete.",
      validation: "passed",
      workState: workState({
        status: "done",
        summary: "The historical audit request is verified and complete.",
      }),
      workstream: {
        completion: {
          accepted: true,
          resources: [],
          missing: [],
          failures: [],
          criteria: [{
            criterion: "The nebula retention receipt is verified.",
            passed: true,
            evidence: "The deterministic audit validation passed.",
          }],
        },
        requestEffect: { kind: "complete", verification: "verified" },
      },
      at: "2026-07-19T10:03:00+05:30",
    });

    const found = await fixture.service.findWorkstreams({
      query: "nebula retention receipt",
      limit: 10,
    });
    const byStatus = await fixture.service.findWorkstreams({
      query: "done",
      limit: 10,
    });

    expect(found.workstreams[0]).toMatchObject({
      workstreamId: selected.workstream.workstreamId,
      unfinishedRequests: [],
      matchingRequests: [{
        id: "R-0001",
        title: "Record nebula retention receipt",
        status: "done",
      }],
      discovery: {
        tier: "probable",
        reasons: expect.arrayContaining(["matching_request", "text_match"]),
      },
    });
    expect(found.workstreams[0]).not.toHaveProperty("currentRequest");
    expect(byStatus.workstreams[0]).toMatchObject({
      workstreamId: selected.workstream.workstreamId,
      matchingRequests: [{ id: "R-0001", status: "done" }],
    });
  });

  it("keeps recent workstreams advisory when the user uses referential continuation wording", async () => {
    const state = await createDiscoveryFixture();

    const found = await state.fixture.service.findWorkstreams({
      streamId: state.fixture.prepared.stream.streamId,
      currentText: "Continue where we left off on that work.",
      limit: 20,
    });

    expect(found.workstreams.find((workstream) => (
      workstream.workstreamId === state.researchWorkstreamId
    ))).toMatchObject({
      workstreamId: state.researchWorkstreamId,
      discovery: {
        tier: "candidate",
        reasons: expect.arrayContaining(["recent"]),
      },
    });
    expect(found.workstreams.flatMap((workstream) => workstream.discovery.reasons))
      .not.toContain("direct_continuation");
    expect(state.fixture.database.prepare(
      "SELECT workstream_id FROM runs WHERE run_id = ?",
    ).get(state.fixture.prepared.run.runId)).toEqual({ workstream_id: null });
  });

  it("recognizes embedded exact workstream and resource identities plus a unique title", async () => {
    const state = await createDiscoveryFixture();
    const byWorkstream = await state.fixture.service.findWorkstreams({
      currentText: `Please continue ${state.researchWorkstreamId} today.`,
      limit: 10,
    });
    const byResource = await state.fixture.service.findWorkstreams({
      query: `Open ${state.codingResourceId}.`,
      limit: 10,
    });
    const byTitle = await state.fixture.service.findWorkstreams({
      currentText: "Continue Home Solar Research.",
      limit: 10,
    });

    expect(byWorkstream.workstreams[0]).toMatchObject({
      workstreamId: state.researchWorkstreamId,
      discovery: { tier: "definite", reasons: expect.arrayContaining(["exact_workstream_id"]) },
    });
    expect(byResource.workstreams[0]).toMatchObject({
      workstreamId: state.codingWorkstreamId,
      discovery: { tier: "definite", reasons: expect.arrayContaining(["exact_resource_id"]) },
    });
    expect(byTitle.workstreams[0]).toMatchObject({
      workstreamId: state.researchWorkstreamId,
      discovery: { tier: "definite", reasons: expect.arrayContaining(["exact_title"]) },
    });
  });

  it("changes stars idempotently while searches never count as opens", async () => {
    const state = await createDiscoveryFixture();
    const input = {
      requestId: "REQ-star-research",
      runId: state.fixture.prepared.run.runId,
      workstreamId: state.researchWorkstreamId,
      starred: true,
      at: "2026-07-19T10:08:00+05:30",
    } as const;
    const before = accessCount(state.fixture);

    const first = await state.fixture.service.setWorkstreamStar(input);
    const replay = await state.fixture.service.setWorkstreamStar(input);
    await state.fixture.service.findWorkstreams({ view: "starred" });
    await state.fixture.service.findWorkstreams({ query: "solar" });

    expect(replay).toEqual(first);
    expect(first).toEqual({
      workstreamId: state.researchWorkstreamId,
      starred: true,
      starredAt: input.at,
    });
    expect(accessCount(state.fixture)).toBe(before);
  });
});

async function createDiscoveryFixture(): Promise<DiscoveryFixture> {
  const fixture = await createWorkstreamServiceFixture(
    "discovery",
    "Build and maintain a coffee website.",
  );
  fixtures.push(fixture);
  const codingPath = join(fixture.root, "external", "coffee-site");
  const researchPath = join(fixture.root, "external", "solar-research");
  await mkdir(join(codingPath, "src"), { recursive: true });
  await mkdir(researchPath, { recursive: true });
  const codingResource = await fixture.service.inspectResourceForRun({
    requestId: "REQ-inspect-coding",
    runId: fixture.prepared.run.runId,
    locator: { kind: "filesystem", path: codingPath },
    kind: "directory",
    origin: "user_reference",
    displayName: "coffee-site",
    description: "Source directory for the coffee website.",
    aliases: ["coffee app"],
    at: "2026-07-19T10:01:00+05:30",
  });
  const coding = await createBoundWorkstream(fixture, {
    requestId: "REQ-create-coding",
    title: "Coffee Website",
    objective: "Build and maintain the coffee shop website.",
    resources: [{
      resourceId: codingResource.resource.resourceId,
      role: "primary",
      access: "mutate",
      primary: true,
    }],
  });
  await finalizeIncomplete(fixture, "coding", "2026-07-19T10:03:00+05:30");

  fixture.prepared = await fixture.service.prepareAgentRun({
    requestId: "REQ-prepare-research",
    timezone: "Asia/Kolkata",
    agentId: "local",
    role: "user",
    content: "Research solar panels and compare installation options.",
    at: "2026-07-19T10:04:00+05:30",
  });
  const researchResource = await fixture.service.inspectResourceForRun({
    requestId: "REQ-inspect-research",
    runId: fixture.prepared.run.runId,
    locator: { kind: "filesystem", path: researchPath },
    kind: "directory",
    origin: "user_reference",
    displayName: "solar-evidence",
    description: "Photovoltaic evidence and installation comparisons.",
    aliases: ["photovoltaic evidence"],
    at: "2026-07-19T10:05:00+05:30",
  });
  const research = await createBoundWorkstream(fixture, {
    requestId: "REQ-create-research",
    title: "Home Solar Research",
    objective: "Research solar panel analysis and compare installation options.",
    resources: [{
      resourceId: researchResource.resource.resourceId,
      role: "primary",
      access: "mutate",
      primary: true,
    }],
  });
  await finalizeIncomplete(fixture, "research", "2026-07-19T10:06:00+05:30");

  fixture.prepared = await fixture.service.prepareAgentRun({
    requestId: "REQ-prepare-discovery",
    timezone: "Asia/Kolkata",
    agentId: "local",
    role: "user",
    content: "Continue where we left off.",
    at: "2026-07-19T10:07:00+05:30",
  });
  return {
    fixture,
    codingWorkstreamId: coding.workstream.workstreamId,
    researchWorkstreamId: research.workstream.workstreamId,
    codingResourceId: codingResource.resource.resourceId,
    researchResourceId: researchResource.resource.resourceId,
    codingPath,
  };
}

async function finalizeIncomplete(
  fixture: WorkstreamServiceFixture,
  name: string,
  at: string,
): Promise<void> {
  await fixture.service.finalizeRun({
    requestId: `REQ-finalize-${name}`,
    runId: fixture.prepared.run.runId,
    outcome: "incomplete",
    stopReason: "run_limit",
    assistantResponse: "The workstream remains in progress.",
    streamSummary: "Started durable work.",
    summary: "Work remains in progress.",
    validation: "not_applicable",
    next: "Continue in the next run.",
    workState: workState({ summary: "Work remains in progress." }),
    workstream: {
      completion: { accepted: false, resources: [], missing: [], failures: [], criteria: [] },
      requestEffect: { kind: "none" },
    },
    at,
  });
}

function accessCount(fixture: WorkstreamServiceFixture): number {
  return Number((fixture.database.prepare(
    "SELECT COUNT(*) AS count FROM workstream_accesses",
  ).get() as { count: number }).count);
}
