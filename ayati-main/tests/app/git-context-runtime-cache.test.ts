import { describe, expect, it, vi } from "vitest";
import type {
  ActiveContext,
  FinalizeRunResponse,
  GitContextObservabilityEvent,
  GitContextService,
  RecordRunStepResponse,
  RunContextProjection,
} from "ayati-git-context";
import { GitContextObserver } from "ayati-git-context";
import { buildContextEngineProjection } from "../../src/context-engine/index.js";
import { createGitContextRuntime } from "../../src/app/git-context-runtime.js";

describe("Git Context runtime cache", () => {
  it("warms the latest live session for daemon startup", async () => {
    const fixture = serviceFixture();
    const runtime = createGitContextRuntime({
      service: fixture.service,
      timezone: "UTC",
      agentId: "local",
    });

    await runtime.warmActiveContext();
    const warmed = await runtime.buildActiveContext("S-1");

    expect(warmed.session.meta.sessionId).toBe("S-1");
    expect(fixture.getActiveContext).toHaveBeenCalledTimes(1);
  });

  it("prepares the message and run atomically, then reuses the projection", async () => {
    const fixture = serviceFixture();
    const runtime = createGitContextRuntime({
      service: fixture.service,
      timezone: "UTC",
      agentId: "local",
    });

    const turn = await runtime.prepareUserTurn({
      clientId: "local",
      userMessage: "Explain the context cache.",
      at: "2026-07-19T10:00:00.000Z",
    });
    const first = await runtime.buildActiveContext(turn.sessionId);
    const second = await runtime.buildActiveContext(turn.sessionId);
    await runtime.finalizeRun({
      turn,
      outcome: "done",
      stopReason: "completed",
      assistantResponse: "The cache reuses the prepared projection.",
      conversationSummary: "Explained the context cache.",
      summary: "Answered directly without an action step.",
      validation: "not_applicable",
      workState: {
        status: "done",
        summary: "Answered directly without an action step.",
        openWork: [],
        blockers: [],
        verifiedFacts: [],
        evidence: [],
      },
      at: "2026-07-19T10:00:01.000Z",
    });

    expect(turn.run).toEqual({
      runId: "RUN-1",
      sessionId: "S-1",
      conversationId: "C-1",
      triggerSeq: 1,
    });
    expect(first).toBe(turn.context);
    expect(second).toBe(first);
    expect(fixture.prepareContextTurn).toHaveBeenCalledTimes(1);
    expect(fixture.finalizeRun).toHaveBeenCalledTimes(1);
    expect(fixture.recordRunStep).not.toHaveBeenCalled();
    expect(fixture.prepareContextTurn).toHaveBeenCalledWith(expect.objectContaining({
      role: "user",
      content: "Explain the context cache.",
      requestId: expect.stringMatching(/^prepare:/),
    }));
    expect(fixture.getActiveContext).not.toHaveBeenCalled();
  });

  it("patches cached run and reusable read context from each persisted step", async () => {
    const fixture = serviceFixture();
    const events: GitContextObservabilityEvent[] = [];
    const runtime = createGitContextRuntime({
      service: fixture.service,
      timezone: "UTC",
      agentId: "local",
      observer: new GitContextObserver("git-context-harness", (event) => events.push(event)),
    });
    const turn = await runtime.prepareUserTurn({
      clientId: "local",
      userMessage: "Read the implementation.",
      at: "2026-07-19T10:00:00.000Z",
    });

    const projection = await runtime.recordRunStep({
      turn,
      record: {
        v: 1,
        sessionId: "S-1",
        runId: "RUN-1",
        step: 1,
        status: "completed",
        startedAt: "2026-07-19T10:00:01.000Z",
        completedAt: "2026-07-19T10:00:02.000Z",
        summary: "Source was read.",
        decision: { kind: "act" },
        action: { calls: 1 },
        toolCalls: [{
          callId: "read-source",
          tool: "read_files",
          purpose: "Inspect source",
          status: "success",
          input: { path: "src/index.ts" },
          output: "source",
        }],
        verification: { passed: true },
        workStateAfter: {
          status: "not_done",
          summary: "Source was read.",
          openWork: [],
          blockers: [],
          verifiedFacts: [],
          evidence: [],
        },
        facts: [],
        artifacts: [],
      },
    });
    const cached = await runtime.buildActiveContext(turn.sessionId);
    await runtime.finalizeRun({
      turn,
      outcome: "done",
      stopReason: "completed",
      assistantResponse: "The source was inspected.",
      conversationSummary: "Inspected the source.",
      summary: "Completed one observational step.",
      validation: "not_applicable",
      workState: {
        status: "done",
        summary: "Completed one observational step.",
        openWork: [],
        blockers: [],
        verifiedFacts: [],
        evidence: [],
      },
      at: "2026-07-19T10:00:03.000Z",
    });

    expect(projection?.readContext?.evidence).toEqual([
      expect.objectContaining({
        runId: "RUN-1",
        step: 1,
        tool: "read_files",
        output: "source",
      }),
    ]);
    expect(cached).toBe(projection);
    expect(fixture.recordRunStep).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "RUN-1:step-1",
      runId: "RUN-1",
      record: expect.objectContaining({
        version: 1,
        step: 1,
        toolCalls: [expect.objectContaining({
          callId: "read-source",
          toolPurpose: "read",
          toolEffect: "read_only",
        })],
      }),
    }));
    expect(fixture.getActiveContext).not.toHaveBeenCalled();
    expect(fixture.prepareContextTurn).toHaveBeenCalledTimes(1);
    expect(fixture.recordRunStep).toHaveBeenCalledTimes(1);
    expect(fixture.finalizeRun).toHaveBeenCalledTimes(1);
    expect(events.map((event) => event.event)).toEqual(expect.arrayContaining([
      "run_step_persistence_queued",
      "run_step_persisted",
    ]));
  });

  it("preserves a newly bound workstream while patching the next step", async () => {
    const fixture = serviceFixture({ stepWorkstreamBound: true });
    const runtime = createGitContextRuntime({
      service: fixture.service,
      timezone: "UTC",
      agentId: "local",
    });
    const turn = await runtime.prepareUserTurn({
      clientId: "local",
      userMessage: "Create the requested file.",
      at: "2026-07-19T10:00:00.000Z",
    });
    const boundContext = buildContextEngineProjection(activeContext(true));

    const projection = await runtime.recordRunStep({
      turn,
      currentContext: boundContext,
      record: {
        v: 1,
        sessionId: "S-1",
        runId: "RUN-1",
        step: 1,
        status: "completed",
        startedAt: "2026-07-19T10:00:01.000Z",
        completedAt: "2026-07-19T10:00:02.000Z",
        summary: "Workstream was bound.",
        decision: { kind: "act" },
        action: { calls: 1 },
        toolCalls: [{
          callId: "bind-workstream",
          tool: "git_context_create_workstream",
          purpose: "Bind this run to the requested workstream",
          status: "success",
          input: { title: "Workstream" },
          output: { runId: "RUN-1", workstreamId: "W-1" },
        }],
        verification: { passed: true },
        workStateAfter: {
          status: "not_done",
          summary: "Workstream was bound.",
          openWork: ["Create the requested file."],
          blockers: [],
          verifiedFacts: [],
          evidence: [],
        },
        facts: [],
        artifacts: [],
      },
    });

    expect(projection).toMatchObject({
      focus: { status: "active", workstreamId: "W-1" },
      pendingTurn: { routingStatus: "bound", runId: "RUN-1", workstreamId: "W-1" },
      workstream: {
        workstreamId: "W-1",
        contextRepositoryPath: "/ayati/workstreams/W-1",
      },
    });
    expect(turn.context).toBe(projection);
    expect(await runtime.buildActiveContext("S-1")).toBe(projection);
    expect(fixture.getActiveContext).not.toHaveBeenCalled();
  });

  it("waits for finalization and emits truthful commit acknowledgement", async () => {
    const fixture = serviceFixture({ workstreamBound: true });
    const events: GitContextObservabilityEvent[] = [];
    const runtime = createGitContextRuntime({
      service: fixture.service,
      timezone: "UTC",
      agentId: "local",
      observer: new GitContextObserver("git-context-harness", (event) => events.push(event)),
    });
    const turn = await runtime.prepareUserTurn({
      clientId: "local",
      userMessage: "Finish the workstream request.",
      at: "2026-07-19T10:00:00.000Z",
    });

    const response = await runtime.finalizeRun({
      turn,
      outcome: "done",
      stopReason: "completed",
      assistantResponse: "Finished the workstream request.",
      conversationSummary: "Finished the workstream request.",
      summary: "Finished and verified the workstream request.",
      validation: "passed",
      workState: {
        status: "done",
        summary: "Finished and verified the workstream request.",
        openWork: [],
        blockers: [],
        verifiedFacts: [],
        evidence: [],
      },
      workstreamCompletion: {
        accepted: true,
        resources: [],
        missing: [],
        failures: [],
        criteria: [{ criterion: "Finish the workstream request", passed: true }],
      },
      at: "2026-07-19T10:01:00.000Z",
    });

    expect(response?.workstreamContextCommit.status).toBe("committed");
    expect(fixture.finalizeRun).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "RUN-1:finalize",
      sessionId: "S-1",
      runId: "RUN-1",
      workstream: { completion: expect.objectContaining({ accepted: true }) },
    }));
    expect(events.map((event) => event.event)).toEqual(expect.arrayContaining([
      "run_finalization_started",
      "run_finalization_completed",
      "workstream_context_commit_created",
    ]));
    expect(events.find((event) => event.event === "run_finalization_completed")?.data).toMatchObject({
      outcome: "done",
      workstreamContextCommit: { status: "committed", commit: "b".repeat(40) },
    });
  });

  it("defensively compacts WorkState before calling the durable service", async () => {
    const fixture = serviceFixture();
    const runtime = createGitContextRuntime({
      service: fixture.service,
      timezone: "UTC",
      agentId: "local",
    });
    const turn = await runtime.prepareUserTurn({
      clientId: "local",
      userMessage: "Continue after choosing a resource.",
      at: "2026-07-19T10:00:00.000Z",
    });
    const question = "Which resource should Ayati use? " + "detail ".repeat(100);

    await runtime.finalizeRun({
      turn,
      outcome: "needs_user_input",
      stopReason: "needs_user_input",
      assistantResponse: question,
      conversationSummary: "Waiting for one resource choice.",
      summary: "Waiting for one resource choice.",
      validation: "not_applicable",
      workState: {
        status: "needs_user_input",
        summary: "Waiting for one resource choice.",
        openWork: [],
        blockers: [],
        verifiedFacts: [],
        evidence: [],
        nextStep: question,
        userInputNeeded: question,
      },
      at: "2026-07-19T10:01:00.000Z",
    });

    const request = fixture.finalizeRun.mock.calls[0]?.[0];
    expect(request?.assistantResponse).toBe(question);
    expect(request?.workState.userInputNeeded[0]).not.toBe(question);
    expect(request?.workState.userInputNeeded[0]?.length).toBeLessThanOrEqual(500);
    expect(request?.workState.nextStep?.length).toBeLessThanOrEqual(1_000);
  });
});

function serviceFixture(options: { workstreamBound?: boolean; stepWorkstreamBound?: boolean } = {}) {
  const context = activeContext(options.workstreamBound === true);
  const prepareContextTurn = vi.fn(async () => ({
    session: context.session!.session,
    sessionCreated: false,
    conversation: context.session!.pendingConversation[0]!,
    message: context.session!.pendingConversationContext[0]!.messages[0]!,
    run: context.run!.run,
    persistence: {
      database: "saved" as const,
      materialization: "not_requested" as const,
      git: "not_committed" as const,
    },
    context,
  }));
  const getActiveContext = vi.fn(async () => context);
  const recordRunStep = vi.fn(async (): Promise<RecordRunStepResponse> => ({
    run: runProjection(options.stepWorkstreamBound ?? options.workstreamBound === true, 1),
    readContext: {
      revision: "read-1",
      inventory: [],
      discovery: [],
      evidence: [{
        key: "evidence:read_files:src/index.ts",
        runId: "RUN-1",
        step: 1,
        callId: "read-source",
        tool: "read_files",
        purpose: "Inspect source",
        resources: ["src/index.ts"],
        input: { path: "src/index.ts" },
        output: "source",
        verification: { passed: true },
        createdAt: "2026-07-19T10:00:02.000Z",
      }],
      actions: [],
    },
  }));
  const finalizeRun = vi.fn(async (): Promise<FinalizeRunResponse> => ({
    run: {
      ...runProjection(options.workstreamBound === true, 0).run,
      status: "done",
      stopReason: "completed",
      completedAt: "2026-07-19T10:01:00.000Z",
    },
    conversation: {
      ...context.session!.pendingConversation[0]!,
      status: "committed",
    },
    persistence: {
      database: "saved",
      materialization: "materialized",
      git: "committed",
    },
    materialization: {
      status: "materialized",
      runFile: "runs/RUN-1/run.json",
      stepsFile: "runs/RUN-1/steps.jsonl",
    },
    resourceEffects: { status: "none", events: [] },
    workstreamContextCommit: options.workstreamBound
      ? {
          status: "committed",
          workstreamId: "W-1",
          requestId: "R-0001",
          headBefore: "a".repeat(40),
          headAfter: "b".repeat(40),
          commit: "b".repeat(40),
        }
      : { status: "not_required" },
  }));
  const service = {
    prepareContextTurn,
    getActiveContext,
    recordRunStep,
    finalizeRun,
  } as unknown as GitContextService;
  return { service, prepareContextTurn, getActiveContext, recordRunStep, finalizeRun };
}

function activeContext(workstreamBound: boolean): ActiveContext {
  const run = runProjection(workstreamBound, 0);
  return {
    contextRevision: "revision-1",
    session: {
      session: {
        sessionId: "S-1",
        repositoryPath: "/session",
        head: "a".repeat(40),
        date: "2026-07-19",
        timezone: "UTC",
        status: "open",
      },
      summary: "",
      pendingConversation: [{
        conversationId: "C-1",
        sessionId: "S-1",
        sequence: 1,
        filePath: "conversations/1.md",
        status: "active",
      }],
      pendingConversationContext: [{
        conversation: {
          conversationId: "C-1",
          sessionId: "S-1",
          sequence: 1,
          filePath: "conversations/1.md",
          status: "active",
        },
        messages: [{
          messageId: "M-1",
          conversationId: "C-1",
          sessionSequence: 1,
          segmentSequence: 1,
          sequence: 1,
          role: "user",
          content: "Current request",
          at: "2026-07-19T10:00:00.000Z",
        }],
        contentHash: "hash-1",
      }],
      pendingDigest: "digest-1",
      recentCommits: [],
    },
    run,
    ...(workstreamBound ? {
      activeWorkstream: {
        workstream: {
          workstreamId: "W-1",
          contextRepositoryPath: "/ayati/workstreams/W-1",
          branch: "main",
          head: "a".repeat(40),
        },
        title: "Workstream",
        objective: "Finish the durable request",
        summary: "Workstream request in progress",
        workstreamStatus: "in_progress" as const,
        lifecycleStatus: "active" as const,
        repositoryHealth: "ready" as const,
        blockers: [],
        currentRequest: {
          id: "R-0001",
          title: "Finish the request",
          status: "active" as const,
          request: "Finish the durable request.",
          acceptance: ["The outcome is verified."],
          constraints: [],
        },
        resources: [],
        recentCommits: [],
      },
    } : {}),
    workstreamCandidates: [],
    ingressResources: [],
    warnings: [],
  };
}

function runProjection(workstreamBound: boolean, afterStep: number): RunContextProjection {
  return {
    run: {
      runId: "RUN-1",
      sessionId: "S-1",
      conversationId: "C-1",
      ...(workstreamBound ? {
        workstreamBinding: {
          workstreamId: "W-1",
          requestId: "R-0001",
          boundAt: "2026-07-19T10:00:00.500Z",
        },
      } : {}),
      status: "running",
      trigger: "user",
      startedAt: "2026-07-19T10:00:00.000Z",
      stepCount: afterStep,
    },
    workState: {
      runId: "RUN-1",
      revision: afterStep,
      afterStep,
      status: "not_done",
      summary: afterStep ? "Source was read." : "",
      openWork: [],
      blockers: [],
      facts: [],
      evidence: [],
      artifacts: [],
      nextStep: null,
      userInputNeeded: [],
      updatedAt: "2026-07-19T10:00:02.000Z",
    },
    steps: [],
  };
}
