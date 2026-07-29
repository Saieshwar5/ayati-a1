import { describe, expect, it } from "vitest";
import type { ContextEngineMachineContext } from "../../src/context-engine/index.js";
import {
  BOUND_WORKSTREAM_PROMPT_LIMITS,
  buildBoundWorkstreamPromptContext,
} from "../../src/ivec/agent-runner/bound-workstream-prompt-context.js";
import { contextEngineFixture } from "../fixtures/agent-context.js";

const WORKSTREAM_ID = "W-20260729-0001";
const REQUEST_ID = "R-0002";

describe("buildBoundWorkstreamPromptContext", () => {
  it("omits workstream context before the run is bound", () => {
    expect(buildBoundWorkstreamPromptContext(contextEngineFixture())).toBeUndefined();
    expect(buildBoundWorkstreamPromptContext(undefined)).toBeUndefined();
  });

  it("projects the exact selected contract and only the five newest bounded progress summaries", () => {
    const context = boundContext();
    const acceptance = Array.from(
      { length: 20 },
      (_, index) => `Criterion ${index + 1}  keeps exact spacing.`,
    );
    const constraints = Array.from(
      { length: 20 },
      (_, index) => `Constraint ${index + 1}`,
    );
    context.workstream!.selectedRequest = {
      ...context.workstream!.selectedRequest!,
      request: "Create the site.\nPreserve this exact request body.",
      acceptance,
      constraints,
      lifecycleNote: "Selected for this run.",
    };
    context.workstream!.summary = "s".repeat(
      BOUND_WORKSTREAM_PROMPT_LIMITS.summaryChars + 100,
    );
    context.workstream!.blockers = Array.from(
      { length: 10 },
      (_, index) => `Blocker ${index + 1}`,
    );
    context.workstream!.recentProgress = Array.from(
      { length: 7 },
      (_, index) => ({
        runId: `RUN-${index + 1}`,
        outcome: "incomplete" as const,
        summary: `Progress ${index + 1}`,
        validationSummary: `Validation ${index + 1}`,
        nextAction: `Next ${index + 1}`,
        commit: `commit-${index + 1}`,
        finalizedAt: `2026-07-${String(index + 1).padStart(2, "0")}T10:00:00.000Z`,
      }),
    );

    const projected = buildBoundWorkstreamPromptContext(context);

    expect(projected).toMatchObject({
      id: WORKSTREAM_ID,
      title: "Lumen Finch Website",
      purpose: "Build and maintain the website.",
      lifecycleStatus: "active",
      currentFocus: "Validate browser interaction.",
      nextAction: "Run browser validation.",
      request: {
        id: REQUEST_ID,
        title: "Validate the website",
        status: "active",
        request: "Create the site.\nPreserve this exact request body.",
        acceptance,
        constraints,
        lifecycleNote: "Selected for this run.",
      },
    });
    expect(projected?.activeRequest).toBeUndefined();
    expect(projected?.summary).toHaveLength(
      BOUND_WORKSTREAM_PROMPT_LIMITS.summaryChars,
    );
    expect(projected?.summary.endsWith("...")).toBe(true);
    expect(projected?.blockers).toHaveLength(
      BOUND_WORKSTREAM_PROMPT_LIMITS.blockerCount,
    );
    expect(projected?.recentProgress.map((entry) => entry.runId)).toEqual([
      "RUN-7",
      "RUN-6",
      "RUN-5",
      "RUN-4",
      "RUN-3",
    ]);
    expect(projected?.recentProgress[0]).toEqual({
      runId: "RUN-7",
      outcome: "incomplete",
      summary: "Progress 7",
      validation: "Validation 7",
      next: "Next 7",
    });
    expect(projected?.recentProgress[0]).not.toHaveProperty("commit");
    expect(projected?.recentProgress[0]).not.toHaveProperty("finalizedAt");
  });

  it("keeps the selected request primary and identifies a different active request", () => {
    const context = boundContext();
    context.workstream!.selectedRequest = {
      ...context.workstream!.selectedRequest!,
      status: "queued",
    };
    context.workstream!.currentRequest = {
      id: "R-0001",
      title: "Create the initial website",
      status: "active",
      request: "Create the initial website.",
      acceptance: ["The initial website exists."],
      constraints: [],
    };

    expect(buildBoundWorkstreamPromptContext(context)).toMatchObject({
      request: {
        id: REQUEST_ID,
        title: "Validate the website",
        status: "queued",
      },
      activeRequest: {
        id: "R-0001",
        title: "Create the initial website",
        status: "active",
      },
    });
  });

  it("fails closed when bound identities or lifecycle projections disagree", () => {
    const cases: Array<{
      mutate: (context: ContextEngineMachineContext) => void;
      code: string;
    }> = [
      {
        mutate: (context) => {
          delete context.workstream!.selectedRequest;
        },
        code: "BOUND_REQUEST_CONTEXT_MISSING",
      },
      {
        mutate: (context) => {
          context.workstream!.selectedRequest!.id = "R-OTHER";
        },
        code: "BOUND_REQUEST_CONTEXT_MISMATCH",
      },
      {
        mutate: (context) => {
          context.workstream!.workstreamId = "W-OTHER";
        },
        code: "BOUND_WORKSTREAM_CONTEXT_MISMATCH",
      },
      {
        mutate: (context) => {
          context.workstream!.selectedRequest!.status = "done";
        },
        code: "BOUND_REQUEST_CONTEXT_TERMINAL",
      },
      {
        mutate: (context) => {
          context.workstream!.lifecycleStatus = "paused";
        },
        code: "BOUND_WORKSTREAM_CONTEXT_MISMATCH",
      },
      {
        mutate: (context) => {
          context.workstream!.currentRequest!.id = "R-OTHER";
        },
        code: "BOUND_REQUEST_CONTEXT_MISMATCH",
      },
      {
        mutate: (context) => {
          context.run!.run.workstreamBinding!.requestId = "R-OTHER";
        },
        code: "BOUND_REQUEST_CONTEXT_MISMATCH",
      },
    ];

    for (const testCase of cases) {
      const context = boundContext();
      testCase.mutate(context);
      expect(() => buildBoundWorkstreamPromptContext(context)).toThrow(
        testCase.code,
      );
    }
  });
});

function boundContext(): ContextEngineMachineContext {
  const context = contextEngineFixture({
    runId: "RUN-CURRENT",
    message: "Continue browser validation.",
  });
  context.current.routing = {
    status: "bound",
    workstreamId: WORKSTREAM_ID,
    requestId: REQUEST_ID,
    branch: "main",
  };
  context.run!.run.workstreamBinding = {
    workstreamId: WORKSTREAM_ID,
    requestId: REQUEST_ID,
    boundAt: "2026-07-29T10:00:00.000Z",
  };
  context.workstream = {
    ref: `workstream:${WORKSTREAM_ID}`,
    workstreamId: WORKSTREAM_ID,
    title: "Lumen Finch Website",
    objective: "Build and maintain the website.",
    summary: "Initial files exist; browser validation remains.",
    workstreamStatus: "in_progress",
    lifecycleStatus: "active",
    repositoryHealth: "ready",
    currentFocus: "Validate browser interaction.",
    blockers: [],
    next: "Run browser validation.",
    currentRequest: {
      id: REQUEST_ID,
      title: "Validate the website",
      status: "active",
      request: "Validate the website.",
      acceptance: ["The main interaction works."],
      constraints: ["Use the existing implementation."],
    },
    selectedRequest: {
      id: REQUEST_ID,
      title: "Validate the website",
      status: "active",
      request: "Validate the website.",
      acceptance: ["The main interaction works."],
      constraints: ["Use the existing implementation."],
      lifecycleNote: "Current active request.",
    },
    recentProgress: [],
    resources: [],
  };
  return context;
}
