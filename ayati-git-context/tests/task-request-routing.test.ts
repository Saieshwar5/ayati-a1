import { describe, expect, it } from "vitest";
import type { TaskCard, TaskLifecycleStatus } from "../src/tasks/task-card.js";
import type { TaskRequestLifecycleState } from "../src/tasks/task-request-lifecycle.js";
import {
  resolveTaskRequestRoutingDecision,
  type TaskRequestRoutingDecision,
} from "../src/tasks/task-request-routing.js";
import type { TaskRequest, TaskRequestStatus } from "../src/tasks/task-request.js";

describe("task request routing resolution", () => {
  it("continues the exact active request for the same unfinished website outcome", () => {
    expect(resolve([task("T-20260717-0001", "active", "R-0002")], {
      kind: "continue_active_request",
      taskId: "T-20260717-0001",
      requestId: "R-0002",
      reason: "The mobile layout acceptance criteria are still unfinished.",
    })).toMatchObject({
      status: "ready",
      next: "continue_request",
      mutationReadiness: "ready",
      taskId: "T-20260717-0001",
      requestId: "R-0002",
    });
  });

  it("routes a separate website feature to a new active request in the same task", () => {
    expect(resolve([task("T-20260717-0001", "active", null)], {
      kind: "create_active_request",
      taskId: "T-20260717-0001",
      reason: "Online ordering is a new bounded feature in the website workstream.",
    })).toMatchObject({
      status: "ready",
      next: "create_active_request",
      mutationReadiness: "request_decision_required",
      taskId: "T-20260717-0001",
    });
  });

  it("queues an independent suggestion when another request is active", () => {
    expect(resolve([task("T-20260717-0001", "active", "R-0001")], {
      kind: "create_queued_request",
      taskId: "T-20260717-0001",
      reason: "Dark mode can be scheduled independently from the active checkout work.",
    })).toMatchObject({
      status: "ready",
      next: "create_queued_request",
      mutationReadiness: "not_requested",
      taskId: "T-20260717-0001",
    });
  });

  it("does not replace an existing active request with a second active request", () => {
    expect(resolve([task("T-20260717-0001", "active", "R-0001")], {
      kind: "create_active_request",
      taskId: "T-20260717-0001",
      reason: "The user requested a separate improvement.",
    })).toMatchObject({
      status: "clarification_required",
      next: "ask_clarification",
      recommendedDecision: "create_queued_request",
      candidateTaskIds: ["T-20260717-0001"],
    });
  });

  it("selects another task and reports whether its request is mutation-ready", () => {
    expect(resolve([
      task("T-20260717-0001", "active", "R-0001"),
      task("T-20260717-0002", "active", "R-0003"),
    ], {
      kind: "use_different_task",
      taskId: "T-20260717-0002",
      reason: "The named dataset belongs to the analysis task.",
    })).toMatchObject({
      status: "ready",
      next: "select_task",
      mutationReadiness: "ready",
      taskId: "T-20260717-0002",
      requestId: "R-0003",
    });
  });

  it("requires a lifecycle transition before paused or archived task mutation", () => {
    for (const status of ["paused", "archived"] as const) {
      expect(resolve([task("T-20260717-0001", status, null)], {
        kind: "create_active_request",
        taskId: "T-20260717-0001",
        reason: "The user requested a new implementation in this task.",
      })).toMatchObject({
        status: "lifecycle_transition_required",
        next: "transition_task_lifecycle",
        mutationReadiness: "lifecycle_transition_required",
        taskStatus: status,
      });
    }
  });

  it("allows read-only access to archived tasks without reopening them", () => {
    expect(resolve([task("T-20260717-0001", "archived", null)], {
      kind: "read_only",
      taskId: "T-20260717-0001",
      reason: "The user only asked what the archived project produced.",
    })).toMatchObject({
      status: "ready",
      next: "answer_read_only",
      mutationReadiness: "not_requested",
      taskId: "T-20260717-0001",
      taskStatus: "archived",
    });
  });

  it("lets unrelated durable work create a task when no strong owner exists", () => {
    expect(resolve([task("T-20260717-0001", "active", "R-0001")], {
      kind: "create_new_task",
      reason: "The automation has a separate purpose, lifecycle, and deliverables.",
    })).toMatchObject({
      status: "ready",
      next: "create_task",
      mutationReadiness: "task_creation_required",
    });
  });

  it("makes exact task and resource ownership outrank a conflicting choice", () => {
    const tasks = [
      task("T-20260717-0001", "active", "R-0001"),
      task("T-20260717-0002", "active", "R-0001"),
    ];
    expect(resolve(tasks, {
      kind: "use_different_task",
      taskId: "T-20260717-0002",
      reason: "The second title looks textually similar.",
    }, {
      explicitTaskId: "T-20260717-0001",
      resourceOwnerTaskIds: ["T-20260717-0001"],
    })).toMatchObject({
      status: "clarification_required",
      next: "ask_clarification",
      candidateTaskIds: ["T-20260717-0001", "T-20260717-0002"],
    });
    expect(resolve(tasks, {
      kind: "create_new_task",
      reason: "Create another task despite the exact task identity.",
    }, {
      explicitTaskId: "T-20260717-0001",
    })).toMatchObject({
      status: "clarification_required",
      recommendedDecision: "use_different_task",
      candidateTaskIds: ["T-20260717-0001"],
    });
  });

  it("requires clarification when strong resource ownership is genuinely ambiguous", () => {
    expect(resolve([
      task("T-20260717-0001", "active", "R-0001"),
      task("T-20260717-0002", "active", "R-0001"),
    ], {
      kind: "continue_active_request",
      taskId: "T-20260717-0001",
      requestId: "R-0001",
      reason: "Attempt to continue despite conflicting ownership.",
    }, {
      resourceOwnerTaskIds: ["T-20260717-0001", "T-20260717-0002"],
    })).toMatchObject({
      status: "clarification_required",
      next: "ask_clarification",
      candidateTaskIds: ["T-20260717-0001", "T-20260717-0002"],
    });
  });

  it("rejects malformed routing state instead of guessing", () => {
    const duplicate = task("T-20260717-0001", "active", "R-0001");
    expect(() => resolve([duplicate, structuredClone(duplicate)], {
      kind: "read_only",
      reason: "Inspect duplicate state.",
    })).toThrow(expect.objectContaining({ code: "INVALID_REQUEST" }));
    expect(() => resolve([duplicate], {
      kind: "read_only",
      reason: "Inspect state.",
    }, {
      explicitTaskId: "T-20260717-9999",
    })).toThrow(expect.objectContaining({ code: "INVALID_REQUEST" }));
    expect(() => resolve([duplicate], {
      kind: "use_different_task",
      taskId: "T-20260717-9999",
      reason: "Select an unavailable task.",
    })).toThrow(expect.objectContaining({ code: "INVALID_REQUEST" }));
  });
});

function resolve(
  tasks: TaskRequestLifecycleState[],
  decision: TaskRequestRoutingDecision,
  evidence?: { explicitTaskId?: string; resourceOwnerTaskIds?: string[] },
) {
  return resolveTaskRequestRoutingDecision({ tasks, ...(evidence ? { evidence } : {}) }, decision);
}

function task(
  taskId: string,
  status: TaskLifecycleStatus,
  currentRequestId: string | null,
): TaskRequestLifecycleState {
  const requests = currentRequestId
    ? [request(currentRequestId, "active")]
    : [request("R-0001", "done")];
  return {
    expectedHead: "a".repeat(40),
    taskCard: card(taskId, status, currentRequestId),
    requests,
  };
}

function card(
  taskId: string,
  status: TaskLifecycleStatus,
  currentRequest: string | null,
): TaskCard {
  return {
    schema: "ayati.task/v1",
    id: taskId,
    title: "Routing fixture",
    status,
    currentRequest,
    purpose: "Exercise deterministic task and request routing.",
    currentSnapshot: "The task has durable committed context.",
    currentFocus: currentRequest ? "Continue " + currentRequest + "." : "Choose the next request.",
    blockers: [],
    importantPaths: [],
    workingAgreements: [],
  };
}

function request(id: string, status: TaskRequestStatus): TaskRequest {
  return {
    schema: "ayati.request/v1",
    id,
    title: "Request " + id,
    status,
    createdAt: "2026-07-17T12:00:00+05:30",
    source: "user",
    request: "Complete the bounded requested outcome.",
    acceptance: ["The requested outcome is verified."],
    constraints: [],
    outcome: status === "done" ? "The request is complete." : "Not completed yet.",
  };
}
