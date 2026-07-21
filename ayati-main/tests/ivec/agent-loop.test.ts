import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentRunHandle } from "ayati-context-engine";
import { agentLoop } from "../../src/ivec/agent-loop.js";
import type { LlmProvider } from "../../src/core/contracts/provider.js";
import type { LlmTurnOutput } from "../../src/core/contracts/llm-protocol.js";
import type { ContextRunStepRecord } from "../../src/context-engine/index.js";
import type { HarnessContextInput } from "../../src/ivec/harness-context.js";
import type { AgentFeedbackEventInput, AgentFeedbackLedger } from "../../src/ivec/feedback-ledger.js";
import { noopRunRecorder } from "../../src/ivec/noop-run-recorder.js";
import { writeFilesTool } from "../../src/skills/builtins/filesystem/write-files.js";
import { createToolExecutor } from "../../src/skills/tool-executor.js";
import type { SkillDefinition, ToolDefinition } from "../../src/skills/types.js";
import { ToolCatalog } from "../../src/ivec/agent-runner/tool-catalog.js";
import { ToolWorkingSetManager } from "../../src/ivec/agent-runner/tool-working-set.js";
import { contextEngineFixture } from "../fixtures/agent-context.js";
import { nativeDecisionFixture } from "./native-decision-fixture.js";

const originalAyatiRootDir = process.env["AYATI_ROOT_DIR"];

afterEach(() => {
  if (originalAyatiRootDir === undefined) {
    delete process.env["AYATI_ROOT_DIR"];
  } else {
    process.env["AYATI_ROOT_DIR"] = originalAyatiRootDir;
  }
});

function makeTmpDir(): string {
  const root = mkdtempSync(join(tmpdir(), "ayati-agent-loop-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  process.env["AYATI_ROOT_DIR"] = root;
  return workspace;
}

function cleanup(path: string): void {
  rmSync(dirname(path), { recursive: true, force: true });
}

function runHandle(runId: string, triggerSeq = 1): AgentRunHandle {
  return {
    runId,
    streamId: "S-1",
    triggerSeq,
  };
}

function baseContext(runId = "RUN-1", text = "Current request"): HarnessContextInput {
  return {
    contextEngine: contextEngineFixture({ runId, message: text }),
  };
}

function unboundContext(runId: string, text: string): HarnessContextInput {
  return baseContext(runId, text);
}

function boundContext(runId: string, text: string, workingDirectory?: string): HarnessContextInput {
  const workstreamId = "W-20260719-0001";
  const resourcePath = workingDirectory ?? "/tmp/ayati-test-workspace";
  const branch = "main";
  const context = baseContext(runId, text).contextEngine!;
  return {
    contextEngine: {
      ...context,
      current: {
        ...context.current,
        routing: {
          status: "bound",
          requestId: "R-0001",
          workstreamId,
          branch,
        },
      },
      run: context.run ? {
        ...context.run,
        run: {
          ...context.run.run,
          workstreamBinding: {
            workstreamId,
            requestId: "R-0001",
            boundAt: "2026-07-19T10:00:00.000Z",
          },
        },
      } : undefined,
      focus: {
        status: "active",
        ref: `refs/heads/${branch}`,
        workstreamId,
      },
      workstream: {
        ref: `refs/heads/${branch}`,
        workstreamId,
        title: "One run file",
        objective: text,
        summary: "Create and verify the requested file.",
        workstreamStatus: "in_progress",
        lifecycleStatus: "active",
        repositoryHealth: "ready",
        blockers: [],
        next: text,
        currentRequest: {
          id: "R-0001",
          title: "Create one-run.txt",
          status: "active",
          request: text,
          acceptance: ["one-run.txt exists and is verified."],
          constraints: [],
        },
        resources: [workstreamResource(resourcePath)],
      },
    },
  };
}

function workstreamResource(path: string) {
  return {
    resource: {
      resourceId: `RES-${"A".repeat(24)}`,
      kind: "directory" as const,
      origin: "agent_created" as const,
      displayName: "One run output",
      description: "User-visible output directory for the one-run fixture.",
      aliases: ["one run output"],
      locator: { kind: "filesystem" as const, path },
      version: {
        key: "directory:one-run",
        observedAt: "2026-07-19T10:00:00.000Z",
        exists: true,
        kind: "directory" as const,
        entryCount: 0,
      },
      availability: "available" as const,
      metadataStatus: "enriched" as const,
      createdAt: "2026-07-19T10:00:00.000Z",
      updatedAt: "2026-07-19T10:00:00.000Z",
    },
    role: "primary" as const,
    access: "mutate" as const,
    primary: true,
    requestIds: ["R-0001"],
    boundAt: "2026-07-19T10:00:00.000Z",
  };
}

function createProvider(responses: unknown[]): LlmProvider {
  const queue = responses.map(nativeDecisionFixture);
  return {
    name: "mock",
    version: "1.0.0",
    capabilities: {
      nativeToolCalling: true,
      structuredOutput: { jsonObject: true, jsonSchema: true },
    },
    start: vi.fn(),
    stop: vi.fn(),
    generateTurn: vi.fn(async (): Promise<LlmTurnOutput> => {
      const response = queue.shift();
      if (!response) throw new Error("No queued provider response");
      return response;
    }),
  };
}

function createMemoryFeedbackLedger(): {
  ledger: AgentFeedbackLedger;
  events: AgentFeedbackEventInput[];
} {
  const events: AgentFeedbackEventInput[] = [];
  return {
    events,
    ledger: {
      enabled: true,
      record(event) {
        events.push(event);
      },
      async flush() {},
      async close() {},
    },
  };
}

function extractStateView(userPrompt: string): Record<string, any> {
  const marker = "State view:\n";
  const start = userPrompt.indexOf(marker);
  if (start < 0) throw new Error("State view section missing from decision prompt");
  const raw = userPrompt.slice(start + marker.length).trim();
  const objectStart = raw.indexOf("{");
  if (objectStart < 0) throw new Error("State view JSON object missing");
  let depth = 0;
  let inString = false;
  let escaping = false;
  for (let index = objectStart; index < raw.length; index++) {
    const char = raw[index];
    if (escaping) {
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth++;
    if (char === "}") {
      depth--;
      if (depth === 0) return JSON.parse(raw.slice(objectStart, index + 1));
    }
  }
  throw new Error("State view JSON object was incomplete");
}

function readTool(): ToolDefinition {
  return {
    name: "read_files",
    description: "Read a fixture file.",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: { path: { type: "string" } },
    },
    async execute() {
      return { ok: true, output: "upload handling lives in src/upload.ts" };
    },
  };
}

function fixtureTool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} fixture`,
    inputSchema: { type: "object", properties: {} },
    async execute() {
      return { ok: true, output: `${name} completed` };
    },
  };
}

function fixtureSkill(id: string, tools: ToolDefinition[]): SkillDefinition {
  return {
    id,
    version: "1.0.0",
    description: `${id} fixture skill`,
    promptBlock: "",
    tools,
  };
}

describe("agentLoop one-run lifecycle", () => {
  it("returns a direct zero-step reply for the prepared run", async () => {
    const dataDir = makeTmpDir();
    try {
      const provider = createProvider([
        { kind: "reply", status: "completed", message: "Hello from one run." },
      ]);
      const recordRunStep = vi.fn();

      const result = await agentLoop({
        provider,
        toolDefinitions: [],
        runRecorder: noopRunRecorder,
        runHandle: runHandle("R-direct"),
        recordRunStep,
        clientId: "c1",
        initialUserMessage: "hello",
        dataDir,
        systemContext: "test system context",
      });

      expect(result).toMatchObject({
        runId: "R-direct",
        outcome: "done",
        stopReason: "completed",
        status: "completed",
        totalIterations: 1,
        totalToolCalls: 0,
        content: "Hello from one run.",
      });
      expect(recordRunStep).not.toHaveBeenCalled();
      expect(provider.generateTurn).toHaveBeenCalledTimes(1);
    } finally {
      cleanup(dataDir);
    }
  });

  it("records an observational step on the same unbound run", async () => {
    const dataDir = makeTmpDir();
    try {
      const tool = readTool();
      const toolExecutor = createToolExecutor([tool]);
      const provider = createProvider([
        {
          kind: "act",
          action: {
            mode: "single",
            calls: [{
              id: "read-upload",
              tool: "read_files",
              input: { path: "src/upload.ts" },
              dependsOn: [],
              purpose: "Locate upload handling",
            }],
            allowedTools: ["read_files"],
            assertions: [],
          },
        },
        { kind: "reply", status: "completed", message: "Upload handling is in src/upload.ts." },
      ]);
      const records: ContextRunStepRecord[] = [];

      const result = await agentLoop({
        provider,
        toolExecutor,
        toolDefinitions: [tool],
        runRecorder: noopRunRecorder,
        runHandle: runHandle("R-read"),
        recordRunStep(record) {
          records.push(record);
        },
        clientId: "c1",
        initialUserMessage: "Where is upload handling?",
        dataDir,
        systemContext: "test system context",
        harnessContext: unboundContext("R-read", "Where is upload handling?"),
      });

      expect(result).toMatchObject({
        runId: "R-read",
        outcome: "done",
        stopReason: "completed",
        totalToolCalls: 1,
      });
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        runId: "R-read",
        step: 1,
        status: "completed",
        toolCalls: [{ tool: "read_files", callId: "read-upload", status: "success" }],
      });

      const secondInput = vi.mocked(provider.generateTurn).mock.calls[1]?.[0];
      const prompt = secondInput.messages.find((message) => message.role === "user")?.content;
      expect(typeof prompt).toBe("string");
      const stateView = extractStateView(prompt as string);
      expect(Object.keys(stateView.context.run).sort()).toEqual(["toolCalls", "workState"]);
      expect(stateView.context.run).not.toHaveProperty("runId");
      expect(stateView.context.run).not.toHaveProperty("status");
      expect(stateView.context.run).not.toHaveProperty("routing");
      expect(stateView.context.run.toolCalls[0]).toMatchObject({
        tool: "read_files",
        purpose: "Locate upload handling",
        status: "success",
      });
    } finally {
      cleanup(dataDir);
    }
  });

  it("rejects an unbound mutation and never defers or executes it", async () => {
    const dataDir = makeTmpDir();
    const outputPath = join(dataDir, "must-not-exist.txt");
    try {
      const toolExecutor = createToolExecutor([writeFilesTool]);
      const feedback = createMemoryFeedbackLedger();
      const provider = createProvider([
        {
          kind: "act",
          action: {
            mode: "single",
            calls: [{
              id: "stale-write",
              tool: "write_files",
              input: { files: [{ path: outputPath, content: "unsafe" }] },
              dependsOn: [],
              purpose: "Create the requested file",
            }],
            allowedTools: ["write_files"],
            assertions: [],
          },
        },
        { kind: "reply", status: "completed", message: "I need to bind this run before mutation." },
      ]);
      const recordRunStep = vi.fn();

      const result = await agentLoop({
        provider,
        toolExecutor,
        toolDefinitions: [writeFilesTool],
        runRecorder: noopRunRecorder,
        runHandle: runHandle("R-unbound-mutation"),
        recordRunStep,
        feedbackLedger: feedback.ledger,
        clientId: "c1",
        initialUserMessage: "Create a file",
        dataDir,
        systemContext: "test system context",
        harnessContext: unboundContext("R-unbound-mutation", "Create a file"),
      });

      expect(result.runId).toBe("R-unbound-mutation");
      expect(existsSync(outputPath)).toBe(false);
      expect(recordRunStep).not.toHaveBeenCalled();
      const repairs = feedback.events.filter((event) => event.event === "repair_requested");
      expect(repairs[0]?.data?.["repair"]).toMatchObject({
        code: "R_MUTATION_REQUIRES_WORKSTREAM_BINDING",
        blockedTargets: ["write_files"],
      });
    } finally {
      cleanup(dataDir);
    }
  });

  it("terminates repeated no-progress loads of bound-only tools before the run limit", async () => {
    const dataDir = makeTmpDir();
    try {
      const routingTools = [
        fixtureTool("git_context_inspect_resource"),
        fixtureTool("git_context_activate_workstream"),
        fixtureTool("git_context_create_workstream"),
      ];
      const toolExecutor = createToolExecutor([]);
      const toolWorkingSetManager = new ToolWorkingSetManager({
        catalog: new ToolCatalog([
          fixtureSkill("filesystem", [writeFilesTool]),
          fixtureSkill("git-context", routingTools),
        ]),
        toolExecutor,
      });
      const loadWriteFiles = {
        kind: "load_tools",
        request: { toolNames: ["write_files"] },
      };
      const provider = createProvider([loadWriteFiles, loadWriteFiles]);
      const feedback = createMemoryFeedbackLedger();

      const result = await agentLoop({
        provider,
        toolExecutor,
        toolWorkingSetManager,
        toolDefinitions: [writeFilesTool, ...routingTools],
        runRecorder: noopRunRecorder,
        runHandle: runHandle("R-repeated-load"),
        feedbackLedger: feedback.ledger,
        clientId: "c1",
        initialUserMessage: "Create a file in /tmp/existing-project",
        dataDir,
        systemContext: "test system context",
        harnessContext: unboundContext("R-repeated-load", "Create a file in /tmp/existing-project"),
      });

      expect(result).toMatchObject({
        runId: "R-repeated-load",
        outcome: "failed",
        stopReason: "failed",
        totalIterations: 2,
        totalToolCalls: 0,
      });
      expect(provider.generateTurn).toHaveBeenCalledTimes(2);
      const firstInput = vi.mocked(provider.generateTurn).mock.calls[0]?.[0];
      expect(firstInput.tools.map((tool) => tool.name)).toEqual(["decision_load_tools"]);
      expect(firstInput.tools.map((tool) => tool.name)).not.toContain("write_files");
      expect(feedback.events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          stage: "guard",
          event: "tool_load_no_progress",
          data: expect.objectContaining({ repeatedTargets: ["write_files"] }),
        }),
      ]));
    } finally {
      cleanup(dataDir);
    }
  });

  it("awaits isolated resolution, refreshes context, and records only the task mutation", async () => {
    const dataDir = makeTmpDir();
    const outputPath = join(dataDir, "one-run.txt");
    const runId = "R-route-and-write";
    try {
      const toolExecutor = createToolExecutor([writeFilesTool]);
      const provider = createProvider([
        {
          kind: "resolve_workstream",
          request: {
            purpose: "Resolve the durable owner for one-run.txt.",
            hints: [{ kind: "filesystem", path: dataDir }],
          },
        },
        {
          kind: "act",
          action: {
            mode: "single",
            calls: [{
              id: "write-after-binding",
              tool: "write_files",
              input: { files: [{ path: outputPath, content: "same durable run" }] },
              dependsOn: [],
              purpose: "Create the requested file after binding",
            }],
            allowedTools: ["write_files"],
            assertions: [],
          },
        },
        {
          kind: "workstream_completion",
          request: {
            summary: "Created and verified one-run.txt.",
            resources: [{
              resourceId: `RES-${"A".repeat(24)}`,
              path: "one-run.txt",
              kind: "file",
              description: "Requested text file",
              aliases: ["one run file"],
            }],
          },
        },
        { kind: "reply", status: "completed", message: "Created one-run.txt." },
      ]);
      const workstreamResolution = {
        resolve: vi.fn(async () => ({
          receipt: {
            status: "resolved" as const,
            activityId: "WSR-route-and-write",
            resolutionKind: "created_workstream" as const,
            workstreamId: "W-20260719-0001",
            requestId: "R-0001",
            stepCount: 2,
            contextRevision: "ctx:bound",
          },
          context: boundContext(runId, "Create one-run.txt", dataDir).contextEngine!,
        })),
      };
      const records: ContextRunStepRecord[] = [];
      const persistedContexts: HarnessContextInput[] = [];

      const result = await agentLoop({
        provider,
        toolExecutor,
        toolDefinitions: [writeFilesTool],
        workstreamResolution,
        runRecorder: noopRunRecorder,
        runHandle: runHandle(runId),
        recordRunStep(record, currentContext) {
          records.push(record);
          persistedContexts.push(currentContext);
        },
        clientId: "c1",
        initialUserMessage: "Create one-run.txt",
        dataDir,
        systemContext: "test system context",
        harnessContext: unboundContext(runId, "Create one-run.txt"),
      });

      expect(result).toMatchObject({
        runId,
        outcome: "done",
        stopReason: "completed",
        status: "completed",
      });
      expect(result.workstreamSummary).toMatchObject({
        runId,
        workstreamStatus: "done",
        stopReason: "completed",
      });
      expect(records.map((record) => [record.runId, record.step])).toEqual([
        [runId, 1],
      ]);
      expect(records[0]?.toolCalls[0]).toMatchObject({ tool: "write_files", callId: "write-after-binding" });
      expect(persistedContexts).toHaveLength(1);
      expect(persistedContexts[0]?.contextEngine?.current).toMatchObject({
        runId,
        routing: { status: "bound" },
      });
      expect(readFileSync(outputPath, "utf8")).toBe("same durable run");
      expect(workstreamResolution.resolve).toHaveBeenCalledTimes(1);

      const firstInput = vi.mocked(provider.generateTurn).mock.calls[0]?.[0];
      const secondInput = vi.mocked(provider.generateTurn).mock.calls[1]?.[0];
      expect(firstInput.tools.map((tool) => tool.name)).toContain("workstream_resolve");
      expect(firstInput.tools.map((tool) => tool.name)).not.toContain("write_files");
      expect(secondInput.tools.map((tool) => tool.name)).toContain("write_files");
      expect(secondInput.tools.map((tool) => tool.name)).not.toContain("workstream_resolve");
    } finally {
      cleanup(dataDir);
    }
  });

  it("keeps a failed resolver activity out of main task-step persistence", async () => {
    const dataDir = makeTmpDir();
    try {
      const runId = "R-routing-failure";
      const provider = createProvider([
        {
          kind: "resolve_workstream",
          request: { purpose: "Resolve durable ownership.", hints: [] },
        },
        { kind: "reply", status: "failed", message: "I could not safely resolve the workstream." },
      ]);
      const records: ContextRunStepRecord[] = [];
      const failedContext = unboundContext(runId, "Create durable work").contextEngine!;
      failedContext.workstreamResolution = {
        activityId: "WSR-routing-failure",
        runId,
        status: "failed",
        purpose: "Resolve durable ownership.",
        stepCount: 2,
        result: {
          status: "failed",
          code: "WORKSTREAM_RESOLUTION_REPEATED_FAILURE",
          message: "Resolver decisions failed validation.",
          retryable: true,
        },
        updatedAt: "2026-07-21T10:00:00.000Z",
      };
      const workstreamResolution = {
        resolve: vi.fn(async () => ({
          receipt: {
            status: "failed" as const,
            activityId: "WSR-routing-failure",
            code: "WORKSTREAM_RESOLUTION_REPEATED_FAILURE",
            retryable: true,
            stepCount: 2,
            contextRevision: failedContext.contextRevision,
          },
          context: failedContext,
        })),
      };

      const result = await agentLoop({
        provider,
        toolDefinitions: [],
        workstreamResolution,
        runRecorder: noopRunRecorder,
        runHandle: runHandle(runId),
        recordRunStep(record) {
          records.push(record);
        },
        clientId: "c1",
        initialUserMessage: "Create durable work",
        dataDir,
        systemContext: "test system context",
        harnessContext: unboundContext(runId, "Create durable work"),
      });

      expect(result).toMatchObject({
        runId,
        outcome: "done",
        stopReason: "completed",
        content: "I could not safely resolve the workstream.",
      });
      expect(workstreamResolution.resolve).toHaveBeenCalledTimes(1);
      expect(records).toEqual([]);
      expect(result.totalToolCalls).toBe(0);
    } finally {
      cleanup(dataDir);
    }
  });

  it("uses a fresh main decision to ask the resolver's clarification", async () => {
    const dataDir = makeTmpDir();
    try {
      const runId = "R-routing-ambiguous";
      const provider = createProvider([
        {
          kind: "resolve_workstream",
          request: { purpose: "Resolve which website to continue.", hints: [] },
        },
        { kind: "reply", status: "completed", message: "Which website workstream should I continue? Please provide me with its name or path." },
      ]);
      const ambiguousContext = unboundContext(runId, "Continue the website").contextEngine!;
      ambiguousContext.current.routing = { status: "clarifying" };
      ambiguousContext.workstreamResolution = {
        activityId: "WSR-routing-ambiguous",
        runId,
        status: "needs_user_input",
        purpose: "Resolve which website to continue.",
        stepCount: 1,
        result: {
          status: "needs_user_input",
          reasonCodes: ["multiple_plausible_workstreams"],
          question: "Which website workstream should I continue?",
          candidates: [],
        },
        updatedAt: "2026-07-21T10:00:00.000Z",
      };
      const workstreamResolution = {
        resolve: vi.fn(async () => ({
          receipt: {
            status: "needs_user_input" as const,
            activityId: "WSR-routing-ambiguous",
            candidateCount: 0,
            stepCount: 1,
            contextRevision: ambiguousContext.contextRevision,
          },
          context: ambiguousContext,
        })),
      };

      const result = await agentLoop({
        provider,
        toolDefinitions: [],
        workstreamResolution,
        runRecorder: noopRunRecorder,
        runHandle: runHandle(runId),
        clientId: "c1",
        initialUserMessage: "Continue the website",
        dataDir,
        systemContext: "test system context",
        harnessContext: unboundContext(runId, "Continue the website"),
      });

      expect(result).toMatchObject({
        runId,
        outcome: "needs_user_input",
        stopReason: "needs_user_input",
        status: "completed",
        content: "Which website workstream should I continue? Please provide me with its name or path.",
      });
      expect(workstreamResolution.resolve).toHaveBeenCalledTimes(1);
      expect(provider.generateTurn).toHaveBeenCalledTimes(2);
    } finally {
      cleanup(dataDir);
    }
  });

  it("maps a focused clarification to needs_user_input", async () => {
    const dataDir = makeTmpDir();
    try {
      const provider = createProvider([
        { kind: "reply", status: "completed", message: "Which file should I inspect? Please provide the file path." },
      ]);

      const result = await agentLoop({
        provider,
        toolDefinitions: [],
        runRecorder: noopRunRecorder,
        runHandle: runHandle("R-clarify"),
        clientId: "c1",
        initialUserMessage: "Inspect it",
        dataDir,
        systemContext: "test system context",
        harnessContext: unboundContext("R-clarify", "Inspect it"),
      });

      expect(result).toMatchObject({
        runId: "R-clarify",
        outcome: "needs_user_input",
        stopReason: "needs_user_input",
        status: "completed",
        workState: {
          status: "needs_user_input",
        },
      });
    } finally {
      cleanup(dataDir);
    }
  });

  it("preserves a full workstream clarification while bounding durable WorkState", async () => {
    const dataDir = makeTmpDir();
    const question = [
      "Every mutation-capable tool requires a selected workstream resource before I can continue.",
      "Please tell me whether I should create a new output resource or use an existing absolute path.",
      "If an existing path should be used, include the exact path and whether Ayati may modify it.",
      "I will wait for that choice before changing files so the durable resource catalog remains truthful.",
      "You may also name the intended deliverable if the destination should be created automatically.",
      "This clarification is intentionally long enough to exercise the durable finalization boundary.",
    ].join(" ");
    expect(question.length).toBeGreaterThan(500);
    try {
      const provider = createProvider([{
        kind: "ask_user",
        question,
        reason: "Mutation requires an explicit durable resource target.",
      }]);

      const result = await agentLoop({
        provider,
        toolDefinitions: [],
        runRecorder: noopRunRecorder,
        runHandle: runHandle("R-bound-long-clarification"),
        clientId: "c1",
        initialUserMessage: "Build the site in the right place",
        dataDir,
        systemContext: "test system context",
        harnessContext: boundContext(
          "R-bound-long-clarification",
          "Build the site in the right place",
        ),
      });

      expect(result).toMatchObject({
        runId: "R-bound-long-clarification",
        outcome: "needs_user_input",
        stopReason: "needs_user_input",
        status: "completed",
        content: question,
        workState: {
          status: "needs_user_input",
        },
      });
      expect(result.workState?.userInputNeeded).not.toBe(question);
      expect(result.workState?.userInputNeeded?.length).toBeLessThanOrEqual(500);
    } finally {
      cleanup(dataDir);
    }
  });

  it("maps context admission exhaustion to incomplete/context_limit without losing workstream state", async () => {
    const dataDir = makeTmpDir();
    const message = `Continue the workstream: ${"x".repeat(300_000)}`;
    try {
      const provider: LlmProvider = {
        name: "mock",
        version: "1.0.0",
        capabilities: {
          nativeToolCalling: true,
          structuredOutput: { jsonObject: true, jsonSchema: true },
        },
        start: vi.fn(),
        stop: vi.fn(),
        countInputTokens: vi.fn().mockResolvedValue({
          provider: "mock",
          model: "1.0.0",
          inputTokens: 90_000,
          exact: true,
        }),
        generateTurn: vi.fn(),
      };

      const result = await agentLoop({
        provider,
        toolDefinitions: [],
        runRecorder: noopRunRecorder,
        runHandle: runHandle("R-context-limit", 3),
        clientId: "c1",
        initialUserMessage: message,
        dataDir,
        systemContext: "test system context",
        harnessContext: boundContext("R-context-limit", message, dataDir),
      });

      expect(result).toMatchObject({
        runId: "R-context-limit",
        outcome: "incomplete",
        stopReason: "context_limit",
        status: "stuck",
        workstreamSummary: {
          runId: "R-context-limit",
          stopReason: "context_limit",
        },
      });
      expect(provider.generateTurn).not.toHaveBeenCalled();
    } finally {
      cleanup(dataDir);
    }
  });
});
