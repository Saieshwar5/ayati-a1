import { describe, it, expect, vi } from "vitest";
import {
  ControllerResponseFormatError,
  parseUnderstandResponse,
  parseReEvalResponse,
  parseDirectResponse,
  callUnderstand,
  callDirect,
  callReEval,
} from "../../src/ivec/controller.js";
import type { LlmProvider } from "../../src/core/contracts/provider.js";
import type { LlmTurnInput, LlmTurnOutput } from "../../src/core/contracts/llm-protocol.js";
import type { LoopState } from "../../src/ivec/types.js";
import type { ToolDefinition } from "../../src/skills/types.js";

function createMockProvider(
  response: string | string[],
  capabilities?: LlmProvider["capabilities"],
  providerName = "mock",
): LlmProvider {
  const replies = Array.isArray(response) ? [...response] : [response];
  return {
    name: providerName,
    version: "1.0.0",
    capabilities: capabilities ?? { nativeToolCalling: true },
    start: vi.fn(),
    stop: vi.fn(),
    generateTurn: vi
      .fn<(input: LlmTurnInput) => Promise<LlmTurnOutput>>()
      .mockImplementation(async () => ({
        type: "assistant",
        content: replies.shift() ?? replies[replies.length - 1] ?? "",
      })),
  };
}

function createState(overrides?: Partial<LoopState>): LoopState {
  return {
    runId: "r1",
    runClass: "interaction",
    userMessage: "hello",
    goal: {
      objective: "greet user",
      done_when: ["a friendly greeting is returned"],
      required_evidence: [],
      ask_user_when: [],
      stop_when_no_progress: [],
    },
    approach: "direct",
    sessionContextSummary: "",
    dependentTask: false,
    dependentTaskSummary: null,
    taskProgress: {
      status: "not_done",
      progressSummary: "",
      keyFacts: [],
      evidence: [],
    },
    status: "running",
    finalOutput: "",
    iteration: 0,
    maxIterations: 15,
    consecutiveFailures: 0,
    approachChangeCount: 0,
    completedSteps: [],
    recentContextSearches: [],
    runPath: "/tmp/test",
    failedApproaches: [],
    sessionHistory: [],
    recentTaskSummaries: [],
    recentSystemActivity: [],
    ...overrides,
  };
}

const shellTool: ToolDefinition = {
  name: "shell",
  description: "Run a shell command and return its output",
  inputSchema: {
    type: "object",
    required: ["cmd"],
    properties: { cmd: { type: "string", description: "The command to run" } },
  },
  execute: vi.fn().mockResolvedValue({ ok: true, output: "done" }),
};

function planCall(
  tool: string,
  input: Record<string, unknown> = {},
  overrides?: Partial<{
    id: string;
    origin: "builtin" | "external_tool";
    source_refs: string[];
    retry_policy: "none" | "same_call_once_on_timeout";
    depends_on: string[];
    purpose: string;
  }>,
): Record<string, unknown> {
  return {
    id: overrides?.id ?? tool.replaceAll(".", "_"),
    tool,
    input,
    origin: overrides?.origin ?? "builtin",
    source_refs: overrides?.source_refs ?? [],
    retry_policy: overrides?.retry_policy ?? "none",
    depends_on: overrides?.depends_on ?? [],
    purpose: overrides?.purpose ?? `Run ${tool}`,
  };
}

function executionPlan(
  mode: "single" | "sequential" | "parallel" | "autonomous",
  calls: Record<string, unknown>[] = [],
  allowedTools: string[] = [],
  maxCalls: number | null = null,
): Record<string, unknown> {
  return {
    mode,
    calls,
    allowed_tools: allowedTools,
    max_calls: maxCalls,
  };
}

function verificationContract(overrides?: Partial<{
  policy: "deterministic" | "llm" | "script" | "hybrid";
  rationale: string;
  expected_artifacts: string[];
  expected_state_change: string;
  requires_full_step_context: boolean;
}>): Record<string, unknown> {
  return {
    policy: overrides?.policy ?? "llm",
    rationale: overrides?.rationale ?? "Test fixture requires semantic validation.",
    expected_artifacts: overrides?.expected_artifacts ?? [],
    expected_state_change: overrides?.expected_state_change ?? "The step result is available for validation.",
    requires_full_step_context: overrides?.requires_full_step_context ?? false,
  };
}

describe("parseUnderstandResponse", () => {
  it("parses a completion directive (simple reply)", () => {
    const json = JSON.stringify({
      done: true,
      summary: "Hey there!",
      status: "completed",
    });
    const result = parseUnderstandResponse(json);
    expect(result.done).toBe(true);
    if (result.done) {
      expect(result.summary).toBe("Hey there!");
      expect(result.status).toBe("completed");
    }
  });

  it("parses an understand directive (complex task)", () => {
    const json = JSON.stringify({
      done: false,
      understand: true,
      goal: {
        objective: "Find and list all JS files",
        done_when: ["JS file paths are returned"],
        required_evidence: ["at least one JS file path"],
        ask_user_when: ["the search root is ambiguous"],
        stop_when_no_progress: ["two searches return no results"],
      },
      approach: "Use shell to run find command",
      session_context_summary: "The user previously asked about JS files under this repo.",
      dependent_task: false,
    });
    const result = parseUnderstandResponse(json);
    expect(result.done).toBe(false);
    if (!result.done) {
      expect(result.understand).toBe(true);
      expect(result.goal.objective).toBe("Find and list all JS files");
      expect(result.goal.done_when).toEqual(["JS file paths are returned"]);
      expect(result.approach).toBe("Use shell to run find command");
    }
  });

  it("parses a wrapped understand directive", () => {
    const json = JSON.stringify({
      kind: "understand",
      payload: {
        done: false,
        understand: true,
        goal: {
          objective: "Find and list all JS files",
          done_when: ["JS file paths are returned"],
          required_evidence: ["at least one JS file path"],
          ask_user_when: ["the search root is ambiguous"],
          stop_when_no_progress: ["two searches return no results"],
        },
        approach: "Use shell to run find command",
        session_context_summary: "The user previously asked about JS files under this repo.",
        dependent_task: false,
      },
    });
    const result = parseUnderstandResponse(json);
    expect(result.done).toBe(false);
    if (!result.done) {
      expect(result.understand).toBe(true);
      expect(result.goal.objective).toBe("Find and list all JS files");
    }
  });

  it("parses understand work_mode when provided", () => {
    const json = JSON.stringify({
      done: false,
      understand: true,
      goal: {
        objective: "analyze attached csv",
        done_when: ["the dataset question is answered"],
        required_evidence: ["query results are returned"],
        ask_user_when: [],
        stop_when_no_progress: ["dataset tools fail twice"],
      },
      approach: "use dataset tools",
      session_context_summary: "The uploaded CSV is the primary task input.",
      dependent_task: false,
      work_mode: "structured_data_process",
    });
    const result = parseUnderstandResponse(json);
    expect(result.done).toBe(false);
    if (!result.done) {
      expect(result.work_mode).toBe("structured_data_process");
    }
  });

  it("parses dependent task selection when provided", () => {
    const json = JSON.stringify({
      done: false,
      understand: true,
      goal: {
        objective: "continue the earlier config task",
        done_when: ["the config task is resumed correctly"],
        required_evidence: ["matching prior run context"],
        ask_user_when: [],
        stop_when_no_progress: ["the prior task cannot be identified"],
      },
      approach: "continue from the prior config run",
      session_context_summary: "Resume from the earlier config investigation.",
      dependent_task: true,
      dependent_task_slot: 2,
    });
    const result = parseUnderstandResponse(json);
    expect(result.done).toBe(false);
    if (!result.done) {
      expect(result.dependent_task).toBe(true);
      expect(result.dependent_task_slot).toBe(2);
    }
  });

  it("drops dependent_task_slot when dependent_task is false", () => {
    const json = JSON.stringify({
      done: false,
      understand: true,
      goal: {
        objective: "start a new task",
        done_when: ["the task is described"],
        required_evidence: ["a clear objective"],
        ask_user_when: [],
        stop_when_no_progress: ["planning cannot proceed"],
      },
      approach: "treat this as a fresh task",
      session_context_summary: "",
      dependent_task: false,
      dependent_task_slot: 2,
    });
    const result = parseUnderstandResponse(json);
    expect(result.done).toBe(false);
    if (!result.done) {
      expect(result.dependent_task).toBe(false);
      expect(result.dependent_task_slot).toBeUndefined();
    }
  });

  it("handles JSON wrapped in ```json fences", () => {
    const text = '```json\n{ "done": true, "summary": "done", "status": "completed" }\n```';
    const result = parseUnderstandResponse(text);
    expect(result.done).toBe(true);
  });

  it("extracts JSON when prose appears before it", () => {
    const text = 'I need to think first.\n{"done":true,"summary":"done","status":"completed"}';
    const result = parseUnderstandResponse(text);
    expect(result.done).toBe(true);
  });

  it("recovers Python-style booleans outside strings", () => {
    const text = '{"done": True, "summary": "done", "status": "completed"}';
    const result = parseUnderstandResponse(text);
    expect(result.done).toBe(true);
  });

  it("throws on invalid JSON", () => {
    expect(() => parseUnderstandResponse("not json")).toThrow();
  });
});

describe("parseDirectResponse", () => {
  it("parses StepDirective JSON", () => {
    const json = JSON.stringify({
      done: false,
      contract_version: 2,
      verification: verificationContract(),
      execution_contract: "read file",
      execution_plan: executionPlan("single", [
        planCall("read_file", { path: "config.json" }, { id: "read_config", purpose: "Read the config file" }),
      ]),
      success_criteria: "file content returned",
      context: "need to check config",
    });
    const result = parseDirectResponse(json);
    expect(result.done).toBe(false);
    if (!result.done && "execution_plan" in result) {
      expect(result.execution_contract).toBe("read file");
      expect(result.execution_plan.mode).toBe("single");
      expect(result.execution_plan.calls[0]?.tool).toBe("read_file");
    }
  });

  it("recovers Python-style literals in direct-stage controller envelopes", () => {
    const text = `{"kind":"step","payload":{"done":False,"contract_version":2,"verification":{"policy":"deterministic","rationale":"write_file success is enough for this fixture","expected_artifacts":["data/learning/system/active.json"],"expected_state_change":"The interest is active","requires_full_step_context":False},"execution_contract":"Create the 'machine-learning' interest directory","execution_plan":{"mode":"single","calls":[{"id":"write_active","tool":"write_file","input":{"path":"data/learning/system/active.json","content":"False stays text","createDirs":True,"previous":None},"origin":"builtin","source_refs":[],"retry_policy":"none","depends_on":[],"purpose":"Write active learning state"}],"allowed_tools":[],"max_calls":None},"success_criteria":"The interest is active","context":"Activate the selected interest"}}}`;
    const result = parseDirectResponse(text);
    expect(result.done).toBe(false);
    if (!result.done && "execution_plan" in result) {
      expect(result.execution_contract).toContain("machine-learning");
      const input = result.execution_plan.calls[0]?.input;
      expect(input?.["createDirs"]).toBe(true);
      expect(input?.["previous"]).toBeNull();
      expect(input?.["content"]).toBe("False stays text");
    }
  });

  it("throws when execution_plan is missing", () => {
    const json = JSON.stringify({
      done: false,
      contract_version: 2,
      verification: verificationContract(),
      execution_contract: "read file",
      success_criteria: "file content returned",
      context: "need to check config",
    });
    expect(() => parseDirectResponse(json)).toThrow(/execution_plan/);
  });

  it("parses CompletionDirective JSON", () => {
    const json = JSON.stringify({
      done: true,
      summary: "Task completed successfully",
      status: "completed",
    });
    const result = parseDirectResponse(json);
    expect(result.done).toBe(true);
    if (result.done) {
      expect(result.summary).toBe("Task completed successfully");
      expect(result.status).toBe("completed");
    }
  });

  it("parses context_search directive JSON", () => {
    const json = JSON.stringify({
      done: false,
      context_search: true,
      query: "What happened in step 3?",
      scope: "run_artifacts",
    });
    const result = parseDirectResponse(json);
    expect(result.done).toBe(false);
    if (!result.done && "context_search" in result) {
      expect(result.context_search).toBe(true);
      expect(result.query).toBe("What happened in step 3?");
      expect(result.scope).toBe("run_artifacts");
    }
  });

  it("parses context_search with skills scope", () => {
    const json = JSON.stringify({
      done: false,
      context_search: true,
      query: "agent-browser commands",
      scope: "skills",
    });
    const result = parseDirectResponse(json);
    expect(result.done).toBe(false);
    if (!result.done && "context_search" in result) {
      expect(result.scope).toBe("skills");
    }
  });

  it("parses document context_search with document_paths", () => {
    const json = JSON.stringify({
      done: false,
      context_search: true,
      query: "What is the termination clause?",
      scope: "documents",
      document_paths: ["/tmp/policy.pdf"],
    });
    const result = parseDirectResponse(json);
    expect(result.done).toBe(false);
    if (!result.done && "context_search" in result) {
      expect(result.scope).toBe("documents");
      expect(result.document_paths).toEqual(["/tmp/policy.pdf"]);
    }
  });

  it("parses builtin and external tool origins distinctly", () => {
    const json = JSON.stringify({
      done: false,
      contract_version: 2,
      verification: verificationContract(),
      execution_contract: "Use a built-in tool and an external tool",
      execution_plan: executionPlan("sequential", [
        planCall("shell", { cmd: "pwd" }, { id: "pwd", origin: "builtin", purpose: "Get current directory" }),
        planCall("demo-search.query", {}, {
          id: "external_query",
          origin: "external_tool",
          depends_on: ["pwd"],
          purpose: "Run external query",
        }),
      ]),
      success_criteria: "The planned tool calls are preserved",
      context: "Need to distinguish built-in tools from external tools",
    });
    const result = parseDirectResponse(json);
    expect(result.done).toBe(false);
    if (!result.done && "execution_plan" in result) {
      expect(result.execution_plan.calls[0]?.origin).toBe("builtin");
      expect(result.execution_plan.calls[1]?.origin).toBe("external_tool");
    }
  });

  it("parses read_run_state directives", () => {
    const json = JSON.stringify({
      kind: "read_run_state",
      payload: {
        done: false,
        read_run_state: true,
        action: "read_summary_window",
        window: { from: 1, to: 3 },
        reason: "Need older failed-step context",
      },
    });
    const result = parseDirectResponse(json);
    expect(result.done).toBe(false);
    if (!result.done && "read_run_state" in result) {
      expect(result.read_run_state).toBe(true);
      expect(result.action).toBe("read_summary_window");
      expect(result.window).toEqual({ from: 1, to: 3 });
    }
  });

  it("parses activate_skill directives and normalizes skill_id", () => {
    const json = JSON.stringify({
      kind: "activate_skill",
      payload: {
        done: false,
        activate_skill: true,
        skillId: " agent-browser ",
        reason: "Need live web tools",
      },
    });
    const result = parseDirectResponse(json);
    expect(result.done).toBe(false);
    if (!result.done && "activate_skill" in result) {
      expect(result.activate_skill).toBe(true);
      expect(result.skill_id).toBe("agent-browser");
      expect(result.reason).toBe("Need live web tools");
    }
  });

  it("rejects legacy read_skills directives", () => {
    const json = JSON.stringify({
      kind: "read_skills",
      payload: {
        done: false,
        read_skills: true,
        mode: "skill_details",
        skill_ids: ["agent-browser", "websearch"],
      },
    });
    expect(() => parseDirectResponse(json)).toThrow(/Unsupported direct response kind "read_skills"/);
  });

  it("extracts the first JSON object when prose surrounds it", () => {
    const text = 'I will respond with JSON now: {"done":true,"summary":"Task completed successfully","status":"completed"} Thanks!';
    const result = parseDirectResponse(text);
    expect(result.done).toBe(true);
    if (result.done) {
      expect(result.summary).toBe("Task completed successfully");
    }
  });
});

describe("parseReEvalResponse", () => {
  it("parses a re-eval directive without changing the goal contract", () => {
    const json = JSON.stringify({
      done: false,
      reeval: true,
      approach: "Use a narrower search strategy",
    });
    const result = parseReEvalResponse(json);
    expect(result.done).toBe(false);
    if (!result.done && "reeval" in result) {
      expect(result.reeval).toBe(true);
      expect(result.approach).toBe("Use a narrower search strategy");
    }
  });

  it("parses context_search during re-eval", () => {
    const json = JSON.stringify({
      done: false,
      context_search: true,
      query: "Read step 2 act and verify files",
      scope: "run_artifacts",
    });
    const result = parseReEvalResponse(json);
    expect(result.done).toBe(false);
    if (!result.done && "context_search" in result) {
      expect(result.context_search).toBe(true);
      expect(result.query).toBe("Read step 2 act and verify files");
      expect(result.scope).toBe("run_artifacts");
    }
  });

  it("parses read_run_state during re-eval", () => {
    const json = JSON.stringify({
      kind: "read_run_state",
      payload: {
        done: false,
        read_run_state: true,
        action: "read_step_full",
        step: 3,
      },
    });
    const result = parseReEvalResponse(json);
    expect(result.done).toBe(false);
    if (!result.done && "read_run_state" in result) {
      expect(result.action).toBe("read_step_full");
      expect(result.step).toBe(3);
    }
  });
});

describe("callUnderstand", () => {
  it("sends system context and returns parsed understand output", async () => {
    const json = JSON.stringify({
      done: false,
      understand: true,
      goal: {
        objective: "help user",
        done_when: ["the user receives a useful answer"],
        required_evidence: [],
        ask_user_when: [],
        stop_when_no_progress: [],
      },
      approach: "direct reply",
      session_context_summary: "The user is continuing a prior help request.",
      dependent_task: false,
    });
    const provider = createMockProvider(json);
    const state = createState({
      goal: {
        objective: "",
        done_when: [],
        required_evidence: [],
        ask_user_when: [],
        stop_when_no_progress: [],
      },
      approach: "",
    });

    const result = await callUnderstand(provider, state, [shellTool], "system context here");
    expect(result.done).toBe(false);
    if (!result.done) {
      expect(result.goal.objective).toBe("help user");
      expect(result.session_context_summary).toBe("The user is continuing a prior help request.");
    }

    // Verify system message was included
    const call = (provider.generateTurn as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(call.messages[0]!.role).toBe("system");
    expect(call.messages[0]!.content).toBe("system context here");
    expect(call.messages[1]!.content).toContain("Analyze this user request");
    expect(call.messages[1]!.content).toContain("shell");
  });

  it("includes session history and recent tasks in understand prompt", async () => {
    const json = JSON.stringify({
      done: false,
      understand: true,
      goal: {
        objective: "help user",
        done_when: ["the user receives a useful answer"],
        required_evidence: [],
        ask_user_when: [],
        stop_when_no_progress: [],
      },
      approach: "direct reply",
      session_context_summary: "Use the earlier folder lookup result if it is still relevant.",
      dependent_task: false,
    });
    const provider = createMockProvider(json);
    const state = createState({
      sessionHistory: [
        { role: "user", content: "find the folder slokan", timestamp: "2026-02-28T05:20:00Z", sessionPath: "/s/1" },
        { role: "assistant", content: "Found folder slokan at /home/slokan", timestamp: "2026-02-28T05:20:15Z", sessionPath: "/s/1" },
      ],
      recentTaskSummaries: [
        {
          timestamp: "2026-02-28T05:20:15Z",
          runId: "abc",
          runPath: "/runs/abc",
          runStatus: "completed",
          taskStatus: "done",
          objective: "Find the folder slokan",
          summary: "Found the folder slokan",
          completedMilestones: [],
          openWork: [],
          blockers: [],
          keyFacts: [],
          evidence: [],
          attachmentNames: [],
        },
      ],
    });

    await callUnderstand(provider, state, [shellTool], "system context");

    const call = (provider.generateTurn as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const prompt = call.messages[1]!.content;
    expect(prompt).toContain("Session conversation so far:");
    expect(prompt).toContain("find the folder slokan");
    expect(prompt).toContain("Found folder slokan");
    expect(prompt).toContain("Recent tasks (last 1, newest first; use slot numbers):");
    expect(prompt).toContain("slot=1");
    expect(prompt).toContain("task_status=done");
    expect(prompt).toContain("dependent_task");
    expect(prompt).toContain("dependent_task_slot");
    expect(prompt).not.toContain("runId=abc");
    expect(prompt).not.toContain("runPath=/runs/abc");
  });

  it("accepts a dependent task slot that matches a listed recent task", async () => {
    const json = JSON.stringify({
      done: false,
      understand: true,
      goal: {
        objective: "resume the earlier folder search",
        done_when: ["the earlier search context is resumed"],
        required_evidence: ["matching prior task context"],
        ask_user_when: [],
        stop_when_no_progress: ["the prior task cannot be resumed"],
      },
      approach: "continue the previous run",
      session_context_summary: "Resume from the earlier folder lookup.",
      dependent_task: true,
      dependent_task_slot: 1,
    });
    const provider = createMockProvider(json);
    const state = createState({
      recentTaskSummaries: [
        {
          timestamp: "2026-02-28T05:20:15Z",
          runId: "abc",
          runPath: "/runs/abc",
          runStatus: "completed",
          taskStatus: "done",
          objective: "Find the folder slokan",
          summary: "Found the folder slokan",
          completedMilestones: [],
          openWork: [],
          blockers: [],
          keyFacts: [],
          evidence: [],
          attachmentNames: [],
        },
      ],
    });

    const result = await callUnderstand(provider, state, [shellTool], "system context");
    expect(result.done).toBe(false);
    if (!result.done) {
      expect(result.dependent_task).toBe(true);
      expect(result.dependent_task_slot).toBe(1);
    }
  });

  it("sanitizes an out-of-range dependent task slot instead of retrying", async () => {
    const provider = createMockProvider(JSON.stringify({
      done: false,
      understand: true,
      goal: {
        objective: "resume the earlier folder search",
        done_when: ["the earlier search context is resumed"],
        required_evidence: ["matching prior task context"],
        ask_user_when: [],
        stop_when_no_progress: ["the prior task cannot be resumed"],
      },
      approach: "continue the previous run",
      session_context_summary: "Resume from the earlier folder lookup.",
      dependent_task: true,
      dependent_task_slot: 3,
    }));
    const state = createState({
      recentTaskSummaries: [
        {
          timestamp: "2026-02-28T05:20:15Z",
          runId: "abc",
          runPath: "/runs/abc",
          runStatus: "completed",
          taskStatus: "done",
          objective: "Find the folder slokan",
          summary: "Found the folder slokan",
          completedMilestones: [],
          openWork: [],
          blockers: [],
          keyFacts: [],
          evidence: [],
          attachmentNames: [],
        },
      ],
    });

    const result = await callUnderstand(provider, state, [shellTool], "system context");
    expect(result.done).toBe(false);
    if (!result.done) {
      expect(result.dependent_task).toBe(false);
      expect(result.dependent_task_slot).toBeUndefined();
    }
    expect(provider.generateTurn).toHaveBeenCalledTimes(1);
  });

  it("sanitizes dependent task metadata for system_event understand inputs", async () => {
    const provider = createMockProvider(JSON.stringify({
      done: false,
      understand: true,
      goal: {
        objective: "handle the system event",
        done_when: ["the event is handled"],
        required_evidence: ["a follow-up action is planned"],
        ask_user_when: [],
        stop_when_no_progress: ["the event payload is insufficient"],
      },
      approach: "continue from the prior run",
      session_context_summary: "",
      dependent_task: true,
      dependent_task_slot: 1,
    }));
    const state = createState({
      inputKind: "system_event",
      recentTaskSummaries: [
        {
          timestamp: "2026-02-28T05:20:15Z",
          runId: "abc",
          runPath: "/runs/abc",
          runStatus: "completed",
          taskStatus: "done",
          objective: "Find the folder slokan",
          summary: "Found the folder slokan",
          completedMilestones: [],
          openWork: [],
          blockers: [],
          keyFacts: [],
          evidence: [],
          attachmentNames: [],
        },
      ],
    });

    const result = await callUnderstand(provider, state, [shellTool], "system context");
    expect(result.done).toBe(false);
    if (!result.done) {
      expect(result.dependent_task).toBe(false);
      expect(result.dependent_task_slot).toBeUndefined();
    }

    const firstCall = (provider.generateTurn as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(provider.generateTurn).toHaveBeenCalledTimes(1);
    expect(firstCall.messages[1]!.content).not.toContain("Recent tasks (last 1");
  });

  it("sanitizes dependent_task_slot when dependent_task is false instead of retrying", async () => {
    const provider = createMockProvider(JSON.stringify({
      done: false,
      understand: true,
      goal: {
        objective: "start a fresh folder lookup",
        done_when: ["the new search is planned"],
        required_evidence: ["a concrete objective"],
        ask_user_when: [],
        stop_when_no_progress: ["the search cannot be scoped"],
      },
      approach: "start a new search",
      session_context_summary: "",
      dependent_task: false,
      dependent_task_slot: 1,
    }));

    const result = await callUnderstand(provider, createState(), [shellTool], "system context");
    expect(result.done).toBe(false);
    if (!result.done) {
      expect(result.dependent_task).toBe(false);
      expect(result.dependent_task_slot).toBeUndefined();
    }
    expect(provider.generateTurn).toHaveBeenCalledTimes(1);
  });

  it("includes low-risk vs high-cost clarification guidance in understand prompt", async () => {
    const json = JSON.stringify({
      done: false,
      understand: true,
      goal: {
        objective: "answer a user request",
        done_when: ["the user receives a useful answer"],
        required_evidence: [],
        ask_user_when: [],
        stop_when_no_progress: [],
      },
      approach: "proceed carefully",
      session_context_summary: "",
      dependent_task: false,
    });
    const provider = createMockProvider(json);
    const state = createState({
      userMessage: "latest t20 final man of the match",
    });

    await callUnderstand(provider, state, [shellTool], "system context");

    const call = (provider.generateTurn as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const prompt = call.messages[1]!.content;
    expect(prompt).toContain("Do NOT ask by default.");
    expect(prompt).toContain("proceed safely by making a reasonable assumption or by verifying with available tools");
    expect(prompt).toContain("materially changes the answer or outcome");
    expect(prompt).toContain("a mistake would be costly because the work is expensive, time-consuming, or hard to redo");
    expect(prompt).toContain("If the ambiguity is low-risk and recoverable, proceed with the best reasonable interpretation");
  });

  it("requires simple-chat understand completions to be exact user-facing reply text", async () => {
    const provider = createMockProvider(JSON.stringify({
      done: true,
      summary: "Hey, how are you?",
      status: "completed",
    }));
    const state = createState({
      userMessage: "hii",
    });

    await callUnderstand(provider, state, [shellTool], "system context");

    const call = (provider.generateTurn as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const prompt = call.messages[1]!.content;
    expect(prompt).toContain("For simple conversation, the completion summary is the exact text that will be sent to the user.");
    expect(prompt).toContain("Write only the reply itself.");
    expect(prompt).toContain("Do not include analysis, explanation, labels, quoted answer wrappers, or meta-commentary");
    expect(prompt).toContain('user: "hii" -> summary: "Hey, how are you?"');
    expect(prompt).toContain('user: "how ru ?" -> summary: "I\'m doing well. How about you?"');
    expect(prompt).toContain('summary: "This is a simple greeting. A suitable reply is: \\"I\'m doing well. How about you?\\""');
    expect(prompt).toContain('"summary": "<exact user-facing reply text only>"');
    expect(prompt).not.toContain('"summary": "<user-facing text or internal note>"');
  });

  it("returns completion for simple messages", async () => {
    const json = JSON.stringify({
      done: true,
      summary: "Hello! How are you?",
      status: "completed",
    });
    const provider = createMockProvider(json);
    const state = createState();

    const result = await callUnderstand(provider, state, [], "system context");
    expect(result.done).toBe(true);
    if (result.done) {
      expect(result.summary).toBe("Hello! How are you?");
    }
  });

  it("includes available external skill cards in the understand prompt", async () => {
    const provider = createMockProvider(JSON.stringify({
      done: true,
      summary: "done",
      status: "completed",
    }));

    await callUnderstand(
      provider,
      createState(),
      [shellTool],
      "system context",
      undefined,
      [{
        skillId: "agent-browser",
        title: "Agent Browser",
        summary: "Search the public web, inspect snapshot refs, and use a structured advanced dispatcher for rarer browser commands.",
        whenToUse: "Use for current public-web discovery, rendered page inspection, or browser interaction.",
        roleLabel: "Browser Agent",
        useFor: ["finding the right site before browsing", "opening pages and acting on snapshot refs"],
        notFor: ["raw shell browser strings", "credential persistence or setup flows"],
        workflowHint: "Search when the site is unknown, then open the page, snapshot refs, interact, and use help before advanced.",
        toolCount: 18,
        domains: ["browser", "web", "search"],
        tags: ["browser", "search"],
      }],
    );

    const call = (provider.generateTurn as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(call.messages[1]!.content).toContain("Available external skills:");
    expect(call.messages[1]!.content).toContain("agent-browser [Browser Agent] (18 tools)");
    expect(call.messages[1]!.content).toContain("Use when: Use for current public-web discovery, rendered page inspection, or browser interaction.");
    expect(call.messages[1]!.content).toContain("Best for: finding the right site before browsing; opening pages and acting on snapshot refs");
    expect(call.messages[1]!.content).toContain("Workflow: Search when the site is unknown, then open the page, snapshot refs, interact, and use help before advanced.");
  });

  it("requests structured output when the provider advertises support", async () => {
    const provider = createMockProvider(
      JSON.stringify({
        kind: "completion",
        payload: {
          done: true,
          summary: "Hello! How are you?",
          status: "completed",
        },
      }),
      {
        nativeToolCalling: true,
        structuredOutput: {
          jsonObject: true,
          jsonSchema: true,
        },
      },
      "openai",
    );

    await callUnderstand(provider, createState(), [], "system context");

    const call = (provider.generateTurn as ReturnType<typeof vi.fn>).mock.calls[0]![0] as LlmTurnInput;
    expect(call.responseFormat).toEqual({
      type: "json_schema",
      name: "controller_understand_response",
      strict: true,
      schema: expect.objectContaining({
        type: "object",
        properties: expect.objectContaining({
          kind: expect.any(Object),
          payload: expect.objectContaining({
            anyOf: expect.any(Array),
          }),
        }),
      }),
    });
    expect(call.responseFormat?.type).toBe("json_schema");
    if (call.responseFormat?.type === "json_schema") {
      expect(call.responseFormat.schema).not.toHaveProperty("anyOf");
      expect(call.responseFormat.schema).not.toHaveProperty("oneOf");
    }
    expect(call.messages[1]?.content).toContain('"dependent_task": false, "dependent_task_slot": null');
    expect(call.messages[1]?.content).toContain("If no Recent tasks block is shown");
    expect(call.messages[1]?.content).toContain(
      "Use strict JSON syntax with double-quoted strings and lowercase true, false, and null.",
    );
  });

  it("falls back to json_object for direct-stage OpenAI controller schemas with generic tool inputs", async () => {
    const provider = createMockProvider(
      JSON.stringify({
        done: false,
        contract_version: 2,
        verification: verificationContract(),
        execution_contract: "Inspect one config file",
        execution_plan: executionPlan("single", [
          planCall("read_file", { path: "config.json" }, { id: "read_config", purpose: "Inspect config file" }),
        ]),
        success_criteria: "The config file contents are returned",
        context: "Inspect the project config",
      }),
      {
        nativeToolCalling: true,
        structuredOutput: {
          jsonObject: true,
          jsonSchema: true,
        },
      },
      "openai",
    );

    await callDirect(provider, createState(), [shellTool]);

    const call = (provider.generateTurn as ReturnType<typeof vi.fn>).mock.calls[0]![0] as LlmTurnInput;
    expect(call.responseFormat?.type).toBe("json_object");
  });

  it("keeps reeval-stage response_format as json_schema for OpenAI-compatible schemas", async () => {
    const provider = createMockProvider(
      JSON.stringify({
        done: false,
        reeval: true,
        approach: "switch to a different lookup path",
      }),
      {
        nativeToolCalling: true,
        structuredOutput: {
          jsonObject: true,
          jsonSchema: true,
        },
      },
      "openai",
    );

    await callReEval(provider, createState(), [shellTool]);

    const call = (provider.generateTurn as ReturnType<typeof vi.fn>).mock.calls[0]![0] as LlmTurnInput;
    expect(call.responseFormat?.type).toBe("json_schema");
  });
});

describe("callDirect", () => {
  it("includes system context and returns step directive", async () => {
    const json = JSON.stringify({
      done: false,
      contract_version: 2,
      verification: verificationContract(),
      execution_contract: "read config file",
      execution_plan: executionPlan("single", [
        planCall("shell", { cmd: "cat config.json" }, { id: "read_config", purpose: "Read config file" }),
      ]),
      success_criteria: "config content available",
      context: "checking project config",
    });
    const provider = createMockProvider(json);
    const state = createState({
      goal: {
        objective: "check project config",
        done_when: ["config details are returned"],
        required_evidence: ["config content"],
        ask_user_when: ["config file is ambiguous"],
        stop_when_no_progress: ["two reads fail"],
      },
      approach: "read config file with shell",
    });

    const result = await callDirect(provider, state, [shellTool], undefined, undefined, "system context here");
    expect(result.done).toBe(false);
    if (!result.done && "execution_plan" in result) {
      expect(result.execution_contract).toBe("read config file");
    }

    // Verify system message was included
    const call = (provider.generateTurn as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(call.messages).toHaveLength(2);
    expect(call.messages[0]!.role).toBe("system");
    expect(call.messages[0]!.content).toBe("system context here");
    expect(call.messages[1]!.role).toBe("user");
    expect(call.messages[1]!.content).toContain("Goal Contract:");
    expect(call.messages[1]!.content).toContain("objective: check project config");
    expect(call.messages[1]!.content).toContain("shell");
    expect(call.messages[1]!.content).toContain("Run a shell command");
    expect(call.messages[1]!.content).toContain("Status: not_done");
    expect(call.messages[1]!.content).toContain("Do not put generated documents");
    expect(call.messages[1]!.content).toContain("execution_plan");
  });

  it("accepts Python-style booleans from direct-stage providers without a repair retry", async () => {
    const provider = createMockProvider(
      `{"kind":"step","payload":{"done":False,"contract_version":2,"verification":{"policy":"llm","rationale":"shell command output needs semantic validation in this fixture","expected_artifacts":[],"expected_state_change":"The command output is returned","requires_full_step_context":False},"execution_contract":"Run one shell command","execution_plan":{"mode":"single","calls":[{"id":"pwd","tool":"shell","input":{"cmd":"pwd","dryRun":False},"origin":"builtin","source_refs":[],"retry_policy":"none","depends_on":[],"purpose":"Run pwd"}],"allowed_tools":[],"max_calls":None},"success_criteria":"The command output is returned","context":"Need the current directory"}}}`,
      undefined,
      "fireworks",
    );

    const result = await callDirect(provider, createState(), [shellTool]);

    expect(result.done).toBe(false);
    if (!result.done && "execution_plan" in result) {
      expect(result.execution_plan.calls[0]?.input["dryRun"]).toBe(false);
    }
    expect(provider.generateTurn).toHaveBeenCalledTimes(1);
  });

  it("rejects large generated content in direct execution plans and repairs to executor autonomy", async () => {
    const oversizedLesson = "# Intro\n\n" + "Machine learning lesson content.\n".repeat(120);
    const provider = createMockProvider([
      JSON.stringify({
        kind: "step",
        payload: {
          done: false,
          contract_version: 2,
          verification: verificationContract(),
          execution_contract: "Write a generated ML lesson file",
          execution_plan: executionPlan("single", [
            planCall("write_file", {
              path: "data/learning/interests/machine-learning/lessons/001-intro-to-ml/lesson.md",
              content: oversizedLesson,
              createDirs: true,
            }, { id: "write_lesson", purpose: "Write generated lesson file" }),
          ]),
          success_criteria: "The lesson file is written",
          context: "Generated learning content",
        },
      }),
      JSON.stringify({
        kind: "step",
        payload: {
          done: false,
          contract_version: 2,
          verification: verificationContract(),
          execution_contract: "Generate and write the first ML lesson files using write_file.",
          execution_plan: executionPlan("autonomous", [], ["write_file"], 4),
          success_criteria: "The lesson files are written",
          context: "Generated learning content should be produced by the executor",
        },
      }),
    ]);

    const result = await callDirect(provider, createState(), [shellTool]);

    expect(result.done).toBe(false);
    if (!result.done && "execution_plan" in result) {
      expect(result.execution_plan.mode).toBe("autonomous");
      expect(result.execution_plan.allowed_tools).toEqual(["write_file"]);
    }
    expect(provider.generateTurn).toHaveBeenCalledTimes(2);
    const retryCall = (provider.generateTurn as ReturnType<typeof vi.fn>).mock.calls[1]![0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(retryCall.messages[retryCall.messages.length - 1]?.content).toContain("large string");
  });

  it("includes available external skills and loaded external tools distinctly in direct prompt", async () => {
    const json = JSON.stringify({
      done: false,
      contract_version: 2,
      verification: verificationContract(),
      execution_contract: "Use the loaded search tool",
      execution_plan: executionPlan("single", [
        planCall("agent-browser.search", { query: "latest market news" }, {
          id: "web_search",
          origin: "external_tool",
          purpose: "Search latest market news",
        }),
      ]),
      success_criteria: "Search results are retrieved",
      context: "Use the live web search capability",
    });
    const provider = createMockProvider(json);
    const externalTool: ToolDefinition = {
      name: "agent-browser.search",
      description: "Search the public web before browsing",
      inputSchema: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string" },
        },
      },
      execute: vi.fn().mockResolvedValue({ ok: true, output: "ok" }),
    };

    await callDirect(
      provider,
      createState(),
      [shellTool, externalTool],
      undefined,
      undefined,
      undefined,
      undefined,
      [{
        skillId: "agent-browser",
        title: "Agent Browser",
        summary: "Search the public web, browse rendered pages, and use structured help plus advanced commands for the long tail.",
        whenToUse: "Use for public-web discovery, rendered page inspection, and browser interaction.",
        roleLabel: "Browser Agent",
        useFor: ["source discovery", "snapshot-driven browser interaction"],
        notFor: ["raw shell browser strings", "setup or auth persistence flows"],
        workflowHint: "Search first when needed, then open the page, snapshot refs, and use help before advanced.",
        toolCount: 18,
        toolsPreview: [
          {
            toolId: "help",
            toolName: "agent-browser.help",
            title: "Load Browser Help",
            description: "Load version-matched docs before using a rare browser command family",
            inputSummary: "topic: string (required)",
          },
        ],
        previewTruncated: false,
        domains: ["browser", "web", "search"],
        tags: ["browser", "search"],
      }],
    );

    const call = (provider.generateTurn as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const prompt = call.messages[0]!.content;
    expect(prompt).toContain("Available tools (2):");
    expect(prompt).toContain("agent-browser.search");
    expect(prompt).toContain("Available external skills:");
    expect(prompt).toContain("agent-browser [Browser Agent] (18 tools)");
    expect(prompt).toContain("agent-browser.help");
    expect(prompt).toContain("Direct activation: return activate_skill with skill_id \"agent-browser\"");
    expect(prompt).toContain("If you need an external capability that is shown in Available external skills but its tools are not yet listed in Available tools");
    expect(prompt).toContain("For inline activation: { \"kind\": \"activate_skill\"");
    expect(prompt).not.toContain("read_skills");
  });

  it("includes compact task progress in the direct prompt", async () => {
    const json = JSON.stringify({
      done: false,
      contract_version: 2,
      verification: verificationContract(),
      execution_contract: "continue",
      execution_plan: executionPlan("autonomous", [], ["shell"], 2),
      success_criteria: "done",
      context: "",
    });
    const provider = createMockProvider(json);
    const state = createState({
      taskProgress: {
        status: "not_done",
        progressSummary: "We found the main config file but still need to inspect one nested include.",
        keyFacts: ["config/app.yml exists", "database settings likely live in config/database.yml"],
        evidence: ["verified read_file output from config/app.yml"],
      },
      completedSteps: [
        {
          step: 1,
          intent: "first step",
          outcome: "success",
          summary: "first done",
          newFacts: ["tool_output:shell#1: old output"],
          artifacts: [],
          toolSuccessCount: 1,
          toolFailureCount: 0,
        },
        {
          step: 2,
          intent: "second step",
          outcome: "success",
          summary: "second done",
          newFacts: [
            "tool_output:shell#1: latest output",
            "tool_error:read_file#2: file not found",
          ],
          artifacts: [],
          toolSuccessCount: 1,
          toolFailureCount: 1,
        },
      ],
    });

    await callDirect(provider, state, [shellTool]);

    const call = (provider.generateTurn as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const prompt = call.messages[0]!.content;
    expect(prompt).toContain("Task progress:");
    expect(prompt).toContain("Status: not_done");
    expect(prompt).toContain("We found the main config file but still need to inspect one nested include.");
    expect(prompt).toContain("config/app.yml exists");
    expect(prompt).not.toContain("Remaining work:");
    expect(prompt).not.toContain("Next focus:");
    expect(prompt).toContain("Recent successful step summaries:");
    expect(prompt).toContain("Step 2: second done");
  });

  it("includes inline run-state guidance and avoids legacy scout guidance in direct prompt", async () => {
    const json = JSON.stringify({
      done: false,
      contract_version: 2,
      verification: verificationContract(),
      execution_contract: "continue",
      execution_plan: executionPlan("autonomous", [], ["shell"], 2),
      success_criteria: "done",
      context: "",
    });
    const provider = createMockProvider(json);
    const state = createState({
      runPath: "/tmp/current-run",
    });

    await callDirect(provider, state, [shellTool]);

    const call = (provider.generateTurn as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const prompt = call.messages[0]!.content;
    expect(prompt).toContain("Automatic run state context:");
    expect(prompt).toContain("Current Step Count: 0");
    expect(prompt).toContain("Latest completed step full text:");
    expect(prompt).toContain("Use the automatic run-state bundle as your first source of recent task context.");
    expect(prompt).toContain("If the next action depends on older active-run history that is not covered by the inline bundle, return read_run_state.");
    expect(prompt).toContain("First use read_summary_window on an explicit 10-step range.");
    expect(prompt).toContain("Use read_step_full only when one specific step becomes important.");
    expect(prompt).not.toContain("context_search");
    expect(prompt).not.toContain("state.json has completedSteps");
  });

  it("includes verification-first and high-cost clarification guidance in direct prompt", async () => {
    const json = JSON.stringify({
      done: false,
      contract_version: 2,
      verification: verificationContract(),
      execution_contract: "verify a public fact",
      execution_plan: executionPlan("autonomous", [], ["shell"], 2),
      success_criteria: "fact is verified",
      context: "",
    });
    const provider = createMockProvider(json);
    const state = createState({
      goal: {
        objective: "answer the latest sports fact question",
        done_when: ["a verified answer is returned"],
        required_evidence: ["source or verification"],
        ask_user_when: [],
        stop_when_no_progress: [],
      },
      approach: "verify before replying",
    });

    await callDirect(provider, state, [shellTool]);

    const call = (provider.generateTurn as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const prompt = call.messages[0]!.content;
    expect(prompt).toContain("prefer checking with tools/search instead of asking the user to restate or reconfirm");
    expect(prompt).toContain("If the next step would be expensive, time-consuming, risky, or hard to undo");
    expect(prompt).toContain("Pick exactly 1 outcome:");
  });

  it("uses the compact session context summary instead of recent task and feedback lists in direct prompt", async () => {
    const json = JSON.stringify({
      done: false,
      contract_version: 2,
      verification: verificationContract(),
      execution_contract: "continue",
      execution_plan: executionPlan("autonomous", [], ["shell"], 2),
      success_criteria: "done",
      context: "",
    });
    const provider = createMockProvider(json);
    const state = createState({
      sessionContextSummary: "Relevant carry-over: prior website discussion preferred a brutalist landing page and Tailwind CSS.",
      recentTaskSummaries: [
        {
          timestamp: "2026-02-28T05:20:15Z",
          runId: "abc",
          runPath: "/runs/abc",
          runStatus: "completed",
          taskStatus: "done",
          objective: "Find the folder slokan",
          summary: "Found the folder slokan",
          completedMilestones: [],
          openWork: [],
          blockers: [],
          keyFacts: [],
          evidence: [],
          attachmentNames: [],
        },
      ],
    });

    await callDirect(provider, state, [shellTool]);

    const call = (provider.generateTurn as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const prompt = call.messages[0]!.content;
    expect(prompt).toContain("Session-relevant prior context:");
    expect(prompt).toContain("brutalist landing page");
    expect(prompt).not.toContain("Recent tasks (last 1):");
    expect(prompt).not.toContain("runId=abc runPath=/runs/abc");
  });

  it("includes the selected dependent prior task in the direct prompt", async () => {
    const json = JSON.stringify({
      done: false,
      contract_version: 2,
      verification: verificationContract(),
      execution_contract: "continue",
      execution_plan: executionPlan("autonomous", [], ["shell"], 2),
      success_criteria: "done",
      context: "",
    });
    const provider = createMockProvider(json);
    const state = createState({
      dependentTask: true,
      dependentTaskSummary: {
        timestamp: "2026-02-28T05:20:15Z",
        runId: "abc",
        runPath: "/runs/abc",
        runStatus: "completed",
        taskStatus: "done",
        objective: "Find the folder slokan",
        summary: "Found the folder slokan",
        progressSummary: "Folder lookup completed successfully.",
        currentFocus: "Resume from the located folder.",
        approach: "Reuse the earlier folder lookup and continue from it.",
        assistantResponseKind: "feedback",
        feedbackKind: "confirmation",
        feedbackLabel: "Use previous folder",
        actionType: "resume_task",
        entityHints: ["folder", "slokan"],
        userInputNeeded: "Confirm whether to reuse the earlier folder result.",
        nextAction: "Reuse the located folder for the next step.",
        completedMilestones: ["Located the folder"],
        openWork: ["Use the folder for the next step"],
        blockers: [],
        keyFacts: ["The folder is under /home/slokan"],
        evidence: ["shell output showed /home/slokan"],
        goalDoneWhen: ["The next step reuses the earlier folder correctly."],
        goalRequiredEvidence: ["The folder path is referenced in the new work."],
        attachmentNames: [],
      },
    });

    await callDirect(provider, state, [shellTool]);

    const call = (provider.generateTurn as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const prompt = call.messages[0]!.content;
    expect(prompt).toContain("Run continuity:");
    expect(prompt).toContain("This run continues a prior task from the same session.");
    expect(prompt).toContain("- runId: abc");
    expect(prompt).toContain("- runPath: /runs/abc");
    expect(prompt).toContain("- objective: Find the folder slokan");
    expect(prompt).toContain("- summary: Found the folder slokan");
    expect(prompt).toContain("- assistantResponseKind: feedback");
    expect(prompt).toContain("- feedbackLabel: Use previous folder");
    expect(prompt).toContain("- entityHints: folder; slokan");
    expect(prompt).toContain("- userInputNeeded: Confirm whether to reuse the earlier folder result.");
    expect(prompt).toContain("- nextAction: Reuse the located folder for the next step.");
    expect(prompt).toContain("- openWork: Use the folder for the next step");
    expect(prompt).toContain("- keyFacts: The folder is under /home/slokan");
    expect(prompt).toContain("- goalDoneWhen: The next step reuses the earlier folder correctly.");
  });

  it("includes prepared attachment guidance in direct prompt when available", async () => {
    const json = JSON.stringify({
      done: false,
      contract_version: 2,
      verification: verificationContract(),
      execution_contract: "query the prepared attachment",
      execution_plan: executionPlan("autonomous", [], ["document_query"], 2),
      success_criteria: "the answer is grounded in the prepared attachment",
      context: "use the prepared attachment metadata",
    });
    const provider = createMockProvider(json);
    const state = createState({
      workMode: "document_lookup",
      preparedAttachments: [
        {
          preparedInputId: "att_1_doc1",
          documentId: "doc-1",
          displayName: "policy.txt",
          source: "cli",
          kind: "txt",
          mode: "unstructured_text",
          sizeBytes: 128,
          checksum: "abc123",
          originalPath: "/docs/policy.txt",
          status: "ready",
          warnings: [],
          artifactPath: "/tmp/test/attachments/att_1_doc1.json",
          unstructured: {
            extractorUsed: "direct",
            sectionCount: 3,
            chunkCount: 4,
            sectionHints: ["summary", "policy", "termination"],
            indexed: false,
          },
        },
      ],
    });

    await callDirect(provider, state, [shellTool]);

    const call = (provider.generateTurn as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const prompt = call.messages[0]!.content;
    expect(prompt).toContain("Work mode: document_lookup");
    expect(prompt).toContain("Prepared attachments available (1):");
    expect(prompt).toContain("policy.txt | kind=txt | mode=unstructured_text | status=ready");
    expect(prompt).toContain("document_query");
    expect(prompt).not.toContain("\"documents\"");
    expect(prompt).not.toContain("Document retrieval status:");
  });

  it("includes directory attachments in the direct prompt", async () => {
    const json = JSON.stringify({
      done: false,
      contract_version: 2,
      verification: verificationContract(),
      execution_contract: "search attached project directory",
      execution_plan: executionPlan("autonomous", [], ["directory_search"], 2),
      success_criteria: "the relevant file is found",
      context: "use the attached directory",
    });
    const provider = createMockProvider(json);
    const state = createState({
      managedDirectories: [
        {
          directoryId: "dir_0123456789abcdef",
          name: "project",
          rootPath: "/tmp/project",
          source: "cli",
          createdAt: "2026-06-03T00:00:00.000Z",
          updatedAt: "2026-06-03T00:00:00.000Z",
          status: "ready",
          capabilities: ["list", "search", "read_files", "register_files"],
          include: [],
          exclude: ["node_modules"],
          maxDepth: 8,
          maxFiles: 1000,
          fileCount: 2,
          directoryCount: 1,
          totalSizeBytes: 256,
          fileTypes: { ".ts": 2 },
          entries: [
            {
              path: "/tmp/project/src",
              relativePath: "src",
              name: "src",
              kind: "directory",
              depth: 1,
            },
            {
              path: "/tmp/project/src/agent.ts",
              relativePath: "src/agent.ts",
              name: "agent.ts",
              kind: "file",
              depth: 2,
              sizeBytes: 128,
              extension: ".ts",
            },
          ],
          truncated: false,
          warnings: [],
        },
      ],
    });

    await callDirect(provider, state, [shellTool]);

    const call = (provider.generateTurn as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const prompt = call.messages[0]!.content;
    expect(prompt).toContain("Attached inputs (1):");
    expect(prompt).toContain("id=dir_0123456789abcdef | type=directory | name=project");
    expect(prompt).toContain("Managed directories available (1):");
    expect(prompt).toContain("preview=src, src/agent.ts");
  });

  it("hides active session attachments when current run attachments are already prepared", async () => {
    const json = JSON.stringify({
      done: false,
      contract_version: 2,
      verification: verificationContract(),
      execution_contract: "profile the current attachment",
      execution_plan: executionPlan("autonomous", [], ["dataset_profile"], 2),
      success_criteria: "the current attachment is inspected",
      context: "use the current prepared attachment",
    });
    const provider = createMockProvider(json);
    const state = createState({
      workMode: "structured_data_process",
      activeSessionAttachments: [
        {
          documentId: "doc-old",
          displayName: "chat_states_1k.csv",
          kind: "csv",
          mode: "structured_data",
          runId: "run-old",
          runPath: "/tmp/old-run",
          preparedInputId: "att_1_old",
          lastUsedAt: "2026-03-31T00:00:00.000Z",
          lastAction: "prepared",
        },
      ],
      preparedAttachments: [
        {
          preparedInputId: "att_1_new",
          documentId: "doc-new",
          displayName: "electronic-card-transactions-february-2026-csv-tables.csv",
          source: "upload",
          kind: "csv",
          mode: "structured_data",
          sizeBytes: 1024,
          checksum: "new123",
          originalPath: "/uploads/electronic-card-transactions-february-2026-csv-tables.csv",
          status: "ready",
          warnings: [],
          artifactPath: "/tmp/test/attachments/att_1_new.json",
          structured: {
            columns: ["txn_type", "amount"],
            inferredTypes: { txn_type: "text", amount: "integer" },
            rowCount: 12,
            sampleRowCount: 5,
            stagingDbPath: "/tmp/test/attachments/staging.sqlite",
            stagingTableName: "staging_att_1_new",
            staged: false,
          },
        },
      ],
    });

    await callDirect(provider, state, [shellTool]);

    const call = (provider.generateTurn as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const prompt = call.messages[0]!.content;
    expect(prompt).toContain("Prepared attachments available (1):");
    expect(prompt).toContain("electronic-card-transactions-february-2026-csv-tables.csv");
    expect(prompt).not.toContain("Active session attachments (1):");
    expect(prompt).not.toContain("chat_states_1k.csv");
  });

  it("uses injected direct instructions when provided", async () => {
    const json = JSON.stringify({
      done: false,
      contract_version: 2,
      verification: verificationContract(),
      execution_contract: "read config file",
      execution_plan: executionPlan("autonomous", [], ["shell"], 2),
      success_criteria: "config content available",
      context: "checking project config",
    });
    const provider = createMockProvider(json);
    const state = createState();

    await callDirect(
      provider,
      state,
      [shellTool],
      undefined,
      {
        understand: "- custom understand instruction",
        direct: "- custom direct instruction",
        reeval: "- custom reeval instruction",
        systemEvent: "- custom system event instruction",
      },
    );

    const call = (provider.generateTurn as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(call.messages).toHaveLength(1);
    expect(call.messages[0]!.role).toBe("user");
    expect(call.messages[0]!.content).toContain("- custom direct instruction");
  });

  it("retries once when the first controller response is prose instead of JSON", async () => {
    const provider = createMockProvider([
      "I need to inspect the mail first.",
      JSON.stringify({
        done: false,
        contract_version: 2,
        verification: verificationContract(),
        execution_contract: "Read the AWS billing email details from Gmail",
        execution_plan: executionPlan("single", [
          planCall("gmail_read", { messageId: "msg-1" }, { purpose: "Read the Gmail message" }),
        ]),
        success_criteria: "The email body and metadata are returned",
        context: "User asked for full AWS billing mail details",
      }),
    ]);

    const result = await callDirect(provider, createState(), [shellTool]);
    expect(result.done).toBe(false);
    if (!result.done && "execution_contract" in result) {
      expect(result.execution_contract).toContain("AWS billing email");
    }

    expect(provider.generateTurn).toHaveBeenCalledTimes(2);
    const retryCall = (provider.generateTurn as ReturnType<typeof vi.fn>).mock.calls[1]![0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const assistantRetryMessage = retryCall.messages[retryCall.messages.length - 2];
    const repairPrompt = retryCall.messages[retryCall.messages.length - 1];
    expect(assistantRetryMessage?.role).toBe("assistant");
    expect(assistantRetryMessage?.content).toContain("inspect the mail");
    expect(repairPrompt?.content).toContain("Reply again with exactly one JSON object");
  });

  it("rejects promise-style completion and retries for an executable step", async () => {
    const provider = createMockProvider([
      JSON.stringify({
        done: true,
        summary: "Let me pull the full details of that AWS billing mail for you now.",
        status: "completed",
        response_kind: "reply",
      }),
      JSON.stringify({
        done: false,
        contract_version: 2,
        verification: verificationContract(),
        execution_contract: "Read the AWS billing email details from Gmail",
        execution_plan: executionPlan("single", [
          planCall("gmail_read", { messageId: "msg-1" }, { purpose: "Read the Gmail message" }),
        ]),
        success_criteria: "The email body and metadata are returned",
        context: "User asked for full AWS billing mail details",
      }),
    ]);

    const result = await callDirect(
      provider,
      createState({ userMessage: "Can you give full details about the AWS billing mail?" }),
      [shellTool],
    );

    expect(result.done).toBe(false);
    if (!result.done && "execution_contract" in result) {
      expect(result.execution_contract).toContain("AWS billing email");
    }

    expect(provider.generateTurn).toHaveBeenCalledTimes(2);
    const retryCall = (provider.generateTurn as ReturnType<typeof vi.fn>).mock.calls[1]![0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const repairPrompt = retryCall.messages[retryCall.messages.length - 1];
    expect(repairPrompt?.content).toContain("must not promise or narrate future work");
    expect(repairPrompt?.content).toContain("If action still needs to happen, return a step, activate_skill, or read_run_state instead of completion.");
  });

  it("rejects excuse-style completion and retries for an executable step", async () => {
    const provider = createMockProvider([
      JSON.stringify({
        done: true,
        summary: "I need access to the latest mail details first.",
        status: "completed",
        response_kind: "reply",
      }),
      JSON.stringify({
        done: false,
        contract_version: 2,
        verification: verificationContract(),
        execution_contract: "Read the AWS billing email details from Gmail",
        execution_plan: executionPlan("single", [
          planCall("gmail_read", { messageId: "msg-1" }, { purpose: "Read the Gmail message" }),
        ]),
        success_criteria: "The email body and metadata are returned",
        context: "User asked for full AWS billing mail details",
      }),
    ]);

    const result = await callDirect(
      provider,
      createState({ userMessage: "Can you give full details about the AWS billing mail?" }),
      [shellTool],
    );

    expect(result.done).toBe(false);
    if (!result.done && "execution_contract" in result) {
      expect(result.execution_contract).toContain("AWS billing email");
    }

    const retryCall = (provider.generateTurn as ReturnType<typeof vi.fn>).mock.calls[1]![0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const repairPrompt = retryCall.messages[retryCall.messages.length - 1];
    expect(repairPrompt?.content).toContain("excuse or missing-action note");
  });

  it("rejects legacy rotate_session direct responses and retries for a step", async () => {
    const provider = createMockProvider([
      JSON.stringify({
        kind: "rotate_session",
        payload: {
          done: false,
          rotate_session: true,
          reason: "context full",
          handoff_summary: "handoff details",
        },
      }),
      JSON.stringify({
        done: false,
        contract_version: 2,
        verification: verificationContract(),
        execution_contract: "Search current India smartphone options under Rs 50,000",
        execution_plan: executionPlan("single", [
          planCall("websearch.search", { query: "best smartphones under 50000 in India" }, {
            origin: "external_tool",
            purpose: "Search current smartphone options",
          }),
        ]),
        success_criteria: "Current smartphone options are found",
        context: "Need a live market search",
      }),
    ]);

    const result = await callDirect(provider, createState(), [shellTool]);

    expect(result.done).toBe(false);
    if (!result.done && "execution_contract" in result) {
      expect(result.execution_contract).toContain("smartphone");
    }

    expect(provider.generateTurn).toHaveBeenCalledTimes(2);
    const retryCall = (provider.generateTurn as ReturnType<typeof vi.fn>).mock.calls[1]![0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const repairPrompt = retryCall.messages[retryCall.messages.length - 1];
    expect(repairPrompt?.content).toContain("Unsupported direct response kind");
    expect(repairPrompt?.content).toContain("rotate_session");
  });

  it("rejects unsafe parallel filesystem plans and retries for a sequential plan", async () => {
    const provider = createMockProvider([
      JSON.stringify({
        done: false,
        contract_version: 2,
        verification: verificationContract(),
        execution_contract: "Create a lesson directory and write the course file",
        execution_plan: executionPlan("parallel", [
          planCall("create_directory", { path: "lessons/001-intro-fluids" }, {
            id: "create_lesson_dir",
            purpose: "Create lesson directory",
          }),
          planCall("write_file", { path: "lessons/001-intro-fluids/course.md", content: "intro", createDirs: false }, {
            id: "write_course",
            purpose: "Write course file",
          }),
        ]),
        success_criteria: "The lesson course file is written",
        context: "Need the directory before writing the file",
      }),
      JSON.stringify({
        done: false,
        contract_version: 2,
        verification: verificationContract(),
        execution_contract: "Create a lesson directory and write the course file",
        execution_plan: executionPlan("sequential", [
          planCall("create_directory", { path: "lessons/001-intro-fluids" }, {
            id: "create_lesson_dir",
            purpose: "Create lesson directory",
          }),
          planCall("write_file", { path: "lessons/001-intro-fluids/course.md", content: "intro", createDirs: false }, {
            id: "write_course",
            depends_on: ["create_lesson_dir"],
            purpose: "Write course file after the directory exists",
          }),
        ]),
        success_criteria: "The lesson course file is written",
        context: "Create the directory before writing the file",
      }),
    ]);

    const result = await callDirect(provider, createState(), [shellTool]);

    expect(result.done).toBe(false);
    if (!result.done && "execution_contract" in result) {
      expect(result.execution_contract).toContain("lesson directory");
      expect(result.execution_plan.mode).toBe("sequential");
      expect(result.execution_plan.calls).toHaveLength(2);
    }

    expect(provider.generateTurn).toHaveBeenCalledTimes(2);
    const retryCall = (provider.generateTurn as ReturnType<typeof vi.fn>).mock.calls[1]![0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const repairPrompt = retryCall.messages[retryCall.messages.length - 1];
    expect(repairPrompt?.content).toContain("Parallel execution_plan contains filesystem calls");
  });

  it("rejects mixed-phase autonomous plans and retries for a single-phase plan", async () => {
    const provider = createMockProvider([
      JSON.stringify({
        done: false,
        contract_version: 2,
        verification: verificationContract(),
        execution_contract: "Inspect and rewrite a lesson view",
        execution_plan: executionPlan("autonomous", [], ["read_file", "write_file", "learning_workspace_show"], 3),
        success_criteria: "the lesson is inspected, rewritten, and displayed",
        context: "Fix the lesson rendering issue.",
      }),
      JSON.stringify({
        done: false,
        contract_version: 2,
        verification: verificationContract(),
        execution_contract: "Read the current lesson files",
        execution_plan: executionPlan("autonomous", [], ["read_file"], 2),
        success_criteria: "the lesson files are read",
        context: "Inspect first; writing and display will be separate steps.",
      }),
    ]);

    const result = await callDirect(provider, createState(), [shellTool]);

    expect(result.done).toBe(false);
    if (!result.done && "execution_contract" in result) {
      expect(result.execution_contract).toContain("Read the current lesson");
      expect(result.execution_plan.mode).toBe("autonomous");
      expect(result.execution_plan.allowed_tools).toEqual(["read_file"]);
    }

    expect(provider.generateTurn).toHaveBeenCalledTimes(2);
    const retryCall = (provider.generateTurn as ReturnType<typeof vi.fn>).mock.calls[1]![0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const repairPrompt = retryCall.messages[retryCall.messages.length - 1];
    expect(repairPrompt?.content).toContain("Autonomous execution_plan mixes incompatible tool phases");
  });

  it("throws a controller format error after two invalid controller responses", async () => {
    const provider = createMockProvider([
      "I need to inspect the mail first.",
      "Still not JSON.",
    ]);

    const run = callDirect(provider, createState(), [shellTool]);
    await expect(run).rejects.toThrow(ControllerResponseFormatError);
    await expect(run).rejects.toThrow(/Invalid controller response format at direct stage/);
  });

  it("returns read_run_state from direct when older active-run history is needed", async () => {
    const provider = createMockProvider(JSON.stringify({
      kind: "read_run_state",
      payload: {
        done: false,
        read_run_state: true,
        action: "read_summary_window",
        window: { from: 1, to: 3 },
        reason: "Need to inspect the earlier failed steps",
      },
    }));

    const result = await callDirect(provider, createState(), [shellTool]);
    expect(result.done).toBe(false);
    if (!result.done && "read_run_state" in result) {
      expect(result.read_run_state).toBe(true);
      expect(result.action).toBe("read_summary_window");
      expect(result.window).toEqual({ from: 1, to: 3 });
    }
  });
});

describe("callReEval", () => {
  it("uses a compact task-progress and serial-failure prompt for re-eval", async () => {
    const json = JSON.stringify({
      done: false,
      reeval: true,
      approach: "use a different search strategy",
    });
    const provider = createMockProvider(json);
    const state = createState({
      consecutiveFailures: 3,
      dependentTask: true,
      dependentTaskSummary: {
        timestamp: "2026-02-28T05:20:15Z",
        runId: "dep-1",
        runPath: "/runs/dep-1",
        runStatus: "completed",
        taskStatus: "done",
        objective: "Inspect blocked filesystem roots",
        summary: "Earlier filesystem sweep found blocked roots that should be avoided.",
        completedMilestones: ["Blocked roots identified"],
        openWork: ["Pivot to a healthy search root"],
        blockers: ["/tmp/secret-a"],
        keyFacts: ["Earlier sweep hit /tmp/secret-a"],
        evidence: ["permission denied on /tmp/secret-a"],
        attachmentNames: [],
      },
      taskProgress: {
        status: "not_done",
        progressSummary: "We keep failing to inspect the blocked target.",
        keyFacts: [],
        evidence: [],
      },
      completedSteps: [
        {
          step: 1,
          intent: "search root A",
          outcome: "failed",
          summary: "Permission denied on /tmp/secret-a",
          newFacts: [],
          artifacts: [],
          toolSuccessCount: 0,
          toolFailureCount: 1,
          failureType: "permission",
          blockedTargets: ["/tmp/secret-a"],
          stoppedEarlyReason: "planned_call_failed",
        },
        {
          step: 2,
          outcome: "failed",
          summary: "Permission denied on /tmp/secret-b",
          newFacts: [],
          artifacts: [],
          toolSuccessCount: 0,
          toolFailureCount: 1,
          failureType: "permission",
          stoppedEarlyReason: "repeated_identical_failure",
          blockedTargets: ["/tmp/secret-b"],
        },
        {
          step: 3,
          intent: "search root C",
          outcome: "success",
          summary: "A healthy path was inspected once.",
          newFacts: ["src/config exists"],
          artifacts: [],
          toolSuccessCount: 1,
          toolFailureCount: 0,
        },
        {
          step: 4,
          intent: "search root D",
          outcome: "failed",
          summary: "Permission denied on /tmp/secret-d",
          newFacts: [],
          artifacts: [],
          toolSuccessCount: 0,
          toolFailureCount: 1,
          failureType: "permission",
          stoppedEarlyReason: "planned_call_failed",
          blockedTargets: ["/tmp/secret-d"],
        },
        {
          step: 5,
          intent: "search root E",
          outcome: "failed",
          summary: "Permission denied on /tmp/secret-e",
          newFacts: [],
          artifacts: [],
          toolSuccessCount: 0,
          toolFailureCount: 1,
          failureType: "permission",
          stoppedEarlyReason: "planned_call_failed",
          blockedTargets: ["/tmp/secret-e"],
        },
        {
          step: 6,
          intent: "search root F",
          outcome: "failed",
          summary: "Permission denied on /tmp/secret-f",
          newFacts: [],
          artifacts: [],
          toolSuccessCount: 0,
          toolFailureCount: 1,
          failureType: "permission",
          stoppedEarlyReason: "repeated_identical_failure",
          blockedTargets: ["/tmp/secret-f"],
        },
      ],
      sessionContextSummary: "Relevant carry-over: the blocked paths came from an earlier filesystem sweep, but the user still wants the same config search.",
      sessionHistory: [
        { role: "user", content: "earlier question", timestamp: "2026-02-28T05:00:00Z", sessionPath: "/s/1" },
      ],
    });

    const result = await callReEval(
      provider,
      state,
      [shellTool],
      undefined,
      "system context here",
    );
    expect(result.done).toBe(false);
    if (!result.done && "reeval" in result) {
      expect(result.reeval).toBe(true);
      expect(result.approach).toBe("use a different search strategy");
    }

    // Verify system message was included
    const call = (provider.generateTurn as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(call.messages).toHaveLength(2);
    expect(call.messages[0]!.role).toBe("system");
    expect(call.messages[0]!.content).toBe("system context here");
    expect(call.messages[1]!.role).toBe("user");
    expect(call.messages[1]!.content).toContain("Re-evaluate this task");
    expect(call.messages[1]!.content).toContain("Session-relevant prior context:");
    expect(call.messages[1]!.content).toContain("blocked paths came from an earlier filesystem sweep");
    expect(call.messages[1]!.content).toContain("Run continuity:");
    expect(call.messages[1]!.content).toContain("- runId: dep-1");
    expect(call.messages[1]!.content).toContain("Earlier filesystem sweep found blocked roots");
    expect(call.messages[1]!.content).toContain("Task progress:");
    expect(call.messages[1]!.content).toContain("Status: not_done");
    expect(call.messages[1]!.content).toContain("We keep failing to inspect the blocked target.");
    expect(call.messages[1]!.content).toContain("Recent consecutive failed steps");
    expect(call.messages[1]!.content).toContain("Step 4");
    expect(call.messages[1]!.content).toContain("Step 5");
    expect(call.messages[1]!.content).toContain("Step 6");
    expect(call.messages[1]!.content).not.toContain("Step 1");
    expect(call.messages[1]!.content).not.toContain("Step 3");
    expect(call.messages[1]!.content).not.toContain("Session conversation so far:");
    expect(call.messages[1]!.content).not.toContain("Recent runs (last");
    expect(call.messages[1]!.content).not.toContain("Automatic run state context:");
    expect(call.messages[1]!.content).toContain("If you still need older active-run context before choosing a new approach, return read_run_state.");
    expect(call.messages[1]!.content).toContain("Read a summary window first. Read a full step only when one specific step looks important.");
    expect(call.messages[1]!.content).toContain("Original goal:");
    expect(call.messages[1]!.content).toContain("objective: greet user");
  });

  it("returns read_run_state from re-eval when older active-run history is needed", async () => {
    const provider = createMockProvider(JSON.stringify({
      kind: "read_run_state",
      payload: {
        done: false,
        read_run_state: true,
        action: "read_step_full",
        step: 3,
      },
    }));

    const result = await callReEval(provider, createState({ consecutiveFailures: 3 }), [shellTool]);
    expect(result.done).toBe(false);
    if (!result.done && "read_run_state" in result) {
      expect(result.read_run_state).toBe(true);
      expect(result.action).toBe("read_step_full");
      expect(result.step).toBe(3);
    }
  });
});
