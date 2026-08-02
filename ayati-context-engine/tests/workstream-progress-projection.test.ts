import { describe, expect, it } from "vitest";
import type {
  ResourceEvent,
  ResourceEventType,
  RunOutcome,
  WorkstreamCompletionRecord,
} from "../src/contracts.js";
import type { RunWorkState } from "../src/run-work-state-contracts.js";
import {
  buildWorkstreamProgressEntry,
  type BuildWorkstreamProgressEntryInput,
} from "../src/workstreams/workstream-progress-projection.js";
import {
  parseWorkstreamProgress,
  renderWorkstreamProgress,
  renderWorkstreamProgressEntry,
  WORKSTREAM_PROGRESS_LIMITS,
} from "../src/workstreams/workstream-progress.js";

describe("workstream progress projection", () => {
  it("maps only durable finalized-run facts into their owned sections", () => {
    const projected = buildWorkstreamProgressEntry(input({
      summary: "Fallback finalization summary.",
      next: "Run browser validation.",
      workState: workState({
        summary: "Created and verified the initial website.",
        plan: [
          { id: "create", task: "Create index.html.", status: "done" },
          { id: "validate", task: "Run browser validation.", status: "pending" },
          { id: "credentials", task: "Obtain browser credentials.", status: "blocked" },
        ],
        importantContext: [
          { kind: "decision", value: "Keep the website dependency-free." },
          { kind: "finding", value: "No build system is required." },
          { kind: "artifact", value: "/workspace/index.html" },
          { kind: "constraint", value: "Do not deploy without approval." },
        ],
        nextAction: "Fallback WorkState next action.",
      }),
      completion: completion({
        missing: ["Browser validation."],
        failures: ["Browser credentials are unavailable."],
        criteria: [{
          criterion: "The created page exists.",
          passed: true,
          proofs: [{
            outcomeRef: `run:${runId(1)}:step:3:call:read-page:outcome:0`,
            kind: "file.read_complete",
            subject: "/workspace/index.html",
            summary: "Verified a complete final read of /workspace/index.html.",
            source: {
              step: 3,
              callId: "read-page",
              tool: "read_files",
              ref: "verification:read-page",
            },
          }],
        }],
      }),
      resourceEvents: [
        event("modified", {
          eventId: "RE-MODIFIED",
          resourceId: resourceId(2),
          at: "2026-07-28T12:22:00+05:30",
          summary: "Updated /workspace/styles.css.",
        }),
        event("observed", {
          eventId: "RE-OBSERVED",
          at: "2026-07-28T12:19:00+05:30",
          summary: "Observed the existing workspace.",
        }),
        event("created", {
          eventId: "RE-CREATED",
          resourceId: resourceId(1),
          at: "2026-07-28T12:20:00+05:30",
          summary: "Created /workspace/index.html.",
        }),
      ],
    }));

    expect(projected).toEqual({
      runId: runId(1),
      requestId: "R-0001",
      at: "2026-07-28T12:30:00+05:30",
      outcome: "incomplete",
      summary: "Created and verified the initial website.",
      workCompleted: ["Create index.html."],
      verifiedMutations: [
        "Created `" + resourceId(1) + "`: Created /workspace/index.html.",
        "Modified `" + resourceId(2) + "`: Updated /workspace/styles.css.",
      ],
      validation: [
        "Overall validation was not applicable.",
        "Completion evidence was not accepted.",
        "Criterion passed: The created page exists. Proof refs: "
          + `run:${runId(1)}:step:3:call:read-page:outcome:0`,
      ],
      findingsAndDecisions: [
        "Decision: Keep the website dependency-free.",
        "Finding: No build system is required.",
      ],
      problems: [
        "Missing: Browser validation.",
        "Failure: Browser credentials are unavailable.",
        "Blocked: Obtain browser credentials.",
      ],
      next: "Run browser validation.",
    });
  });

  it("uses the finalization mutation classification and excludes read-only events", () => {
    const types: ResourceEventType[] = [
      "registered",
      "linked",
      "observed",
      "created",
      "modified",
      "moved",
      "deleted",
      "missing",
      "restored",
      "downloaded",
      "uploaded",
      "delivered",
      "external_state_changed",
    ];
    const projected = buildWorkstreamProgressEntry(input({
      resourceEvents: types.map((type, index) => event(type, {
        eventId: "RE-" + String(index).padStart(2, "0"),
        resourceId: resourceId(index + 1),
        summary: "Recorded " + type + ".",
      })),
    }));

    expect(projected.verifiedMutations).toEqual([
      "Created `" + resourceId(4) + "`: Recorded created.",
      "Modified `" + resourceId(5) + "`: Recorded modified.",
      "Moved `" + resourceId(6) + "`: Recorded moved.",
      "Deleted `" + resourceId(7) + "`: Recorded deleted.",
      "Restored `" + resourceId(9) + "`: Recorded restored.",
      "Downloaded `" + resourceId(10) + "`: Recorded downloaded.",
      "Changed external state for `" + resourceId(13)
        + "`: Recorded external_state_changed.",
    ]);
    expect(projected.workCompleted).toEqual([
      "Recorded created.",
      "Recorded modified.",
      "Recorded moved.",
      "Recorded deleted.",
      "Recorded restored.",
      "Recorded downloaded.",
      "Recorded external_state_changed.",
    ]);
  });

  it("orders mutation events by timestamp and event identity", () => {
    const events = [
      event("modified", {
        eventId: "RE-B",
        at: "2026-07-28T12:20:00+05:30",
        summary: "Second at the same timestamp.",
      }),
      event("created", {
        eventId: "RE-C",
        at: "2026-07-28T12:19:00+05:30",
        summary: "First by timestamp.",
      }),
      event("deleted", {
        eventId: "RE-A",
        at: "2026-07-28T12:20:00+05:30",
        summary: "First at the same timestamp.",
      }),
    ];

    const forward = buildWorkstreamProgressEntry(input({ resourceEvents: events }));
    const reversed = buildWorkstreamProgressEntry(input({
      resourceEvents: [...events].reverse(),
    }));

    expect(reversed.verifiedMutations).toEqual(forward.verifiedMutations);
    expect(forward.verifiedMutations.map((item) => item.split(": ")[1])).toEqual([
      "First by timestamp.",
      "First at the same timestamp.",
      "Second at the same timestamp.",
    ]);
  });

  it("rejects WorkState and resource evidence from another run or request", () => {
    expectProgressError(() => buildWorkstreamProgressEntry(input({
      workState: workState({ runId: runId(2) }),
    })), "WorkState does not belong");
    expectProgressError(() => buildWorkstreamProgressEntry(input({
      resourceEvents: [event("created", { runId: runId(2) })],
    })), "resource event does not belong to the finalized run");
    expectProgressError(() => buildWorkstreamProgressEntry(input({
      resourceEvents: [event("created", { requestId: "R-0002" })],
    })), "resource event does not belong to the bound request");
    expectProgressError(() => buildWorkstreamProgressEntry(input({
      completion: completion({
        criteria: [{
          criterion: "The page exists.",
          passed: true,
          proofs: [{
            outcomeRef: `run:${runId(2)}:step:1:call:read-page:outcome:0`,
            kind: "file.read_complete",
            subject: "/workspace/index.html",
            summary: "Verified the page.",
            source: { step: 1, callId: "read-page", tool: "read_files" },
          }],
        }],
      }),
    })), "completion proof does not belong");
  });

  it("keeps legacy prose evidence readable without treating it as structured proof", () => {
    const projected = buildWorkstreamProgressEntry(input({
      completion: completion({
        criteria: [{
          criterion: "Historical criterion.",
          passed: true,
          evidence: "Historical assistant evidence.",
        }],
      }),
    }));

    expect(projected.validation).toContain(
      "Criterion passed: Historical criterion. Evidence: Historical assistant evidence.",
    );
  });

  it("produces valid no-change entries for every finalized run outcome", () => {
    const outcomes: RunOutcome[] = [
      "done",
      "incomplete",
      "failed",
      "blocked",
      "needs_user_input",
    ];
    const entries = outcomes.map((outcome, index) => buildWorkstreamProgressEntry(input({
      runId: runId(index + 1),
      outcome,
      validation: outcome === "done"
        ? "passed"
        : outcome === "failed"
          ? "failed"
          : "not_applicable",
      workState: workState({
        runId: runId(index + 1),
        summary: "Finalized a " + outcome + " no-change run.",
        plan: [],
        importantContext: [],
        nextAction: null,
      }),
      completion: completion({
        accepted: outcome === "done",
        criteria: [],
      }),
      resourceEvents: [],
    })));

    const parsed = parseWorkstreamProgress(renderWorkstreamProgress(entries));

    expect(parsed.map((entry) => entry.outcome)).toEqual(outcomes);
    expect(parsed.every((entry) =>
      entry.workCompleted.length === 0
      && entry.verifiedMutations.length === 0
      && entry.findingsAndDecisions.length === 0
      && entry.problems.length === 0)).toBe(true);
  });

  it("falls back to finalization summary and WorkState next action", () => {
    const projected = buildWorkstreamProgressEntry(input({
      summary: "The bounded finalization summary.",
      workState: workState({
        summary: " ",
        nextAction: "Continue the active request.",
      }),
    }));

    expect(projected.summary).toBe("The bounded finalization summary.");
    expect(projected.next).toBe("Continue the active request.");
  });

  it("compacts long projected facts to the progress contract limits", () => {
    const projected = buildWorkstreamProgressEntry(input({
      workState: workState({
        summary: "s".repeat(WORKSTREAM_PROGRESS_LIMITS.summaryChars + 100),
        plan: [{
          id: "long",
          task: "t".repeat(WORKSTREAM_PROGRESS_LIMITS.itemChars + 100),
          status: "done",
        }],
      }),
      completion: completion({
        failures: ["f".repeat(WORKSTREAM_PROGRESS_LIMITS.itemChars + 100)],
      }),
      resourceEvents: [event("created", {
        summary: "m".repeat(WORKSTREAM_PROGRESS_LIMITS.itemChars + 100),
      })],
    }));

    expect(projected.summary).toHaveLength(WORKSTREAM_PROGRESS_LIMITS.summaryChars);
    expect(projected.workCompleted[0]).toHaveLength(WORKSTREAM_PROGRESS_LIMITS.itemChars);
    expect(projected.problems[0]).toHaveLength(WORKSTREAM_PROGRESS_LIMITS.itemChars);
    expect(projected.verifiedMutations[0]).toHaveLength(
      WORKSTREAM_PROGRESS_LIMITS.itemChars,
    );
    expect(() => renderWorkstreamProgressEntry(projected)).not.toThrow();
  });
});

function input(
  overrides: Partial<BuildWorkstreamProgressEntryInput> = {},
): BuildWorkstreamProgressEntryInput {
  return {
    runId: runId(1),
    requestId: "R-0001",
    at: "2026-07-28T12:30:00+05:30",
    outcome: "incomplete",
    summary: "Finalized the current run.",
    validation: "not_applicable",
    workState: workState(),
    completion: completion(),
    resourceEvents: [],
    ...overrides,
  };
}

function workState(overrides: Partial<RunWorkState> = {}): RunWorkState {
  return {
    runId: runId(1),
    revision: 2,
    afterStep: 3,
    updateReason: "run_paused",
    updatedAt: "2026-07-28T12:30:00+05:30",
    status: "in_progress",
    summary: "Finalized the current WorkState.",
    plan: [],
    importantContext: [],
    nextAction: null,
    ...overrides,
  };
}

function completion(
  overrides: Partial<WorkstreamCompletionRecord> = {},
): WorkstreamCompletionRecord {
  return {
    accepted: false,
    resources: [],
    missing: [],
    failures: [],
    criteria: [],
    ...overrides,
  };
}

function event(
  type: ResourceEventType,
  overrides: Partial<ResourceEvent> = {},
): ResourceEvent {
  return {
    eventId: "RE-000000000000000000000001",
    resourceId: resourceId(1),
    runId: runId(1),
    requestId: "R-0001",
    type,
    verification: { verified: true },
    summary: "Recorded a verified resource event.",
    at: "2026-07-28T12:20:00+05:30",
    ...overrides,
  };
}

function runId(sequence: number): string {
  return "RUN-9054007D-" + String(sequence).padStart(10, "0");
}

function resourceId(sequence: number): string {
  return "RES-" + String(sequence).padStart(24, "0");
}

function expectProgressError(operation: () => unknown, message: string): void {
  try {
    operation();
    throw new Error("Expected progress projection to fail.");
  } catch (error) {
    expect(error).toMatchObject({
      code: "WORKSTREAM_PROGRESS_INVALID",
      message: expect.stringContaining(message),
    });
  }
}
