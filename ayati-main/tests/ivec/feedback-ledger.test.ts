import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AsyncAgentFeedbackLedger,
  buildContextEngineFeedbackSummary,
  buildFeedbackTriageSummary,
} from "../../src/ivec/feedback-ledger.js";

let tempDir = "";

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "ayati-feedback-ledger-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

describe("AsyncAgentFeedbackLedger", () => {
  it("does not write files when disabled", async () => {
    const ledger = new AsyncAgentFeedbackLedger({
      dataDir: tempDir,
      enabled: false,
      now: () => new Date("2026-06-23T10:00:00.000Z"),
    });

    ledger.record({
      clientId: "local",
      sessionId: "session-1",
      seq: 1,
      stage: "message",
      event: "received",
      data: { content: "hi" },
    });
    await ledger.flush();

    expect(existsSync(join(tempDir, "feedback"))).toBe(false);
  });

  it("writes events asynchronously and updates latest pointer", async () => {
    const times = [
      new Date("2026-06-23T10:00:00.000Z"),
      new Date("2026-06-23T10:00:01.000Z"),
    ];
    let index = 0;
    const ledger = new AsyncAgentFeedbackLedger({
      dataDir: tempDir,
      enabled: true,
      now: () => times[index++] ?? times[times.length - 1]!,
    });

    ledger.record({
      clientId: "local",
      sessionId: "session-1",
      seq: 1,
      stage: "message",
      event: "received",
      data: { content: "first" },
    });
    ledger.record({
      clientId: "local",
      sessionId: "session-1",
      seq: 2,
      runId: "run-2",
      stage: "final",
      event: "reply",
      data: { content: "second" },
    });

    const feedbackPath = join(tempDir, "feedback", "2026-06-23", "session-session-1.jsonl");
    expect(existsSync(feedbackPath)).toBe(false);

    await ledger.flush();

    const lines = (await readFile(feedbackPath, "utf-8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)["seq"]).toBe(1);
    expect(JSON.parse(lines[1]!)["seq"]).toBe(2);

    const latest = JSON.parse(await readFile(join(tempDir, "feedback", "latest-session.json"), "utf-8")) as {
      updatedAt?: string;
      seq?: number;
      runId?: string;
      path?: string;
    };
    expect(latest.updatedAt).toBe("2026-06-23T10:00:01.000Z");
    expect(latest.seq).toBe(2);
    expect(latest.runId).toBe("run-2");
    expect(latest.path).toBe("feedback/2026-06-23/session-session-1.jsonl");
    const latestRun = JSON.parse(await readFile(
      join(tempDir, "feedback", "latest-run.json"),
      "utf-8",
    )) as { runId?: string };
    expect(latestRun.runId).toBe("run-2");
  });

  it("does not let process-only events replace the latest session pointer", async () => {
    const times = [
      new Date("2026-06-23T10:00:00.000Z"),
      new Date("2026-06-23T10:00:01.000Z"),
    ];
    let index = 0;
    const ledger = new AsyncAgentFeedbackLedger({
      dataDir: tempDir,
      enabled: true,
      now: () => times[index++] ?? times.at(-1)!,
    });
    ledger.record({
      sessionId: "session-1",
      seq: 1,
      stage: "final",
      event: "reply",
    });
    await ledger.flush();
    ledger.record({
      stage: "git_context_service",
      event: "child_shutdown_completed",
    });
    await ledger.flush();

    const latest = JSON.parse(await readFile(
      join(tempDir, "feedback", "latest-session.json"),
      "utf-8",
    )) as { sessionId?: string; path?: string };
    const process = JSON.parse(await readFile(
      join(tempDir, "feedback", "latest-process.json"),
      "utf-8",
    )) as { sessionId?: string; path?: string };
    expect(latest).toMatchObject({
      sessionId: "session-1",
      path: "feedback/2026-06-23/session-session-1.jsonl",
    });
    expect(process.sessionId).toBeUndefined();
    expect(process.path).toBe("feedback/2026-06-23/session-unknown-session.jsonl");
  });

  it("writes a compact latest summary when final feedback summary data is present", async () => {
    const ledger = new AsyncAgentFeedbackLedger({
      dataDir: tempDir,
      enabled: true,
      now: () => new Date("2026-06-23T10:00:00.000Z"),
    });

    ledger.record({
      clientId: "local",
      sessionId: "session-1",
      seq: 2,
      runId: "run-2",
      stage: "final",
      event: "reply",
      data: {
        feedbackSummary: {
          status: "completed",
          responseKind: "reply",
          iterations: 3,
          toolCalls: 2,
          toolLoadDecisions: 1,
          actionSteps: 1,
          verificationPassed: true,
          basedOnVerifiedFacts: true,
          warnings: [],
        },
      },
    });
    ledger.record({
      sessionId: "session-1",
      seq: 2,
      runId: "run-2",
      stage: "git_context_service",
      event: "run_finalization_completed",
      data: {
        outcome: "done",
        stopReason: "completed",
        materialization: { status: "not_requested" },
        workstreamContextCommit: { status: "not_required" },
      },
    });
    await ledger.flush();

    const summary = JSON.parse(await readFile(join(tempDir, "feedback", "latest-summary.json"), "utf-8")) as {
      status?: string;
      responseKind?: string;
      iterations?: number;
      toolCalls?: number;
      toolLoadDecisions?: number;
      actionSteps?: number;
      verificationPassed?: boolean;
      basedOnVerifiedFacts?: boolean;
      execution?: {
        verification?: string;
        finalization?: string;
        commit?: string;
      };
      warnings?: string[];
      rawPath?: string;
    };

    expect(summary.status).toBe("completed");
    expect(summary.responseKind).toBe("reply");
    expect(summary.iterations).toBe(3);
    expect(summary.toolCalls).toBe(2);
    expect(summary.toolLoadDecisions).toBe(1);
    expect(summary.actionSteps).toBe(1);
    expect(summary.verificationPassed).toBeUndefined();
    expect(summary.basedOnVerifiedFacts).toBe(true);
    expect(summary.execution).toEqual({
      verification: "passed",
      finalization: "completed",
      commit: "not_required",
    });
    expect(summary.warnings).toEqual([]);
    expect(summary.rawPath).toBe("feedback/2026-06-23/session-session-1.jsonl");

    const triage = JSON.parse(await readFile(join(tempDir, "feedback", "triage-summary.json"), "utf-8")) as {
      outcome?: string;
      findings?: Array<{ code?: string; severity?: string }>;
      rawSummaryPath?: string;
    };
    expect(triage.outcome).toBe("healthy");
    expect(triage.findings?.[0]).toMatchObject({ code: "healthy_conversation", severity: "info" });
    expect(triage.rawSummaryPath).toBe("feedback/latest-summary.json");
  });

  it("includes compact context-engine state in the latest summary", async () => {
    const ledger = new AsyncAgentFeedbackLedger({
      dataDir: tempDir,
      enabled: true,
      now: () => new Date("2026-06-23T10:00:00.000Z"),
    });

    ledger.record({
      clientId: "local",
      sessionId: "session-1",
      seq: 3,
      runId: "run-3",
      stage: "final",
      event: "reply",
      data: {
        feedbackSummary: {
          status: "completed",
          responseKind: "reply",
          iterations: 2,
          toolCalls: 1,
          warnings: [],
          contextEngine: buildContextEngineFeedbackSummary({
            context: {
              session: {
                meta: {
                  sessionId: "session-1",
                  resourceCount: 0,
                },
                conversationTail: [],
                activityTail: [],
              },
              pendingTurn: {
                fromSeq: 3,
                toSeq: 3,
                text: "continue upload UI",
                at: "2026-06-23T10:00:00.000Z",
                routingStatus: "bound",
                workstreamId: "W-1",
                branch: "main",
                runId: "run-3",
              },
              focus: {
                status: "active",
                ref: "refs/heads/main",
                workstreamId: "W-1",
              },
              workstream: {
                contextRepositoryPath: "/ayati/workstreams/W-1",
                ref: "refs/heads/main",
                workstreamId: "W-1",
                title: "Upload UI",
                objective: "Improve upload UI",
                summary: "Upload UI remains in progress.",
                workstreamStatus: "in_progress",
                lifecycleStatus: "active",
                repositoryHealth: "ready",
                blockers: [],
                resources: [{
                  resource: {
                    resourceId: "resource-1",
                    kind: "file",
                    origin: "user_reference",
                    displayName: "mock.png",
                    description: "Upload UI mockup",
                    aliases: ["mockup"],
                    locator: { kind: "filesystem", path: "/ayati/workspace/mock.png" },
                    version: {
                      key: "sha256:mock",
                      observedAt: "2026-06-23T09:00:00.000Z",
                      exists: true,
                      kind: "file",
                      sha256: "mock",
                    },
                    availability: "available",
                    metadataStatus: "enriched",
                    createdAt: "2026-06-23T09:00:00.000Z",
                    updatedAt: "2026-06-23T09:00:00.000Z",
                  },
                  role: "input",
                  access: "read",
                  primary: false,
                  requestIds: ["R-0001"],
                  boundAt: "2026-06-23T09:00:00.000Z",
                }],
                recentCommits: [],
              },
            },
            routeStatus: "ready",
            routeMode: "activated",
            routeSource: "auto",
            finalizationStatus: "not_started",
            committed: false,
          }),
        },
      },
    });
    await ledger.flush();

    const summary = JSON.parse(await readFile(join(tempDir, "feedback", "latest-summary.json"), "utf-8")) as {
      contextEngine?: {
        pendingTurnStatus?: string;
        routeMode?: string;
        routeSource?: string;
        workstreamId?: string;
        branch?: string;
        runId?: string;
        committed?: boolean;
        resourceCount?: number;
      };
    };

    expect(summary.contextEngine).toMatchObject({
      pendingTurnStatus: "bound",
      routeMode: "activated",
      routeSource: "auto",
      workstreamId: "W-1",
      branch: "main",
      runId: "run-3",
      committed: false,
      resourceCount: 1,
    });
  });

  it("updates the latest summary when context-engine commit feedback arrives after final reply", async () => {
    const times = [
      new Date("2026-06-23T10:00:00.000Z"),
      new Date("2026-06-23T10:00:01.000Z"),
    ];
    let index = 0;
    const ledger = new AsyncAgentFeedbackLedger({
      dataDir: tempDir,
      enabled: true,
      now: () => times[index++] ?? times[times.length - 1]!,
    });

    ledger.record({
      clientId: "local",
      sessionId: "session-1",
      seq: 4,
      runId: "run-4",
      stage: "final",
      event: "reply",
      data: {
        feedbackSummary: {
          status: "completed",
          responseKind: "reply",
          iterations: 1,
          toolCalls: 1,
          actionSteps: 1,
          verificationPassed: true,
          warnings: [],
          contextEngine: {
            workstreamId: "W-4",
            runId: "run-4",
            finalizationStatus: "not_started",
            committed: false,
          },
        },
      },
    });
    await ledger.flush();

    ledger.record({
      clientId: "local",
      sessionId: "session-1",
      seq: 4,
      runId: "run-4",
      stage: "git_context_service",
      event: "run_finalization_completed",
      data: {
        outcome: "done",
        stopReason: "completed",
        workstreamBinding: {
          workstreamId: "W-4",
          requestId: "R-0001",
          boundAt: "2026-06-23T09:59:00.000Z",
        },
        materialization: { status: "not_requested" },
        workstreamContextCommit: {
          status: "committed",
          workstreamId: "W-4",
          requestId: "R-0001",
          headBefore: "0000000",
          headAfter: "abc1234",
          commit: "abc1234",
        },
      },
    });
    await ledger.flush();

    const summary = JSON.parse(await readFile(join(tempDir, "feedback", "latest-summary.json"), "utf-8")) as {
      contextEngine?: {
        finalizationStatus?: string;
        committed?: boolean;
        commit?: string;
        ref?: string;
      };
      execution?: {
        verification?: string;
        finalization?: string;
        commit?: string;
      };
    };
    expect(summary.contextEngine).toMatchObject({
      finalizationStatus: "committed",
      committed: true,
      commit: "abc1234",
      headAfter: "abc1234",
    });
    expect(summary.execution).toEqual({
      verification: "passed",
      finalization: "completed",
      commit: "committed",
    });

    const triage = JSON.parse(await readFile(join(tempDir, "feedback", "triage-summary.json"), "utf-8")) as {
      outcome?: string;
      findings?: Array<{ code?: string }>;
    };
    expect(triage.outcome).toBe("healthy");
    expect(triage.findings?.map((finding) => finding.code)).toEqual(["healthy_run"]);
  });

  it("updates the latest summary when conversation persistence arrives after final reply", async () => {
    const times = [
      new Date("2026-07-18T10:00:00.000Z"),
      new Date("2026-07-18T10:00:01.000Z"),
    ];
    let index = 0;
    const ledger = new AsyncAgentFeedbackLedger({
      dataDir: tempDir,
      enabled: true,
      now: () => times[index++] ?? times.at(-1)!,
    });
    ledger.record({
      sessionId: "S-1",
      seq: 4,
      stage: "final",
      event: "reply",
      data: {
        feedbackSummary: {
          status: "completed",
          responseKind: "reply",
          iterations: 1,
          toolCalls: 0,
          actionSteps: 0,
          verificationPassed: false,
          contextEngine: {
            finalizationStatus: "not_started",
            committed: false,
          },
          warnings: [],
        },
      },
    });
    ledger.record({
      sessionId: "S-1",
      seq: 4,
      runId: "run-4",
      stage: "git_context_service",
      event: "run_finalization_completed",
      data: {
        outcome: "done",
        stopReason: "completed",
        materialization: { status: "not_requested" },
        workstreamContextCommit: { status: "not_required" },
      },
    });
    await ledger.flush();

    ledger.record({
      sessionId: "S-1",
      seq: 4,
      stage: "git_context_service",
      event: "conversation_persisted",
      data: {
        conversationPersistence: {
          database: "saved",
          materialization: "not_requested",
          git: "not_committed",
          plannedPath: "conversations/000004.pending.md",
        },
      },
    });
    await ledger.flush();

    const summary = JSON.parse(await readFile(
      join(tempDir, "feedback", "latest-summary.json"),
      "utf-8",
    ));
    expect(summary.conversationPersistence).toEqual({
      database: "saved",
      materialization: "not_requested",
      git: "not_committed",
      plannedPath: "conversations/000004.pending.md",
    });
    expect(summary.execution).toEqual({
      verification: "not_applicable",
      finalization: "completed",
      commit: "not_required",
    });
    const triage = JSON.parse(await readFile(
      join(tempDir, "feedback", "triage-summary.json"),
      "utf-8",
    ));
    expect(triage).toMatchObject({
      outcome: "healthy",
      findings: [{ code: "healthy_conversation", severity: "info" }],
    });
  });

  it("merges decision repair signals into the latest summary warnings", async () => {
    const times = [
      new Date("2026-06-23T10:00:00.000Z"),
      new Date("2026-06-23T10:00:01.000Z"),
    ];
    let index = 0;
    const ledger = new AsyncAgentFeedbackLedger({
      dataDir: tempDir,
      enabled: true,
      now: () => times[index++] ?? times[times.length - 1]!,
    });

    ledger.record({
      clientId: "local",
      sessionId: "session-1",
      seq: 2,
      stage: "decision",
      event: "parse_failed",
      data: { attempt: 1, error: "Expected JSON object" },
    });
    ledger.record({
      clientId: "local",
      sessionId: "session-1",
      seq: 2,
      runId: "run-2",
      stage: "final",
      event: "reply",
      data: {
        feedbackSummary: {
          status: "completed",
          responseKind: "reply",
          iterations: 1,
          toolCalls: 0,
          warnings: ["completed_without_tool_calls"],
        },
      },
    });
    await ledger.flush();

    const summary = JSON.parse(await readFile(join(tempDir, "feedback", "latest-summary.json"), "utf-8")) as {
      warnings?: string[];
    };

    expect(summary.warnings).toEqual(["completed_without_tool_calls", "parse_repair_needed"]);

    const triage = JSON.parse(await readFile(join(tempDir, "feedback", "triage-summary.json"), "utf-8")) as {
      outcome?: string;
      findings?: Array<{ code?: string; severity?: string }>;
    };
    expect(triage.outcome).toBe("needs_review");
    expect(triage.findings?.map((finding) => finding.code)).toEqual([
      "decision_repair_needed",
      "completed_without_tool_calls",
    ]);
  });

  it("projects cache and persistence telemetry and triages persistence failures", async () => {
    const ledger = new AsyncAgentFeedbackLedger({
      dataDir: tempDir,
      enabled: true,
      now: () => new Date("2026-06-23T10:00:00.000Z"),
    });
    ledger.record({
      sessionId: "session-1",
      seq: 5,
      runId: "run-5",
      stage: "final",
      event: "reply",
      data: { feedbackSummary: { status: "completed", responseKind: "reply", warnings: [] } },
    });
    ledger.record({
      sessionId: "session-1",
      seq: 5,
      runId: "run-5",
      stage: "context_engine",
      event: "harness_context_refresh_completed",
      data: {
        contextRevision: "revision-5",
        previousRevision: "revision-4",
        readContextRevision: "read-revision-5",
        readContextAfterCommitRunId: "run-4",
        readContextCounts: {
          inventory: 1,
          discovery: 2,
          evidence: 3,
          actions: 1,
          total: 7,
        },
        hits: 3,
        misses: 1,
        refreshes: 2,
      },
    });
    ledger.record({
      sessionId: "session-1",
      seq: 5,
      runId: "run-5",
      stage: "context_engine",
      event: "run_step_persistence_failed",
      data: { step: 2, message: "database unavailable" },
    });
    await ledger.flush();

    const summary = JSON.parse(await readFile(join(tempDir, "feedback", "latest-summary.json"), "utf-8"));
    expect(summary.contextEngine).toMatchObject({
      cacheStatus: "fresh",
      contextRevision: "revision-5",
      previousContextRevision: "revision-4",
      cacheHits: 3,
      cacheMisses: 1,
      cacheRefreshes: 2,
      readContextRevision: "read-revision-5",
      readContextAfterCommitRunId: "run-4",
      readContextCounts: {
        inventory: 1,
        discovery: 2,
        evidence: 3,
        actions: 1,
        total: 7,
      },
    });
    expect(summary.warnings).toContain("run_step_persistence_failed");

    const triage = JSON.parse(await readFile(join(tempDir, "feedback", "triage-summary.json"), "utf-8"));
    expect(triage.outcome).toBe("failed");
    expect(triage.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "run_step_persistence_failed", severity: "error" }),
    ]));
  });

  it("turns final runtime errors and guard warning codes into actionable triage", async () => {
    const times = [
      new Date("2026-06-23T10:00:00.000Z"),
      new Date("2026-06-23T10:00:01.000Z"),
    ];
    let index = 0;
    const ledger = new AsyncAgentFeedbackLedger({
      dataDir: tempDir,
      enabled: true,
      now: () => times[index++] ?? times[times.length - 1]!,
    });

    ledger.record({
      clientId: "local",
      sessionId: "session-1",
      seq: 5,
      stage: "tools",
      event: "working_set_prepared",
      data: {
        warningCodes: [
          "workstream_tools_selected_without_binding",
          "normal_tool_before_routing",
          "workstream_binding_required_for_action",
        ],
      },
    });
    ledger.record({
      clientId: "local",
      sessionId: "session-1",
      seq: 5,
      stage: "final",
      event: "error",
      data: {
        message: "A workstream binding is required before this action.",
      },
    });
    await ledger.flush();

    const summary = JSON.parse(await readFile(join(tempDir, "feedback", "latest-summary.json"), "utf-8")) as {
      status?: string;
      responseKind?: string;
      warnings?: string[];
    };
    expect(summary.status).toBe("failed");
    expect(summary.responseKind).toBe("error");
    expect(summary.warnings).toEqual([
      "runtime_error",
      "workstream_tools_selected_without_binding",
      "normal_tool_before_routing",
      "workstream_binding_required_for_action",
    ]);

    const triage = JSON.parse(await readFile(join(tempDir, "feedback", "triage-summary.json"), "utf-8")) as {
      outcome?: string;
      findings?: Array<{ code?: string; severity?: string }>;
    };
    expect(triage.outcome).toBe("failed");
    expect(triage.findings?.map((finding) => finding.code)).toEqual([
      "run_not_completed",
      "runtime_error",
      "workstream_tools_selected_without_binding",
      "workstream_binding_required_for_action",
      "normal_tool_before_routing",
    ]);
  });

  it("indexes repair codes from feedback events into summary warnings and triage", async () => {
    const ledger = new AsyncAgentFeedbackLedger({
      dataDir: tempDir,
      enabled: true,
      now: () => new Date("2026-06-23T10:00:00.000Z"),
    });

    ledger.record({
      clientId: "local",
      sessionId: "session-1",
      seq: 6,
      stage: "guard",
      event: "unbound_run_tool_repair_requested",
      data: {
        repair: {
          code: "R_UNBOUND_RUN_NEEDS_WORKSTREAM_BINDING",
          blockedTargets: ["write_files"],
        },
      },
    });
    ledger.record({
      clientId: "local",
      sessionId: "session-1",
      seq: 6,
      stage: "decision",
      event: "assistant_text_tool_call",
      data: {
        repair: {
          code: "R_ASSISTANT_TEXT_TOOL_CALL",
          blockedTargets: ["git_context_create_workstream"],
        },
      },
    });
    ledger.record({
      clientId: "local",
      sessionId: "session-1",
      seq: 6,
      stage: "final",
      event: "reply",
      data: {
        feedbackSummary: {
          status: "completed",
          responseKind: "reply",
          iterations: 2,
          toolCalls: 0,
          warnings: [],
        },
      },
    });
    await ledger.flush();

    const summary = JSON.parse(await readFile(join(tempDir, "feedback", "latest-summary.json"), "utf-8")) as {
      warnings?: string[];
    };
    expect(summary.warnings).toEqual([
      "unbound_run_tool_repair_requested",
      "R_UNBOUND_RUN_NEEDS_WORKSTREAM_BINDING",
      "R_ASSISTANT_TEXT_TOOL_CALL",
    ]);

    const triage = JSON.parse(await readFile(join(tempDir, "feedback", "triage-summary.json"), "utf-8")) as {
      findings?: Array<{ code?: string; severity?: string }>;
    };
    expect(triage.findings?.map((finding) => finding.code)).toEqual([
      "R_ASSISTANT_TEXT_TOOL_CALL",
      "R_UNBOUND_RUN_NEEDS_WORKSTREAM_BINDING",
      "unbound_run_tool_repair_requested",
    ]);
  });

  it("builds provider-empty-response triage from repair code without the legacy event name", () => {
    const triage = buildFeedbackTriageSummary({
      updatedAt: "2026-06-23T10:00:00.000Z",
      tsMs: 1,
      sessionId: "session-1",
      seq: 7,
      status: "failed",
      responseKind: "error",
      warnings: ["R_PROVIDER_EMPTY_RESPONSE"],
      rawPath: "feedback/test.jsonl",
    });

    expect(triage.outcome).toBe("failed");
    expect(triage.findings.map((finding) => finding.code)).toEqual([
      "run_not_completed",
      "R_PROVIDER_EMPTY_RESPONSE",
    ]);
  });

  it("builds repeated-repair triage from repair code", () => {
    const triage = buildFeedbackTriageSummary({
      updatedAt: "2026-06-23T10:00:00.000Z",
      tsMs: 1,
      sessionId: "session-1",
      seq: 8,
      status: "failed",
      responseKind: "error",
      warnings: ["R_REPEATED_REPAIR_FAILURE"],
      rawPath: "feedback/test.jsonl",
    });

    expect(triage.outcome).toBe("failed");
    expect(triage.findings.map((finding) => finding.code)).toEqual([
      "run_not_completed",
      "R_REPEATED_REPAIR_FAILURE",
    ]);
  });

  it("builds verification and no-progress triage from repair codes", () => {
    const triage = buildFeedbackTriageSummary({
      updatedAt: "2026-06-23T10:00:00.000Z",
      tsMs: 1,
      sessionId: "session-1",
      seq: 9,
      status: "failed",
      responseKind: "error",
      warnings: ["R_VERIFICATION_FAILED", "R_NO_PROGRESS"],
      rawPath: "feedback/test.jsonl",
    });

    expect(triage.outcome).toBe("failed");
    expect(triage.findings.map((finding) => finding.code)).toEqual([
      "run_not_completed",
      "R_VERIFICATION_FAILED",
      "R_NO_PROGRESS",
    ]);
  });

  it("builds operator triage findings from final feedback warning signals", () => {
    const triage = buildFeedbackTriageSummary({
      updatedAt: "2026-06-23T10:00:00.000Z",
      tsMs: 1,
      sessionId: "session-1",
      seq: 2,
      runId: "run-2",
      status: "failed",
      responseKind: "reply",
      iterations: 12,
      toolCalls: 1,
      toolLoadDecisions: 3,
      actionSteps: 1,
      verificationPassed: false,
      basedOnVerifiedFacts: false,
      warnings: ["runtime_error", "repeated_tool_load", "verification_failed"],
      rawPath: "feedback/2026-06-23/session-session-1.jsonl",
    });

    expect(triage.outcome).toBe("failed");
    expect(triage.findings.map((finding) => finding.code)).toEqual([
      "run_not_completed",
      "runtime_error",
      "verification_failed",
      "ungrounded_final_reply",
      "repeated_tool_load",
      "many_iterations",
    ]);
    expect(triage.topRecommendation).toContain("raw feedback log");
  });

  it("keeps a complete workstream lifecycle in the latest summary", async () => {
    const ledger = new AsyncAgentFeedbackLedger({
      dataDir: tempDir,
      enabled: true,
      now: () => new Date("2026-07-18T10:00:00.000Z"),
    });
    const lifecycle = {
      repository: {
        workstreamId: "W-20260718-0001",
        contextRepositoryPath: "/ayati/workstreams/W-20260718-0001-site",
        branch: "main",
        selectionMode: "activated",
        workstreamCreated: false,
        headBefore: "a".repeat(40),
      },
      request: {
        decision: "create",
        requestId: "R-0002",
        status: "active",
        created: true,
      },
      run: {
        runId: "RUN-2",
        workstreamBound: true,
      },
      finalization: { status: "not_started" },
    } as const;
    ledger.record({
      sessionId: "S-1",
      seq: 2,
      runId: "RUN-2",
      stage: "context_engine",
      event: "agent_routed",
      data: {
        workstreamId: "W-20260718-0001",
        runId: "RUN-2",
        workstreamLifecycle: lifecycle,
        contextEngine: {
          workstreamId: "W-20260718-0001",
          runId: "RUN-2",
          workstreamLifecycle: lifecycle,
        },
      },
    });
    ledger.record({
      sessionId: "S-1",
      seq: 2,
      runId: "RUN-2",
      stage: "final",
      event: "reply",
      data: {
        feedbackSummary: {
          status: "completed",
          responseKind: "reply",
          iterations: 3,
          toolCalls: 2,
          actionSteps: 1,
          verificationPassed: true,
          basedOnVerifiedFacts: true,
          warnings: [],
        },
      },
    });
    ledger.record({
      sessionId: "S-1",
      seq: 2,
      runId: "RUN-2",
      stage: "git_context_service",
      event: "run_finalization_completed",
      data: {
        outcome: "done",
        stopReason: "completed",
        workstreamBinding: {
          workstreamId: "W-20260718-0001",
          requestId: "R-0002",
          boundAt: "2026-07-18T09:59:00.000Z",
        },
        materialization: { status: "not_requested" },
        workstreamContextCommit: {
          status: "committed",
          workstreamId: "W-20260718-0001",
          requestId: "R-0002",
          commit: "b".repeat(40),
          headBefore: "a".repeat(40),
          headAfter: "b".repeat(40),
        },
      },
    });
    await ledger.flush();

    const summary = JSON.parse(
      await readFile(join(tempDir, "feedback", "latest-summary.json"), "utf-8"),
    );
    expect(summary.contextEngine.workstreamLifecycle).toMatchObject({
      repository: {
        workstreamId: "W-20260718-0001",
        contextRepositoryPath: "/ayati/workstreams/W-20260718-0001-site",
        selectionMode: "activated",
        headAfter: "b".repeat(40),
      },
      request: { decision: "create", requestId: "R-0002", created: true },
      run: { runId: "RUN-2", workstreamBound: true },
      finalization: {
        status: "committed",
        outcome: "done",
        commit: "b".repeat(40),
        headAfter: "b".repeat(40),
      },
    });
    const triage = JSON.parse(
      await readFile(join(tempDir, "feedback", "triage-summary.json"), "utf-8"),
    );
    expect(triage.outcome).toBe("healthy");
    expect(triage.findings).toEqual([expect.objectContaining({ code: "healthy_run" })]);
  });

  it("reduces one-run Git Context events into the workstream lifecycle summary", async () => {
    const ledger = new AsyncAgentFeedbackLedger({
      dataDir: tempDir,
      enabled: true,
      now: () => new Date("2026-07-18T10:00:00.000Z"),
    });
    ledger.record({
      sessionId: "S-1",
      seq: 2,
      runId: "RUN-1",
      stage: "git_context_service",
      event: "run_workstream_bound",
      data: {
        workstreamId: "W-20260718-0001",
        runId: "RUN-1",
        mode: "created",
        contextRepositoryPath: "/ayati/workstreams/W-20260718-0001-site",
        branch: "main",
        workstreamHead: "a".repeat(40),
        workstreamCreated: true,
        requestDecision: "initial",
        requestId: "R-0001",
        requestStatus: "active",
        requestCreated: true,
      },
    });
    ledger.record({
      sessionId: "S-1",
      seq: 2,
      runId: "RUN-1",
      stage: "git_context_service",
      event: "run_finalization_completed",
      data: {
        outcome: "done",
        stopReason: "completed",
        workstreamBinding: {
          workstreamId: "W-20260718-0001",
          requestId: "R-0001",
          boundAt: "2026-07-18T09:59:00.000Z",
        },
        materialization: { status: "not_requested" },
        workstreamContextCommit: {
          status: "committed",
          workstreamId: "W-20260718-0001",
          requestId: "R-0001",
          headBefore: "a".repeat(40),
          headAfter: "b".repeat(40),
          commit: "b".repeat(40),
        },
      },
    });
    ledger.record({
      sessionId: "S-1",
      seq: 2,
      runId: "RUN-1",
      stage: "final",
      event: "reply",
      data: {
        feedbackSummary: {
          status: "completed",
          responseKind: "reply",
          warnings: [],
        },
      },
    });
    await ledger.flush();

    const summary = JSON.parse(
      await readFile(join(tempDir, "feedback", "latest-summary.json"), "utf8"),
    );
    expect(summary.contextEngine.workstreamLifecycle).toMatchObject({
      repository: {
        workstreamId: "W-20260718-0001",
        contextRepositoryPath: "/ayati/workstreams/W-20260718-0001-site",
        headAfter: "b".repeat(40),
      },
      request: {
        decision: "initial",
        requestId: "R-0001",
        created: true,
      },
      run: { runId: "RUN-1", workstreamBound: true },
      finalization: {
        status: "committed",
        outcome: "done",
        commit: "b".repeat(40),
        commitCreated: true,
      },
    });
  });

  it("triages missing request decisions", () => {
    const triage = buildFeedbackTriageSummary({
      updatedAt: "2026-07-18T10:00:00.000Z",
      tsMs: 1,
      status: "completed",
      responseKind: "reply",
      contextEngine: {
        workstreamBound: true,
        workstreamLifecycle: {
          repository: {
            workstreamId: "W-20260718-0001",
            contextRepositoryPath: "/ayati/workstreams/W-20260718-0001-site",
            selectionMode: "activated",
          },
          run: { runId: "RUN-1", workstreamBound: true },
        },
      },
      warnings: [],
      rawPath: "feedback/test.jsonl",
    });

    expect(triage.outcome).toBe("failed");
    expect(triage.findings.map((finding) => finding.code)).toEqual([
      "workstream_request_decision_missing",
      "workstream_request_missing",
    ]);
  });

  it("allows clarification to finalize an unbound run", () => {
    const triage = buildFeedbackTriageSummary({
      updatedAt: "2026-07-18T10:00:00.000Z",
      tsMs: 1,
      status: "completed",
      responseKind: "reply",
      contextEngine: {
        pendingTurnStatus: "clarifying",
        runId: "RUN-unbound",
        workstreamBound: false,
        workstreamLifecycle: {
          run: {
            runId: "RUN-unbound",
            workstreamBound: false,
          },
        },
      },
      warnings: [],
      rawPath: "feedback/test.jsonl",
    });

    expect(triage.outcome).toBe("healthy");
    expect(triage.findings.map((finding) => finding.code)).toEqual(["healthy_run"]);
  });

  it("reports a failed no-change workstream finalization without requiring a commit", () => {
    const triage = buildFeedbackTriageSummary({
      updatedAt: "2026-07-18T10:00:00.000Z",
      tsMs: 1,
      status: "completed",
      responseKind: "reply",
      contextEngine: {
        workstreamBound: true,
        workstreamLifecycle: {
          repository: {
            workstreamId: "W-20260718-0001",
            contextRepositoryPath: "/ayati/workstreams/W-20260718-0001-site",
            selectionMode: "activated",
            headAfter: "a".repeat(40),
          },
          request: {
            decision: "continue",
            requestId: "R-0001",
            created: false,
          },
          run: { runId: "RUN-1", workstreamBound: true },
          finalization: {
            status: "no_change",
            outcome: "failed",
            validation: "failed",
            commitCreated: false,
            headAfter: "a".repeat(40),
          },
        },
      },
      warnings: [],
      rawPath: "feedback/test.jsonl",
    });

    expect(triage.outcome).toBe("needs_review");
    expect(triage.findings.map((finding) => finding.code)).toEqual([
      "workstream_finalization_validation_failed",
      "workstream_outcome_failed",
    ]);
  });

  it("drops oldest events when the queue is full", async () => {
    const ledger = new AsyncAgentFeedbackLedger({
      dataDir: tempDir,
      enabled: true,
      maxQueueSize: 2,
      now: () => new Date("2026-06-23T10:00:00.000Z"),
    });

    ledger.record({ sessionId: "session-1", stage: "test", event: "one" });
    ledger.record({ sessionId: "session-1", stage: "test", event: "two" });
    ledger.record({ sessionId: "session-1", stage: "test", event: "three" });
    await ledger.flush();

    const lines = (await readFile(join(tempDir, "feedback", "2026-06-23", "session-session-1.jsonl"), "utf-8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { stage: string; event: string; data?: { count?: number } });

    expect(lines.map((line) => `${line.stage}.${line.event}`)).toEqual([
      "feedback.dropped",
      "test.two",
      "test.three",
    ]);
    expect(lines[0]?.data?.count).toBe(1);
  });

  it("does not throw when feedback writes fail", async () => {
    const blockedPath = join(tempDir, "not-a-directory");
    await writeFile(blockedPath, "file");
    const warn = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const ledger = new AsyncAgentFeedbackLedger({
      dataDir: blockedPath,
      enabled: true,
      now: () => new Date("2026-06-23T10:00:00.000Z"),
    });

    ledger.record({ sessionId: "session-1", stage: "message", event: "received" });

    await expect(ledger.flush()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});
