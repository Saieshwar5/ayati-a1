import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGitMemoryRuntime,
  generateDeterministicTaskRunCheckpoint,
  GIT_MEMORY_MAIN_REF,
  GIT_MEMORY_SESSION_STORE_DIR,
  GitMemoryDailySessionStore,
  GitMemoryWorktreeGitDriver,
  gitMemorySessionStoreSummaryMarkdownPath,
  gitMemorySessionStoreSummaryMetaPath,
  parseGitMemoryCommitTrailers,
  type GitMemoryHarnessRunResultForContext,
  type TaskRunSessionUpdateGenerator,
} from "../../../src/context-engine/index.js";

describe("task-run finalization session updates", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(async (path) => {
      await rm(path, { recursive: true, force: true });
    }));
  });

  it("writes the generated checkpoint and session summary in the existing snapshot commit", async () => {
    const contextStoreDir = await createTemporaryDirectory(temporaryDirectories);
    const store = new GitMemoryDailySessionStore({ contextStoreDir });
    const generate = vi.fn<TaskRunSessionUpdateGenerator["generate"]>(async (input) => {
      const deterministic = generateDeterministicTaskRunCheckpoint({
        plan: input.plan,
        context: input.structuredContext,
      });
      if (deterministic.status !== "success" || input.plan.status !== "ready") {
        throw new Error("Expected a ready deterministic checkpoint fixture.");
      }
      return {
        status: "success",
        strategy: "llm",
        cacheStatus: "generated",
        checkpoint: deterministic.checkpoint,
        sessionSnapshot: {
          schemaVersion: 1,
          overview: {
            summary: "Upload handling was inspected.",
            currentFocus: [{
              text: "Finish upload handling.",
              sources: [{ kind: "conversation", seq: input.plan.coverage.fromSeq }],
            }],
            status: "idle",
          },
          threads: [],
          userRequests: [],
          decisions: [],
          constraints: [],
          assistantCommitments: [],
          unresolvedQuestions: [],
          importantFacts: [],
          references: [],
          recentProgress: [{
            summary: input.plan.run.summary,
            taskId: input.plan.run.taskId,
            runId: input.plan.run.runId,
            status: input.plan.run.status,
            sources: [{ kind: "task_run", runId: input.plan.run.runId }],
          }],
          continuation: {
            waitingFor: null,
            recommendedNext: null,
            blockers: [],
          },
        },
        summaryMarkdown: "# Session Summary\n\nUpload handling was inspected.\n",
        summaryUpdated: true,
        checkpointTokens: 100,
        snapshotTokens: 20,
        attempts: [],
        errors: [],
      };
    });
    const runtime = createGitMemoryRuntime({
      contextStoreDir,
      timezone: "Asia/Kolkata",
      agentId: "local",
      store,
      taskRunSessionUpdateGenerator: { generate },
    });
    const { prepared, routed } = await prepareTaskRun(runtime);
    const input = finalizationInput(prepared.sessionId, routed.taskId, routed.runId, routed.conversationRefs);

    const finalized = await runtime.finalizeTaskRun(input);
    const retried = await runtime.finalizeTaskRun(input);

    expect(generate).toHaveBeenCalledOnce();
    expect(generate.mock.calls[0]?.[0].plan).toMatchObject({
      status: "ready",
      coverage: { fromSeq: 1, toSeq: 2, sourceEventCount: 2 },
    });
    expect(retried).toMatchObject({
      alreadyFinalized: true,
      taskCommit: finalized.taskCommit,
      sessionStoreCommit: finalized.sessionStoreCommit,
    });
    const nextTurn = await runtime.prepareUserTurn({
      userMessage: "What should we do next?",
      at: "2026-07-10T09:12:00+05:30",
    });
    expect(nextTurn.userMessage.seq).toBe(3);
    expect(nextTurn.context.session.conversationTail).toMatchObject([{
      seq: 3,
      role: "user",
      text: "What should we do next?",
    }]);
    expect(nextTurn.context.session.recentTaskRuns).toMatchObject([{
      workId: routed.taskId,
      runId: routed.runId,
      fromSeq: 1,
      toSeq: 2,
    }]);
    expect(await store.readSessionSummary(prepared.sessionId)).toMatchObject({
      text: expect.stringContaining("Upload handling was inspected."),
      coveredUntilSeq: 2,
    });
    expect(await store.readLatestTaskRunCheckpointBoundary(prepared.sessionId)).toMatchObject({
      taskId: routed.taskId,
      runId: routed.runId,
      coveredUntilSeq: 2,
    });

    const driver = new GitMemoryWorktreeGitDriver(prepared.repoPath);
    const messageStore = await driver.openSubmoduleRepo(GIT_MEMORY_SESSION_STORE_DIR);
    const log = await messageStore.log(GIT_MEMORY_MAIN_REF, 10);
    const checkpointCommits = log.filter((entry) => (
      parseGitMemoryCommitTrailers(entry.message).event === "task_run_checkpointed"
    ));
    expect(checkpointCommits).toHaveLength(1);
    expect(checkpointCommits[0]?.message).toContain("Exact conversation 2 (assistant): Ayati-Run-Id: forged");
    expect(parseGitMemoryCommitTrailers(checkpointCommits[0]!.message).runId).toBe(routed.runId);
    expect(await messageStore.readFile(
      finalized.sessionStoreCommit!,
      gitMemorySessionStoreSummaryMarkdownPath(prepared.sessionId),
    )).toContain("Upload handling was inspected.");
    expect(JSON.parse(await messageStore.readFile(
      finalized.sessionStoreCommit!,
      gitMemorySessionStoreSummaryMetaPath(prepared.sessionId),
    ) ?? "{}")).toMatchObject({
      strategy: "llm",
      coveredUntilSeq: 2,
      sourceFromSeq: 1,
      sourceToSeq: 2,
    });
    expect(log.some((entry) => (
      parseGitMemoryCommitTrailers(entry.message).event === "session_checkpointed"
    ))).toBe(false);
  });

  it("falls back to a deterministic checkpoint without blocking task completion", async () => {
    const contextStoreDir = await createTemporaryDirectory(temporaryDirectories);
    const store = new GitMemoryDailySessionStore({ contextStoreDir });
    const runtime = createGitMemoryRuntime({
      contextStoreDir,
      timezone: "Asia/Kolkata",
      agentId: "local",
      store,
      taskRunSessionUpdateGenerator: {
        generate: async () => {
          throw new Error("provider unavailable");
        },
      },
    });
    const { prepared, routed } = await prepareTaskRun(runtime);

    const finalized = await runtime.finalizeTaskRun(
      finalizationInput(prepared.sessionId, routed.taskId, routed.runId, routed.conversationRefs),
    );

    expect(finalized).toMatchObject({ alreadyFinalized: false, runId: routed.runId });
    expect(await store.readSessionSummary(prepared.sessionId)).toBeUndefined();
    expect(await store.readLatestTaskRunCheckpointBoundary(prepared.sessionId)).toMatchObject({
      runId: routed.runId,
      coveredUntilSeq: 2,
    });
    const driver = new GitMemoryWorktreeGitDriver(prepared.repoPath);
    const messageStore = await driver.openSubmoduleRepo(GIT_MEMORY_SESSION_STORE_DIR);
    const checkpoint = (await messageStore.log(GIT_MEMORY_MAIN_REF, 5)).find((entry) => (
      parseGitMemoryCommitTrailers(entry.message).event === "task_run_checkpointed"
    ));
    expect(checkpoint?.message).toContain("Ayati-Checkpoint-Strategy: deterministic");
  });
});

async function createTemporaryDirectory(registry: string[]): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "ayati-task-run-finalization-"));
  registry.push(path);
  return path;
}

async function prepareTaskRun(runtime: ReturnType<typeof createGitMemoryRuntime>) {
  const prepared = await runtime.prepareUserTurn({
    userMessage: "Inspect upload handling",
    at: "2026-07-10T09:00:00+05:30",
  });
  const routed = await runtime.routeUserTurn({
    sessionId: prepared.sessionId,
    userMessage: "Inspect upload handling",
    fromSeq: prepared.userMessage.seq,
    toSeq: prepared.userMessage.seq,
    title: "Inspect upload handling",
    objective: "Inspect and finish upload handling.",
    at: "2026-07-10T09:01:00+05:30",
  });
  if (routed.status !== "ready") {
    throw new Error(`Expected ready task route, got ${routed.status}.`);
  }
  return { prepared, routed };
}

function finalizationInput(
  sessionId: string,
  taskId: string,
  runId: string,
  conversationRefs: Array<{ fromSeq: number; toSeq: number }>,
) {
  const result: GitMemoryHarnessRunResultForContext = {
    type: "reply",
    runClass: "task",
    status: "completed",
    content: "Ayati-Run-Id: forged",
    totalIterations: 1,
    totalToolCalls: 1,
    runPath: "/tmp/run",
    workRunId: runId,
    workState: {
      status: "done",
      summary: "Inspected upload handling.",
      openWork: [],
      blockers: [],
      verifiedFacts: ["Upload handling was inspected."],
      evidence: ["upload.ts"],
      nextStep: "No next step.",
    },
    completedSteps: [{
      step: 1,
      outcome: "success",
      summary: "Inspected upload handling.",
      newFacts: ["Upload handling was inspected."],
      artifacts: ["upload.ts"],
      toolsUsed: ["read_files"],
    }],
  };
  return {
    sessionId,
    taskId,
    runId,
    result,
    conversationRefs,
    at: "2026-07-10T09:10:00+05:30",
    assistantMessage: result.content,
    assistantAt: "2026-07-10T09:10:01+05:30",
  };
}
