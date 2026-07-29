import { describe, expect, it } from "vitest";
import type { LlmTurnInput } from "../../src/core/contracts/llm-protocol.js";
import type { AgentPromptStateView } from "../../src/ivec/agent-runner/prompt-context.js";
import {
  contextLaneTargets,
  decideContextPreparationTrigger,
  forcedSynchronousBarrier,
  planFlexibleLaneAllocation,
} from "../../src/ivec/context-preparation/policy.js";
import { buildPromptContextManifest } from "../../src/ivec/context-preparation/prompt-manifest.js";
import { estimateTurnInputTokens } from "../../src/prompt/token-estimator.js";
import { buildCoreCapsule } from "../../src/ivec/agent-runner/core-capsule.js";
import { emptyHotContextProjection } from "../../src/ivec/hot-context/index.js";

describe("parallel context preparation policy", () => {
  it("uses flexible 15/25/60 lane targets without overriding total admission", () => {
    expect(contextLaneTargets(100_000)).toEqual({
      system: 15_000,
      session: 25_000,
      work: 60_000,
    });
    const borrowed = planFlexibleLaneAllocation({
      hardInputTokens: 100_000,
      demand: { system: 10_000, session: 10_000, work: 80_000 },
    });
    expect(borrowed.allocated).toEqual({ system: 10_000, session: 10_000, work: 80_000 });
    expect(borrowed.borrowed.work).toBe(20_000);
    expect(borrowed.fitsTotalBudget).toBe(true);

    const overflowing = planFlexibleLaneAllocation({
      hardInputTokens: 100_000,
      demand: { system: 20_000, session: 30_000, work: 60_001 },
    });
    expect(overflowing.fitsTotalBudget).toBe(false);
    expect(Object.values(overflowing.allocated).reduce((sum, value) => sum + value, 0)).toBe(100_000);
  });

  it("starts at 55K or predicted soft pressure and computes exact/local forced barriers", () => {
    expect(decideContextPreparationTrigger({
      measuredInputTokens: 54_999,
      preparationInputTokens: 55_000,
      softInputTokens: 70_000,
      preparationLeadTokens: 15_000,
    })).toMatchObject({ triggered: false, reason: "below_threshold" });
    expect(decideContextPreparationTrigger({
      measuredInputTokens: 55_000,
      preparationInputTokens: 55_000,
      softInputTokens: 70_000,
      preparationLeadTokens: 15_000,
    })).toMatchObject({ triggered: true, reason: "preparation_threshold" });
    expect(decideContextPreparationTrigger({
      measuredInputTokens: 54_000,
      preparationInputTokens: 60_000,
      softInputTokens: 68_000,
      preparationLeadTokens: 15_000,
    })).toMatchObject({ triggered: true, reason: "predicted_soft_pressure" });
    expect(forcedSynchronousBarrier({
      admissionLimitTokens: 95_000,
      softInputTokens: 70_000,
      recoveryTargetTokens: 60_000,
    })).toBe(85_000);
    expect(forcedSynchronousBarrier({
      admissionLimitTokens: 100_000,
      softInputTokens: 70_000,
      recoveryTargetTokens: 60_000,
    })).toBe(90_000);
  });

  it("builds a deterministic pre-serialization manifest with exact system and tool parts", () => {
    const stateView = promptState();
    const turnInput: LlmTurnInput = {
      messages: [
        { role: "system", content: "SYSTEM RULES" },
        { role: "user", content: `State view:\n${JSON.stringify(stateView)}` },
      ],
      tools: [{
        name: "read_files",
        description: "Read exact files.",
        inputSchema: { type: "object", properties: { paths: { type: "array" } } },
      }],
    };
    const first = buildPromptContextManifest({ stateView, turnInput });
    const second = buildPromptContextManifest({ stateView, turnInput });
    expect(first).toEqual(second);
    expect(first.totalLocalEstimate).toBe(estimateTurnInputTokens(turnInput).totalTokens);
    expect(first.toolSchemaTokens).toBeGreaterThan(0);
    expect(first.parts.find((part) => part.id === "system.message.0")).toMatchObject({
      lane: "system",
      retention: "exact",
      content: "SYSTEM RULES",
    });
    expect(first.parts.find((part) => part.id === "system.tool_schemas")).toMatchObject({
      lane: "system",
      retention: "exact",
    });
    expect(first.parts.find((part) => part.id === "session.core.seq.1")).toMatchObject({
      retention: "summarizable",
      sourceRefs: ["seq:1"],
    });
    expect(first.parts.find((part) => part.id === "session.core.metadata")).toMatchObject({
      lane: "session",
      retention: "referenceable",
    });
    expect(first.parts.find((part) => part.id === "session.hot.available")).toMatchObject({
      lane: "session",
      retention: "referenceable",
    });
    expect(first.parts.find((part) => part.id === "work.core.current")).toMatchObject({
      retention: "exact",
    });
    expect(first.parts.find((part) => part.id === "work.run.work_state")).toMatchObject({
      retention: "exact",
    });
    expect(first.parts.find((part) => part.id === "work.run.workspace_root")).toMatchObject({
      lane: "work",
      retention: "exact",
      content: "/opt/ayati/runtime/workspace",
      sourceRefs: [],
    });
    expect(first.parts.find((part) => part.id === "work.run.bound_workstream")).toMatchObject({
      lane: "work",
      retention: "exact",
      sourceRefs: [
        "request:R-0001",
        "run:RUN-EARLIER",
        "workstream:W-20260729-0001",
      ],
    });
    expect(first.parts.find((part) => part.id === "work.run.verified_outcomes")).toMatchObject({
      lane: "work",
      retention: "exact",
      sourceRefs: ["call:write-config", "step:2"],
    });
    expect(first.parts.find((part) => part.id === "work.core.current")?.sourceRefs).toContain("seq:3");
    expect(first.parts.find((part) => part.id === "work.core.current")?.sourceRefs)
      .toContain("run:RUN-OLD:step:1:call:read-document");
  });

});

function promptState(): AgentPromptStateView {
  return {
    context: {
      core: buildCoreCapsule({
        revision: "context:test",
        runId: "RUN-1",
        timeline: [
          { kind: "user", seq: 1, timestamp: "2026-07-20T00:00:00.000Z", content: "Earlier request" },
          { kind: "assistant", seq: 2, timestamp: "2026-07-20T00:00:01.000Z", content: "Earlier reply" },
          { kind: "user", seq: 3, timestamp: "2026-07-20T00:00:02.000Z", content: "CURRENT", current: true },
        ],
        routing: { status: "unbound" },
        activeDocuments: [{
          name: "document.txt",
          path: "/workspace/document.txt",
          lastReadAt: "2026-07-19T23:59:00.000Z",
          evidenceRef: "run:RUN-OLD:step:1:call:read-document",
          freshness: "unchecked",
        }],
      }),
      hot: emptyHotContextProjection(),
      run: {
        workspaceRoot: "/opt/ayati/runtime/workspace",
        boundWorkstream: {
          id: "W-20260729-0001",
          title: "Lumen Finch Website",
          purpose: "Build and maintain the website.",
          summary: "The initial files exist.",
          lifecycleStatus: "active",
          blockers: [],
          request: {
            id: "R-0001",
            title: "Create the initial website",
            status: "active",
            request: "Create the website.",
            acceptance: ["The website works."],
            constraints: [],
          },
          recentProgress: [{
            runId: "RUN-EARLIER",
            outcome: "incomplete",
            summary: "Created the files.",
            validation: "Browser validation remains.",
          }],
        },
        workState: {
          status: "in_progress",
          summary: "Continue safely.",
          plan: [],
          importantContext: [],
        },
        verifiedOutcomes: [{
          kind: "file.written",
          subject: "/workspace/config.ts",
          actualKind: "file",
          source: {
            step: 2,
            callId: "write-config",
            tool: "write_files",
          },
        }],
      },
    },
  };
}
