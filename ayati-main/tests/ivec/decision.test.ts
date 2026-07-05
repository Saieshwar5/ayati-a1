import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmProvider } from "../../src/core/contracts/provider.js";
import {
  ProviderEmptyResponseError,
  ProviderMalformedResponseError,
} from "../../src/core/contracts/provider-errors.js";
import type { LlmTurnOutput } from "../../src/core/contracts/llm-protocol.js";
import { callAgentDecision, parseAgentDecision } from "../../src/ivec/agent-runner/decision.js";
import type { AgentFeedbackEventInput, AgentFeedbackLedger } from "../../src/ivec/feedback-ledger.js";
import type { AgentStateView } from "../../src/ivec/agent-runner/state-view.js";
import { createRunMetrics } from "../../src/ivec/metrics.js";
import type { ToolDefinition } from "../../src/skills/types.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("parseAgentDecision", () => {
  it("ignores model-provided action assertions", () => {
    const decision = parseAgentDecision(JSON.stringify({
      kind: "act",
      action: {
        mode: "single",
        calls: [{
          id: "call_1",
          tool: "write_files",
          input: { files: [] },
          dependsOn: [],
          purpose: "Create files",
        }],
        allowedTools: ["write_files"],
        assertions: [{
          id: "model_invented_check",
          kind: "html_contains",
          text: "Organic Vegetables",
        }],
      },
    }));

    expect(decision.kind).toBe("act");
    if (decision.kind !== "act") {
      throw new Error("Expected act decision.");
    }
    expect(decision.action.assertions).toEqual([]);
  });

  it("parses optional working notes", () => {
    const decision = parseAgentDecision(JSON.stringify({
      kind: "reply",
      status: "completed",
      message: "Done",
      workingNotes: ["  RAM used is 3.5Gi.  ", ""],
    }));

    expect(decision.kind).toBe("reply");
    expect(decision.workingNotes).toEqual(["RAM used is 3.5Gi."]);
  });

  it("accepts direct assistant text as a terminal reply", async () => {
    vi.stubEnv("AYATI_AGENT_TRACE", "1");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { provider, generateTurn } = createProvider([
      "Hi!",
    ]);

    const decision = await callAgentDecision({
      provider,
      stateView: createStateView(),
      toolDefinitions: [],
    });

    const traceOutput = log.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
    expect(generateTurn).toHaveBeenCalledTimes(1);
    expect(decision).toMatchObject({
      kind: "reply",
      status: "completed",
      message: "Hi!",
    });
    expect(traceOutput).toContain("provider_request provider=fake-provider");
    expect(traceOutput).toContain("nativeDecisionTools=auto");
    expect(traceOutput).toContain("raw_response=Hi!");
  });

  it("does not log decision traces by default", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { provider } = createProvider([
      JSON.stringify({ kind: "reply", status: "completed", message: "Hi!" }),
    ]);

    const decision = await callAgentDecision({
      provider,
      stateView: createStateView(),
      toolDefinitions: [],
    });

    expect(decision.kind).toBe("reply");
    expect(log).not.toHaveBeenCalled();
  });

  it("keeps action-first semantics in the stable decision prompt", async () => {
    const { provider, generateTurn } = createProvider([
      JSON.stringify({ kind: "reply", status: "completed", message: "Hi!" }),
    ]);

    await callAgentDecision({
      provider,
      stateView: createStateView(),
      toolDefinitions: [],
    });

    const messages = generateTurn.mock.calls[0]?.[0]?.messages ?? [];
    const systemPrompt = messages.find((message) => message.role === "system")?.content ?? "";
    expect(systemPrompt).toContain("Autonomous execution policy: for actionable user requests, prefer progress over discussion.");
    expect(systemPrompt).toContain("Use direct assistant text for normal terminal replies.");
    expect(systemPrompt).toContain("Use direct assistant text only as a terminal response");
    expect(systemPrompt).toContain("Do not use direct assistant text to say you will do future work.");
    expect(systemPrompt).toContain("call the selected executable tool directly");
    expect(systemPrompt).toContain("Use ask_user_feedback only during an active task run");
    expect(systemPrompt).toContain("Do not use ask_user_feedback for final responses");
    expect(systemPrompt).toContain("concrete deliverable and enough detail to begin now");
    expect(systemPrompt).toContain("reply directly with one short clarifying question instead of creating a task");
    expect(systemPrompt).toContain("Normal work tools require a task run");
    expect(systemPrompt).toContain("Do not tell the user tools are missing.");
    expect(systemPrompt).not.toContain("decision_act");
  });

  it("prefers the grouped prompt context paths in the stable decision prompt", async () => {
    const { provider, generateTurn } = createProvider([
      JSON.stringify({ kind: "reply", status: "completed", message: "Hi!" }),
    ]);

    await callAgentDecision({
      provider,
      stateView: createStateView(),
      toolDefinitions: [],
    });

    const messages = generateTurn.mock.calls[0]?.[0]?.messages ?? [];
    const systemPrompt = messages.find((message) => message.role === "system")?.content ?? "";
    expect(systemPrompt).toContain("Prefer the grouped context paths");
    expect(systemPrompt).toContain("context.git.current.task");
    expect(systemPrompt).toContain("context.git.session.attachments");
    expect(systemPrompt).toContain("Use context.git.session.summary as compressed session history");
    expect(systemPrompt).toContain("Use context.timeline for exact recent messages and current input");
    expect(systemPrompt).toContain("If summary and exact conversation conflict, trust context.timeline");
    expect(systemPrompt).toContain("do not infer omitted details from it");
    expect(systemPrompt).toContain("context.run.status");
    expect(systemPrompt).toContain("context.run.toolCalls");
    expect(systemPrompt).not.toContain("context.scratch");
    expect(systemPrompt).not.toContain("context.run.progress");
    expect(systemPrompt).not.toContain("context.run.feedback");
    expect(systemPrompt).toContain("context.harness.feedback");
    expect(systemPrompt).not.toContain("context.run.readContext.latest");
    expect(systemPrompt).not.toContain("context.run.observations.latest");
    expect(systemPrompt).not.toContain("context.run.trace");
    expect(systemPrompt).toContain("context.tools.active");
    expect(systemPrompt).toContain("context.personal.memorySnapshot");
    expect(systemPrompt).toContain("Legacy fields such as context.gitContext");
  });

  it("does not promote legacy git context in prompt state breakdown metrics", async () => {
    const { provider } = createProvider([
      JSON.stringify({ kind: "reply", status: "completed", message: "Hi!" }),
    ]);
    const metrics = createRunMetrics();

    await callAgentDecision({
      provider,
      stateView: createStateView({
        context: {
          timeline: [{
            kind: "user",
            seq: 1,
            timestamp: new Date(0).toISOString(),
            content: "continue",
            current: true,
          }],
          git: {
            session: {
              meta: {
                sessionId: "S-20260627-local",
                assetCount: 0,
              },
              summary: {
                text: "Session summary.",
              },
              activity: {
                recent: [],
              },
            },
            current: {
              focus: { status: "none" },
            },
          },
          gitContext: {
            session: {
              meta: {
                sessionId: "S-20260627-local",
                assetCount: 0,
              },
              conversationTail: [],
              conversationMarkdownTail: "# Conversation\n\nlegacy",
              summary: {
                text: "Session summary.",
              },
              activityTail: [],
              recentCommits: [],
            },
            focus: { status: "none" },
          },
        },
      }),
      toolDefinitions: [],
      metrics,
    });

    const breakdown = metrics.promptGrowthState.agent_decision?.stateBreakdown ?? {};
    expect(breakdown["state.context.git"]).toBeGreaterThan(0);
    expect(breakdown).not.toHaveProperty("state.context.gitContext");
  });

  it("sends a deduplicated state view to the model prompt", async () => {
    const { provider, generateTurn } = createProvider([
      JSON.stringify({ kind: "reply", status: "completed", message: "Hi!" }),
    ]);

    await callAgentDecision({
      provider,
      stateView: createStateView({
        context: {
          timeline: [{
            kind: "user",
            seq: 1,
            timestamp: new Date(0).toISOString(),
            content: "continue",
            current: true,
          }],
          git: {
            session: {
              meta: {
                sessionId: "S-20260627-local",
                assetCount: 0,
              },
              summary: {
                text: "Session summary.",
              },
              activity: {
                recent: [],
              },
            },
            current: {
              focus: { status: "none" },
            },
          },
          tools: {
            active: ["read_file"],
          },
          harness: {
            feedback: {
              latest: [{
                severity: "warning",
                source: "tool_validation",
                message: "Fix the next call.",
              }],
            },
          },
          run: {
            status: "not_done",
          },
          personal: {
            memorySnapshot: "Prefer concise answers.",
          },
          gitContext: {
            session: {
              sessionId: "S-20260627-local",
              conversationTail: [],
              conversationMarkdownTail: "# Conversation\n\nlegacy",
              summary: {
                text: "Session summary.",
              },
              activityTail: [],
              recentCommits: [],
              assetCount: 0,
            },
            focus: { status: "none" },
          },
          personalMemorySnapshot: "Prefer concise answers.",
        },
        progress: {
          status: "not_done",
          summary: "Work in progress.",
        },
        workingFeedback: {
          latest: [{
            severity: "warning",
            source: "tool_validation",
            message: "Fix the next call.",
          }],
        },
        toolLoad: {
          status: "success",
          requested: {
            query: "files",
            toolNames: ["read_file"],
            groups: ["filesystem"],
          },
          loaded: ["read_file"],
          alreadyActive: [],
          evicted: [],
          missing: [],
          message: "Loaded read_file.",
        },
        observations: {
          latest: [],
        },
        trace: {
          recentSteps: [],
        },
      }),
      toolDefinitions: [],
    });

    const messages = generateTurn.mock.calls[0]?.[0]?.messages ?? [];
    const userPrompt = messages.find((message) => message.role === "user")?.content ?? "";
    const promptStateView = parsePromptStateView(userPrompt);
    expect(promptStateView).toEqual({
      context: {
        timeline: [{
          kind: "user",
          seq: 1,
          timestamp: new Date(0).toISOString(),
          content: "continue",
          current: true,
        }],
        git: {
          session: {
            meta: {
              sessionId: "S-20260627-local",
              assetCount: 0,
            },
            summary: {
              text: "Session summary.",
            },
            activity: {
              recent: [],
            },
          },
          current: {
            focus: { status: "none" },
          },
        },
        tools: {
          active: ["read_file"],
        },
        harness: {
          feedback: {
            latest: [{
              severity: "warning",
              source: "tool_validation",
              message: "Fix the next call.",
            }],
          },
        },
        run: {
          status: "not_done",
        },
        personal: {
          memorySnapshot: "Prefer concise answers.",
        },
      },
    });
    expect(promptStateView).not.toHaveProperty("progress");
    expect(promptStateView).not.toHaveProperty("workingFeedback");
    expect(promptStateView).not.toHaveProperty("toolLoad");
    expect(promptStateView).not.toHaveProperty("observations");
    expect(promptStateView).not.toHaveProperty("trace");
    expect(promptStateView.context).not.toHaveProperty("gitContext");
    expect(promptStateView.context).not.toHaveProperty("personalMemorySnapshot");
    expect(promptStateView.context).not.toHaveProperty("scratch");
  });

  it("repairs act decisions that reference unselected tools into load_tools", async () => {
    const badAction = {
      kind: "act",
      action: {
        mode: "sequential",
        calls: [
          {
            id: "call_1",
            tool: "shell",
            input: { command: "pwd" },
            dependsOn: [],
          },
          {
            id: "call_2",
            tool: "load_tools",
            input: { groups: ["skill:shell"] },
            dependsOn: [],
          },
        ],
        allowedTools: ["shell", "load_tools"],
      },
    };
    const repaired = {
      kind: "load_tools",
      request: {
        groups: ["skill:shell"],
        reason: "Need shell to run a command.",
      },
    };
    const { provider, generateTurn } = createProvider([
      JSON.stringify(badAction),
      JSON.stringify(repaired),
    ]);
    const feedback = createFeedbackLedger();

    const decision = await callAgentDecision({
      provider,
      stateView: createStateView(),
      toolDefinitions: [],
      feedbackLedger: feedback.ledger,
      feedbackContext: {
        clientId: "local",
        sessionId: "S-test",
        seq: 1,
      },
    });

    expect(decision.kind).toBe("load_tools");
    expect(generateTurn).toHaveBeenCalledTimes(2);
    const repairMessages = generateTurn.mock.calls[1]?.[0]?.messages ?? [];
    const repairPrompt = repairMessages.at(-1)?.content;
    expect(repairPrompt).toContain("Repair code: R_LOAD_TOOLS_USED_AS_ACTION");
    expect(repairPrompt).toContain("Blocked targets: shell, load_tools");
    expect(repairPrompt).toContain("Use the native decision_load_tools control tool.");
    expect(feedback.events.find((event) => event.event === "protocol_violation")?.data).toMatchObject({
      repair: {
        code: "R_LOAD_TOOLS_USED_AS_ACTION",
        blockedTargets: ["shell", "load_tools"],
      },
    });
  });

  it("repairs tool-call JSON returned as assistant text", async () => {
    const fakeToolJson = JSON.stringify({
      tool: "git_context_create_task_for_turn",
      arguments: {
        taskCompletion: {
          intent: "not_completion",
          reason: "Create task for user request to create Linux commands file",
        },
      },
    });
    const repaired = {
      kind: "act",
      action: {
        mode: "single",
        calls: [{
          id: "call_1",
          tool: "git_context_create_task_for_turn",
          input: {
            title: "Linux commands file",
            objective: "Create a text file with 10 Linux commands.",
            reason: "The user requested durable file creation.",
          },
          dependsOn: [],
        }],
        allowedTools: ["git_context_create_task_for_turn"],
      },
    };
    const feedback = createFeedbackLedger();
    const { provider, generateTurn } = createProvider([
      fakeToolJson,
      JSON.stringify(repaired),
    ]);

    const decision = await callAgentDecision({
      provider,
      stateView: createStateView(),
      toolDefinitions: [createTool("git_context_create_task_for_turn")],
      feedbackLedger: feedback.ledger,
      feedbackContext: {
        clientId: "local",
        sessionId: "S-test",
        seq: 1,
      },
    });

    expect(decision.kind).toBe("act");
    expect(generateTurn).toHaveBeenCalledTimes(2);
    const repairPrompt = generateTurn.mock.calls[1]?.[0]?.messages.at(-1)?.content ?? "";
    expect(repairPrompt).toContain("Repair code: R_ASSISTANT_TEXT_TOOL_CALL");
    expect(repairPrompt).toContain("Blocked targets: git_context_create_task_for_turn");
    expect(repairPrompt).toContain("Do not write tool-call JSON in assistant text");
    expect(feedback.events.some((event) => event.event === "direct_reply")).toBe(false);
    expect(feedback.events.find((event) => event.event === "assistant_text_tool_call")?.data).toMatchObject({
      toolName: "git_context_create_task_for_turn",
      selectedTools: ["git_context_create_task_for_turn"],
      repair: {
        code: "R_ASSISTANT_TEXT_TOOL_CALL",
        blockedTargets: ["git_context_create_task_for_turn"],
        operatorDetails: {
          attempt: 1,
          toolName: "git_context_create_task_for_turn",
          inputKeys: ["taskCompletion"],
          selectedTools: ["git_context_create_task_for_turn"],
        },
      },
    });
    expect(feedback.events.find((event) => event.event === "repair_requested")?.data).toMatchObject({
      repair: {
        code: "R_ASSISTANT_TEXT_TOOL_CALL",
      },
    });
  });

  it("repairs truncated internal action JSON returned as assistant text", async () => {
    const truncatedInternalActionJson = "{\"kind\":\"act\",\"action\":{\"mode\":\"single\",\"allowedTools\":[\"write_files\"],\"calls\":[{\"id\":\"call_1\",\"t";
    const feedback = createFeedbackLedger();
    const { provider, generateTurn } = createNativeToolProvider([
      {
        type: "assistant",
        content: truncatedInternalActionJson,
      },
      {
        type: "tool_calls",
        calls: [{
          id: "call_2",
          name: "write_files",
          input: {
            files: [{ path: "live-tests/fresh-gate/count_lines.py", content: "print('ok')\n" }],
            createDirs: true,
            taskCompletion: {
              intent: "completion_candidate",
              reason: "This writes the requested script file.",
            },
          },
        }],
      },
    ]);

    const decision = await callAgentDecision({
      provider,
      stateView: createStateView(),
      toolDefinitions: [createTool("write_files", {
        type: "object",
        required: ["files"],
        properties: {
          files: { type: "array" },
          createDirs: { type: "boolean" },
        },
      })],
      feedbackLedger: feedback.ledger,
      feedbackContext: {
        clientId: "local",
        sessionId: "S-test",
        seq: 3,
      },
    });

    expect(decision.kind).toBe("act");
    if (decision.kind !== "act") {
      throw new Error("Expected act decision.");
    }
    expect(decision.action.calls[0]).toMatchObject({
      id: "call_2",
      tool: "write_files",
      input: {
        files: [{ path: "live-tests/fresh-gate/count_lines.py", content: "print('ok')\n" }],
        createDirs: true,
      },
    });
    expect(generateTurn).toHaveBeenCalledTimes(2);
    const repairPrompt = generateTurn.mock.calls[1]?.[0]?.messages.at(-1)?.content ?? "";
    expect(repairPrompt).toContain("Repair code: R_ASSISTANT_TEXT_TOOL_CALL");
    expect(repairPrompt).toContain("Blocked targets: write_files");
    expect(repairPrompt).toContain("Do not write tool-call JSON in assistant text");
    expect(feedback.events.find((event) => event.event === "assistant_text_tool_call")?.data).toMatchObject({
      toolName: "write_files",
      selectedTools: ["write_files"],
      repair: {
        code: "R_ASSISTANT_TEXT_TOOL_CALL",
        blockedTargets: ["write_files"],
      },
    });
    expect(feedback.events.some((event) => event.event === "parse_failed")).toBe(false);
  });

  it("returns a failed reply after repeated assistant-text tool calls", async () => {
    const fakeToolJson = JSON.stringify({
      tool: "git_context_create_task_for_turn",
      arguments: {
        taskCompletion: {
          intent: "not_completion",
          reason: "Create task for user request",
        },
      },
    });
    const { provider, generateTurn } = createProvider([fakeToolJson, fakeToolJson, fakeToolJson]);

    const decision = await callAgentDecision({
      provider,
      stateView: createStateView(),
      toolDefinitions: [createTool("git_context_create_task_for_turn")],
    });

    expect(generateTurn).toHaveBeenCalledTimes(3);
    expect(decision).toEqual({
      kind: "reply",
      status: "failed",
      message: "I could not form a valid tool call for this request.",
    });
  });

  it("returns a failed reply after repeated tool protocol violations", async () => {
    const badAction = JSON.stringify({
      kind: "act",
      action: {
        mode: "single",
        calls: [{
          id: "call_1",
          tool: "shell",
          input: { command: "pwd" },
          dependsOn: [],
        }],
        allowedTools: ["shell"],
      },
    });
    const { provider, generateTurn } = createProvider([badAction, badAction, badAction]);

    const decision = await callAgentDecision({
      provider,
      stateView: createStateView(),
      toolDefinitions: [],
    });

    expect(generateTurn).toHaveBeenCalledTimes(3);
    expect(decision).toEqual({
      kind: "reply",
      status: "failed",
      message: "I could not form a valid tool call for this request.",
    });
  });

  it("records a repair code when a decision calls an unselected tool", async () => {
    const badAction = {
      kind: "act",
      action: {
        mode: "single",
        calls: [{
          id: "call_1",
          tool: "shell",
          input: { command: "pwd" },
          dependsOn: [],
        }],
        allowedTools: ["shell"],
      },
    };
    const repaired = {
      kind: "load_tools",
      request: {
        groups: ["skill:shell"],
      },
    };
    const feedback = createFeedbackLedger();
    const { provider, generateTurn } = createProvider([
      JSON.stringify(badAction),
      JSON.stringify(repaired),
    ]);

    const decision = await callAgentDecision({
      provider,
      stateView: createStateView(),
      toolDefinitions: [],
      feedbackLedger: feedback.ledger,
      feedbackContext: {
        clientId: "local",
        sessionId: "S-test",
        seq: 1,
      },
    });

    expect(decision.kind).toBe("load_tools");
    const repairPrompt = generateTurn.mock.calls[1]?.[0]?.messages.at(-1)?.content ?? "";
    expect(repairPrompt).toContain("Repair code: R_TOOL_NOT_SELECTED");
    expect(repairPrompt).toContain("Blocked targets: shell");
    expect(feedback.events.find((event) => event.event === "protocol_violation")?.data).toMatchObject({
      repair: {
        code: "R_TOOL_NOT_SELECTED",
        blockedTargets: ["shell"],
      },
    });
  });

  it("allows act decisions that use selected tools", async () => {
    const { provider, generateTurn } = createProvider([
      JSON.stringify({
        kind: "act",
        action: {
          mode: "single",
          calls: [{
            id: "call_1",
            tool: "shell",
            input: { command: "pwd" },
            dependsOn: [],
          }],
          allowedTools: ["shell"],
        },
      }),
    ]);

    const decision = await callAgentDecision({
      provider,
      stateView: createStateView(),
      toolDefinitions: [createTool("shell")],
    });

    expect(generateTurn).toHaveBeenCalledTimes(1);
    expect(decision.kind).toBe("act");
  });

  it("uses native decision tools when supported", async () => {
    const { provider, generateTurn } = createProvider([
      JSON.stringify({ kind: "reply", status: "completed", message: "Hi!" }),
    ], { jsonSchema: true });

    await callAgentDecision({
      provider,
      stateView: createStateView(),
      toolDefinitions: [],
    });

    expect(generateTurn.mock.calls[0]?.[0]?.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "decision_load_tools",
    ]);
    expect(generateTurn.mock.calls[0]?.[0]?.toolChoice).toBe("auto");
    expect(generateTurn.mock.calls[0]?.[0]?.parallelToolCalls).toBe(false);
  });

  it("records and retries an empty provider response once", async () => {
    const providerError = new ProviderEmptyResponseError("Empty response from OpenRouter.", {
      provider: "openrouter",
      model: "test-model",
      choiceCount: 0,
      responseKeys: ["id", "choices"],
    });
    const { provider, generateTurn } = createProviderFromMock(
      vi.fn()
        .mockRejectedValueOnce(providerError)
        .mockResolvedValueOnce({ type: "assistant", content: "Hi!" }),
    );
    const feedback = createFeedbackLedger();

    const decision = await callAgentDecision({
      provider,
      stateView: createStateView(),
      toolDefinitions: [],
      feedbackLedger: feedback.ledger,
      feedbackContext: {
        clientId: "local",
        sessionId: "S-test",
        seq: 1,
      },
    });

    expect(generateTurn).toHaveBeenCalledTimes(2);
    expect(decision).toMatchObject({
      kind: "reply",
      status: "completed",
      message: "Hi!",
    });
    const emptyEvents = feedback.events.filter((event) => event.event === "provider_empty_response");
    expect(emptyEvents).toHaveLength(1);
    expect(emptyEvents[0]?.data).toMatchObject({
      attempt: 1,
      providerAttempt: 1,
      provider: "openrouter",
      model: "test-model",
      choiceCount: 0,
      responseKeys: ["id", "choices"],
      toolChoice: "auto",
      nativeToolCount: 1,
      requestMode: "tools",
      willRetry: true,
      retryDelayMs: 400,
      repair: {
        code: "R_PROVIDER_EMPTY_RESPONSE",
        modelFacing: false,
        operatorDetails: {
          provider: "openrouter",
          model: "test-model",
          choiceCount: 0,
          willRetry: true,
        },
      },
    });
  });

  it("records and retries a malformed provider response once", async () => {
    const providerError = new ProviderMalformedResponseError("Malformed response from OpenRouter.", {
      provider: "openrouter",
      model: "test-model",
      errorName: "SyntaxError",
      errorMessage: "Unexpected end of JSON input",
    });
    const { provider, generateTurn } = createProviderFromMock(
      vi.fn()
        .mockRejectedValueOnce(providerError)
        .mockResolvedValueOnce({ type: "assistant", content: "Hi!" }),
    );
    const feedback = createFeedbackLedger();

    const decision = await callAgentDecision({
      provider,
      stateView: createStateView(),
      toolDefinitions: [],
      feedbackLedger: feedback.ledger,
      feedbackContext: {
        clientId: "local",
        sessionId: "S-test",
        seq: 1,
      },
    });

    expect(generateTurn).toHaveBeenCalledTimes(2);
    expect(decision).toMatchObject({
      kind: "reply",
      status: "completed",
      message: "Hi!",
    });
    const malformedEvents = feedback.events.filter((event) => event.event === "provider_malformed_response");
    expect(malformedEvents).toHaveLength(1);
    expect(malformedEvents[0]?.data).toMatchObject({
      attempt: 1,
      providerAttempt: 1,
      provider: "openrouter",
      model: "test-model",
      errorName: "SyntaxError",
      errorMessage: "Unexpected end of JSON input",
      toolChoice: "auto",
      nativeToolCount: 1,
      requestMode: "tools",
      willRetry: true,
      retryDelayMs: 400,
      repair: {
        code: "R_PROVIDER_MALFORMED_RESPONSE",
        modelFacing: false,
        operatorDetails: {
          provider: "openrouter",
          model: "test-model",
          errorName: "SyntaxError",
          errorMessage: "Unexpected end of JSON input",
          willRetry: true,
        },
      },
    });
  });

  it("records final empty provider response when retry also fails", async () => {
    const providerError = new ProviderEmptyResponseError("Empty response from OpenRouter.", {
      provider: "openrouter",
      model: "test-model",
      choiceCount: 0,
      responseKeys: ["choices"],
    });
    const { provider, generateTurn } = createProviderFromMock(vi.fn().mockRejectedValue(providerError));
    const feedback = createFeedbackLedger();

    await expect(callAgentDecision({
      provider,
      stateView: createStateView(),
      toolDefinitions: [],
      feedbackLedger: feedback.ledger,
      feedbackContext: {
        clientId: "local",
        sessionId: "S-test",
        seq: 1,
      },
    })).rejects.toThrow("Empty response from OpenRouter.");

    expect(generateTurn).toHaveBeenCalledTimes(2);
    const emptyEvents = feedback.events.filter((event) => event.event === "provider_empty_response");
    expect(emptyEvents).toHaveLength(2);
    expect(emptyEvents[0]?.data).toMatchObject({
      providerAttempt: 1,
      willRetry: true,
      repair: {
        code: "R_PROVIDER_EMPTY_RESPONSE",
      },
    });
    expect(emptyEvents[1]?.data).toMatchObject({
      providerAttempt: 2,
      willRetry: false,
      repair: {
        code: "R_PROVIDER_EMPTY_RESPONSE",
        operatorDetails: {
          willRetry: false,
        },
      },
    });
  });

  it("exposes task feedback only when enabled", async () => {
    const { provider, generateTurn } = createProvider([
      JSON.stringify({ kind: "ask_user", question: "Which path?", reason: "Need a target path." }),
    ], { jsonSchema: true });

    const decision = await callAgentDecision({
      provider,
      stateView: createStateView(),
      toolDefinitions: [],
      taskFeedbackToolAvailable: true,
    });

    expect(generateTurn.mock.calls[0]?.[0]?.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "decision_load_tools",
      "ask_user_feedback",
    ]);
    expect(decision).toMatchObject({
      kind: "ask_user",
      question: "Which path?",
      reason: "Need a target path.",
    });
  });

  it("exposes selected executable tools as native tools", async () => {
    const { provider, generateTurn } = createProvider([
      JSON.stringify({ kind: "reply", status: "completed", message: "Hi!" }),
    ], { jsonObject: true, jsonSchema: true });

    await callAgentDecision({
      provider,
      stateView: createStateView(),
      toolDefinitions: [createTool("write_files", {
        type: "object",
        required: ["files"],
        properties: {
          files: { type: "array" },
        },
        additionalProperties: false,
      })],
    });

    const tools = generateTurn.mock.calls[0]?.[0]?.tools ?? [];
    expect(tools.map((tool: { name: string }) => tool.name)).toEqual([
      "decision_load_tools",
      "write_files",
    ]);
    expect(tools.find((tool: { name: string }) => tool.name === "write_files")?.inputSchema).toMatchObject({
      required: expect.arrayContaining(["files", "taskCompletion"]),
      properties: {
        taskCompletion: {
          required: ["intent", "reason"],
          properties: {
            intent: {
              enum: ["not_completion", "completion_candidate"],
            },
          },
        },
      },
    });
  });

  it("converts a selected native executable tool call into an internal act decision", async () => {
    const { provider, generateTurn } = createNativeToolProvider([
      {
        type: "tool_calls",
        calls: [{
          id: "call_1",
          name: "write_files",
          input: {
            files: [{ path: "site/index.html", content: "ok" }],
            createDirs: true,
            taskCompletion: {
              intent: "completion_candidate",
              reason: "This writes the requested site file.",
              expectedEvidence: ["site/index.html written"],
            },
          },
        }],
      },
    ]);

    const decision = await callAgentDecision({
      provider,
      stateView: createStateView(),
      toolDefinitions: [createTool("write_files", {
        type: "object",
        required: ["files"],
        properties: {
          files: { type: "array" },
          createDirs: { type: "boolean" },
        },
      })],
    });

    expect(generateTurn).toHaveBeenCalledTimes(1);
    expect(decision.kind).toBe("act");
    if (decision.kind !== "act") {
      throw new Error("Expected act decision.");
    }
    expect(decision.action).toMatchObject({
      mode: "single",
      allowedTools: ["write_files"],
      calls: [{
        id: "call_1",
        tool: "write_files",
        input: {
          files: [{ path: "site/index.html", content: "ok" }],
          createDirs: true,
        },
        dependsOn: [],
      }],
      completion: {
        intent: "completion_candidate",
        reason: "This writes the requested site file.",
        expectedEvidence: ["site/index.html written"],
      },
    });
  });

  it("repairs selected native executable calls with invalid input", async () => {
    const { provider, generateTurn } = createNativeToolProvider([
      {
        type: "tool_calls",
        calls: [{
          id: "call_1",
          name: "write_files",
          input: {},
        }],
      },
      {
        type: "tool_calls",
        calls: [{
          id: "call_1",
          name: "write_files",
          input: { files: [{ path: "site/index.html", content: "ok" }] },
        }],
      },
    ]);
    const feedback = createFeedbackLedger();

    const decision = await callAgentDecision({
      provider,
      stateView: createStateView(),
      toolDefinitions: [createTool("write_files", {
        type: "object",
        required: ["files"],
        properties: {
          files: { type: "array" },
        },
      })],
      feedbackLedger: feedback.ledger,
      feedbackContext: {
        clientId: "local",
        sessionId: "S-test",
        seq: 1,
      },
    });

    expect(generateTurn).toHaveBeenCalledTimes(2);
    expect(decision.kind).toBe("act");
    const repairMessages = generateTurn.mock.calls[1]?.[0]?.messages ?? [];
    const repairPrompt = repairMessages.at(-1)?.content;
    expect(repairPrompt).toContain("Repair code: R_TOOL_INPUT_MISSING_REQUIRED_FIELD");
    expect(repairPrompt).toContain("Missing fields: files");
    expect(repairPrompt).toContain("Call the selected tool again with the missing required fields.");
    expect(feedback.events.find((event) => event.event === "input_schema_violation")?.data).toMatchObject({
      repair: {
        code: "R_TOOL_INPUT_MISSING_REQUIRED_FIELD",
        blockedTargets: ["write_files"],
        missingFields: ["files"],
      },
    });
  });

  it("repairs act decisions with invalid selected tool input", async () => {
    const badAction = {
      kind: "act",
      action: {
        mode: "single",
        calls: [{
          id: "call_1",
          tool: "write_files",
          input: {},
          dependsOn: [],
          purpose: "Create files",
        }],
        allowedTools: ["write_files"],
      },
    };
    const repairedAction = {
      kind: "act",
      action: {
        mode: "single",
        calls: [{
          id: "call_1",
          tool: "write_files",
          input: { files: [{ path: "site/index.html", content: "ok" }] },
          dependsOn: [],
          purpose: "Create files",
        }],
        allowedTools: ["write_files"],
      },
    };
    const { provider, generateTurn } = createProvider([
      JSON.stringify(badAction),
      JSON.stringify(repairedAction),
    ]);

    const decision = await callAgentDecision({
      provider,
      stateView: createStateView(),
      toolDefinitions: [createTool("write_files", {
        type: "object",
        required: ["files"],
        properties: {
          files: { type: "array" },
        },
      })],
    });

    expect(generateTurn).toHaveBeenCalledTimes(2);
    expect(decision.kind).toBe("act");
    const repairMessages = generateTurn.mock.calls[1]?.[0]?.messages ?? [];
    const repairPrompt = repairMessages.at(-1)?.content;
    expect(repairPrompt).toContain("Repair code: R_TOOL_INPUT_MISSING_REQUIRED_FIELD");
    expect(repairPrompt).toContain("Missing fields: files");
    expect(repairPrompt).toContain("Call the selected tool again with the missing required fields.");
  });
});

function createProvider(
  responses: string[],
  structuredOutput: { jsonObject: boolean; jsonSchema: boolean } = { jsonObject: true, jsonSchema: false },
): { provider: LlmProvider; generateTurn: ReturnType<typeof vi.fn> } {
  let index = 0;
  const generateTurn = vi.fn(async () => {
    const content = responses[Math.min(index, responses.length - 1)] ?? "";
    index++;
    return { type: "assistant" as const, content };
  });
  return {
    provider: {
      name: "fake-provider",
      version: "test-model",
      capabilities: {
        nativeToolCalling: true,
        structuredOutput,
      },
      start() {},
      stop() {},
      generateTurn,
    },
    generateTurn,
  };
}

function createNativeToolProvider(
  responses: LlmTurnOutput[],
  structuredOutput: { jsonObject: boolean; jsonSchema: boolean } = { jsonObject: true, jsonSchema: false },
): { provider: LlmProvider; generateTurn: ReturnType<typeof vi.fn> } {
  let index = 0;
  const generateTurn = vi.fn(async () => {
    const response = responses[Math.min(index, responses.length - 1)];
    index++;
    if (!response) {
      throw new Error("No queued provider response.");
    }
    return response;
  });
  return {
    provider: {
      name: "fake-provider",
      version: "test-model",
      capabilities: {
        nativeToolCalling: true,
        structuredOutput,
      },
      start() {},
      stop() {},
      generateTurn,
    },
    generateTurn,
  };
}

function createProviderFromMock(
  generateTurn: ReturnType<typeof vi.fn>,
  structuredOutput: { jsonObject: boolean; jsonSchema: boolean } = { jsonObject: true, jsonSchema: false },
): { provider: LlmProvider; generateTurn: ReturnType<typeof vi.fn> } {
  return {
    provider: {
      name: "fake-provider",
      version: "test-model",
      capabilities: {
        nativeToolCalling: true,
        structuredOutput,
      },
      start() {},
      stop() {},
      generateTurn,
    },
    generateTurn,
  };
}

function createFeedbackLedger(): { ledger: AgentFeedbackLedger; events: AgentFeedbackEventInput[] } {
  const events: AgentFeedbackEventInput[] = [];
  return {
    events,
    ledger: {
      enabled: true,
      record(event: AgentFeedbackEventInput) {
        events.push(event);
      },
      async flush() {},
      async close() {},
    },
  };
}

function createTool(name: string, inputSchema?: Record<string, unknown>): ToolDefinition {
  return {
    name,
    description: `${name} test tool`,
    ...(inputSchema ? { inputSchema } : {}),
    execute: async () => ({
      ok: true,
      content: "",
    }),
  };
}

function parsePromptStateView(userPrompt: string): Record<string, unknown> {
  const marker = "State view:\n";
  const index = userPrompt.indexOf(marker);
  if (index < 0) {
    throw new Error("State view marker missing from prompt.");
  }
  return JSON.parse(userPrompt.slice(index + marker.length)) as Record<string, unknown>;
}

function createStateView(overrides: Partial<AgentStateView> = {}): AgentStateView {
  return {
    context: {
      timeline: [{
        kind: "user",
        seq: 1,
        timestamp: new Date(0).toISOString(),
        content: "Hii",
        current: true,
      }],
    },
    ...overrides,
  };
}
