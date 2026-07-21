import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ContextCheckpointSummary, RunStepToolCall } from "../src/contracts.js";
import { readRecentStreamMessages } from "../src/repositories/message-records.js";
import {
  createWorkstreamServiceFixture,
  workState,
  type WorkstreamServiceFixture,
} from "./simple-workstream-repository-fixtures.js";

const fixtures: WorkstreamServiceFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (fixture) => await fixture.dispose()));
});

describe("V7 agent-facing context", () => {
  it("reads the newest exact stream tail in chronological order", async () => {
    const fixture = await createFixture("recent-tail", "turn 1");
    await finalize(fixture, "answer 1", "recent-tail-1");
    for (let turn = 2; turn <= 5; turn++) {
      fixture.prepared = await fixture.service.prepareAgentRun(prepare(
        `REQ-recent-tail-${turn}`,
        `turn ${turn}`,
        `2026-07-20T10:0${turn}:00+05:30`,
      ));
      await finalize(fixture, `answer ${turn}`, `recent-tail-${turn}`);
    }

    expect(readRecentStreamMessages(fixture.database, {
      streamId: fixture.prepared.stream.streamId,
      afterSeq: 2,
      limit: 3,
    }).map((message) => message.sequence)).toEqual([8, 9, 10]);
  });

  it("commits a pressure checkpoint over complete terminal runs and retains an exact tail", async () => {
    const fixture = await createFixture("checkpoint", "first " + "a".repeat(2_000));
    await finalize(fixture, "first answer " + "b".repeat(2_000), "first");
    fixture.prepared = await fixture.service.prepareAgentRun(prepare(
      "REQ-checkpoint-second",
      "second " + "c".repeat(2_000),
      "2026-07-20T10:02:00+05:30",
    ));
    await finalize(fixture, "second answer " + "d".repeat(2_000), "second");
    fixture.prepared = await fixture.service.prepareAgentRun(prepare(
      "REQ-checkpoint-current",
      "Current input must remain exact.",
      "2026-07-20T10:04:00+05:30",
    ));

    const plan = await fixture.service.planContextCheckpoint({
      requestId: "REQ-checkpoint-plan",
      streamId: fixture.prepared.stream.streamId,
      protectFromSeq: fixture.prepared.message.sequence,
      requiredSavingsTokens: 500,
      estimatedCheckpointTokens: 200,
      at: "2026-07-20T10:04:01+05:30",
    });
    expect(plan).toMatchObject({
      triggered: true,
      coveredFromSeq: 1,
      coveredToSeq: 4,
      estimatedCheckpointTokens: 200,
    });
    expect(plan.selectedMessages.map((message) => message.sequence)).toEqual([1, 2, 3, 4]);
    expect(plan.exactTail.map((message) => message.sequence)).toEqual([5]);

    const summary = checkpointSummary(1, 4);
    const committed = await fixture.service.commitContextCheckpoint({
      requestId: "REQ-checkpoint-commit",
      plan,
      summary,
      tokenCount: 100,
      provider: "test-provider",
      model: "test-model",
      at: "2026-07-20T10:04:02+05:30",
    });
    expect(committed.checkpoint).toMatchObject({
      coveredFromSeq: 1,
      coveredToSeq: 4,
      reason: "context_pressure",
      exactAnchors: [1, 4],
    });
    expect(committed.context.stream?.checkpoint?.checkpointId)
      .toBe(committed.checkpoint.checkpointId);
    expect(committed.context.stream?.recentMessages.map((message) => message.sequence)).toEqual([5]);
    expect(fixture.database.prepare(
      "SELECT active_checkpoint_id FROM agent_streams WHERE stream_id = ?",
    ).get(fixture.prepared.stream.streamId)).toEqual({
      active_checkpoint_id: committed.checkpoint.checkpointId,
    });
  });

  it("rejects non-exact checkpoint anchors without moving the active pointer", async () => {
    const fixture = await createFixture("invalid-anchor", "old " + "a".repeat(2_000));
    await finalize(fixture, "answer " + "b".repeat(2_000), "old");
    fixture.prepared = await fixture.service.prepareAgentRun(prepare(
      "REQ-invalid-current",
      "Current exact input.",
      "2026-07-20T10:02:00+05:30",
    ));
    const plan = await fixture.service.planContextCheckpoint({
      requestId: "REQ-invalid-plan",
      streamId: fixture.prepared.stream.streamId,
      protectFromSeq: fixture.prepared.message.sequence,
      requiredSavingsTokens: 1,
      estimatedCheckpointTokens: 200,
      at: "2026-07-20T10:02:01+05:30",
    });

    await expect(fixture.service.commitContextCheckpoint({
      requestId: "REQ-invalid-commit",
      plan,
      summary: {
        ...checkpointSummary(1, 2),
        importantFacts: [{ seq: 999, text: "Invented anchor." }],
      },
      tokenCount: 100,
      provider: "test",
      model: "test",
      at: "2026-07-20T10:02:02+05:30",
    })).rejects.toMatchObject({ code: "CHECKPOINT_INVALID" });
    expect(fixture.database.prepare(
      "SELECT active_checkpoint_id FROM agent_streams WHERE stream_id = ?",
    ).get(fixture.prepared.stream.streamId)).toEqual({ active_checkpoint_id: null });
  });

  it("searches and reads exact older messages and run evidence with stable refs", async () => {
    const fixture = await createFixture("history", "Discuss the cobalt migration plan.");
    await recordStep(fixture, [{
      callId: "call-search",
      tool: "search_in_files",
      purpose: "Find cobalt configuration.",
      toolPurpose: "search",
      toolEffect: "read_only",
      status: "success",
      input: { query: "cobalt" },
      output: { matches: ["config/cobalt.json"] },
    }]);
    await finalize(fixture, "The cobalt migration evidence is ready.", "history");

    const search = await fixture.service.searchAgentHistory({
      streamId: fixture.prepared.stream.streamId,
      query: "cobalt",
    });
    expect(search.hits.length).toBeGreaterThan(0);
    expect(search.hits.map((hit) => hit.kind)).toContain("message");
    expect(search.hits.map((hit) => hit.ref)).toContain(
      "run:" + fixture.prepared.run.runId + ":step:1:call:call-search",
    );

    const message = await fixture.service.readAgentHistory({
      streamId: fixture.prepared.stream.streamId,
      ref: "seq:1",
      maxChars: 32_000,
    });
    expect(message.messages).toEqual([
      expect.objectContaining({ sequence: 1, role: "user", content: "Discuss the cobalt migration plan." }),
    ]);
    const evidenceRef = search.hits.find((hit) => hit.kind === "evidence")!.ref;
    const evidence = await fixture.service.readAgentHistory({
      streamId: fixture.prepared.stream.streamId,
      ref: evidenceRef,
      maxChars: 32_000,
    });
    expect(evidence.evidence?.content).toContain("config/cobalt.json");
    expect(evidence.truncated).toBe(false);
  });

  it("projects only successful list/search/read observations and invalidates changed resources", async () => {
    const fixture = await createFixture("observations", "Inspect the project inventory.");
    const project = join(fixture.root, "external", "project");
    await mkdir(project, { recursive: true });
    await writeFile(join(project, "README.md"), "version one\n", "utf8");
    const resourcePath = join(project, "README.md");
    const inspected = await fixture.service.inspectResourceForRun({
      requestId: "REQ-observation-inspect",
      runId: fixture.prepared.run.runId,
      locator: { kind: "filesystem", path: resourcePath },
      kind: "file",
      origin: "user_reference",
      description: "Project directory.",
      aliases: ["project inventory"],
      at: "2026-07-20T10:00:01+05:30",
    });
    await recordStep(fixture, [
      {
        callId: "call-list",
        tool: "list_directory",
        purpose: "List the project inventory.",
        toolPurpose: "list",
        toolEffect: "read_only",
        status: "success",
        input: { resourceId: inspected.resource.resourceId, path: resourcePath },
        output: { resourceId: inspected.resource.resourceId, entries: ["README.md"] },
      },
      {
        callId: "call-failed-read",
        tool: "read_files",
        purpose: "Failed read is not reusable.",
        toolPurpose: "read",
        toolEffect: "read_only",
        status: "failed",
        input: { resourceId: inspected.resource.resourceId },
        error: { message: "failed" },
      },
      {
        callId: "call-control",
        tool: "git_context_inspect_resource",
        purpose: "Control calls are not reusable.",
        toolPurpose: "control",
        toolEffect: "context_mutation",
        status: "success",
        input: {},
        output: {},
      },
    ]);
    let context = await fixture.service.getAgentContext({ streamId: fixture.prepared.stream.streamId });
    expect(context.observations.inventory).toHaveLength(1);
    expect(context.observations.discovery).toEqual([]);
    expect(context.observations.evidence).toEqual([]);
    expect(context.observations.inventory[0]?.resources).toEqual([{
      resourceId: inspected.resource.resourceId,
      versionKey: inspected.resource.version.key,
    }]);

    await writeFile(join(project, "README.md"), "version two with a different size\n", "utf8");
    await fixture.service.inspectResourceForRun({
      requestId: "REQ-observation-refresh",
      runId: fixture.prepared.run.runId,
      locator: { kind: "filesystem", path: resourcePath },
      kind: "file",
      origin: "user_reference",
      at: "2026-07-20T10:00:03+05:30",
    });
    context = await fixture.service.getAgentContext({ streamId: fixture.prepared.stream.streamId });
    expect(context.observations.inventory).toEqual([]);
    expect(await fixture.service.searchAgentHistory({
      streamId: fixture.prepared.stream.streamId,
      query: "project inventory",
      kinds: ["evidence"],
    })).toEqual({ hits: [] });
    expect(fixture.database.prepare(
      "SELECT status, invalidation_reason FROM reusable_observations",
    ).get()).toEqual({ status: "invalidated", invalidation_reason: "resource_version_changed" });
  });
});

async function createFixture(name: string, message: string): Promise<WorkstreamServiceFixture> {
  const fixture = await createWorkstreamServiceFixture(name, message);
  fixtures.push(fixture);
  return fixture;
}

function prepare(requestId: string, content: string, at: string) {
  return {
    requestId,
    timezone: "Asia/Kolkata",
    agentId: "local",
    scopeKey: "default",
    role: "user" as const,
    content,
    at,
  };
}

async function finalize(fixture: WorkstreamServiceFixture, response: string, suffix: string): Promise<void> {
  await fixture.service.finalizeRun({
    requestId: "REQ-" + suffix + "-finalize",
    runId: fixture.prepared.run.runId,
    outcome: "done",
    stopReason: "completed",
    assistantResponse: response,
    streamSummary: suffix + " exchange completed.",
    summary: suffix + " exchange completed.",
    validation: "not_applicable",
    workState: workState({ status: "done", summary: suffix + " exchange completed." }),
    at: "2026-07-20T10:01:00+05:30",
  });
}

async function recordStep(
  fixture: WorkstreamServiceFixture,
  calls: RunStepToolCall[],
): Promise<void> {
  await fixture.service.recordRunStep({
    requestId: fixture.prepared.run.runId + ":step:1",
    runId: fixture.prepared.run.runId,
    record: {
      version: 1,
      step: 1,
      status: calls.some((call) => call.status === "success") ? "completed" : "failed",
      summary: "Recorded observational calls.",
      decision: { kind: "act" },
      action: { calls: calls.map((call) => call.tool) },
      toolCalls: calls,
      verification: { passed: true },
      workStateAfter: workState({ summary: "Recorded observational calls." }),
      createdAt: "2026-07-20T10:00:02+05:30",
    },
  });
}

function checkpointSummary(first: number, last: number): ContextCheckpointSummary {
  return {
    userRequests: [{ seq: first, text: "The user made an exact request." }],
    constraints: [],
    decisions: [],
    corrections: [],
    importantFacts: [{ seq: last, text: "The assistant completed the earlier exchange." }],
    unresolvedQuestions: [],
    references: [],
    narrative: "Earlier exact exchanges were completed and remain available through history.",
  };
}
