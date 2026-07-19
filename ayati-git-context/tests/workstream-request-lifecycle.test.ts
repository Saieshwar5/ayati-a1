import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseWorkstreamCard, type WorkstreamCard } from "../src/workstreams/workstream-card.js";
import {
  listWorkstreamRequests,
  planWorkstreamRequestChange,
  readWorkstreamRequest,
  type WorkstreamRequestLifecycleState,
} from "../src/workstreams/workstream-request-lifecycle.js";
import { validateWorkstreamRequestRoutingDecision } from "../src/workstreams/workstream-request-routing.js";
import { validateWorkstreamRepository } from "../src/workstreams/workstream-repository-validator.js";
import { parseWorkstreamRequest, type WorkstreamRequest } from "../src/workstreams/workstream-request.js";
import {
  createBoundWorkstream,
  createWorkstreamServiceFixture,
  type WorkstreamServiceFixture,
} from "./simple-workstream-repository-fixtures.js";

const fixtures: WorkstreamServiceFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (fixture) => await fixture.dispose()));
});

describe("workstream request lifecycle planner", () => {
  it("creates a queued request with a monotonic identity and no workstream-card write", () => {
    const state = requestState([
      request("R-0001", "done", "Initial work"),
      request("R-0002", "dropped", "Discarded work"),
    ]);
    const original = structuredClone(state);

    const plan = planWorkstreamRequestChange(state, {
      kind: "create",
      title: "Practice logistic regression",
      request: "Explain and implement logistic regression.",
      acceptance: ["The explanation exists.", "The implementation is verified."],
      constraints: ["Use NumPy first."],
      source: "user",
      createdAt: "2026-07-17T13:00:00+05:30",
      activate: false,
    });

    expect(state).toEqual(original);
    expect(plan).toMatchObject({
      operation: "create",
      primaryRequestId: "R-0003",
      workstreamCardAfter: { currentRequest: null },
      changedRequests: [{ id: "R-0003", status: "queued", source: "user" }],
      deletedPaths: [],
    });
    expect(plan.writes).toHaveLength(1);
    expect(plan.writes[0]?.path).toBe(
      "requests/R-0003-practice-logistic-regression.md",
    );
    expect(parseWorkstreamRequest(plan.writes[0]!.content)).toMatchObject({
      id: "R-0003",
      status: "queued",
    });
  });

  it("creates an active user request and synchronizes the workstream card", () => {
    const plan = planWorkstreamRequestChange(requestState([
      request("R-0001", "done", "Initial work"),
    ]), {
      kind: "create",
      title: "Add accessible navigation",
      request: "Add accessible responsive navigation.",
      acceptance: ["Keyboard navigation works."],
      constraints: [],
      source: "user",
      createdAt: "2026-07-17T13:00:00+05:30",
      activate: true,
    });

    expect(plan).toMatchObject({
      primaryRequestId: "R-0002",
      activatedRequestId: "R-0002",
      workstreamCardAfter: {
        currentRequest: "R-0002",
        currentFocus: "Complete R-0002: Add accessible navigation.",
      },
    });
    expect(plan.writes.map((write) => write.path)).toEqual([
      "requests/R-0002-add-accessible-navigation.md",
      "workstream.md",
    ]);
    expect(parseWorkstreamCard(plan.writes[1]!.content).currentRequest).toBe("R-0002");
  });

  it("rejects implicit agent-proposal activation and a second active request", () => {
    expectCode(() => planWorkstreamRequestChange(requestState([]), {
      kind: "create",
      title: "Agent idea",
      request: "Consider an optional improvement.",
      acceptance: ["The idea is evaluated."],
      constraints: [],
      source: "agent_proposal",
      createdAt: "2026-07-17T13:00:00+05:30",
      activate: true,
    }), "WORKSTREAM_REQUEST_STATE_INVALID");

    expectCode(() => planWorkstreamRequestChange(activeState(), {
      kind: "create",
      title: "Second active request",
      request: "Attempt a second current request.",
      acceptance: ["The invariant is enforced."],
      constraints: [],
      source: "user",
      createdAt: "2026-07-17T13:00:00+05:30",
      activate: true,
    }), "WORKSTREAM_REQUEST_STATE_INVALID");
  });

  it("activates only queued requests", () => {
    const plan = planWorkstreamRequestChange(requestState([
      request("R-0001", "done", "Initial work"),
      request("R-0002", "queued", "Queued feature"),
    ]), { kind: "activate", requestId: "R-0002" });

    expect(plan).toMatchObject({
      operation: "activate",
      activatedRequestId: "R-0002",
      changedRequests: [{ id: "R-0002", status: "active" }],
      workstreamCardAfter: { currentRequest: "R-0002" },
    });
    expectCode(() => planWorkstreamRequestChange(requestState([
      request("R-0001", "blocked", "Blocked work"),
    ]), { kind: "activate", requestId: "R-0001" }), "WORKSTREAM_REQUEST_STATE_INVALID");
  });

  it("blocks the current request, clears current_request, and records one blocker", () => {
    const plan = planWorkstreamRequestChange(activeState(), {
      kind: "block",
      requestId: "R-0001",
      reason: "The user must provide the source dataset.",
    });

    expect(plan).toMatchObject({
      changedRequests: [{
        id: "R-0001",
        status: "blocked",
        outcome: "Blocked: The user must provide the source dataset.",
      }],
      workstreamCardAfter: {
        currentRequest: null,
        blockers: ["Request R-0001: The user must provide the source dataset."],
      },
    });
  });

  it("resumes a blocked request and removes only its workstream-card blocker", () => {
    const card = workstreamCard(null);
    card.blockers = [
      "Request R-0001: Waiting for data.",
      "A separate durable blocker.",
    ];
    const plan = planWorkstreamRequestChange({
      expectedHead: "a".repeat(40),
      workstreamCard: card,
      requests: [request("R-0001", "blocked", "Analyze data")],
    }, { kind: "resume", requestId: "R-0001" });

    expect(plan).toMatchObject({
      activatedRequestId: "R-0001",
      changedRequests: [{ id: "R-0001", status: "active" }],
      workstreamCardAfter: {
        currentRequest: "R-0001",
        blockers: ["A separate durable blocker."],
      },
    });
  });

  it("completes verified work, preserves the workstream, and clears current_request", () => {
    const state = activeState();
    const originalRequest = structuredClone(state.requests[0]);
    const plan = planWorkstreamRequestChange(state, {
      kind: "complete",
      requestId: "R-0001",
      outcome: "The implementation and focused tests are complete.",
      verification: "verified",
    });

    expect(plan).toMatchObject({
      completionVerification: "verified",
      workstreamCardAfter: { status: "active", currentRequest: null },
      changedRequests: [{
        id: "R-0001",
        status: "done",
        outcome: "The implementation and focused tests are complete.",
      }],
    });
    expect(plan.changedRequests[0]).toMatchObject({
      request: originalRequest?.request,
      acceptance: originalRequest?.acceptance,
    });
  });

  it("completes one request and activates one authorized queued request atomically", () => {
    const state = activeState();
    state.requests.push(request("R-0002", "queued", "Next feature"));
    const plan = planWorkstreamRequestChange(state, {
      kind: "complete",
      requestId: "R-0001",
      outcome: "The current request is complete.",
      verification: "user_accepted",
      activateNextRequestId: "R-0002",
    });

    expect(plan).toMatchObject({
      primaryRequestId: "R-0001",
      activatedRequestId: "R-0002",
      completionVerification: "user_accepted",
      workstreamCardAfter: { currentRequest: "R-0002" },
      changedRequests: [
        { id: "R-0001", status: "done" },
        { id: "R-0002", status: "active" },
      ],
    });
    expect(plan.writes.map((write) => write.path)).toEqual([
      "requests/R-0001-initial-request.md",
      "requests/R-0002-next-feature.md",
      "workstream.md",
    ]);
  });

  it("drops requests durably without producing a delete", () => {
    const plan = planWorkstreamRequestChange(requestState([
      request("R-0001", "queued", "Optional feature"),
    ]), {
      kind: "drop",
      requestId: "R-0001",
      reason: "The user no longer wants this feature.",
    });

    expect(plan).toMatchObject({
      changedRequests: [{ id: "R-0001", status: "dropped" }],
      deletedPaths: [],
    });
    expect(plan.writes).toHaveLength(1);
    expect(parseWorkstreamRequest(plan.writes[0]!.content)).toMatchObject({
      status: "dropped",
      outcome: "Dropped: The user no longer wants this feature.",
    });
    expectCode(() => planWorkstreamRequestChange(requestState([
      request("R-0001", "dropped", "Already dropped"),
    ]), {
      kind: "drop",
      requestId: "R-0001",
      reason: "Drop it again.",
    }), "WORKSTREAM_REQUEST_STATE_INVALID");
  });

  it("reopens only an explicitly confirmed completed intention", () => {
    const state = requestState([request("R-0001", "done", "Correct same defect")]);
    const original = structuredClone(state.requests[0]);
    const plan = planWorkstreamRequestChange(state, {
      kind: "reopen",
      requestId: "R-0001",
      reason: "The original acceptance criterion was not actually satisfied.",
      explicitSameIntention: true,
    });

    expect(plan).toMatchObject({
      activatedRequestId: "R-0001",
      changedRequests: [{ id: "R-0001", status: "active" }],
      workstreamCardAfter: { currentRequest: "R-0001" },
    });
    expect(plan.changedRequests[0]).toMatchObject({
      request: original?.request,
      acceptance: original?.acceptance,
    });
    expectCode(() => planWorkstreamRequestChange(state, {
      kind: "reopen",
      requestId: "R-0001",
      reason: "Try again.",
      explicitSameIntention: false,
    }), "WORKSTREAM_REQUEST_STATE_INVALID");
  });

  it("rejects malformed whole-workstream request state and archived-workstream changes", () => {
    const multiple = activeState();
    multiple.requests.push(request("R-0002", "active", "Second active"));
    expectCode(() => listWorkstreamRequests(multiple), "WORKSTREAM_REQUEST_STATE_INVALID");

    const mismatch = activeState();
    mismatch.workstreamCard.currentRequest = null;
    expectCode(() => listWorkstreamRequests(mismatch), "WORKSTREAM_REQUEST_STATE_INVALID");

    const archived = requestState([request("R-0001", "queued", "Queued")]);
    archived.workstreamCard.status = "archived";
    expectCode(() => planWorkstreamRequestChange(archived, {
      kind: "drop",
      requestId: "R-0001",
      reason: "No longer needed.",
    }), "WORKSTREAM_REQUEST_STATE_INVALID");
  });

  it("lists requests in identity order and returns defensive copies", () => {
    const state = requestState([
      request("R-0002", "queued", "Second"),
      request("R-0001", "done", "First"),
    ]);

    const listed = listWorkstreamRequests(state);
    const read = readWorkstreamRequest(state, "R-0002");
    listed[0]!.acceptance.push("Mutated copy");
    read.constraints.push("Mutated copy");

    expect(listed.map((request) => request.id)).toEqual(["R-0001", "R-0002"]);
    expect(state.requests[1]?.acceptance).not.toContain("Mutated copy");
    expect(state.requests[0]?.constraints).not.toContain("Mutated copy");
    expectCode(() => readWorkstreamRequest(state, "R-9999"), "WORKSTREAM_REQUEST_STATE_INVALID");
  });

  it("validates explicit routing decisions without applying keyword heuristics", () => {
    expect(validateWorkstreamRequestRoutingDecision({
      kind: "continue_active_request",
      workstreamId: "W-20260717-0001",
      requestId: "R-0002",
      reason: "  The user is continuing the same unfinished outcome.  ",
    })).toEqual({
      kind: "continue_active_request",
      workstreamId: "W-20260717-0001",
      requestId: "R-0002",
      reason: "The user is continuing the same unfinished outcome.",
    });
    expect(validateWorkstreamRequestRoutingDecision({
      kind: "read_only",
      reason: "The user only asked what changed.",
    })).toEqual({
      kind: "read_only",
      reason: "The user only asked what changed.",
    });
    expectCode(() => validateWorkstreamRequestRoutingDecision({
      kind: "clarify",
      reason: "The target workstream is ambiguous.",
      question: "  ",
    }), "INVALID_REQUEST");
  });

  it("plans against a real committed V2 workstream without filesystem or Git side effects", async () => {
    const fixture = await createWorkstreamServiceFixture("request-plan");
    fixtures.push(fixture);
    const selected = await createBoundWorkstream(fixture, {
      title: "Website workstream",
      objective: "Maintain a website through durable requests.",
    });
    const workstreamRoot = join(fixture.root, "workstreams");
    const validation = await validateWorkstreamRepository({
      workstreamRoot,
      contextRepositoryPath: selected.workstream.contextRepositoryPath,
    });
    const headBefore = await git(selected.workstream.contextRepositoryPath, ["rev-parse", "HEAD"]);
    const statusBefore = await git(selected.workstream.contextRepositoryPath, [
      "status",
      "--porcelain",
      "--untracked-files=all",
    ]);
    const cardBefore = await readFile(join(selected.workstream.contextRepositoryPath, "workstream.md"), "utf8");

    const plan = planWorkstreamRequestChange({
      expectedHead: headBefore,
      workstreamCard: validation.workstreamCard,
      requests: validation.requests,
    }, {
      kind: "create",
      title: "Add dark mode",
      request: "Add an accessible dark color scheme.",
      acceptance: ["The theme passes focused accessibility checks."],
      constraints: ["Preserve the existing semantic structure."],
      source: "user",
      createdAt: "2026-07-17T13:00:00+05:30",
      activate: false,
    });

    expect(plan.primaryRequestId).toBe("R-0002");
    expect(await git(selected.workstream.contextRepositoryPath, ["rev-parse", "HEAD"])).toBe(headBefore);
    expect(await git(selected.workstream.contextRepositoryPath, [
      "status",
      "--porcelain",
      "--untracked-files=all",
    ])).toBe(statusBefore);
    expect(await readFile(join(selected.workstream.contextRepositoryPath, "workstream.md"), "utf8"))
      .toBe(cardBefore);
    await expect(access(join(
      selected.workstream.contextRepositoryPath,
      "requests/R-0002-add-dark-mode.md",
    ))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function activeState(): WorkstreamRequestLifecycleState {
  return requestState([request("R-0001", "active", "Initial request")], "R-0001");
}

function requestState(
  requests: WorkstreamRequest[],
  currentRequest: string | null = null,
): WorkstreamRequestLifecycleState {
  return {
    expectedHead: "a".repeat(40),
    workstreamCard: workstreamCard(currentRequest),
    requests,
  };
}

function workstreamCard(currentRequest: string | null): WorkstreamCard {
  return {
    schema: "ayati.workstream/v2",
    id: "W-20260717-0001",
    title: "Lifecycle workstream",
    status: "active",
    currentRequest,
    purpose: "Exercise the durable request lifecycle.",
    currentSnapshot: "The workstream repository is initialized.",
    currentFocus: currentRequest
      ? "Complete " + currentRequest + ": Initial request."
      : "Choose or create the next request.",
    blockers: [],
    workingAgreements: ["Keep request state deterministic."],
  };
}

function request(id: string, status: WorkstreamRequest["status"], title: string): WorkstreamRequest {
  return {
    schema: "ayati.request/v2",
    id,
    title,
    status,
    createdAt: "2026-07-17T12:00:00+05:30",
    source: "user",
    request: "Complete " + title.toLowerCase() + ".",
    acceptance: ["The requested outcome is verified."],
    constraints: [],
    outcome: status === "done" ? "The request is complete." : "Not completed yet.",
  };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const result = await promisify(execFile)("git", args, { cwd });
  return result.stdout.trim();
}

function expectCode(operation: () => unknown, code: string): void {
  try {
    operation();
  } catch (error) {
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error("Expected operation to throw " + code + ".");
}
