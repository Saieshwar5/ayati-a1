import { describe, expect, it } from "vitest";
import {
  collectWorkstreamRoutingEvidence,
} from "../../src/ivec/agent-runner/workstream-routing-evidence.js";
import { createEntryVirtualModeState } from "../../src/ivec/agent-runner/virtual-mode.js";
import type { LoopState } from "../../src/ivec/types.js";
import { contextEngineFixture } from "../fixtures/agent-context.js";

describe("workstream routing evidence", () => {
  it("keeps repository history as navigation rather than direct binding evidence", () => {
    const current = state();
    current.toolContext = {
      recent: [],
      toolCalls: [{
        step: 1,
        callId: "history-log",
        tool: "git_read",
        purpose: "Find recent durable work that may explain the continuation.",
        input: { repositoryPath: "/tmp/workstreams", operation: "log", limit: 5 },
        status: "success",
        output: JSON.stringify({
          commits: [{
            commit: "a".repeat(40),
            workstreamId: "W-20260729-0001",
            requestId: "R-0002",
            outcome: "incomplete",
          }],
        }),
        evidenceRef: "run:RUN-1:step:1:call:history-log",
        stepRef: { runId: "RUN-1", step: 1, callId: "history-log" },
      }],
    };

    expect(collectWorkstreamRoutingEvidence(current)).toEqual({
      observed: false,
      currentRunObserved: false,
      references: [],
      currentRunReferences: [],
      workstreams: [],
      resources: [],
    });
  });

  it("derives resource ownership and filesystem paths from an exact workstream read", () => {
    const current = state();
    current.toolContext = {
      recent: [],
      toolCalls: [{
        step: 1,
        callId: "read-workstream",
        tool: "git_context_read_workstream",
        purpose: "Inspect the exact workstream and its resources.",
        input: { workstreamId: "W-20260729-0001" },
        status: "success",
        output: JSON.stringify({
          workstream: {
            workstreamId: "W-20260729-0001",
            head: "a".repeat(40),
          },
          context: {
            currentRequest: {
              id: "R-0001",
              status: "done",
            },
            resources: [{
              resource: {
                resourceId: "RES-0123456789ABCDEF01234567",
                locator: {
                  kind: "filesystem",
                  path: "/tmp/workspace/balcony-herbs.md",
                },
              },
              access: "mutate",
            }],
          },
          opened: true,
        }),
        evidenceRef: "run:RUN-1:step:1:call:read-workstream",
        stepRef: {
          runId: "RUN-1",
          step: 1,
          callId: "read-workstream",
        },
      }],
    };

    expect(collectWorkstreamRoutingEvidence(current)).toEqual({
      observed: true,
      currentRunObserved: true,
      references: ["run:RUN-1:step:1:call:read-workstream"],
      currentRunReferences: ["run:RUN-1:step:1:call:read-workstream"],
      workstreams: [{
        workstreamId: "W-20260729-0001",
        head: "a".repeat(40),
        reasons: ["inspected_workstream"],
        requestIds: ["R-0001"],
        inspected: true,
        references: ["run:RUN-1:step:1:call:read-workstream"],
      }],
      resources: [{
        resourceId: "RES-0123456789ABCDEF01234567",
        workstreamIds: ["W-20260729-0001"],
        locators: [
          JSON.stringify({
            kind: "filesystem",
            path: "/tmp/workspace/balcony-herbs.md",
          }),
        ],
        filesystemPaths: ["/tmp/workspace/balcony-herbs.md"],
        references: ["run:RUN-1:step:1:call:read-workstream"],
      }],
    });
  });

  it("uses exact focused work as activation evidence without treating it as a current-run search", () => {
    const current = state();
    current.harnessContext.contextEngine!.agentStream.focusedWorkstream = {
      ref: "workstreams/W-20260729-0001@" + "b".repeat(40),
      workstreamId: "W-20260729-0001",
      title: "Balcony herbs",
      objective: "Maintain the balcony herb guide.",
      summary: "The planting guide remains unfinished.",
      workstreamStatus: "in_progress",
      lifecycleStatus: "active",
      repositoryHealth: "ready",
      blockers: [],
      selectedRequest: {
        id: "R-0001",
        title: "Update the guide",
        status: "active",
        request: "Update the balcony herb guide.",
        acceptance: ["The guide is current."],
        constraints: [],
      },
      recentProgress: [],
      resources: [],
    };

    expect(collectWorkstreamRoutingEvidence(current)).toEqual({
      observed: true,
      currentRunObserved: false,
      references: ["stream-focus:W-20260729-0001/R-0001"],
      currentRunReferences: [],
      workstreams: [{
        workstreamId: "W-20260729-0001",
        head: "b".repeat(40),
        reasons: ["stream_focus"],
        requestIds: ["R-0001"],
        inspected: true,
        references: ["stream-focus:W-20260729-0001/R-0001"],
      }],
      resources: [],
    });
  });
});

function state(): LoopState {
  const contextEngine = contextEngineFixture({
    runId: "RUN-1",
    message: "Update balcony-herbs.md.",
  });
  return {
    runId: "RUN-1",
    currentSeq: 1,
    inputKind: "user_message",
    userMessage: "Update balcony-herbs.md.",
    workState: {
      status: "in_progress",
      summary: "Run started.",
      plan: [],
      importantContext: [],
    },
    workStateRuntime: {
      revision: 0,
      afterStep: 0,
      updateReason: "initial",
    },
    status: "running",
    finalOutput: "",
    iteration: 1,
    maxIterations: 20,
    consecutiveFailures: 0,
    completedSteps: [],
    runPath: "",
    failureHistory: [],
    virtualMode: createEntryVirtualModeState(),
    harnessContext: {
      contextEngine: {
        ...contextEngine,
        current: {
          ...contextEngine.current,
          runId: "RUN-1",
          routing: { status: "unbound" },
        },
      },
    },
  };
}
