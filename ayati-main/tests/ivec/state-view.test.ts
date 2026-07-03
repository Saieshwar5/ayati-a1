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
      sessionId: "2026-06-27",
      conversationTail: [],
      activityTail: [],
      recentCommits: [{
        commit: "abc123",
        subject: "ayati: checkpoint session",
        event: "session_checkpointed",
      }],
      assetCount: 0,
    },
    focus: {
      status: "active",
      ref: "refs/heads/work/W-20260627-0001-analyze-invoice",
      workId: "W-20260627-0001",
    },
    task: {
      ref: "refs/heads/work/W-20260627-0001-analyze-invoice",
      workId: "W-20260627-0001",
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
        workId: "W-20260627-0001",
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
        workId: "W-20260627-0001",
      }],
      recentEvidence: [{
        runId: "R-20260627-0001",
        workId: "W-20260627-0001",
        step: 1,
        tool: "read_file",
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
    runClass: "task",
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
  it("exposes git context as the durable task source", () => {
    const state = createLoopState({
      harnessContext: createHarnessContext({
        contextEngine: createGitContext(),
      }),
    });

    const context = buildAgentStateView(state).context;
    expect(context.gitContext?.task).toMatchObject({
      workId: "W-20260627-0001",
      open: ["Summarize invoice"],
      facts: [{ text: "Invoice has three line items.", source: "ev-001" }],
    });
    expect(context.git?.current.task).toMatchObject({
      identity: {
        workId: "W-20260627-0001",
        title: "Analyze invoice",
      },
      state: {
        open: ["Summarize invoice"],
        facts: [{ text: "Invoice has three line items.", source: "ev-001" }],
      },
      activity: {
        recentRuns: [{
          runId: "R-20260627-0001",
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
    expect(context.git?.session).not.toHaveProperty("recentCommits");
    expect(context.git?.session).not.toHaveProperty("conversationTail");
    expect(context.git?.session).not.toHaveProperty("conversationMarkdownTail");
    expect(context.git?.session).not.toHaveProperty("summary");
    expect(context.git?.current).not.toHaveProperty("session");
    expect(context.git?.current.task).not.toHaveProperty("conversationMarkdownTail");
    expect(context.git?.current.task).not.toHaveProperty("recentCommits");
    expect(context.git?.current.task).not.toHaveProperty("recentRuns");
    expect(context.git?.current.task).not.toHaveProperty("recentEvidence");
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
      retryHint: expect.stringContaining("git_context_activate_task_for_turn"),
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

  it("projects repair-coded failure history into scratch feedback and trace", () => {
    const state = createLoopState({
      failureHistory: [{
        step: 1,
        failureType: "validation_error",
        reason: "No active task exists. Create and activate the first task before using work tools.",
        blockedTargets: ["write_files"],
        repairCode: "R_FRESH_SESSION_NEEDS_TASK",
        repair: {
          code: "R_FRESH_SESSION_NEEDS_TASK",
          message: "No active task exists yet. Normal work tools cannot run before task creation.",
          blockedTargets: ["write_files"],
          allowedNextActions: [
            "Call git_context_create_task_for_turn with title, objective, and reason.",
          ],
        },
      }],
    });

    const stateView = buildAgentStateView(state);
    expect(stateView.workingFeedback?.latest[0]).toMatchObject({
      severity: "error",
      source: "tool_validation",
      code: "R_FRESH_SESSION_NEEDS_TASK",
      message: "No active task exists yet. Normal work tools cannot run before task creation.",
      retryHint: "Call git_context_create_task_for_turn with title, objective, and reason.",
      repair: {
        code: "R_FRESH_SESSION_NEEDS_TASK",
        blockedTargets: ["write_files"],
      },
    });
    expect(stateView.context.scratch?.feedback?.latest[0]).toMatchObject({
      code: "R_FRESH_SESSION_NEEDS_TASK",
      repair: {
        code: "R_FRESH_SESSION_NEEDS_TASK",
      },
    });
    expect(stateView.context.scratch?.trace?.recentFailures?.[0]).toMatchObject({
      code: "R_FRESH_SESSION_NEEDS_TASK",
      blockedTargets: ["write_files"],
    });
  });

  it("builds timeline from git conversation tail", () => {
    const state = createLoopState({
      currentSeq: 3,
      userMessage: "yes",
      harnessContext: createHarnessContext({
        contextEngine: createGitContext({
          session: {
            sessionId: "2026-06-27",
            activityTail: [],
            assetCount: 0,
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

  it("groups personal memory without mixing it into git, tools, or scratch context", () => {
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
    expect(stateView.context.scratch).toBeUndefined();
    expect(Object.keys(stateView.context).sort()).toEqual([
      "git",
      "gitContext",
      "personal",
      "personalMemorySnapshot",
      "runtimeMode",
      "timeline",
    ]);
  });

  it("projects compact runtime mode context", () => {
    const state = createLoopState({
      runId: "",
      harnessContext: createHarnessContext({
        contextEngine: createGitContext({
          focus: {
            status: "none",
          },
          task: undefined,
        }),
      }),
    });

    expect(buildAgentStateView(state).context.runtimeMode).toMatchObject({
      name: "fresh_session_routing",
      why: "No active task exists.",
      allowed: [
        "direct_reply",
        "git_context_create_task_for_turn",
        "git_context_ask_clarification_for_turn",
      ],
      blocked: [
        "normal_work_tools",
        "decision_load_tools",
        "task_search_or_activation",
      ],
      repairCode: "R_FRESH_SESSION_NEEDS_TASK",
    });
  });

  it("keeps progress, observations, and trace independent from context source", () => {
    const state = createLoopState({
      workState: {
        status: "needs_user_input",
        summary: "Need approval before editing.",
        openWork: ["Patch prompt"],
        blockers: ["Approval required"],
        verifiedFacts: ["State view uses git context."],
        evidence: ["state-view.ts"],
        userInputNeeded: "Can I edit the prompt?",
      },
      toolContext: {
        recent: [{
          id: "obs-1",
          step: 1,
          callId: "call-1",
          tool: "read_file",
          status: "success",
          mode: "summary",
          retention: "while_relevant",
          content: "Read state-view.ts.",
          hasMore: false,
        }],
      },
      completedSteps: [{
        step: 1,
        outcome: "success",
        summary: "Inspected state view.",
        newFacts: ["State view uses git context."],
        artifacts: [],
        toolsUsed: ["read_file"],
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
    expect(stateView.context.scratch?.progress).toMatchObject({
      status: "needs_user_input",
      summary: "Need approval before editing.",
      userInputNeeded: "Can I edit the prompt?",
    });
    expect(stateView.observations?.latest).toHaveLength(1);
    expect((stateView.context.scratch?.observations as { latest?: unknown[] } | undefined)?.latest).toHaveLength(1);
    expect(stateView.observations?.latest[0]?.retention).toBe("while_relevant");
    expect(stateView.trace?.recentSteps?.map((step) => step.step)).toEqual([1]);
    expect((stateView.context.scratch?.trace as { recentSteps?: Array<{ step: number }> } | undefined)?.recentSteps?.map((step) => step.step)).toEqual([1]);
    expect(stateView.workingFeedback?.latest[0]).toMatchObject({
      source: "tool_execution",
      message: "Approval required before editing.",
    });
    expect((stateView.context.scratch?.feedback as { latest?: Array<{ source: string }> } | undefined)?.latest?.[0])
      .toMatchObject({ source: "tool_execution" });
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
          toolNames: ["read_file"],
          groups: ["filesystem"],
        },
        loaded: ["read_file"],
        alreadyActive: [],
        evicted: [],
        missing: ["write_file"],
        message: "Loaded read_file; write_file was unavailable.",
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
      activeTools: ["read_file", "read_file", " search_files "],
    });
    expect(stateView.toolLoad).toMatchObject({
      status: "partial",
      loaded: ["read_file"],
      missing: ["write_file"],
    });
    expect(stateView.context.tools).toMatchObject({
      active: ["read_file", "search_files"],
      lastLoad: {
        status: "partial",
        loaded: ["read_file"],
        missing: ["write_file"],
      },
    });
    expect(stateView.context.tools).not.toHaveProperty("inputSchema");
    expect(stateView.context.tools).not.toHaveProperty("schemas");
    expect(stateView.context.scratch?.toolLoad).toMatchObject({
      status: "partial",
      loaded: ["read_file"],
      missing: ["write_file"],
    });
    expect(stateView.attachments?.incoming?.[0]).toMatchObject({
      id: "doc-1",
      name: "invoice.pdf",
      status: "registered",
    });
    expect(stateView.context.git?.session.attachments).toBeUndefined();
    expect(stateView.context.scratch?.attachments).toMatchObject({
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
    expect(stateView.context.scratch?.systemEvent).toMatchObject({
      source: "calendar",
      eventName: "meeting.started",
      requestedAction: "Prepare meeting notes.",
      approvalRequired: true,
      approvalState: "pending",
    });
  });
});
