import { describe, expect, it } from "vitest";
import type { WorkstreamCard, WorkstreamLifecycleStatus } from "../src/workstreams/workstream-card.js";
import type { WorkstreamRequestLifecycleState } from "../src/workstreams/workstream-request-lifecycle.js";
import {
  resolveWorkstreamRequestRoutingDecision,
  type WorkstreamRequestRoutingDecision,
} from "../src/workstreams/workstream-request-routing.js";
import type { WorkstreamRequest, WorkstreamRequestStatus } from "../src/workstreams/workstream-request.js";

describe("workstream request routing resolution", () => {
  it("continues the exact active request for the same unfinished website outcome", () => {
    expect(resolve([workstream("W-20260717-0001", "active", "R-0002")], {
      kind: "continue_active_request",
      workstreamId: "W-20260717-0001",
      requestId: "R-0002",
      reason: "The mobile layout acceptance criteria are still unfinished.",
    })).toMatchObject({
      status: "ready",
      next: "continue_request",
      mutationReadiness: "ready",
      workstreamId: "W-20260717-0001",
      requestId: "R-0002",
    });
  });

  it("routes a separate website feature to a new active request in the same workstream", () => {
    expect(resolve([workstream("W-20260717-0001", "active", null)], {
      kind: "create_active_request",
      workstreamId: "W-20260717-0001",
      reason: "Online ordering is a new bounded feature in the website workstream.",
    })).toMatchObject({
      status: "ready",
      next: "create_active_request",
      mutationReadiness: "request_decision_required",
      workstreamId: "W-20260717-0001",
    });
  });

  it("queues an independent suggestion when another request is active", () => {
    expect(resolve([workstream("W-20260717-0001", "active", "R-0001")], {
      kind: "create_queued_request",
      workstreamId: "W-20260717-0001",
      reason: "Dark mode can be scheduled independently from the active checkout work.",
    })).toMatchObject({
      status: "ready",
      next: "create_queued_request",
      mutationReadiness: "not_requested",
      workstreamId: "W-20260717-0001",
    });
  });

  it("does not replace an existing active request with a second active request", () => {
    expect(resolve([workstream("W-20260717-0001", "active", "R-0001")], {
      kind: "create_active_request",
      workstreamId: "W-20260717-0001",
      reason: "The user requested a separate improvement.",
    })).toMatchObject({
      status: "clarification_required",
      next: "ask_clarification",
      recommendedDecision: "create_queued_request",
      candidateWorkstreamIds: ["W-20260717-0001"],
    });
  });

  it("selects another workstream and reports whether its request is mutation-ready", () => {
    expect(resolve([
      workstream("W-20260717-0001", "active", "R-0001"),
      workstream("W-20260717-0002", "active", "R-0003"),
    ], {
      kind: "use_different_workstream",
      workstreamId: "W-20260717-0002",
      reason: "The named dataset belongs to the analysis workstream.",
    })).toMatchObject({
      status: "ready",
      next: "select_workstream",
      mutationReadiness: "ready",
      workstreamId: "W-20260717-0002",
      requestId: "R-0003",
    });
  });

  it("requires a lifecycle transition before paused or archived workstream mutation", () => {
    for (const status of ["paused", "archived"] as const) {
      expect(resolve([workstream("W-20260717-0001", status, null)], {
        kind: "create_active_request",
        workstreamId: "W-20260717-0001",
        reason: "The user requested a new implementation in this workstream.",
      })).toMatchObject({
        status: "lifecycle_transition_required",
        next: "transition_workstream_lifecycle",
        mutationReadiness: "lifecycle_transition_required",
        workstreamStatus: status,
      });
    }
  });

  it("allows read-only access to archived workstreams without reopening them", () => {
    expect(resolve([workstream("W-20260717-0001", "archived", null)], {
      kind: "read_only",
      workstreamId: "W-20260717-0001",
      reason: "The user only asked what the archived project produced.",
    })).toMatchObject({
      status: "ready",
      next: "answer_read_only",
      mutationReadiness: "not_requested",
      workstreamId: "W-20260717-0001",
      workstreamStatus: "archived",
    });
  });

  it("lets unrelated durable work create a workstream when no strong owner exists", () => {
    expect(resolve([workstream("W-20260717-0001", "active", "R-0001")], {
      kind: "create_new_workstream",
      reason: "The automation has a separate purpose, lifecycle, and deliverables.",
    })).toMatchObject({
      status: "ready",
      next: "create_workstream",
      mutationReadiness: "workstream_creation_required",
    });
  });

  it("makes exact workstream and resource ownership outrank a conflicting choice", () => {
    const workstreams = [
      workstream("W-20260717-0001", "active", "R-0001"),
      workstream("W-20260717-0002", "active", "R-0001"),
    ];
    expect(resolve(workstreams, {
      kind: "use_different_workstream",
      workstreamId: "W-20260717-0002",
      reason: "The second title looks textually similar.",
    }, {
      explicitWorkstreamId: "W-20260717-0001",
      resourceOwnerWorkstreamIds: ["W-20260717-0001"],
    })).toMatchObject({
      status: "clarification_required",
      next: "ask_clarification",
      candidateWorkstreamIds: ["W-20260717-0001", "W-20260717-0002"],
    });
    expect(resolve(workstreams, {
      kind: "create_new_workstream",
      reason: "Create another workstream despite the exact workstream identity.",
    }, {
      explicitWorkstreamId: "W-20260717-0001",
    })).toMatchObject({
      status: "clarification_required",
      recommendedDecision: "use_different_workstream",
      candidateWorkstreamIds: ["W-20260717-0001"],
    });
  });

  it("requires clarification when strong resource ownership is genuinely ambiguous", () => {
    expect(resolve([
      workstream("W-20260717-0001", "active", "R-0001"),
      workstream("W-20260717-0002", "active", "R-0001"),
    ], {
      kind: "continue_active_request",
      workstreamId: "W-20260717-0001",
      requestId: "R-0001",
      reason: "Attempt to continue despite conflicting ownership.",
    }, {
      resourceOwnerWorkstreamIds: ["W-20260717-0001", "W-20260717-0002"],
    })).toMatchObject({
      status: "clarification_required",
      next: "ask_clarification",
      candidateWorkstreamIds: ["W-20260717-0001", "W-20260717-0002"],
    });
  });

  it("rejects malformed routing state instead of guessing", () => {
    const duplicate = workstream("W-20260717-0001", "active", "R-0001");
    expect(() => resolve([duplicate, structuredClone(duplicate)], {
      kind: "read_only",
      reason: "Inspect duplicate state.",
    })).toThrow(expect.objectContaining({ code: "INVALID_REQUEST" }));
    expect(() => resolve([duplicate], {
      kind: "read_only",
      reason: "Inspect state.",
    }, {
      explicitWorkstreamId: "W-20260717-9999",
    })).toThrow(expect.objectContaining({ code: "INVALID_REQUEST" }));
    expect(() => resolve([duplicate], {
      kind: "use_different_workstream",
      workstreamId: "W-20260717-9999",
      reason: "Select an unavailable workstream.",
    })).toThrow(expect.objectContaining({ code: "INVALID_REQUEST" }));
  });
});

function resolve(
  workstreams: WorkstreamRequestLifecycleState[],
  decision: WorkstreamRequestRoutingDecision,
  evidence?: { explicitWorkstreamId?: string; resourceOwnerWorkstreamIds?: string[] },
) {
  return resolveWorkstreamRequestRoutingDecision({ workstreams, ...(evidence ? { evidence } : {}) }, decision);
}

function workstream(
  workstreamId: string,
  status: WorkstreamLifecycleStatus,
  currentRequestId: string | null,
): WorkstreamRequestLifecycleState {
  const requests = currentRequestId
    ? [request(currentRequestId, "active")]
    : [request("R-0001", "done")];
  return {
    expectedHead: "a".repeat(40),
    workstreamCard: card(workstreamId, status, currentRequestId),
    requests,
  };
}

function card(
  workstreamId: string,
  status: WorkstreamLifecycleStatus,
  currentRequest: string | null,
): WorkstreamCard {
  return {
    schema: "ayati.workstream/v1",
    id: workstreamId,
    title: "Routing fixture",
    status,
    currentRequest,
    purpose: "Exercise deterministic workstream and request routing.",
    currentSnapshot: "The workstream has durable committed context.",
    currentFocus: currentRequest ? "Continue " + currentRequest + "." : "Choose the next request.",
    blockers: [],
    workingAgreements: [],
  };
}

function request(id: string, status: WorkstreamRequestStatus): WorkstreamRequest {
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
