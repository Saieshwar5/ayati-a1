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

    const latest = JSON.parse(await readFile(join(tempDir, "feedback", "latest.json"), "utf-8")) as {
      updatedAt?: string;
      seq?: number;
      runId?: string;
      path?: string;
    };
    expect(latest.updatedAt).toBe("2026-06-23T10:00:01.000Z");
    expect(latest.seq).toBe(2);
    expect(latest.runId).toBe("run-2");
    expect(latest.path).toBe("feedback/2026-06-23/session-session-1.jsonl");
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
      warnings?: string[];
      rawPath?: string;
    };

    expect(summary.status).toBe("completed");
    expect(summary.responseKind).toBe("reply");
    expect(summary.iterations).toBe(3);
    expect(summary.toolCalls).toBe(2);
    expect(summary.toolLoadDecisions).toBe(1);
    expect(summary.actionSteps).toBe(1);
    expect(summary.verificationPassed).toBe(true);
    expect(summary.basedOnVerifiedFacts).toBe(true);
    expect(summary.warnings).toEqual([]);
    expect(summary.rawPath).toBe("feedback/2026-06-23/session-session-1.jsonl");

    const triage = JSON.parse(await readFile(join(tempDir, "feedback", "triage-summary.json"), "utf-8")) as {
      outcome?: string;
      findings?: Array<{ code?: string; severity?: string }>;
      rawSummaryPath?: string;
    };
    expect(triage.outcome).toBe("healthy");
    expect(triage.findings?.[0]).toMatchObject({ code: "healthy_run", severity: "info" });
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
                sessionId: "session-1",
                conversationTail: [],
                activityTail: [],
                assetCount: 0,
              },
              pendingTurn: {
                fromSeq: 3,
                toSeq: 3,
                text: "continue upload UI",
                at: "2026-06-23T10:00:00.000Z",
                routingStatus: "bound",
                workId: "W-1",
                branch: "task/W-1-upload-ui",
                runId: "run-3",
              },
              focus: {
                status: "active",
                ref: "refs/heads/task/W-1-upload-ui",
                workId: "W-1",
              },
              task: {
                ref: "refs/heads/task/W-1-upload-ui",
                workId: "W-1",
                title: "Upload UI",
                objective: "Improve upload UI",
                status: "open",
                completed: [],
                open: ["Improve upload UI"],
                blockers: [],
                facts: [],
                assets: [{ assetId: "asset-1", role: "input", kind: "file", name: "mock.png" }],
                recentRuns: [],
                recentCommits: [],
                recentEvidence: [{
                  runId: "run-2",
                  workId: "W-1",
                  tool: "shell",
                  summary: "tests passed",
                  artifacts: [],
                  facts: [],
                  accessModes: ["tail"],
                }],
              },
            },
            routeStatus: "ready",
            routeMode: "continue_active_task",
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
        taskId?: string;
        branch?: string;
        runId?: string;
        committed?: boolean;
        taskAssetCount?: number;
        recentEvidenceCount?: number;
      };
    };

    expect(summary.contextEngine).toMatchObject({
      pendingTurnStatus: "bound",
      routeMode: "continue_active_task",
      routeSource: "auto",
      taskId: "W-1",
      branch: "task/W-1-upload-ui",
      runId: "run-3",
      committed: false,
      taskAssetCount: 1,
      recentEvidenceCount: 1,
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
          warnings: [],
          contextEngine: {
            taskId: "W-4",
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
      stage: "context_engine",
      event: "committed",
      data: {
        taskId: "W-4",
        taskCommit: "abc1234",
        ref: "refs/heads/task/W-4-example",
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
    };
    expect(summary.contextEngine).toMatchObject({
      finalizationStatus: "committed",
      committed: true,
      commit: "abc1234",
      ref: "refs/heads/task/W-4-example",
    });

    const triage = JSON.parse(await readFile(join(tempDir, "feedback", "triage-summary.json"), "utf-8")) as {
      outcome?: string;
      findings?: Array<{ code?: string }>;
    };
    expect(triage.outcome).toBe("healthy");
    expect(triage.findings?.map((finding) => finding.code)).toEqual(["healthy_run"]);
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
          "normal_tools_selected_without_work_run",
          "normal_tool_before_routing",
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
        message: "Git-memory routed run is required before chat tool execution.",
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
      "normal_tools_selected_without_work_run",
      "normal_tool_before_routing",
      "missing_work_run_for_action",
    ]);

    const triage = JSON.parse(await readFile(join(tempDir, "feedback", "triage-summary.json"), "utf-8")) as {
      outcome?: string;
      findings?: Array<{ code?: string; severity?: string }>;
    };
    expect(triage.outcome).toBe("failed");
    expect(triage.findings?.map((finding) => finding.code)).toEqual([
      "run_not_completed",
      "runtime_error",
      "normal_tools_selected_without_work_run",
      "missing_work_run_for_action",
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
      event: "fresh_session_tool_repair_requested",
      data: {
        repair: {
          code: "R_FRESH_SESSION_NEEDS_TASK",
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
          blockedTargets: ["git_context_create_task_for_turn"],
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
      "fresh_session_tool_repair_requested",
      "R_FRESH_SESSION_NEEDS_TASK",
      "R_ASSISTANT_TEXT_TOOL_CALL",
    ]);

    const triage = JSON.parse(await readFile(join(tempDir, "feedback", "triage-summary.json"), "utf-8")) as {
      findings?: Array<{ code?: string; severity?: string }>;
    };
    expect(triage.findings?.map((finding) => finding.code)).toEqual([
      "R_ASSISTANT_TEXT_TOOL_CALL",
      "R_FRESH_SESSION_NEEDS_TASK",
      "fresh_session_tool_repair_requested",
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
