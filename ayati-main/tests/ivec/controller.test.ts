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
): LlmProvider {
  const replies = Array.isArray(response) ? [...response] : [response];
  return {
    name: "mock",
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
    recentContextSearches: [],
    runPath: "/tmp/test",
    failedApproaches: [],
    sessionHistory: [],
    recentRunLedgers: [],
    openFeedbacks: [],
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
      work_mode: "structured_data_process",
    });
    const result = parseUnderstandResponse(json);
    expect(result.done).toBe(false);
    if (!result.done) {
      expect(result.work_mode).toBe("structured_data_process");
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
    expect(call.messages[1]?.content).toContain(
      "Use strict JSON syntax with double-quoted strings and lowercase true, false, and null.",
    );
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
    expect(prompt).toContain("Before using one or more external skills, you MUST use \"skills\" scope");
    expect(prompt).toContain("If the next step depends on multiple external skills, prefer one broad \"skills\" query");
    expect(prompt).toContain("Read the playwright and websearch skill.md commands needed for this step.");
  });

  it("includes verification-first and high-cost clarification guidance in direct prompt", async () => {
    const json = JSON.stringify({
      done: false,
      execution_mode: "dependent",
      intent: "verify a public fact",
      tools_hint: ["shell"],
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
    expect(prompt).toContain("If the next step would be expensive, time-consuming, or hard to undo");
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

  it("includes prepared attachment guidance in direct prompt when available", async () => {
    const json = JSON.stringify({
      done: false,
      execution_mode: "dependent",
      intent: "query the prepared attachment",
      tools_hint: ["document_query"],
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
  });

  it("hides active session attachments when current run attachments are already prepared", async () => {
    const json = JSON.stringify({
      done: false,
      execution_mode: "dependent",
      intent: "profile the current attachment",
      tools_hint: ["dataset_profile"],
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
          source: "web",
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
        execution_mode: "dependent",
        execution_contract: "Read the AWS billing email details from Gmail",
        tool_plan: [
          {
            tool: "gmail_read",
            input: { messageId: "msg-1" },
            origin: "builtin",
            source_refs: [],
            retry_policy: "none",
          },
        ],
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
        execution_mode: "dependent",
        execution_contract: "Read the AWS billing email details from Gmail",
        tool_plan: [
          {
            tool: "gmail_read",
            input: { messageId: "msg-1" },
            origin: "builtin",
            source_refs: [],
            retry_policy: "none",
          },
        ],
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
    expect(repairPrompt?.content).toContain("return a step or context_search instead of completion");
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
        execution_mode: "dependent",
        execution_contract: "Read the AWS billing email details from Gmail",
        tool_plan: [
          {
            tool: "gmail_read",
            input: { messageId: "msg-1" },
            origin: "builtin",
            source_refs: [],
            retry_policy: "none",
          },
        ],
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

  it("throws a controller format error after two invalid controller responses", async () => {
    const provider = createMockProvider([
      "I need to inspect the mail first.",
      "Still not JSON.",
    ]);

    const run = callDirect(provider, createState(), [shellTool]);
    await expect(run).rejects.toThrow(ControllerResponseFormatError);
    await expect(run).rejects.toThrow(/Invalid controller response format at direct stage/);
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
      recentContextSearches: [
        {
          scope: "run_artifacts",
          query: "What happened in step 2?",
          status: "success",
          context: "Step 2 failed because /tmp/secret is blocked.",
          sources: ["/tmp/test/steps/002-verify.md"],
          confidence: 0.92,
          iteration: 2,
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
    expect(call.messages[1]!.content).toContain("Recent context_search results (latest 5):");
    expect(call.messages[1]!.content).toContain("query=What happened in step 2?");
    expect(call.messages[1]!.content).toContain("Retrieved context from prior context_search:");
    expect(call.messages[1]!.content).toContain("If the revised approach depends on an older non-latest step");
    expect(call.messages[1]!.content).toContain(
      "For context search: { \"kind\": \"context_search\", \"payload\": { \"done\": false, \"context_search\": true",
    );
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
