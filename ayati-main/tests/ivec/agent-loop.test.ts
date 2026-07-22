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

function workstreamSearchTool(
  workstreams: Array<Record<string, unknown>> = [],
): ToolDefinition {
  const structuredContent = { workstreams, count: workstreams.length };
  return {
    name: "git_context_find_workstreams",
    description: "Find authoritative workstream candidates.",
    inputSchema: { type: "object", properties: {} },
    async execute() {
      return {
        ok: true,
        output: JSON.stringify(structuredContent),
        structuredContent,
      };
    },
  };
}

function createBindingProposal(runId: string, callId: string) {
  return {
    kind: "create" as const,
    title: "Create requested output",
    objective: "Create and verify the exact output requested by the user.",
    initialRequest: {
      title: "Create requested output",
      request: "Create the requested file.",
      acceptance: ["The requested file exists and is verified."],
      constraints: [],
    },
    resources: [],
    evidence: [`run:${runId}:step:1:call:${callId}`],
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

  it("starts at ENTRY and mounts read-only tools only after an observation transition", async () => {
    const dataDir = makeTmpDir();
    try {
      const observationTools = [fixtureTool("inspect_paths"), fixtureTool("find_files")];
      const toolExecutor = createToolExecutor([]);
      const toolWorkingSetManager = new ToolWorkingSetManager({
        catalog: new ToolCatalog([fixtureSkill("filesystem", observationTools)]),
        toolExecutor,
      });
      const provider = createProvider([
        {
          kind: "transition_mode",
          request: {
            to: "observe.locate",
            purpose: "Find the requested notes file without changing it.",
            capabilities: ["file:search"],
          },
        },
        {
          kind: "act",
          action: {
            mode: "single",
            calls: [{
              id: "find-notes",
              tool: "find_files",
              input: {},
              dependsOn: [],
              purpose: "Locate harbor-sensor-notes.md",
            }],
            allowedTools: ["find_files"],
            assertions: [],
          },
        },
        {
          kind: "validate",
          request: {
            outcome: "completed",
            summary: "Searched for the requested notes file without mutation.",
            response: "I searched for harbor-sensor-notes.md without changing anything.",
          },
        },
      ]);
      const workstreamBinding = { bind: vi.fn() };
      const recordRunStep = vi.fn();

      const result = await agentLoop({
        provider,
        toolExecutor,
        toolWorkingSetManager,
        toolDefinitions: observationTools,
        workstreamBinding,
        runRecorder: noopRunRecorder,
        runHandle: runHandle("R-observation-preload"),
        recordRunStep,
        clientId: "c1",
        initialUserMessage: "Find harbor-sensor-notes.md. Only inspect; do not modify anything.",
        dataDir,
        systemContext: "test system context",
        harnessContext: unboundContext(
          "R-observation-preload",
          "Find harbor-sensor-notes.md. Only inspect; do not modify anything.",
        ),
      });

      expect(result).toMatchObject({ outcome: "done", totalIterations: 3, totalToolCalls: 1 });
      const firstInput = vi.mocked(provider.generateTurn).mock.calls[0]?.[0];
      expect(firstInput.tools.map((tool) => tool.name)).toEqual(["decision_transition_mode"]);
      const secondInput = vi.mocked(provider.generateTurn).mock.calls[1]?.[0];
      expect(secondInput.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
        "decision_transition_mode",
        "decision_validate",
        "inspect_paths",
        "find_files",
      ]));
      expect(secondInput.tools.map((tool) => tool.name)).not.toContain("write_files");
      expect(workstreamBinding.bind).not.toHaveBeenCalled();
      expect(recordRunStep).toHaveBeenCalledOnce();
    } finally {
      cleanup(dataDir);
    }
  });

  it("locates a vague read target before investigating it in five decisions", async () => {
    const dataDir = makeTmpDir();
    const target = join(dataDir, "project-notes.md");
    try {
      const findTool: ToolDefinition = {
        ...fixtureTool("find_files"),
        async execute() {
          return { ok: true, output: target };
        },
      };
      const read = readTool();
      const provider = createProvider([
        {
          kind: "transition_mode",
          request: {
            to: "observe.locate",
            purpose: "Locate the project notes requested by the user.",
            capabilities: ["file:search"],
          },
        },
        {
          kind: "act",
          action: {
            mode: "single",
            calls: [{
              id: "locate-project-notes",
              tool: "find_files",
              input: {},
              dependsOn: [],
              purpose: "Find the project notes",
            }],
            allowedTools: ["find_files"],
            assertions: [],
          },
        },
        {
          kind: "transition_mode",
          request: {
            to: "observe.investigate",
            purpose: "Read the exact notes file established by locate evidence.",
            capabilities: ["file:verify"],
            targets: [target],
          },
        },
        {
          kind: "act",
          action: {
            mode: "single",
            calls: [{
              id: "read-project-notes",
              tool: "read_files",
              input: { path: target },
              dependsOn: [],
              purpose: "Read the located project notes",
            }],
            allowedTools: ["read_files"],
            assertions: [],
          },
        },
        {
          kind: "validate",
          request: {
            outcome: "completed",
            summary: "Located and read the project notes.",
            response: "The project notes describe upload handling in src/upload.ts.",
          },
        },
      ]);

      const result = await agentLoop({
        provider,
        toolExecutor: createToolExecutor([findTool, read]),
        toolDefinitions: [findTool, read],
        runRecorder: noopRunRecorder,
        runHandle: runHandle("R-vague-read"),
        clientId: "c1",
        initialUserMessage: "Find and read the project notes, then summarize them.",
        dataDir,
        systemContext: "test system context",
        harnessContext: unboundContext(
          "R-vague-read",
          "Find and read the project notes, then summarize them.",
        ),
      });

      expect(result).toMatchObject({
        outcome: "done",
        stopReason: "completed",
        totalIterations: 5,
        totalToolCalls: 2,
      });
      expect(provider.generateTurn).toHaveBeenCalledTimes(5);
      const investigateInput = vi.mocked(provider.generateTurn).mock.calls[3]?.[0];
      expect(investigateInput.tools.map((tool) => tool.name)).toContain("read_files");
      expect(investigateInput.tools.map((tool) => tool.name)).not.toContain("find_files");
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
          kind: "transition_mode",
          request: {
            to: "observe.investigate",
            purpose: "Read the exact source file named by the user.",
            capabilities: ["file:read"],
            targets: ["src/upload.ts"],
          },
        },
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
        {
          kind: "validate",
          request: {
            outcome: "completed",
            summary: "Verified upload handling in src/upload.ts.",
            response: "Upload handling is in src/upload.ts.",
          },
        },
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
        initialUserMessage: "Read src/upload.ts and tell me where upload handling lives.",
        dataDir,
        systemContext: "test system context",
        harnessContext: unboundContext("R-read", "Read src/upload.ts and tell me where upload handling lives."),
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

      const thirdInput = vi.mocked(provider.generateTurn).mock.calls[2]?.[0];
      const prompt = thirdInput.messages.find((message) => message.role === "user")?.content;
      expect(typeof prompt).toBe("string");
      const stateView = extractStateView(prompt as string);
      expect(Object.keys(stateView.context.run).sort()).toEqual(["mode", "toolCalls", "workState"]);
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

  it("fails safely when deterministic binding is unavailable after routing observation", async () => {
    const dataDir = makeTmpDir();
    const outputPath = join(dataDir, "must-not-exist.txt");
    const runId = "R-unbound-mutation";
    const routingCallId = "find-binding-candidates";
    try {
      const routingTool = workstreamSearchTool();
      const toolExecutor = createToolExecutor([writeFilesTool, routingTool]);
      const feedback = createMemoryFeedbackLedger();
      const provider = createProvider([
        {
          kind: "transition_mode",
          request: {
            to: "observe.locate",
            purpose: "Check durable ownership before creating the file.",
            capabilities: ["workstream:search"],
            targets: [outputPath],
          },
        },
        {
          kind: "act",
          action: {
            mode: "single",
            calls: [{
              id: routingCallId,
              tool: "git_context_find_workstreams",
              input: {},
              dependsOn: [],
              purpose: "Find an existing owner for the requested output",
            }],
            allowedTools: ["git_context_find_workstreams"],
            assertions: [],
          },
        },
        {
          kind: "transition_mode",
          request: {
            to: "resolve",
            purpose: "Bind the exact output target before creating it.",
            capabilities: ["file:write"],
            targets: [outputPath],
            binding: createBindingProposal(runId, routingCallId),
          },
        },
        {
          kind: "validate",
          request: {
            outcome: "failed",
            summary: "Deterministic workstream binding was unavailable before mutation.",
            response: "I could not safely create the file because workstream binding is unavailable.",
          },
        },
      ]);
      const recordRunStep = vi.fn();

      const result = await agentLoop({
        provider,
        toolExecutor,
        toolDefinitions: [writeFilesTool, routingTool],
        runRecorder: noopRunRecorder,
        runHandle: runHandle(runId),
        recordRunStep,
        feedbackLedger: feedback.ledger,
        clientId: "c1",
        initialUserMessage: `Create a file at ${outputPath}`,
        dataDir,
        systemContext: "test system context",
        harnessContext: unboundContext(runId, `Create a file at ${outputPath}`),
      });

      expect(result.runId).toBe(runId);
      expect(result).toMatchObject({
        outcome: "failed",
        stopReason: "failed",
        totalIterations: 4,
        totalToolCalls: 1,
        content: "I could not safely create the file because workstream binding is unavailable.",
      });
      expect(existsSync(outputPath)).toBe(false);
      expect(recordRunStep).toHaveBeenCalledOnce();
      expect(provider.generateTurn).toHaveBeenCalledTimes(4);
      expect(feedback.events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          stage: "virtual_mode",
          event: "transition_rejected",
        }),
      ]));
    } finally {
      cleanup(dataDir);
    }
  });

  it("never resolves or executes mutation that contradicts an explicit read-only request", async () => {
    const dataDir = makeTmpDir();
    const outputPath = join(dataDir, "must-stay-absent.txt");
    try {
      const mutationAttempt = {
        kind: "transition_mode",
        request: {
          to: "resolve",
          purpose: "Attempt mutation despite the read-only request.",
          capabilities: ["file:write"],
          targets: [outputPath],
        },
      };
      const provider = createProvider([mutationAttempt, mutationAttempt, mutationAttempt]);
      const workstreamBinding = { bind: vi.fn() };

      const result = await agentLoop({
        provider,
        toolExecutor: createToolExecutor([writeFilesTool]),
        toolDefinitions: [writeFilesTool],
        workstreamBinding,
        runRecorder: noopRunRecorder,
        runHandle: runHandle("R-read-only-mutation"),
        config: { maxConsecutiveFailures: 3 },
        clientId: "c1",
        initialUserMessage: `Inspect ${outputPath} only; do not modify anything.`,
        dataDir,
        systemContext: "test system context",
        harnessContext: unboundContext("R-read-only-mutation", `Inspect ${outputPath} only; do not modify anything.`),
      });

      expect(result).toMatchObject({
        outcome: "failed",
        totalIterations: 3,
        totalToolCalls: 0,
        content: expect.stringContaining("MODE_MUTATION_INTENT_REQUIRED"),
      });
      expect(provider.generateTurn).toHaveBeenCalledTimes(3);
      expect(workstreamBinding.bind).not.toHaveBeenCalled();
      expect(existsSync(outputPath)).toBe(false);
    } finally {
      cleanup(dataDir);
    }
  });

  it("allows only one deterministic binding attempt per run", async () => {
    const dataDir = makeTmpDir();
    const runId = "R-repeated-load";
    const routingCallId = "find-existing-project";
    try {
      const routingSearch = workstreamSearchTool();
      const routingTools = [
        routingSearch,
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
      const provider = createProvider([
        {
          kind: "transition_mode",
          request: {
            to: "observe.locate",
            purpose: "Find the workstream that owns the project.",
            capabilities: ["workstream:search"],
            targets: ["/tmp/existing-project"],
          },
        },
        {
          kind: "act",
          action: {
            mode: "single",
            calls: [{
              id: routingCallId,
              tool: "git_context_find_workstreams",
              input: {},
              dependsOn: [],
              purpose: "Find the owning workstream",
            }],
            allowedTools: ["git_context_find_workstreams"],
            assertions: [],
          },
        },
        {
          kind: "transition_mode",
          request: {
            to: "resolve",
            purpose: "Bind the exact project before writing.",
            capabilities: ["file:write"],
            targets: ["/tmp/existing-project"],
            binding: createBindingProposal(runId, routingCallId),
          },
        },
        {
          kind: "transition_mode",
          request: {
            to: "resolve",
            purpose: "Do not replay the failed binding attempt.",
            capabilities: ["file:write"],
            targets: ["/tmp/existing-project"],
            binding: createBindingProposal(runId, routingCallId),
          },
        },
        {
          kind: "validate",
          request: {
            outcome: "failed",
            summary: "The single deterministic binding attempt failed.",
            response: "Workstream binding failed, so no file was changed.",
          },
        },
      ]);
      const feedback = createMemoryFeedbackLedger();
      const workstreamBinding = {
        bind: vi.fn(async () => ({
          status: "failed" as const,
          code: "WORKSTREAM_BINDING_TEST_FAILURE",
          message: "Fixture binding failed.",
          retryable: false,
        })),
      };

      const result = await agentLoop({
        provider,
        toolExecutor,
        toolWorkingSetManager,
        toolDefinitions: [writeFilesTool, ...routingTools],
        runRecorder: noopRunRecorder,
        runHandle: runHandle(runId),
        workstreamBinding,
        feedbackLedger: feedback.ledger,
        clientId: "c1",
        initialUserMessage: "Create a file in /tmp/existing-project",
        dataDir,
        systemContext: "test system context",
        harnessContext: unboundContext(runId, "Create a file in /tmp/existing-project"),
      });

      expect(result).toMatchObject({
        runId,
        outcome: "failed",
        stopReason: "failed",
        totalIterations: 5,
        totalToolCalls: 1,
        content: "Workstream binding failed, so no file was changed.",
      });
      expect(provider.generateTurn).toHaveBeenCalledTimes(5);
      expect(workstreamBinding.bind).toHaveBeenCalledOnce();
      const firstInput = vi.mocked(provider.generateTurn).mock.calls[0]?.[0];
      expect(firstInput.tools.map((tool) => tool.name)).toEqual(["decision_transition_mode"]);
      expect(firstInput.tools.map((tool) => tool.name)).not.toContain("write_files");
      const secondInput = vi.mocked(provider.generateTurn).mock.calls[1]?.[0];
      expect(secondInput.tools.map((tool) => tool.name)).toContain("git_context_find_workstreams");
      expect(secondInput.tools.map((tool) => tool.name)).not.toContain("git_context_create_workstream");
      expect(secondInput.tools.map((tool) => tool.name)).not.toContain("git_context_activate_workstream");
      expect(feedback.events.some((event) => event.event === "tool_load_no_progress")).toBe(false);
    } finally {
      cleanup(dataDir);
    }
  });

  it("observes routing in the main loop, binds deterministically, then makes a fresh mutation decision", async () => {
    const dataDir = makeTmpDir();
    const outputPath = join(dataDir, "one-run.txt");
    const runId = "R-route-and-write";
    const routingCallId = "find-one-run-owner";
    try {
      const routingTool = workstreamSearchTool();
      const toolExecutor = createToolExecutor([writeFilesTool, routingTool]);
      const provider = createProvider([
        {
          kind: "transition_mode",
          request: {
            to: "observe.locate",
            purpose: "Check whether durable work already owns this output.",
            capabilities: ["workstream:search"],
            targets: ["one-run.txt"],
          },
        },
        {
          kind: "act",
          action: {
            mode: "single",
            calls: [{
              id: routingCallId,
              tool: "git_context_find_workstreams",
              input: {},
              dependsOn: [],
              purpose: "Find an existing owner before binding",
            }],
            allowedTools: ["git_context_find_workstreams"],
            assertions: [],
          },
        },
        {
          kind: "transition_mode",
          request: {
            to: "resolve",
            purpose: "Bind the requested output before creating it.",
            capabilities: ["file:write"],
            targets: ["one-run.txt"],
            binding: createBindingProposal(runId, routingCallId),
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
          kind: "validate",
          request: {
            outcome: "completed",
            summary: "Created and verified one-run.txt.",
            response: "Created one-run.txt.",
            resources: [{
              resourceId: `RES-${"A".repeat(24)}`,
              path: "one-run.txt",
              kind: "file",
              description: "Requested text file",
              aliases: ["one run file"],
            }],
          },
        },
      ]);
      const workstreamBinding = {
        bind: vi.fn(async () => ({
          status: "resolved" as const,
          kind: "created_workstream" as const,
          workstreamId: "W-20260719-0001",
          requestId: "R-0001",
          context: boundContext(runId, "Create one-run.txt", dataDir).contextEngine!,
        })),
      };
      const records: ContextRunStepRecord[] = [];
      const persistedContexts: HarnessContextInput[] = [];
      const feedback = createMemoryFeedbackLedger();

      const result = await agentLoop({
        provider,
        toolExecutor,
        toolDefinitions: [writeFilesTool, routingTool],
        workstreamBinding,
        feedbackLedger: feedback.ledger,
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
        [runId, 2],
      ]);
      expect(records[0]?.toolCalls[0]).toMatchObject({
        tool: "git_context_find_workstreams",
        callId: routingCallId,
      });
      expect(records[1]?.toolCalls[0]).toMatchObject({ tool: "write_files", callId: "write-after-binding" });
      expect(persistedContexts).toHaveLength(2);
      expect(persistedContexts[1]?.contextEngine?.current).toMatchObject({
        runId,
        routing: { status: "bound" },
      });
      expect(readFileSync(outputPath, "utf8")).toBe("same durable run");
      expect(workstreamBinding.bind).toHaveBeenCalledTimes(1);
      expect(provider.generateTurn).toHaveBeenCalledTimes(5);
      expect(feedback.events.find((event) => event.stage === "final" && event.event === "reply")?.data?.["feedbackSummary"])
        .toMatchObject({
          navigation: {
            currentMode: "execute",
            transitionRequests: 2,
            transitionAccepted: 2,
            transitionRejected: 0,
            bindingAttempts: 1,
            bindingStatus: "resolved",
            validationAttempts: 1,
            validationAccepted: 1,
            validationRejected: 0,
          },
        });
      expect(feedback.events.filter((event) =>
        event.stage === "workstream_binding" && event.event === "deterministic_binding_started"))
        .toHaveLength(1);

      const firstInput = vi.mocked(provider.generateTurn).mock.calls[0]?.[0];
      const secondInput = vi.mocked(provider.generateTurn).mock.calls[1]?.[0];
      const fourthInput = vi.mocked(provider.generateTurn).mock.calls[3]?.[0];
      expect(firstInput.tools.map((tool) => tool.name)).toEqual(["decision_transition_mode"]);
      expect(firstInput.tools.map((tool) => tool.name)).not.toContain("workstream_resolve");
      expect(firstInput.tools.map((tool) => tool.name)).not.toContain("write_files");
      expect(secondInput.tools.map((tool) => tool.name)).toContain("git_context_find_workstreams");
      expect(secondInput.tools.map((tool) => tool.name)).toContain("decision_validate");
      expect(fourthInput.tools.map((tool) => tool.name)).toContain("write_files");
      expect(fourthInput.tools.map((tool) => tool.name)).toContain("decision_validate");
    } finally {
      cleanup(dataDir);
    }
  });

  it("uses an existing authoritative binding without invoking the binding gate again", async () => {
    const dataDir = makeTmpDir();
    const outputPath = join(dataDir, "one-run.txt");
    const runId = "R-already-bound-write";
    try {
      const provider = createProvider([
        {
          kind: "transition_mode",
          request: {
            to: "resolve",
            purpose: "Use the existing binding before writing the requested file.",
            capabilities: ["file:write"],
            targets: ["one-run.txt"],
          },
        },
        {
          kind: "act",
          action: {
            mode: "single",
            calls: [{
              id: "write-existing-binding",
              tool: "write_files",
              input: { files: [{ path: outputPath, content: "bound continuation" }] },
              dependsOn: [],
              purpose: "Write within the existing bound resource",
            }],
            allowedTools: ["write_files"],
            assertions: [],
          },
        },
        {
          kind: "validate",
          request: {
            outcome: "completed",
            summary: "Created and verified one-run.txt in the existing binding.",
            response: "Created one-run.txt.",
            resources: [{
              resourceId: `RES-${"A".repeat(24)}`,
              path: "one-run.txt",
              kind: "file",
              description: "Requested text file",
              aliases: ["one run file"],
            }],
          },
        },
      ]);
      const workstreamBinding = { bind: vi.fn() };

      const result = await agentLoop({
        provider,
        toolExecutor: createToolExecutor([writeFilesTool]),
        toolDefinitions: [writeFilesTool],
        workstreamBinding,
        runRecorder: noopRunRecorder,
        runHandle: runHandle(runId),
        clientId: "c1",
        initialUserMessage: "Create one-run.txt",
        dataDir,
        systemContext: "test system context",
        harnessContext: boundContext(runId, "Create one-run.txt", dataDir),
      });

      expect(result).toMatchObject({
        runId,
        outcome: "done",
        stopReason: "completed",
        totalIterations: 3,
        totalToolCalls: 1,
      });
      expect(workstreamBinding.bind).not.toHaveBeenCalled();
      expect(provider.generateTurn).toHaveBeenCalledTimes(3);
      expect(readFileSync(outputPath, "utf8")).toBe("bound continuation");
    } finally {
      cleanup(dataDir);
    }
  });

  it("persists main-loop routing evidence but never records a failed gate as a task step", async () => {
    const dataDir = makeTmpDir();
    try {
      const runId = "R-routing-failure";
      const target = "/tmp/durable-work.txt";
      const routingCallId = "find-durable-work-owner";
      const routingTool = workstreamSearchTool();
      const provider = createProvider([
        {
          kind: "transition_mode",
          request: {
            to: "observe.locate",
            purpose: "Find durable ownership before creating the file.",
            capabilities: ["workstream:search"],
            targets: [target],
          },
        },
        {
          kind: "act",
          action: {
            mode: "single",
            calls: [{
              id: routingCallId,
              tool: "git_context_find_workstreams",
              input: {},
              dependsOn: [],
              purpose: "Find the durable work owner",
            }],
            allowedTools: ["git_context_find_workstreams"],
            assertions: [],
          },
        },
        {
          kind: "transition_mode",
          request: {
            to: "resolve",
            purpose: "Bind ownership before creating the durable file.",
            capabilities: ["file:write"],
            targets: [target],
            binding: createBindingProposal(runId, routingCallId),
          },
        },
        {
          kind: "validate",
          request: {
            outcome: "failed",
            summary: "The deterministic binding gate failed.",
            response: "I could not safely bind the workstream.",
          },
        },
      ]);
      const records: ContextRunStepRecord[] = [];
      const workstreamBinding = {
        bind: vi.fn(async () => ({
          status: "failed" as const,
          code: "WORKSTREAM_BINDING_TEST_FAILURE",
          message: "The authoritative binding operation failed.",
          retryable: false,
        })),
      };

      const result = await agentLoop({
        provider,
        toolExecutor: createToolExecutor([routingTool]),
        toolDefinitions: [writeFilesTool, routingTool],
        workstreamBinding,
        runRecorder: noopRunRecorder,
        runHandle: runHandle(runId),
        recordRunStep(record) {
          records.push(record);
        },
        clientId: "c1",
        initialUserMessage: `Create a file at ${target}`,
        dataDir,
        systemContext: "test system context",
        harnessContext: unboundContext(runId, `Create a file at ${target}`),
      });

      expect(result).toMatchObject({
        runId,
        outcome: "failed",
        stopReason: "failed",
        content: "I could not safely bind the workstream.",
      });
      expect(workstreamBinding.bind).toHaveBeenCalledTimes(1);
      expect(records).toHaveLength(1);
      expect(records[0]?.toolCalls[0]).toMatchObject({
        tool: "git_context_find_workstreams",
        callId: routingCallId,
      });
      expect(result.totalToolCalls).toBe(1);
      expect(provider.generateTurn).toHaveBeenCalledTimes(4);
    } finally {
      cleanup(dataDir);
    }
  });

  it("uses a fresh main decision to present deterministic binding ambiguity", async () => {
    const dataDir = makeTmpDir();
    try {
      const runId = "R-routing-ambiguous";
      const target = "/tmp/site";
      const routingCallId = "find-site-owner";
      const routingTool = workstreamSearchTool();
      const provider = createProvider([
        {
          kind: "transition_mode",
          request: {
            to: "observe.locate",
            purpose: "Find workstreams that may own the website target.",
            capabilities: ["workstream:search"],
            targets: [target],
          },
        },
        {
          kind: "act",
          action: {
            mode: "single",
            calls: [{
              id: routingCallId,
              tool: "git_context_find_workstreams",
              input: {},
              dependsOn: [],
              purpose: "Find possible website owners",
            }],
            allowedTools: ["git_context_find_workstreams"],
            assertions: [],
          },
        },
        {
          kind: "transition_mode",
          request: {
            to: "resolve",
            purpose: "Bind the website target before updating it.",
            capabilities: ["file:write"],
            targets: [target],
            binding: createBindingProposal(runId, routingCallId),
          },
        },
        {
          kind: "validate",
          request: {
            outcome: "needs_user_input",
            summary: "Multiple website workstreams remain plausible.",
            response: "Which website workstream should I continue? Please provide me with its name or path.",
          },
        },
      ]);
      const workstreamBinding = {
        bind: vi.fn(async () => ({
          status: "needs_user_input" as const,
          question: "Which website workstream should I continue?",
          candidateIds: ["W-20260720-0001", "W-20260720-0002"],
        })),
      };

      const result = await agentLoop({
        provider,
        toolExecutor: createToolExecutor([routingTool]),
        toolDefinitions: [writeFilesTool, routingTool],
        workstreamBinding,
        runRecorder: noopRunRecorder,
        runHandle: runHandle(runId),
        clientId: "c1",
        initialUserMessage: `Update the website at ${target}`,
        dataDir,
        systemContext: "test system context",
        harnessContext: unboundContext(runId, `Update the website at ${target}`),
      });

      expect(result).toMatchObject({
        runId,
        outcome: "needs_user_input",
        stopReason: "needs_user_input",
        status: "completed",
        content: "Which website workstream should I continue? Please provide me with its name or path.",
      });
      expect(workstreamBinding.bind).toHaveBeenCalledTimes(1);
      expect(provider.generateTurn).toHaveBeenCalledTimes(4);
      expect(result.totalToolCalls).toBe(1);
    } finally {
      cleanup(dataDir);
    }
  });

  it("maps a focused clarification to needs_user_input", async () => {
    const dataDir = makeTmpDir();
    try {
      const provider = createProvider([
        {
          kind: "transition_mode",
          request: {
            to: "observe.locate",
            purpose: "Identify which file the user means.",
            capabilities: ["file:search"],
          },
        },
        {
          kind: "validate",
          request: {
            outcome: "needs_user_input",
            summary: "The requested file is ambiguous.",
            response: "Which file should I inspect? Please provide the file path.",
          },
        },
      ]);
      const findTool = fixtureTool("find_files");

      const result = await agentLoop({
        provider,
        toolExecutor: createToolExecutor([findTool]),
        toolDefinitions: [findTool],
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
      expect(provider.generateTurn).toHaveBeenCalledTimes(2);
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
      const locateTool = fixtureTool("find_files");
      const provider = createProvider([
        {
          kind: "transition_mode",
          request: {
            to: "observe.locate",
            purpose: "Establish which exact bound destination the user intends.",
            capabilities: ["file:search"],
          },
        },
        {
          kind: "validate",
          request: {
            outcome: "needs_user_input",
            summary: "The requested destination remains materially ambiguous.",
            response: question,
          },
        },
      ]);

      const result = await agentLoop({
        provider,
        toolExecutor: createToolExecutor([locateTool]),
        toolDefinitions: [locateTool],
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

  it("stops repeated identical self-transitions through no-progress protection", async () => {
    const dataDir = makeTmpDir();
    try {
      const findTool = fixtureTool("find_files");
      const sameTransition = {
        kind: "transition_mode",
        request: {
          to: "observe.locate",
          purpose: "Locate the requested notes file.",
          capabilities: ["file:search"],
          targets: ["notes.md"],
        },
      };
      const provider = createProvider([sameTransition, sameTransition, sameTransition]);

      const result = await agentLoop({
        provider,
        toolExecutor: createToolExecutor([findTool]),
        toolDefinitions: [findTool],
        runRecorder: noopRunRecorder,
        runHandle: runHandle("R-identical-mode"),
        clientId: "c1",
        initialUserMessage: "Find notes.md in the workspace.",
        dataDir,
        systemContext: "test system context",
        harnessContext: unboundContext("R-identical-mode", "Find notes.md in the workspace."),
      });

      expect(result).toMatchObject({
        outcome: "failed",
        stopReason: "failed",
        totalIterations: 3,
        totalToolCalls: 0,
        content: expect.stringContaining("already active"),
      });
      expect(provider.generateTurn).toHaveBeenCalledTimes(3);
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
