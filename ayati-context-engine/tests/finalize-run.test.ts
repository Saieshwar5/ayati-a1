import { afterEach, describe, expect, it } from "vitest";
import type { RunOutcome, RunStopReason } from "../src/contracts.js";
import {
  createWorkstreamServiceFixture,
  workState,
  type WorkstreamServiceFixture,
} from "./simple-workstream-repository-fixtures.js";

const fixtures: WorkstreamServiceFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (fixture) => await fixture.dispose()));
});

describe("V7 run finalization", () => {
  it("closes a zero-step direct reply and appends one immutable assistant message", async () => {
    const fixture = await createFixture("direct-reply");
    const input = finalization(fixture, "done", "completed", "The answer is complete.");
    const result = await fixture.service.finalizeRun(input);
    const replayed = await fixture.service.finalizeRun(input);

    expect(replayed).toEqual(result);
    expect(result).toMatchObject({
      run: { runId: fixture.prepared.run.runId, status: "done", stopReason: "completed", stepCount: 0 },
      assistantMessage: { role: "assistant", sequence: 2, content: "The answer is complete." },
      resourceEffects: { status: "none", events: [] },
      workstreamContextCommit: { status: "not_required" },
    });
    expect(fixture.database.prepare(
      "SELECT COUNT(*) AS count FROM messages WHERE stream_id = ?",
    ).get(fixture.prepared.stream.streamId)).toEqual({ count: 2 });
    expect(() => fixture.database.prepare(
      "UPDATE messages SET content = 'changed' WHERE message_id = ?",
    ).run(result.assistantMessage!.messageId)).toThrow("messages are immutable");
  });

  it("keeps structured step evidence in run history without transcript materialization", async () => {
    const fixture = await createFixture("step-evidence");
    await fixture.service.recordRunStep({
      requestId: fixture.prepared.run.runId + ":step:1",
      runId: fixture.prepared.run.runId,
      record: {
        version: 1,
        step: 1,
        status: "completed",
        summary: "Read exact evidence.",
        decision: { kind: "act" },
        action: { tool: "read_files" },
        toolCalls: [{
          callId: "call-read",
          tool: "read_files",
          purpose: "Read exact evidence.",
          toolPurpose: "read",
          toolEffect: "read_only",
          status: "success",
          input: { paths: ["README.md"] },
          output: { files: [{ path: "README.md", content: "evidence" }] },
        }],
        verification: { passed: true },
        workStateAfter: workState({
          summary: "Read exact evidence.",
          facts: ["README was read."],
          evidence: ["README.md"],
        }),
        createdAt: "2026-07-19T10:01:00+05:30",
      },
    });
    await fixture.service.finalizeRun(finalization(
      fixture,
      "done",
      "completed",
      "I inspected the evidence.",
    ));

    const history = await fixture.service.readAgentHistory({
      streamId: fixture.prepared.stream.streamId,
      ref: "run:" + fixture.prepared.run.runId,
      maxChars: 32_000,
    });
    expect(history.messages).toEqual([]);
    expect(history.evidence?.content).toContain("call-read");
    expect(history.evidence?.content).toContain("README.md");
    expect(history.truncated).toBe(false);
    const tables = fixture.database.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'conversation_segments'",
    ).all();
    expect(tables).toEqual([]);
  });

  for (const [outcome, stopReason] of [
    ["failed", "failed"],
    ["blocked", "blocked"],
    ["needs_user_input", "needs_user_input"],
    ["incomplete", "run_limit"],
    ["incomplete", "context_limit"],
    ["incomplete", "interrupted"],
  ] as Array<[RunOutcome, RunStopReason]>) {
    it(`persists ${outcome}/${stopReason} truthfully`, async () => {
      const fixture = await createFixture(outcome + "-" + stopReason);
      const result = await fixture.service.finalizeRun(finalization(
        fixture,
        outcome,
        stopReason,
        `Final ${outcome} response.`,
      ));
      expect(result.run).toMatchObject({ status: outcome, stopReason });
      expect(result.assistantMessage?.content).toBe(`Final ${outcome} response.`);
    });
  }
});

async function createFixture(name: string): Promise<WorkstreamServiceFixture> {
  const fixture = await createWorkstreamServiceFixture(name, "Answer this request.");
  fixtures.push(fixture);
  return fixture;
}

function finalization(
  fixture: WorkstreamServiceFixture,
  outcome: RunOutcome,
  stopReason: RunStopReason,
  assistantResponse: string,
) {
  return {
    requestId: fixture.prepared.run.runId + ":finalize",
    runId: fixture.prepared.run.runId,
    outcome,
    stopReason,
    assistantResponse,
    streamSummary: "The run reached its terminal state.",
    summary: "The run reached its terminal state.",
    validation: "not_applicable" as const,
    workState: workState({
      status: outcome === "done"
        ? "done"
        : outcome === "blocked"
          ? "blocked"
          : outcome === "needs_user_input"
            ? "needs_user_input"
            : "not_done",
      summary: "The run reached its terminal state.",
    }),
    at: "2026-07-19T10:02:00+05:30",
  };
}
