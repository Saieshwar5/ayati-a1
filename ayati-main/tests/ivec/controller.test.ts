import { describe, it, expect, vi } from "vitest";
import {
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

function createMockProvider(response: string): LlmProvider {
  return {
    name: "mock",
    version: "1.0.0",
    capabilities: { nativeToolCalling: true },
    start: vi.fn(),
    stop: vi.fn(),
    generateTurn: vi
      .fn<(input: LlmTurnInput) => Promise<LlmTurnOutput>>()
      .mockResolvedValue({ type: "assistant", content: response }),
  };
}

function createState(overrides?: Partial<LoopState>): LoopState {
  return {
    runId: "r1",
    userMessage: "hello",
    goal: {
      objective: "greet user",
      done_when: ["a friendly greeting is returned"],
      required_evidence: [],
      ask_user_when: [],
      stop_when_no_progress: [],
    },
    approach: "direct",
    taskStatus: "not_done",
    progressLedger: {
      lastSuccessfulStepSummary: "",
      lastStepFacts: [],
      taskEvidence: [],
    },
    status: "running",
    finalOutput: "",
    iteration: 0,
    maxIterations: 15,
    consecutiveFailures: 0,
    approachChangeCount: 0,
    completedSteps: [],
    runPath: "/tmp/test",
    failedApproaches: [],
    sessionHistory: [],
    recentRunLedgers: [],
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

  it("handles JSON wrapped in ```json fences", () => {
    const text = '```json\n{ "done": true, "summary": "done", "status": "completed" }\n```';
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
      execution_mode: "independent",
      intent: "read file",
      tools_hint: ["read_file"],
      success_criteria: "file content returned",
      context: "need to check config",
    });
    const result = parseDirectResponse(json);
    expect(result.done).toBe(false);
    if (!result.done && "intent" in result) {
      expect(result.intent).toBe("read file");
      expect(result.tools_hint).toEqual(["read_file"]);
      expect(result.execution_mode).toBe("independent");
    }
  });

  it("defaults execution_mode to dependent when missing", () => {
    const json = JSON.stringify({
      done: false,
      intent: "read file",
      tools_hint: ["read_file"],
      success_criteria: "file content returned",
      context: "need to check config",
    });
    const result = parseDirectResponse(json);
    expect(result.done).toBe(false);
    if (!result.done && "intent" in result) {
      expect(result.execution_mode).toBe("dependent");
    }
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
      query: "playwright commands",
      scope: "skills",
    });
    const result = parseDirectResponse(json);
    expect(result.done).toBe(false);
    if (!result.done && "context_search" in result) {
      expect(result.scope).toBe("skills");
    }
  });

  it("parses session rotation directive JSON", () => {
    const json = JSON.stringify({
      done: false,
      rotate_session: true,
      reason: "context full",
      handoff_summary: "discussed files",
    });
    const result = parseDirectResponse(json);
    expect(result.done).toBe(false);
    if (!result.done && "rotate_session" in result) {
      expect(result.rotate_session).toBe(true);
      expect(result.reason).toBe("context full");
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

  it("includes session history and recent runs in understand prompt", async () => {
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
    });
    const provider = createMockProvider(json);
    const state = createState({
      sessionHistory: [
        { role: "user", content: "find the folder slokan", timestamp: "2026-02-28T05:20:00Z", sessionPath: "/s/1" },
        { role: "assistant", content: "Found folder slokan at /home/slokan", timestamp: "2026-02-28T05:20:15Z", sessionPath: "/s/1" },
      ],
      recentRunLedgers: [
        { timestamp: "2026-02-28T05:20:15Z", runId: "abc", runPath: "/runs/abc", state: "completed", status: "completed", summary: "Found the folder slokan" },
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
    expect(prompt).toContain("Recent runs (last 1):");
    expect(prompt).toContain("runId=abc");
    expect(prompt).toContain("runPath=/runs/abc");
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
});

describe("callDirect", () => {
  it("includes system context and returns step directive", async () => {
    const json = JSON.stringify({
      done: false,
      execution_mode: "dependent",
      intent: "read config file",
      tools_hint: ["shell"],
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
    if (!result.done && "intent" in result) {
      expect(result.intent).toBe("read config file");
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
    expect(call.messages[1]!.content).toContain("Task status: not_done");
    expect(call.messages[1]!.content).toContain("shell");
    expect(call.messages[1]!.content).toContain("Run a shell command");
  });

  it("includes only latest step newFacts in direct prompt", async () => {
    const json = JSON.stringify({
      done: false,
      execution_mode: "dependent",
      intent: "continue",
      tools_hint: ["shell"],
      success_criteria: "done",
      context: "",
    });
    const provider = createMockProvider(json);
    const state = createState({
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
    expect(prompt).toContain("Latest step newFacts (step 2):");
    expect(prompt).toContain("tool_output:shell#1: latest output");
    expect(prompt).toContain("tool_error:read_file#2: file not found");
    expect(prompt).not.toContain("tool_output:shell#1: old output");
  });

  it("includes run artifact format guidance in direct prompt", async () => {
    const json = JSON.stringify({
      done: false,
      execution_mode: "dependent",
      intent: "continue",
      tools_hint: ["shell"],
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
    expect(prompt).toContain("Run artifacts root: /tmp/current-run");
    expect(prompt).toContain("Run artifact format:");
    expect(prompt).toContain("/tmp/current-run/state.json");
    expect(prompt).toContain("/tmp/current-run/steps/<NNN>-act.md");
    expect(prompt).toContain("/tmp/current-run/steps/<NNN>-verify.md");
    expect(prompt).toContain("Only latest step newFacts are inlined here; use context_search to read older-step facts.");
    expect(prompt).toContain("If the next action depends on an older non-latest step");
    expect(prompt).toContain("Before using any external skill, you MUST use \"skills\" scope");
  });

  it("includes runPath in recent runs section for direct prompt", async () => {
    const json = JSON.stringify({
      done: false,
      execution_mode: "dependent",
      intent: "continue",
      tools_hint: ["shell"],
      success_criteria: "done",
      context: "",
    });
    const provider = createMockProvider(json);
    const state = createState({
      recentRunLedgers: [
        {
          timestamp: "2026-02-28T05:20:15Z",
          runId: "abc",
          runPath: "/runs/abc",
          state: "completed",
          status: "completed",
          summary: "Found the folder slokan",
        },
      ],
    });

    await callDirect(provider, state, [shellTool]);

    const call = (provider.generateTurn as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const prompt = call.messages[0]!.content;
    expect(prompt).toContain("Recent runs (last 1):");
    expect(prompt).toContain("runId=abc runPath=/runs/abc");
  });

  it("uses injected direct instructions when provided", async () => {
    const json = JSON.stringify({
      done: false,
      execution_mode: "dependent",
      intent: "read config file",
      tools_hint: ["shell"],
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
      },
    );

    const call = (provider.generateTurn as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(call.messages).toHaveLength(1);
    expect(call.messages[0]!.role).toBe("user");
    expect(call.messages[0]!.content).toContain("- custom direct instruction");
  });
});

describe("callReEval", () => {
  it("includes success and failure context and returns new approach", async () => {
    const json = JSON.stringify({
      done: false,
      reeval: true,
      approach: "use a different search strategy",
    });
    const provider = createMockProvider(json);
    const state = createState({
      consecutiveFailures: 2,
      completedSteps: [
        {
          step: 1,
          intent: "read config",
          outcome: "success",
          summary: "Read package config",
          newFacts: ["package.json exists"],
          artifacts: [],
          toolSuccessCount: 1,
          toolFailureCount: 0,
        },
        {
          step: 2,
          intent: "scan /tmp",
          outcome: "failed",
          summary: "Permission denied on /tmp/secret",
          newFacts: [],
          artifacts: [],
          toolSuccessCount: 0,
          toolFailureCount: 1,
          failureType: "permission",
          stoppedEarlyReason: "repeated_identical_failure",
        },
      ],
      failedApproaches: [
        {
          step: 1,
          intent: "search /tmp",
          tools_hint: ["shell"],
          failureType: "permission",
          reason: "EACCES",
          blockedTargets: ["/tmp/secret"],
        },
      ],
    });

    const result = await callReEval(
      provider,
      state,
      [shellTool],
      "Scout found that step 2 failed because /tmp/secret is blocked",
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
    expect(call.messages[1]!.content).toContain("Run artifacts root: /tmp/test");
    expect(call.messages[1]!.content).toContain("Previous successful steps");
    expect(call.messages[1]!.content).toContain("Read package config");
    expect(call.messages[1]!.content).toContain("Failed steps");
    expect(call.messages[1]!.content).toContain("Failed Approaches");
    expect(call.messages[1]!.content).toContain("Scout research results (from prior context search):");
    expect(call.messages[1]!.content).toContain("If the revised approach depends on an older non-latest step");
    expect(call.messages[1]!.content).toContain("For context search: { \"done\": false, \"context_search\": true");
    expect(call.messages[1]!.content).toContain("Original goal:");
    expect(call.messages[1]!.content).toContain("objective: greet user");
  });

  it("includes session history in re-eval prompt", async () => {
    const json = JSON.stringify({
      done: false,
      reeval: true,
      approach: "try different strategy",
    });
    const provider = createMockProvider(json);
    const state = createState({
      consecutiveFailures: 2,
      sessionHistory: [
        { role: "user", content: "earlier question", timestamp: "2026-02-28T05:00:00Z", sessionPath: "/s/1" },
      ],
      recentRunLedgers: [
        { timestamp: "2026-02-28T05:00:10Z", runId: "prev1", runPath: "/runs/prev1", state: "completed", status: "completed", summary: "Answered earlier question" },
      ],
    });

    await callReEval(provider, state, [shellTool]);

    const call = (provider.generateTurn as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(call.messages[0]!.role).toBe("user");
    const prompt = call.messages[0]!.content;
    expect(prompt).toContain("Session conversation so far:");
    expect(prompt).toContain("earlier question");
    expect(prompt).toContain("Recent runs (last 1):");
    expect(prompt).toContain("runId=prev1");
    expect(prompt).toContain("runPath=/runs/prev1");
  });
});
