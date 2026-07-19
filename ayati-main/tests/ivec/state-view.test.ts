import { describe, expect, it } from "vitest";
import { buildAgentStateView } from "../../src/ivec/agent-runner/state-view.js";
import type { ContextEngineMachineContext } from "../../src/context-engine/index.js";
import type { HarnessContext } from "../../src/ivec/harness-context.js";
import type { LoopState } from "../../src/ivec/types.js";

function createHarnessContext(overrides: Partial<HarnessContext> = {}): HarnessContext {
  return {
    personalMemorySnapshot: "",
    ...overrides,
  };
}

function createGitContext(overrides: Partial<ContextEngineMachineContext> = {}): ContextEngineMachineContext {
  return {
    session: {
      meta: {
        sessionId: "2026-06-27",
        assetCount: 0,
      },
      conversationTail: [],
      activityTail: [],
      recentCommits: [{
        commit: "abc123",
        subject: "ayati: checkpoint session",
        event: "session_checkpointed",
      }],
    },
    focus: {
      status: "active",
      ref: "refs/heads/task/T-20260627-0001-analyze-invoice",
      workId: "T-20260627-0001",
    },
    task: {
      ref: "refs/heads/task/T-20260627-0001-analyze-invoice",
      workId: "T-20260627-0001",
      title: "Analyze invoice",
      objective: "Analyze invoice",
      status: "active",
      completed: ["Read invoice"],
      open: ["Summarize invoice"],
      blockers: [],
      facts: [{ text: "Invoice has three line items.", source: "ev-001" }],
      next: "Summarize invoice",
      assets: [{
        assetId: "A-20260627-0001",
        role: "input",
        kind: "document",
        name: "invoice.pdf",
        path: "uploads/invoice.pdf",
      }],
      recentRuns: [{
        schemaVersion: 1,
        runId: "R-20260627-0001",
        workId: "T-20260627-0001",
        status: "completed",
        summary: "Read invoice.",
        completed: ["Read invoice"],
        open: ["Summarize invoice"],
        actions: ["action-0001"],
        createdAt: "2026-06-27T10:00:00.000Z",
      }],
      recentCommits: [{
        commit: "def456",
        subject: "ayati: commit run",
        event: "run_committed",
        workId: "T-20260627-0001",
      }],
      recentEvidence: [{
        runId: "R-20260627-0001",
        workId: "T-20260627-0001",
        step: 1,
        tool: "read_files",
        status: "completed",
        summary: "Read invoice input.",
        artifacts: ["uploads/invoice.pdf"],
        facts: ["Invoice has three line items."],
        accessModes: ["summary"],
      }],
    },
    ...overrides,
  };
}

function createLoopState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    runId: "run-current",
    currentSeq: 1,
    userMessage: "continue invoice",
    workState: {
      status: "not_done",
      openWork: [],
      blockers: [],
      summary: "",
      verifiedFacts: [],
      evidence: [],
    },
    status: "running",
    finalOutput: "",
    iteration: 0,
    maxIterations: 15,
    consecutiveFailures: 0,
    completedSteps: [],
    runPath: "/tmp/ayati/run-current",
    failureHistory: [],
    harnessContext: createHarnessContext(),
    ...overrides,
  };
}

describe("buildAgentStateView", () => {
  it("uses durable readContext instead of duplicating the same active-run read output", () => {
    const state = createLoopState({
      runId: "R-1",
      harnessContext: createHarnessContext({
        contextEngine: createGitContext({
          readContext: {
            revision: "read-revision",
            inventory: [],
            discovery: [],
            evidence: [{
              key: "evidence:read_files:requirements.md",
              runId: "R-1",
              step: 1,
              tool: "read_files",
              purpose: "Read requirements.",
              resources: ["requirements.md"],
              input: { files: [{ path: "requirements.md" }] },
              output: { files: [{ path: "requirements.md", content: "requirements" }] },
              verification: { passed: true },
              createdAt: "2026-07-14T10:00:00.000Z",
            }],
            actions: [],
          },
        }),
      }),
      toolContext: {
        recent: [],
        toolCalls: [{
          step: 1,
          tool: "read_files",
          purpose: "Read requirements.",
          input: { files: [{ path: "requirements.md" }] },
          status: "success",
          output: "requirements",
        }, {
          step: 2,
          tool: "process_run",
          purpose: "Validate the application.",
          input: { cmd: "node --check app.js" },
          status: "success",
          output: "",
        }],
      },
    });

    const view = buildAgentStateView(state);

    expect(view.context.git?.current.readContext?.evidence).toHaveLength(1);
    expect(view.context.run?.toolCalls).toEqual([
      expect.objectContaining({
        step: 1,
        tool: "read_files",
        mode: "reference",
        readContextKeys: ["evidence:read_files:requirements.md"],
      }),
      expect.objectContaining({ step: 2, tool: "process_run", mode: "full" }),
    ]);
    expect(view.context.run?.toolCalls?.[0]).not.toHaveProperty("output");
  });

  it("exposes git context as the durable task source", () => {
    const state = createLoopState({
      harnessContext: createHarnessContext({
        contextEngine: createGitContext(),
      }),
    });

    const context = buildAgentStateView(state).context;
    expect(context.gitContext?.task).toMatchObject({
      workId: "T-20260627-0001",
      open: ["Summarize invoice"],
      facts: [{ text: "Invoice has three line items.", source: "ev-001" }],
    });
    expect(context.git?.current.task).toMatchObject({
      identity: {
        workId: "T-20260627-0001",
        title: "Analyze invoice",
      },
      state: {
        open: ["Summarize invoice"],
        facts: [{ text: "Invoice has three line items.", source: "ev-001" }],
      },
      activity: {
        recentRuns: [{
          summary: "Read invoice.",
        }],
        recentEvidence: [{
          summary: "Read invoice input.",
        }],
      },
    });
    expect(context.git?.session).toMatchObject({
      meta: {
        sessionId: "2026-06-27",
        assetCount: 0,
      },
      activity: {
        recent: [],
      },
    });
    expect(context.git?.session).not.toHaveProperty("sessionId");
    expect(context.git?.session).not.toHaveProperty("assetCount");
    expect(context.git?.session.recentCommits).toHaveLength(1);
    expect(context.git?.session).not.toHaveProperty("conversationTail");
    expect(context.git?.session).not.toHaveProperty("conversationMarkdownTail");
    expect(context.git?.session).not.toHaveProperty("summary");
    expect(context.git?.current).not.toHaveProperty("session");
    expect(context.git?.current.task).not.toHaveProperty("conversationMarkdownTail");
    expect(context.git?.current.task).not.toHaveProperty("recentCommits");
    expect(context.git?.current.task).not.toHaveProperty("recentRuns");
    expect(context.git?.current.task).not.toHaveProperty("recentEvidence");
    expect(context.git?.current.task?.activity.recentRuns[0]).not.toHaveProperty("runId");
    expect(context.git?.current.task?.activity.recentEvidence[0]).not.toHaveProperty("runId");
    expect(context.gitContext?.session.recentCommits).toHaveLength(1);
    expect(context.gitContext?.task?.recentCommits).toHaveLength(1);
    expect(context).not.toHaveProperty("continuity");
    expect(context).not.toHaveProperty("taskThreadContext");
    expect(context).not.toHaveProperty("sessionWork");
  });

  it("projects a session summary when the context provider supplies one", () => {
    const gitContext = createGitContext();
    const state = createLoopState({
      harnessContext: createHarnessContext({
        contextEngine: createGitContext({
          session: {
            ...gitContext.session,
            summary: {
              text: "The session is organizing Ayati prompt context before adding summarization.",
              updatedAt: "2026-06-27T10:05:00.000Z",
              coveredUntilSeq: 6,
            },
          },
        }),
      }),
    });

    const context = buildAgentStateView(state).context;
    expect(context.git?.session.summary).toEqual({
      text: "The session is organizing Ayati prompt context before adding summarization.",
      updatedAt: "2026-06-27T10:05:00.000Z",
      coveredUntilSeq: 6,
    });
    expect(context.git?.session.summary).not.toHaveProperty("conversationTail");
  });

  it("projects recent task-bound-run checkpoints separately from the exact timeline", () => {
    const gitContext = createGitContext();
    const state = createLoopState({
      currentSeq: 7,
      userMessage: "Continue with the next step.",
      harnessContext: createHarnessContext({
        contextEngine: createGitContext({
          session: {
            ...gitContext.session,
            conversationTail: [{
              seq: 7,
              role: "user",
              at: "2026-06-27T10:07:00.000Z",
              text: "Continue with the next step.",
            }],
            recentTaskRuns: [{
              checkpointId: `task-bound-run-checkpoint-${"a".repeat(64)}`,
              commit: "checkpoint-commit",
              workId: "T-20260627-0001",
              runId: "R-20260627-0001",
              status: "completed",
              fromSeq: 1,
              toSeq: 6,
              sourceHash: "a".repeat(64),
              strategy: "llm",
              at: "2026-06-27T10:06:00.000Z",
              summary: "Summary:\nSession interval: prepared the context system.",
            }],
            projection: {
              latestConversationSeq: 7,
              checkpointBoundarySeq: 6,
              summaryTokens: 20,
              checkpointTokens: 80,
              timelineTokens: 10,
              attachmentTokens: 0,
              totalSessionTokens: 110,
            },
          },
        }),
      }),
    });

    const context = buildAgentStateView(state).context;
    expect(context.timeline).toEqual([{
      kind: "user",
      seq: 7,
      timestamp: "2026-06-27T10:07:00.000Z",
      content: "Continue with the next step.",
      current: true,
    }]);
    expect(context.git?.session.recentTaskRuns).toMatchObject([{
      fromSeq: 1,
      toSeq: 6,
    }]);
    expect(context.git?.session.recentTaskRuns?.[0]).not.toHaveProperty("runId");
    expect(context.git?.session).not.toHaveProperty("projection");
  });

  it("adds routing feedback for an unbound pending turn", () => {
    const state = createLoopState({
      harnessContext: createHarnessContext({
        contextEngine: createGitContext({
          pendingTurn: {
            fromSeq: 4,
            toSeq: 4,
            text: "add another story",
            at: "2026-06-27T10:02:00.000Z",
            routingStatus: "unbound",
          },
        }),
      }),
    });

    expect(buildAgentStateView(state).workingFeedback?.latest[0]).toMatchObject({
      severity: "warning",
      source: "tool_validation",
      message: expect.stringContaining("pending turn is unbound"),
      retryHint: expect.stringContaining("git_context_activate_task"),
    });
  });

  it("adds ask-user feedback for a clarifying pending turn", () => {
    const state = createLoopState({
      harnessContext: createHarnessContext({
        contextEngine: createGitContext({
          pendingTurn: {
            fromSeq: 4,
            toSeq: 4,
            text: "build it",
            at: "2026-06-27T10:02:00.000Z",
            routingStatus: "clarifying",
          },
        }),
      }),
    });

    expect(buildAgentStateView(state).workingFeedback?.latest[0]).toMatchObject({
      severity: "warning",
      source: "tool_validation",
      message: expect.stringContaining("pending turn is clarifying"),
      retryHint: expect.stringContaining("Ask the user directly"),
    });
  });

  it("projects repair-coded failure history into harness feedback without run trace", () => {
    const state = createLoopState({
      failureHistory: [{
        step: 1,
        failureType: "validation_error",
        reason: "No active task exists. Create and activate the first task before using work tools.",
        blockedTargets: ["write_files"],
        repairCode: "R_UNBOUND_RUN_NEEDS_TASK_BINDING",
        repair: {
          code: "R_UNBOUND_RUN_NEEDS_TASK_BINDING",
          message: "No active task exists yet. Normal work tools cannot run before task creation.",
          blockedTargets: ["write_files"],
          allowedNextActions: [
            "Call git_context_create_task with title, objective, and createReason \"no_active_task\".",
          ],
        },
      }],
    });

    const stateView = buildAgentStateView(state);
    expect(stateView.workingFeedback?.latest[0]).toMatchObject({
      severity: "error",
      source: "tool_validation",
      code: "R_UNBOUND_RUN_NEEDS_TASK_BINDING",
      message: "No active task exists yet. Normal work tools cannot run before task creation.",
      retryHint: "Call git_context_create_task with title, objective, and createReason \"no_active_task\".",
      repair: {
        code: "R_UNBOUND_RUN_NEEDS_TASK_BINDING",
        blockedTargets: ["write_files"],
      },
    });
    expect(stateView.context.run ?? {}).not.toHaveProperty("feedback");
    expect(stateView.context.harness?.feedback?.latest[0]).toMatchObject({
      code: "R_UNBOUND_RUN_NEEDS_TASK_BINDING",
      repair: {
        code: "R_UNBOUND_RUN_NEEDS_TASK_BINDING",
      },
    });
    expect(stateView.trace?.recentFailures?.[0]).toMatchObject({
      code: "R_UNBOUND_RUN_NEEDS_TASK_BINDING",
      blockedTargets: ["write_files"],
    });
    expect(stateView.context.run ?? {}).not.toHaveProperty("trace");
  });

  it("builds timeline from git conversation tail", () => {
    const state = createLoopState({
      currentSeq: 3,
      userMessage: "yes",
      harnessContext: createHarnessContext({
        contextEngine: createGitContext({
          session: {
            meta: {
              sessionId: "2026-06-27",
              assetCount: 0,
            },
            activityTail: [],
            conversationTail: [
              {
                seq: 1,
                role: "assistant",
                at: "2026-06-27T10:00:00.000Z",
                text: "Should I summarize the invoice now?",
              },
              {
                seq: 3,
                role: "user",
                at: "2026-06-27T10:01:00.000Z",
                text: "yes",
              },
            ],
          },
        }),
      }),
    });

    expect(buildAgentStateView(state).context.timeline).toEqual([
      {
        kind: "assistant",
        seq: 1,
        timestamp: "2026-06-27T10:00:00.000Z",
        content: "Should I summarize the invoice now?",
        expectsUserResponse: true,
      },
      {
        kind: "user",
        seq: 3,
        timestamp: "2026-06-27T10:01:00.000Z",
        content: "yes",
        current: true,
      },
    ]);
    const context = buildAgentStateView(state).context;
    expect(context.gitContext?.session.conversationTail).toHaveLength(2);
    expect(context.git?.session).not.toHaveProperty("conversationTail");
  });

  it("marks the exact current message by stable id when turn and message sequences differ", () => {
    const state = createLoopState({
      currentSeq: 3,
      currentMessageId: "S-1-M-000005",
      inputKind: "user_message",
      userMessage: "What did I ask about in this conversation?",
      harnessContext: createHarnessContext({
        contextEngine: createGitContext({
          session: {
            meta: { sessionId: "S-1", assetCount: 0 },
            activityTail: [],
            conversationTail: [
              message(1, "S-1-M-000001", "user", "Explain a Git commit."),
              message(2, "S-1-M-000002", "assistant", "A Git commit is a snapshot."),
              message(3, "S-1-M-000003", "user", "Compare it to a checkpoint."),
              message(4, "S-1-M-000004", "assistant", "A checkpoint is less formal."),
              message(5, "S-1-M-000005", "user", "What did I ask about in this conversation?"),
            ],
          },
        }),
      }),
    });

    const timeline = buildAgentStateView(state).context.timeline;
    expect(timeline).toHaveLength(5);
    expect(timeline.filter((event) => event.current)).toHaveLength(1);
    expect(timeline.at(-1)).toMatchObject({
      seq: 5,
      kind: "user",
      content: "What did I ask about in this conversation?",
      current: true,
    });
    expect(timeline.find((event) => event.seq === 3)).not.toHaveProperty("current");
  });

  it("uses message identity when the user repeats the same text", () => {
    const state = createLoopState({
      currentSeq: 2,
      currentMessageId: "S-1-M-000003",
      inputKind: "user_message",
      userMessage: "Continue.",
      harnessContext: createHarnessContext({
        contextEngine: createGitContext({
          session: {
            meta: { sessionId: "S-1", assetCount: 0 },
            activityTail: [],
            conversationTail: [
              message(1, "S-1-M-000001", "user", "Continue."),
              message(2, "S-1-M-000002", "assistant", "I continued."),
              message(3, "S-1-M-000003", "user", "Continue."),
            ],
          },
        }),
      }),
    });

    const timeline = buildAgentStateView(state).context.timeline;
    expect(timeline.filter((event) => event.current)).toEqual([
      expect.objectContaining({ seq: 3, content: "Continue.", current: true }),
    ]);
  });

  it("keeps the complete recent timeline and current input exact below pressure", () => {
    const longCurrentInput = `  current request\n${"x".repeat(2_000)}  `;
    const conversationTail = Array.from({ length: 20 }, (_, index) => ({
      seq: index + 1,
      role: index % 2 === 0 ? "assistant" as const : "user" as const,
      at: `2026-06-27T10:00:${String(index).padStart(2, "0")}.000Z`,
      text: index === 19
        ? longCurrentInput
        : `message-${index + 1}\n${"y".repeat(800)}`,
    }));
    const state = createLoopState({
      currentSeq: 20,
      userMessage: longCurrentInput,
      harnessContext: createHarnessContext({
        contextEngine: createGitContext({
          session: {
            meta: { sessionId: "2026-06-27", assetCount: 0 },
            activityTail: [],
            conversationTail,
          },
        }),
      }),
    });

    const timeline = buildAgentStateView(state).context.timeline;
    expect(timeline).toHaveLength(20);
    expect(timeline[0]).toMatchObject({ content: conversationTail[0]!.text });
    expect(timeline.at(-1)).toMatchObject({
      kind: "user",
      seq: 20,
      content: longCurrentInput,
      current: true,
    });
  });

  it("falls back to the current input when git conversation is unavailable", () => {
    const state = createLoopState({
      currentSeq: 7,
      userMessage: "start a new task",
    });

    expect(buildAgentStateView(state).context.timeline).toEqual([{
      kind: "user",
      seq: 7,
      timestamp: "1970-01-01T00:00:00.000Z",
      content: "start a new task",
      current: true,
    }]);
  });

  it("keeps a synthesized current input byte-identical", () => {
    const currentInput = `  preserve spacing\n${"z".repeat(2_000)}  `;
    const state = createLoopState({
      currentSeq: 8,
      userMessage: currentInput,
    });

    expect(buildAgentStateView(state).context.timeline).toEqual([{
      kind: "user",
      seq: 8,
      timestamp: "1970-01-01T00:00:00.000Z",
      content: currentInput,
      current: true,
    }]);
  });

  it("groups personal memory without mixing it into git, tools, or run context", () => {
    const state = createLoopState({
      harnessContext: createHarnessContext({
        personalMemorySnapshot: "Prefer exact schema contracts.",
        contextEngine: createGitContext(),
      }),
    });

    const stateView = buildAgentStateView(state);
    expect(stateView.context.personalMemorySnapshot).toBe("Prefer exact schema contracts.");
    expect(stateView.context.personal).toEqual({
      memorySnapshot: "Prefer exact schema contracts.",
    });
    expect(stateView.context.git).not.toHaveProperty("personalMemorySnapshot");
    expect(stateView.context.tools).toBeUndefined();
    expect(stateView.context.run).toBeUndefined();
    expect(stateView.context).not.toHaveProperty("scratch");
    expect(Object.keys(stateView.context).sort()).toEqual([
      "git",
      "gitContext",
      "personal",
      "personalMemorySnapshot",
      "timeline",
    ]);
  });

  it("does not project runtime mode names or routing counters", () => {
    const state = createLoopState({
      harnessContext: createHarnessContext({
        contextEngine: createGitContext({
          focus: {
            status: "none",
          },
          task: undefined,
        }),
      }),
    });

    const context = buildAgentStateView(state).context;
    expect(context).not.toHaveProperty("runtimeMode");
    expect(context.run).toBeUndefined();
  });

  it("keeps progress and observations independent from context source without run trace", () => {
    const state = createLoopState({
      workState: {
        status: "needs_user_input",
        summary: "Need approval before editing.",
        openWork: ["Patch prompt"],
        blockers: ["Approval required"],
        verifiedFacts: ["State view uses git context."],
        evidence: ["state-view.ts"],
        artifacts: ["state-view.ts"],
        userInputNeeded: "Can I edit the prompt?",
      },
      toolContext: {
        toolCalls: [{
          step: 1,
          callId: "call-1",
          tool: "read_files",
          input: { path: "state-view.ts" },
          status: "success",
          output: "Read state-view.ts.",
          hasMore: false,
        }],
        recent: [
          {
            id: "obs-1",
            step: 1,
            callId: "call-1",
            tool: "read_files",
            status: "success",
            mode: "summary",
            retention: "while_relevant",
            content: "Read state-view.ts.",
            hasMore: false,
          },
          {
            id: "obs-2",
            step: 1,
            callId: "call-2",
            tool: "process_run",
            status: "success",
            mode: "summary",
            retention: "next_step",
            content: "npm test passed.",
            hasMore: false,
          },
        ],
      },
      completedSteps: [{
        step: 1,
        outcome: "success",
        summary: "Inspected state view.",
        newFacts: ["State view uses git context."],
        artifacts: [],
        toolsUsed: ["read_files"],
        toolSuccessCount: 1,
        toolFailureCount: 0,
      }],
      failureHistory: [{
        step: 2,
        failureType: "permission",
        reason: "Approval required before editing.",
        blockedTargets: ["prompt"],
      }],
    });

    const stateView = buildAgentStateView(state);
    expect(stateView.progress).toMatchObject({
      status: "needs_user_input",
      summary: "Need approval before editing.",
      userInputNeeded: "Can I edit the prompt?",
    });
    expect(stateView.context.run?.workState).toEqual(stateView.progress);
    expect(stateView.context.run?.workState).toMatchObject({
      status: "needs_user_input",
      summary: "Need approval before editing.",
      openWork: ["Patch prompt"],
      blockers: ["Approval required"],
      verifiedFacts: ["State view uses git context."],
      evidence: ["state-view.ts"],
      artifacts: ["state-view.ts"],
      userInputNeeded: "Can I edit the prompt?",
    });
    expect(stateView.context.run).not.toHaveProperty("progress");
    expect(stateView.observations?.latest).toHaveLength(2);
    expect(stateView.context.run).not.toHaveProperty("observations");
    expect(stateView.observations?.latest[0]?.retention).toBe("while_relevant");
    expect(stateView.readContext?.latest).toHaveLength(1);
    expect(stateView.readContext?.latest[0]?.tool).toBe("read_files");
    expect(stateView.context.run).not.toHaveProperty("readContext");
    expect(stateView.toolCalls).toEqual([
      expect.objectContaining({
        step: 1,
        callId: "call-1",
        tool: "read_files",
        input: { path: "state-view.ts" },
        status: "success",
        output: "Read state-view.ts.",
      }),
    ]);
    expect((stateView.context.run?.toolCalls as Array<{ tool: string; input: unknown; output: string; hasMore?: boolean }> | undefined))
      .toEqual([expect.objectContaining({ tool: "read_files", input: { path: "state-view.ts" }, output: "Read state-view.ts." })]);
    expect(stateView.context.run?.toolCalls?.[0]).toHaveProperty("mode", "full");
    expect(stateView.context.run?.toolCalls?.[0]).not.toHaveProperty("hasMore");
    expect(stateView.trace?.recentSteps?.map((step) => step.step)).toEqual([1]);
    expect(stateView.context.run).not.toHaveProperty("trace");
    expect(stateView.workingFeedback?.latest[0]).toMatchObject({
      source: "tool_execution",
      message: "Approval required before editing.",
    });
    expect(stateView.context.run).not.toHaveProperty("feedback");
    expect((stateView.context.harness?.feedback as { latest?: Array<{ source: string }> } | undefined)?.latest?.[0])
      .toMatchObject({ source: "tool_execution" });
  });

  it("keeps all prompt-eligible tool calls full before measured pressure", () => {
    const oldReadOutput = `old read output ${"x".repeat(32_000)}`;
    const oldReadQuery = `query-${"q".repeat(2_000)}`;
    const failedOutput = "command failed with stack trace";
    const state = createLoopState({
      toolContext: {
        recent: [],
        toolCalls: [
          {
            step: 1,
            callId: "call-old-read",
            tool: "read_files",
            input: { path: "src/old.ts", query: oldReadQuery },
            status: "success",
            output: oldReadOutput,
            stepRef: { runId: "run-current", step: 1, callId: "call-old-read" },
            evidenceRef: "steps/run-current.jsonl#call-old-read",
          },
          {
            step: 2,
            callId: "call-old-failed",
            tool: "exec_command",
            input: { cmd: "pnpm test" },
            status: "failed",
            output: failedOutput,
            error: "Tests failed.",
            stepRef: { runId: "run-current", step: 2, callId: "call-old-failed" },
          },
          {
            step: 3,
            callId: "call-search",
            tool: "search_in_files",
            input: { path: "src", query: "context.run" },
            status: "success",
            output: "src/ivec/state-view.ts: context.run",
          },
          {
            step: 4,
            callId: "call-shell",
            tool: "exec_command",
            input: { cmd: "pnpm --filter ayati-main build" },
            status: "success",
            output: "build passed",
          },
          {
            step: 5,
            callId: "call-patch",
            tool: "apply_patch",
            input: { path: "src/ivec/state-view.ts" },
            status: "success",
            output: "patch applied",
          },
          {
            step: 6,
            callId: "call-recent-read",
            tool: "read_files",
            input: { path: "src/recent.ts" },
            status: "success",
            output: "recent read output",
          },
        ],
      },
    });

    const toolCalls = buildAgentStateView(state).context.run?.toolCalls;
    expect(toolCalls).toHaveLength(6);
    expect(toolCalls?.[0]).toMatchObject({
      callId: "call-old-read",
      mode: "full",
      input: { path: "src/old.ts", query: oldReadQuery },
      output: oldReadOutput,
      stepRef: { step: 1, callId: "call-old-read" },
      evidenceRef: "steps/run-current.jsonl#call-old-read",
    });
    expect(toolCalls?.[0]).not.toHaveProperty("outputCompacted");
    expect(toolCalls?.[1]).toMatchObject({
      callId: "call-old-failed",
      mode: "full",
      output: failedOutput,
      error: "Tests failed.",
      stepRef: { step: 2, callId: "call-old-failed" },
    });
    expect(toolCalls?.slice(2).map((call) => call.mode)).toEqual(["full", "full", "full", "full"]);
    expect(toolCalls?.[5]).toMatchObject({
      callId: "call-recent-read",
      output: "recent read output",
    });
  });

  it("keeps older run tool calls full when they fit the live context budget", () => {
    const state = createLoopState({
      toolContext: {
        recent: [],
        toolCalls: [
          {
            step: 1,
            callId: "call-old-read",
            tool: "read_files",
            input: { path: "src/old.ts" },
            status: "success",
            output: "old read output",
            stepRef: { runId: "run-current", step: 1, callId: "call-old-read" },
          },
          {
            step: 2,
            callId: "call-write",
            tool: "write_files",
            input: { files: [{ path: "src/new.ts", content: "new content" }] },
            status: "success",
            output: "write completed",
          },
          {
            step: 3,
            callId: "call-recent-read",
            tool: "read_files",
            input: { path: "src/recent.ts" },
            status: "success",
            output: "recent read output",
          },
        ],
      },
    });

    const toolCalls = buildAgentStateView(state).context.run?.toolCalls;
    expect(toolCalls?.map((call) => call.mode)).toEqual(["full", "full", "full"]);
    expect(toolCalls?.[0]).toMatchObject({
      callId: "call-old-read",
      output: "old read output",
      stepRef: { step: 1, callId: "call-old-read" },
    });
    expect(toolCalls?.[0]).not.toHaveProperty("outputCompacted");
  });

  it("exposes a compact recoverable signal after tool projection enforcement", () => {
    const state = createLoopState({
      contextPressure: {
        mode: "tool_compact",
        softLimitBreachCount: 1,
        unresolvedPressureStreak: 0,
        successfulRecoveryCount: 1,
        admissionRejectionCount: 0,
        peakCandidateInputTokens: 82_000,
        latestReceipt: {
          schemaVersion: 1,
          decisionAttempt: 1,
          mode: "tool_compact",
          provider: "test",
          model: "test-128k",
          candidateInputTokens: 82_000,
          finalInputTokens: 59_000,
          recoveryTargetTokens: 60_000,
          softInputTokens: 70_000,
          hardInputTokens: 100_000,
          admissionLimitTokens: 95_000,
          softLimitExceeded: true,
          hardLimitExceeded: false,
          admitted: true,
          countSource: "local_estimate",
          targetReached: true,
          transformations: [
            { kind: "tool_call_projection", tokensBefore: 20_000, tokensAfter: 1_000 },
            { kind: "tool_call_projection", tokensBefore: 10_000, tokensAfter: 500 },
          ],
        },
      },
    });

    expect(buildAgentStateView(state).context.run?.contextPressure).toEqual({
      mode: "tool_compact",
      unresolvedPressureStreak: 0,
      compactedCalls: 2,
      targetReached: true,
      recoverable: true,
    });
  });

  it("exposes a timeline recommendation without claiming it was applied", () => {
    const state = createLoopState({
      contextPressure: {
        mode: "tool_compact",
        recommendedMode: "timeline_checkpoint",
        escalationReason: "repeated_unresolved_pressure",
        softLimitBreachCount: 2,
        unresolvedPressureStreak: 2,
        successfulRecoveryCount: 0,
        admissionRejectionCount: 0,
        peakCandidateInputTokens: 84_000,
      },
    });

    expect(buildAgentStateView(state).context.run?.contextPressure).toEqual({
      mode: "tool_compact",
      recommendedMode: "timeline_checkpoint",
      escalationReason: "repeated_unresolved_pressure",
      unresolvedPressureStreak: 2,
      compactedCalls: 0,
      recoverable: true,
    });
  });

  it("does not expose the run-scoped timeline checkpoint cache", () => {
    const state = createLoopState({
      timelineCheckpointCache: {
        entries: {
          cached: {
            status: "success",
            checkpointTokens: 100,
            checkpoint: {
              kind: "checkpoint",
              seq: 2,
              timestamp: "2026-07-10T00:00:00.000Z",
              schemaVersion: 1,
              coveredFromSeq: 1,
              coveredToSeq: 2,
              sourceEventCount: 2,
              sourceHash: "secret-source-hash",
              summary: {
                userRequests: [],
                constraints: [],
                decisions: [],
                corrections: [],
                importantFacts: [],
                unresolvedQuestions: [],
                references: [],
                narrative: "cached checkpoint content",
              },
            },
          },
        },
      },
    });

    const serialized = JSON.stringify(buildAgentStateView(state));
    expect(serialized).not.toContain("timelineCheckpointCache");
    expect(serialized).not.toContain("secret-source-hash");
    expect(serialized).not.toContain("cached checkpoint content");
  });

  it("groups tool load, attachments, and system events while keeping top-level aliases", () => {
    const state = createLoopState({
      harnessContext: createHarnessContext({
        contextEngine: createGitContext(),
      }),
      lastToolLoad: {
        status: "partial",
        requested: {
          query: "files",
          toolNames: ["read_files"],
          groups: ["filesystem"],
        },
        loaded: ["read_files"],
        alreadyActive: [],
        evicted: [],
        missing: ["patch_files"],
        message: "Loaded read_files; patch_files was unavailable.",
      },
      attachedDocuments: [{
        documentId: "doc-1",
        name: "invoice.pdf",
        displayName: "invoice.pdf",
        source: "cli",
        originalPath: "/tmp/invoice.pdf",
        storedPath: "/tmp/ayati/docs/invoice.pdf",
        kind: "pdf",
        mimeType: "application/pdf",
        sizeBytes: 1024,
        checksum: "sha256-doc",
      }],
      preparedAttachments: [{
        preparedInputId: "prepared-1",
        documentId: "doc-1",
        displayName: "invoice.pdf",
        source: "cli",
        kind: "pdf",
        mode: "unstructured_text",
        sizeBytes: 1024,
        checksum: "sha256-doc",
        originalPath: "/tmp/invoice.pdf",
        status: "ready",
        warnings: [],
        artifactPath: "/tmp/ayati/prepared/invoice.json",
      }],
      managedFiles: [{
        fileId: "file-1",
        sha256: "sha256-file",
        originalName: "invoice.pdf",
        safeName: "invoice.pdf",
        kind: "pdf",
        mimeType: "application/pdf",
        sizeBytes: 1024,
        origin: "user_upload",
        storagePath: "/tmp/ayati/files/invoice.pdf",
        metadataPath: "/tmp/ayati/files/invoice.json",
        derivedDir: "/tmp/ayati/files/invoice",
        createdAt: "2026-06-27T10:00:00.000Z",
        updatedAt: "2026-06-27T10:00:00.000Z",
        capabilities: ["text"],
        processingStatus: "ready",
        warnings: [],
      }],
      managedDirectories: [{
        directoryId: "dir-1",
        name: "workspace",
        rootPath: "/tmp/workspace",
        source: "cli",
        createdAt: "2026-06-27T10:00:00.000Z",
        updatedAt: "2026-06-27T10:00:00.000Z",
        status: "ready",
        capabilities: ["list", "read_files"],
        include: [],
        exclude: [],
        maxDepth: 3,
        fileCount: 2,
        directoryCount: 1,
        totalSizeBytes: 2048,
        sampleEntries: [],
        warnings: [],
      }],
      attachmentWarnings: ["Skipped one unsupported attachment."],
      systemEvent: {
        type: "system_event",
        eventId: "evt-1",
        source: "calendar",
        eventName: "meeting.started",
        receivedAt: "2026-06-27T10:00:00.000Z",
        summary: "Meeting started.",
        payload: {},
      },
      systemEventRequestedAction: "Prepare meeting notes.",
      approvalRequired: true,
      approvalState: "pending",
    });

    const stateView = buildAgentStateView(state, {
      activeTools: ["read_files", "read_files", " search_files "],
    });
    expect(stateView.toolLoad).toMatchObject({
      status: "partial",
      loaded: ["read_files"],
      missing: ["patch_files"],
    });
    expect(stateView.context.tools).toMatchObject({
      active: ["read_files", "search_files"],
      lastLoad: {
        status: "partial",
        loaded: ["read_files"],
        missing: ["patch_files"],
      },
    });
    expect(stateView.context.tools).not.toHaveProperty("inputSchema");
    expect(stateView.context.tools).not.toHaveProperty("schemas");
    expect(stateView.context.run ?? {}).not.toHaveProperty("toolLoad");
    expect(stateView.context.git?.session.attachments).toBeUndefined();
    expect(stateView.context.run ?? {}).not.toHaveProperty("attachments");
    expect(stateView.attachments).toMatchObject({
      incoming: [{ id: "doc-1", name: "invoice.pdf", status: "registered" }],
      prepared: [{ id: "prepared-1", name: "invoice.pdf", status: "ready" }],
      managedFiles: [{ id: "file-1", name: "invoice.pdf", status: "ready" }],
      managedDirectories: [{ id: "dir-1", name: "workspace", status: "ready" }],
      warnings: ["Skipped one unsupported attachment."],
    });
    expect(stateView.context.git?.current.task?.assets).toEqual([{
      assetId: "A-20260627-0001",
      role: "input",
      kind: "document",
      name: "invoice.pdf",
      path: "uploads/invoice.pdf",
    }]);
    expect(stateView.systemEvent).toMatchObject({
      source: "calendar",
      eventName: "meeting.started",
      requestedAction: "Prepare meeting notes.",
      approvalRequired: true,
      approvalState: "pending",
    });
    expect(stateView.context.run ?? {}).not.toHaveProperty("systemEvent");
  });
});

function message(
  seq: number,
  messageId: string,
  role: "user" | "assistant",
  text: string,
) {
  return {
    seq,
    messageId,
    role,
    at: `2026-07-13T10:00:0${seq}.000Z`,
    text,
  };
}
