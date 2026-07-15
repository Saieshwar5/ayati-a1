import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInitialHarnessContext } from "../../src/ivec/harness-context.js";
import type { LoopState, StepSummary } from "../../src/ivec/types.js";
import { evaluateTaskCompletion, isTaskCompletionAvailable } from "../../src/ivec/agent-runner/task-completion-policy.js";

describe("task completion policy", () => {
  let workspace: string;
  let previousWorkspace: string | undefined;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "ayati-task-completion-"));
    previousWorkspace = process.env["AYATI_WORKSPACE_DIR"];
    process.env["AYATI_WORKSPACE_DIR"] = workspace;
  });

  afterEach(async () => {
    if (previousWorkspace === undefined) delete process.env["AYATI_WORKSPACE_DIR"];
    else process.env["AYATI_WORKSPACE_DIR"] = previousWorkspace;
    await rm(workspace, { recursive: true, force: true });
  });

  it("accepts verified files and directories and sets WorkState done", async () => {
    await mkdir(join(workspace, "site"), { recursive: true });
    await writeFile(join(workspace, "site/index.html"), "<h1>Chenko</h1>", "utf-8");
    const state = taskState({
      workState: {
        status: "not_done",
        summary: "Website files were written.",
        verifiedFacts: ["write_files read-back hash matched for site/index.html"],
        evidence: [],
        artifacts: [join(workspace, "site"), join(workspace, "site/index.html")],
      },
    });

    const result = await evaluateTaskCompletion(state, {
      summary: "Created the Chenko restaurant homepage.",
      assets: [
        { path: "site", kind: "directory", description: "Root website directory" },
        { path: "site/index.html", kind: "file", description: "Main restaurant homepage" },
      ],
    });

    expect(result.accepted).toBe(true);
    expect(result.nextWorkState).toMatchObject({
      status: "done",
      summary: "Created the Chenko restaurant homepage.",
      openWork: [],
      blockers: [],
    });
    if (!result.accepted) throw new Error("Expected completion acceptance.");
    expect(result.assets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        resolvedPath: join(workspace, "site/index.html"),
        description: "Main restaurant homepage",
      }),
    ]));
  });

  it("rejects missing assets and deterministically records remaining work", async () => {
    const state = taskState();
    const result = await evaluateTaskCompletion(state, {
      summary: "Created the requested website files.",
      assets: [{ path: "site/index.html", kind: "file", description: "Main page" }],
    });

    expect(result.accepted).toBe(false);
    if (result.accepted) throw new Error("Expected completion rejection.");
    expect(result.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "REQUIRED_ASSET_MISSING", path: "site/index.html" }),
    ]));
    expect(result.nextWorkState).toMatchObject({
      status: "not_done",
      nextStep: expect.stringContaining("site/index.html"),
    });
  });

  it("rejects an existing asset without verified run evidence", async () => {
    await writeFile(join(workspace, "existing.html"), "old", "utf-8");
    const state = taskState({
      workState: {
        status: "not_done",
        summary: "Inspected the task.",
        verifiedFacts: ["A different tool call succeeded."],
        evidence: [],
      },
    });
    const result = await evaluateTaskCompletion(state, {
      summary: "Updated the existing homepage.",
      assets: [{ path: "existing.html", kind: "file", description: "Updated homepage" }],
    });

    expect(result.accepted).toBe(false);
    if (result.accepted) throw new Error("Expected completion rejection.");
    expect(result.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "ASSET_MUTATION_NOT_VERIFIED" }),
    ]));
  });

  it("resolves completion assets against the active task checkout", async () => {
    const checkoutPath = await mkdtemp(join(tmpdir(), "ayati-active-task-"));
    try {
      await mkdir(join(checkoutPath, "aurora-coffee-site"), { recursive: true });
      await writeFile(
        join(checkoutPath, "aurora-coffee-site/app.js"),
        "const ready = true;\n",
        "utf-8",
      );
      const state = taskState({
        harnessContext: taskHarnessContext(checkoutPath),
        workState: {
          status: "not_done",
          summary: "The task checkout contains validated website assets.",
          verifiedFacts: ["node --check passed for aurora-coffee-site/app.js"],
          evidence: [],
          artifacts: [join(checkoutPath, "aurora-coffee-site/app.js")],
        },
      });

      const result = await evaluateTaskCompletion(state, {
        summary: "Created and validated the Aurora Coffee website.",
        assets: [{
          path: "aurora-coffee-site/app.js",
          kind: "file",
          description: "Validated website behavior",
        }],
      });

      expect(result.accepted).toBe(true);
      if (!result.accepted) throw new Error("Expected task-root completion acceptance.");
      expect(result.assets[0]?.resolvedPath).toBe(join(checkoutPath, "aurora-coffee-site/app.js"));
    } finally {
      await rm(checkoutPath, { recursive: true, force: true });
    }
  });

  it("exposes completion only for active not-done task runs", () => {
    expect(isTaskCompletionAvailable(taskState())).toBe(true);
    expect(isTaskCompletionAvailable(taskState({ runClass: "session" }))).toBe(false);
    expect(isTaskCompletionAvailable(taskState({ workState: { ...baseWorkState(), status: "done" } }))).toBe(false);
  });
});

function taskHarnessContext(checkoutPath: string) {
  return createInitialHarnessContext({
    contextEngine: {
      session: {
        meta: { sessionId: "S-1", assetCount: 0 },
        conversationTail: [],
        activityTail: [],
      },
      focus: {
        status: "active",
        ref: "refs/heads/main",
        workId: "W-1",
      },
      task: {
        checkoutPath,
        ref: "refs/heads/main",
        workId: "W-1",
        title: "Aurora Coffee website",
        objective: "Build the requested website.",
        status: "in_progress",
        completed: [],
        open: ["Build the website."],
        blockers: [],
        facts: [],
        assets: [],
        recentRuns: [],
        recentCommits: [],
        recentEvidence: [],
      },
    },
  });
}

function baseWorkState() {
  return {
    status: "not_done" as const,
    summary: "A verified task step succeeded.",
    verifiedFacts: ["write_files succeeded"],
    evidence: [],
  };
}

function successfulStep(): StepSummary {
  return {
    step: 1,
    outcome: "success",
    summary: "write_files succeeded",
    newFacts: [],
    artifacts: [],
    toolsUsed: ["write_files"],
    toolSuccessCount: 1,
    toolFailureCount: 0,
  };
}

function taskState(input: Partial<LoopState> = {}): LoopState {
  return {
    runId: "R-1",
    currentSeq: 1,
    runClass: "task",
    userMessage: "Create a website",
    workState: baseWorkState(),
    status: "running",
    finalOutput: "",
    iteration: 2,
    maxIterations: 15,
    consecutiveFailures: 0,
    completedSteps: [successfulStep()],
    routingAttempts: { successCount: 0, failureCount: 0, maxFailures: 2, resolved: true },
    runPath: "",
    failureHistory: [],
    harnessContext: createInitialHarnessContext(),
    ...input,
  };
}
