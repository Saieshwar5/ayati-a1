import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ContextCheckpointSummary,
  RunStepToolCall,
  StreamMessage,
} from "../src/contracts.js";
import { contextCheckpointSourceHash } from "../src/repositories/context-checkpoint-records.js";
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

describe("current-schema agent-facing context", () => {
  it("includes response semantics and exact attachment links in checkpoint source identity", () => {
    const baseMessage = {
      messageId: "M-1",
      streamId: "S-1",
      runId: "RUN-1",
      sequence: 1,
      content: "Should I continue?",
      contentHash: "sha256:message",
      at: "2026-07-20T10:00:00+05:30",
    };
    const message: StreamMessage = {
      ...baseMessage,
      role: "assistant",
      responseKind: "feedback",
      feedbackKind: "confirmation",
    };

    expect(contextCheckpointSourceHash({ messages: [message] })).not.toBe(
      contextCheckpointSourceHash({
        messages: [{ ...baseMessage, role: "assistant", responseKind: "reply" }],
      }),
    );
    expect(contextCheckpointSourceHash({
      messages: [{
        ...baseMessage,
        role: "user",
        attachmentRefs: [{
          resourceId: "RES-0123456789ABCDEF01234567",
          kind: "document",
          displayName: "source.md",
        }],
      }],
    })).not.toBe(contextCheckpointSourceHash({
      messages: [{ ...baseMessage, role: "user" }],
    }));
  });

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

  it("rolls a previous checkpoint forward when the new exact prefix alone is smaller than the target", async () => {
    const fixture = await createFixture("checkpoint-roll-forward", "first " + "a".repeat(2_000));
    await finalize(fixture, "first answer " + "b".repeat(2_000), "checkpoint-roll-forward-first");
    fixture.prepared = await fixture.service.prepareAgentRun(prepare(
      "REQ-checkpoint-roll-forward-second",
      "follow-up " + "c".repeat(250),
      "2026-07-20T10:02:00+05:30",
    ));

    const firstPlan = await fixture.service.planContextCheckpoint({
      requestId: "REQ-checkpoint-roll-forward-plan-1",
      streamId: fixture.prepared.stream.streamId,
      protectFromSeq: fixture.prepared.message.sequence,
      requiredSavingsTokens: 1,
      estimatedCheckpointTokens: 200,
      at: "2026-07-20T10:02:01+05:30",
    });
    const firstCommit = await fixture.service.commitContextCheckpoint({
      requestId: "REQ-checkpoint-roll-forward-commit-1",
      plan: firstPlan,
      summary: checkpointSummary(1, 2),
      tokenCount: 190,
      provider: "test",
      model: "test",
      at: "2026-07-20T10:02:02+05:30",
    });
    await finalize(
      fixture,
      "follow-up answer " + "d".repeat(250),
      "checkpoint-roll-forward-second",
    );
    fixture.prepared = await fixture.service.prepareAgentRun(prepare(
      "REQ-checkpoint-roll-forward-current",
      "Current exact input.",
      "2026-07-20T10:04:00+05:30",
    ));

    const secondPlan = await fixture.service.planContextCheckpoint({
      requestId: "REQ-checkpoint-roll-forward-plan-2",
      streamId: fixture.prepared.stream.streamId,
      protectFromSeq: fixture.prepared.message.sequence,
      requiredSavingsTokens: 1,
      estimatedCheckpointTokens: 200,
      at: "2026-07-20T10:04:01+05:30",
    });

    expect(firstCommit.checkpoint.tokenCount).toBe(190);
    expect(secondPlan).toMatchObject({
      triggered: true,
      previousCheckpoint: { checkpointId: firstCommit.checkpoint.checkpointId },
      coveredFromSeq: 1,
      coveredToSeq: 4,
    });
    expect(secondPlan.selectedMessages.map((message) => message.sequence)).toEqual([3, 4]);
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

  it("pages exact conversation backward from a stable snapshot", async () => {
    const fixture = await createFixture("conversation-pages", "turn 1");
    await finalize(fixture, "answer 1", "conversation-pages-1");
    for (let turn = 2; turn <= 27; turn++) {
      fixture.prepared = await fixture.service.prepareAgentRun(prepare(
        `REQ-conversation-pages-${turn}`,
        `turn ${turn}`,
        `2026-07-20T11:${String(turn).padStart(2, "0")}:00+05:30`,
      ));
      await finalize(fixture, `answer ${turn}`, `conversation-pages-${turn}`);
    }
    fixture.prepared = await fixture.service.prepareAgentRun({
      ...prepare(
        "REQ-conversation-pages-system",
        "Scheduled reminder fired.",
        "2026-07-20T11:28:00+05:30",
      ),
      role: "system_event",
    });
    await finalize(fixture, "Reminder handled.", "conversation-pages-system");

    const first = await fixture.service.readAgentConversation({
      streamId: fixture.prepared.stream.streamId,
    });
    expect(first.page).toMatchObject({
      snapshotToSeq: 56,
      fromSeq: 7,
      toSeq: 56,
      count: 50,
      hasOlder: true,
    });
    expect(first.messages.map((message) => message.sequence)).toEqual(
      Array.from({ length: 50 }, (_, index) => index + 7),
    );
    expect(first.messages).toContainEqual(expect.objectContaining({
      sequence: 55,
      role: "system_event",
      content: "Scheduled reminder fired.",
    }));

    fixture.prepared = await fixture.service.prepareAgentRun(prepare(
      "REQ-conversation-pages-new",
      "new message after paging began",
      "2026-07-20T11:29:00+05:30",
    ));
    await finalize(fixture, "new answer", "conversation-pages-new");

    const second = await fixture.service.readAgentConversation({
      streamId: fixture.prepared.stream.streamId,
      cursor: first.page.olderCursor!,
    });
    expect(second.page).toEqual({
      snapshotToSeq: 56,
      fromSeq: 1,
      toSeq: 6,
      count: 6,
      hasOlder: false,
    });
    expect(second.messages.map((message) => message.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(new Set([
      ...first.messages.map((message) => message.sequence),
      ...second.messages.map((message) => message.sequence),
    ]).size).toBe(56);
  });

  it("chunks one oversized conversation message and rejects malformed cursors", async () => {
    const content = "large exact message " + "x".repeat(40_000);
    const fixture = await createFixture("conversation-large", content);

    const page = await fixture.service.readAgentConversation({
      streamId: fixture.prepared.stream.streamId,
      maxChars: 1_000,
    });
    expect(page).toMatchObject({
      messages: [expect.objectContaining({ sequence: 1, role: "user" })],
      page: { snapshotToSeq: 1, fromSeq: 1, toSeq: 1, count: 1, hasOlder: false },
      contentTruncated: true,
      continuationRef: expect.stringMatching(/^message:/),
      continuationOffsetChars: 1_000,
    });
    expect(page.messages[0]?.content).toHaveLength(1_000);
    await expect(fixture.service.readAgentConversation({
      streamId: fixture.prepared.stream.streamId,
      cursor: "conversation:v1:999:10",
    })).rejects.toMatchObject({ code: "HISTORY_CURSOR_INVALID" });
    await expect(fixture.service.readAgentConversation({
      streamId: fixture.prepared.stream.streamId,
      cursor: "",
    })).rejects.toMatchObject({ code: "HISTORY_CURSOR_INVALID" });
  });

  it("binds conversation cursors to their originating stream", async () => {
    const first = await createFixture("conversation-cursor-first", "first stream");
    await finalize(first, "first answer", "conversation-cursor-first");
    const page = await first.service.readAgentConversation({
      streamId: first.prepared.stream.streamId,
      limit: 1,
    });
    const second = await first.service.prepareAgentRun({
      ...prepare(
        "REQ-conversation-cursor-second",
        "second stream",
        "2026-07-20T12:00:00+05:30",
      ),
      scopeKey: "other",
    });

    await expect(first.service.readAgentConversation({
      streamId: second.stream.streamId,
      cursor: page.page.olderCursor!,
    })).rejects.toMatchObject({ code: "HISTORY_CURSOR_INVALID" });
  });

  it("refuses conversation content that no longer matches its stored hash", async () => {
    const fixture = await createFixture("conversation-integrity", "original message");
    fixture.database.exec("DROP TRIGGER messages_immutable_update");
    fixture.database.prepare([
      "UPDATE messages SET content = ? WHERE stream_id = ? AND sequence = 1",
    ].join(" ")).run("tampered message", fixture.prepared.stream.streamId);

    await expect(fixture.service.readAgentConversation({
      streamId: fixture.prepared.stream.streamId,
    })).rejects.toMatchObject({ code: "HISTORY_INTEGRITY_FAILED" });
  });

  it("keeps verified reads in run history without materializing a reusable context lane", async () => {
    const fixture = await createFixture("run-evidence", "Inspect the project inventory.");
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
        purpose: "Failed read is not historical evidence.",
        toolPurpose: "read",
        toolEffect: "read_only",
        status: "failed",
        input: { resourceId: inspected.resource.resourceId },
        error: { message: "failed" },
      },
      {
        callId: "call-control",
        tool: "git_context_inspect_resource",
        purpose: "Control calls are not historical evidence.",
        toolPurpose: "control",
        toolEffect: "context_mutation",
        status: "success",
        input: {},
        output: {},
      },
      {
        callId: "call-database-read",
        tool: "db_query",
        purpose: "Read the current queue depth.",
        toolPurpose: "read",
        toolEffect: "read_only",
        status: "success",
        input: { sql: "SELECT COUNT(*) AS count FROM jobs" },
        output: { rows: [{ count: 4 }] },
      },
      {
        callId: "call-history-search",
        tool: "agent_history_search",
        purpose: "Find the earlier queue discussion.",
        toolPurpose: "search",
        toolEffect: "read_only",
        status: "success",
        input: { query: "queue depth" },
        output: { hits: ["seq:12"] },
      },
    ]);
    const context = await fixture.service.getAgentContext({
      streamId: fixture.prepared.stream.streamId,
    });
    expect("observations" in context).toBe(false);
    expect(fixture.database.prepare([
      "SELECT COUNT(*) AS count FROM sqlite_schema",
      "WHERE type = 'table' AND name = 'reusable_observations'",
    ].join(" ")).get())
      .toEqual({ count: 0 });
    await fixture.service.recordRunStep({
      requestId: fixture.prepared.run.runId + ":step:2",
      runId: fixture.prepared.run.runId,
      record: {
        version: 1,
        step: 2,
        status: "failed",
        summary: "A successful transport result failed deterministic verification.",
        decision: { kind: "act" },
        action: { calls: ["db_get_table_ddl"] },
        toolCalls: [{
          callId: "call-unverified-read",
          tool: "db_get_table_ddl",
          purpose: "Read a table definition.",
          toolPurpose: "read",
          toolEffect: "read_only",
          status: "success",
          input: { table: "jobs" },
          output: { ddl: "CREATE TABLE jobs (...)" },
        }],
        verification: { passed: false },
        createdAt: "2026-07-20T10:00:02.500+05:30",
      },
    });
    await writeFile(join(project, "README.md"), "version two with a different size\n", "utf8");
    await fixture.service.inspectResourceForRun({
      requestId: "REQ-observation-refresh",
      runId: fixture.prepared.run.runId,
      locator: { kind: "filesystem", path: resourcePath },
      kind: "file",
      origin: "user_reference",
      at: "2026-07-20T10:00:03+05:30",
    });
    const history = await fixture.service.searchAgentHistory({
      streamId: fixture.prepared.stream.streamId,
      query: "project inventory",
      kinds: ["evidence"],
    });
    expect(history.hits).toEqual([
      expect.objectContaining({
        ref: `run:${fixture.prepared.run.runId}:step:1:call:call-list`,
        kind: "evidence",
      }),
    ]);
    expect(fixture.database.prepare([
      "SELECT COUNT(*) AS count FROM sqlite_schema",
      "WHERE type = 'table' AND name = 'reusable_observations'",
    ].join(" ")).get())
      .toEqual({ count: 0 });
  });

  it("searches exact read-only run evidence across runs without a reusable projection", async () => {
    const fixture = await createFixture("run-evidence-search", "Find the current queue.");
    await recordStep(fixture, [{
      callId: "call-queue",
      tool: "agent_history_search",
      purpose: "Find the current queue.",
      toolPurpose: "search",
      toolEffect: "read_only",
      status: "success",
      input: { query: "current queue" },
      output: { hits: ["seq:1"] },
    }]);
    const oldestRunId = fixture.prepared.run.runId;
    await finalize(fixture, "The queue was found.", "run-evidence-search-first");

    fixture.prepared = await fixture.service.prepareAgentRun(prepare(
      "REQ-run-evidence-search-second",
      "Find the current queue again.",
      "2026-07-20T10:02:00+05:30",
    ));
    const newestRunId = fixture.prepared.run.runId;
    await recordStep(fixture, [{
      callId: "call-queue",
      tool: "agent_history_search",
      purpose: "Find the current queue.",
      toolPurpose: "search",
      toolEffect: "read_only",
      status: "success",
      input: { query: "current queue" },
      output: { hits: ["seq:3"] },
    }], "2026-07-20T10:02:01+05:30");

    const history = await fixture.service.searchAgentHistory({
      streamId: fixture.prepared.stream.streamId,
      query: "current queue",
      kinds: ["evidence"],
    });
    expect(history.hits).toEqual([
      expect.objectContaining({
        ref: `run:${newestRunId}:step:1:call:call-queue`,
        preview: expect.stringContaining("seq:3"),
      }),
      expect.objectContaining({
        ref: `run:${oldestRunId}:step:1:call:call-queue`,
        preview: expect.stringContaining("seq:1"),
      }),
    ]);
    expect(fixture.database.prepare([
      "SELECT COUNT(*) AS count FROM sqlite_schema",
      "WHERE type = 'table' AND name = 'reusable_observations'",
    ].join(" ")).get())
      .toEqual({ count: 0 });
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
  createdAt = "2026-07-20T10:00:02+05:30",
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
      createdAt,
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
