import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunStepRecord, RunStepToolCall } from "../src/contracts.js";
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

describe("recordRunStep", () => {
  it("persists one structured step and replays it without advancing state twice", async () => {
    const fixture = await createFixture();
    const prepared = await prepare(fixture.service, "step-replay");
    const input = {
      requestId: prepared.run.runId + ":step:1",
      sessionId: prepared.session.sessionId,
      runId: prepared.run.runId,
      record: step(1, readCall()),
    };

    const first = await fixture.service.recordRunStep(input);
    const replayed = await fixture.service.recordRunStep(input);

    expect(replayed).toEqual(first);
    expect(first.run).toMatchObject({
      run: { stepCount: 1 },
      workState: { revision: 1, afterStep: 1 },
      steps: [{ step: 1, toolCalls: [{ callId: "call-read" }] }],
    });
    expect(fixture.database.prepare(
      "SELECT COUNT(*) AS count FROM run_steps WHERE run_id = ?",
    ).get(prepared.run.runId)).toEqual({ count: 1 });
  });

  it("requires contiguous unique step numbers", async () => {
    const fixture = await createFixture();
    const prepared = await prepare(fixture.service, "contiguous");

    await expect(fixture.service.recordRunStep({
      requestId: "REQ-step-two-first",
      sessionId: prepared.session.sessionId,
      runId: prepared.run.runId,
      record: step(2, readCall()),
    })).rejects.toMatchObject({ code: "RUN_STEP_NOT_CONTIGUOUS" });
    await fixture.service.recordRunStep({
      requestId: "REQ-step-one",
      sessionId: prepared.session.sessionId,
      runId: prepared.run.runId,
      record: step(1, readCall()),
    });
    await expect(fixture.service.recordRunStep({
      requestId: "REQ-step-one-duplicate",
      sessionId: prepared.session.sessionId,
      runId: prepared.run.runId,
      record: step(1, readCall()),
    })).rejects.toMatchObject({ code: "RUN_STEP_NOT_CONTIGUOUS" });
  });

  it("rejects mutation calls before workstream binding", async () => {
    const fixture = await createFixture();
    const prepared = await prepare(fixture.service, "unbound-mutation");

    await expect(fixture.service.recordRunStep({
      requestId: "REQ-unbound-mutation",
      sessionId: prepared.session.sessionId,
      runId: prepared.run.runId,
      record: step(1, {
        callId: "call-write",
        tool: "write_files",
        purpose: "Write a workstream-owned file.",
        toolPurpose: "mutation",
        toolEffect: "workspace_mutation",
        status: "success",
        input: { path: "src/app.ts" },
      }),
    })).rejects.toMatchObject({ code: "MUTATION_REQUIRES_WORKSTREAM_BINDING" });
    expect(fixture.database.prepare(
      "SELECT step_count FROM runs WHERE run_id = ?",
    ).get(prepared.run.runId)).toEqual({ step_count: 0 });
  });

  it("persists failed routing controls while the run remains unbound", async () => {
    const fixture = await createFixture();
    const prepared = await prepare(fixture.service, "routing-failed");

    const result = await fixture.service.recordRunStep({
      requestId: "REQ-routing-failed",
      sessionId: prepared.session.sessionId,
      runId: prepared.run.runId,
      record: {
        ...step(1, {
          callId: "call-route",
          tool: "git_context_activate_workstream",
          purpose: "Route to the requested existing workstream.",
          toolPurpose: "control",
          toolEffect: "context_mutation",
          status: "failed",
          input: { workstreamId: "T-missing" },
          error: { code: "WORKSTREAM_NOT_FOUND" },
        }),
        status: "failed",
        summary: "Routing failed without changing workstream ownership.",
        verification: { passed: false },
      },
    });

    expect(result.run).toMatchObject({
      run: { runId: prepared.run.runId, stepCount: 1 },
      steps: [{ status: "failed", toolCalls: [{ status: "failed" }] }],
    });
  });

  it("persists a failed executor step when validation prevented every tool call", async () => {
    const fixture = await createFixture();
    const prepared = await prepare(fixture.service, "empty-plan-failure");

    const result = await fixture.service.recordRunStep({
      requestId: "REQ-empty-plan-failure",
      sessionId: prepared.session.sessionId,
      runId: prepared.run.runId,
      record: {
        version: 1,
        step: 1,
        status: "failed",
        summary: "The action plan failed deterministic validation.",
        decision: { kind: "tool_call" },
        action: { mode: "single", calls: [] },
        toolCalls: [],
        verification: { passed: false, error: "Action contains no tool calls." },
        workStateAfter: {
          ...workState(),
          status: "blocked",
          summary: "The action plan failed deterministic validation.",
          blockers: ["Action contains no tool calls."],
        },
        createdAt: "2026-07-19T10:01:01+05:30",
      },
    });

    expect(result.run).toMatchObject({
      run: { stepCount: 1 },
      steps: [{ status: "failed", toolCalls: [] }],
      workState: { revision: 1, afterStep: 1, status: "blocked" },
    });
  });

  it("rejects inconsistent classifications and terminal-run steps", async () => {
    const fixture = await createFixture();
    const prepared = await prepare(fixture.service, "classification");
    const inconsistent = {
      ...readCall(),
      toolEffect: "workspace_mutation" as const,
    };
    await expect(fixture.service.recordRunStep({
      requestId: "REQ-inconsistent",
      sessionId: prepared.session.sessionId,
      runId: prepared.run.runId,
      record: step(1, inconsistent),
    })).rejects.toMatchObject({ code: "UNKNOWN_TOOL_CLASSIFICATION" });

    await fixture.service.finalizeRun({
      requestId: "REQ-terminal",
      sessionId: prepared.session.sessionId,
      runId: prepared.run.runId,
      outcome: "done",
      stopReason: "completed",
      assistantResponse: "Done.",
      conversationSummary: "The direct response completed.",
      summary: "Done.",
      validation: "not_applicable",
      workState: { ...workState(), status: "done", summary: "Done." },
      at: "2026-07-19T10:02:00+05:30",
    });
    await expect(fixture.service.recordRunStep({
      requestId: "REQ-after-terminal",
      sessionId: prepared.session.sessionId,
      runId: prepared.run.runId,
      record: step(1, readCall()),
    })).rejects.toMatchObject({ code: "RUN_NOT_ACTIVE" });
  });
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "ayati-record-run-step-"));
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

async function prepare(service: SqliteGitContextService, suffix: string) {
  return await service.prepareContextTurn({
    requestId: "REQ-prepare-" + suffix,
    date: "2026-07-19",
    timezone: "Asia/Kolkata",
    agentId: "local",
    role: "user",
    content: "Exercise unified step persistence.",
    at: "2026-07-19T10:00:00+05:30",
  });
}

function step(number: number, call: RunStepToolCall): RunStepRecord {
  return {
    version: 1,
    step: number,
    status: "completed",
    summary: "Step completed.",
    decision: { kind: "tool_call" },
    action: { callId: call.callId },
    toolCalls: [call],
    verification: { passed: true },
    workStateAfter: { ...workState(), summary: "Step completed." },
    createdAt: `2026-07-19T10:01:0${number}+05:30`,
  };
}

function readCall(): RunStepToolCall {
  return {
    callId: "call-read",
    tool: "read_files",
    purpose: "Read the requested file.",
    toolPurpose: "read",
    toolEffect: "read_only",
    status: "success",
    input: { paths: ["src/app.ts"] },
    output: { files: [] },
  };
}

function workState() {
  return {
    status: "not_done" as const,
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
