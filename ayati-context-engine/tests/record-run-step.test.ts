import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunStepRecord, RunStepToolCall } from "../src/contracts.js";
import { ContextDatabase } from "../src/database/database.js";
import { SqliteContextEngineService } from "../src/services/sqlite-context-engine-service.js";

const roots: string[] = [];
const services: SqliteContextEngineService[] = [];

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
      runId: prepared.run.runId,
      record: step(1, readCall()),
    };

    const first = await fixture.service.recordRunStep(input);
    const replayed = await fixture.service.recordRunStep(input);

    expect(replayed).toEqual(first);
    expect(first.run).toMatchObject({
      run: { stepCount: 1 },
      workState: { revision: 0, afterStep: 0 },
      steps: [{
        step: 1,
        toolCalls: [{
          callId: "call-read",
          verification: {
            version: 1,
            status: "passed",
            method: "tool_contract",
          },
        }],
      }],
    });
    expect(first.context).toMatchObject({
      run: {
        run: { runId: prepared.run.runId, stepCount: 1 },
        workState: { revision: 0, afterStep: 0 },
      },
      stream: { stream: { streamId: prepared.stream.streamId } },
    });
    expect(fixture.database.prepare(
      "SELECT COUNT(*) AS count FROM run_steps WHERE run_id = ?",
    ).get(prepared.run.runId)).toEqual({ count: 1 });
  });

  it("persists deterministic zero-match search evidence on the exact tool call", async () => {
    const fixture = await createFixture();
    const prepared = await prepare(fixture.service, "search-evidence");
    const searchCall: RunStepToolCall = {
      callId: "call-search",
      tool: "find_files",
      purpose: "Search for the requested file.",
      toolPurpose: "search",
      toolEffect: "read_only",
      status: "success",
      input: { query: "missing-report.txt", roots: ["/workspace"] },
      output: { matches: [] },
      verification: {
        version: 1,
        status: "passed",
        method: "tool_contract",
        contract: "tool_result_v2",
        summary: "The filename search passed deterministic verification.",
        checks: [],
        facts: [],
      },
      completionEvidence: [{
        kind: "file_search",
        query: "missing-report.txt",
        roots: ["/workspace"],
        matchCount: 0,
        maxDepth: 10,
        includeHidden: false,
        capped: false,
        errorCount: 0,
        depthLimitedDirectoryCount: 0,
        complete: true,
        change: "observed",
        tool: "find_files",
        step: 1,
        callId: "call-search",
      }],
    };

    const result = await fixture.service.recordRunStep({
      requestId: "REQ-search-evidence",
      runId: prepared.run.runId,
      record: step(1, searchCall),
    });

    expect(result.run.steps[0]?.toolCalls[0]?.completionEvidence).toEqual(
      searchCall.completionEvidence,
    );
  });

  it("persists compact structured denial metadata on a failed tool call", async () => {
    const fixture = await createFixture();
    const prepared = await prepare(fixture.service, "permission-denial");
    const deniedCall: RunStepToolCall = {
      callId: "call-denied",
      tool: "read_files",
      purpose: "Read the requested protected file.",
      toolPurpose: "read",
      toolEffect: "read_only",
      status: "failed",
      input: {
        files: [{
          path: "/protected/report.txt",
          mode: "full",
        }],
      },
      error: "The operating-system account cannot read the file.",
      code: "EACCES",
      errorCategory: "permission",
      errorTarget: "/protected/report.txt",
      operationStatus: "failed",
      verificationPassed: false,
    };
    const record = {
      ...step(1, deniedCall),
      status: "failed" as const,
      summary: "External mutation was denied.",
      verification: { passed: false },
    };

    const result = await fixture.service.recordRunStep({
      requestId: "REQ-permission-denial",
      runId: prepared.run.runId,
      record,
    });

    expect(result.run.steps[0]?.toolCalls[0]).toMatchObject({
      callId: "call-denied",
      status: "failed",
      code: "EACCES",
      errorCategory: "permission",
      errorTarget: "/protected/report.txt",
      operationStatus: "failed",
      verificationPassed: false,
    });
  });

  it("requires contiguous unique step numbers", async () => {
    const fixture = await createFixture();
    const prepared = await prepare(fixture.service, "contiguous");

    await expect(fixture.service.recordRunStep({
      requestId: "REQ-step-two-first",
      runId: prepared.run.runId,
      record: step(2, readCall()),
    })).rejects.toMatchObject({ code: "RUN_STEP_NOT_CONTIGUOUS" });
    await fixture.service.recordRunStep({
      requestId: "REQ-step-one",
      runId: prepared.run.runId,
      record: step(1, readCall()),
    });
    await expect(fixture.service.recordRunStep({
      requestId: "REQ-step-one-duplicate",
      runId: prepared.run.runId,
      record: step(1, readCall()),
    })).rejects.toMatchObject({ code: "RUN_STEP_NOT_CONTIGUOUS" });
  });

  it("revises WorkState only through an explicit named checkpoint", async () => {
    const fixture = await createFixture();
    const prepared = await prepare(fixture.service, "work-state-checkpoint");
    await fixture.service.recordRunStep({
      requestId: "REQ-checkpoint-step-one",
      runId: prepared.run.runId,
      record: step(1, readCall()),
    });

    const checkpoint = await fixture.service.checkpointRunWorkState({
      requestId: "REQ-checkpoint-plan",
      runId: prepared.run.runId,
      expectedRevision: 0,
      afterStep: 1,
      reason: "plan",
      workState: {
        status: "in_progress",
        summary: "The exact source was inspected; implementation is now multi-step.",
        plan: [
          { id: "design", task: "Finish the design contract.", status: "active" },
          { id: "tests", task: "Add deterministic coverage.", status: "pending" },
        ],
        importantContext: [{
          kind: "artifact",
          value: "Primary source file",
          ref: "/workspace/src/app.ts",
        }],
        nextAction: "Finish the design contract.",
      },
      at: "2026-07-19T10:01:02+05:30",
    });

    expect(checkpoint.run.workState).toMatchObject({
      revision: 1,
      afterStep: 1,
      updateReason: "plan",
      status: "in_progress",
    });
    expect(checkpoint.run.workState.plan).toContainEqual({
      id: "design",
      task: "Finish the design contract.",
      status: "active",
    });
    await fixture.service.recordRunStep({
      requestId: "REQ-checkpoint-step-two",
      runId: prepared.run.runId,
      record: step(2, readCall()),
    });
    const context = await fixture.service.getAgentContext({
      streamId: prepared.stream.streamId,
    });
    expect(context.run).toMatchObject({
      run: { stepCount: 2 },
      workState: {
        revision: 1,
        afterStep: 1,
        updateReason: "plan",
      },
    });
    await expect(fixture.service.checkpointRunWorkState({
      requestId: "REQ-checkpoint-stale",
      runId: prepared.run.runId,
      expectedRevision: 0,
      afterStep: 2,
      reason: "context_pressure",
      workState: {
        status: "in_progress",
        summary: "Stale update.",
        plan: [],
        importantContext: [],
        nextAction: null,
      },
      at: "2026-07-19T10:01:03+05:30",
    })).rejects.toThrow("revision conflict");
  });

  it("rejects mutation calls before workstream binding", async () => {
    const fixture = await createFixture();
    const prepared = await prepare(fixture.service, "unbound-mutation");

    await expect(fixture.service.recordRunStep({
      requestId: "REQ-unbound-mutation",
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
        createdAt: "2026-07-19T10:01:01+05:30",
      },
    });

    expect(result.run).toMatchObject({
      run: { stepCount: 1 },
      steps: [{ status: "failed", toolCalls: [] }],
      workState: { revision: 0, afterStep: 0, status: "in_progress" },
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
      runId: prepared.run.runId,
      record: step(1, inconsistent),
    })).rejects.toMatchObject({ code: "UNKNOWN_TOOL_CLASSIFICATION" });

    await fixture.service.finalizeRun({
      requestId: "REQ-terminal",
      runId: prepared.run.runId,
      outcome: "done",
      stopReason: "completed",
      assistantResponse: "Done.",
      streamSummary: "The direct response completed.",
      summary: "Done.",
      validation: "not_applicable",
      workState: { ...workState(), status: "done", summary: "Done." },
      at: "2026-07-19T10:02:00+05:30",
    });
    await expect(fixture.service.recordRunStep({
      requestId: "REQ-after-terminal",
      runId: prepared.run.runId,
      record: step(1, readCall()),
    })).rejects.toMatchObject({ code: "RUN_NOT_ACTIVE" });
  });
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "ayati-record-run-step-"));
  roots.push(root);
  const database = await ContextDatabase.open({ path: join(root, "context.sqlite") });
  const service = new SqliteContextEngineService({
    database,
    rootDirectory: root,
    now: () => "2026-07-19T10:00:00+05:30",
  });
  services.push(service);
  return { database, service };
}

async function prepare(service: SqliteContextEngineService, suffix: string) {
  return await service.prepareAgentRun({
    requestId: "REQ-prepare-" + suffix,
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
    verification: {
      version: 1,
      status: "passed",
      method: "tool_contract",
      contract: "tool_result_v2",
      summary: "The exact read call passed deterministic verification.",
      checks: [],
      facts: [{
        kind: "file_read",
        message: "The requested file was read.",
        subject: "src/app.ts",
      }],
    },
    verificationPassed: true,
  };
}

function workState() {
  return {
    status: "in_progress" as const,
    summary: "Run is active.",
    plan: [],
    importantContext: [],
    nextAction: null,
  };
}
