import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type {
  FinalizeRunRequest,
  SelectedWorkstreamForRunResponse,
  WorkstreamCompletionRecord,
} from "../src/contracts.js";
import { RUN_FINALIZATION_LIMITS } from "../src/run-finalization-limits.js";
import { parseWorkstreamCommit } from "../src/workstreams/workstream-commit-metadata.js";
import { validateWorkstreamRepository } from "../src/workstreams/workstream-repository-validator.js";
import {
  createBoundWorkstream,
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
    await expect(fixture.service.createWorkstreamForRun({
      ...input,
      requestId: "REQ-attempt-rebind",
      title: "Another workstream",
      objective: "This must not take ownership of the current run.",
    })).rejects.toMatchObject({ code: "RUN_WORKSTREAM_BINDING_IMMUTABLE" });
    expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM workstreams").get())
      .toEqual({ count: 1 });
  });

  it("commits only durable context for a completed context-only run", async () => {
    const fixture = await createFixture("context-only");
    const selected = await createBoundWorkstream(fixture, {
      title: "Context-only Workstream",
      objective: "Record a verified durable outcome without project files in context Git.",
    });
    const input = doneFinalization(fixture, []);

    const result = await fixture.service.finalizeRun(input);
    const replayed = await fixture.service.finalizeRun(input);

    expect(replayed).toEqual(result);
    expect(result).toMatchObject({
      run: { runId: fixture.prepared.run.runId, status: "done", stopReason: "completed" },
      materialization: { status: "not_requested" },
      workstreamContextCommit: {
        status: "committed",
        workstreamId: selected.workstream.workstreamId,
        requestId: "R-0001",
        headBefore: selected.workstream.head,
      },
    });
    if (result.workstreamContextCommit.status !== "committed") {
      throw new Error("Expected a context commit.");
    }
    expect(result.workstreamContextCommit.headAfter).toBe(result.workstreamContextCommit.commit);
    expect(await git(selected.workstream.contextRepositoryPath, ["rev-list", "--count", "HEAD"]))
      .toBe("2");
    expect((await git(selected.workstream.contextRepositoryPath, [
      "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD",
    ])).split("\n").sort()).toEqual([
      "requests/R-0001-context-only-workstream.md",
      "resources.json",
      "workstream.md",
    ]);
    const validation = await validateWorkstreamRepository({
      workstreamRoot: join(fixture.root, "workstreams"),
      contextRepositoryPath: selected.workstream.contextRepositoryPath,
      expectedWorkstreamId: selected.workstream.workstreamId,
    });
    expect(validation).toMatchObject({
      health: "ready",
      workstreamCard: { currentRequest: null, currentSnapshot: "The requested work is complete." },
      requests: [{ id: "R-0001", status: "done" }],
      resourceManifest: { resources: [{ role: "primary", access: "mutate" }] },
    });
  });

  it("keeps one canonical primary binding when completion reuses its directory as a deliverable", async () => {
    const fixture = await createFixture("canonical-primary-resource");
    const selected = await createBoundWorkstream(fixture, {
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
    const selected = await createBoundWorkstream(fixture, {
      title: "Clarification Boundary",
      objective: "Preserve the full reply while durably recording a bounded clarification.",
    });
    const prefix = "Which durable output resource should Ayati use? ";
    const question = prefix + "x".repeat(
      RUN_FINALIZATION_LIMITS.workState.contextItemChars - prefix.length,
    );
    const assistantResponse = question
      + " The complete user-facing reply may contain additional explanation.";

    const result = await fixture.service.finalizeRun(
      needsUserInputFinalization(fixture, question, assistantResponse),
    );

    expect(question).toHaveLength(RUN_FINALIZATION_LIMITS.workState.contextItemChars);
    expect(result).toMatchObject({
      run: { status: "needs_user_input", stopReason: "needs_user_input" },
      workstreamContextCommit: { status: "committed" },
    });
    expect((fixture.database.prepare([
      "SELECT content FROM messages",
      "WHERE conversation_id = ? AND role = 'assistant'",
    ].join(" ")).get(fixture.prepared.conversation.conversationId) as { content: string } | undefined)
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
        currentFocus: question,
        blockers: [question],
      },
      requests: [{ id: "R-0001", status: "blocked" }],
    });
  });

  it("records verified real-file mutation but commits only context files exactly once", async () => {
    const fixture = await createFixture("verified-mutation");
    const selected = await createBoundWorkstream(fixture, {
      title: "Verified Website",
      objective: "Create a verified website file in the real output resource.",
    });
    const primary = requireFilesystemPrimary(selected);
    const outputPath = join(primary.path, "index.html");
    const binding = selected.run.workstreamBinding;
    if (!binding) throw new Error("Expected workstream binding.");
    const prepared = await fixture.service.prepareResourceMutation({
      requestId: fixture.prepared.run.runId + ":call-write:prepare",
      sessionId: fixture.prepared.session.sessionId,
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
      sessionId: fixture.prepared.session.sessionId,
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
        workStateAfter: workState({
          summary: "Created the verified website entry point.",
          artifacts: [outputPath],
        }),
        createdAt: "2026-07-19T10:03:01+05:30",
      },
    });
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
      sessionId: fixture.prepared.session.sessionId,
      outcome: "completed",
      validation: "passed",
      summary: "The requested work is complete.",
    });
    expect(result.workstreamContextCommit.status === "committed"
      ? result.workstreamContextCommit.commit
      : undefined).toBe(metadata ? await git(selected.workstream.contextRepositoryPath, ["rev-parse", "HEAD"]) : "");
  });

  it("does not create a context commit for a later failed read-only continuation", async () => {
    const fixture = await createFixture("read-only-failure");
    const created = await createBoundWorkstream(fixture, {
      title: "Read-only Continuation",
      objective: "Keep one request active across runs.",
    });
    const first = await fixture.service.finalizeRun(incompleteFinalization(fixture));
    if (first.workstreamContextCommit.status !== "committed") {
      throw new Error("Expected initial context update.");
    }
    const firstRunId = fixture.prepared.run.runId;
    fixture.prepared = await fixture.service.prepareContextTurn({
      requestId: "REQ-read-only-next",
      date: "2026-07-19",
      timezone: "Asia/Kolkata",
      agentId: "local",
      role: "user",
      content: "Inspect the prior context, but the read fails.",
      at: "2026-07-19T10:04:00+05:30",
    });
    await fixture.service.recordRunStep({
      requestId: fixture.prepared.run.runId + ":step:1",
      sessionId: fixture.prepared.session.sessionId,
      runId: fixture.prepared.run.runId,
      record: readStep(),
    });
    await fixture.service.activateWorkstreamForRun({
      requestId: "REQ-activate-read-only",
      sessionId: fixture.prepared.session.sessionId,
      conversationId: fixture.prepared.conversation.conversationId,
      runId: fixture.prepared.run.runId,
      workstreamId: created.workstream.workstreamId,
      expectedWorkstreamHead: first.workstreamContextCommit.headAfter,
      route: {
        kind: "continue_active_request",
        requestId: "R-0001",
        reason: "The same unfinished request is being inspected.",
      },
      at: "2026-07-19T10:05:00+05:30",
    });
    const headBefore = await git(created.workstream.contextRepositoryPath, ["rev-parse", "HEAD"]);

    const result = await fixture.service.finalizeRun(failedFinalization(fixture));
    const context = await fixture.service.getActiveContext({
      sessionId: fixture.prepared.session.sessionId,
    });

    expect(result).toMatchObject({
      run: { status: "failed", stopReason: "failed" },
      workstreamContextCommit: { status: "not_required" },
    });
    expect(await git(created.workstream.contextRepositoryPath, ["rev-parse", "HEAD"]))
      .toBe(headBefore);
    expect(context.readContext).toMatchObject({
      afterCommitRunId: firstRunId,
      evidence: [],
    });
  });

  it("marks unjournaled context-repository dirt recovery-required and preserves it", async () => {
    const fixture = await createFixture("dirty-recovery");
    const selected = await createBoundWorkstream(fixture, {
      title: "Dirty Context",
      objective: "Prove context Git safety during finalization.",
    });
    const dirtyPath = join(selected.workstream.contextRepositoryPath, "unverified.txt");
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
    sessionId: fixture.prepared.session.sessionId,
    conversationId: fixture.prepared.conversation.conversationId,
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
    sessionId: fixture.prepared.session.sessionId,
    runId: fixture.prepared.run.runId,
    outcome: "done",
    stopReason: "completed",
    assistantResponse: "The requested workstream work is complete.",
    conversationSummary: "The user requested one durable workstream outcome.",
    summary: "The requested work is complete.",
    validation: "passed",
    workState: workState({
      status: "done",
      summary: "The requested work is complete.",
      artifacts: resources.flatMap((resource) =>
        resource.locator?.kind === "filesystem" ? [resource.locator.path] : []),
    }),
    workstream: {
      completion: {
        accepted: true,
        resources,
        missing: [],
        failures: [],
        criteria: [{
          criterion: "The requested outcome is deterministically verified.",
          passed: true,
          evidence: "Resource and context verification passed.",
        }],
      },
    },
    at: "2026-07-19T10:06:00+05:30",
  };
}

function incompleteFinalization(fixture: WorkstreamServiceFixture): FinalizeRunRequest {
  return {
    requestId: fixture.prepared.run.runId + ":finalize",
    sessionId: fixture.prepared.session.sessionId,
    runId: fixture.prepared.run.runId,
    outcome: "incomplete",
    stopReason: "run_limit",
    assistantResponse: "The work remains in progress.",
    conversationSummary: "The request remains active for a later run.",
    summary: "The request remains in progress.",
    validation: "not_applicable",
    next: "Continue the active request.",
    workState: workState({ summary: "The request remains in progress." }),
    workstream: {
      completion: { accepted: false, resources: [], missing: [], failures: [], criteria: [] },
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
    sessionId: fixture.prepared.session.sessionId,
    runId: fixture.prepared.run.runId,
    outcome: "needs_user_input",
    stopReason: "needs_user_input",
    assistantResponse,
    conversationSummary: "The workstream needs one resource-selection answer.",
    summary: "Waiting for the user to select the durable output resource.",
    validation: "not_applicable",
    next: question,
    workState: workState({
      status: "needs_user_input",
      summary: "Waiting for the user to select the durable output resource.",
      nextStep: question,
      userInputNeeded: [question],
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
    },
    at: "2026-07-19T10:06:00+05:30",
  };
}

function failedFinalization(fixture: WorkstreamServiceFixture): FinalizeRunRequest {
  return {
    requestId: fixture.prepared.run.runId + ":finalize",
    sessionId: fixture.prepared.session.sessionId,
    runId: fixture.prepared.run.runId,
    outcome: "failed",
    stopReason: "failed",
    assistantResponse: "The read-only attempt failed without changing durable work.",
    conversationSummary: "The attempt ended without a durable change.",
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
    workStateAfter: workState({ summary: "The read failed." }),
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

async function git(repositoryPath: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd: repositoryPath, encoding: "utf8" });
  return result.stdout.trim();
}
