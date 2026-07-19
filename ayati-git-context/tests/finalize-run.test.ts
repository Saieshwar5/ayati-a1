import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  PrepareContextTurnResponse,
  RunOutcome,
  RunStopReason,
  RunWorkStateInput,
} from "../src/contracts.js";
import { ContextDatabase } from "../src/database/database.js";
import { SqliteGitContextService } from "../src/services/sqlite-git-context-service.js";

const roots: string[] = [];
const services: SqliteGitContextService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map(async (service) => await service.close()));
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

describe("unified run finalization", () => {
  it("closes a zero-step direct reply without run files or a commit", async () => {
    const fixture = await createFixture();
    const prepared = await prepare(fixture.service, "direct", "What is inertia?");

    const result = await fixture.service.finalizeRun(finalization(prepared, {
      requestId: "REQ-finalize-direct",
      outcome: "done",
      stopReason: "completed",
      assistantResponse: "Inertia is an object's resistance to a change in motion.",
      workState: { ...workState(), status: "done", summary: "Answered directly." },
    }));

    expect(result).toMatchObject({
      run: { runId: prepared.run.runId, status: "done", stopReason: "completed", stepCount: 0 },
      conversation: { status: "closed" },
      materialization: { status: "not_requested" },
      resourceEffects: { status: "none", events: [] },
      workstreamContextCommit: { status: "not_required" },
    });
    expect(fixture.database.prepare(
      "SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?",
    ).get(prepared.conversation.conversationId)).toEqual({ count: 2 });
    await expect(access(join(prepared.session.repositoryPath, "runs", prepared.run.runId)))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("replays one finalization without duplicating its assistant message", async () => {
    const fixture = await createFixture();
    const prepared = await prepare(fixture.service, "replay", "Give me a short answer.");
    const input = finalization(prepared, {
      requestId: "REQ-finalize-replay",
      outcome: "done",
      stopReason: "completed",
      assistantResponse: "Here is the short answer.",
      workState: { ...workState(), status: "done", summary: "Answered directly." },
    });

    const first = await fixture.service.finalizeRun(input);
    const replayed = await fixture.service.finalizeRun(input);

    expect(replayed).toEqual(first);
    expect(fixture.database.prepare(
      "SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?",
    ).get(prepared.conversation.conversationId)).toEqual({ count: 2 });
    await expect(fixture.service.finalizeRun({
      ...input,
      requestId: "REQ-finalize-second",
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("materializes complete ordered evidence for a step-bearing unbound run", async () => {
    const fixture = await createFixture();
    const prepared = await prepare(fixture.service, "observed", "Inspect package.json.");
    const recorded = await fixture.service.recordRunStep({
      requestId: prepared.run.runId + ":step:1",
      sessionId: prepared.session.sessionId,
      runId: prepared.run.runId,
      record: {
        version: 1,
        step: 1,
        status: "completed",
        summary: "Read the package metadata.",
        decision: { kind: "tool_call", tool: "read_files" },
        action: { callId: "call-read" },
        toolCalls: [{
          callId: "call-read",
          tool: "read_files",
          purpose: "Inspect package metadata.",
          toolPurpose: "read",
          toolEffect: "read_only",
          status: "success",
          input: { paths: ["package.json"] },
          output: { name: "fixture" },
        }],
        verification: { passed: true, resources: ["package.json"] },
        workStateAfter: {
          ...workState(),
          summary: "Package metadata inspected.",
          facts: ["The package name is fixture."],
        },
        createdAt: "2026-07-19T10:01:00+05:30",
      },
    });
    expect(recorded.run.run.stepCount).toBe(1);
    expect(recorded.readContext.evidence[0]).toMatchObject({
      runId: prepared.run.runId,
      callId: "call-read",
      tool: "read_files",
    });

    const result = await fixture.service.finalizeRun(finalization(prepared, {
      requestId: "REQ-finalize-observed",
      outcome: "done",
      stopReason: "completed",
      assistantResponse: "I inspected the package metadata.",
      workState: { ...workState(), status: "done", summary: "Inspection complete." },
    }));

    expect(result.materialization).toMatchObject({
      status: "materialized",
      runFile: `runs/${prepared.run.runId}/run.json`,
      stepsFile: `runs/${prepared.run.runId}/steps.jsonl`,
    });
    expect(result.workstreamContextCommit).toEqual({ status: "not_required" });
    const runFile = JSON.parse(await readFile(
      join(prepared.session.repositoryPath, result.materialization.runFile!),
      "utf8",
    )) as Record<string, unknown>;
    expect(runFile).toMatchObject({
      schemaVersion: 2,
      runId: prepared.run.runId,
      status: "done",
      stopReason: "completed",
      stepCount: 1,
    });
    const stepLine = JSON.parse((await readFile(
      join(prepared.session.repositoryPath, result.materialization.stepsFile!),
      "utf8",
    )).trim()) as Record<string, unknown>;
    expect(stepLine).toMatchObject({
      step: 1,
      toolCalls: [{ callId: "call-read", tool: "read_files" }],
    });
  });

  it.each([
    ["done", "completed", "done", "done"],
    ["failed", "failed", "not_done", "failed"],
    ["blocked", "blocked", "blocked", "blocked"],
    ["needs_user_input", "needs_user_input", "needs_user_input", "needs_user_input"],
    ["incomplete", "run_limit", "not_done", "incomplete"],
    ["incomplete", "context_limit", "not_done", "incomplete"],
    ["incomplete", "interrupted", "not_done", "incomplete"],
  ] as const)(
    "persists %s/%s truthfully",
    async (outcome, stopReason, workStatus, expectedStatus) => {
      const fixture = await createFixture();
      const prepared = await prepare(fixture.service, `${outcome}-${stopReason}`, "Exercise outcome.");
      const result = await fixture.service.finalizeRun(finalization(prepared, {
        requestId: `REQ-finalize-${outcome}-${stopReason}`,
        outcome,
        stopReason,
        assistantResponse: stopReason === "interrupted" ? "" : `Run ended as ${outcome}.`,
        workState: {
          ...workState(),
          status: workStatus,
          summary: `Run ended as ${outcome}.`,
          ...(workStatus === "blocked" ? { blockers: ["A proven blocker remains."] } : {}),
          ...(workStatus === "needs_user_input"
            ? { userInputNeeded: ["Choose the intended workstream."] }
            : {}),
        },
      }));

      expect(result.run).toMatchObject({ status: expectedStatus, stopReason });
      expect(fixture.database.prepare(
        "SELECT status, stop_reason FROM runs WHERE run_id = ?",
      ).get(prepared.run.runId)).toEqual({ status: expectedStatus, stop_reason: stopReason });
    },
  );
});

async function createFixture(): Promise<{
  database: ContextDatabase;
  service: SqliteGitContextService;
}> {
  const root = await mkdtemp(join(tmpdir(), "ayati-finalize-run-"));
  roots.push(root);
  const database = await ContextDatabase.open({ path: join(root, "context.sqlite") });
  const service = new SqliteGitContextService({
    database,
    rootDirectory: root,
    now: () => "2026-07-19T10:00:00+05:30",
  });
  services.push(service);
  return { database, service };
}

async function prepare(
  service: SqliteGitContextService,
  suffix: string,
  content: string,
): Promise<PrepareContextTurnResponse> {
  return await service.prepareContextTurn({
    requestId: `REQ-prepare-${suffix}`,
    date: "2026-07-19",
    timezone: "Asia/Kolkata",
    agentId: "local",
    role: "user",
    content,
    at: "2026-07-19T10:00:00+05:30",
  });
}

function finalization(
  prepared: PrepareContextTurnResponse,
  input: {
    requestId: string;
    outcome: RunOutcome;
    stopReason: RunStopReason;
    assistantResponse: string;
    workState: RunWorkStateInput;
  },
) {
  return {
    ...input,
    sessionId: prepared.session.sessionId,
    runId: prepared.run.runId,
    conversationSummary: "The run reached its truthful terminal state.",
    summary: input.workState.summary,
    validation: input.outcome === "failed" ? "failed" as const : "not_applicable" as const,
    at: "2026-07-19T10:02:00+05:30",
  };
}

function workState(): RunWorkStateInput {
  return {
    status: "not_done",
    summary: "Run is active.",
    openWork: [],
    blockers: [],
    facts: [],
    evidence: [],
    artifacts: [],
    nextStep: null,
    userInputNeeded: [],
  };
}
