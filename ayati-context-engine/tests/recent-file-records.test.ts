import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  RunStepFilesystemCompletionEvidence,
  RunStepToolCall,
} from "../src/contracts.js";
import {
  MAX_RECENT_FILES,
  readRecentFiles,
} from "../src/repositories/recent-file-records.js";
import {
  createWorkstreamServiceFixture,
  workState,
  type WorkstreamServiceFixture,
} from "./simple-workstream-repository-fixtures.js";

const fixtures: WorkstreamServiceFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (fixture) => await fixture.dispose()));
});

describe("recent file records", () => {
  it("projects only verified complete historical reads and links them to exact turns", async () => {
    const fixture = await createFixture("recent-files");
    const completePath = join(fixture.root, "archive", "field-brief.txt");
    const partialPath = join(fixture.root, "archive", "partial.txt");
    const unverifiedPath = join(fixture.root, "archive", "unverified.txt");
    const sourceRunId = fixture.prepared.run.runId;
    await recordReadStep(fixture, [
      readCall(completePath, {
        callId: "call-complete",
        coverage: "complete",
        verificationPassed: true,
      }),
      readCall(partialPath, {
        callId: "call-partial",
        coverage: "partial",
        verificationPassed: true,
      }),
      readCall(unverifiedPath, {
        callId: "call-unverified",
        coverage: "complete",
        verificationPassed: false,
      }),
    ], "2026-07-25T08:00:01.000Z");
    await finalize(fixture, "I read the field brief.", "first");

    fixture.prepared = await fixture.service.prepareAgentRun({
      requestId: "REQ-recent-files-follow-up",
      timezone: "Asia/Kolkata",
      agentId: "local",
      scopeKey: "default",
      role: "user",
      content: "What else did that file say?",
      at: "2026-07-25T08:01:00.000Z",
    });

    const recent = readRecentFiles(fixture.database, {
      streamId: fixture.prepared.stream.streamId,
    });
    expect(recent).toEqual([{
      name: "field-brief.txt",
      path: completePath,
      lastReadAt: "2026-07-25T08:00:01.000Z",
      evidenceRef: `run:${sourceRunId}:step:1:call:call-complete`,
      coverage: "complete",
      status: "navigation_only",
      requestSeq: 1,
      responseSeq: 2,
      sizeBytes: 376,
      lineCount: 8,
      sha256: "sha256-field-brief",
    }]);
    expect(fixture.prepared.context.stream?.recentFiles).toEqual(recent);
  });

  it("deduplicates by canonical path, keeps the newest read, and caps output", async () => {
    const fixture = await createFixture("recent-files-bounds");
    const paths = Array.from(
      { length: MAX_RECENT_FILES + 2 },
      (_, index) => join(fixture.root, "docs", `file-${index + 1}.txt`),
    );
    await recordReadStep(
      fixture,
      paths.map((path, index) => readCall(path, {
        callId: `call-${index + 1}`,
        coverage: "complete",
        verificationPassed: true,
      })),
      "2026-07-25T08:00:01.000Z",
    );
    await finalize(fixture, "I read the files.", "bounds-first");

    fixture.prepared = await fixture.service.prepareAgentRun({
      requestId: "REQ-recent-files-bounds-second",
      timezone: "Asia/Kolkata",
      agentId: "local",
      scopeKey: "default",
      role: "user",
      content: "Read the first file again.",
      at: "2026-07-25T08:01:00.000Z",
    });
    await recordReadStep(
      fixture,
      [readCall(paths[0]!, {
        callId: "call-newest",
        coverage: "complete",
        verificationPassed: true,
      })],
      "2026-07-25T08:01:01.000Z",
    );
    await finalize(
      fixture,
      "I reread the first file.",
      "bounds-second",
      "2026-07-25T08:01:02.000Z",
    );

    const recent = readRecentFiles(fixture.database, {
      streamId: fixture.prepared.stream.streamId,
    });
    expect(recent).toHaveLength(MAX_RECENT_FILES);
    expect(recent[0]).toMatchObject({
      path: paths[0],
      lastReadAt: "2026-07-25T08:01:01.000Z",
      evidenceRef: expect.stringContaining("call-newest"),
      requestSeq: 3,
      responseSeq: 4,
    });
    expect(new Set(recent.map((file) => file.path)).size).toBe(MAX_RECENT_FILES);
  });
});

async function createFixture(name: string): Promise<WorkstreamServiceFixture> {
  const fixture = await createWorkstreamServiceFixture(name, "Read the requested file.");
  fixtures.push(fixture);
  return fixture;
}

async function recordReadStep(
  fixture: WorkstreamServiceFixture,
  calls: RunStepToolCall[],
  createdAt: string,
): Promise<void> {
  await fixture.service.recordRunStep({
    requestId: `${fixture.prepared.run.runId}:step:1`,
    runId: fixture.prepared.run.runId,
    record: {
      version: 1,
      step: 1,
      status: "completed",
      summary: "Read the requested files.",
      decision: { kind: "act" },
      action: { calls: calls.map((call) => call.callId) },
      toolCalls: calls,
      verification: { passed: true },
      createdAt,
    },
  });
}

function readCall(
  path: string,
  input: {
    callId: string;
    coverage: "complete" | "partial";
    verificationPassed: boolean;
  },
): RunStepToolCall {
  const evidence: RunStepFilesystemCompletionEvidence = {
    kind: "file_read",
    path,
    requestedPath: path,
    coverage: input.coverage,
    contentAvailable: true,
    change: "observed",
    tool: "read_files",
    step: 1,
    callId: input.callId,
    sizeBytes: 376,
    lineCount: 8,
    sha256: "sha256-field-brief",
  };
  return {
    callId: input.callId,
    tool: "read_files",
    purpose: "Read the requested file.",
    toolPurpose: "read",
    toolEffect: "read_only",
    status: "success",
    input: { files: [{ path }] },
    output: { results: [{ ok: true, filePath: path }] },
    verification: {
      version: 1,
      status: input.verificationPassed ? "passed" : "failed",
      method: "tool_contract",
      contract: "tool_result_v2",
      summary: input.verificationPassed
        ? "The exact read call passed deterministic verification."
        : "The exact read call failed deterministic verification.",
      checks: [],
      facts: [],
      ...(!input.verificationPassed ? {
        failure: {
          code: "READ_UNVERIFIED",
          message: "The exact read call failed deterministic verification.",
        },
      } : {}),
    },
    verificationPassed: input.verificationPassed,
    completionEvidence: [evidence],
  };
}

async function finalize(
  fixture: WorkstreamServiceFixture,
  response: string,
  suffix: string,
  at = "2026-07-25T08:00:02.000Z",
): Promise<void> {
  await fixture.service.finalizeRun({
    requestId: `REQ-${suffix}-finalize`,
    runId: fixture.prepared.run.runId,
    outcome: "done",
    stopReason: "completed",
    assistantResponse: response,
    streamSummary: "File reading completed.",
    summary: "File reading completed.",
    validation: "passed",
    workState: workState({
      status: "done",
      summary: "File reading completed.",
    }),
    at,
  });
}
