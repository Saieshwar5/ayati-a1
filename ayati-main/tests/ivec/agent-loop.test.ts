import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { inspectPathsTool } from "../../src/skills/builtins/filesystem/inspect-paths.js";
import { findFilesTool } from "../../src/skills/builtins/filesystem/find-files.js";
import { readFilesTool } from "../../src/skills/builtins/filesystem/read-files.js";
import { createToolExecutor } from "../../src/skills/tool-executor.js";
import type { ToolDefinition } from "../../src/skills/types.js";
import { CapabilitySurfaceManager } from "../../src/ivec/agent-runner/capabilities/surface-manager.js";
import { ToolRegistry } from "../../src/ivec/agent-runner/capabilities/registry.js";
import {
  createPersonalMemoryHotContextSource,
  HotContextRuntime,
  WORKSTREAMS_RECENT_HOT_CONTEXT_KEY,
} from "../../src/ivec/hot-context/index.js";
import { createContextSkill } from "../../src/skills/builtins/context/index.js";
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

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
        selectedRequest: {
          id: "R-0001",
          title: "Create one-run.txt",
          status: "active",
          request: text,
          acceptance: ["one-run.txt exists and is verified."],
          constraints: [],
          lifecycleNote: "Selected for the current run.",
        },
        recentProgress: [{
          runId: "RUN-EARLIER",
          outcome: "incomplete",
          summary: "Prepared the output location.",
          validationSummary: "The requested file remains.",
          nextAction: text,
          commit: "abc123",
          finalizedAt: "2026-07-19T09:00:00.000Z",
        }],
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
    generateTurn: vi.fn(async (input): Promise<LlmTurnOutput> => {
      const response = queue.shift();
      if (!response) {
        const prompt = input.messages.find((message) => message.role === "user")?.content;
        const mode = typeof prompt === "string"
          ? extractStateView(prompt).context?.run?.mode
          : undefined;
        throw new Error(`No queued provider response; current mode=${JSON.stringify(mode)}`);
      }
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
    async execute(input) {
      const path = typeof input["path"] === "string" ? input["path"] : "";
      return {
        ok: true,
        output: "upload handling lives in src/upload.ts",
        v2: {
          transportOk: true,
          operationStatus: "succeeded",
          code: "FILES_READ",
          message: "Read file.",
          structuredContent: {
            results: [{
              requestedPath: path,
              filePath: path,
              ok: true,
              content: "upload handling lives in src/upload.ts",
              coverage: "complete",
              truncated: false,
            }],
          },
        },
      };
    },
  };
}

function validationDecisions(input: {
  path: string;
  response: string;
  id: string;
  check?: "exists" | "read_complete";
}): unknown[] {
  const kind = input.check === "read_complete"
    ? "file.read_complete"
    : "path.exists";
  return [
    {
      kind: "transition_mode",
      request: {
        to: "validation",
        purpose: "Check current-run completion proof before responding.",
        capabilities: ["task:validation"],
        validationChecks: [{
          kind,
          subject: input.path,
          expectedKind: "file",
        }],
      },
    },
    {
      kind: "reply",
      status: "completed",
      message: input.response,
    },
  ];
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

function foundFileResult(path: string) {
  return {
    ok: true,
    output: path,
    v2: {
      transportOk: true as const,
      operationStatus: "succeeded" as const,
      code: "FILES_FOUND",
      message: "Found one file.",
      structuredContent: {
        query: path.split("/").at(-1) ?? path,
        roots: [],
        matches: [{ absolutePath: path, kind: "file" as const }],
        capped: false,
        errors: [],
      },
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
  void runId;
  void callId;
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
        workspaceRoot: dataDir,
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
      const firstTurn = vi.mocked(provider.generateTurn).mock.calls[0]?.[0];
      const userPrompt = firstTurn?.messages.find((message) => message.role === "user")?.content;
      expect(typeof userPrompt).toBe("string");
      expect(extractStateView(userPrompt as string).context.run.workspaceRoot).toBe(dataDir);
    } finally {
      cleanup(dataDir);
    }
  });

  it("persists a named WorkState checkpoint without creating an action step", async () => {
    const dataDir = makeTmpDir();
    try {
      const checkpointWorkState = vi.fn(async (input) => ({
        runtime: {
          revision: input.runtime.revision + 1,
          afterStep: input.afterStep,
          updateReason: input.reason,
          updatedAt: input.at,
        },
      }));
      const recordRunStep = vi.fn();
      const provider = createProvider([
        {
          kind: "transition_mode",
          request: {
            to: "observe.locate",
            purpose: "Identify which file the user means.",
            capabilities: ["file:search"],
            subjects: ["that file"],
          },
        },
        {
          kind: "checkpoint_work_state",
          update: {
            reason: "plan",
            summary: "The target must be identified before inspection.",
            plan: [{
              id: "locate",
              task: "Identify the requested file.",
              status: "active",
            }],
            importantContext: [{
              kind: "decision",
              value: "Do not guess the file identity.",
            }],
            nextAction: "Ask the user for the filename.",
          },
        },
        {
          kind: "stop",
          request: {
            outcome: "needs_user_input",
            response: "Which file would you like me to find?",
          },
        },
      ]);

      const result = await agentLoop({
        provider,
        toolDefinitions: [fixtureTool("find_files")],
        runRecorder: noopRunRecorder,
        runHandle: runHandle("R-work-state-checkpoint"),
        recordRunStep,
        checkpointWorkState,
        clientId: "c1",
        initialUserMessage: "Find that file for me.",
        dataDir,
        systemContext: "test system context",
        harnessContext: unboundContext(
          "R-work-state-checkpoint",
          "Find that file for me.",
        ),
      });

      expect(checkpointWorkState).toHaveBeenCalledOnce();
      expect(checkpointWorkState).toHaveBeenCalledWith(expect.objectContaining({
        reason: "plan",
        afterStep: 0,
        runtime: {
          revision: 0,
          afterStep: 0,
          updateReason: "initial",
        },
        workState: expect.objectContaining({
          status: "in_progress",
          summary: "The target must be identified before inspection.",
          plan: [expect.objectContaining({ id: "locate", status: "active" })],
        }),
      }));
      expect(recordRunStep).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        outcome: "needs_user_input",
        workState: {
          status: "needs_user_input",
          plan: [expect.objectContaining({ id: "locate", status: "active" })],
        },
      });
    } finally {
      cleanup(dataDir);
    }
  });

  it("keeps request-like direct response text completed", async () => {
    const dataDir = makeTmpDir();
    const response = "Could you please send me the report whenever you have a chance?";
    try {
      const provider = createProvider([
        { kind: "reply", status: "completed", message: response },
      ]);

      const result = await agentLoop({
        provider,
        toolDefinitions: [],
        runRecorder: noopRunRecorder,
        runHandle: runHandle("R-direct-rewrite"),
        clientId: "c1",
        initialUserMessage: "Rewrite this politely: Send me the report now.",
        dataDir,
        systemContext: "test system context",
      });

      expect(result).toMatchObject({
        runId: "R-direct-rewrite",
        outcome: "done",
        stopReason: "completed",
        status: "completed",
        totalIterations: 1,
        totalToolCalls: 0,
        content: response,
        workState: {
          status: "done",
          summary: "Completed the direct response.",
        },
      });
      expect(result.workState?.summary).not.toBe(response);
      expect(result.workState?.nextAction).toBeUndefined();
      expect(provider.generateTurn).toHaveBeenCalledTimes(1);
    } finally {
      cleanup(dataDir);
    }
  });

  it("allows an operational request to receive a direct clarification at ENTRY", async () => {
    const dataDir = makeTmpDir();
    const response = "Which release-notes.txt should I read: North or South?";
    try {
      const provider = createProvider([
        { kind: "reply", status: "completed", message: response },
      ]);

      const result = await agentLoop({
        provider,
        toolDefinitions: [],
        runRecorder: noopRunRecorder,
        runHandle: runHandle("R-direct-clarification"),
        clientId: "c1",
        initialUserMessage: "Read exactly one of the two release-notes.txt files and tell me its coordinator.",
        dataDir,
        systemContext: "test system context",
      });

      expect(result).toMatchObject({
        runId: "R-direct-clarification",
        outcome: "done",
        stopReason: "completed",
        status: "completed",
        totalIterations: 1,
        totalToolCalls: 0,
        content: response,
      });
      expect(provider.generateTurn).toHaveBeenCalledTimes(1);
    } finally {
      cleanup(dataDir);
    }
  });

  it("starts at ENTRY and mounts read-only tools only after an observation transition", async () => {
    const dataDir = makeTmpDir();
    try {
      const notesPath = join(dataDir, "harbor-sensor-notes.md");
      writeFileSync(notesPath, "harbor sensor notes\n", "utf8");
      const findTool: ToolDefinition = {
        ...fixtureTool("find_files"),
        async execute() {
          return foundFileResult(notesPath);
        },
      };
      const observationTools = [
        inspectPathsTool,
        readTool(),
        findTool,
        fixtureTool("list_directory"),
        fixtureTool("search_in_files"),
      ];
      const toolExecutor = createToolExecutor([]);
      const capabilitySurfaceManager = new CapabilitySurfaceManager({
        registry: new ToolRegistry(observationTools),
        toolExecutor,
        validateCoverage: false,
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
        ...validationDecisions({
          path: notesPath,
          response: `Found ${notesPath}.`,
          id: "harbor-notes",
        }),
      ]);
      const workstreamBinding = { bind: vi.fn() };
      const recordRunStep = vi.fn();

      const result = await agentLoop({
        provider,
        toolExecutor,
        capabilitySurfaceManager,
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

      expect(result).toMatchObject({ outcome: "done", totalIterations: 4, totalToolCalls: 1 });
      const firstInput = vi.mocked(provider.generateTurn).mock.calls[0]?.[0];
      expect(firstInput.tools.map((tool) => tool.name)).toEqual([
        "decision_enter_observe_locate",
        "decision_enter_observe_investigate",
      ]);
      const secondInput = vi.mocked(provider.generateTurn).mock.calls[1]?.[0];
      expect(secondInput.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
        "decision_enter_observe_locate",
        "decision_enter_observe_investigate",
        "decision_stop",
        "find_files",
        "list_directory",
        "search_in_files",
      ]));
      expect(secondInput.tools.map((tool) => tool.name)).not.toContain("write_files");
      expect(workstreamBinding.bind).not.toHaveBeenCalled();
      expect(recordRunStep).toHaveBeenCalledTimes(1);
    } finally {
      cleanup(dataDir);
    }
  });

  it("mounts Hot Context through a transient mode without changing WorkState or durable work steps", async () => {
    const dataDir = makeTmpDir();
    try {
      const personalMemory = "The user prefers concise implementation explanations.";
      const hotContextRuntime = new HotContextRuntime({
        sources: [
          createPersonalMemoryHotContextSource({
            getSnapshot: () => personalMemory,
          }),
        ],
      });
      const contextTool = createContextSkill({ hotContextRuntime }).tools[0]!;
      const toolExecutor = createToolExecutor([]);
      const capabilitySurfaceManager = new CapabilitySurfaceManager({
        registry: new ToolRegistry([contextTool]),
        toolExecutor,
        validateCoverage: false,
      });
      const provider = createProvider([
        {
          kind: "transition_mode",
          request: {
            to: "context.retrieve",
            purpose: "Load the relevant personal preference.",
            capabilities: ["context:load"],
          },
        },
        {
          kind: "act",
          action: {
            mode: "single",
            calls: [{
              id: "load-personal-memory",
              tool: "context_load",
              input: { keys: ["personal.memory"] },
              dependsOn: [],
              purpose: "Load the relevant personal preference",
            }],
            allowedTools: ["context_load"],
            assertions: [],
          },
        },
        {
          kind: "reply",
          status: "completed",
          message: "You usually prefer concise implementation explanations.",
        },
      ]);
      const recordRunStep = vi.fn();
      const run = runHandle("R-hot-context");

      const result = await agentLoop({
        provider,
        toolExecutor,
        capabilitySurfaceManager,
        hotContextRuntime,
        toolDefinitions: [contextTool],
        runRecorder: noopRunRecorder,
        runHandle: run,
        recordRunStep,
        clientId: "c1",
        initialUserMessage: "What response style do I usually prefer?",
        dataDir,
        systemContext: "test system context",
        harnessContext: unboundContext(
          run.runId,
          "What response style do I usually prefer?",
        ),
      });

      expect(result).toMatchObject({
        outcome: "done",
        totalIterations: 3,
        totalToolCalls: 1,
        completedSteps: [],
      });
      expect(recordRunStep).not.toHaveBeenCalled();

      const calls = vi.mocked(provider.generateTurn).mock.calls;
      const firstPrompt = extractStateView(
        calls[0]?.[0].messages.find((message) => message.role === "user")?.content ?? "",
      );
      expect(firstPrompt.context.hot).toMatchObject({
        available: [{ key: "personal.memory" }],
        loaded: [],
      });
      expect(JSON.stringify(firstPrompt)).not.toContain(personalMemory);

      const secondInput = calls[1]?.[0];
      expect(secondInput?.tools.map((tool) => tool.name)).toEqual([
        "context_load",
      ]);

      const finalPromptText = calls[2]?.[0].messages
        .find((message) => message.role === "user")?.content ?? "";
      const finalPrompt = extractStateView(finalPromptText);
      expect(finalPrompt.context.run.mode).toMatchObject({
        active: "ENTRY",
      });
      expect(finalPrompt.context.hot).toMatchObject({
        available: [],
        loaded: [{
          key: "personal.memory",
          content: personalMemory,
        }],
      });
      expect(finalPromptText.match(new RegExp(personalMemory, "g"))).toHaveLength(1);
      expect(hotContextRuntime.project("c1", run.runId).loaded).toEqual([]);
    } finally {
      cleanup(dataDir);
    }
  });

  it("persists the first durable tool as step one after a transient Hot Context load", async () => {
    const dataDir = makeTmpDir();
    try {
      const target = join(dataDir, "archive", "field-brief.txt");
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, "Lead botanist: Dr. Nila Voss.\n", "utf8");

      const hotContextRuntime = new HotContextRuntime({
        sources: [
          createPersonalMemoryHotContextSource({
            getSnapshot: () => "The user prefers concise answers.",
          }),
        ],
      });
      const contextTool = createContextSkill({ hotContextRuntime }).tools[0]!;
      const toolExecutor = createToolExecutor([]);
      const capabilitySurfaceManager = new CapabilitySurfaceManager({
        registry: new ToolRegistry([contextTool, readFilesTool, inspectPathsTool]),
        toolExecutor,
        validateCoverage: false,
      });
      const provider = createProvider([
        {
          kind: "transition_mode",
          request: {
            to: "context.retrieve",
            purpose: "Load the user's response preference.",
            capabilities: ["context:load"],
          },
        },
        {
          kind: "act",
          action: {
            mode: "single",
            calls: [{
              id: "load-personal-memory",
              tool: "context_load",
              input: { keys: ["personal.memory"] },
              dependsOn: [],
              purpose: "Load the user's response preference",
            }],
            allowedTools: ["context_load"],
            assertions: [],
          },
        },
        {
          kind: "transition_mode",
          request: {
            to: "observe.investigate",
            purpose: "Read the exact file requested by the user.",
            capabilities: ["file:read"],
            references: [{ kind: "filesystem", path: target }],
          },
        },
        {
          kind: "act",
          action: {
            mode: "single",
            calls: [{
              id: "read-field-brief",
              tool: "read_files",
              input: {
                files: [{
                  path: target,
                  mode: "full",
                }],
              },
              dependsOn: [],
              purpose: "Read the field brief",
            }],
            allowedTools: ["read_files"],
            assertions: [],
          },
        },
        ...validationDecisions({
          path: target,
          response: "The lead botanist is Dr. Nila Voss.",
          id: "field-brief",
          check: "read_complete",
        }),
      ]);
      const records: ContextRunStepRecord[] = [];
      const run = runHandle("R-hot-context-then-read");

      const result = await agentLoop({
        provider,
        toolExecutor,
        capabilitySurfaceManager,
        hotContextRuntime,
        toolDefinitions: [contextTool, readFilesTool, inspectPathsTool],
        runRecorder: noopRunRecorder,
        runHandle: run,
        recordRunStep(record) {
          const expectedStep = records.length + 1;
          if (record.step !== expectedStep) {
            throw new Error(
              `RUN_STEP_NOT_CONTIGUOUS: expected ${expectedStep}, received ${record.step}`,
            );
          }
          records.push(record);
        },
        clientId: "c1",
        initialUserMessage: `Read ${target} and tell me who the lead botanist is.`,
        dataDir,
        systemContext: "test system context",
        harnessContext: unboundContext(
          run.runId,
          `Read ${target} and tell me who the lead botanist is.`,
        ),
      });

      expect(result).toMatchObject({
        outcome: "done",
        totalIterations: 6,
        totalToolCalls: 2,
        completedSteps: [{
          step: 1,
        }],
      });
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        runId: run.runId,
        step: 1,
        status: "completed",
        toolCalls: [{
          callId: "read-field-brief",
          tool: "read_files",
          verificationPassed: true,
        }],
      });

      const validationInput = vi.mocked(provider.generateTurn).mock.calls[4]?.[0];
      const validationPrompt = extractStateView(
        validationInput.messages.find((message) => message.role === "user")?.content ?? "",
      );
      expect(validationPrompt.context.run.toolCalls).toEqual([
        expect.objectContaining({
          step: 1,
          stepKind: "transient_context",
          callId: "load-personal-memory",
          tool: "context_load",
        }),
        expect.objectContaining({
          step: 1,
          callId: "read-field-brief",
          tool: "read_files",
        }),
      ]);
      expect(validationPrompt.context.run.toolCalls[1]).not.toHaveProperty("stepKind");
      expect(validationPrompt.context.run.verifiedOutcomes).toContainEqual({
        kind: "file.read_complete",
        subject: target,
        actualKind: "file",
        source: {
          step: 1,
          callId: "read-field-brief",
          tool: "read_files",
        },
      });
      expect(JSON.stringify(validationPrompt.context.run.verifiedOutcomes))
        .not.toContain("context_load");
    } finally {
      cleanup(dataDir);
    }
  });

  it("keeps recent workstreams metadata-only until the agent loads its Hot Context entry", async () => {
    const dataDir = makeTmpDir();
    try {
      const hotContextRuntime = new HotContextRuntime({
        sources: [],
        runScopedKeys: [WORKSTREAMS_RECENT_HOT_CONTEXT_KEY],
      });
      const contextTool = createContextSkill({ hotContextRuntime }).tools[0]!;
      const toolExecutor = createToolExecutor([]);
      const capabilitySurfaceManager = new CapabilitySurfaceManager({
        registry: new ToolRegistry([contextTool]),
        toolExecutor,
        validateCoverage: false,
      });
      const provider = createProvider([
        {
          kind: "transition_mode",
          request: {
            to: "context.retrieve",
            purpose: "Load recent workstream navigation metadata.",
            capabilities: ["context:load"],
          },
        },
        {
          kind: "act",
          action: {
            mode: "single",
            calls: [{
              id: "load-recent-workstreams",
              tool: "context_load",
              input: { keys: [WORKSTREAMS_RECENT_HOT_CONTEXT_KEY] },
              dependsOn: [],
              purpose: "Load recent workstream navigation metadata",
            }],
            allowedTools: ["context_load"],
            assertions: [],
          },
        },
        {
          kind: "reply",
          status: "completed",
          message: "The Hot Context implementation is the recent workstream.",
        },
      ]);
      const run = runHandle("R-recent-workstreams");
      const harnessContext = unboundContext(
        run.runId,
        "Which workstream did we use recently?",
      );
      harnessContext.contextEngine!.agentStream.recentWorkstreams = [{
        workstreamId: "W-20260724-0001",
        title: "Hot Context implementation",
        lifecycleStatus: "active",
        repositoryHealth: "ready",
        currentRequest: {
          id: "R-0002",
          title: "Add recent workstreams",
          status: "active",
        },
        lastActivity: {
          kind: "bound",
          at: "2026-07-24T10:00:00.000Z",
        },
      }];

      const result = await agentLoop({
        provider,
        toolExecutor,
        capabilitySurfaceManager,
        hotContextRuntime,
        toolDefinitions: [contextTool],
        runRecorder: noopRunRecorder,
        runHandle: run,
        clientId: "c1",
        initialUserMessage: "Which workstream did we use recently?",
        dataDir,
        systemContext: "test system context",
        harnessContext,
      });

      expect(result).toMatchObject({
        outcome: "done",
        totalIterations: 3,
        totalToolCalls: 1,
        completedSteps: [],
      });
      const calls = vi.mocked(provider.generateTurn).mock.calls;
      const initialPromptText = calls[0]?.[0].messages
        .find((message) => message.role === "user")?.content ?? "";
      const initialPrompt = extractStateView(initialPromptText);
      expect(initialPrompt.context.hot).toMatchObject({
        available: [{ key: WORKSTREAMS_RECENT_HOT_CONTEXT_KEY }],
        loaded: [],
      });
      expect(initialPromptText).not.toContain("W-20260724-0001");
      expect(initialPrompt.context).not.toHaveProperty("work");
      expect(initialPrompt.context).not.toHaveProperty("resources");
      expect(initialPrompt.context).not.toHaveProperty("observations");

      const loadedPromptText = calls[2]?.[0].messages
        .find((message) => message.role === "user")?.content ?? "";
      const loadedPrompt = extractStateView(loadedPromptText);
      expect(loadedPrompt.context.hot.loaded).toEqual([
        expect.objectContaining({
          key: WORKSTREAMS_RECENT_HOT_CONTEXT_KEY,
          content: expect.stringContaining("W-20260724-0001"),
        }),
      ]);
      expect(loadedPromptText.match(/W-20260724-0001/g)).toHaveLength(1);
    } finally {
      cleanup(dataDir);
    }
  });

  it("removes a recovered transition repair from later prompts while retaining audit feedback", async () => {
    const dataDir = makeTmpDir();
    try {
      const notesPath = join(dataDir, "requested-notes.md");
      writeFileSync(notesPath, "requested notes\n", "utf8");
      const findTool: ToolDefinition = {
        ...fixtureTool("find_files"),
        async execute() {
          return foundFileResult(notesPath);
        },
      };
      const read = readTool();
      const feedback = createMemoryFeedbackLedger();
      const provider = createProvider([
        {
          kind: "transition_mode",
          request: {
            to: "observe.investigate",
            purpose: "Read an assumed notes path.",
            capabilities: ["file:read"],
            targets: ["/tmp/invented-notes.md"],
          },
        },
        {
          kind: "transition_mode",
          request: {
            to: "observe.locate",
            purpose: "Locate the requested notes file.",
            capabilities: ["domain:filesystem"],
          },
        },
        {
          kind: "transition_mode",
          request: {
            to: "observe.locate",
            purpose: "Locate the requested notes file.",
            capabilities: ["file:search"],
          },
        },
        {
          kind: "act",
          action: {
            mode: "single",
            calls: [{
              id: "find-requested-notes",
              tool: "find_files",
              input: {},
              dependsOn: [],
              purpose: "Find the requested notes file",
            }],
            allowedTools: ["find_files"],
            assertions: [],
          },
        },
        ...validationDecisions({
          path: notesPath,
          response: `Found ${notesPath}.`,
          id: "requested-notes",
        }),
      ]);

      const result = await agentLoop({
        provider,
        toolExecutor: createToolExecutor([findTool, read, inspectPathsTool]),
        toolDefinitions: [findTool, read, inspectPathsTool],
        feedbackLedger: feedback.ledger,
        runRecorder: noopRunRecorder,
        runHandle: runHandle("R-recovered-transition-repairs"),
        clientId: "c1",
        initialUserMessage: "Find the requested notes file without modifying anything.",
        dataDir,
        systemContext: "test system context",
        harnessContext: unboundContext(
          "R-recovered-transition-repairs",
          "Find the requested notes file without modifying anything.",
        ),
      });

      expect(result).toMatchObject({
        outcome: "done",
        totalIterations: 5,
        totalToolCalls: 1,
      });
      expect(provider.generateTurn).toHaveBeenCalledTimes(6);

      const decisionView = (index: number): Record<string, any> => {
        const input = vi.mocked(provider.generateTurn).mock.calls[index]?.[0];
        const prompt = input.messages.find((message) => message.role === "user")?.content;
        expect(typeof prompt).toBe("string");
        return extractStateView(prompt as string);
      };
      const afterDirectReadMode = decisionView(1);
      const capabilityRepairInput = vi.mocked(provider.generateTurn).mock.calls[2]?.[0];
      const capabilityRepairPrompt = capabilityRepairInput.messages.at(-1)?.content ?? "";
      const duringCapabilityRepair = decisionView(2);
      const afterAcceptedTransition = decisionView(3);
      const afterVerifiedAction = decisionView(4);

      expect(JSON.stringify(afterDirectReadMode)).toContain("/tmp/invented-notes.md");
      expect(JSON.stringify(afterDirectReadMode)).not.toContain("MODE_TARGET_UNVERIFIED");
      expect(JSON.stringify(duringCapabilityRepair)).toContain("/tmp/invented-notes.md");
      expect(capabilityRepairPrompt).toContain("Repair code: R_TOOL_INPUT_INVALID");
      expect(JSON.stringify(feedback.events.find(
        (event) => event.event === "input_schema_violation",
      ))).toContain("capabilities.0 must be one of");
      expect(JSON.stringify(afterAcceptedTransition)).not.toContain("/tmp/invented-notes.md");
      expect(JSON.stringify(afterAcceptedTransition)).not.toContain("Unknown capability ids");
      expect(JSON.stringify(afterAcceptedTransition)).not.toContain("domain:filesystem");
      expect(afterAcceptedTransition.context.harness).toBeUndefined();
      expect(afterAcceptedTransition.trace?.recentFailures).toBeUndefined();
      expect(JSON.stringify(afterVerifiedAction)).not.toContain("/tmp/invented-notes.md");
      expect(JSON.stringify(afterVerifiedAction)).not.toContain("Unknown capability ids");
      expect(JSON.stringify(afterVerifiedAction)).not.toContain("domain:filesystem");

      expect(feedback.events).toContainEqual(expect.objectContaining({
        stage: "decision",
        event: "repair_requested",
        data: expect.objectContaining({
          reason: "tool_input_schema_violation",
          repair: expect.objectContaining({
            code: "R_TOOL_INPUT_INVALID",
          }),
        }),
      }));
    } finally {
      cleanup(dataDir);
    }
  });

  it("locates a vague read target before investigating it in five decisions", async () => {
    const dataDir = makeTmpDir();
    const target = join(dataDir, "project-notes.md");
    writeFileSync(target, "upload handling lives in src/upload.ts\n", "utf8");
    try {
      const findTool: ToolDefinition = {
        ...fixtureTool("find_files"),
        async execute() {
          return foundFileResult(target);
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
            capabilities: ["file:read"],
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
        ...validationDecisions({
          path: target,
          response: "The project notes describe upload handling in src/upload.ts.",
          id: "project-notes",
          check: "read_complete",
        }),
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
        totalIterations: 6,
        totalToolCalls: 2,
      });
      expect(provider.generateTurn).toHaveBeenCalledTimes(6);
      const investigateInput = vi.mocked(provider.generateTurn).mock.calls[3]?.[0];
      expect(investigateInput.tools.map((tool) => tool.name)).toContain("read_files");
      expect(investigateInput.tools.map((tool) => tool.name)).not.toContain("find_files");
    } finally {
      cleanup(dataDir);
    }
  });

  it("enters proof-only validation and then replies without a second filesystem call", async () => {
    const dataDir = makeTmpDir();
    const target = join(dataDir, "validated-notes.md");
    writeFileSync(target, "validation mode works\n", "utf8");
    try {
      const read = readTool();
      const provider = createProvider([
        {
          kind: "transition_mode",
          request: {
            to: "observe.investigate",
            purpose: "Read the exact notes file requested by the user.",
            capabilities: ["file:read"],
            references: [{ kind: "filesystem", path: target }],
          },
        },
        {
          kind: "act",
          action: {
            mode: "single",
            calls: [{
              id: "read-validated-notes",
              tool: "read_files",
              input: { path: target },
              dependsOn: [],
              purpose: "Read the requested notes",
            }],
            allowedTools: ["read_files"],
            assertions: [],
          },
        },
        {
          kind: "transition_mode",
          request: {
            to: "validation",
            purpose: "Check current-run proof for the important notes file before responding.",
            capabilities: ["task:validation"],
            validationChecks: [{
              kind: "path.exists",
              subject: target,
              expectedKind: "file",
            }],
          },
        },
        {
          kind: "reply",
          status: "completed",
          message: `The verified notes file is at ${target}.`,
        },
      ]);

      const result = await agentLoop({
        provider,
        toolExecutor: createToolExecutor([read]),
        toolDefinitions: [read],
        runRecorder: noopRunRecorder,
        runHandle: runHandle("R-validation-mode"),
        clientId: "c1",
        initialUserMessage: `Read ${target} and report its location.`,
        dataDir,
        systemContext: "test system context",
        harnessContext: unboundContext(
          "R-validation-mode",
          `Read ${target} and report its location.`,
        ),
      });

      expect(result).toMatchObject({
        outcome: "done",
        stopReason: "completed",
        content: `The verified notes file is at ${target}.`,
        totalIterations: 4,
        totalToolCalls: 1,
      });
      const finalInput = vi.mocked(provider.generateTurn).mock.calls[3]?.[0];
      const finalPrompt = finalInput.messages.find((message) => message.role === "user")?.content ?? "";
      expect(finalPrompt).toContain("\"active\": \"validation\"");
      expect(finalPrompt).toContain("\"status\": \"passed\"");
      expect(finalInput.tools.map((tool) => tool.name)).toContain("decision_stop");
    } finally {
      cleanup(dataDir);
    }
  });

  it("records an observational step on the same unbound run", async () => {
    const dataDir = makeTmpDir();
    try {
      const target = join(dataDir, "src", "upload.ts");
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, "export const upload = true;\n", "utf8");
      const tool = readTool();
      const toolExecutor = createToolExecutor([tool]);
      const provider = createProvider([
        {
          kind: "transition_mode",
          request: {
            to: "observe.investigate",
            purpose: "Read the exact source file named by the user.",
            capabilities: ["file:read"],
            references: [{ kind: "filesystem", path: target }],
          },
        },
        {
          kind: "act",
          action: {
            mode: "single",
            calls: [{
              id: "read-upload",
              tool: "read_files",
              input: { path: target },
              dependsOn: [],
              purpose: "Locate upload handling",
            }],
            allowedTools: ["read_files"],
            assertions: [],
          },
        },
        ...validationDecisions({
          path: target,
          response: `Upload handling is in ${target}.`,
          id: "upload",
          check: "read_complete",
        }),
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
        initialUserMessage: `Read ${target} and tell me where upload handling lives.`,
        dataDir,
        systemContext: "test system context",
        harnessContext: unboundContext("R-read", `Read ${target} and tell me where upload handling lives.`),
      });

      expect(result).toMatchObject({
        runId: "R-read",
        outcome: "done",
        stopReason: "completed",
        totalToolCalls: 1,
        workState: {
          status: "done",
          summary: `Verified a complete read of ${target}.`,
          plan: [],
          importantContext: [{
            kind: "finding",
            value: `Verified a complete read of ${target}.`,
            ref: "run:R-read:step:1:call:read-upload",
          }],
        },
      });
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        runId: "R-read",
        step: 1,
        status: "completed",
        toolCalls: [{
          tool: "read_files",
          callId: "read-upload",
          status: "success",
          verification: {
            version: 1,
            status: "passed",
            method: "runtime_check",
            contract: "deterministic_success_gate_v1",
          },
          verificationPassed: true,
          completionEvidence: expect.arrayContaining([
            expect.objectContaining({
              kind: "file_read",
              path: target,
              coverage: "complete",
              contentAvailable: true,
            }),
          ]),
        }],
      });

      const thirdInput = vi.mocked(provider.generateTurn).mock.calls[2]?.[0];
      const prompt = thirdInput.messages.find((message) => message.role === "user")?.content;
      expect(typeof prompt).toBe("string");
      const stateView = extractStateView(prompt as string);
      expect(Object.keys(stateView.context.run).sort()).toEqual([
        "mode",
        "toolCalls",
        "verifiedOutcomes",
        "workspaceRoot",
      ]);
      expect(stateView.context.run).not.toHaveProperty("runId");
      expect(stateView.context.run).not.toHaveProperty("status");
      expect(stateView.context.run).not.toHaveProperty("routing");
      expect(stateView.context.run.toolCalls[0]).toMatchObject({
        tool: "read_files",
        purpose: "Locate upload handling",
        status: "success",
        verificationStatus: "passed",
      });
      expect(stateView.context.run.toolCalls[0]).not.toHaveProperty("verification");
      expect(stateView.context.run.toolCalls[0]).not.toHaveProperty("verificationPassed");
      expect(stateView.context.run.toolCalls[0]).not.toHaveProperty("completionEvidence");
      expect(stateView.context.run.verifiedOutcomes).toContainEqual({
        kind: "file.read_complete",
        subject: target,
        actualKind: "file",
        source: {
          step: 1,
          callId: "read-upload",
          tool: "read_files",
        },
      });
    } finally {
      cleanup(dataDir);
    }
  });

  it("validates a requested line slice without reading the file again", async () => {
    const dataDir = makeTmpDir();
    try {
      const target = join(dataDir, "src", "parser.ts");
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(
        target,
        Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n"),
        "utf8",
      );
      const provider = createProvider([
        {
          kind: "transition_mode",
          request: {
            to: "observe.investigate",
            purpose: "Read only the exact source lines requested by the user.",
            capabilities: ["file:read"],
            references: [{ kind: "filesystem", path: target }],
          },
        },
        {
          kind: "act",
          action: {
            mode: "single",
            calls: [{
              id: "read-parser-slice",
              tool: "read_files",
              input: {
                files: [{
                  path: target,
                  mode: "slice",
                  startLine: 10,
                  lineCount: 5,
                }],
              },
              dependsOn: [],
              purpose: "Read lines 10 through 14",
            }],
            allowedTools: ["read_files"],
            assertions: [],
          },
        },
        {
          kind: "transition_mode",
          request: {
            to: "validation",
            purpose: "Validate that the requested line range was returned.",
            capabilities: ["task:validation"],
            validationChecks: [{
              kind: "file.read_scope_satisfied",
              subject: target,
              expectedKind: "file",
              readScope: {
                mode: "slice",
                startLine: 10,
                endLine: 14,
              },
            }],
          },
        },
        {
          kind: "reply",
          status: "completed",
          message: "Lines 10 through 14 contain line 10, line 11, line 12, line 13, and line 14.",
        },
      ]);
      const records: ContextRunStepRecord[] = [];

      const result = await agentLoop({
        provider,
        toolExecutor: createToolExecutor([readFilesTool]),
        toolDefinitions: [readFilesTool],
        runRecorder: noopRunRecorder,
        runHandle: runHandle("R-slice-read"),
        recordRunStep(record) {
          records.push(record);
        },
        clientId: "c1",
        initialUserMessage: `Read only lines 10 through 14 from ${target}.`,
        dataDir,
        systemContext: "test system context",
        harnessContext: unboundContext(
          "R-slice-read",
          `Read only lines 10 through 14 from ${target}.`,
        ),
      });

      expect(result).toMatchObject({
        runId: "R-slice-read",
        outcome: "done",
        stopReason: "completed",
        totalToolCalls: 1,
        workState: {
          status: "done",
          importantContext: [{
            kind: "finding",
            value: `Verified a read of lines 10-14 from ${target}.`,
            ref: "run:R-slice-read:step:1:call:read-parser-slice",
          }],
        },
      });
      expect(records).toHaveLength(1);
      expect(records[0]?.toolCalls).toEqual([
        expect.objectContaining({
          tool: "read_files",
          callId: "read-parser-slice",
          verification: expect.objectContaining({
            status: "passed",
          }),
          completionEvidence: expect.arrayContaining([
            expect.objectContaining({
              kind: "file_read",
              path: target,
              mode: "slice",
              coverage: "partial",
              truncated: false,
              startLine: 10,
              endLine: 14,
            }),
          ]),
        }),
      ]);
      const finalInput = vi.mocked(provider.generateTurn).mock.calls[3]?.[0];
      const finalPrompt = finalInput.messages.find((message) => message.role === "user")?.content ?? "";
      expect(finalPrompt).toContain("\"status\": \"passed\"");
      expect(finalPrompt).toContain("\"file.read_scope_satisfied\"");
    } finally {
      cleanup(dataDir);
    }
  });

  it("lets accepted validation recover after an unnecessary duplicate read is blocked", async () => {
    const dataDir = makeTmpDir();
    try {
      const target = join(dataDir, "riverstone-brief.txt");
      writeFileSync(target, "Build a small responsive cafe website.\n", "utf8");
      const readInput = {
        files: [{
          path: target,
          mode: "full",
        }],
      };
      const feedback = createMemoryFeedbackLedger();
      const provider = createProvider([
        {
          kind: "transition_mode",
          request: {
            to: "observe.investigate",
            purpose: "Read the exact website brief requested by the user.",
            capabilities: ["file:read"],
            references: [{ kind: "filesystem", path: target }],
          },
        },
        {
          kind: "act",
          action: {
            mode: "single",
            calls: [{
              id: "read-brief",
              tool: "read_files",
              input: readInput,
              dependsOn: [],
              purpose: "Read the complete website brief",
            }],
            allowedTools: ["read_files"],
            assertions: [],
          },
        },
        {
          kind: "act",
          action: {
            mode: "single",
            calls: [{
              id: "read-brief-again",
              tool: "read_files",
              input: readInput,
              dependsOn: [],
              purpose: "Read the same website brief again",
            }],
            allowedTools: ["read_files"],
            assertions: [],
          },
        },
        ...validationDecisions({
          path: target,
          response: "The brief asks for a small responsive cafe website.",
          id: "riverstone-brief",
          check: "read_complete",
        }),
      ]);
      const records: ContextRunStepRecord[] = [];
      const runId = "R-duplicate-read-recovery";

      const result = await agentLoop({
        provider,
        toolExecutor: createToolExecutor([readFilesTool]),
        toolDefinitions: [readFilesTool],
        feedbackLedger: feedback.ledger,
        runRecorder: noopRunRecorder,
        runHandle: runHandle(runId),
        recordRunStep(record) {
          records.push(record);
        },
        clientId: "c1",
        initialUserMessage: `Read ${target} and explain what it asks for.`,
        dataDir,
        systemContext: "test system context",
        harnessContext: unboundContext(
          runId,
          `Read ${target} and explain what it asks for.`,
        ),
      });

      expect(result).toMatchObject({
        runId,
        outcome: "done",
        stopReason: "completed",
        content: "The brief asks for a small responsive cafe website.",
        totalIterations: 5,
        totalToolCalls: 1,
      });
      expect(records).toHaveLength(1);
      expect(feedback.events).toContainEqual(expect.objectContaining({
        stage: "guard",
        event: "read_progress_repair_requested",
        data: expect.objectContaining({
          repair: expect.objectContaining({
            code: "R_DUPLICATE_READ",
          }),
        }),
      }));
      expect(feedback.events).toContainEqual(expect.objectContaining({
        stage: "guard",
        event: "repair_resolved",
        data: expect.objectContaining({
          resolutionKind: "validation_accepted",
          scopes: ["navigation", "validation"],
          resolvedCount: 1,
        }),
      }));
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
      const toolExecutor = createToolExecutor([writeFilesTool, routingTool, inspectPathsTool]);
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
            to: "workstream.route",
            purpose: "Use the observed ownership evidence to prepare deterministic binding.",
          },
        },
        {
          kind: "transition_mode",
          request: {
            to: "resolve",
            purpose: "Bind the exact output target before creating it.",
            capabilities: ["file:write"],
            workspaceTargets: [{
              kind: "file",
              relativePath: "must-not-exist.txt",
            }],
            binding: createBindingProposal(runId, routingCallId),
          },
        },
        {
          kind: "stop",
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
        totalIterations: 5,
        totalToolCalls: 1,
        content: "I could not safely create the file because workstream binding is unavailable.",
        workState: {
          status: "in_progress",
          summary: "The run failed before completion.",
        },
      });
      expect(result.workState?.summary).not.toBe(result.content);
      expect(existsSync(outputPath)).toBe(false);
      expect(recordRunStep).toHaveBeenCalledOnce();
      expect(provider.generateTurn).toHaveBeenCalledTimes(5);
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
    const runId = "R-read-only-mutation";
    try {
      const mutationAttempt = {
        kind: "transition_mode",
        request: {
          to: "resolve",
          purpose: "Attempt mutation despite the read-only request.",
          capabilities: ["file:write"],
          workspaceTargets: [{
            kind: "file",
            relativePath: "must-stay-absent.txt",
          }],
          binding: createBindingProposal(runId, "unreachable-routing-evidence"),
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
        runHandle: runHandle(runId),
        config: { maxConsecutiveFailures: 3 },
        clientId: "c1",
        initialUserMessage: `Inspect ${outputPath} only; do not modify anything.`,
        dataDir,
        systemContext: "test system context",
        harnessContext: unboundContext(runId, `Inspect ${outputPath} only; do not modify anything.`),
      });

      expect(result).toMatchObject({
        outcome: "failed",
        totalIterations: 3,
        totalToolCalls: 0,
        content: "I couldn't complete this request. The request could not be completed safely.",
      });
      expect(result.content).not.toContain("MODE_MUTATION_INTENT_REQUIRED");
      expect(provider.generateTurn).toHaveBeenCalledTimes(3);
      expect(workstreamBinding.bind).not.toHaveBeenCalled();
      expect(existsSync(outputPath)).toBe(false);
    } finally {
      cleanup(dataDir);
    }
  });

  it("allows one corrected binding call after a retryable no-change rejection", async () => {
    const dataDir = makeTmpDir();
    const runId = "R-repeated-load";
    const routingCallId = "find-existing-project";
    const projectPath = join(dataDir, "existing-project");
    try {
      const routingSearch = workstreamSearchTool();
      const routingTools = [
        routingSearch,
        fixtureTool("git_context_inspect_resource"),
        fixtureTool("git_context_activate_workstream"),
        fixtureTool("git_context_create_workstream"),
      ];
      const toolExecutor = createToolExecutor([]);
      const mutationTools = [
        fixtureTool("create_directory"),
        writeFilesTool,
        fixtureTool("patch_files"),
      ];
      const capabilitySurfaceManager = new CapabilitySurfaceManager({
        registry: new ToolRegistry([...mutationTools, ...routingTools]),
        toolExecutor,
        validateCoverage: false,
      });
      const provider = createProvider([
        {
          kind: "transition_mode",
          request: {
            to: "observe.locate",
            purpose: "Find the workstream that owns the project.",
            capabilities: ["workstream:search"],
            targets: [projectPath],
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
            to: "workstream.route",
            purpose: "Use the observed owner candidates to prepare deterministic binding.",
          },
        },
        {
          kind: "transition_mode",
          request: {
            to: "resolve",
            purpose: "Bind the exact project before writing.",
            capabilities: ["file:write"],
            workspaceTargets: [{
              kind: "directory",
              relativePath: "existing-project",
            }],
            binding: createBindingProposal(runId, routingCallId),
          },
        },
        {
          kind: "transition_mode",
          request: {
            to: "resolve",
            purpose: "Retry once with the corrected request lifecycle route.",
            capabilities: ["file:write"],
            workspaceTargets: [{
              kind: "directory",
              relativePath: "existing-project",
            }],
            binding: createBindingProposal(runId, routingCallId),
          },
        },
        {
          kind: "stop",
          request: {
            outcome: "failed",
            summary: "The corrected deterministic binding attempt also failed.",
            response: "Workstream binding failed, so no file was changed.",
          },
        },
      ]);
      const feedback = createMemoryFeedbackLedger();
      const workstreamBinding = {
        bind: vi.fn()
          .mockResolvedValueOnce({
            status: "failed" as const,
            code: "WORKSTREAM_CURRENT_REQUEST_INVALID",
            message: "The first route was rejected without changing state.",
            retryable: true,
            attemptDisposition: "retryable_no_change" as const,
          })
          .mockResolvedValueOnce({
            status: "failed" as const,
            code: "WORKSTREAM_BINDING_TEST_FAILURE",
            message: "The corrected fixture binding failed.",
            retryable: false,
            attemptDisposition: "consumed" as const,
          }),
      };

      const result = await agentLoop({
        provider,
        toolExecutor,
        capabilitySurfaceManager,
        toolDefinitions: [...mutationTools, ...routingTools],
        runRecorder: noopRunRecorder,
        runHandle: runHandle(runId),
        workstreamBinding,
        feedbackLedger: feedback.ledger,
        clientId: "c1",
        initialUserMessage: `Create a file in ${projectPath}`,
        dataDir,
        systemContext: "test system context",
        harnessContext: unboundContext(runId, `Create a file in ${projectPath}`),
      });

      expect(result).toMatchObject({
        runId,
        outcome: "failed",
        stopReason: "failed",
        totalIterations: 6,
        totalToolCalls: 1,
        content: "Workstream binding failed, so no file was changed.",
      });
      expect(provider.generateTurn).toHaveBeenCalledTimes(6);
      expect(workstreamBinding.bind).toHaveBeenCalledTimes(2);
      const firstInput = vi.mocked(provider.generateTurn).mock.calls[0]?.[0];
      expect(firstInput.tools.map((tool) => tool.name)).toEqual([
        "decision_enter_observe_locate",
        "decision_enter_observe_investigate",
      ]);
      expect(firstInput.tools.map((tool) => tool.name)).not.toContain("write_files");
      const secondInput = vi.mocked(provider.generateTurn).mock.calls[1]?.[0];
      expect(secondInput.tools.map((tool) => tool.name)).toContain("git_context_find_workstreams");
      expect(secondInput.tools.map((tool) => tool.name)).not.toContain("git_context_create_workstream");
      expect(secondInput.tools.map((tool) => tool.name)).not.toContain("git_context_activate_workstream");
      const correctionInput = vi.mocked(provider.generateTurn).mock.calls[4]?.[0];
      const correctionPrompt = correctionInput.messages
        .map((message) => message.content)
        .join("\n");
      expect(correctionPrompt).toContain(
        "Correct the request lifecycle operation using the observed request state, then retry resolve once.",
      );
      expect(correctionPrompt).not.toContain(
        "without replaying mutation",
      );
      expect(feedback.events.find((event) =>
        event.stage === "final" && event.event === "reply")?.data?.["feedbackSummary"])
        .toMatchObject({
          navigation: {
            bindingAttempts: 2,
            bindingStatus: "failed",
          },
        });
      expect(feedback.events.some((event) => event.event === "mode_transition_no_progress")).toBe(false);
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
      const toolExecutor = createToolExecutor([writeFilesTool, routingTool, inspectPathsTool]);
      const provider = createProvider([
        {
          kind: "transition_mode",
          request: {
            to: "observe.locate",
            purpose: "Check whether durable work already owns this output.",
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
              purpose: "Find an existing owner before binding",
            }],
            allowedTools: ["git_context_find_workstreams"],
            assertions: [],
          },
        },
        {
          kind: "transition_mode",
          request: {
            to: "workstream.route",
            purpose: "Use the observed owner candidates to prepare deterministic binding.",
          },
        },
        {
          kind: "transition_mode",
          request: {
            to: "resolve",
            purpose: "Bind the requested output before creating it.",
            capabilities: ["file:write"],
            workspaceTargets: [{
              kind: "file",
              relativePath: "one-run.txt",
            }],
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
        ...validationDecisions({
          path: outputPath,
          response: "Created one-run.txt.",
          id: "one-run",
        }),
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
        toolDefinitions: [writeFilesTool, routingTool, inspectPathsTool],
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
      expect(result.verifiedCompletionResources).toEqual([
        expect.objectContaining({
          role: "deliverable",
          kind: "file",
          locator: { kind: "filesystem", path: outputPath },
        }),
      ]);
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
      expect(provider.generateTurn).toHaveBeenCalledTimes(7);
      expect(feedback.events.find((event) => event.stage === "final" && event.event === "reply")?.data?.["feedbackSummary"])
        .toMatchObject({
          navigation: {
            currentMode: "validation",
            transitionRequests: 4,
            transitionAccepted: 4,
            transitionRejected: 0,
            bindingAttempts: 1,
            bindingStatus: "resolved",
            terminalStopAttempts: 0,
            terminalStopAccepted: 0,
            terminalStopRejected: 0,
          },
        });
      expect(feedback.events.filter((event) =>
        event.stage === "workstream_binding" && event.event === "deterministic_binding_started"))
        .toHaveLength(1);

      const firstInput = vi.mocked(provider.generateTurn).mock.calls[0]?.[0];
      const secondInput = vi.mocked(provider.generateTurn).mock.calls[1]?.[0];
      const thirdInput = vi.mocked(provider.generateTurn).mock.calls[2]?.[0];
      const fourthInput = vi.mocked(provider.generateTurn).mock.calls[3]?.[0];
      const fifthInput = vi.mocked(provider.generateTurn).mock.calls[4]?.[0];
      expect(firstInput.tools.map((tool) => tool.name)).toEqual([
        "decision_enter_observe_locate",
        "decision_enter_observe_investigate",
      ]);
      expect(firstInput.tools.map((tool) => tool.name)).not.toContain("workstream_resolve");
      expect(firstInput.tools.map((tool) => tool.name)).not.toContain("write_files");
      expect(secondInput.tools.map((tool) => tool.name)).toContain("git_context_find_workstreams");
      expect(secondInput.tools.map((tool) => tool.name)).toContain("decision_stop");
      expect(secondInput.tools.map((tool) => tool.name)).not.toContain("decision_resolve_create");
      expect(thirdInput.tools.map((tool) => tool.name)).toContain("decision_enter_workstream_route");
      expect(fourthInput.tools.map((tool) => tool.name)).toContain("decision_resolve_activate");
      expect(fourthInput.tools.map((tool) => tool.name)).toContain("decision_resolve_create");
      expect(fourthInput.tools.map((tool) => tool.name)).not.toContain("git_context_find_workstreams");
      expect(fifthInput.tools.map((tool) => tool.name)).toContain("write_files");
      expect(fifthInput.tools.map((tool) => tool.name)).toContain("decision_stop");
      const fifthPromptText = fifthInput.messages
        .find((message) => message.role === "user")?.content ?? "";
      const fifthPrompt = extractStateView(fifthPromptText);
      expect(fifthPrompt.context.run.boundWorkstream).toEqual({
        id: "W-20260719-0001",
        title: "One run file",
        purpose: "Create one-run.txt",
        summary: "Create and verify the requested file.",
        lifecycleStatus: "active",
        blockers: [],
        nextAction: "Create one-run.txt",
        request: {
          id: "R-0001",
          title: "Create one-run.txt",
          status: "active",
          request: "Create one-run.txt",
          acceptance: ["one-run.txt exists and is verified."],
          constraints: [],
          lifecycleNote: "Selected for the current run.",
        },
        recentProgress: [{
          runId: "RUN-EARLIER",
          outcome: "incomplete",
          summary: "Prepared the output location.",
          validation: "The requested file remains.",
          next: "Create one-run.txt",
        }],
        resources: [{
          id: "RES-AAAAAAAAAAAAAAAAAAAAAAAA",
          name: "One run output",
          kind: "directory",
          description: "User-visible output directory for the one-run fixture.",
          aliases: ["one run output"],
          locator: {
            kind: "filesystem",
            path: dataDir,
          },
          role: "primary",
          access: "mutate",
          availability: "available",
          primary: true,
          requestRelevant: true,
        }],
        otherResourceCount: 0,
      });
      expect(
        JSON.stringify(fifthPrompt.context.run.boundWorkstream).match(
          new RegExp(escapeRegex(dataDir), "g"),
        ),
      ).toHaveLength(1);
      expect(JSON.stringify(fifthPrompt.context.run.boundWorkstream)).not.toContain("abc123");
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
            to: "execute",
            purpose: "Use the existing binding to write the requested file.",
            capabilities: ["file:write"],
            targets: [outputPath],
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
        ...validationDecisions({
          path: outputPath,
          response: "Created one-run.txt.",
          id: "existing-one-run",
        }),
      ]);
      const workstreamBinding = { bind: vi.fn() };

      const result = await agentLoop({
        provider,
        toolExecutor: createToolExecutor([writeFilesTool, inspectPathsTool]),
        toolDefinitions: [writeFilesTool, inspectPathsTool],
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
        totalIterations: 4,
        totalToolCalls: 1,
      });
      expect(workstreamBinding.bind).not.toHaveBeenCalled();
      expect(provider.generateTurn).toHaveBeenCalledTimes(4);
      expect(readFileSync(outputPath, "utf8")).toBe("bound continuation");
    } finally {
      cleanup(dataDir);
    }
  });

  it("can validate and truthfully report one exact denied mutation without retrying it", async () => {
    const dataDir = makeTmpDir();
    const runId = "R-report-external-denial";
    const externalPath = join(dirname(dataDir), "outside", "report.txt");
    const deniedWriteTool: ToolDefinition = {
      ...writeFilesTool,
      async execute() {
        const message = `Mutation path is outside the configured Ayati workspace: ${externalPath}`;
        return {
          ok: false,
          error: message,
          v2: {
            transportOk: true,
            operationStatus: "failed",
            code: "PATH_OUTSIDE_MUTATION_WORKSPACE",
            message,
            error: {
              category: "permission",
              code: "PATH_OUTSIDE_MUTATION_WORKSPACE",
              message,
              retryable: false,
              recoverable: true,
              target: externalPath,
              suggestedNextActions: [
                "Choose an exact target inside the configured Ayati workspace.",
              ],
            },
          },
        };
      },
    };
    const provider = createProvider([
      {
        kind: "transition_mode",
        request: {
          to: "execute",
          purpose: "Attempt the exact requested write under the active binding.",
          capabilities: ["file:write"],
          targets: [externalPath],
        },
      },
      {
        kind: "act",
        action: {
          mode: "single",
          calls: [{
            id: "write-denied-outside-workspace",
            tool: "write_files",
            input: {
              files: [{ path: externalPath, content: "must not be written" }],
            },
            dependsOn: [],
            purpose: "Attempt the exact external write once.",
          }],
          allowedTools: ["write_files"],
          assertions: [],
        },
      },
      {
        kind: "transition_mode",
        request: {
          to: "validation",
          purpose: "Confirm the exact workspace-policy denial before reporting it.",
          capabilities: ["task:validation"],
          validationChecks: [{
            kind: "tool.call_denied",
            subject: "write-denied-outside-workspace",
            denialCode: "PATH_OUTSIDE_MUTATION_WORKSPACE",
          }],
        },
      },
      {
        kind: "reply",
        status: "completed",
        message: `I could not write ${externalPath} because filesystem mutations are restricted to Ayati's workspace.`,
      },
    ]);
    const records: ContextRunStepRecord[] = [];

    try {
      const result = await agentLoop({
        provider,
        toolExecutor: createToolExecutor([deniedWriteTool]),
        toolDefinitions: [deniedWriteTool],
        workstreamBinding: { bind: vi.fn() },
        runRecorder: noopRunRecorder,
        runHandle: runHandle(runId),
        recordRunStep(record) {
          records.push(record);
        },
        clientId: "c1",
        initialUserMessage: `Write a report to ${externalPath}. If that is not allowed, explain the restriction.`,
        dataDir,
        systemContext: "test system context",
        harnessContext: boundContext(
          runId,
          `Write a report to ${externalPath}. If that is not allowed, explain the restriction.`,
          dataDir,
        ),
      });

      expect(result).toMatchObject({
        runId,
        outcome: "done",
        stopReason: "completed",
        totalIterations: 4,
        totalToolCalls: 1,
        workState: {
          status: "done",
        },
      });
      expect(result.content).toContain("filesystem mutations are restricted");
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        status: "failed",
        toolCalls: [{
          callId: "write-denied-outside-workspace",
          status: "failed",
          code: "PATH_OUTSIDE_MUTATION_WORKSPACE",
          errorCategory: "permission",
          errorTarget: externalPath,
          operationStatus: "failed",
        }],
      });
      expect(existsSync(externalPath)).toBe(false);
      expect(provider.generateTurn).toHaveBeenCalledTimes(4);
    } finally {
      cleanup(dataDir);
    }
  });

  it("persists main-loop routing evidence but never records a failed gate as a task step", async () => {
    const dataDir = makeTmpDir();
    try {
      const runId = "R-routing-failure";
      const target = join(dataDir, "durable-work.txt");
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
            to: "workstream.route",
            purpose: "Use the observed owner candidates to prepare deterministic binding.",
          },
        },
        {
          kind: "transition_mode",
          request: {
            to: "resolve",
            purpose: "Bind ownership before creating the durable file.",
            capabilities: ["file:write"],
            workspaceTargets: [{
              kind: "file",
              relativePath: "durable-work.txt",
            }],
            binding: createBindingProposal(runId, routingCallId),
          },
        },
        {
          kind: "stop",
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
      expect(provider.generateTurn).toHaveBeenCalledTimes(5);
    } finally {
      cleanup(dataDir);
    }
  });

  it("uses a fresh main decision to present deterministic binding ambiguity", async () => {
    const dataDir = makeTmpDir();
    try {
      const runId = "R-routing-ambiguous";
      const target = join(dataDir, "site");
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
            to: "workstream.route",
            purpose: "Use the observed owner candidates to prepare deterministic binding.",
          },
        },
        {
          kind: "transition_mode",
          request: {
            to: "resolve",
            purpose: "Bind the website target before updating it.",
            capabilities: ["file:write"],
            workspaceTargets: [{
              kind: "directory",
              relativePath: "site",
            }],
            binding: createBindingProposal(runId, routingCallId),
          },
        },
        {
          kind: "stop",
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
      expect(provider.generateTurn).toHaveBeenCalledTimes(5);
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
          kind: "stop",
          request: {
            outcome: "needs_user_input",
            summary: "The requested file is ambiguous.",
            response: "Please confirm which file I should inspect: North or South.",
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
        content: "Please confirm which file I should inspect: North or South.",
        workState: {
          status: "needs_user_input",
        },
      });
      expect(provider.generateTurn).toHaveBeenCalledTimes(2);
    } finally {
      cleanup(dataDir);
    }
  });

  it("recovers from a rejected blocked stop by validating a conclusive no-match search", async () => {
    const dataDir = makeTmpDir();
    const runId = "R-verified-no-match";
    const query = "missing-orbit-manual.txt";
    const feedback = createMemoryFeedbackLedger();
    try {
      const provider = createProvider([
        {
          kind: "transition_mode",
          request: {
            to: "observe.locate",
            purpose: "Search the authorized workspace for the requested file.",
            capabilities: ["file:search"],
          },
        },
        {
          kind: "act",
          action: {
            mode: "single",
            calls: [{
              id: "find-missing-file",
              tool: "find_files",
              input: {
                query,
                roots: [dataDir],
              },
              dependsOn: [],
              purpose: "Search the complete authorized workspace for the named file",
            }],
            allowedTools: ["find_files"],
            assertions: [],
          },
        },
        {
          kind: "stop",
          request: {
            outcome: "blocked",
            summary: "The requested file was not found.",
            response: "I could not find the requested file.",
          },
        },
        {
          kind: "transition_mode",
          request: {
            to: "validation",
            purpose: "Validate the complete zero-match search before responding.",
            capabilities: ["task:validation"],
            validationChecks: [{
              kind: "file.search_no_match",
              subject: query,
              searchScope: {
                roots: [dataDir],
                maxDepth: 10,
                includeHidden: false,
              },
            }],
          },
        },
        {
          kind: "reply",
          status: "completed",
          message: "I searched the authorized workspace, but that file was not found.",
        },
      ]);

      const result = await agentLoop({
        provider,
        toolExecutor: createToolExecutor([findFilesTool]),
        toolDefinitions: [findFilesTool],
        feedbackLedger: feedback.ledger,
        runRecorder: noopRunRecorder,
        runHandle: runHandle(runId),
        clientId: "c1",
        initialUserMessage: `Find ${query} and tell me its procedure.`,
        dataDir,
        systemContext: "test system context",
        harnessContext: unboundContext(
          runId,
          `Find ${query} and tell me its procedure.`,
        ),
      });

      expect(result).toMatchObject({
        runId,
        outcome: "done",
        stopReason: "completed",
        status: "completed",
        content: "I searched the authorized workspace, but that file was not found.",
        totalIterations: 5,
        totalToolCalls: 1,
      });
      const validationInput = vi.mocked(provider.generateTurn).mock.calls[3]?.[0];
      const validationState = extractStateView(
        validationInput.messages.find((message) => message.role === "user")?.content ?? "",
      );
      expect(validationState.context.run.verifiedOutcomes).toContainEqual({
        kind: "file.search_no_match",
        subject: query,
        searchScope: {
          roots: [dataDir],
          maxDepth: 10,
          includeHidden: false,
        },
        source: {
          step: 1,
          callId: "find-missing-file",
          tool: "find_files",
        },
      });
      expect(feedback.events).toContainEqual(expect.objectContaining({
        stage: "guard",
        event: "repair_resolved",
        data: expect.objectContaining({
          resolutionKind: "validation_accepted",
          scopes: ["navigation", "validation"],
          resolvedCount: 1,
        }),
      }));
    } finally {
      cleanup(dataDir);
    }
  });

  it("preserves a full workstream clarification while bounding durable WorkState", async () => {
    const dataDir = makeTmpDir();
    const question = [
      "Should I create a new output resource or use an existing absolute path?",
      "Every mutation-capable tool requires a selected workstream resource before I can continue.",
      "If an existing path should be used, include the exact path and whether Ayati may modify it.",
      "I will wait for that choice before changing files so the durable resource catalog remains truthful.",
      "You may also name the intended deliverable if the destination should be created automatically.",
      "This clarification is intentionally long enough to exercise the durable finalization boundary.",
    ].join(" ");
    expect(question.length).toBeGreaterThan(500);
    try {
      const locateTool: ToolDefinition = {
        ...fixtureTool("find_files"),
        async execute() {
          return {
            ok: true,
            output: "(no matches)",
            structuredContent: { matches: [] },
          };
        },
      };
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
          kind: "act",
          action: {
            mode: "single",
            calls: [{
              id: "find-destination",
              tool: "find_files",
              input: {},
              dependsOn: [],
              purpose: "Check whether the intended destination can be identified",
            }],
            allowedTools: ["find_files"],
            assertions: [],
          },
        },
        {
          kind: "stop",
          request: {
            outcome: "needs_user_input",
            summary: "The requested destination remains materially ambiguous.",
            response: question,
            evidenceRefs: [
              "run:R-bound-long-clarification:step:1:call:find-destination",
            ],
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
      expect(result.workState?.nextAction).not.toBe(question);
      expect(result.workState?.nextAction?.length).toBeLessThanOrEqual(320);
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
        content: "I couldn't complete this request. I could not make further verified progress.",
      });
      expect(result.content).not.toContain("already active");
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
