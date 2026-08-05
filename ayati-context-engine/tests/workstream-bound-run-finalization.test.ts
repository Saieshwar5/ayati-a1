import { execFile } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type {
  FinalizeRunRequest,
  SelectedWorkstreamForRunResponse,
  WorkstreamCompletionRecord,
} from "../src/contracts.js";
import { ContextDatabase } from "../src/database/database.js";
import { RUN_FINALIZATION_LIMITS } from "../src/run-finalization-limits.js";
import { SqliteContextEngineService } from "../src/services/sqlite-context-engine-service.js";
import { parseWorkstreamCommit } from "../src/workstreams/workstream-commit-metadata.js";
import { validateWorkstreamRepository } from "../src/workstreams/workstream-repository-validator.js";
import {
  boundRequestAcceptance,
  createBoundWorkstream,
  createBoundWorkstreamWithMutableDirectory,
  createWorkstreamServiceFixture,
  workState,
  type WorkstreamServiceFixture,
} from "./simple-workstream-repository-fixtures.js";

const execFileAsync = promisify(execFile);
const fixtures: WorkstreamServiceFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (fixture) => await fixture.dispose()));
});

describe("workstream-bound run finalization", () => {
  it("binds the existing run idempotently and never permits another workstream owner", async () => {
    const fixture = await createFixture("binding");
    const input = createInput(fixture, "REQ-create-binding");

    const selected = await fixture.service.createWorkstreamForRun(input);
    const replayed = await fixture.service.createWorkstreamForRun(input);

    expect(replayed).toEqual(selected);
    expect(selected).toMatchObject({
      run: {
        runId: fixture.prepared.run.runId,
        workstreamBinding: {
          workstreamId: selected.workstream.workstreamId,
          requestId: "R-0001",
        },
      },
      workstreamCreated: true,
      workstreamRequestDecision: "initial",
      workstreamRequestCreated: true,
      workstreamRequestStatus: "active",
      headBeforeSelection: selected.workstream.head,
    });
    expect(fixture.database.prepare([
      "SELECT workstream_id, bound_request_id FROM runs WHERE run_id = ?",
    ].join(" ")).get(fixture.prepared.run.runId)).toEqual({
      workstream_id: selected.workstream.workstreamId,
      bound_request_id: "R-0001",
    });
    expect(fixture.database.prepare([
      "SELECT focused_workstream_id, focused_request_id FROM agent_streams WHERE stream_id = ?",
    ].join(" ")).get(fixture.prepared.stream.streamId)).toEqual({
      focused_workstream_id: selected.workstream.workstreamId,
      focused_request_id: "R-0001",
    });
    const focusedContext = await fixture.service.getAgentContext({
      streamId: fixture.prepared.stream.streamId,
    });
    expect(focusedContext.stream?.focusedWorkstream).toMatchObject({
      workstream: { workstreamId: selected.workstream.workstreamId },
      selectedRequest: { id: "R-0001", status: "active" },
    });
    await expect(fixture.service.createWorkstreamForRun({
      ...input,
      requestId: "REQ-attempt-rebind",
      title: "Another workstream",
      objective: "This must not take ownership of the current run.",
    })).rejects.toMatchObject({ code: "RUN_WORKSTREAM_BINDING_IMMUTABLE" });
    expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM workstreams").get())
      .toEqual({ count: 1 });
  });

  it("discards an empty initializing workstream while preserving the finalized run", async () => {
    const fixture = await createFixture("discard-empty");
    const selected = await createBoundWorkstream(fixture, {
      title: "Empty Workstream",
      objective: "Do not retain a workstream when the run produces no resource.",
      resources: [],
    });
    await fixture.service.recordRunStep({
      requestId: fixture.prepared.run.runId + ":step:1",
      runId: fixture.prepared.run.runId,
      record: {
        version: 1,
        step: 1,
        status: "completed",
        summary: "Inspected the workspace without producing a resource.",
        toolCalls: [{
          callId: "call-read",
          tool: "find_files",
          purpose: "Inspect the workspace before deciding whether durable work exists.",
          toolPurpose: "search",
          toolEffect: "read_only",
          status: "success",
          input: { pattern: "*" },
          output: { files: [] },
        }],
        verification: { passed: true, resources: [] },
        createdAt: "2026-07-19T10:02:00+05:30",
      },
    });
    const input = failedFinalization(fixture);
    const repositoryHeadBefore = fixture.database.prepare(
      "SELECT head_sha FROM workstream_repository_state WHERE singleton_id = 1",
    ).get();

    const result = await fixture.service.finalizeRun(input);
    const replayed = await fixture.service.finalizeRun(input);

    expect(replayed).toEqual(result);
    expect(result).toMatchObject({
      run: { runId: fixture.prepared.run.runId, status: "failed", stopReason: "failed" },
      workstreamContextCommit: { status: "not_required" },
    });
    expect(result.run.workstreamBinding).toBeUndefined();
    expect(fixture.database.prepare(
      "SELECT workstream_id FROM workstreams WHERE workstream_id = ?",
    ).get(selected.workstream.workstreamId)).toBeUndefined();
    expect(fixture.database.prepare(
      "SELECT COUNT(*) AS count FROM workstream_requests WHERE workstream_id = ?",
    ).get(selected.workstream.workstreamId)).toEqual({ count: 0 });
    expect(fixture.database.prepare(
      "SELECT COUNT(*) AS count FROM workstream_request_route_plans WHERE run_id = ?",
    ).get(fixture.prepared.run.runId)).toEqual({ count: 0 });
    expect(fixture.database.prepare(
      "SELECT COUNT(*) AS count FROM run_steps WHERE run_id = ?",
    ).get(fixture.prepared.run.runId)).toEqual({ count: 1 });
    expect(fixture.database.prepare([
      "SELECT role FROM messages WHERE run_id = ? ORDER BY sequence",
    ].join(" ")).all(fixture.prepared.run.runId)).toEqual([
      { role: "user" },
      { role: "assistant" },
    ]);
    expect(fixture.database.prepare(
      "SELECT phase FROM unbound_run_finalizations WHERE run_id = ?",
    ).get(fixture.prepared.run.runId)).toEqual({ phase: "completed" });
    expect(fixture.database.prepare(
      "SELECT head_sha FROM workstream_repository_state WHERE singleton_id = 1",
    ).get()).toEqual(repositoryHeadBefore);
    await expect(access(selected.workstream.contextRepositoryPath)).rejects.toThrow();
    expect(fixture.database.prepare([
      "SELECT focused_workstream_id, focused_request_id FROM agent_streams WHERE stream_id = ?",
    ].join(" ")).get(fixture.prepared.stream.streamId)).toEqual({
      focused_workstream_id: null,
      focused_request_id: null,
    });
  });

  it("discards an interrupted empty workstream during startup recovery", async () => {
    const fixture = await createFixture("discard-interrupted-empty");
    const selected = await createBoundWorkstream(fixture, {
      title: "Interrupted Empty Workstream",
      objective: "Remove provisional context when an interrupted run produced no resource.",
      resources: [],
    });
    const runId = fixture.prepared.run.runId;
    const streamId = fixture.prepared.stream.streamId;
    const databasePath = fixture.database.path;
    await fixture.service.close();
    const database = await ContextDatabase.open({ path: databasePath });
    const restarted = new SqliteContextEngineService({
      database,
      rootDirectory: fixture.root,
      now: () => "2026-07-19T10:10:00+05:30",
    });
    try {
      const context = await restarted.getAgentContext({ streamId });

      expect(context.run).toBeUndefined();
      expect(context.stream?.focusedWorkstream).toBeUndefined();
      expect(database.prepare([
        "SELECT status, stop_reason, workstream_id, bound_request_id FROM runs WHERE run_id = ?",
      ].join(" ")).get(runId)).toEqual({
        status: "incomplete",
        stop_reason: "interrupted",
        workstream_id: null,
        bound_request_id: null,
      });
      expect(database.prepare(
        "SELECT workstream_id FROM workstreams WHERE workstream_id = ?",
      ).get(selected.workstream.workstreamId)).toBeUndefined();
      await expect(access(selected.workstream.contextRepositoryPath)).rejects.toThrow();
    } finally {
      await restarted.close();
    }
  });

  it("swaps stream focus after another workstream binds without closing the prior request", async () => {
    const fixture = await createFixture("focus-swap");
    const first = await createBoundWorkstreamWithMutableDirectory(fixture, {
      title: "First Focus",
      objective: "Remain unfinished when another owner becomes focused.",
    });
    await fixture.service.finalizeRun(incompleteFinalization(fixture));
    fixture.prepared = await fixture.service.prepareAgentRun({
      requestId: "REQ-focus-swap",
      timezone: "Asia/Kolkata",
      agentId: "local",
      role: "user",
      content: "Start a separate durable workstream.",
      at: "2026-07-19T10:04:00+05:30",
    });
    const second = await createBoundWorkstream(fixture, {
      title: "Second Focus",
      objective: "Become the current focused owner.",
    });

    expect(fixture.database.prepare([
      "SELECT focused_workstream_id, focused_request_id FROM agent_streams WHERE stream_id = ?",
    ].join(" ")).get(fixture.prepared.stream.streamId)).toEqual({
      focused_workstream_id: second.workstream.workstreamId,
      focused_request_id: "R-0001",
    });
    expect(fixture.database.prepare([
      "SELECT status FROM workstream_requests WHERE workstream_id = ? AND request_id = 'R-0001'",
    ].join(" ")).get(first.workstream.workstreamId)).toEqual({ status: "active" });
  });

  it("rehydrates unfinished focus after a full service restart", async () => {
    const fixture = await createFixture("focus-restart");
    const selected = await createBoundWorkstreamWithMutableDirectory(fixture, {
      title: "Restart Focus",
      objective: "Remain visible after the daemon restarts.",
    });
    await fixture.service.finalizeRun(incompleteFinalization(fixture));
    const streamId = fixture.prepared.stream.streamId;
    const databasePath = fixture.database.path;
    await fixture.service.close();
    const database = await ContextDatabase.open({ path: databasePath });
    const restarted = new SqliteContextEngineService({
      database,
      rootDirectory: fixture.root,
      now: () => "2026-07-19T10:10:00+05:30",
    });

    const context = await restarted.getAgentContext({ streamId });

    expect(context.stream?.focusedWorkstream).toMatchObject({
      workstream: { workstreamId: selected.workstream.workstreamId },
      selectedRequest: { id: "R-0001", status: "active" },
    });
    await restarted.close();
  });

  it("keeps one canonical primary binding when completion reuses its directory as a deliverable", async () => {
    const fixture = await createFixture("canonical-primary-resource");
    const selected = await createBoundWorkstreamWithMutableDirectory(fixture, {
      title: "Canonical Website",
      objective: "Keep one stable resource identity across requests and completion.",
    });
    const primary = selected.resourceBindings.find((binding) => binding.primary);
    if (!primary || primary.resource.locator.kind !== "filesystem") {
      throw new Error("Expected a filesystem primary resource.");
    }

    await fixture.service.finalizeRun(doneFinalization(fixture, [{
      locator: primary.resource.locator,
      kind: "directory",
      role: "deliverable",
      description: "Verified website output directory.",
      aliases: ["website output"],
      verified: true,
    }]));

    expect(fixture.database.prepare([
      "SELECT resource_id, role, access, is_primary FROM workstream_resources",
      "WHERE workstream_id = ?",
    ].join(" ")).all(selected.workstream.workstreamId)).toEqual([{
      resource_id: primary.resource.resourceId,
      role: "primary",
      access: "mutate",
      is_primary: 1,
    }]);
    expect(fixture.database.prepare([
      "SELECT role FROM request_resources",
      "WHERE workstream_id = ? AND request_id = 'R-0001' AND resource_id = ? ORDER BY role",
    ].join(" ")).all(selected.workstream.workstreamId, primary.resource.resourceId)).toEqual([
      { role: "deliverable" },
      { role: "primary" },
    ]);
    const validation = await validateWorkstreamRepository({
      workstreamRoot: join(fixture.root, "workstreams"),
      contextRepositoryPath: selected.workstream.contextRepositoryPath,
      expectedWorkstreamId: selected.workstream.workstreamId,
    });
    expect(validation.resourceManifest.resources).toHaveLength(1);
    expect(validation.resourceManifest.resources[0]).toMatchObject({
      resourceId: primary.resource.resourceId,
      role: "primary",
      access: "mutate",
      primary: true,
      requestIds: ["R-0001"],
    });
    expect((await fixture.service.findResources({
      resourceIds: [primary.resource.resourceId],
    })).resources).toEqual([
      expect.objectContaining({
        workstreamIds: [selected.workstream.workstreamId],
        roles: ["primary"],
      }),
    ]);
  });

  it("finalizes needs-user-input at the declared durable text boundary", async () => {
    const fixture = await createFixture("needs-user-input-boundary");
    const selected = await createBoundWorkstreamWithMutableDirectory(fixture, {
      title: "Clarification Boundary",
      objective: "Preserve the full reply while durably recording a bounded clarification.",
    });
    const prefix = "Which durable output resource should Ayati use? ";
    const question = prefix + "x".repeat(
      RUN_FINALIZATION_LIMITS.workState.nextActionChars - prefix.length,
    );
    const assistantResponse = question
      + " The complete user-facing reply may contain additional explanation.";

    const result = await fixture.service.finalizeRun(
      needsUserInputFinalization(fixture, question, assistantResponse),
    );

    expect(question).toHaveLength(RUN_FINALIZATION_LIMITS.workState.nextActionChars);
    expect(result).toMatchObject({
      run: { status: "needs_user_input", stopReason: "needs_user_input" },
      workstreamContextCommit: { status: "committed" },
    });
    expect((fixture.database.prepare([
      "SELECT content FROM messages",
      "WHERE run_id = ? AND role = 'assistant'",
    ].join(" ")).get(fixture.prepared.run.runId) as { content: string } | undefined)
      ?.content).toBe(assistantResponse);
    const validation = await validateWorkstreamRepository({
      workstreamRoot: join(fixture.root, "workstreams"),
      contextRepositoryPath: selected.workstream.contextRepositoryPath,
      expectedWorkstreamId: selected.workstream.workstreamId,
    });
    expect(validation).toMatchObject({
      health: "ready",
      workstreamCard: {
        currentRequest: null,
        currentFocus: "Resolve the blocker for R-0001: Clarification Boundary.",
        blockers: [
          "Request R-0001: The user must select or provide the durable output resource.",
        ],
      },
      requests: [{ id: "R-0001", status: "blocked" }],
      progress: {
        entries: [{
          runId: fixture.prepared.run.runId,
          requestId: "R-0001",
          outcome: "needs_user_input",
          next: question,
        }],
      },
    });
    const blockedContext = await fixture.service.getAgentContext({
      streamId: fixture.prepared.stream.streamId,
    });
    expect(blockedContext.stream?.focusedWorkstream).toMatchObject({
      workstream: { workstreamId: selected.workstream.workstreamId },
      selectedRequest: { id: "R-0001", status: "blocked" },
    });
  });

  it("records verified real-file mutation but commits only context files exactly once", async () => {
    const fixture = await createFixture("verified-mutation");
    const selected = await createBoundWorkstreamWithMutableDirectory(fixture, {
      title: "Verified Website",
      objective: "Create a verified website file in the real output resource.",
    });
    const primary = requireFilesystemPrimary(selected);
    const outputPath = join(primary.path, "index.html");
    const binding = selected.run.workstreamBinding;
    if (!binding) throw new Error("Expected workstream binding.");
    const prepared = await fixture.service.prepareResourceMutation({
      requestId: fixture.prepared.run.runId + ":call-write:prepare",
      runId: fixture.prepared.run.runId,
      workstreamId: binding.workstreamId,
      activeRequestId: binding.requestId,
      callId: "call-write",
      tool: "write_files",
      effect: "workspace_mutation",
      targets: [{
        resourceId: primary.resourceId,
        relativePath: "index.html",
        kind: "file",
        expectedVersionKey: primary.versionKey,
      }],
      at: "2026-07-19T10:02:00+05:30",
    });
    await writeFile(outputPath, "<!doctype html><title>Verified</title>\n", "utf8");
    const verified = await fixture.service.verifyResourceMutation({
      requestId: fixture.prepared.run.runId + ":call-write:verify",
      operationId: prepared.operationId,
      leaseId: prepared.leaseId,
      lockToken: prepared.lockToken,
      toolStatus: "completed",
      at: "2026-07-19T10:03:00+05:30",
    });
    expect(verified).toMatchObject({
      status: "verified",
      verified: true,
      events: [{ resourceId: primary.resourceId, type: "modified" }],
    });
    await fixture.service.recordRunStep({
      requestId: fixture.prepared.run.runId + ":step:1",
      runId: fixture.prepared.run.runId,
      record: {
        version: 1,
        step: 1,
        status: "completed",
        summary: "Created and verified the website entry point.",
        toolCalls: [{
          callId: "call-write",
          tool: "write_files",
          purpose: "Create the website entry point in its real output directory.",
          toolPurpose: "mutation",
          toolEffect: "workspace_mutation",
          status: "success",
          input: { files: [{ path: outputPath }] },
          output: { written: [outputPath] },
        }],
        verification: { passed: true, resources: [primary.resourceId] },
        createdAt: "2026-07-19T10:03:01+05:30",
      },
    });
    const contextAfterMutation = await fixture.service.getAgentContext({
      streamId: fixture.prepared.stream.streamId,
    });
    expect("observations" in contextAfterMutation).toBe(false);
    const input = doneFinalization(fixture, [{
      locator: { kind: "filesystem", path: outputPath },
      kind: "file",
      role: "deliverable",
      description: "Verified website entry point.",
      aliases: ["homepage", "website output"],
      verified: true,
    }]);

    const result = await fixture.service.finalizeRun(input);
    const replayed = await fixture.service.finalizeRun(input);

    expect(replayed).toEqual(result);
    expect(result).toMatchObject({
      resourceEffects: {
        status: "verified",
        events: expect.arrayContaining([expect.objectContaining({
          resourceId: primary.resourceId,
          type: "modified",
        })]),
      },
      workstreamContextCommit: { status: "committed" },
    });
    expect(await git(selected.workstream.contextRepositoryPath, ["rev-list", "--count", "HEAD"]))
      .toBe("2");
    expect((await git(selected.workstream.contextRepositoryPath, ["ls-files"])).split("\n"))
      .toEqual([
        "progress.md",
        "requests/R-0001-verified-website.md",
        "resources.json",
        "workstream.md",
      ]);
    expect(await git(selected.workstream.contextRepositoryPath, [
      "status", "--porcelain", "--untracked-files=all",
    ])).toBe("");
    const metadata = parseWorkstreamCommit(await git(
      selected.workstream.contextRepositoryPath,
      ["show", "-s", "--format=%B", "HEAD"],
    ));
    expect(metadata).toMatchObject({
      workstreamId: selected.workstream.workstreamId,
      requestId: "R-0001",
      runId: fixture.prepared.run.runId,
      streamId: fixture.prepared.stream.streamId,
      outcome: "completed",
      validation: "passed",
      requestStatusAfter: "done",
      stopReason: "completed",
      resourceEffects: {
        created: 0,
        modified: 1,
        moved: 0,
        deleted: 0,
        restored: 0,
        downloaded: 0,
        external_state_changed: 0,
      },
      mutationDetails: [{
        type: "modified",
        resourceId: primary.resourceId,
      }],
      summary: "The requested work is complete.",
      schema: "workstream-commit/v1",
    });
    expect(result.workstreamContextCommit.status === "committed"
      ? result.workstreamContextCommit.commit
      : undefined).toBe(metadata ? await git(selected.workstream.contextRepositoryPath, ["rev-parse", "HEAD"]) : "");
  });

  it("keeps focus without updating workstream context for an unbound read-only run", async () => {
    const fixture = await createFixture("unbound-read-only-focus");
    const created = await createBoundWorkstreamWithMutableDirectory(fixture, {
      title: "Read-only Focus",
      objective: "Keep unfinished durable focus through an informational turn.",
    });
    await fixture.service.finalizeRun(incompleteFinalization(fixture));
    const headBefore = await git(created.workstream.contextRepositoryPath, ["rev-parse", "HEAD"]);
    fixture.prepared = await fixture.service.prepareAgentRun({
      requestId: "REQ-unbound-read-only",
      timezone: "Asia/Kolkata",
      agentId: "local",
      role: "user",
      content: "What does the current plan mean? Do not change it.",
      at: "2026-07-19T10:04:00+05:30",
    });

    expect(fixture.prepared.context.stream?.focusedWorkstream).toMatchObject({
      workstream: { workstreamId: created.workstream.workstreamId },
      selectedRequest: { id: "R-0001", status: "active" },
    });
    const finalized = await fixture.service.finalizeRun({
      requestId: fixture.prepared.run.runId + ":finalize",
      runId: fixture.prepared.run.runId,
      outcome: "done",
      stopReason: "completed",
      assistantResponse: "The plan remains unchanged.",
      streamSummary: "Answered an informational question without durable task work.",
      summary: "Answered without changing the focused workstream.",
      validation: "not_applicable",
      workState: workState({
        status: "done",
        summary: "Answered without changing the focused workstream.",
      }),
      at: "2026-07-19T10:05:00+05:30",
    });
    const context = await fixture.service.getAgentContext({
      streamId: fixture.prepared.stream.streamId,
    });

    expect(finalized.workstreamContextCommit).toEqual({ status: "not_required" });
    expect(await git(created.workstream.contextRepositoryPath, ["rev-parse", "HEAD"]))
      .toBe(headBefore);
    expect(context.stream?.focusedWorkstream).toMatchObject({
      workstream: { workstreamId: created.workstream.workstreamId },
      selectedRequest: { id: "R-0001", status: "active" },
    });
  });

  it("records a later failed read-only continuation in one progress-only commit", async () => {
    const fixture = await createFixture("read-only-failure");
    const created = await createBoundWorkstreamWithMutableDirectory(fixture, {
      title: "Read-only Continuation",
      objective: "Keep one request active across runs.",
    });
    const first = await fixture.service.finalizeRun(incompleteFinalization(fixture));
    if (first.workstreamContextCommit.status !== "committed") {
      throw new Error("Expected initial context update.");
    }
    const firstRunId = fixture.prepared.run.runId;
    fixture.prepared = await fixture.service.prepareAgentRun({
      requestId: "REQ-read-only-next",
      timezone: "Asia/Kolkata",
      agentId: "local",
      role: "user",
      content: "Inspect the prior context, but the read fails.",
      at: "2026-07-19T10:04:00+05:30",
    });
    await fixture.service.recordRunStep({
      requestId: fixture.prepared.run.runId + ":step:1",
      runId: fixture.prepared.run.runId,
      record: readStep(),
    });
    await fixture.service.activateWorkstreamForRun({
      requestId: "REQ-activate-read-only",
      runId: fixture.prepared.run.runId,
      workstreamId: created.workstream.workstreamId,
      expectedWorkstreamHead: first.workstreamContextCommit.headAfter,
      route: {
        kind: "continue_current",
        requestId: "R-0001",
        reason: "The same unfinished request is being inspected.",
      },
      at: "2026-07-19T10:05:00+05:30",
    });
    const headBefore = await git(created.workstream.contextRepositoryPath, ["rev-parse", "HEAD"]);
    const requestBefore = await git(created.workstream.contextRepositoryPath, [
      "show",
      headBefore + ":" + workstreamPath(created, "requests/R-0001-read-only-continuation.md"),
    ]);
    const input = failedFinalization(fixture);

    const result = await fixture.service.finalizeRun(input);
    const replayed = await fixture.service.finalizeRun(input);
    const context = await fixture.service.getAgentContext({
      streamId: fixture.prepared.stream.streamId,
    });

    expect(replayed).toEqual(result);
    expect(result).toMatchObject({
      run: { status: "failed", stopReason: "failed" },
      workstreamContextCommit: {
        status: "committed",
        headBefore,
        requestId: "R-0001",
      },
    });
    expect(await git(created.workstream.contextRepositoryPath, ["rev-parse", "HEAD"]))
      .not.toBe(headBefore);
    expect((await git(created.workstream.contextRepositoryPath, [
      "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD",
    ])).split("\n")).toEqual([workstreamPath(created, "progress.md")]);
    expect(await git(created.workstream.contextRepositoryPath, [
      "show", "HEAD:" + workstreamPath(created, "requests/R-0001-read-only-continuation.md"),
    ])).toBe(requestBefore);
    expect(await git(created.workstream.contextRepositoryPath, ["rev-list", "--count", "HEAD"]))
      .toBe("3");
    expect(context.stream?.focusedWorkstream).toMatchObject({
      workstream: { workstreamId: created.workstream.workstreamId },
      selectedRequest: { id: "R-0001", status: "active" },
    });
    const validation = await validateWorkstreamRepository({
      workstreamRoot: join(fixture.root, "workstreams"),
      contextRepositoryPath: created.workstream.contextRepositoryPath,
      expectedWorkstreamId: created.workstream.workstreamId,
      requestReadMode: "all",
    });
    expect(validation.currentRequest).toMatchObject({ id: "R-0001", status: "active" });
    expect(validation.progress.entries).toHaveLength(2);
    expect(validation.progress.entries[1]).toMatchObject({
      runId: fixture.prepared.run.runId,
      requestId: "R-0001",
      outcome: "failed",
      summary: "The read-only attempt failed.",
    });
    expect(firstRunId).not.toBe(fixture.prepared.run.runId);
    expect("observations" in context).toBe(false);
  });

  it("finalizes a failed bound run from authoritative state when completion projection is missing", async () => {
    const fixture = await createFixture("failed-bound-fallback");
    const created = await createBoundWorkstreamWithMutableDirectory(fixture, {
      title: "Provider Failure Recovery",
      objective: "Keep unfinished work resumable after a decision-provider failure.",
    });
    await fixture.service.checkpointRunWorkState({
      requestId: "REQ-provider-failure-checkpoint",
      runId: fixture.prepared.run.runId,
      expectedRevision: 0,
      afterStep: 0,
      reason: "plan",
      workState: workState({
        summary: "The project is bound and implementation remains.",
        plan: [
          { id: "inspect", task: "Inspect the existing project.", status: "done" },
          { id: "implement", task: "Implement the requested change.", status: "active" },
        ],
        importantContext: [{
          kind: "finding",
          value: "The existing project owns this request.",
        }],
        nextAction: "Implement the requested change.",
      }),
      at: "2026-07-19T10:02:00+05:30",
    });
    const input = failedFinalization(fixture);
    delete input.workstream;
    input.summary = "The decision provider timed out.";
    input.workState = workState({
      status: "blocked",
      summary: "The decision provider timed out.",
      importantContext: [{ kind: "constraint", value: "Provider timeout" }],
      nextAction: "Retry from the latest verified state.",
    });

    const result = await fixture.service.finalizeRun(input);
    const context = await fixture.service.getAgentContext({
      streamId: fixture.prepared.stream.streamId,
    });
    const persisted = fixture.database.prepare([
      "SELECT status, summary, plan_json, important_context_json, next_action, update_reason",
      "FROM run_work_state WHERE run_id = ?",
    ].join(" ")).get(fixture.prepared.run.runId) as {
      status: string;
      summary: string;
      plan_json: string;
      important_context_json: string;
      next_action: string | null;
      update_reason: string;
    };

    expect(result).toMatchObject({
      run: { status: "failed", stopReason: "failed" },
      workstreamContextCommit: {
        status: "committed",
        workstreamId: created.workstream.workstreamId,
        requestId: "R-0001",
      },
    });
    expect(persisted).toMatchObject({
      status: "in_progress",
      summary: "The decision provider timed out.",
      next_action: "Retry from the latest verified state.",
      update_reason: "run_paused",
    });
    expect(JSON.parse(persisted.plan_json)).toEqual([
      { id: "inspect", task: "Inspect the existing project.", status: "done" },
      { id: "implement", task: "Implement the requested change.", status: "pending" },
    ]);
    expect(JSON.parse(persisted.important_context_json)).toEqual([
      { kind: "finding", value: "The existing project owns this request." },
      { kind: "constraint", value: "Provider timeout" },
    ]);
    expect(context.stream?.focusedWorkstream).toMatchObject({
      workstream: { workstreamId: created.workstream.workstreamId },
      selectedRequest: { id: "R-0001", status: "active" },
    });
  });

  it("still rejects successful bound finalization without completion evidence", async () => {
    const fixture = await createFixture("done-without-completion");
    await createBoundWorkstreamWithMutableDirectory(fixture);
    const input = doneFinalization(fixture, []);
    delete input.workstream;

    await expect(fixture.service.finalizeRun(input)).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      message: "Workstream-bound finalization requires workstream completion evidence.",
    });
    expect(fixture.database.prepare(
      "SELECT status, stop_reason FROM runs WHERE run_id = ?",
    ).get(fixture.prepared.run.runId)).toEqual({ status: "running", stop_reason: null });
  });

  it("restores a material WorkState when the next run continues the same request", async () => {
    const fixture = await createFixture("work-state-continuation");
    const created = await createBoundWorkstreamWithMutableDirectory(fixture, {
      title: "Long-running implementation",
      objective: "Continue one complex implementation across run boundaries.",
    });
    const handoff = workState({
      summary: "The data contract is implemented; runtime wiring and tests remain.",
      plan: [
        { id: "contract", task: "Implement the data contract.", status: "done" },
        { id: "runtime", task: "Wire the runtime checkpoint.", status: "active" },
        { id: "tests", task: "Add continuation coverage.", status: "pending" },
      ],
      importantContext: [{
        kind: "artifact",
        value: "WorkState contract",
        ref: "/workspace/src/work-state/contracts.ts",
      }],
      nextAction: "Wire the runtime checkpoint.",
    });
    await fixture.service.checkpointRunWorkState({
      requestId: "REQ-checkpoint-material-handoff",
      runId: fixture.prepared.run.runId,
      expectedRevision: 0,
      afterStep: 0,
      reason: "plan",
      workState: handoff,
      at: "2026-07-19T10:02:00+05:30",
    });
    const finalization = incompleteFinalization(fixture);
    finalization.workState = handoff;
    finalization.summary = handoff.summary;
    finalization.next = "Wire the runtime checkpoint.";
    const first = await fixture.service.finalizeRun(finalization);
    if (first.workstreamContextCommit.status === "not_required") {
      throw new Error("Expected the incomplete run to commit its workstream handoff.");
    }

    fixture.prepared = await fixture.service.prepareAgentRun({
      requestId: "REQ-prepare-continuation",
      timezone: "Asia/Kolkata",
      agentId: "local",
      role: "user",
      content: "Continue the runtime work.",
      at: "2026-07-19T10:04:00+05:30",
    });
    await fixture.service.activateWorkstreamForRun({
      requestId: "REQ-activate-continuation",
      runId: fixture.prepared.run.runId,
      workstreamId: created.workstream.workstreamId,
      expectedWorkstreamHead: first.workstreamContextCommit.headAfter,
      route: {
        kind: "continue_current",
        requestId: "R-0001",
        reason: "Continue the same unfinished implementation request.",
      },
      at: "2026-07-19T10:05:00+05:30",
    });

    const context = await fixture.service.getAgentContext({
      streamId: fixture.prepared.stream.streamId,
    });
    expect(context.run?.workState).toMatchObject({
      revision: 1,
      afterStep: 0,
      status: "in_progress",
      updateReason: "continuation",
      summary: handoff.summary,
      plan: handoff.plan,
      importantContext: handoff.importantContext,
      nextAction: handoff.nextAction,
    });
  });

  it("marks unjournaled context-repository dirt recovery-required and preserves it", async () => {
    const fixture = await createFixture("dirty-recovery");
    const selected = await createBoundWorkstreamWithMutableDirectory(fixture, {
      title: "Dirty Context",
      objective: "Prove context Git safety during finalization.",
    });
    const dirtyPath = join(selected.workstream.contextRepositoryPath, "unverified.txt");
    await mkdir(selected.workstream.contextRepositoryPath);
    await writeFile(dirtyPath, "must be preserved\n", "utf8");

    await expect(fixture.service.finalizeRun(doneFinalization(fixture, [])))
      .rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });

    expect(await git(selected.workstream.contextRepositoryPath, ["rev-parse", "HEAD"]))
      .toBe(selected.workstream.head);
    expect(await git(selected.workstream.contextRepositoryPath, [
      "status", "--porcelain", "--untracked-files=all",
    ])).toContain("unverified.txt");
    expect(fixture.database.prepare(
      "SELECT status, stop_reason FROM runs WHERE run_id = ?",
    ).get(fixture.prepared.run.runId)).toEqual({ status: "recovery_required", stop_reason: null });
  });
});

async function createFixture(name: string): Promise<WorkstreamServiceFixture> {
  const fixture = await createWorkstreamServiceFixture(
    "finalize-" + name,
    "Complete one durable workstream outcome.",
  );
  fixtures.push(fixture);
  return fixture;
}

function createInput(fixture: WorkstreamServiceFixture, requestId: string) {
  return {
    requestId,
    runId: fixture.prepared.run.runId,
    title: "Unified run workstream",
    objective: "Verify one workstream-bound run and its durable finalization.",
    at: "2026-07-19T10:01:00+05:30",
  };
}

function doneFinalization(
  fixture: WorkstreamServiceFixture,
  resources: WorkstreamCompletionRecord["resources"],
): FinalizeRunRequest {
  return {
    requestId: fixture.prepared.run.runId + ":finalize",
    runId: fixture.prepared.run.runId,
    outcome: "done",
    stopReason: "completed",
    assistantResponse: "The requested workstream work is complete.",
    streamSummary: "The user requested one durable workstream outcome.",
    summary: "The requested work is complete.",
    validation: "passed",
    workState: workState({
      status: "done",
      summary: "The requested work is complete.",
      importantContext: resources.flatMap((resource) =>
        resource.locator?.kind === "filesystem"
          ? [{
              kind: "artifact" as const,
              value: resource.description,
              ref: resource.locator.path,
            }]
          : []),
    }),
    workstream: {
      completion: {
        accepted: true,
        resources,
        missing: [],
        failures: [],
        criteria: boundRequestAcceptance(fixture).map((criterion) => ({
          criterion,
          passed: true,
          evidence: "Resource and context verification passed.",
        })),
      },
      requestEffect: { kind: "complete", verification: "verified" },
    },
    at: "2026-07-19T10:06:00+05:30",
  };
}

function incompleteFinalization(fixture: WorkstreamServiceFixture): FinalizeRunRequest {
  return {
    requestId: fixture.prepared.run.runId + ":finalize",
    runId: fixture.prepared.run.runId,
    outcome: "incomplete",
    stopReason: "run_limit",
    assistantResponse: "The work remains in progress.",
    streamSummary: "The request remains active for a later run.",
    summary: "The request remains in progress.",
    validation: "not_applicable",
    next: "Continue the active request.",
    workState: workState({ summary: "The request remains in progress." }),
    workstream: {
      completion: { accepted: false, resources: [], missing: [], failures: [], criteria: [] },
      requestEffect: { kind: "none" },
    },
    at: "2026-07-19T10:03:00+05:30",
  };
}

function needsUserInputFinalization(
  fixture: WorkstreamServiceFixture,
  question: string,
  assistantResponse: string,
): FinalizeRunRequest {
  return {
    requestId: fixture.prepared.run.runId + ":finalize",
    runId: fixture.prepared.run.runId,
    outcome: "needs_user_input",
    stopReason: "needs_user_input",
    assistantResponse,
    streamSummary: "The workstream needs one resource-selection answer.",
    summary: "Waiting for the user to select the durable output resource.",
    validation: "not_applicable",
    next: question,
    workState: workState({
      status: "needs_user_input",
      summary: "Waiting for the user to select the durable output resource.",
      nextAction: question,
    }),
    workstream: {
      completion: {
        accepted: false,
        resources: [],
        missing: [],
        failures: [],
        criteria: [{
          criterion: "The durable output resource is selected.",
          passed: false,
          evidence: "The user must select or provide the resource.",
        }],
      },
      requestEffect: {
        kind: "block",
        reason: "The user must select or provide the durable output resource.",
      },
    },
    at: "2026-07-19T10:06:00+05:30",
  };
}

function failedFinalization(fixture: WorkstreamServiceFixture): FinalizeRunRequest {
  return {
    requestId: fixture.prepared.run.runId + ":finalize",
    runId: fixture.prepared.run.runId,
    outcome: "failed",
    stopReason: "failed",
    assistantResponse: "The read-only attempt failed without changing durable work.",
    streamSummary: "The attempt ended without a durable change.",
    summary: "The read-only attempt failed.",
    validation: "failed",
    workState: workState({ summary: "The read-only attempt failed." }),
    workstream: {
      completion: {
        accepted: false,
        resources: [],
        missing: ["A readable source"],
        failures: ["The read failed."],
        criteria: [{ criterion: "The source is read.", passed: false }],
      },
      requestEffect: { kind: "none" },
    },
    at: "2026-07-19T10:06:00+05:30",
  };
}

function readStep() {
  return {
    version: 1 as const,
    step: 1,
    status: "failed" as const,
    summary: "The relevant file could not be read.",
    toolCalls: [{
      callId: "call-read",
      tool: "read_files",
      purpose: "Inspect the relevant file.",
      toolPurpose: "read" as const,
      toolEffect: "read_only" as const,
      status: "failed" as const,
      input: { files: [{ path: "missing.md" }] },
      error: { code: "ENOENT" },
    }],
    verification: { passed: false },
    createdAt: "2026-07-19T10:04:01+05:30",
  };
}

function requireFilesystemPrimary(selected: SelectedWorkstreamForRunResponse): {
  resourceId: string;
  path: string;
  versionKey: string;
} {
  const binding = selected.resourceBindings.find((item) => item.primary);
  if (!binding || binding.resource.locator.kind !== "filesystem") {
    throw new Error("Expected filesystem primary resource.");
  }
  return {
    resourceId: binding.resource.resourceId,
    path: binding.resource.locator.path,
    versionKey: binding.resource.version.key,
  };
}

function workstreamPath(
  selected: SelectedWorkstreamForRunResponse,
  relativePath: string,
): string {
  return basename(selected.workstream.contextRepositoryPath) + "/" + relativePath;
}

async function git(repositoryPath: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd: repositoryPath, encoding: "utf8" });
  return result.stdout.trim();
}
