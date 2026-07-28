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
import {
  parseWorkstreamRequest,
  validateWorkstreamRequestTransition,
  type WorkstreamRequest,
} from "../src/workstreams/workstream-request.js";
import {
  createBoundWorkstream,
  createWorkstreamServiceFixture,
  workState,
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

  it("defers the current request without changing its contract or outcome", () => {
    const state = activeState();
    state.requests[0]!.lifecycleNote = "Implementation is partially verified.";
    state.workstreamCard.blockers = ["A separate durable blocker."];
    const originalRequest = structuredClone(state.requests[0]!);

    const plan = planWorkstreamRequestChange(state, {
      kind: "defer",
      requestId: "R-0001",
      reason: "A newly authorized request should run first.",
    });

    expect(plan).toMatchObject({
      operation: "defer",
      primaryRequestId: "R-0001",
      deferralReason: "A newly authorized request should run first.",
      changedRequests: [{
        id: "R-0001",
        status: "queued",
        lifecycleNote: "Deferred: A newly authorized request should run first.",
      }],
      workstreamCardAfter: {
        status: "active",
        currentRequest: null,
        currentFocus: "Choose or create the next request. Deferred R-0001: "
          + "A newly authorized request should run first.",
        blockers: ["A separate durable blocker."],
      },
    });
    expect(plan.changedRequests[0]).toEqual({
      ...originalRequest,
      status: "queued",
      lifecycleNote: "Deferred: A newly authorized request should run first.",
    });
    expect(plan.writes.map((write) => write.path)).toEqual([
      "requests/R-0001-initial-request.md",
      "workstream.md",
    ]);

    const reactivated = planWorkstreamRequestChange({
      expectedHead: plan.expectedHead,
      workstreamCard: plan.workstreamCardAfter,
      requests: plan.requestsAfter,
    }, { kind: "activate", requestId: "R-0001" });
    expect(reactivated).toMatchObject({
      activatedRequestId: "R-0001",
      changedRequests: [{
        id: "R-0001",
        status: "active",
        finalOutcome: "Pending.",
      }],
      workstreamCardAfter: { currentRequest: "R-0001" },
    });
  });

  it("rejects deferring anything except the current active request", () => {
    for (const status of ["queued", "blocked", "done", "dropped"] as const) {
      expectCode(() => planWorkstreamRequestChange(requestState([
        request("R-0001", status, "Not active"),
      ]), {
        kind: "defer",
        requestId: "R-0001",
        reason: "Another request should run first.",
      }), "WORKSTREAM_REQUEST_STATE_INVALID");
    }

    const nonCurrent = activeState();
    nonCurrent.requests.push(request("R-0002", "queued", "Queued request"));
    expectCode(() => planWorkstreamRequestChange(nonCurrent, {
      kind: "defer",
      requestId: "R-0002",
      reason: "Another request should run first.",
    }), "WORKSTREAM_REQUEST_STATE_INVALID");
  });

  it("atomically defers the current request and creates the next active request", () => {
    const state = activeState();
    state.requests[0]!.lifecycleNote = "The initial implementation is partially verified.";
    state.requests.push(request("R-0002", "done", "Earlier completed work"));
    const original = structuredClone(state);

    const plan = planWorkstreamRequestChange(state, {
      kind: "defer_and_create",
      currentRequestId: "R-0001",
      deferReason: "The newly authorized contact form should run first.",
      newRequest: newRequestInput("Add contact form"),
    });

    expect(state).toEqual(original);
    expect(plan).toMatchObject({
      operation: "defer_and_create",
      primaryRequestId: "R-0001",
      activatedRequestId: "R-0003",
      deferralReason: "The newly authorized contact form should run first.",
      changedRequests: [
        { id: "R-0001", status: "queued" },
        { id: "R-0003", status: "active", source: "user", finalOutcome: "Pending." },
      ],
      workstreamCardAfter: {
        status: "active",
        currentRequest: "R-0003",
        currentFocus: "Complete R-0003: Add contact form.",
      },
    });
    expect(plan.changedRequests[0]).toEqual({
      ...original.requests[0]!,
      status: "queued",
      updatedAt: "2026-07-17T13:00:00+05:30",
      lifecycleNote: "Deferred: The newly authorized contact form should run first.",
    });
    expect(plan.requestsAfter.filter((request) => request.status === "active")
      .map((request) => request.id)).toEqual(["R-0003"]);
    expect(plan.writes.map((write) => write.path)).toEqual([
      "requests/R-0001-initial-request.md",
      "requests/R-0003-add-contact-form.md",
      "workstream.md",
    ]);
  });

  it("rejects an unauthorized or mismatched atomic request switch", () => {
    expectCode(() => planWorkstreamRequestChange(activeState(), {
      kind: "defer_and_create",
      currentRequestId: "R-0001",
      deferReason: "Try an agent-selected replacement.",
      newRequest: newRequestInput("Agent idea", "agent_proposal"),
    }), "WORKSTREAM_REQUEST_STATE_INVALID");

    const state = activeState();
    state.requests.push(request("R-0002", "queued", "Different queued request"));
    expectCode(() => planWorkstreamRequestChange(state, {
      kind: "defer_and_create",
      currentRequestId: "R-0002",
      deferReason: "Target the wrong request.",
      newRequest: newRequestInput("New work"),
    }), "WORKSTREAM_REQUEST_STATE_INVALID");
  });

  it("atomically defers the current request and activates an existing queued request", () => {
    const state = activeState();
    state.requests.push(request("R-0002", "queued", "Queued priority"));

    const plan = planWorkstreamRequestChange(state, {
      kind: "defer_and_activate",
      currentRequestId: "R-0001",
      nextRequestId: "R-0002",
      deferReason: "The queued priority was selected explicitly.",
      at: "2026-07-17T14:00:00+05:30",
    });

    expect(plan).toMatchObject({
      operation: "defer_and_activate",
      primaryRequestId: "R-0001",
      activatedRequestId: "R-0002",
      deferralReason: "The queued priority was selected explicitly.",
      changedRequests: [
        {
          id: "R-0001",
          status: "queued",
          lifecycleNote: "Deferred: The queued priority was selected explicitly.",
        },
        {
          id: "R-0002",
          status: "active",
          lifecycleNote: "Activated after deferring R-0001.",
        },
      ],
      workstreamCardAfter: {
        currentRequest: "R-0002",
        currentFocus: "Complete R-0002: Queued priority.",
      },
    });
    expect(plan.requestsAfter.filter((entry) => entry.status === "active"))
      .toEqual([expect.objectContaining({ id: "R-0002" })]);
    expect(plan.writes.map((write) => write.path)).toEqual([
      "requests/R-0001-initial-request.md",
      "requests/R-0002-queued-priority.md",
      "workstream.md",
    ]);
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
        finalOutcome: "Pending.",
        lifecycleNote: "Blocked: The user must provide the source dataset.",
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

  it("resolves a blocked request to queued without displacing the active request", () => {
    const state = activeState();
    state.requests.push(request("R-0002", "blocked", "Deferred analysis"));
    state.workstreamCard.blockers = [
      "Request R-0002: Waiting for an external dataset.",
      "A separate durable blocker.",
    ];

    const plan = planWorkstreamRequestChange(state, {
      kind: "resolve_blocked_to_queued",
      requestId: "R-0002",
      reason: "The dataset is now available, but the current request remains first.",
      at: "2026-07-17T14:00:00+05:30",
    });

    expect(plan).toMatchObject({
      operation: "resolve_blocked_to_queued",
      primaryRequestId: "R-0002",
      changedRequests: [{
        id: "R-0002",
        status: "queued",
        lifecycleNote: "Blocker resolved; queued: The dataset is now available, "
          + "but the current request remains first.",
      }],
      workstreamCardAfter: {
        currentRequest: "R-0001",
        blockers: ["A separate durable blocker."],
      },
    });
    expect(plan.requestsAfter.filter((entry) => entry.status === "active"))
      .toEqual([expect.objectContaining({ id: "R-0001" })]);
  });

  it("amends a request contract without changing its identity, path, or creation time", () => {
    const state = activeState();
    const before = structuredClone(state.requests[0]!);

    const plan = planWorkstreamRequestChange(state, {
      kind: "amend",
      requestId: "R-0001",
      patch: {
        title: "Clarified initial request",
        acceptance: ["The clarified outcome is verified."],
        constraints: ["Keep the implementation dependency-free."],
      },
      reason: "The user clarified the desired outcome and constraint.",
      authority: "user",
      at: "2026-07-17T14:00:00+05:30",
    });

    expect(plan.changedRequests[0]).toMatchObject({
      id: before.id,
      relativePath: before.relativePath,
      createdAt: before.createdAt,
      startedAt: before.startedAt,
      updatedAt: "2026-07-17T14:00:00+05:30",
      title: "Clarified initial request",
      acceptance: ["The clarified outcome is verified."],
      constraints: ["Keep the implementation dependency-free."],
      lifecycleNote: "Contract amended: The user clarified the desired outcome and constraint.",
    });
    expect(plan.workstreamCardAfter).toMatchObject({
      currentRequest: "R-0001",
      currentFocus: "Complete R-0001: Clarified initial request.",
    });
    expect(plan.writes.map((write) => write.path)).toEqual([
      before.relativePath,
      "workstream.md",
    ]);

    expectCode(() => planWorkstreamRequestChange(state, {
      kind: "amend",
      requestId: "R-0001",
      patch: { acceptance: [] },
      reason: "A policy tried to silently weaken the contract.",
      authority: "trusted_policy",
      at: "2026-07-17T14:00:00+05:30",
    }), "WORKSTREAM_REQUEST_STATE_INVALID");
    expectCode(() => planWorkstreamRequestChange(state, {
      kind: "amend",
      requestId: "R-0001",
      patch: { title: before.title },
      reason: "No contract field actually changed.",
      authority: "user",
      at: "2026-07-17T14:00:00+05:30",
    }), "WORKSTREAM_REQUEST_STATE_INVALID");
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
        finalOutcome: "The implementation and focused tests are complete.",
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
      finalOutcome: "Dropped: The user no longer wants this feature.",
    });
    expectCode(() => planWorkstreamRequestChange(requestState([
      request("R-0001", "dropped", "Already dropped"),
    ]), {
      kind: "drop",
      requestId: "R-0001",
      reason: "Drop it again.",
    }), "WORKSTREAM_REQUEST_STATE_INVALID");
  });

  it("treats done and dropped requests as terminal", () => {
    const statuses: WorkstreamRequest["status"][] = [
      "queued",
      "active",
      "blocked",
      "done",
      "dropped",
    ];
    for (const from of ["done", "dropped"] as const) {
      for (const to of statuses.filter((status) => status !== from)) {
        expectCode(() => validateWorkstreamRequestTransition({ from, to }),
          "WORKSTREAM_REQUEST_STATE_INVALID");
      }
      expect(() => validateWorkstreamRequestTransition({ from, to: from })).not.toThrow();
    }
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
      kind: "continue_current",
      workstreamId: "W-20260717-0001",
      requestId: "R-0002",
      reason: "  The user is continuing the same unfinished outcome.  ",
    })).toEqual({
      kind: "continue_current",
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

  it("plans against a real committed V3 workstream without filesystem or Git side effects", async () => {
    const fixture = await createWorkstreamServiceFixture("request-plan");
    fixtures.push(fixture);
    const selected = await createBoundWorkstream(fixture, {
      title: "Website workstream",
      objective: "Maintain a website through durable requests.",
    });
    await fixture.service.finalizeRun({
      requestId: fixture.prepared.run.runId + ":finalize",
      runId: fixture.prepared.run.runId,
      outcome: "incomplete",
      stopReason: "run_limit",
      assistantResponse: "The website request remains active.",
      streamSummary: "Initialized the website workstream.",
      summary: "The website request remains active.",
      validation: "not_applicable",
      next: "Continue the website request.",
      workState: workState({ summary: "The website request remains active." }),
      workstream: {
        completion: { accepted: false, resources: [], missing: [], failures: [], criteria: [] },
        requestEffect: { kind: "none" },
      },
      at: "2026-07-19T10:02:00+05:30",
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
    schema: "ayati.workstream/v3",
    id: "W-20260717-0001",
    title: "Lifecycle workstream",
    status: "active",
    currentRequest,
    aliases: [],
    purpose: "Exercise the durable request lifecycle.",
    currentSnapshot: "The workstream repository is initialized.",
    importantFindings: [],
    decisions: ["Keep request state deterministic."],
    currentFocus: currentRequest
      ? "Complete " + currentRequest + ": Initial request."
      : "Choose or create the next request.",
    openQuestions: [],
    blockers: [],
    nextAction: currentRequest
      ? "Advance " + currentRequest + " toward completion."
      : "Choose or create the next request.",
  };
}

function request(id: string, status: WorkstreamRequest["status"], title: string): WorkstreamRequest {
  const createdAt = "2026-07-17T12:00:00+05:30";
  const terminal = status === "done" || status === "dropped";
  return {
    schema: "ayati.request/v3",
    id,
    workstreamId: "W-20260717-0001",
    relativePath: `requests/${id}-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md`,
    title,
    status,
    createdAt,
    updatedAt: createdAt,
    startedAt: status === "active" || status === "blocked" || terminal ? createdAt : null,
    closedAt: terminal ? createdAt : null,
    source: "user",
    request: "Complete " + title.toLowerCase() + ".",
    acceptance: ["The requested outcome is verified."],
    constraints: [],
    lifecycleNote: "Lifecycle fixture.",
    finalOutcome: status === "done"
      ? "The request is complete."
      : status === "dropped"
        ? "The request was dropped."
        : "Pending.",
  };
}

function newRequestInput(title: string, source: WorkstreamRequest["source"] = "user") {
  return {
    title,
    request: "Complete " + title.toLowerCase() + ".",
    acceptance: ["The requested outcome is verified."],
    constraints: [],
    source,
    createdAt: "2026-07-17T13:00:00+05:30",
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
