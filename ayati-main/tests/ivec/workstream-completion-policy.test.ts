import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInitialHarnessContext } from "../../src/ivec/harness-context.js";
import type { LoopState, StepSummary, WorkState } from "../../src/ivec/types.js";
import {
  evaluateWorkstreamCompletion,
  isWorkstreamCompletionAvailable,
} from "../../src/ivec/agent-runner/workstream-completion-policy.js";
import { contextEngineFixture } from "../fixtures/agent-context.js";

const RESOURCE_ID = "RES-SITE";
const NOW = "2026-07-19T10:00:00.000Z";

describe("workstream completion policy", () => {
  let testRoot: string;
  let resourceRoot: string;

  beforeEach(async () => {
    testRoot = await mkdtemp(join(tmpdir(), "ayati-workstream-completion-"));
    resourceRoot = join(testRoot, "workspace", "aurora-coffee-site");
    await mkdir(resourceRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });

  it("accepts verified outputs inside an independently bound resource", async () => {
    await mkdir(join(resourceRoot, "assets"), { recursive: true });
    await writeFile(join(resourceRoot, "index.html"), "<h1>Aurora Coffee</h1>", "utf-8");
    const state = workstreamState(resourceRoot, {
      workState: {
        ...baseWorkState(),
        summary: "Website files were written.",
        verifiedFacts: [`write_files read-back hash matched ${join(resourceRoot, "index.html")}`],
        artifacts: [resourceRoot, join(resourceRoot, "index.html")],
      },
    });

    const result = await evaluateWorkstreamCompletion(state, {
      summary: "Created the Aurora Coffee homepage.",
      resources: [
        {
          resourceId: RESOURCE_ID,
          path: ".",
          kind: "directory",
          description: "Website project directory",
          aliases: ["aurora site"],
        },
        {
          resourceId: RESOURCE_ID,
          path: "index.html",
          kind: "file",
          description: "Main coffee shop homepage",
          aliases: ["homepage"],
        },
      ],
    });

    expect(result.accepted).toBe(true);
    expect(result.nextWorkState).toMatchObject({
      status: "done",
      summary: "Created the Aurora Coffee homepage.",
      openWork: [],
      blockers: [],
    });
    if (!result.accepted) throw new Error("Expected completion acceptance.");
    expect(result.resources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        resourceId: RESOURCE_ID,
        path: "index.html",
        resolvedPath: join(resourceRoot, "index.html"),
        description: "Main coffee shop homepage",
        aliases: ["homepage"],
      }),
    ]));
  });

  it("rejects a missing output and records deterministic remaining work", async () => {
    const result = await evaluateWorkstreamCompletion(workstreamState(resourceRoot), {
      summary: "Created the requested website files.",
      resources: [completionResource("missing.html")],
    });

    expect(result.accepted).toBe(false);
    if (result.accepted) throw new Error("Expected completion rejection.");
    expect(result.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "REQUIRED_RESOURCE_MISSING", path: "missing.html" }),
    ]));
    expect(result.nextWorkState).toMatchObject({
      status: "not_done",
      nextStep: expect.stringContaining("missing.html"),
    });
  });

  it("rejects absolute paths and paths that escape the bound resource", async () => {
    for (const path of [join(resourceRoot, "index.html"), "../outside.html"]) {
      const result = await evaluateWorkstreamCompletion(workstreamState(resourceRoot), {
        summary: "Created the requested website files.",
        resources: [completionResource(path)],
      });

      expect(result.accepted).toBe(false);
      if (result.accepted) throw new Error("Expected completion rejection.");
      expect(result.failures).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "INVALID_RESOURCE_PATH", path }),
      ]));
    }
  });

  it("rejects outputs that name a resource not bound to the workstream", async () => {
    await writeFile(join(resourceRoot, "index.html"), "ready", "utf-8");
    const result = await evaluateWorkstreamCompletion(workstreamState(resourceRoot), {
      summary: "Created the requested website files.",
      resources: [{ ...completionResource("index.html"), resourceId: "RES-OTHER" }],
    });

    expect(result.accepted).toBe(false);
    if (result.accepted) throw new Error("Expected completion rejection.");
    expect(result.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "RESOURCE_NOT_BOUND", path: "index.html" }),
    ]));
  });

  it("rejects an existing output without verified current-run evidence", async () => {
    await writeFile(join(resourceRoot, "existing.html"), "old", "utf-8");
    const state = workstreamState(resourceRoot, {
      workState: {
        ...baseWorkState(),
        summary: "Inspected the workstream.",
        verifiedFacts: ["A different tool call succeeded."],
      },
    });
    const result = await evaluateWorkstreamCompletion(state, {
      summary: "Updated the existing homepage.",
      resources: [completionResource("existing.html")],
    });

    expect(result.accepted).toBe(false);
    if (result.accepted) throw new Error("Expected completion rejection.");
    expect(result.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "RESOURCE_MUTATION_NOT_VERIFIED" }),
    ]));
  });

  it("rejects completion while deterministic open work remains", async () => {
    const result = await evaluateWorkstreamCompletion(workstreamState(resourceRoot, {
      workState: {
        ...baseWorkState(),
        openWork: ["Run the final verification suite."],
      },
    }), {
      summary: "Implemented the requested website changes.",
      resources: [],
    });

    expect(result.accepted).toBe(false);
    if (result.accepted) throw new Error("Expected completion rejection.");
    expect(result.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "OPEN_WORK_REMAINS" }),
    ]));
  });

  it("does not accept resolver or legacy routing steps as task completion evidence", async () => {
    const result = await evaluateWorkstreamCompletion(workstreamState(resourceRoot, {
      completedSteps: [{
        ...successfulStep(),
        toolsUsed: ["git_context_create_workstream"],
      }],
    }), {
      summary: "Created the requested workstream context.",
      resources: [],
    });

    expect(result.accepted).toBe(false);
    if (result.accepted) throw new Error("Expected completion rejection.");
    expect(result.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "COMPLETION_EVIDENCE_MISSING" }),
    ]));
  });

  it("rejects kind mismatches even when the path has evidence", async () => {
    await writeFile(join(resourceRoot, "index.html"), "ready", "utf-8");
    const state = workstreamState(resourceRoot, {
      workState: {
        ...baseWorkState(),
        artifacts: [join(resourceRoot, "index.html")],
      },
    });
    const result = await evaluateWorkstreamCompletion(state, {
      summary: "Created the requested website files.",
      resources: [{ ...completionResource("index.html"), kind: "directory" }],
    });

    expect(result.accepted).toBe(false);
    if (result.accepted) throw new Error("Expected completion rejection.");
    expect(result.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "RESOURCE_KIND_MISMATCH" }),
    ]));
  });

  it("exposes completion only for a bound run that is not done", () => {
    expect(isWorkstreamCompletionAvailable(workstreamState(resourceRoot))).toBe(true);
    expect(isWorkstreamCompletionAvailable(workstreamState(resourceRoot, {
      harnessContext: createInitialHarnessContext(),
    }))).toBe(false);
    expect(isWorkstreamCompletionAvailable(workstreamState(resourceRoot, {
      workState: { ...baseWorkState(), status: "done" },
    }))).toBe(false);
  });
});

function completionResource(path: string) {
  return {
    resourceId: RESOURCE_ID,
    path,
    kind: "file" as const,
    description: "Website homepage",
    aliases: ["homepage"],
  };
}

function workstreamHarnessContext(resourcePath: string) {
  const contextEngine = contextEngineFixture({ runId: "R-1", message: "Create a website" });
  return createInitialHarnessContext({
    contextEngine: {
      ...contextEngine,
      focus: {
        status: "active",
        ref: "refs/heads/main",
        workstreamId: "W-1",
      },
      current: {
        ...contextEngine.current,
        routing: {
          status: "bound",
          workstreamId: "W-1",
          requestId: "REQ-1",
          branch: "main",
        },
      },
      workstream: {
        ref: "refs/heads/main",
        workstreamId: "W-1",
        title: "Aurora Coffee website",
        objective: "Build the requested website.",
        summary: "The website is in progress.",
        workstreamStatus: "in_progress",
        lifecycleStatus: "active",
        repositoryHealth: "ready",
        blockers: [],
        currentRequest: {
          id: "REQ-1",
          title: "Build the website",
          status: "active",
          request: "Create an Aurora Coffee website.",
          acceptance: ["A working homepage exists."],
          constraints: [],
        },
        resources: [{
          resource: {
            resourceId: RESOURCE_ID,
            kind: "directory",
            origin: "agent_created",
            displayName: "Aurora Coffee website",
            description: "The user-visible website project directory.",
            aliases: ["aurora site", "coffee website"],
            locator: { kind: "filesystem", path: resourcePath },
            version: {
              key: "directory:test",
              observedAt: NOW,
              exists: true,
              kind: "directory",
              entryCount: 0,
            },
            availability: "available",
            metadataStatus: "enriched",
            createdAt: NOW,
            updatedAt: NOW,
          },
          role: "primary",
          access: "mutate",
          primary: true,
          requestIds: ["REQ-1"],
          boundAt: NOW,
        }],
        recentCommits: [],
      },
    },
  });
}

function baseWorkState(): WorkState {
  return {
    status: "not_done",
    summary: "A verified workstream step succeeded.",
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

function workstreamState(resourcePath: string, input: Partial<LoopState> = {}): LoopState {
  return {
    runId: "R-1",
    currentSeq: 1,
    userMessage: "Create a website",
    workState: baseWorkState(),
    status: "running",
    finalOutput: "",
    iteration: 2,
    maxIterations: 15,
    consecutiveFailures: 0,
    completedSteps: [successfulStep()],
    runPath: "",
    failureHistory: [],
    harnessContext: workstreamHarnessContext(resourcePath),
    ...input,
  };
}
