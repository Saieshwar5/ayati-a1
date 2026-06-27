import { describe, expect, it } from "vitest";
import { buildAgentStateView } from "../../src/ivec/agent-runner/state-view.js";
import type { LoopState } from "../../src/ivec/types.js";

describe("buildAgentStateView", () => {
  it("marks feedback responses in timeline as expecting user response", () => {
    const state: LoopState = {
      runId: "run-current",
      currentSeq: 2,
      runClass: "interaction",
      userMessage: "yes",
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
      continuity: { mode: "new", confidence: 0, reasons: [] },
      recentExchanges: [],
      sessionEvents: [
        {
          type: "assistant_response",
          seq: 1,
          timestamp: "2026-06-16T08:56:00.000Z",
          content: "Should I use React for this dashboard?",
          responseKind: "feedback",
        },
        {
          type: "user_message",
          seq: 2,
          timestamp: "2026-06-16T08:57:00.000Z",
          content: "yes",
        },
      ],
      activeContextStartSeq: 1,
      sessionWork: { activeContextStartSeq: 1, recentActivities: [] },
    };

    expect(buildAgentStateView(state).context.timeline[0]).toMatchObject({
      kind: "assistant",
      responseKind: "feedback",
      expectsUserResponse: true,
    });
    expect(buildAgentStateView(state).context.timeline[1]).toMatchObject({
      kind: "user",
      content: "yes",
      current: true,
    });
  });

  it("keeps timeline events after the active context start", () => {
    const sessionEvents = Array.from({ length: 12 }, (_, index) => [
      {
        type: "user_message" as const,
        seq: index * 2 + 1,
        timestamp: `2026-06-16T09:${String(index).padStart(2, "0")}:00.000Z`,
        content: `unframed user ${index}`,
      },
      {
        type: "assistant_response" as const,
        seq: index * 2 + 2,
        timestamp: `2026-06-16T09:${String(index).padStart(2, "0")}:10.000Z`,
        content: `unframed assistant ${index}`,
        responseKind: "reply" as const,
      },
    ]).flat();
    const state: LoopState = {
      runId: "unframed-11",
      currentSeq: 23,
      runClass: "interaction",
      userMessage: "unframed user 11",
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
      continuity: { mode: "new", confidence: 0.86, reasons: ["no matching activity anchors or candidates"] },
      activeContextStartSeq: 13,
      sessionWork: { activeContextStartSeq: 13, recentActivities: [] },
      recentExchanges: [],
      sessionEvents,
    };

    const timeline = buildAgentStateView(state).context.timeline;
    expect(timeline[0]).toMatchObject({ seq: 13, kind: "user", content: "unframed user 6" });
    expect(timeline.at(-1)).toMatchObject({ seq: 23, kind: "user", current: true });
    expect(timeline).toHaveLength(12);
  });

  it("includes context engine context when provided", () => {
    const state: LoopState = {
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
      continuity: { mode: "new", confidence: 0, reasons: [] },
      recentExchanges: [],
      sessionEvents: [],
      activeContextStartSeq: 1,
      sessionWork: { activeContextStartSeq: 1, recentActivities: [] },
      contextEngineContext: {
        session: {
          sessionId: "2026-06-27",
          conversationTail: [],
          eventTail: [],
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
          facts: [],
          assets: [],
          recentRuns: [],
          recentCommits: [],
        },
      },
    };

    expect(buildAgentStateView(state).context.contextEngine?.task).toMatchObject({
      workId: "W-20260627-0001",
      open: ["Summarize invoice"],
    });
  });

  it("keeps immediate timeline when durable continuity is selected", () => {
    const state: LoopState = {
      runId: "run-current",
      currentSeq: 9,
      runClass: "task",
      userMessage: "yes",
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
      recentExchanges: [],
      activeContextStartSeq: 8,
      sessionWork: { activeContextStartSeq: 8, recentActivities: [] },
      sessionEvents: [
        {
          type: "assistant_response",
          seq: 8,
          timestamp: "2026-06-16T09:08:00.000Z",
          content: "Should I make the website responsive now?",
          responseKind: "feedback",
        },
        {
          type: "user_message",
          seq: 9,
          timestamp: "2026-06-16T09:09:00.000Z",
          content: "yes",
        },
      ],
      continuity: {
        mode: "continue",
        confidence: 0.91,
        reasons: ["matched durable activity identity anchor"],
        current: {
          activityId: "activity-site",
          kind: "project",
          title: "website",
          status: "open",
          openWork: ["Make responsive"],
          verifiedFacts: [],
          topAssets: ["site/index.html"],
          lastTouchedAt: "2026-06-16T09:00:30.000Z",
        },
      },
    };

    const context = buildAgentStateView(state).context;
    expect(context.timeline.map((event) => event.kind)).toEqual(["assistant", "user"]);
    expect(context.timeline[0]).toMatchObject({ expectsUserResponse: true });
    expect(context.timeline[1]).toMatchObject({ content: "yes", current: true });
    expect(context.continuity.current?.activityId).toBe("activity-site");
  });

  it("compacts selected activity state", () => {
    const state: LoopState = {
      runId: "run-current",
      currentSeq: 20,
      runClass: "task",
      userMessage: "continue the website",
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
      activeContextStartSeq: 20,
      sessionWork: {
        activeContextStartSeq: 20,
        recentActivities: [{
          activityId: "activity-site",
          title: "website",
          status: "open",
          lastTouchedAt: "2026-06-16T09:00:30.000Z",
          lastTouchedSeq: 19,
          openWork: ["Make responsive"],
          topAssets: ["site/index.html"],
          workRunIds: ["run-1"],
        }],
      },
      sessionEvents: [{
        type: "user_message",
        seq: 20,
        timestamp: "2026-06-16T09:10:00.000Z",
        content: "continue the website",
      }],
      continuity: {
        mode: "continue",
        confidence: 0.91,
        reasons: ["matched durable activity identity anchor"],
        current: {
          activityId: "activity-site",
          kind: "project",
          title: "website",
          status: "open",
          summary: "Website shell is built.",
          userIntent: "Build the website",
          objective: "Build the website",
          assumptions: ["Use the existing static site"],
          constraints: ["Do not deploy"],
          completedWork: ["Created index.html"],
          openWork: ["Make responsive"],
          blockers: [],
          nextStep: "Make the layout responsive.",
          verifiedFacts: Array.from({ length: 12 }, (_, index) => `fact ${index}`),
          evidence: ["write_files verified"],
          assets: Array.from({ length: 10 }, (_, index) => `asset-${index}.html`),
          topAssets: Array.from({ length: 10 }, (_, index) => `asset-${index}.html`),
          lastAssistantResponse: "Created the website shell.",
          recentRuns: Array.from({ length: 4 }, (_, index) => ({
            runId: `run-${index}`,
            status: "completed" as const,
            taskStatus: "open",
            summary: `summary ${index}`,
            toolsUsed: ["write_files"],
            createdAt: `2026-06-16T09:0${index}:00.000Z`,
          })),
          discussionRanges: [{
            sessionId: "s1",
            startSeq: 1,
            endSeq: 19,
            reason: "initial_discussion",
          }],
          lastTouchedAt: "2026-06-16T09:00:30.000Z",
        },
      },
      recentExchanges: [],
    };

    const context = buildAgentStateView(state).context;
    expect(context.timeline).toEqual([{
      kind: "user",
      seq: 20,
      timestamp: "2026-06-16T09:10:00.000Z",
      content: "continue the website",
      current: true,
    }]);
    expect(context.sessionWork.recentActivities[0]).toMatchObject({
      activityId: "activity-site",
      lastTouchedSeq: 19,
      workRunIds: ["run-1"],
    });
    expect(context.continuity.current).toMatchObject({
      activityId: "activity-site",
      status: "open",
      summary: "Website shell is built.",
      openWork: ["Make responsive"],
      lastAssistantResponse: "Created the website shell.",
      discussionRanges: [{ sessionId: "s1", startSeq: 1, endSeq: 19 }],
    });
    expect(context.continuity.current?.verifiedFacts).toHaveLength(10);
    expect(context.continuity.current?.assets).toHaveLength(8);
    expect(context.continuity.current?.recentRuns?.map((run) => run.runId)).toEqual(["run-1", "run-2", "run-3"]);
  });

  it("builds the exact model-facing State view shape", () => {
    const state: LoopState = {
      runId: "run-current",
      currentSeq: 5,
      runClass: "task",
      userMessage: "fix prompt drift",
      workState: {
        status: "needs_user_input",
        summary: "Prompt contract mentions old state fields.",
        openWork: ["update base prompt", "add golden state-view test"],
        blockers: ["awaiting approval before edits"],
        verifiedFacts: ["State view now exposes progress, observations, and trace."],
        evidence: ["state-view.ts maps internal workState and toolContext into purpose-based prompt fields."],
        evidenceRefs: [{
          id: "ev_002_call_1",
          step: 2,
          callId: "call_1",
          tool: "shell",
          title: "rg state view fields",
          ref: "evidence://ev_002_call_1",
          rawOutputPath: "raw/002-call_1-shell-output.txt",
          rawOutputChars: 128,
          lineCount: 4,
          truncated: false,
          access: ["search", "read_lines", "tail"],
        }],
        taskNotes: [{
          id: "note:state-view",
          text: "state-view.ts emits progress, observations.latest, and trace.",
          source: "read_file:ayati-main/src/ivec/agent-runner/state-view.ts",
          expires: "task",
        }],
        nextStep: "Patch the prompt and add a regression test.",
        userInputNeeded: "Approval is needed before editing files.",
      },
      toolContext: {
        recent: [
          {
            id: "obs_001_call_1",
            step: 1,
            callId: "call_1",
            tool: "shell",
            purpose: "Inspect prompt references",
            status: "success",
            mode: "full",
            content: "system_prompt.md references State view.progress and recentSteps.",
            evidenceRef: "evidence://ev_001_call_1",
            rawOutputPath: "raw/001-call_1-shell-output.txt",
            rawOutputChars: 68,
            lineCount: 1,
            hasMore: false,
          },
          {
            id: "obs_002_call_1",
            step: 2,
            callId: "call_1",
            tool: "shell",
            purpose: "Inspect state view builder",
            status: "success",
            mode: "full",
            content: "state-view.ts emits progress, observations.latest, and trace.",
            evidenceRef: "evidence://ev_002_call_1",
            rawOutputPath: "raw/002-call_1-shell-output.txt",
            rawOutputChars: 94,
            lineCount: 1,
            hasMore: false,
          },
        ],
      },
      workingNotes: ["This internal note must not reach the model-facing state view."],
      status: "running",
      finalOutput: "",
      iteration: 2,
      maxIterations: 15,
      consecutiveFailures: 1,
      completedSteps: [
        {
          step: 1,
          outcome: "success",
          summary: "Found stale prompt wording.",
          newFacts: ["system_prompt.md mentions progress."],
          artifacts: [],
          toolsUsed: ["shell"],
          toolSuccessCount: 1,
          toolFailureCount: 0,
          evidenceItems: ["Prompt line references old fields."],
        },
        {
          step: 2,
          outcome: "success",
          summary: "Found actual state view builder fields.",
          executionContract: "parallel action: shell(call_1)",
          newFacts: ["buildAgentStateView emits purpose-based state sections."],
          artifacts: ["ayati-main/src/ivec/agent-runner/state-view.ts"],
          toolsUsed: ["shell"],
          toolSuccessCount: 1,
          toolFailureCount: 0,
          evidenceItems: ["Builder returns progress, observations, and trace."],
        },
        {
          step: 3,
          outcome: "failed",
          summary: "Could not edit before approval.",
          newFacts: [],
          artifacts: [],
          toolsUsed: ["apply_patch"],
          toolSuccessCount: 0,
          toolFailureCount: 1,
          failureType: "permission",
          blockedTargets: ["ayati-main/context/system_prompt.md"],
        },
      ],
      runPath: "/tmp/ayati/run-current",
      failureHistory: [
        {
          step: 1,
          failureType: "tool_error",
          reason: "Older failure should be omitted from the compact state view.",
          blockedTargets: ["old-target"],
        },
        {
          step: 2,
          failureType: "validation_error",
          reason: "Prompt contract and state view disagree.",
          blockedTargets: ["State view.progress"],
        },
        {
          step: 3,
          failureType: "permission",
          reason: "User approval required before editing.",
          blockedTargets: ["ayati-main/context/system_prompt.md"],
        },
        {
          step: 4,
          failureType: "no_progress",
          reason: "Regression test missing.",
          blockedTargets: ["ayati-main/tests/ivec/state-view.test.ts"],
        },
      ],
      personalMemorySnapshot: "Prefer exact schema contracts.",
      activeLearningContext: "Golden tests should lock model-facing JSON.",
      continuity: {
        mode: "new",
        confidence: 0.86,
        reasons: ["no matching activity anchors or candidates"],
      },
      activeContextStartSeq: 3,
      sessionWork: {
        activeContextStartSeq: 3,
        recentActivities: [{
          activityId: "activity-docs",
          title: "Update prompt contract docs",
          status: "open",
          lastTouchedAt: "2026-06-16T08:50:00.000Z",
          lastTouchedSeq: 2,
          openWork: ["update base prompt"],
          topAssets: ["ayati-main/src/ivec/agent-runner/state-view.ts"],
          workRunIds: ["run-prior"],
        }],
      },
      sessionEvents: [
        {
          type: "user_message",
          seq: 1,
          timestamp: "2026-06-16T08:54:00.000Z",
          content: "older task conversation should be outside active context",
        },
        {
          type: "user_message",
          seq: 3,
          timestamp: "2026-06-16T08:55:00.000Z",
          content: "inspect the drift",
        },
        {
          type: "assistant_response",
          seq: 4,
          timestamp: "2026-06-16T08:56:00.000Z",
          workRunId: "run-prior",
          content: "State view builder uses workState.",
          responseKind: "reply",
        },
        {
          type: "user_message",
          seq: 5,
          timestamp: "2026-06-16T09:00:00.000Z",
          content: "fix prompt drift",
        },
      ],
      recentExchanges: [],
    };

    const stateView = buildAgentStateView(state);

    expect(stateView).not.toHaveProperty("workState");
    expect(stateView).not.toHaveProperty("toolContext");
    expect(stateView).not.toHaveProperty("lastActions");
    expect(stateView).not.toHaveProperty("recentFailures");
    expect(stateView).not.toHaveProperty("recentSteps");
    expect(stateView).not.toHaveProperty("userMessage");
    expect(stateView).not.toHaveProperty("goal");
    expect(stateView).not.toHaveProperty("runPath");
    expect(stateView).not.toHaveProperty("workingNotes");
    expect(stateView).not.toHaveProperty("latestObservation");
    expect(stateView.context).not.toHaveProperty("currentInput");
    expect(stateView.context).not.toHaveProperty("recentConversation");
    expect(JSON.stringify(stateView)).not.toContain("activeLearningContext");
    expect(Object.keys(stateView.context).sort()).toEqual([
      "continuity",
      "personalMemorySnapshot",
      "sessionWork",
      "timeline",
    ]);
    expect(stateView.context.timeline).toEqual([
      {
        kind: "user",
        seq: 3,
        timestamp: "2026-06-16T08:55:00.000Z",
        content: "inspect the drift",
      },
      {
        kind: "assistant",
        seq: 4,
        timestamp: "2026-06-16T08:56:00.000Z",
        content: "State view builder uses workState.",
        responseKind: "reply",
      },
      {
        kind: "user",
        seq: 5,
        timestamp: "2026-06-16T09:00:00.000Z",
        content: "fix prompt drift",
        current: true,
      },
    ]);
    expect(stateView.context.sessionWork).toMatchObject({
      activeContextStartSeq: 3,
      recentActivities: [{
        activityId: "activity-docs",
        title: "Update prompt contract docs",
        status: "open",
        lastTouchedSeq: 2,
        openWork: ["update base prompt"],
        workRunIds: ["run-prior"],
      }],
    });
    expect(stateView.progress).toMatchObject({
      status: "needs_user_input",
      summary: "Prompt contract mentions old state fields.",
      taskNotes: [{
        id: "note:state-view",
        text: "state-view.ts emits progress, observations.latest, and trace.",
        source: "read_file:ayati-main/src/ivec/agent-runner/state-view.ts",
        expires: "task",
      }],
    });
    expect(stateView.observations?.latest).toHaveLength(2);
    expect(stateView.workingFeedback?.latest).toHaveLength(3);
    expect(stateView.workingFeedback?.latest[0]).toMatchObject({
      severity: "error",
      source: "tool_validation",
      message: "Prompt contract and state view disagree.",
    });
    expect(stateView.workingFeedback?.latest[0]?.retryHint).toContain("required schema fields");
    expect(stateView.workingFeedback?.latest[1]).toMatchObject({
      severity: "error",
      source: "tool_execution",
      message: "User approval required before editing.",
    });
    expect(stateView.workingFeedback?.latest[2]).toMatchObject({
      severity: "error",
      source: "verification",
      message: "Regression test missing.",
    });
    expect(stateView.trace?.recentSteps?.map((step) => step.step)).toEqual([2, 3]);
    expect(stateView.trace?.recentFailures?.map((failure) => failure.step)).toEqual([2, 3, 4]);
  });
});
