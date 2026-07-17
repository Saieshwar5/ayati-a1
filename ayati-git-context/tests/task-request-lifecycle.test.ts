import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseTaskCard, type TaskCard } from "../src/tasks/task-card.js";
import {
  listTaskRequests,
  planTaskRequestChange,
  readTaskRequest,
  type TaskRequestLifecycleState,
} from "../src/tasks/task-request-lifecycle.js";
import { validateTaskRequestRoutingDecision } from "../src/tasks/task-request-routing.js";
import { validateTaskRepository } from "../src/tasks/task-repository-validator.js";
import { parseTaskRequest, type TaskRequest } from "../src/tasks/task-request.js";
import { createSimpleTaskFixture, git } from "./simple-task-repository-fixtures.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => {
    await rm(path, { recursive: true, force: true });
  }));
});

describe("task request lifecycle planner", () => {
  it("creates a queued request with a monotonic identity and no task-card write", () => {
    const state = requestState([
      request("R-0001", "done", "Initial work"),
      request("R-0002", "dropped", "Discarded work"),
    ]);
    const original = structuredClone(state);

    const plan = planTaskRequestChange(state, {
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
      taskCardAfter: { currentRequest: null },
      changedRequests: [{ id: "R-0003", status: "queued", source: "user" }],
      deletedPaths: [],
    });
    expect(plan.writes).toHaveLength(1);
    expect(plan.writes[0]?.path).toBe(
      ".ayati/requests/R-0003-practice-logistic-regression.md",
    );
    expect(parseTaskRequest(plan.writes[0]!.content)).toMatchObject({
      id: "R-0003",
      status: "queued",
    });
  });

  it("creates an active user request and synchronizes the task card", () => {
    const plan = planTaskRequestChange(requestState([
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
      taskCardAfter: {
        currentRequest: "R-0002",
        currentFocus: "Complete R-0002: Add accessible navigation.",
      },
    });
    expect(plan.writes.map((write) => write.path)).toEqual([
      ".ayati/requests/R-0002-add-accessible-navigation.md",
      ".ayati/task.md",
    ]);
    expect(parseTaskCard(plan.writes[1]!.content).currentRequest).toBe("R-0002");
  });

  it("rejects implicit agent-proposal activation and a second active request", () => {
    expectCode(() => planTaskRequestChange(requestState([]), {
      kind: "create",
      title: "Agent idea",
      request: "Consider an optional improvement.",
      acceptance: ["The idea is evaluated."],
      constraints: [],
      source: "agent_proposal",
      createdAt: "2026-07-17T13:00:00+05:30",
      activate: true,
    }), "TASK_REQUEST_STATE_INVALID");

    expectCode(() => planTaskRequestChange(activeState(), {
      kind: "create",
      title: "Second active request",
      request: "Attempt a second current request.",
      acceptance: ["The invariant is enforced."],
      constraints: [],
      source: "user",
      createdAt: "2026-07-17T13:00:00+05:30",
      activate: true,
    }), "TASK_REQUEST_STATE_INVALID");
  });

  it("activates only queued requests", () => {
    const plan = planTaskRequestChange(requestState([
      request("R-0001", "done", "Initial work"),
      request("R-0002", "queued", "Queued feature"),
    ]), { kind: "activate", requestId: "R-0002" });

    expect(plan).toMatchObject({
      operation: "activate",
      activatedRequestId: "R-0002",
      changedRequests: [{ id: "R-0002", status: "active" }],
      taskCardAfter: { currentRequest: "R-0002" },
    });
    expectCode(() => planTaskRequestChange(requestState([
      request("R-0001", "blocked", "Blocked work"),
    ]), { kind: "activate", requestId: "R-0001" }), "TASK_REQUEST_STATE_INVALID");
  });

  it("blocks the current request, clears current_request, and records one blocker", () => {
    const plan = planTaskRequestChange(activeState(), {
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
      taskCardAfter: {
        currentRequest: null,
        blockers: ["Request R-0001: The user must provide the source dataset."],
      },
    });
  });

  it("resumes a blocked request and removes only its task-card blocker", () => {
    const card = taskCard(null);
    card.blockers = [
      "Request R-0001: Waiting for data.",
      "A separate durable blocker.",
    ];
    const plan = planTaskRequestChange({
      expectedHead: "a".repeat(40),
      taskCard: card,
      requests: [request("R-0001", "blocked", "Analyze data")],
    }, { kind: "resume", requestId: "R-0001" });

    expect(plan).toMatchObject({
      activatedRequestId: "R-0001",
      changedRequests: [{ id: "R-0001", status: "active" }],
      taskCardAfter: {
        currentRequest: "R-0001",
        blockers: ["A separate durable blocker."],
      },
    });
  });

  it("completes verified work, preserves the task, and clears current_request", () => {
    const state = activeState();
    const originalRequest = structuredClone(state.requests[0]);
    const plan = planTaskRequestChange(state, {
      kind: "complete",
      requestId: "R-0001",
      outcome: "The implementation and focused tests are complete.",
      verification: "verified",
    });

    expect(plan).toMatchObject({
      completionVerification: "verified",
      taskCardAfter: { status: "active", currentRequest: null },
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
    const plan = planTaskRequestChange(state, {
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
      taskCardAfter: { currentRequest: "R-0002" },
      changedRequests: [
        { id: "R-0001", status: "done" },
        { id: "R-0002", status: "active" },
      ],
    });
    expect(plan.writes.map((write) => write.path)).toEqual([
      ".ayati/requests/R-0001-initial-request.md",
      ".ayati/requests/R-0002-next-feature.md",
      ".ayati/task.md",
    ]);
  });

  it("drops requests durably without producing a delete", () => {
    const plan = planTaskRequestChange(requestState([
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
    expect(parseTaskRequest(plan.writes[0]!.content)).toMatchObject({
      status: "dropped",
      outcome: "Dropped: The user no longer wants this feature.",
    });
    expectCode(() => planTaskRequestChange(requestState([
      request("R-0001", "dropped", "Already dropped"),
    ]), {
      kind: "drop",
      requestId: "R-0001",
      reason: "Drop it again.",
    }), "TASK_REQUEST_STATE_INVALID");
  });

  it("reopens only an explicitly confirmed completed intention", () => {
    const state = requestState([request("R-0001", "done", "Correct same defect")]);
    const original = structuredClone(state.requests[0]);
    const plan = planTaskRequestChange(state, {
      kind: "reopen",
      requestId: "R-0001",
      reason: "The original acceptance criterion was not actually satisfied.",
      explicitSameIntention: true,
    });

    expect(plan).toMatchObject({
      activatedRequestId: "R-0001",
      changedRequests: [{ id: "R-0001", status: "active" }],
      taskCardAfter: { currentRequest: "R-0001" },
    });
    expect(plan.changedRequests[0]).toMatchObject({
      request: original?.request,
      acceptance: original?.acceptance,
    });
    expectCode(() => planTaskRequestChange(state, {
      kind: "reopen",
      requestId: "R-0001",
      reason: "Try again.",
      explicitSameIntention: false,
    }), "TASK_REQUEST_STATE_INVALID");
  });

  it("rejects malformed whole-task request state and archived-task changes", () => {
    const multiple = activeState();
    multiple.requests.push(request("R-0002", "active", "Second active"));
    expectCode(() => listTaskRequests(multiple), "TASK_REQUEST_STATE_INVALID");

    const mismatch = activeState();
    mismatch.taskCard.currentRequest = null;
    expectCode(() => listTaskRequests(mismatch), "TASK_REQUEST_STATE_INVALID");

    const archived = requestState([request("R-0001", "queued", "Queued")]);
    archived.taskCard.status = "archived";
    expectCode(() => planTaskRequestChange(archived, {
      kind: "drop",
      requestId: "R-0001",
      reason: "No longer needed.",
    }), "TASK_REQUEST_STATE_INVALID");
  });

  it("lists requests in identity order and returns defensive copies", () => {
    const state = requestState([
      request("R-0002", "queued", "Second"),
      request("R-0001", "done", "First"),
    ]);

    const listed = listTaskRequests(state);
    const read = readTaskRequest(state, "R-0002");
    listed[0]!.acceptance.push("Mutated copy");
    read.constraints.push("Mutated copy");

    expect(listed.map((request) => request.id)).toEqual(["R-0001", "R-0002"]);
    expect(state.requests[1]?.acceptance).not.toContain("Mutated copy");
    expect(state.requests[0]?.constraints).not.toContain("Mutated copy");
    expectCode(() => readTaskRequest(state, "R-9999"), "TASK_REQUEST_STATE_INVALID");
  });

  it("validates explicit routing decisions without applying keyword heuristics", () => {
    expect(validateTaskRequestRoutingDecision({
      kind: "continue_active_request",
      taskId: "T-20260717-0001",
      requestId: "R-0002",
      reason: "  The user is continuing the same unfinished outcome.  ",
    })).toEqual({
      kind: "continue_active_request",
      taskId: "T-20260717-0001",
      requestId: "R-0002",
      reason: "The user is continuing the same unfinished outcome.",
    });
    expect(validateTaskRequestRoutingDecision({
      kind: "read_only",
      reason: "The user only asked what changed.",
    })).toEqual({
      kind: "read_only",
      reason: "The user only asked what changed.",
    });
    expectCode(() => validateTaskRequestRoutingDecision({
      kind: "clarify",
      reason: "The target task is ambiguous.",
      question: "  ",
    }), "INVALID_REQUEST");
  });

  it("plans against a real committed V1 task without filesystem or Git side effects", async () => {
    const root = await mkdtemp(join(tmpdir(), "ayati-request-plan-"));
    temporaryDirectories.push(root);
    const taskRoot = join(root, "tasks");
    await mkdir(taskRoot);
    const fixture = await createSimpleTaskFixture({
      taskRoot,
      taskId: "T-20260717-0001",
      title: "Website task",
      domain: "coding",
    });
    const validation = await validateTaskRepository({
      taskRoot,
      repositoryPath: fixture.repositoryPath,
    });
    const headBefore = await git(fixture.repositoryPath, ["rev-parse", "HEAD"]);
    const statusBefore = await git(fixture.repositoryPath, [
      "status",
      "--porcelain",
      "--untracked-files=all",
    ]);
    const cardBefore = await readFile(join(fixture.repositoryPath, ".ayati/task.md"), "utf8");

    const plan = planTaskRequestChange({
      expectedHead: headBefore,
      taskCard: validation.taskCard,
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
    expect(await git(fixture.repositoryPath, ["rev-parse", "HEAD"])).toBe(headBefore);
    expect(await git(fixture.repositoryPath, [
      "status",
      "--porcelain",
      "--untracked-files=all",
    ])).toBe(statusBefore);
    expect(await readFile(join(fixture.repositoryPath, ".ayati/task.md"), "utf8"))
      .toBe(cardBefore);
    await expect(access(join(
      fixture.repositoryPath,
      ".ayati/requests/R-0002-add-dark-mode.md",
    ))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function activeState(): TaskRequestLifecycleState {
  return requestState([request("R-0001", "active", "Initial request")], "R-0001");
}

function requestState(
  requests: TaskRequest[],
  currentRequest: string | null = null,
): TaskRequestLifecycleState {
  return {
    expectedHead: "a".repeat(40),
    taskCard: taskCard(currentRequest),
    requests,
  };
}

function taskCard(currentRequest: string | null): TaskCard {
  return {
    schema: "ayati.task/v1",
    id: "T-20260717-0001",
    title: "Lifecycle task",
    status: "active",
    currentRequest,
    purpose: "Exercise the durable request lifecycle.",
    currentSnapshot: "The task repository is initialized.",
    currentFocus: currentRequest
      ? "Complete " + currentRequest + ": Initial request."
      : "Choose or create the next request.",
    blockers: [],
    importantPaths: [],
    workingAgreements: ["Keep request state deterministic."],
  };
}

function request(id: string, status: TaskRequest["status"], title: string): TaskRequest {
  return {
    schema: "ayati.request/v1",
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

function expectCode(operation: () => unknown, code: string): void {
  try {
    operation();
  } catch (error) {
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error("Expected operation to throw " + code + ".");
}
