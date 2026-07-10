import { describe, expect, it } from "vitest";
import {
  parseSessionSnapshot,
  renderSessionSnapshotMarkdown,
  SESSION_SNAPSHOT_JSON_SCHEMA,
  validateSessionSnapshot,
} from "../../../src/context-engine/git-memory/index.js";
import type {
  SessionSnapshot,
  SessionSnapshotValidationContext,
} from "../../../src/context-engine/git-memory/index.js";

describe("session snapshot foundation", () => {
  it("publishes a strict schema with every top-level field required", () => {
    expect(SESSION_SNAPSHOT_JSON_SCHEMA).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: [
        "schemaVersion",
        "overview",
        "threads",
        "userRequests",
        "decisions",
        "constraints",
        "assistantCommitments",
        "unresolvedQuestions",
        "importantFacts",
        "references",
        "recentProgress",
        "continuation",
      ],
    });
    const properties = SESSION_SNAPSHOT_JSON_SCHEMA["properties"] as Record<string, unknown>;
    expect(properties["overview"]).toMatchObject({
      additionalProperties: false,
      required: ["summary", "currentFocus", "status"],
    });
  });

  it("parses a valid multi-thread snapshot and returns an owned clone", () => {
    const snapshot = validSnapshot();
    const original = structuredClone(snapshot);

    const result = parseSessionSnapshot(snapshot, validationContext());

    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect(result.snapshot).toEqual(snapshot);
    expect(result.snapshot).not.toBe(snapshot);
    expect(result.estimatedTokens).toBeGreaterThan(0);
    result.snapshot.overview.summary = "Changed clone";
    expect(snapshot).toEqual(original);
  });

  it("rejects unknown and missing fields even without provider schema enforcement", () => {
    const withUnknown = {
      ...validSnapshot(),
      invented: "not allowed",
    };
    const missing = structuredClone(validSnapshot()) as Record<string, unknown>;
    delete missing["continuation"];

    expect(validateSessionSnapshot(withUnknown, validationContext())).toContain(
      "snapshot contains unknown field invented",
    );
    expect(validateSessionSnapshot(missing, validationContext())).toContain(
      "snapshot is missing required field continuation",
    );
  });

  it("returns validation errors instead of throwing for non-JSON values", () => {
    const snapshot = {
      ...validSnapshot(),
      schemaVersion: 1n,
    };

    expect(parseSessionSnapshot(snapshot, validationContext())).toEqual({
      status: "failed",
      errors: ["snapshot.schemaVersion must be 1"],
    });
  });

  it("rejects unsupported statuses and malformed nullable fields", () => {
    const snapshot = validSnapshot() as unknown as Record<string, unknown>;
    const overview = snapshot["overview"] as Record<string, unknown>;
    overview["status"] = "paused";
    const threads = snapshot["threads"] as Array<Record<string, unknown>>;
    threads[0]!["latestOutcome"] = "";

    expect(validateSessionSnapshot(snapshot, validationContext())).toEqual(expect.arrayContaining([
      "snapshot.overview.status must be one of active, waiting_for_user, idle",
      "snapshot.threads[0].latestOutcome must be a non-empty string",
    ]));
  });

  it("validates conversation, run, task, and previous-summary sources", () => {
    const snapshot = validSnapshot();
    snapshot.decisions = [{
      text: "Unknown sources",
      sources: [
        { kind: "conversation", seq: 99 },
        { kind: "task_run", runId: "R-999" },
        { kind: "previous_summary" },
      ],
    }];
    snapshot.threads[0]!.taskIds = ["W-999"];
    snapshot.threads[0]!.runIds = ["R-999"];

    expect(validateSessionSnapshot(snapshot, {
      ...validationContext(),
      previousSummarySupplied: false,
    })).toEqual(expect.arrayContaining([
      "snapshot.decisions[0].sources references unknown conversation sequence 99",
      "snapshot.decisions[0].sources references unknown task run R-999",
      "snapshot.decisions[0].sources references a previous summary that was not supplied",
      "snapshot.threads[0].taskIds references unknown id W-999",
      "snapshot.threads[0].runIds references unknown id R-999",
    ]));
  });

  it("allows previous-summary sources only when a previous summary was supplied", () => {
    const snapshot = validSnapshot();

    expect(validateSessionSnapshot(snapshot, validationContext())).toEqual([]);
    expect(validateSessionSnapshot(snapshot, {
      ...validationContext(),
      previousSummarySupplied: false,
    })).toContain(
      "snapshot.decisions[0].sources references a previous summary that was not supplied",
    );
  });

  it("requires the exact pending question, source sequence, and waiting state", () => {
    const snapshot = validSnapshot();
    snapshot.overview.status = "waiting_for_user";
    snapshot.unresolvedQuestions = [{
      text: "Should I use SQLite or PostgreSQL?",
      sources: [{ kind: "conversation", seq: 4 }],
    }];
    snapshot.continuation.waitingFor = "The user's database choice";
    const context = {
      ...validationContext(),
      pendingUserInput: {
        question: "Should I use SQLite or PostgreSQL?",
        sourceSeq: 4,
      },
    };

    expect(validateSessionSnapshot(snapshot, context)).toEqual([]);
    snapshot.unresolvedQuestions[0]!.text = "Which database?";
    expect(validateSessionSnapshot(snapshot, context)).toContain(
      "snapshot must preserve the exact pending user-input question and source sequence",
    );
  });

  it("rejects pending input without waiting status or continuation", () => {
    const snapshot = validSnapshot();
    snapshot.unresolvedQuestions = [{
      text: "Should I continue?",
      sources: [{ kind: "conversation", seq: 4 }],
    }];
    const context = {
      ...validationContext(),
      pendingUserInput: { question: "Should I continue?", sourceSeq: 4 },
    };

    expect(validateSessionSnapshot(snapshot, context)).toEqual(expect.arrayContaining([
      "snapshot with pending user input must have waiting_for_user status",
      "snapshot with pending user input must describe continuation.waitingFor",
    ]));
  });

  it("rejects waiting state without any unresolved question", () => {
    const snapshot = validSnapshot();
    snapshot.overview.status = "waiting_for_user";
    snapshot.unresolvedQuestions = [];

    expect(validateSessionSnapshot(snapshot, validationContext())).toContain(
      "waiting_for_user snapshot must contain an unresolved question",
    );
  });

  it("rejects duplicate semantic items, thread subjects, ids, and sources", () => {
    const snapshot = validSnapshot();
    snapshot.userRequests.push(structuredClone(snapshot.userRequests[0]!));
    snapshot.threads.push({
      ...structuredClone(snapshot.threads[0]!),
      subject: snapshot.threads[0]!.subject.toUpperCase(),
    });
    snapshot.threads[0]!.taskIds = ["W-001", "W-001"];
    snapshot.constraints[0]!.sources.push({ kind: "conversation", seq: 2 });

    expect(validateSessionSnapshot(snapshot, validationContext())).toEqual(expect.arrayContaining([
      expect.stringContaining("snapshot.userRequests contains duplicate item"),
      expect.stringContaining("snapshot.threads contains duplicate item"),
      "snapshot.threads[0].taskIds contains duplicate id W-001",
      "snapshot.constraints[0].sources contains duplicate source conversation:2",
    ]));
  });

  it("enforces the configured token ceiling", () => {
    const snapshot = validSnapshot();
    snapshot.overview.summary = "x".repeat(2_000);

    expect(validateSessionSnapshot(snapshot, {
      ...validationContext(),
      maxTokens: 100,
    })).toContainEqual(expect.stringContaining("session snapshot uses"));
  });

  it("renders deterministic structured Markdown without multiline injection", () => {
    const snapshot = validSnapshot();
    snapshot.overview.summary = "Session summary\nwith another line";

    const first = renderSessionSnapshotMarkdown(snapshot);
    const second = renderSessionSnapshotMarkdown(snapshot);

    expect(first).toBe(second);
    expect(first).toContain("# Session Summary\n");
    expect(first).toContain("## Current Threads\n");
    expect(first).toContain("## Assistant Commitments\n");
    expect(first).toContain("## Continuation\n");
    expect(first).toContain("Summary: Session summary with another line");
    expect(first).toContain("[sources: conversation:1]");
    expect(first).toContain("[sources: previous-summary]");
    expect(first.endsWith("\n")).toBe(true);
  });
});

function validSnapshot(): SessionSnapshot {
  return {
    schemaVersion: 1,
    overview: {
      summary: "The session is improving Ayati context management.",
      currentFocus: [{
        text: "Build task-run-aware session context.",
        sources: [{ kind: "conversation", seq: 1 }],
      }],
      status: "active",
    },
    threads: [
      {
        subject: "Context management",
        goal: "Preserve useful session context within bounded prompts.",
        status: "active",
        latestOutcome: "The deterministic checkpoint generator is complete.",
        next: "Define the session snapshot contract.",
        taskIds: ["W-001"],
        runIds: ["R-001"],
        sources: [{ kind: "task_run", runId: "R-001" }],
      },
      {
        subject: "Earlier architecture",
        goal: "Keep task and session context separate.",
        status: "completed",
        latestOutcome: "The boundary was agreed.",
        next: null,
        taskIds: [],
        runIds: [],
        sources: [{ kind: "previous_summary" }],
      },
    ],
    userRequests: [
      {
        text: "Create a commit-aware timeline.",
        status: "open",
        sources: [{ kind: "conversation", seq: 1 }],
      },
      {
        text: "Define deterministic checkpoint planning.",
        status: "completed",
        sources: [{ kind: "task_run", runId: "R-001" }],
      },
    ],
    decisions: [{
      text: "Only finalized task runs create checkpoint boundaries.",
      sources: [{ kind: "previous_summary" }],
    }],
    constraints: [{
      text: "Session runs never create commits.",
      sources: [{ kind: "conversation", seq: 2 }],
    }],
    assistantCommitments: [{
      text: "Keep persistence unchanged while designing prompt projection.",
      sources: [{ kind: "conversation", seq: 3 }],
    }],
    unresolvedQuestions: [],
    importantFacts: [{
      text: "The default model context window is at least 128K tokens.",
      sources: [{ kind: "conversation", seq: 2 }],
    }],
    references: [{
      text: "ayati-main/src/context-engine/git-memory",
      sources: [{ kind: "task_run", runId: "R-001" }],
    }],
    recentProgress: [{
      summary: "Added deterministic task-run checkpoint generation.",
      taskId: "W-001",
      runId: "R-001",
      status: "completed",
      sources: [{ kind: "task_run", runId: "R-001" }],
    }],
    continuation: {
      waitingFor: null,
      recommendedNext: "Implement the structured session snapshot foundation.",
      blockers: [],
    },
  };
}

function validationContext(): SessionSnapshotValidationContext {
  return {
    conversationSeqs: [1, 2, 3, 4],
    taskIds: ["W-001", "W-002"],
    runIds: ["R-001", "R-002"],
    previousSummarySupplied: true,
  };
}
