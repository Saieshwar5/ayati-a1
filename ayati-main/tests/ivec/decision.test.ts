import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmProvider } from "../../src/core/contracts/provider.js";
import {
  ProviderEmptyResponseError,
  ProviderMalformedResponseError,
} from "../../src/core/contracts/provider-errors.js";
import type { LlmTurnInput, LlmTurnOutput } from "../../src/core/contracts/llm-protocol.js";
import {
  ContextInputLimitError,
  ContextRunCapacityError,
} from "../../src/prompt/context-compilation-receipt.js";
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

  it("sends recent committed session work to the provider for a follow-up", async () => {
    const { provider, generateTurn } = createProvider([
      "I created index.html and styles.css.",
    ]);
    const recentCommit = {
      commit: "commit-1",
      subject: "session: created aurora coffee website",
      conversationSummary: "The user requested an Aurora Coffee website.",
      workSummary: "Created and validated the responsive website.",
      assets: [
        { path: "aurora-coffee-site/index.html", description: "Main website page" },
        { path: "aurora-coffee-site/styles.css", description: "Responsive styling" },
      ],
      outcome: "done",
      validation: "passed",
      workId: "W-20260714-0001",
      runId: "R-20260714-0004",
    };

    await callAgentDecision({
      provider,
      stateView: createStateView({
        context: {
          timeline: [{
            kind: "user",
            seq: 2,
            timestamp: "2026-07-14T10:31:00.000Z",
            content: "What files did you create?",
            current: true,
          }],
          git: {
            session: {
              meta: { sessionId: "S-20260714-local", assetCount: 0 },
              recentCommits: [recentCommit],
              activity: { recent: [] },
            },
            current: { focus: { status: "none" } },
          },
        },
      }),
      toolDefinitions: [],
    });

    const sentState = promptStateFromTurn(generateTurn.mock.calls[0]![0]);
    const sentContext = sentState["context"] as {
      git: { session: { recentCommits?: unknown[] } };
    };
    expect(sentContext.git.session.recentCommits).toEqual([recentCommit]);
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
    expect(systemPrompt).toContain("There is no session-global active task");
    expect(systemPrompt).toContain("Treat a task as a long-lived workstream");
    expect(systemPrompt).toContain("A separate feature, lesson, analysis, or independently completable improvement belongs to a new request in the same task");
    expect(systemPrompt).toContain("Request completion does not archive its task");
    expect(systemPrompt).toContain("Exact resource ownership is stronger evidence than title similarity");
    expect(systemPrompt).toContain("If ownership is ambiguous, reply directly with one short clarifying question");
    expect(systemPrompt).toContain("Normal work tools require an explicitly selected task run");
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
    expect(systemPrompt).toContain("kind=\"checkpoint\" is a structured summary of its covered older sequence range");
    expect(systemPrompt).toContain("Exact timeline events after it remain authoritative");
    expect(systemPrompt).toContain("do not infer omitted details from it");
    expect(systemPrompt).toContain("context.run.status");
    expect(systemPrompt).toContain("context.run.workState");
    expect(systemPrompt).toContain("context.run.toolCalls");
    expect(systemPrompt).toContain("mode=\"summary\"");
    expect(systemPrompt).toContain("outputPreview");
    expect(systemPrompt).toContain("stepRef");
    expect(systemPrompt).toContain("evidenceRef");
    expect(systemPrompt).toContain("use a narrow normal domain read");
    expect(systemPrompt).toContain("When context.run.contextPressure is present, work in small verifiable steps");
    expect(systemPrompt).toContain("context.run.contextPressure.recommendedMode is a runtime escalation signal");
    expect(systemPrompt).toContain("Do not summarize or rewrite timeline, task, session, work-state, or source tool records yourself");
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

  it("records a model-aware budget for the complete decision request", async () => {
    const { provider } = createProvider([
      JSON.stringify({ kind: "reply", status: "completed", message: "Hi!" }),
    ]);
    const metrics = createRunMetrics();
    const feedback = createFeedbackLedger();
    const onContextCompilation = vi.fn();

    await callAgentDecision({
      provider,
      stateView: createStateView(),
      toolDefinitions: [createTool("read_files", {
        type: "object",
        properties: {
          files: { type: "array", items: { type: "object" } },
        },
      })],
      metrics,
      feedbackLedger: feedback.ledger,
      feedbackContext: {
        clientId: "client-1",
        sessionId: "session-1",
        seq: 1,
      },
      onContextCompilation,
    });

    const event = metrics.optimizationEvents.find((item) => item.kind === "context_budget");
    expect(event?.data).toMatchObject({
      stage: "agent_decision",
      decisionAttempt: 1,
      contextWindowTokens: 128_000,
      recoveryTargetTokens: 60_000,
      softInputTokens: 70_000,
      hardInputTokens: 100_000,
      limitSource: "default_128k",
      countSource: "local_estimate",
      providerCountStatus: "not_needed",
      pressureLevel: "normal",
      overBudget: false,
    });
    expect(event?.data["measuredInputTokens"]).toEqual(expect.any(Number));
    expect(feedback.events.some((item) => item.event === "context_budget")).toBe(true);
    expect(metrics.optimizationEvents.some((item) => item.kind === "context_compilation")).toBe(true);
    expect(metrics.optimizationEvents.some((item) => item.kind === "tool_context_projection_shadow")).toBe(false);
    expect(onContextCompilation).toHaveBeenCalledWith(expect.objectContaining({
      mode: "full",
      admitted: true,
      transformations: [],
    }));
  });

  it("rejects an over-limit request before provider generation", async () => {
    const generateTurn = vi.fn();
    const countInputTokens = vi.fn().mockResolvedValue({
      provider: "fake-provider",
      model: "test-model",
      inputTokens: 101_000,
      exact: true,
    });
    const provider: LlmProvider = {
      name: "fake-provider",
      version: "test-model",
      capabilities: { nativeToolCalling: true },
      start() {},
      stop() {},
      countInputTokens,
      generateTurn,
    };
    const onContextCompilation = vi.fn();

    await expect(callAgentDecision({
      provider,
      stateView: createStateView({
        context: {
          timeline: [{
            kind: "user",
            seq: 1,
            timestamp: "2026-07-10T00:00:00.000Z",
            content: "x".repeat(300_000),
            current: true,
          }],
        },
      }),
      toolDefinitions: [],
      onContextCompilation,
    })).rejects.toBeInstanceOf(ContextInputLimitError);

    expect(countInputTokens).toHaveBeenCalledTimes(1);
    expect(generateTurn).not.toHaveBeenCalled();
    expect(onContextCompilation).toHaveBeenCalledWith(expect.objectContaining({
      admitted: false,
      hardLimitExceeded: true,
    }));
  });

  it("ends context recovery when no source is eligible for projection", async () => {
    const generateTurn = vi.fn().mockResolvedValue({
      type: "assistant",
      content: JSON.stringify({ kind: "reply", status: "completed", message: "Continue" }),
    });
    const countInputTokens = vi.fn().mockResolvedValue({
      provider: "fake-provider",
      model: "test-model",
      inputTokens: 80_000,
      exact: true,
    });
    const provider: LlmProvider = {
      name: "fake-provider",
      version: "test-model",
      capabilities: { nativeToolCalling: true },
      start() {},
      stop() {},
      countInputTokens,
      generateTurn,
    };
    const onContextCompilation = vi.fn();

    await expect(callAgentDecision({
      provider,
      stateView: createStateView({
        context: {
          timeline: [{
            kind: "user",
            seq: 1,
            timestamp: "2026-07-10T00:00:00.000Z",
            content: "x".repeat(300_000),
            current: true,
          }],
        },
      }),
      toolDefinitions: [],
      toolContextProjectionPolicy: "enforce",
      onContextCompilation,
    })).rejects.toBeInstanceOf(ContextRunCapacityError);

    expect(countInputTokens).toHaveBeenCalledTimes(1);
    expect(generateTurn).not.toHaveBeenCalled();
    expect(onContextCompilation).toHaveBeenCalledWith(expect.objectContaining({
      mode: "full",
      toolProjectionPolicy: "enforce",
      targetReached: false,
      needsEscalation: false,
      recoveryExhausted: true,
      admitted: true,
    }));
  });

  it("records a pressure-only tool projection plan without changing the request", async () => {
    const generateTurn = vi.fn().mockResolvedValue({
      type: "assistant",
      content: JSON.stringify({ kind: "reply", status: "completed", message: "Done" }),
    });
    const provider: LlmProvider = {
      name: "fake-provider",
      version: "test-model",
      capabilities: { nativeToolCalling: true },
      start() {},
      stop() {},
      countInputTokens: vi.fn().mockResolvedValue({
        provider: "fake-provider",
        model: "test-model",
        inputTokens: 80_000,
        exact: true,
      }),
      generateTurn,
    };
    const metrics = createRunMetrics();
    const toolCalls = Array.from({ length: 10 }, (_, index) => ({
      step: index + 1,
      callId: `call-${index + 1}`,
      tool: "read_files",
      input: { path: `src/file-${index + 1}.ts` },
      status: "success" as const,
      retention: "next_step" as const,
      mode: "full" as const,
      output: "x".repeat(30_000),
      projectionMetadata: { filePath: `src/file-${index + 1}.ts`, lineCount: 1_000 },
      stepRef: { runId: "run-1", step: index + 1, callId: `call-${index + 1}` },
    }));

    await callAgentDecision({
      provider,
      stateView: createStateView({
        context: {
          timeline: [{
            kind: "user",
            seq: 1,
            timestamp: "2026-07-10T00:00:00.000Z",
            content: "Continue the task",
            current: true,
          }],
          run: { toolCalls },
        },
      }),
      toolDefinitions: [],
      metrics,
    });

    const event = metrics.optimizationEvents.find(
      (item) => item.kind === "tool_context_projection_shadow",
    );
    expect(event?.data).toMatchObject({
      shadow: true,
      triggered: true,
      candidateInputTokens: 80_000,
      recoveryTargetTokens: 60_000,
      hotWindowSize: 6,
      shadowLocalEstimateTokens: expect.any(Number),
      correctedShadowLocalEstimateTokens: expect.any(Number),
    });
    const plannedCalls = event?.data["calls"] as Array<{ mode: string; reason: string; projectorId?: string }>;
    expect(event?.data["estimatedSavingsTokens"]).toBeGreaterThan(0);
    expect(event?.data["projectedInputTokens"]).toBeLessThan(80_000);
    expect(plannedCalls.slice(-6).every((call) => call.mode === "full")).toBe(true);
    expect(plannedCalls.slice(0, 4).some((call) => call.projectorId === "filesystem_read_v1")).toBe(true);

    const sentUserPrompt = generateTurn.mock.calls[0]?.[0]?.messages
      .find((message: { role: string }) => message.role === "user")?.content;
    if (typeof sentUserPrompt !== "string") {
      throw new Error("Expected a user prompt.");
    }
    const sentState = parsePromptStateView(sentUserPrompt);
    const sentCalls = (sentState["context"] as { run: { toolCalls: Array<{ mode: string }> } }).run.toolCalls;
    expect(sentCalls.every((call) => call.mode === "full")).toBe(true);
    expect(sentCalls.every((call) => !("projectionMetadata" in call))).toBe(true);
  });

  it("enforces tool projection and admits the measured final request", async () => {
    const generateTurn = vi.fn().mockResolvedValue({
      type: "assistant",
      content: JSON.stringify({ kind: "reply", status: "completed", message: "Done" }),
    });
    const countInputTokens = vi.fn()
      .mockResolvedValueOnce({ provider: "fake-provider", model: "test-model", inputTokens: 101_000, exact: true })
      .mockResolvedValueOnce({ provider: "fake-provider", model: "test-model", inputTokens: 65_000, exact: true });
    const provider: LlmProvider = {
      name: "fake-provider",
      version: "test-model",
      capabilities: { nativeToolCalling: true },
      start() {},
      stop() {},
      countInputTokens,
      generateTurn,
    };
    const task = protectedTaskContext();
    const workState = {
      status: "not_done" as const,
      blockers: ["Keep the protected state intact."],
      verifiedFacts: ["The candidate was measured."],
      nextStep: "Compile only tool-call context.",
    };
    const stateView = createStateView({
      context: {
        timeline: [{
          kind: "user",
          seq: 1,
          timestamp: "2026-07-10T00:00:00.000Z",
          content: "Continue the task",
          current: true,
        }],
        git: {
          session: {
            meta: { sessionId: "session-1", assetCount: 0 },
            activity: { recent: [] },
          },
          current: {
            focus: { status: "active", ref: "refs/heads/task/T-1", workId: "T-1" },
            task,
          },
        },
        run: { workState, toolCalls: largeToolCalls(50_000) },
      },
    });
    const sourceBefore = structuredClone(stateView);
    const onContextCompilation = vi.fn();
    const metrics = createRunMetrics();

    await callAgentDecision({
      provider,
      stateView,
      toolDefinitions: [],
      toolLoadingAvailable: false,
      toolContextProjectionPolicy: "enforce",
      onContextCompilation,
      metrics,
    });

    expect(countInputTokens).toHaveBeenCalledTimes(2);
    expect(generateTurn).toHaveBeenCalledTimes(1);
    expect(stateView).toEqual(sourceBefore);
    expect(onContextCompilation).toHaveBeenCalledWith(expect.objectContaining({
      mode: "tool_compact",
      candidateInputTokens: 101_000,
      finalInputTokens: 65_000,
      candidateHardLimitExceeded: true,
      targetReached: false,
      needsEscalation: false,
      admitted: true,
    }));
    expect(metrics.optimizationEvents.some((event) => event.kind === "context_budget_final")).toBe(true);
    expect(metrics.optimizationEvents.some((event) => event.kind === "tool_context_projection_enforced")).toBe(true);

    const sentUserPrompt = generateTurn.mock.calls[0]?.[0]?.messages
      .find((message: { role: string }) => message.role === "user")?.content;
    if (typeof sentUserPrompt !== "string") throw new Error("Expected a user prompt.");
    const sentState = parsePromptStateView(sentUserPrompt);
    const sentContext = sentState["context"] as {
      git: { current: { task: unknown } };
      run: { workState: unknown; toolCalls: Array<{ mode: string }> };
    };
    expect(sentContext.git.current.task).toEqual(task);
    expect(sentContext.run.workState).toEqual(workState);
    expect(sentContext.run.toolCalls.slice(0, 4).some((call) => call.mode !== "full")).toBe(true);
    expect(sentContext.run.toolCalls.slice(-6).every((call) => call.mode === "full")).toBe(true);
  });

  it("sheds low-value session context before touching the exact timeline", async () => {
    const generateTurn = vi.fn().mockResolvedValue({
      type: "assistant",
      content: JSON.stringify({ kind: "reply", status: "completed", message: "Continue" }),
    });
    const countInputTokens = vi.fn(async (turnInput: LlmTurnInput) => {
      const state = promptStateFromTurn(turnInput);
      const session = (state["context"] as {
        git: { session: { summary?: unknown; recentTaskRuns?: unknown[] } };
      }).git.session;
      return {
        provider: "fake-provider",
        model: "test-model",
        inputTokens: session.summary ? 85_000 : 65_000,
        exact: true,
      };
    });
    const provider: LlmProvider = {
      name: "fake-provider",
      version: "test-model",
      capabilities: { nativeToolCalling: true },
      start() {},
      stop() {},
      countInputTokens,
      generateTurn,
    };
    const workState = {
      status: "not_done" as const,
      openWork: ["Continue the protected task."],
      nextStep: "Take the next small step.",
    };
    const stateView = contextPressureState({
      timeline: [{
        kind: "user",
        seq: 11,
        timestamp: "2026-07-10T10:01:00.000Z",
        content: "Continue.",
        current: true,
      }],
      workState,
    });
    const sourceBefore = structuredClone(stateView);
    const onContextCompilation = vi.fn();

    await callAgentDecision({
      provider,
      stateView,
      toolDefinitions: [],
      toolContextProjectionPolicy: "enforce",
      onContextCompilation,
    });

    expect(stateView).toEqual(sourceBefore);
    expect(countInputTokens).toHaveBeenCalledTimes(2);
    expect(generateTurn).toHaveBeenCalledTimes(1);
    expect(onContextCompilation).toHaveBeenCalledWith(expect.objectContaining({
      mode: "session_shed",
      candidateInputTokens: 85_000,
      intermediateInputTokens: 85_000,
      finalInputTokens: 65_000,
      needsEscalation: false,
      sessionShedding: {
        removedSummary: true,
        removedCheckpointCount: 4,
        retainedCheckpointId: "checkpoint-5",
        removedActivityCount: 1,
        tokensBefore: 85_000,
        tokensAfter: 65_000,
      },
    }));

    const sentState = promptStateFromTurn(generateTurn.mock.calls[0]![0]);
    const sentContext = sentState["context"] as {
      timeline: unknown;
      git: {
        session: {
          summary?: unknown;
          recentTaskRuns?: Array<{ runId: string }>;
          attachments?: unknown;
          activity: { recent: unknown[] };
        };
        current: { task: unknown };
      };
      run: { workState: unknown };
    };
    expect(sentContext.git.session).not.toHaveProperty("summary");
    expect(sentContext.git.session.recentTaskRuns?.map((item) => item.runId)).toEqual(["run-5"]);
    expect(sentContext.git.session.activity.recent).toEqual([]);
    expect(sentContext.git.session.attachments).toEqual(
      stateView.context.git?.session.attachments,
    );
    expect(sentContext.timeline).toEqual(stateView.context.timeline);
    expect(sentContext.git.current.task).toEqual(protectedTaskContext());
    expect(sentContext.run.workState).toEqual(workState);
  });

  it("combines the latest task-run checkpoint with the old timeline prefix", async () => {
    const generateTurn = vi.fn(async (turnInput: LlmTurnInput): Promise<LlmTurnOutput> => {
      if (turnInput.responseFormat?.type === "json_schema") {
        return { type: "assistant", content: JSON.stringify(validTimelineCheckpointSummary(9)) };
      }
      return {
        type: "assistant",
        content: JSON.stringify({ kind: "reply", status: "completed", message: "Recovered" }),
      };
    });
    const countInputTokens = vi.fn(async (turnInput: LlmTurnInput) => {
      const state = promptStateFromTurn(turnInput);
      const context = state["context"] as {
        timeline: Array<{ kind: string }>;
        git: { session: { summary?: unknown } };
      };
      return {
        provider: "fake-provider",
        model: "test-model",
        inputTokens: context.timeline.some((event) => event.kind === "checkpoint")
          ? 55_000
          : context.git.session.summary
            ? 85_000
            : 75_000,
        exact: true,
      };
    });
    const provider: LlmProvider = {
      name: "fake-provider",
      version: "test-model",
      capabilities: {
        nativeToolCalling: true,
        structuredOutput: { jsonObject: true, jsonSchema: true },
      },
      start() {},
      stop() {},
      countInputTokens,
      generateTurn,
    };
    const workState = {
      status: "not_done" as const,
      verifiedFacts: ["The protected task is active."],
      nextStep: "Continue after recovery.",
    };
    const timeline = pressureTimelineAfterCheckpoint();
    const stateView = contextPressureState({ timeline, workState });
    const sourceBefore = structuredClone(stateView);
    const onContextCompilation = vi.fn();

    const decision = await callAgentDecision({
      provider,
      stateView,
      toolDefinitions: [],
      toolContextProjectionPolicy: "enforce",
      onContextCompilation,
    });

    expect(decision).toMatchObject({ kind: "reply", message: "Recovered" });
    expect(stateView).toEqual(sourceBefore);
    expect(countInputTokens).toHaveBeenCalledTimes(3);
    expect(onContextCompilation).toHaveBeenCalledWith(expect.objectContaining({
      mode: "timeline_checkpoint",
      candidateInputTokens: 85_000,
      intermediateInputTokens: 75_000,
      finalInputTokens: 55_000,
      sessionShedding: expect.objectContaining({
        retainedCheckpointId: "checkpoint-5",
      }),
    }));

    const checkpointInput = generateTurn.mock.calls.find((call) => call[0].responseFormat)?.[0];
    const checkpointSource = checkpointInput?.messages.find((message) => message.role === "user")?.content;
    if (typeof checkpointSource !== "string") throw new Error("Expected checkpoint source.");
    expect(checkpointSource).toContain('"previousTaskRunCheckpoint"');
    expect(checkpointSource).toContain('"runId": "run-5"');
    expect(checkpointSource).toContain('"seq": 11');

    const decisionInput = generateTurn.mock.calls.find((call) => !call[0].responseFormat)?.[0];
    if (!decisionInput) throw new Error("Expected final decision input.");
    const sentState = promptStateFromTurn(decisionInput);
    const sentContext = sentState["context"] as {
      timeline: Array<{ kind: string; seq: number; current?: true }>;
      git: {
        session: { summary?: unknown; recentTaskRuns?: unknown; activity: { recent: unknown[] } };
        current: { task: unknown };
      };
      run: { workState: unknown };
    };
    expect(sentContext.timeline[0]).toMatchObject({ kind: "checkpoint", seq: 11 });
    expect(sentContext.timeline.at(-1)).toEqual(timeline.at(-1));
    expect(sentContext.git.session).not.toHaveProperty("summary");
    expect(sentContext.git.session).not.toHaveProperty("recentTaskRuns");
    expect(sentContext.git.session.activity.recent).toEqual([]);
    expect(sentContext.git.current.task).toEqual(protectedTaskContext());
    expect(sentContext.run.workState).toEqual(workState);
  });

  it("ends recovery when the combined checkpoint remains above the soft limit", async () => {
    const generateTurn = vi.fn(async (turnInput: LlmTurnInput): Promise<LlmTurnOutput> => {
      if (!turnInput.responseFormat) throw new Error("A normal decision must not be requested.");
      return { type: "assistant", content: JSON.stringify(validTimelineCheckpointSummary(9)) };
    });
    const countInputTokens = vi.fn()
      .mockResolvedValueOnce({ provider: "fake-provider", model: "test-model", inputTokens: 85_000, exact: true })
      .mockResolvedValueOnce({ provider: "fake-provider", model: "test-model", inputTokens: 75_000, exact: true })
      .mockResolvedValueOnce({ provider: "fake-provider", model: "test-model", inputTokens: 72_000, exact: true });
    const provider: LlmProvider = {
      name: "fake-provider",
      version: "test-model",
      capabilities: {
        nativeToolCalling: true,
        structuredOutput: { jsonObject: true, jsonSchema: true },
      },
      start() {},
      stop() {},
      countInputTokens,
      generateTurn,
    };
    const onContextCompilation = vi.fn();

    await expect(callAgentDecision({
      provider,
      stateView: contextPressureState({ timeline: pressureTimelineAfterCheckpoint() }),
      toolDefinitions: [],
      toolContextProjectionPolicy: "enforce",
      onContextCompilation,
    })).rejects.toBeInstanceOf(ContextRunCapacityError);

    expect(generateTurn).toHaveBeenCalledTimes(1);
    expect(generateTurn.mock.calls[0]?.[0].responseFormat?.type).toBe("json_schema");
    expect(onContextCompilation).toHaveBeenCalledWith(expect.objectContaining({
      mode: "timeline_checkpoint",
      finalInputTokens: 72_000,
      recoveryExhausted: true,
      needsEscalation: true,
    }));
  });

  it("rejects an enforced projection when the measured final request remains over hard limit", async () => {
    const generateTurn = vi.fn();
    const countInputTokens = vi.fn()
      .mockResolvedValueOnce({ provider: "fake-provider", model: "test-model", inputTokens: 110_000, exact: true })
      .mockResolvedValueOnce({ provider: "fake-provider", model: "test-model", inputTokens: 105_000, exact: true });
    const provider: LlmProvider = {
      name: "fake-provider",
      version: "test-model",
      capabilities: { nativeToolCalling: true },
      start() {},
      stop() {},
      countInputTokens,
      generateTurn,
    };
    const onContextCompilation = vi.fn();

    await expect(callAgentDecision({
      provider,
      stateView: createStateView({
        context: {
          timeline: [{
            kind: "user",
            seq: 1,
            timestamp: "2026-07-10T00:00:00.000Z",
            content: "Continue",
            current: true,
          }],
          run: { toolCalls: largeToolCalls(50_000) },
        },
      }),
      toolDefinitions: [],
      toolContextProjectionPolicy: "enforce",
      onContextCompilation,
    })).rejects.toBeInstanceOf(ContextInputLimitError);

    expect(countInputTokens).toHaveBeenCalledTimes(2);
    expect(generateTurn).not.toHaveBeenCalled();
    expect(onContextCompilation).toHaveBeenCalledWith(expect.objectContaining({
      mode: "tool_compact",
      candidateInputTokens: 110_000,
      finalInputTokens: 105_000,
      admitted: false,
      hardLimitExceeded: true,
    }));
  });

  it("uses the enforced final request for streaming decisions", async () => {
    const streamTurn = vi.fn().mockResolvedValue({ type: "assistant", content: "Streamed" });
    const generateTurn = vi.fn();
    const provider: LlmProvider = {
      name: "fake-provider",
      version: "test-model",
      capabilities: { nativeToolCalling: true, streaming: true },
      start() {},
      stop() {},
      countInputTokens: vi.fn()
        .mockResolvedValueOnce({ provider: "fake-provider", model: "test-model", inputTokens: 101_000, exact: true })
        .mockResolvedValueOnce({ provider: "fake-provider", model: "test-model", inputTokens: 65_000, exact: true }),
      generateTurn,
      streamTurn,
    };

    await callAgentDecision({
      provider,
      stateView: createStateView({
        context: {
          timeline: [{
            kind: "user",
            seq: 1,
            timestamp: "2026-07-10T00:00:00.000Z",
            content: "Stream the response",
            current: true,
          }],
          run: { toolCalls: largeToolCalls(50_000) },
        },
      }),
      toolDefinitions: [],
      toolLoadingAvailable: false,
      toolContextProjectionPolicy: "enforce",
      onAssistantTextDelta: vi.fn(),
    });

    expect(generateTurn).not.toHaveBeenCalled();
    expect(streamTurn).toHaveBeenCalledTimes(1);
    const streamedPrompt = streamTurn.mock.calls[0]?.[0]?.messages
      .find((message: { role: string }) => message.role === "user")?.content;
    if (typeof streamedPrompt !== "string") throw new Error("Expected a streamed user prompt.");
    const streamedState = parsePromptStateView(streamedPrompt);
    const streamedCalls = (streamedState["context"] as { run: { toolCalls: Array<{ mode: string }> } }).run.toolCalls;
    expect(streamedCalls.slice(0, 4).some((call) => call.mode !== "full")).toBe(true);
    expect(streamedCalls.slice(-6).every((call) => call.mode === "full")).toBe(true);
  });

  it("includes repair messages when measuring an enforced final request", async () => {
    const generateTurn = vi.fn()
      .mockResolvedValueOnce({
        type: "assistant",
        content: "{\"kind\":\"act\",\"action\":{\"mode\":\"single\",\"allowedTools\":[\"read_files\"],\"calls\":[{\"id\":\"call-new\",\"t",
      })
      .mockResolvedValueOnce({
        type: "assistant",
        content: JSON.stringify({ kind: "reply", status: "completed", message: "Repaired" }),
      });
    const countInputTokens = vi.fn()
      .mockResolvedValueOnce({ provider: "fake-provider", model: "test-model", inputTokens: 101_000, exact: true })
      .mockResolvedValueOnce({ provider: "fake-provider", model: "test-model", inputTokens: 65_000, exact: true })
      .mockResolvedValueOnce({ provider: "fake-provider", model: "test-model", inputTokens: 102_000, exact: true })
      .mockResolvedValueOnce({ provider: "fake-provider", model: "test-model", inputTokens: 66_000, exact: true });
    const provider: LlmProvider = {
      name: "fake-provider",
      version: "test-model",
      capabilities: { nativeToolCalling: true },
      start() {},
      stop() {},
      countInputTokens,
      generateTurn,
    };

    await callAgentDecision({
      provider,
      stateView: createStateView({
        context: {
          timeline: [{
            kind: "user",
            seq: 1,
            timestamp: "2026-07-10T00:00:00.000Z",
            content: "Continue",
            current: true,
          }],
          run: { toolCalls: largeToolCalls(50_000) },
        },
      }),
      toolDefinitions: [createTool("read_files")],
      toolContextProjectionPolicy: "enforce",
    });

    expect(countInputTokens).toHaveBeenCalledTimes(4);
    const repairedFinalMessages = countInputTokens.mock.calls[3]?.[0]?.messages ?? [];
    expect(repairedFinalMessages.at(-1)?.content).toContain("Repair code: R_ASSISTANT_TEXT_TOOL_CALL");
    expect(repairedFinalMessages.at(-1)?.content).toContain("Do not write tool-call JSON in assistant text");
  });

  it("combines tool and timeline projection and reuses the checkpoint across a decision repair", async () => {
    let decisionCalls = 0;
    const generateTurn = vi.fn(async (turnInput: LlmTurnInput): Promise<LlmTurnOutput> => {
      if (turnInput.responseFormat?.type === "json_schema") {
        return { type: "assistant", content: JSON.stringify(validTimelineCheckpointSummary()) };
      }
      decisionCalls++;
      return decisionCalls === 1
        ? {
            type: "assistant",
            content: "{\"kind\":\"act\",\"action\":{\"mode\":\"single\",\"allowedTools\":[\"read_files\"],\"calls\":[{\"id\":\"call-new\",\"t",
          }
        : {
            type: "assistant",
            content: JSON.stringify({ kind: "reply", status: "completed", message: "Repaired" }),
          };
    });
    const countInputTokens = vi.fn(async (turnInput: LlmTurnInput) => {
      const userPrompt = turnInput.messages.find((message) => message.role === "user")?.content;
      if (typeof userPrompt !== "string") throw new Error("Expected a user prompt.");
      const state = parsePromptStateView(userPrompt);
      const context = state["context"] as {
        timeline: Array<{ kind: string }>;
        run: { toolCalls: Array<{ mode: string }> };
      };
      const hasCheckpoint = context.timeline.some((event) => event.kind === "checkpoint");
      const hasToolProjection = context.run.toolCalls.some((call) => call.mode !== "full");
      return {
        provider: "fake-provider",
        model: "test-model",
        inputTokens: hasCheckpoint ? 55_000 : hasToolProjection ? 75_000 : 85_000,
        exact: true,
      };
    });
    const provider: LlmProvider = {
      name: "fake-provider",
      version: "test-model",
      capabilities: {
        nativeToolCalling: true,
        structuredOutput: { jsonObject: true, jsonSchema: true },
      },
      start() {},
      stop() {},
      countInputTokens,
      generateTurn,
    };
    const workState = {
      status: "not_done" as const,
      blockers: [],
      verifiedFacts: ["Protected work state"],
      nextStep: "Continue after checkpointing.",
    };
    const stateView = createStateView({
      context: {
        timeline: pressureTimeline(),
        git: {
          session: { meta: { sessionId: "session-1", assetCount: 0 }, activity: { recent: [] } },
          current: {
            focus: { status: "active", ref: "refs/heads/task/T-1", workId: "T-1" },
            task: protectedTaskContext(),
          },
        },
        run: {
          workState,
          toolCalls: largeToolCalls(50_000),
          contextPressure: {
            mode: "tool_compact",
            recommendedMode: "timeline_checkpoint",
            escalationReason: "repeated_unresolved_pressure",
            unresolvedPressureStreak: 2,
            compactedCalls: 4,
            recoverable: true,
          },
        },
      },
    });
    const sourceBefore = structuredClone(stateView);
    const onContextCompilation = vi.fn();

    const decision = await callAgentDecision({
      provider,
      stateView,
      toolDefinitions: [createTool("read_files")],
      toolContextProjectionPolicy: "enforce",
      onContextCompilation,
    });

    expect(decision).toMatchObject({ kind: "reply", message: "Repaired" });
    expect(stateView).toEqual(sourceBefore);
    expect(countInputTokens).toHaveBeenCalledTimes(6);
    expect(generateTurn.mock.calls.filter((call) => call[0].responseFormat?.type === "json_schema")).toHaveLength(1);
    expect(onContextCompilation).toHaveBeenCalledTimes(2);
    expect(onContextCompilation.mock.calls[0]?.[0]).toMatchObject({
      mode: "timeline_checkpoint",
      candidateInputTokens: 85_000,
      intermediateInputTokens: 75_000,
      finalInputTokens: 55_000,
      timelineCheckpoint: { cacheStatus: "generated", generationAttempts: 1 },
      targetReached: true,
    });
    expect(onContextCompilation.mock.calls[1]?.[0]).toMatchObject({
      mode: "timeline_checkpoint",
      timelineCheckpoint: { cacheStatus: "success_hit", generationAttempts: 0 },
    });

    const finalDecisionInput = generateTurn.mock.calls.filter(
      (call) => !call[0].responseFormat,
    ).at(-1)?.[0];
    const finalUserPrompt = finalDecisionInput?.messages.find((message) => message.role === "user")?.content;
    if (typeof finalUserPrompt !== "string") throw new Error("Expected final decision prompt.");
    const sentState = parsePromptStateView(finalUserPrompt);
    const sentContext = sentState["context"] as {
      timeline: Array<{ kind: string; current?: true; content?: string }>;
      git: { current: { task: unknown } };
      run: {
        workState: unknown;
        toolCalls: Array<{ mode: string }>;
        contextPressure: { mode: string; recommendedMode?: string };
      };
    };
    expect(sentContext.timeline[0]?.kind).toBe("checkpoint");
    expect(sentContext.timeline.at(-1)).toMatchObject({
      kind: "user",
      content: pressureTimeline().at(-1)?.content,
      current: true,
    });
    expect(sentContext.git.current.task).toEqual(protectedTaskContext());
    expect(sentContext.run.workState).toEqual(workState);
    expect(sentContext.run.toolCalls.slice(0, 4).some((call) => call.mode !== "full")).toBe(true);
    expect(sentContext.run.toolCalls.slice(-6).every((call) => call.mode === "full")).toBe(true);
    expect(sentContext.run.contextPressure).toMatchObject({ mode: "timeline_checkpoint" });
    expect(sentContext.run.contextPressure).not.toHaveProperty("recommendedMode");
  });

  it("skips timeline generation when tool projection reaches the recovery target", async () => {
    const generateTurn = vi.fn(async (turnInput: LlmTurnInput): Promise<LlmTurnOutput> => {
      if (turnInput.responseFormat) throw new Error("Timeline checkpoint should not run.");
      return {
        type: "assistant",
        content: JSON.stringify({ kind: "reply", status: "completed", message: "Recovered" }),
      };
    });
    const countInputTokens = vi.fn()
      .mockResolvedValueOnce({ provider: "fake-provider", model: "test-model", inputTokens: 80_000, exact: true })
      .mockResolvedValueOnce({ provider: "fake-provider", model: "test-model", inputTokens: 58_000, exact: true });
    const provider: LlmProvider = {
      name: "fake-provider",
      version: "test-model",
      capabilities: { nativeToolCalling: true, structuredOutput: { jsonObject: true, jsonSchema: true } },
      start() {},
      stop() {},
      countInputTokens,
      generateTurn,
    };
    const state = checkpointRecommendedState(pressureTimeline());
    state.context.run = {
      ...state.context.run,
      toolCalls: largeToolCalls(50_000),
    };
    const onContextCompilation = vi.fn();

    await callAgentDecision({
      provider,
      stateView: state,
      toolDefinitions: [],
      toolContextProjectionPolicy: "enforce",
      onContextCompilation,
    });

    expect(countInputTokens).toHaveBeenCalledTimes(2);
    expect(generateTurn).toHaveBeenCalledTimes(1);
    expect(onContextCompilation).toHaveBeenCalledWith(expect.objectContaining({
      mode: "tool_compact",
      finalInputTokens: 58_000,
      targetReached: true,
    }));
  });

  it("ends context recovery when checkpoint generation fails above the soft limit", async () => {
    const generateTurn = vi.fn(async (turnInput: LlmTurnInput): Promise<LlmTurnOutput> => {
      return turnInput.responseFormat
        ? { type: "assistant", content: "invalid-checkpoint" }
        : { type: "assistant", content: JSON.stringify({ kind: "reply", status: "completed", message: "Fallback" }) };
    });
    const provider: LlmProvider = {
      name: "fake-provider",
      version: "test-model",
      capabilities: { nativeToolCalling: true, structuredOutput: { jsonObject: true, jsonSchema: true } },
      start() {},
      stop() {},
      countInputTokens: vi.fn().mockResolvedValue({
        provider: "fake-provider",
        model: "test-model",
        inputTokens: 80_000,
        exact: true,
      }),
      generateTurn,
    };
    const timeline = pressureTimeline();
    const onContextCompilation = vi.fn();

    await expect(callAgentDecision({
      provider,
      stateView: checkpointRecommendedState(timeline),
      toolDefinitions: [],
      toolContextProjectionPolicy: "enforce",
      onContextCompilation,
    })).rejects.toBeInstanceOf(ContextRunCapacityError);

    expect(generateTurn.mock.calls.filter((call) => call[0].responseFormat)).toHaveLength(2);
    expect(generateTurn.mock.calls.every((call) => call[0].responseFormat)).toBe(true);
    expect(onContextCompilation).toHaveBeenCalledWith(expect.objectContaining({
      mode: "full",
      admitted: true,
      needsEscalation: false,
      recoveryExhausted: true,
    }));
  });

  it("rejects before the decision call when checkpoint failure leaves the request over hard admission", async () => {
    const generateTurn = vi.fn(async (): Promise<LlmTurnOutput> => ({
      type: "assistant",
      content: "invalid-checkpoint",
    }));
    const provider: LlmProvider = {
      name: "fake-provider",
      version: "test-model",
      capabilities: { nativeToolCalling: true, structuredOutput: { jsonObject: true, jsonSchema: true } },
      start() {},
      stop() {},
      countInputTokens: vi.fn().mockResolvedValue({
        provider: "fake-provider",
        model: "test-model",
        inputTokens: 101_000,
        exact: true,
      }),
      generateTurn,
    };

    await expect(callAgentDecision({
      provider,
      stateView: checkpointRecommendedState(pressureTimeline()),
      toolDefinitions: [],
      toolContextProjectionPolicy: "enforce",
    })).rejects.toBeInstanceOf(ContextInputLimitError);

    expect(generateTurn).toHaveBeenCalledTimes(2);
    expect(generateTurn.mock.calls.every((call) => call[0].responseFormat?.type === "json_schema")).toBe(true);
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
            active: ["read_files"],
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
            toolNames: ["read_files"],
            groups: ["filesystem"],
          },
          loaded: ["read_files"],
          alreadyActive: [],
          evicted: [],
          missing: [],
          message: "Loaded read_files.",
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
          active: ["read_files"],
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
      tool: "git_context_create_task",
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
          tool: "git_context_create_task",
          input: {
            title: "Linux commands file",
            objective: "Create a text file with 10 Linux commands.",
            reason: "The user requested durable file creation.",
          },
          dependsOn: [],
          purpose: "Create and activate the task for the requested Linux commands file.",
        }],
        allowedTools: ["git_context_create_task"],
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
      toolDefinitions: [createTool("git_context_create_task")],
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
    expect(repairPrompt).toContain("Blocked targets: git_context_create_task");
    expect(repairPrompt).toContain("Do not write tool-call JSON in assistant text");
    expect(feedback.events.some((event) => event.event === "direct_reply")).toBe(false);
    expect(feedback.events.find((event) => event.event === "assistant_text_tool_call")?.data).toMatchObject({
      toolName: "git_context_create_task",
      selectedTools: ["git_context_create_task"],
      repair: {
        code: "R_ASSISTANT_TEXT_TOOL_CALL",
        blockedTargets: ["git_context_create_task"],
        operatorDetails: {
          attempt: 1,
          toolName: "git_context_create_task",
          inputKeys: ["taskCompletion"],
          selectedTools: ["git_context_create_task"],
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
            purpose: "Create the requested line-counting script.",
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
      tool: "git_context_create_task",
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
      toolDefinitions: [createTool("git_context_create_task")],
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
            purpose: "Inspect the current working directory.",
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

  it("repairs executable decisions that omit the call purpose", async () => {
    const action = (purpose?: string) => JSON.stringify({
      kind: "act",
      action: {
        mode: "single",
        calls: [{
          id: "call_1",
          tool: "shell",
          input: { command: "pwd" },
          dependsOn: [],
          ...(purpose ? { purpose } : {}),
        }],
        allowedTools: ["shell"],
      },
    });
    const { provider, generateTurn } = createProvider([
      action(),
      action("Inspect the current working directory."),
    ]);

    const decision = await callAgentDecision({
      provider,
      stateView: createStateView(),
      toolDefinitions: [createTool("shell")],
    });

    expect(generateTurn).toHaveBeenCalledTimes(2);
    expect(decision).toMatchObject({
      kind: "act",
      action: { calls: [{ purpose: "Inspect the current working directory." }] },
    });
    expect(generateTurn.mock.calls[1]?.[0]?.messages.at(-1)?.content).toContain("requires a specific purpose");
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

  it("keeps callable schemas native and sends only selected tool names in text", async () => {
    const { provider, generateTurn } = createProvider([
      JSON.stringify({ kind: "reply", status: "completed", message: "Done" }),
    ]);
    const selectedTool: ToolDefinition = {
      name: "inspect_data",
      description: "Inspect structured data with a unique schema description.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "UNIQUE_INPUT_SCHEMA_MARKER" },
        },
      },
      outputSchema: {
        type: "object",
        properties: {
          rows: { type: "array", description: "UNIQUE_OUTPUT_SCHEMA_MARKER" },
        },
      },
      annotations: { domain: "database" },
      selectionHints: { tags: ["UNIQUE_SELECTION_HINT_MARKER"] },
      async execute() {
        return { ok: true, output: "" };
      },
    };

    await callAgentDecision({
      provider,
      stateView: createStateView(),
      toolDefinitions: [selectedTool],
    });

    const turnInput = generateTurn.mock.calls[0]?.[0];
    const userPrompt = turnInput?.messages.find((message) => message.role === "user")?.content;
    if (typeof userPrompt !== "string") throw new Error("Expected a user prompt.");
    expect(userPrompt).toContain("Selected tools:\n- inspect_data");
    expect(userPrompt).not.toContain("UNIQUE_INPUT_SCHEMA_MARKER");
    expect(userPrompt).not.toContain("UNIQUE_OUTPUT_SCHEMA_MARKER");
    expect(userPrompt).not.toContain("UNIQUE_SELECTION_HINT_MARKER");
    expect(userPrompt).not.toContain("annotations=");
    expect(userPrompt).not.toContain("inputSchema=");
    expect(userPrompt).not.toContain("outputSchema=");
    expect(userPrompt).not.toContain("hints=");

    const nativeTool = turnInput?.tools?.find((tool) => tool.name === "inspect_data");
    expect(nativeTool?.description).toBe(selectedTool.description);
    expect(nativeTool?.inputSchema).toMatchObject({
      properties: {
        query: { description: "UNIQUE_INPUT_SCHEMA_MARKER" },
      },
    });
    expect((nativeTool?.inputSchema.properties as Record<string, unknown>)["taskCompletion"]).toBeUndefined();
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
      required: ["files", "purpose"],
      properties: {
        files: { type: "array" },
        purpose: { type: "string", maxLength: 240 },
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
            purpose: "Create the main website page.",
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
        purpose: "Create the main website page.",
      }],
    });
  });

  it("exposes and parses task_completion only when enabled", async () => {
    const { provider, generateTurn } = createNativeToolProvider([{
      type: "tool_calls",
      calls: [{
        id: "complete_1",
        name: "task_completion",
        input: {
          summary: "Created the requested website files.",
          assets: [{ path: "index.html", kind: "file", description: "Main website page" }],
        },
      }],
    }]);

    const decision = await callAgentDecision({
      provider,
      stateView: createStateView(),
      toolDefinitions: [],
      taskCompletionAvailable: true,
    });

    expect(generateTurn.mock.calls[0]?.[0]?.tools?.map((tool) => tool.name)).toContain("task_completion");
    expect(decision).toEqual({
      kind: "task_completion",
      request: {
        summary: "Created the requested website files.",
        assets: [{ path: "index.html", kind: "file", description: "Main website page" }],
      },
      workingNotes: undefined,
    });
  });

  it("repairs selected native executable calls with invalid input", async () => {
    const { provider, generateTurn } = createNativeToolProvider([
      {
        type: "tool_calls",
        calls: [{
          id: "call_1",
          name: "write_files",
          input: { purpose: "Create the main website page." },
        }],
      },
      {
        type: "tool_calls",
        calls: [{
          id: "call_1",
          name: "write_files",
          input: {
            files: [{ path: "site/index.html", content: "ok" }],
            purpose: "Create the main website page.",
          },
        }],
      },
    ]);
    const feedback = createFeedbackLedger();
    const metrics = createRunMetrics();

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
      metrics,
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
    const budgetEvents = metrics.optimizationEvents.filter((event) => event.kind === "context_budget");
    expect(budgetEvents).toHaveLength(2);
    expect(budgetEvents[1]?.data["measuredInputTokens"]).toBeGreaterThan(
      Number(budgetEvents[0]?.data["measuredInputTokens"]),
    );
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

function promptStateFromTurn(turnInput: LlmTurnInput): Record<string, unknown> {
  const userPrompt = turnInput.messages.find((message) => message.role === "user")?.content;
  if (typeof userPrompt !== "string") throw new Error("Expected a user prompt.");
  return parsePromptStateView(userPrompt);
}

function largeToolCalls(outputChars: number) {
  return Array.from({ length: 10 }, (_, index) => ({
    step: index + 1,
    callId: `call-${index + 1}`,
    tool: "read_files",
    input: { path: `src/file-${index + 1}.ts` },
    status: "success" as const,
    retention: "next_step" as const,
    mode: "full" as const,
    output: "x".repeat(outputChars),
    projectionMetadata: { filePath: `src/file-${index + 1}.ts`, lineCount: 1_000 },
    stepRef: { runId: "run-1", step: index + 1, callId: `call-${index + 1}` },
  }));
}

function pressureTimeline() {
  return Array.from({ length: 8 }, (_, index) => ({
    kind: index === 7 || index % 2 === 0 ? "user" as const : "assistant" as const,
    seq: index + 1,
    timestamp: `2026-07-10T00:00:${String(index).padStart(2, "0")}.000Z`,
    content: index === 7 ? `current:${"c".repeat(70_000)}` : `${index + 1}:${"t".repeat(70_000)}`,
    ...(index === 7 ? { current: true as const } : {}),
  }));
}

function pressureTimelineAfterCheckpoint() {
  return pressureTimeline().map((event) => ({
    ...event,
    seq: event.seq + 10,
  }));
}

function contextPressureState(input: {
  timeline: AgentStateView["context"]["timeline"];
  workState?: NonNullable<AgentStateView["context"]["run"]>["workState"];
}): AgentStateView {
  return createStateView({
    context: {
      timeline: input.timeline,
      git: {
        session: {
          meta: { sessionId: "session-1", assetCount: 1 },
          summary: { text: "Structured session snapshot.", coveredUntilSeq: 8 },
          recentTaskRuns: Array.from({ length: 5 }, (_, index) => taskRunCheckpoint(index + 1)),
          attachments: { count: 1, recent: [] },
          activity: {
            recent: [{
              seq: 10,
              type: "run_committed",
              at: "2026-07-10T10:00:00.000Z",
              runId: "run-5",
              workId: "work-5",
              commit: "commit-5",
            }],
          },
        },
        current: {
          focus: { status: "active", ref: "refs/heads/task/T-1", workId: "T-1" },
          task: protectedTaskContext(),
        },
      },
      ...(input.workState ? { run: { workState: input.workState } } : {}),
    },
  });
}

function taskRunCheckpoint(sequence: number) {
  const fromSeq = sequence * 2 - 1;
  return {
    checkpointId: `checkpoint-${sequence}`,
    commit: `commit-${sequence}`,
    workId: `work-${sequence}`,
    runId: `run-${sequence}`,
    status: "completed" as const,
    fromSeq,
    toSeq: fromSeq + 1,
    sourceHash: String(sequence).repeat(64),
    strategy: "llm" as const,
    at: `2026-07-10T09:0${sequence}:00.000Z`,
    summary: sequence === 5
      ? `Task-run checkpoint ${sequence}: ${"x".repeat(300_000)}`
      : `Task-run checkpoint ${sequence}.`,
  };
}

function checkpointRecommendedState(timeline: ReturnType<typeof pressureTimeline>): AgentStateView {
  return createStateView({
    context: {
      timeline,
      run: {
        contextPressure: {
          mode: "tool_compact",
          recommendedMode: "timeline_checkpoint",
          escalationReason: "repeated_unresolved_pressure",
          unresolvedPressureStreak: 2,
          compactedCalls: 0,
          recoverable: true,
        },
      },
    },
  });
}

function validTimelineCheckpointSummary(seq = 1) {
  return {
    userRequests: [{ seq, text: "Preserve the original request." }],
    constraints: [],
    decisions: [],
    corrections: [],
    importantFacts: [],
    unresolvedQuestions: [],
    references: [],
    narrative: "The user provided the original request.",
  };
}

function protectedTaskContext() {
  return {
    identity: {
      ref: "refs/heads/task/T-1",
      title: "Protected task",
      objective: "Preserve task context during tool projection.",
      workId: "T-1",
    },
    state: {
      status: "active",
      completed: ["Measured the candidate."],
      open: ["Enforce the tool projection."],
      blockers: [],
      facts: [{ text: "Task state is protected." }],
      next: "Measure the final request.",
    },
    assets: [{ path: "src/context.ts", kind: "file" }],
    activity: {
      recentRuns: [],
      recentEvidence: [],
    },
  };
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
