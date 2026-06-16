import { describe, expect, it } from "vitest";
import { buildAgentStateView } from "../../src/ivec/agent-runner/state-view.js";
import type { LoopState } from "../../src/ivec/types.js";

describe("buildAgentStateView", () => {
  it("builds the exact model-facing State view shape", () => {
    const state: LoopState = {
      runId: "run-current",
      runClass: "task",
      userMessage: "fix prompt drift",
      workState: {
        status: "needs_user_input",
        summary: "Prompt contract mentions old progress fields.",
        openWork: ["update base prompt", "add golden state-view test"],
        blockers: ["awaiting approval before edits"],
        verifiedFacts: ["State view uses workState, lastActions, toolContext, and latestObservation."],
        evidence: ["state-view.ts builds top-level workState and toolContext fields."],
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
            content: "state-view.ts emits workState, toolContext, latestObservation, lastActions, and recentFailures.",
            evidenceRef: "evidence://ev_002_call_1",
            rawOutputPath: "raw/002-call_1-shell-output.txt",
            rawOutputChars: 94,
            lineCount: 1,
            hasMore: false,
          },
        ],
      },
      latestObservation: {
        id: "obs_002_call_1",
        step: 2,
        callId: "call_1",
        tool: "shell",
        purpose: "Inspect state view builder",
        status: "success",
        mode: "full",
        content: "state-view.ts emits workState, toolContext, latestObservation, lastActions, and recentFailures.",
        evidenceRef: "evidence://ev_002_call_1",
        rawOutputPath: "raw/002-call_1-shell-output.txt",
        rawOutputChars: 94,
        lineCount: 1,
        hasMore: false,
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
          newFacts: ["buildAgentStateView emits workState and toolContext."],
          artifacts: ["ayati-main/src/ivec/agent-runner/state-view.ts"],
          toolsUsed: ["shell"],
          toolSuccessCount: 1,
          toolFailureCount: 0,
          evidenceItems: ["Builder returns workState, toolContext, latestObservation, lastActions, and recentFailures."],
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
      recentExchanges: [
        {
          runId: "run-current",
          user: {
            timestamp: "2026-06-16T09:00:00.000Z",
            content: "current exchange should be filtered",
          },
          assistant: {
            timestamp: "2026-06-16T09:00:05.000Z",
            content: "filtered",
          },
        },
        {
          runId: "run-prior",
          user: {
            timestamp: "2026-06-16T08:55:00.000Z",
            content: "inspect the drift",
          },
          assistant: {
            timestamp: "2026-06-16T08:56:00.000Z",
            content: "State view builder uses workState.",
            responseKind: "assistant_message",
          },
        },
      ],
    };

    const stateView = buildAgentStateView(state);

    expect(stateView).not.toHaveProperty("progress");
    expect(stateView).not.toHaveProperty("recentSteps");
    expect(stateView).not.toHaveProperty("userMessage");
    expect(stateView).not.toHaveProperty("goal");
    expect(stateView).not.toHaveProperty("runPath");
    expect(stateView).not.toHaveProperty("workingNotes");
    expect(JSON.stringify(stateView, null, 2)).toMatchInlineSnapshot(`
      "{
        "context": {
          "currentInput": "fix prompt drift",
          "activeFocus": [],
          "sessionFocusCards": [],
          "attentionShelf": [],
          "personalMemorySnapshot": "Prefer exact schema contracts.",
          "activeLearningContext": "Golden tests should lock model-facing JSON.",
          "recentConversation": [
            {
              "runId": "run-prior",
              "user": {
                "timestamp": "2026-06-16T08:55:00.000Z",
                "content": "inspect the drift"
              },
              "assistant": {
                "timestamp": "2026-06-16T08:56:00.000Z",
                "content": "State view builder uses workState.",
                "responseKind": "assistant_message"
              }
            }
          ]
        },
        "workState": {
          "status": "needs_user_input",
          "summary": "Prompt contract mentions old progress fields.",
          "openWork": [
            "update base prompt",
            "add golden state-view test"
          ],
          "blockers": [
            "awaiting approval before edits"
          ],
          "verifiedFacts": [
            "State view uses workState, lastActions, toolContext, and latestObservation."
          ],
          "evidence": [
            "state-view.ts builds top-level workState and toolContext fields."
          ],
          "evidenceRefs": [
            {
              "id": "ev_002_call_1",
              "step": 2,
              "callId": "call_1",
              "tool": "shell",
              "title": "rg state view fields",
              "ref": "evidence://ev_002_call_1",
              "rawOutputPath": "raw/002-call_1-shell-output.txt",
              "rawOutputChars": 128,
              "lineCount": 4,
              "truncated": false,
              "access": [
                "search",
                "read_lines",
                "tail"
              ]
            }
          ],
          "nextStep": "Patch the prompt and add a regression test.",
          "userInputNeeded": "Approval is needed before editing files."
        },
        "toolContext": {
          "recent": [
            {
              "id": "obs_001_call_1",
              "step": 1,
              "callId": "call_1",
              "tool": "shell",
              "purpose": "Inspect prompt references",
              "status": "success",
              "mode": "full",
              "content": "system_prompt.md references State view.progress and recentSteps.",
              "evidenceRef": "evidence://ev_001_call_1",
              "rawOutputPath": "raw/001-call_1-shell-output.txt",
              "rawOutputChars": 68,
              "lineCount": 1,
              "hasMore": false
            },
            {
              "id": "obs_002_call_1",
              "step": 2,
              "callId": "call_1",
              "tool": "shell",
              "purpose": "Inspect state view builder",
              "status": "success",
              "mode": "full",
              "content": "state-view.ts emits workState, toolContext, latestObservation, lastActions, and recentFailures.",
              "evidenceRef": "evidence://ev_002_call_1",
              "rawOutputPath": "raw/002-call_1-shell-output.txt",
              "rawOutputChars": 94,
              "lineCount": 1,
              "hasMore": false
            }
          ]
        },
        "latestObservation": {
          "id": "obs_002_call_1",
          "step": 2,
          "callId": "call_1",
          "tool": "shell",
          "purpose": "Inspect state view builder",
          "status": "success",
          "mode": "full",
          "content": "state-view.ts emits workState, toolContext, latestObservation, lastActions, and recentFailures.",
          "evidenceRef": "evidence://ev_002_call_1",
          "rawOutputPath": "raw/002-call_1-shell-output.txt",
          "rawOutputChars": 94,
          "lineCount": 1,
          "hasMore": false
        },
        "lastActions": [
          {
            "step": 2,
            "status": "success",
            "summary": "Found actual state view builder fields.",
            "toolsUsed": [
              "shell"
            ],
            "evidence": [
              "Builder returns workState, toolContext, latestObservation, lastActions, and recentFailures."
            ],
            "artifacts": [
              "ayati-main/src/ivec/agent-runner/state-view.ts"
            ]
          },
          {
            "step": 3,
            "status": "failed",
            "summary": "Could not edit before approval.",
            "toolsUsed": [
              "apply_patch"
            ],
            "failureType": "permission",
            "blockedTargets": [
              "ayati-main/context/system_prompt.md"
            ]
          }
        ],
        "recentFailures": [
          {
            "step": 2,
            "failureType": "validation_error",
            "reason": "Prompt contract and state view disagree.",
            "blockedTargets": [
              "State view.progress"
            ]
          },
          {
            "step": 3,
            "failureType": "permission",
            "reason": "User approval required before editing.",
            "blockedTargets": [
              "ayati-main/context/system_prompt.md"
            ]
          },
          {
            "step": 4,
            "failureType": "no_progress",
            "reason": "Regression test missing.",
            "blockedTargets": [
              "ayati-main/tests/ivec/state-view.test.ts"
            ]
          }
        ]
      }"
    `);
  });
});
