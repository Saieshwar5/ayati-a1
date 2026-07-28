import { describe, expect, it } from "vitest";
import type {
  RunOutcome,
  RunWorkState,
  WorkstreamCompletionRecord,
} from "../src/contracts.js";
import {
  reduceSimpleWorkstreamContext,
} from "../src/workstreams/simple-workstream-context-reducer.js";
import type { WorkstreamCard } from "../src/workstreams/workstream-card.js";
import type { WorkstreamRequest } from "../src/workstreams/workstream-request.js";

describe("simple workstream context reducer", () => {
  it.each([
    {
      name: "incomplete",
      outcome: "incomplete" as const,
      validation: "not_applicable" as const,
      hasVerifiedChanges: false,
      summary: "The implementation is partially complete.",
      next: "Complete the remaining implementation.",
    },
    {
      name: "failed with verified changes",
      outcome: "failed" as const,
      validation: "failed" as const,
      hasVerifiedChanges: true,
      summary: "The verified partial change remains, but the run failed.",
      next: "Review the failure and continue the request.",
    },
  ])("keeps request.md unchanged after a $name run", ({
    outcome,
    validation,
    hasVerifiedChanges,
    summary,
    next,
  }: {
    outcome: RunOutcome;
    validation: "passed" | "failed" | "not_applicable";
    hasVerifiedChanges: boolean;
    summary: string;
    next: string;
  }) => {
    const request = activeRequest();
    const result = reduceSimpleWorkstreamContext({
      workstreamCard: activeWorkstreamCard(),
      workstreamRequest: request,
      workState: runWorkState(summary, next),
      outcome,
      validation,
      summary,
      next,
      completion: incompleteCompletion(),
      hasVerifiedChanges,
    });

    expect(result.workstreamRequest).toEqual(request);
    expect(result.workstreamCard).toMatchObject({
      currentRequest: request.id,
      currentSnapshot: summary,
      currentFocus: next,
    });
    expect(result.commitRequired).toBe(true);
    expect(result.contextWrites.map((write) => write.path)).toEqual([
      "workstream.md",
    ]);
  });
});

function activeWorkstreamCard(): WorkstreamCard {
  return {
    schema: "ayati.workstream/v2",
    id: "W-20260728-0001",
    title: "Request lifecycle",
    status: "active",
    currentRequest: "R-0001",
    purpose: "Keep request contracts separate from per-run progress.",
    currentSnapshot: "The request is active and no run progress is recorded yet.",
    currentFocus: "Advance the active request.",
    blockers: [],
    workingAgreements: [],
  };
}

function activeRequest(): WorkstreamRequest {
  return {
    schema: "ayati.request/v2",
    id: "R-0001",
    title: "Separate request and run progress",
    status: "active",
    createdAt: "2026-07-28T10:00:00+05:30",
    source: "user",
    request: "Keep ordinary run progress out of the durable request contract.",
    acceptance: ["Incomplete and failed runs leave the request contract unchanged."],
    constraints: [],
    outcome: "Not completed yet.",
  };
}

function runWorkState(summary: string, nextAction: string): RunWorkState {
  return {
    runId: "RUN-9054007D-0000000001",
    revision: 1,
    afterStep: 1,
    updateReason: "run_paused",
    updatedAt: "2026-07-28T10:05:00+05:30",
    status: "in_progress",
    summary,
    plan: [],
    importantContext: [],
    nextAction,
  };
}

function incompleteCompletion(): WorkstreamCompletionRecord {
  return {
    accepted: false,
    resources: [],
    missing: [],
    failures: [],
    criteria: [],
  };
}
