import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type {
  FinalizeRunRequest,
  WorkstreamRequestLifecycleEffect,
  WorkstreamRequestRoute,
} from "../src/contracts.js";
import {
  validateWorkstreamRepository,
} from "../src/workstreams/workstream-repository-validator.js";
import {
  boundRequestAcceptance,
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

describe("live workstream request lifecycle routes", () => {
  it("queues, switches, amends, blocks, resumes, completes, and reactivates requests", async () => {
    const fixture = await createWorkstreamServiceFixture(
      "request-route-sequence",
      "Start the initial bounded project request.",
    );
    fixtures.push(fixture);
    const selected = await createBoundWorkstream(fixture, {
      title: "Route Lifecycle Project",
      objective: "Exercise every supported request route in one workstream.",
    });
    const workstreamId = selected.workstream.workstreamId;
    let head = await finalize(fixture, 1, "incomplete", { kind: "none" });

    await prepareAndRoute(fixture, workstreamId, head, 2, {
      kind: "create_queued",
      reason: "The user explicitly asked to record this independent outcome for later.",
      title: "Queued report",
      request: "Create the separate queued report.",
      acceptance: ["The report exists and is verified."],
      constraints: ["Keep the report concise."],
    });
    const queuedContext = await fixture.service.getAgentContext({
      streamId: fixture.prepared.stream.streamId,
    });
    expect(queuedContext.activeWorkstream).toMatchObject({
      currentRequest: { id: "R-0001", status: "active" },
      selectedRequest: { id: "R-0002", status: "queued" },
    });
    await expect(fixture.service.recordRunStep({
      requestId: "REQ-route-sequence-2-mutation-step",
      runId: fixture.prepared.run.runId,
      record: {
        version: 1,
        step: 1,
        status: "completed",
        summary: "A queued request must not execute mutations.",
        decision: { kind: "tool_call" },
        action: { callId: "call-queued-write" },
        toolCalls: [{
          callId: "call-queued-write",
          tool: "write_files",
          purpose: "Attempt work that belongs to the queued request.",
          toolPurpose: "mutation",
          toolEffect: "workspace_mutation",
          status: "success",
          input: { path: "queued-report.md" },
        }],
        verification: { passed: true },
        createdAt: at(2, 2),
      },
    })).rejects.toMatchObject({ code: "MUTATION_REQUIRES_WORKSTREAM_BINDING" });
    expect(fixture.database.prepare(
      "SELECT step_count FROM runs WHERE run_id = ?",
    ).get(fixture.prepared.run.runId)).toEqual({ step_count: 0 });
    head = await finalize(fixture, 2, "done", { kind: "none" });
    let validation = await validate(selected, fixture);
    expect(validation.requests).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "R-0001", status: "active" }),
      expect.objectContaining({ id: "R-0002", status: "queued", finalOutcome: "Pending." }),
    ]));

    await prepareAndRoute(fixture, workstreamId, head, 3, {
      kind: "defer_current_and_activate_existing",
      currentRequestId: "R-0001",
      nextRequestId: "R-0002",
      reason: "The user explicitly selected the queued report as the new priority.",
    });
    head = await finalize(fixture, 3, "incomplete", { kind: "none" });
    validation = await validate(selected, fixture);
    expect(validation.requests).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "R-0001", status: "queued" }),
      expect.objectContaining({ id: "R-0002", status: "active" }),
    ]));
    expect(validation.currentRequest?.id).toBe("R-0002");

    const originalPath = validation.requests.find((request) => request.id === "R-0002")
      ?.relativePath;
    await prepareAndRoute(fixture, workstreamId, head, 4, {
      kind: "amend_current",
      currentRequestId: "R-0002",
      reason: "The user clarified the report title and added a durable constraint.",
      authority: "user",
      patch: {
        title: "Clarified queued report",
        constraints: [
          "Keep the report concise.",
          "Use the existing project terminology.",
        ],
      },
    });
    head = await finalize(fixture, 4, "incomplete", { kind: "none" });
    validation = await validate(selected, fixture);
    expect(validation.currentRequest).toMatchObject({
      id: "R-0002",
      title: "Clarified queued report",
      constraints: [
        "Keep the report concise.",
        "Use the existing project terminology.",
      ],
      relativePath: originalPath,
    });
    const amendedContractHash = requestContractHash(fixture, workstreamId, "R-0002");

    await prepareAndRoute(fixture, workstreamId, head, 5, {
      kind: "continue_current",
      requestId: "R-0002",
      reason: "The same report request needs one missing user decision.",
    });
    head = await finalize(fixture, 5, "needs_user_input", {
      kind: "block",
      reason: "The user must choose the report audience.",
    });
    validation = await validate(selected, fixture);
    expect(validation.currentRequest).toBeUndefined();
    expect(validation.requests.find((request) => request.id === "R-0002"))
      .toMatchObject({ status: "blocked", finalOutcome: "Pending." });

    await prepareAndRoute(fixture, workstreamId, head, 6, {
      kind: "resume_blocked",
      requestId: "R-0002",
      reason: "The user supplied the audience and explicitly resumed the report.",
    });
    head = await finalize(fixture, 6, "incomplete", { kind: "none" });
    validation = await validate(selected, fixture);
    expect(validation.currentRequest).toMatchObject({ id: "R-0002", status: "active" });
    expect(validation.workstreamCard.blockers).not.toContain(
      "Request R-0002: The user must choose the report audience.",
    );

    await prepareAndRoute(fixture, workstreamId, head, 7, {
      kind: "continue_current",
      requestId: "R-0002",
      reason: "The resumed report is ready for verified completion.",
    });
    head = await finalize(fixture, 7, "done", {
      kind: "complete",
      verification: "verified",
    });
    validation = await validate(selected, fixture);
    expect(validation.currentRequest).toBeUndefined();
    expect(validation.requests.find((request) => request.id === "R-0002"))
      .toMatchObject({
        status: "done",
        finalOutcome: "Run 7 recorded durable request progress.",
      });

    await prepareAndRoute(fixture, workstreamId, head, 8, {
      kind: "activate_existing",
      requestId: "R-0001",
      reason: "The user explicitly returned to the deferred initial request.",
    });
    head = await finalize(fixture, 8, "incomplete", { kind: "none" });
    validation = await validate(selected, fixture);

    expect(validation.currentRequest).toMatchObject({ id: "R-0001", status: "active" });
    expect(validation.requests).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "R-0001", status: "active" }),
      expect.objectContaining({ id: "R-0002", status: "done" }),
    ]));
    expect(requestContractHash(fixture, workstreamId, "R-0002"))
      .toBe(amendedContractHash);
    expect(validation.progress.entries).toHaveLength(8);
    expect(new Set(validation.progress.entries.map((entry) => entry.runId)).size).toBe(8);
    expect(validation.progress.entries[1]).toMatchObject({
      requestId: "R-0002",
      outcome: "done",
      summary: "Run 2 recorded durable request progress.",
    });
    expect(await git(join(fixture.root, "workstreams"), [
      "rev-list",
      "--count",
      "HEAD",
    ])).toBe("9");
    expect(await git(join(fixture.root, "workstreams"), [
      "rev-parse",
      "HEAD",
    ])).toBe(head);
  }, 15_000);
});

async function prepareAndRoute(
  fixture: WorkstreamServiceFixture,
  workstreamId: string,
  expectedHead: string,
  runNumber: number,
  route: WorkstreamRequestRoute,
): Promise<void> {
  fixture.prepared = await fixture.service.prepareAgentRun({
    requestId: `REQ-route-sequence-${runNumber}`,
    timezone: "Asia/Kolkata",
    agentId: "local",
    role: "user",
    content: `Advance lifecycle route ${runNumber}.`,
    at: at(runNumber, 0),
  });
  await fixture.service.activateWorkstreamForRun({
    requestId: `REQ-route-sequence-${runNumber}-activate`,
    runId: fixture.prepared.run.runId,
    workstreamId,
    expectedWorkstreamHead: expectedHead,
    route,
    at: at(runNumber, 1),
  });
}

async function finalize(
  fixture: WorkstreamServiceFixture,
  runNumber: number,
  outcome: "done" | "incomplete" | "needs_user_input",
  requestEffect: WorkstreamRequestLifecycleEffect,
): Promise<string> {
  const summary = `Run ${runNumber} recorded durable request progress.`;
  const completed = requestEffect.kind === "complete";
  const input: FinalizeRunRequest = {
    requestId: `REQ-route-sequence-${runNumber}-finalize`,
    runId: fixture.prepared.run.runId,
    outcome,
    stopReason: outcome === "done"
      ? "completed"
      : outcome === "needs_user_input"
        ? "needs_user_input"
        : "run_limit",
    assistantResponse: summary,
    streamSummary: summary,
    summary,
    validation: completed ? "passed" : "not_applicable",
    ...(outcome === "incomplete"
      ? { next: "Continue the selected request." }
      : outcome === "needs_user_input"
        ? { next: "Ask the user to choose the report audience." }
        : {}),
    workState: workState({
      status: outcome === "done"
        ? "done"
        : outcome === "needs_user_input"
          ? "needs_user_input"
          : "in_progress",
      summary,
      nextAction: outcome === "incomplete"
        ? "Continue the selected request."
        : outcome === "needs_user_input"
          ? "Ask the user to choose the report audience."
          : null,
    }),
    workstream: {
      completion: completed
        ? {
            accepted: true,
            resources: [],
            missing: [],
            failures: [],
            criteria: boundRequestAcceptance(fixture).map((criterion) => ({
              criterion,
              passed: true,
            })),
          }
        : {
            accepted: false,
            resources: [],
            missing: [],
            failures: [],
            criteria: [],
          },
      requestEffect,
    },
    at: at(runNumber, 2),
  };
  const result = await fixture.service.finalizeRun(input);
  if (result.workstreamContextCommit.status !== "committed") {
    throw new Error("Expected the finalized bound run to create a context commit.");
  }
  return result.workstreamContextCommit.headAfter;
}

async function validate(
  selected: Awaited<ReturnType<typeof createBoundWorkstream>>,
  fixture: WorkstreamServiceFixture,
) {
  return await validateWorkstreamRepository({
    workstreamRoot: join(fixture.root, "workstreams"),
    contextRepositoryPath: selected.workstream.contextRepositoryPath,
    expectedWorkstreamId: selected.workstream.workstreamId,
    requestReadMode: "all",
  });
}

function requestContractHash(
  fixture: WorkstreamServiceFixture,
  workstreamId: string,
  requestId: string,
): string {
  const row = fixture.database.prepare([
    "SELECT contract_hash FROM workstream_requests",
    "WHERE workstream_id = ? AND request_id = ?",
  ].join(" ")).get(workstreamId, requestId) as { contract_hash: string } | undefined;
  if (!row) throw new Error("Expected the request contract projection.");
  return row.contract_hash;
}

function at(runNumber: number, second: number): string {
  return `2026-07-2${runNumber}T10:00:0${second}+05:30`;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}
