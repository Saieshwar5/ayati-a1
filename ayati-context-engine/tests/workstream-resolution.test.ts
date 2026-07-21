import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContextDatabase } from "../src/database/database.js";
import { SqliteContextEngineService } from "../src/services/sqlite-context-engine-service.js";

const roots: string[] = [];
const services: SqliteContextEngineService[] = [];
const AT = "2026-07-21T10:00:00.000Z";

afterEach(async () => {
  await Promise.all(services.splice(0).map(async (service) => await service.close()));
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe("workstream resolution activity", () => {
  it("uses the current input for the resolver revision check and candidate projection", async () => {
    const fixture = await createFixture("candidate-revision");
    seedCandidateCatalog(fixture.database, fixture.root);
    const prepared = await prepare(fixture.service, "Continue the lunar archive migration.");
    const withoutCurrentText = await fixture.service.getAgentContext({
      streamId: prepared.stream.streamId,
    });

    expect(prepared.context.workstreamCandidates).toHaveLength(5);
    expect(prepared.context.workstreamCandidates?.map((candidate) => candidate.workstreamId))
      .toContain("W-20260721-0001");
    expect(withoutCurrentText.workstreamCandidates?.map((candidate) => candidate.workstreamId))
      .not.toContain("W-20260721-0001");
    expect(withoutCurrentText.contextRevision).not.toBe(prepared.context.contextRevision);

    const started = await startResolution(
      fixture.service,
      prepared,
      "Resolve the workstream that owns the lunar archive migration.",
    );
    expect(started.activity.status).toBe("running");
    expect(started.context.workstreamCandidates?.map((candidate) => candidate.workstreamId))
      .toContain("W-20260721-0001");
  });

  it("journals resolver steps separately and mounts a created workstream after binding", async () => {
    const fixture = await createFixture("create");
    const prepared = await prepare(fixture.service, "Build the resolver subsystem.");
    const started = await startResolution(fixture.service, prepared, "Implement isolated workstream resolution.");

    await fixture.service.recordWorkstreamResolutionStep({
      requestId: started.activity.activityId + ":step:1",
      activityId: started.activity.activityId,
      record: stepRecord(1, "resolution_search_workstreams", { workstreams: [] }),
    });
    const committed = await fixture.service.commitWorkstreamResolution({
      requestId: started.activity.activityId + ":commit",
      activityId: started.activity.activityId,
      runId: prepared.run.runId,
      commit: {
        kind: "create",
        title: "Isolated workstream resolution",
        objective: "Keep workstream discovery and binding outside main task state.",
        initialRequest: {
          title: "Implement the isolated resolver",
          request: "Implement the bounded resolver loop and mount its selected context.",
          acceptance: ["Resolver steps are isolated from main run steps."],
          constraints: ["Bind exactly one workstream and request."],
        },
        evidence: ["No existing workstream owns this concrete task."],
      },
      finalState: { status: "resolved" },
      at: "2026-07-21T10:00:02.000Z",
    });
    await fixture.service.recordWorkstreamResolutionStep({
      requestId: started.activity.activityId + ":step:2",
      activityId: started.activity.activityId,
      record: stepRecord(2, "resolution_create_workstream", committed.receipt),
    });

    const journal = await fixture.service.getWorkstreamResolution({
      activityId: started.activity.activityId,
    });
    const context = await fixture.service.getAgentContext({ streamId: prepared.stream.streamId });
    expect(journal.activity).toMatchObject({
      status: "resolved",
      stepCount: 2,
      toolCallCount: 2,
      result: {
        status: "resolved",
        kind: "created_workstream",
        requestId: "R-0001",
      },
    });
    expect(journal.steps.map((step) => step.step)).toEqual([1, 2]);
    expect(context).toMatchObject({
      activeWorkstream: {
        title: "Isolated workstream resolution",
        currentRequest: {
          id: "R-0001",
          title: "Implement the isolated resolver",
          request: "Implement the bounded resolver loop and mount its selected context.",
          acceptance: ["Resolver steps are isolated from main run steps."],
          constraints: ["Bind exactly one workstream and request."],
        },
      },
      run: {
        run: { stepCount: 0 },
        workState: { revision: 0, afterStep: 0 },
        steps: [],
      },
      workstreamResolution: {
        activityId: started.activity.activityId,
        runId: prepared.run.runId,
        status: "resolved",
        stepCount: 2,
      },
    });
    expect(context.workstreamCandidates).toBeUndefined();
  });

  it("publishes ambiguity without binding or task-state changes", async () => {
    const fixture = await createFixture("ambiguity");
    const prepared = await prepare(fixture.service, "Continue the project.");
    const started = await startResolution(fixture.service, prepared, "Resolve which project to continue.");
    const finished = await fixture.service.finishWorkstreamResolution({
      requestId: started.activity.activityId + ":needs-user-input",
      activityId: started.activity.activityId,
      runId: prepared.run.runId,
      result: {
        status: "needs_user_input",
        reasonCodes: ["multiple_plausible_workstreams"],
        question: "Which workstream should I continue?",
        candidates: [],
      },
      finalState: { status: "needs_user_input" },
      at: "2026-07-21T10:00:01.000Z",
    });
    await fixture.service.recordWorkstreamResolutionStep({
      requestId: started.activity.activityId + ":step:1",
      activityId: started.activity.activityId,
      record: stepRecord(1, "resolution_needs_user_input", { candidateCount: 0 }),
    });
    const context = await fixture.service.getAgentContext({ streamId: prepared.stream.streamId });

    expect(finished.activity.status).toBe("needs_user_input");
    expect(context.run?.run.workstreamBinding).toBeUndefined();
    expect(context.run?.steps).toEqual([]);
    expect(context.workstreamResolution?.result).toMatchObject({
      status: "needs_user_input",
      question: "Which workstream should I continue?",
    });
  });

  it("marks an unfinished resolver interrupted on startup and does not resume it", async () => {
    const fixture = await createFixture("recovery");
    const prepared = await prepare(fixture.service, "Resolve this work.");
    const started = await startResolution(fixture.service, prepared, "Resolve current work ownership.");
    await fixture.service.close();
    services.splice(services.indexOf(fixture.service), 1);

    const reopenedDatabase = await ContextDatabase.open({ path: fixture.databasePath });
    const reopened = new SqliteContextEngineService({
      database: reopenedDatabase,
      rootDirectory: fixture.root,
      now: () => "2026-07-21T10:05:00.000Z",
    });
    services.push(reopened);
    await reopened.getHealth();
    const journal = await reopened.getWorkstreamResolution({ activityId: started.activity.activityId });

    expect(journal.activity).toMatchObject({
      status: "interrupted",
      result: {
        status: "interrupted",
        code: "WORKSTREAM_RESOLUTION_INTERRUPTED",
        retryable: true,
      },
    });
    expect(journal.steps).toEqual([]);
  });
});

async function createFixture(name: string): Promise<{
  root: string;
  databasePath: string;
  database: ContextDatabase;
  service: SqliteContextEngineService;
}> {
  const root = await mkdtemp(join(tmpdir(), `ayati-resolution-${name}-`));
  roots.push(root);
  const databasePath = join(root, "context.sqlite");
  const database = await ContextDatabase.open({ path: databasePath });
  const service = new SqliteContextEngineService({
    database,
    rootDirectory: root,
    now: () => AT,
  });
  services.push(service);
  return { root, databasePath, database, service };
}

function seedCandidateCatalog(database: ContextDatabase, root: string): void {
  const insert = database.prepare([
    "INSERT INTO workstreams(",
    "workstream_id, repository_path, branch, head_sha, title_cache, objective_cache,",
    "lifecycle_status, repository_health, status, created_at, updated_at",
    ") VALUES (?, ?, 'main', ?, ?, ?, 'active', 'ready', 'active', ?, ?)",
  ].join(" "));
  for (let index = 1; index <= 6; index++) {
    const suffix = String(index).padStart(4, "0");
    const at = `2026-07-${String(10 + index).padStart(2, "0")}T10:00:00.000Z`;
    insert.run(
      `W-20260721-${suffix}`,
      join(root, "workstreams", suffix),
      String(index).repeat(40),
      index === 1 ? "Lunar archive migration" : `Recent workstream ${index}`,
      index === 1 ? "Migrate the lunar archive." : `Maintain recent workstream ${index}.`,
      at,
      at,
    );
  }
}

async function prepare(service: SqliteContextEngineService, content: string) {
  return await service.prepareAgentRun({
    requestId: "prepare:" + content,
    timezone: "Asia/Kolkata",
    agentId: "local",
    scopeKey: "default",
    role: "user",
    content,
    at: AT,
  });
}

async function startResolution(
  service: SqliteContextEngineService,
  prepared: Awaited<ReturnType<typeof prepare>>,
  purpose: string,
) {
  return await service.startWorkstreamResolution({
    requestId: prepared.run.runId + ":resolution:start",
    runId: prepared.run.runId,
    streamId: prepared.stream.streamId,
    input: {
      purpose,
      currentInput: prepared.message.content,
      hints: [],
      limits: { maxTurns: 6, maxToolCalls: 16, maxParallelCalls: 4 },
    },
    inputContextRevision: prepared.context.contextRevision,
    at: AT,
  });
}

function stepRecord(step: number, tool: string, output: unknown) {
  return {
    version: 1 as const,
    step,
    status: "completed" as const,
    context: { step },
    decision: { calls: [{ id: "call-" + step, tool, input: {} }] },
    toolCalls: [{ id: "call-" + step, tool, input: {}, status: "completed", output }],
    verification: { passed: true },
    stateAfter: { status: tool === "resolution_needs_user_input" ? "needs_user_input" : "resolved" },
    createdAt: `2026-07-21T10:00:0${step}.000Z`,
  };
}
