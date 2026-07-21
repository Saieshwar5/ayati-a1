import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type {
  FinalizeRunRequest,
  SelectedWorkstreamForRunResponse,
} from "../src/contracts.js";
import { ResourceCatalogService } from "../src/services/resource-catalog-service.js";
import { WorkstreamFinalizationService } from "../src/services/workstream-finalization-service.js";
import { validateWorkstreamRepository } from "../src/workstreams/workstream-repository-validator.js";
import {
  createBoundWorkstream,
  createWorkstreamServiceFixture,
  workState,
  type WorkstreamServiceFixture,
} from "./simple-workstream-repository-fixtures.js";

const execFileAsync = promisify(execFile);
const fixtures: WorkstreamServiceFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (fixture) => await fixture.dispose()));
});

describe("live V2 workstream request routing", () => {
  it("binds continuation to the exact committed active request without another run", async () => {
    const state = await createExistingWorkstream("continue", false);
    const input = {
      requestId: "REQ-activate-continuation",
      runId: state.fixture.prepared.run.runId,
      workstreamId: state.created.workstream.workstreamId,
      expectedWorkstreamHead: state.head,
      route: {
        kind: "continue_active_request" as const,
        requestId: "R-0001",
        reason: "The user is continuing the same unfinished outcome.",
      },
      at: "2026-07-19T10:05:00+05:30",
    };

    const selected = await state.fixture.service.activateWorkstreamForRun(input);
    const replayed = await state.fixture.service.activateWorkstreamForRun(input);

    expect(replayed).toEqual(selected);
    expect(selected).toMatchObject({
      workstreamRequestDecision: "continue",
      workstreamRequestCreated: false,
      run: {
        runId: state.fixture.prepared.run.runId,
        workstreamBinding: {
          workstreamId: state.created.workstream.workstreamId,
          requestId: "R-0001",
        },
      },
      context: { currentRequest: { id: "R-0001", status: "active" } },
    });
    expect(state.fixture.database.prepare(
      "SELECT change_plan_json FROM workstream_request_route_plans WHERE run_id = ?",
    ).get(state.fixture.prepared.run.runId)).toEqual({ change_plan_json: null });
    expect(await git(state.created.workstream.contextRepositoryPath, ["rev-parse", "HEAD"]))
      .toBe(state.head);
  });

  it("projects a new request and applies it with verified resource work in one context commit", async () => {
    const state = await createExistingWorkstream("new-request", true);
    const route = createRequestRoute(state, "REQ-activate-new-request");

    const selected = await state.fixture.service.activateWorkstreamForRun(route);
    const replayed = await state.fixture.service.activateWorkstreamForRun(route);

    expect(replayed).toEqual(selected);
    expect(selected).toMatchObject({
      workstreamRequestDecision: "create",
      workstreamRequestCreated: true,
      headBeforeSelection: state.head,
      run: { workstreamBinding: { requestId: "R-0002" } },
      context: { currentRequest: { id: "R-0002", title: "Add the next lesson", status: "active" } },
    });
    expect(await git(state.created.workstream.contextRepositoryPath, ["rev-parse", "HEAD"]))
      .toBe(state.head);
    expect(await git(state.created.workstream.contextRepositoryPath, [
      "status", "--porcelain", "--untracked-files=all",
    ])).toBe("");
    const primary = requirePrimary(selected);
    const prepared = await state.fixture.service.prepareResourceMutation({
      requestId: "REQ-next-lesson-mutation",
      runId: state.fixture.prepared.run.runId,
      workstreamId: state.created.workstream.workstreamId,
      activeRequestId: "R-0002",
      callId: "call-next-lesson",
      tool: "write_files",
      effect: "workspace_mutation",
      targets: [{
        resourceId: primary.resourceId,
        relativePath: "lessons",
        kind: "directory",
        expectedVersionKey: primary.versionKey,
      }],
      at: "2026-07-19T10:06:00+05:30",
    });
    const lessonDirectory = join(primary.path, "lessons");
    const lessonPath = join(lessonDirectory, "next.md");
    await mkdir(lessonDirectory);
    await writeFile(lessonPath, "# Next lesson\n", "utf8");
    await expect(state.fixture.service.verifyResourceMutation({
      requestId: "REQ-next-lesson-verify",
      operationId: prepared.operationId,
      leaseId: prepared.leaseId,
      lockToken: prepared.lockToken,
      toolStatus: "completed",
      at: "2026-07-19T10:07:00+05:30",
    })).resolves.toMatchObject({ status: "verified", verified: true });

    const finalized = await state.fixture.service.finalizeRun(doneFinalization(
      state.fixture,
      lessonPath,
      "The next lesson is complete.",
    ));

    expect(finalized.workstreamContextCommit).toMatchObject({
      status: "committed",
      headBefore: state.head,
      requestId: "R-0002",
    });
    expect((await git(state.created.workstream.contextRepositoryPath, [
      "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD",
    ])).split("\n").sort()).toEqual([
      "requests/R-0002-add-the-next-lesson.md",
      "resources.json",
      "workstream.md",
    ]);
    expect(await readFile(lessonPath, "utf8")).toBe("# Next lesson\n");
    expect((await git(state.created.workstream.contextRepositoryPath, ["ls-files"])).split("\n"))
      .not.toContain("lessons/next.md");
    const validation = await validateWorkstreamRepository({
      workstreamRoot: join(state.fixture.root, "workstreams"),
      contextRepositoryPath: state.created.workstream.contextRepositoryPath,
      expectedWorkstreamId: state.created.workstream.workstreamId,
      requestReadMode: "all",
    });
    expect(validation.requests.find((request) => request.id === "R-0002"))
      .toMatchObject({ status: "done", title: "Add the next lesson" });
    expect(validation.resourceManifest.resources).toContainEqual(expect.objectContaining({
      role: "deliverable",
      locator: { kind: "filesystem", path: lessonPath },
    }));
  });

  it("discards a newly planned request when failed work produced no durable change", async () => {
    const state = await createExistingWorkstream("discard", true);
    await state.fixture.service.activateWorkstreamForRun(
      createRequestRoute(state, "REQ-activate-discarded-request"),
    );

    const finalized = await state.fixture.service.finalizeRun(failedFinalization(state.fixture));

    expect(finalized.workstreamContextCommit).toEqual({ status: "not_required" });
    expect(state.fixture.database.prepare(
      "SELECT phase FROM workstream_request_route_plans WHERE run_id = ?",
    ).get(state.fixture.prepared.run.runId)).toEqual({ phase: "discarded" });
    await expect(readFile(join(
      state.created.workstream.contextRepositoryPath,
      "requests/R-0002-add-the-next-lesson.md",
    ), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const validation = await validateWorkstreamRepository({
      workstreamRoot: join(state.fixture.root, "workstreams"),
      contextRepositoryPath: state.created.workstream.contextRepositoryPath,
      expectedWorkstreamId: state.created.workstream.workstreamId,
      requestReadMode: "all",
    });
    expect(validation.requests.map((request) => request.id)).toEqual(["R-0001"]);
  });

  it("recognizes and acknowledges an exact context commit after interrupted finalization", async () => {
    const fixture = await createWorkstreamServiceFixture(
      "routing-recovery",
      "Complete a context-only durable outcome.",
    );
    fixtures.push(fixture);
    const selected = await createBoundWorkstream(fixture, {
      title: "Recoverable Context",
      objective: "Recover a journaled context commit idempotently.",
    });
    const input = doneFinalization(fixture, undefined, "The context outcome is complete.");
    const interrupted = new WorkstreamFinalizationService({
      database: fixture.database,
      workstreamRoot: join(fixture.root, "workstreams"),
      resourceCatalog: new ResourceCatalogService({
        database: fixture.database,
        rootDirectory: fixture.root,
      }),
      hook: (phase) => {
        if (phase === "commit_created") throw new Error("interrupt after context commit");
      },
    });

    await expect(interrupted.finalize(input, fixture.prepared.session))
      .rejects.toThrow("interrupt after context commit");
    expect(fixture.database.prepare([
      "SELECT phase, commit_created, commit_head FROM workstream_finalizations WHERE run_id = ?",
    ].join(" ")).get(fixture.prepared.run.runId)).toMatchObject({
      phase: "recovery_required",
      commit_created: 1,
      commit_head: await git(selected.workstream.contextRepositoryPath, ["rev-parse", "HEAD"]),
    });

    const recovery = new WorkstreamFinalizationService({
      database: fixture.database,
      workstreamRoot: join(fixture.root, "workstreams"),
      resourceCatalog: new ResourceCatalogService({
        database: fixture.database,
        rootDirectory: fixture.root,
      }),
    });
    await recovery.recover("2026-07-19T10:08:00+05:30");

    expect(fixture.database.prepare([
      "SELECT phase, commit_created, commit_head FROM workstream_finalizations WHERE run_id = ?",
    ].join(" ")).get(fixture.prepared.run.runId)).toEqual({
      phase: "completed",
      commit_created: 1,
      commit_head: await git(selected.workstream.contextRepositoryPath, ["rev-parse", "HEAD"]),
    });
    expect(fixture.database.prepare(
      "SELECT status, stop_reason FROM runs WHERE run_id = ?",
    ).get(fixture.prepared.run.runId)).toEqual({ status: "done", stop_reason: "completed" });
  });
});

interface ExistingWorkstreamState {
  fixture: WorkstreamServiceFixture;
  created: SelectedWorkstreamForRunResponse;
  head: string;
}

async function createExistingWorkstream(
  name: string,
  completeInitialRequest: boolean,
): Promise<ExistingWorkstreamState> {
  const fixture = await createWorkstreamServiceFixture(
    "routing-" + name,
    "Start a long-lived learning workstream.",
  );
  fixtures.push(fixture);
  const created = await createBoundWorkstream(fixture, {
    title: "Long-lived Learning",
    objective: "Learn one subject across many bounded lessons.",
  });
  const finalized = completeInitialRequest
    ? await fixture.service.finalizeRun(doneFinalization(
        fixture,
        undefined,
        "The initial learning setup is complete.",
      ))
    : await fixture.service.finalizeRun(incompleteFinalization(fixture));
  const commit = finalized.workstreamContextCommit;
  const head = commit.status === "committed" || commit.status === "no_change"
    ? commit.headAfter
    : created.workstream.head;
  fixture.prepared = await fixture.service.prepareAgentRun({
    requestId: `REQ-${name}-next-turn`,
    timezone: "Asia/Kolkata",
    agentId: "local",
    role: "user",
    content: completeInitialRequest
      ? "Add and finish the next lesson in this learning workstream."
      : "Continue the unfinished initial learning request.",
    at: "2026-07-19T10:04:00+05:30",
  });
  return { fixture, created, head };
}

function createRequestRoute(state: ExistingWorkstreamState, requestId: string) {
  return {
    requestId,
    runId: state.fixture.prepared.run.runId,
    workstreamId: state.created.workstream.workstreamId,
    expectedWorkstreamHead: state.head,
    route: {
      kind: "create_active_request" as const,
      reason: "The next lesson is a separate bounded outcome in the same learning workstream.",
      title: "Add the next lesson",
      request: "Create and explain the next bounded lesson.",
      acceptance: ["The next lesson exists and is verified."],
      constraints: ["Keep the lesson concise."],
    },
    at: "2026-07-19T10:05:00+05:30",
  };
}

function doneFinalization(
  fixture: WorkstreamServiceFixture,
  outputPath: string | undefined,
  summary: string,
): FinalizeRunRequest {
  return {
    requestId: fixture.prepared.run.runId + ":finalize",
    runId: fixture.prepared.run.runId,
    outcome: "done",
    stopReason: "completed",
    assistantResponse: summary,
    streamSummary: summary,
    summary,
    validation: "passed",
    workState: workState({ status: "done", summary, artifacts: outputPath ? [outputPath] : [] }),
    workstream: {
      completion: {
        accepted: true,
        resources: outputPath ? [{
          locator: { kind: "filesystem", path: outputPath },
          kind: "document",
          role: "deliverable",
          description: "Verified learning lesson.",
          aliases: ["next lesson"],
          verified: true,
        }] : [],
        missing: [],
        failures: [],
        criteria: [{ criterion: "The bounded outcome is verified.", passed: true }],
      },
    },
    at: "2026-07-19T10:08:00+05:30",
  };
}

function incompleteFinalization(fixture: WorkstreamServiceFixture): FinalizeRunRequest {
  return {
    requestId: fixture.prepared.run.runId + ":finalize",
    runId: fixture.prepared.run.runId,
    outcome: "incomplete",
    stopReason: "run_limit",
    assistantResponse: "The initial learning request remains in progress.",
    streamSummary: "The initial request remains active.",
    summary: "The initial learning request remains in progress.",
    validation: "not_applicable",
    next: "Continue the initial request.",
    workState: workState({ summary: "The initial learning request remains in progress." }),
    workstream: {
      completion: { accepted: false, resources: [], missing: [], failures: [], criteria: [] },
    },
    at: "2026-07-19T10:03:00+05:30",
  };
}

function failedFinalization(fixture: WorkstreamServiceFixture): FinalizeRunRequest {
  return {
    requestId: fixture.prepared.run.runId + ":finalize",
    runId: fixture.prepared.run.runId,
    outcome: "failed",
    stopReason: "failed",
    assistantResponse: "The new lesson was not created.",
    streamSummary: "The attempt failed without durable changes.",
    summary: "The attempt failed without durable changes.",
    validation: "failed",
    workState: workState({ summary: "The attempt failed without durable changes." }),
    workstream: {
      completion: {
        accepted: false,
        resources: [],
        missing: ["The new lesson"],
        failures: ["No verified change was produced."],
        criteria: [{ criterion: "The new lesson is verified.", passed: false }],
      },
    },
    at: "2026-07-19T10:06:00+05:30",
  };
}

function requirePrimary(selected: SelectedWorkstreamForRunResponse): {
  resourceId: string;
  path: string;
  versionKey: string;
} {
  const binding = selected.resourceBindings.find((item) => item.primary);
  if (!binding || binding.resource.locator.kind !== "filesystem") {
    throw new Error("Expected a filesystem primary resource.");
  }
  return {
    resourceId: binding.resource.resourceId,
    path: binding.resource.locator.path,
    versionKey: binding.resource.version.key,
  };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd });
  return result.stdout.trim();
}
