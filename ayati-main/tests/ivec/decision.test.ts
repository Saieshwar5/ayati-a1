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
import { callAgentDecision } from "../../src/ivec/agent-runner/decision.js";
import type { AgentFeedbackEventInput, AgentFeedbackLedger } from "../../src/ivec/feedback-ledger.js";
import type { AgentStateView } from "../../src/ivec/agent-runner/state-view.js";
import { buildCoreCapsule } from "../../src/ivec/agent-runner/core-capsule.js";
import type { AgentTemporalEvent } from "../../src/ivec/agent-runner/agent-context-events.js";
import { MODE_TRANSITION_CONTROL_TOOL_NAMES } from "../../src/ivec/agent-runner/mode-transition-controls.js";
import { createRunMetrics } from "../../src/ivec/metrics.js";
import type { ToolDefinition } from "../../src/skills/types.js";
import { nativeDecisionFixture } from "./native-decision-fixture.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("callAgentDecision", () => {
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

  it("sends recent workstream metadata only after its Hot Context entry is loaded", async () => {
    const { provider, generateTurn } = createProvider([
      "I created index.html and styles.css.",
    ]);
    const content = JSON.stringify({
      schemaVersion: 1,
      workstreams: [{
        workstreamId: "W-20260714-0001",
        title: "Website implementation",
        lifecycleStatus: "active",
        repositoryHealth: "ready",
        lastActivity: {
          kind: "bound",
          at: "2026-07-14T10:30:00.000Z",
        },
      }],
    });

    await callAgentDecision({
      provider,
      stateView: createStateView({
        context: {
          hot: {
            available: [],
            loaded: [{
              key: "workstreams.recent",
              description: "Recently used workstreams.",
              version: "sha256:test",
              estimatedTokens: 40,
              freshness: "current",
              sourceRefs: ["workstream-catalog:recent"],
              content,
              mountedAtStep: 1,
            }],
            budget: {
              maxMountedTokens: 8_000,
              mountedTokens: 40,
            },
          },
        },
      }),
      toolDefinitions: [],
    });

    const sentState = promptStateFromTurn(generateTurn.mock.calls[0]![0]);
    const sentContext = sentState["context"] as {
      hot: { loaded: Array<{ key: string; content: string }> };
    };
    expect(sentContext).not.toHaveProperty("work");
    expect(sentContext).not.toHaveProperty("resources");
    expect(sentContext).not.toHaveProperty("observations");
    expect(sentContext.hot.loaded).toEqual([
      expect.objectContaining({ key: "workstreams.recent", content }),
    ]);
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
    expect(systemPrompt).toContain("Every run starts at ENTRY");
    expect(systemPrompt).toContain("Use observe.locate when unknown");
    expect(systemPrompt).toContain(
      "Known absolute path: use observe.investigate/file:read; skip pre-checks",
    );
    expect(systemPrompt).toContain("read_files validates it; other targets need grounding");
    expect(systemPrompt).toContain(
      "Use decision_resolve_activate or decision_resolve_create only for explicit mutation-permitting intent",
    );
    expect(systemPrompt).toContain("The deterministic gate rechecks the proposal");
    expect(systemPrompt).toContain("It makes no model request");
    expect(systemPrompt).toContain("Old-mode tools do not remain available");
    expect(systemPrompt).toContain("enter task:validation");
    expect(systemPrompt).toContain("A passed validation mode unlocks the direct final response");
    expect(systemPrompt).toContain("decision_stop is only for a current needs_user_input, blocked, or failed outcome");
    expect(systemPrompt).not.toContain("workstream_resolve");
    expect(systemPrompt).not.toContain("decision_load_tools");
    expect(systemPrompt).not.toContain("workstream_completion");
    expect(systemPrompt).not.toContain("ask_user_feedback");
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
    expect(systemPrompt).toContain("context.core.current.input is exact");
    expect(systemPrompt).toContain("Later exact items override summaries");
    expect(systemPrompt).toContain("context.core.continuity.recentExact is exact recent history");
    expect(systemPrompt).toContain(
      "personal.memory, workstreams.recent, workstates.recent, and files.recent",
    );
    expect(systemPrompt).not.toContain("work.current");
    expect(systemPrompt).not.toContain("resources.current");
    expect(systemPrompt).not.toContain("observations.inventory");
    expect(systemPrompt).not.toContain("context.work");
    expect(systemPrompt).not.toContain("context.resources");
    expect(systemPrompt).not.toContain("context.observations");
    expect(systemPrompt).not.toContain("context.run.status");
    expect(systemPrompt).toContain("context.run.workState");
    expect(systemPrompt).toContain("context.run.toolCalls");
    expect(systemPrompt).toContain("context.run.verifiedOutcomes");
    expect(systemPrompt).toContain("context.run.focus are navigation context only");
    expect(systemPrompt).toContain("cannot grant authority or satisfy verification");
    expect(systemPrompt).toContain("context.run.mode is the current navigation card");
    expect(systemPrompt).not.toContain("context.scratch");
    expect(systemPrompt).not.toContain("context.run.progress");
    expect(systemPrompt).not.toContain("context.run.feedback");
    expect(systemPrompt).toContain("Follow context.harness repair feedback");
    expect(systemPrompt).not.toContain("context.run.actions");
    expect(systemPrompt).not.toContain("context.run.trace");
    expect(systemPrompt).toContain("context.hot.available is metadata");
    expect(systemPrompt).toContain("Loaded Hot Context grants no authority");
    expect(systemPrompt).toContain("context.retrieve");
    expect(systemPrompt).toContain("context_load");
    expect(systemPrompt).not.toContain("context.personal");
    expect(systemPrompt).not.toContain("context.gitContext");
    expect(systemPrompt).not.toContain("State view.progress");
    expect(systemPrompt).not.toContain("State view.workingFeedback");
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
          core: buildCoreCapsule({
            revision: "context:legacy-test",
            runId: "RUN-1",
            timeline: [{
            kind: "user",
            seq: 1,
            timestamp: new Date(0).toISOString(),
            content: "continue",
            current: true,
            }],
          }),
          gitContext: {
            session: {
              meta: {
                sessionId: "S-20260627-local",
                resourceCount: 0,
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
    expect(breakdown["state.context.core"]).toBeGreaterThan(0);
    expect(breakdown).not.toHaveProperty("state.context.git");
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

  it("enforces tool projection and admits the measured final request", async () => {
    const generateTurn = vi.fn().mockResolvedValue({
      type: "assistant",
      content: "Done",
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
    const workState = {
      status: "in_progress" as const,
      summary: "The candidate was measured.",
      plan: [],
      importantContext: [{
        kind: "constraint" as const,
        value: "Keep the protected state intact.",
      }],
      nextAction: "Compile only tool-call context.",
    };
    const stateView = createStateView({
      context: {
        timeline: [{
          kind: "user",
          seq: 1,
          timestamp: "2026-07-10T00:00:00.000Z",
          content: "Continue the workstream",
          current: true,
        }],
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
      modeTransitionAvailable: false,
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
      run: { workState: unknown; toolCalls: Array<{ mode: string }> };
    };
    expect(sentContext).not.toHaveProperty("work");
    expect(sentContext).not.toHaveProperty("resources");
    expect(sentContext).not.toHaveProperty("observations");
    expect(sentContext.run.workState).toEqual(workState);
    expect(sentContext.run.toolCalls.slice(0, 4).some((call) => call.mode !== "full")).toBe(true);
    expect(sentContext.run.toolCalls.slice(-6).every((call) => call.mode === "full")).toBe(true);
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
      modeTransitionAvailable: false,
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
        content: "Repaired",
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

  it("skips stream checkpointing when tool projection reaches the recovery target", async () => {
    const generateTurn = vi.fn(async (turnInput: LlmTurnInput): Promise<LlmTurnOutput> => {
      if (turnInput.responseFormat) throw new Error("Stream checkpoint should not run.");
      return {
        type: "assistant",
        content: "Recovered",
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

  it("sends only the model-facing context lanes to the prompt", async () => {
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
                resourceCount: 0,
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
            workState: {
              status: "in_progress",
              summary: "Work in progress.",
              plan: [],
              importantContext: [],
            },
          },
          hot: {
            available: [],
            loaded: [{
              key: "personal.memory",
              description: "Stable personal facts and preferences learned about the user.",
              version: "test",
              estimatedTokens: 4,
              freshness: "current",
              sourceRefs: ["personal-memory:snapshot"],
              content: "Prefer concise answers.",
              mountedAtStep: 1,
            }],
            budget: {
              maxMountedTokens: 8_000,
              mountedTokens: 4,
            },
          },
        },
        progress: {
          status: "in_progress",
          summary: "Work in progress.",
          plan: [],
          importantContext: [],
        },
        workingFeedback: {
          latest: [{
            severity: "warning",
            source: "tool_validation",
            message: "Fix the next call.",
          }],
        },
        capabilitySurface: {
          status: "partial",
          requested: ["file:read"],
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
    expect(promptStateView.context).toMatchObject({
      core: expect.objectContaining({
        current: expect.objectContaining({
          input: expect.objectContaining({
            kind: "user",
            seq: 1,
            content: "continue",
            current: true,
          }),
        }),
      }),
      tools: { active: ["read_files"] },
      harness: {
        feedback: {
          latest: [{
            severity: "warning",
            source: "tool_validation",
            message: "Fix the next call.",
          }],
        },
      },
      hot: {
        loaded: [expect.objectContaining({
          key: "personal.memory",
          content: "Prefer concise answers.",
        })],
      },
    });
    expect(promptStateView.context).not.toHaveProperty("work");
    expect(promptStateView.context).not.toHaveProperty("resources");
    expect(promptStateView.context).not.toHaveProperty("observations");
    expect(promptStateView).not.toHaveProperty("progress");
    expect(promptStateView).not.toHaveProperty("workingFeedback");
    expect(promptStateView).not.toHaveProperty("capabilitySurface");
    expect(promptStateView).not.toHaveProperty("observations");
    expect(promptStateView).not.toHaveProperty("trace");
    expect(promptStateView.context).not.toHaveProperty("git");
    expect(promptStateView.context).not.toHaveProperty("gitContext");
    expect(promptStateView.context).not.toHaveProperty("personalMemorySnapshot");
    expect(promptStateView.context).not.toHaveProperty("scratch");
  });

  it("repairs multiple native tool calls into one mode transition", async () => {
    const badAction = {
      kind: "act",
      action: {
        mode: "sequential",
        calls: [
          {
            id: "call_1",
            tool: "process_run",
            input: { command: "pwd" },
            dependsOn: [],
          },
          {
            id: "call_2",
            tool: "decision_enter_observe_investigate",
            input: {
              purpose: "Inspect the project.",
              capabilities: ["file:read"],
              references: [{ kind: "filesystem", value: "/tmp/project" }],
            },
            dependsOn: [],
          },
        ],
        allowedTools: ["process_run", "decision_enter_observe_investigate"],
      },
    };
    const repaired = {
      kind: "transition_mode",
      request: {
        to: "observe.investigate",
        purpose: "Inspect the project before continuing.",
        capabilities: ["file:read"],
        references: [{ kind: "filesystem", path: "/tmp/project" }],
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

    expect(decision.kind).toBe("transition_mode");
    expect(generateTurn).toHaveBeenCalledTimes(2);
    const repairMessages = generateTurn.mock.calls[1]?.[0]?.messages ?? [];
    const repairPrompt = repairMessages.at(-1)?.content;
    expect(repairPrompt).toContain("Repair code: R_MULTIPLE_NATIVE_TOOL_CALLS");
    expect(feedback.events.find((event) => event.event === "parse_failed")?.data).toMatchObject({
      repair: {
        code: "R_MULTIPLE_NATIVE_TOOL_CALLS",
      },
    });
  });

  it("returns a clean failed decision when native decision repair also fails", async () => {
    const invalid = JSON.stringify({
      kind: "act",
      action: {
        mode: "sequential",
        calls: [
          { id: "call_1", tool: "process_run", input: { command: "pwd" }, dependsOn: [] },
          { id: "call_2", tool: "read_files", input: { files: [] }, dependsOn: [] },
        ],
        allowedTools: ["process_run", "read_files"],
      },
    });
    const feedback = createFeedbackLedger();
    const { provider, generateTurn } = createProvider([invalid, invalid]);

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
    expect(decision).toEqual({
      kind: "reply",
      status: "failed",
      message: "I could not form a valid tool call for this request.",
    });
    expect(feedback.events.filter((event) => event.event === "parse_failed")).toHaveLength(2);
    expect(feedback.events.at(-1)?.event).toBe("failed_fallback");
  });

  it("repairs tool-call JSON returned as assistant text", async () => {
    const fakeToolJson = JSON.stringify({
      tool: "git_context_create_workstream",
      arguments: {
        taskCompletion: {
          intent: "not_completion",
          reason: "Create a workstream for the user's Linux commands file",
        },
      },
    });
    const repaired = {
      kind: "act",
      action: {
        mode: "single",
        calls: [{
          id: "call_1",
          tool: "git_context_create_workstream",
          input: {
            title: "Linux commands file",
            objective: "Create a text file with 10 Linux commands.",
            reason: "The user requested durable file creation.",
          },
          dependsOn: [],
          purpose: "Create and activate the workstream for the requested Linux commands file.",
        }],
        allowedTools: ["git_context_create_workstream"],
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
      toolDefinitions: [createTool("git_context_create_workstream")],
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
    expect(repairPrompt).toContain("Blocked targets: git_context_create_workstream");
    expect(repairPrompt).toContain("Do not write tool-call JSON in assistant text");
    expect(feedback.events.some((event) => event.event === "direct_reply")).toBe(false);
    expect(feedback.events.find((event) => event.event === "assistant_text_tool_call")?.data).toMatchObject({
      toolName: "git_context_create_workstream",
      selectedTools: ["git_context_create_workstream"],
      repair: {
        code: "R_ASSISTANT_TEXT_TOOL_CALL",
        blockedTargets: ["git_context_create_workstream"],
        operatorDetails: {
          attempt: 1,
          toolName: "git_context_create_workstream",
          inputKeys: ["taskCompletion"],
          selectedTools: ["git_context_create_workstream"],
        },
      },
    });
    expect(feedback.events.find((event) => event.event === "repair_requested")?.data).toMatchObject({
      repair: {
        code: "R_ASSISTANT_TEXT_TOOL_CALL",
      },
    });
  });

  it("repairs bare native-control arguments returned as assistant text", async () => {
    const bareControlInput = JSON.stringify({
      purpose: "Read the exact report before answering.",
      capabilities: ["file:read"],
      references: [{
        kind: "filesystem",
        path: "/tmp/project/report.txt",
      }],
    });
    const feedback = createFeedbackLedger();
    const { provider, generateTurn } = createNativeToolProvider([
      {
        type: "assistant",
        content: bareControlInput,
      },
      {
        type: "tool_calls",
        calls: [{
          id: "call-investigate",
          name: "decision_enter_observe_investigate",
          input: {
            purpose: "Read the exact report before answering.",
            capabilities: ["file:read"],
            references: [{
              kind: "filesystem",
              value: "/tmp/project/report.txt",
            }],
          },
        }],
      },
    ]);

    const decision = await callAgentDecision({
      provider,
      stateView: createStateView(),
      toolDefinitions: [],
      feedbackLedger: feedback.ledger,
      feedbackContext: {
        clientId: "local",
        sessionId: "S-test",
        seq: 2,
      },
    });

    expect(decision).toMatchObject({
      kind: "transition_mode",
      request: {
        to: "observe.investigate",
        purpose: "Read the exact report before answering.",
        capabilities: ["file:read"],
        references: [{
          kind: "filesystem",
          path: "/tmp/project/report.txt",
        }],
      },
    });
    expect(generateTurn).toHaveBeenCalledTimes(2);
    const repairPrompt = generateTurn.mock.calls[1]?.[0]?.messages.at(-1)?.content ?? "";
    expect(repairPrompt).toContain("Repair code: R_ASSISTANT_TEXT_TOOL_CALL");
    expect(repairPrompt).toContain(
      "Blocked targets: decision_enter_observe_investigate",
    );
    expect(feedback.events.some((event) => event.event === "direct_reply")).toBe(false);
    expect(
      feedback.events.find((event) => event.event === "assistant_text_tool_call")?.data,
    ).toMatchObject({
      toolName: "decision_enter_observe_investigate",
      inputKeys: ["purpose", "capabilities", "references"],
      repair: {
        code: "R_ASSISTANT_TEXT_TOOL_CALL",
        blockedTargets: ["decision_enter_observe_investigate"],
      },
    });
  });

  it("keeps ordinary JSON assistant replies that do not match a native control", async () => {
    const response = JSON.stringify({
      coordinator: "Dr. Nila Voss",
      emergencyCode: "SILVER-MOSS-42",
    });
    const { provider, generateTurn } = createNativeToolProvider([{
      type: "assistant",
      content: response,
    }]);

    const decision = await callAgentDecision({
      provider,
      stateView: createStateView(),
      toolDefinitions: [],
    });

    expect(generateTurn).toHaveBeenCalledTimes(1);
    expect(decision).toEqual({
      kind: "reply",
      status: "completed",
      message: response,
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
      tool: "git_context_create_workstream",
      arguments: {
        taskCompletion: {
          intent: "not_completion",
          reason: "Create a workstream for the user request",
        },
      },
    });
    const { provider, generateTurn } = createProvider([fakeToolJson, fakeToolJson, fakeToolJson]);

    const decision = await callAgentDecision({
      provider,
      stateView: createStateView(),
      toolDefinitions: [createTool("git_context_create_workstream")],
    });

    expect(generateTurn).toHaveBeenCalledTimes(3);
    expect(decision).toEqual({
      kind: "reply",
      status: "failed",
      message: "I could not form a valid tool call for this request.",
    });
  });

  it("does not infer binding or replay state from a selected executable call", async () => {
    const action = JSON.stringify({
      kind: "act",
      action: {
        mode: "single",
        calls: [{
          id: "call_1",
          tool: "process_run",
          input: { command: "pwd" },
          dependsOn: [],
          purpose: "Inspect the selected project directory.",
        }],
        allowedTools: ["process_run"],
      },
    });
    const { provider, generateTurn } = createProvider([action]);

    const decision = await callAgentDecision({
      provider,
      stateView: createStateView(),
      toolDefinitions: [createTool("process_run")],
    });

    expect(generateTurn).toHaveBeenCalledTimes(1);
    expect(decision).toMatchObject({
      kind: "act",
      action: { calls: [{ tool: "process_run", purpose: "Inspect the selected project directory." }] },
    });
  });

  it("repairs an unselected mutation tool into an explicit mode transition", async () => {
    const badAction = {
      kind: "act",
      action: {
        mode: "single",
        calls: [{
          id: "call_1",
          tool: "process_run",
          input: { command: "pwd" },
          dependsOn: [],
          purpose: "Inspect the selected project directory.",
        }],
        allowedTools: ["process_run"],
      },
    };
    const feedback = createFeedbackLedger();
    const binding = {
      kind: "create",
      title: "Project command",
      objective: "Bind the project before executing its command.",
      initialRequest: {
        title: "Run project command",
        request: "Run the requested command in the project.",
        acceptance: ["The requested command completes."],
        constraints: [],
      },
      resources: [],
      evidence: ["run:RUN-1:step:1:call:find-owner"],
    };
    const { provider, generateTurn } = createProvider([
      JSON.stringify(badAction),
      JSON.stringify({
        kind: "transition_mode",
        request: {
          to: "resolve",
          purpose: "Bind the project before executing a command.",
          capabilities: ["process:command"],
          targets: ["/tmp/project"],
          binding,
        },
      }),
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

    expect(generateTurn).toHaveBeenCalledTimes(2);
    expect(decision).toEqual({
      kind: "transition_mode",
      request: {
        to: "resolve",
        purpose: "Bind the project before executing a command.",
        capabilities: ["process:command"],
        mutationScopes: [{ kind: "filesystem", path: "/tmp/project" }],
        binding,
      },
      workingNotes: undefined,
    });
    expect(feedback.events.find((event) => event.event === "protocol_violation")?.data)
      .toMatchObject({
        invalidTools: ["process_run"],
        repair: { code: "R_TOOL_NOT_SELECTED" },
      });
  });

  it("reports an invalid tool purpose as a purpose repair", async () => {
    const withoutPurpose = {
      kind: "act",
      action: {
        mode: "single",
        calls: [{
          id: "call_1",
          tool: "process_run",
          input: { command: "pwd" },
          dependsOn: [],
        }],
        allowedTools: ["process_run"],
      },
    };
    const withPurpose = {
      ...withoutPurpose,
      action: {
        ...withoutPurpose.action,
        calls: [{
          ...withoutPurpose.action.calls[0],
          purpose: "Inspect the selected project directory.",
        }],
      },
    };
    const feedback = createFeedbackLedger();
    const { provider, generateTurn } = createProvider([
      JSON.stringify(withoutPurpose),
      JSON.stringify(withPurpose),
    ]);

    const decision = await callAgentDecision({
      provider,
      stateView: createStateView(),
      toolDefinitions: [createTool("process_run")],
      feedbackLedger: feedback.ledger,
      feedbackContext: {
        clientId: "local",
        sessionId: "S-test",
        seq: 1,
      },
    });

    expect(decision).toMatchObject({
      kind: "act",
      action: {
        calls: [{
          tool: "process_run",
          purpose: "Inspect the selected project directory.",
        }],
      },
    });
    expect(generateTurn.mock.calls[1]?.[0]?.messages.at(-1)?.content)
      .toContain("Repair code: R_TOOL_PURPOSE_INVALID");
    expect(feedback.events.find((event) => event.event === "protocol_violation")?.data)
      .toMatchObject({
        repair: { code: "R_TOOL_PURPOSE_INVALID" },
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
            tool: "process_run",
            input: { command: "pwd" },
            dependsOn: [],
            purpose: "Inspect the current working directory.",
          }],
          allowedTools: ["process_run"],
        },
      }),
    ]);

    const decision = await callAgentDecision({
      provider,
      stateView: createStateView(),
      toolDefinitions: [createTool("process_run")],
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
          tool: "process_run",
          input: { command: "pwd" },
          dependsOn: [],
          ...(purpose ? { purpose } : {}),
        }],
        allowedTools: ["process_run"],
      },
    });
    const { provider, generateTurn } = createProvider([
      action(),
      action("Inspect the current working directory."),
    ]);

    const decision = await callAgentDecision({
      provider,
      stateView: createStateView(),
      toolDefinitions: [createTool("process_run")],
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
      ...MODE_TRANSITION_CONTROL_TOOL_NAMES,
    ]);
    const tools = generateTurn.mock.calls[0]?.[0]?.tools ?? [];
    expect(tools.every((tool) => (
      tool.inputSchema["type"] === "object"
      && tool.inputSchema["oneOf"] === undefined
      && tool.inputSchema["additionalProperties"] === false
    ))).toBe(true);
    const contextProperties = tools
      .find((tool) => tool.name === "decision_enter_context_retrieve")
      ?.inputSchema["properties"] as Record<string, Record<string, unknown>>;
    expect(contextProperties["capabilities"]?.["items"]).toMatchObject({
      enum: ["context:load"],
    });
    const resolveCreateSchema = tools
      .find((tool) => tool.name === "decision_resolve_create")
      ?.inputSchema;
    const resolveProperties = resolveCreateSchema?.["properties"] as Record<string, Record<string, unknown>>;
    expect(resolveCreateSchema?.["required"]).toEqual([
      "purpose",
      "capabilities",
      "mutationScopes",
      "binding",
    ]);
    expect(resolveProperties["mutationScopes"]).toMatchObject({
      type: "array",
      minItems: 1,
      maxItems: 8,
    });
    expect(resolveProperties["binding"]).toMatchObject({
      type: "object",
      properties: expect.objectContaining({ kind: { const: "create" } }),
    });
    expect(generateTurn.mock.calls[0]?.[0]?.toolChoice).toBe("auto");
    expect(generateTurn.mock.calls[0]?.[0]?.parallelToolCalls).toBe(false);
  });

  it("parses an exact typed binding proposal from the native transition control", async () => {
    const binding = {
      kind: "create" as const,
      title: "Create notes",
      objective: "Create and verify notes.md.",
      initialRequest: {
        title: "Create notes",
        request: "Create notes.md.",
        acceptance: ["notes.md exists."],
        constraints: [],
      },
      resources: [],
      evidence: ["run:RUN-1:step:1:call:find-owner"],
    };
    const { provider } = createNativeToolProvider([{
      type: "tool_calls",
      calls: [{
        id: "transition-1",
        name: "decision_resolve_create",
        input: {
          purpose: "Bind notes.md before creating it.",
          capabilities: ["file:write"],
          mutationScopes: [{ kind: "filesystem", value: "/tmp/notes.md" }],
          binding,
        },
      }],
    }]);

    await expect(callAgentDecision({
      provider,
      stateView: createStateView(),
      toolDefinitions: [],
    })).resolves.toMatchObject({
      kind: "transition_mode",
      request: { to: "resolve", binding },
    });
  });

  it("repairs an empty destination-specific mode call before it reaches the graph", async () => {
    const { provider, generateTurn } = createNativeToolProvider([
      {
        type: "tool_calls",
        calls: [{
          id: "transition-empty",
          name: "decision_enter_observe_investigate",
          input: {},
        }],
      },
      {
        type: "tool_calls",
        calls: [{
          id: "transition-repaired",
          name: "decision_enter_observe_investigate",
          input: {
            purpose: "Read the exact requested file.",
            capabilities: ["file:read"],
            references: [{ kind: "filesystem", value: "/tmp/notes.md" }],
          },
        }],
      },
    ]);

    const decision = await callAgentDecision({
      provider,
      stateView: createStateView(),
      toolDefinitions: [],
    });

    expect(generateTurn).toHaveBeenCalledTimes(2);
    expect(generateTurn.mock.calls[1]?.[0]?.messages.at(-1)?.content).toContain(
      "missing required field",
    );
    expect(decision).toMatchObject({
      kind: "transition_mode",
      request: {
        to: "observe.investigate",
        purpose: "Read the exact requested file.",
        capabilities: ["file:read"],
        references: [{ kind: "filesystem", path: "/tmp/notes.md" }],
      },
    });
  });

  it("keeps callable schemas native and groups selected tool names by purpose in text", async () => {
    const { provider, generateTurn } = createProvider([
      JSON.stringify({ kind: "reply", status: "completed", message: "Done" }),
    ]);
    const selectedTool: ToolDefinition = {
      name: "read_files",
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
    expect(userPrompt).toContain("Selected tools:\n- read: read_files");
    expect(userPrompt).not.toContain("UNIQUE_INPUT_SCHEMA_MARKER");
    expect(userPrompt).not.toContain("UNIQUE_OUTPUT_SCHEMA_MARKER");
    expect(userPrompt).not.toContain("annotations=");
    expect(userPrompt).not.toContain("inputSchema=");
    expect(userPrompt).not.toContain("outputSchema=");

    const nativeTool = turnInput?.tools?.find((tool) => tool.name === "read_files");
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
      nativeToolCount: MODE_TRANSITION_CONTROL_TOOL_NAMES.length,
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
      nativeToolCount: MODE_TRANSITION_CONTROL_TOOL_NAMES.length,
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

  it("exposes and parses terminal stop only when the graph is active", async () => {
    const { provider, generateTurn } = createProvider([
      JSON.stringify({
        kind: "stop",
        request: {
          outcome: "needs_user_input",
          response: "Which path should I inspect?",
        },
      }),
    ], { jsonSchema: true });

    const decision = await callAgentDecision({
      provider,
      stateView: createStateView(),
      toolDefinitions: [],
      terminalStopAvailable: true,
    });

    expect(generateTurn.mock.calls[0]?.[0]?.tools.map((tool: { name: string }) => tool.name)).toEqual([
      ...MODE_TRANSITION_CONTROL_TOOL_NAMES,
      "decision_stop",
    ]);
    expect(decision).toMatchObject({
      kind: "stop",
      request: {
        outcome: "needs_user_input",
        response: "Which path should I inspect?",
      },
    });
  });

  it("exposes and parses the WorkState checkpoint only when the graph is active", async () => {
    const update = {
      reason: "plan",
      summary: "The contract is complete and runtime wiring remains.",
      plan: [
        { id: "contract", task: "Implement the contract.", status: "done" },
        { id: "runtime", task: "Wire the runtime.", status: "active" },
      ],
      importantContext: [{
        kind: "artifact",
        value: "WorkState contract",
        ref: "/workspace/src/work-state/contracts.ts",
      }],
      nextAction: "Wire the runtime.",
    };
    const { provider, generateTurn } = createNativeToolProvider([{
      type: "tool_calls",
      calls: [{
        id: "checkpoint-1",
        name: "decision_checkpoint_workstate",
        input: update,
      }],
    }]);

    const decision = await callAgentDecision({
      provider,
      stateView: createStateView(),
      toolDefinitions: [],
      workStateCheckpointAvailable: true,
    });

    expect(generateTurn.mock.calls[0]?.[0]?.tools.map((tool: { name: string }) => tool.name))
      .toContain("decision_checkpoint_workstate");
    expect(decision).toEqual({
      kind: "checkpoint_work_state",
      update,
      workingNotes: undefined,
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
      ...MODE_TRANSITION_CONTROL_TOOL_NAMES,
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

  it("exposes the exact validation-mode schema and parses typed task outcomes", async () => {
    const { provider, generateTurn } = createNativeToolProvider([{
      type: "tool_calls",
      calls: [{
        id: "validate_1",
        name: "decision_enter_validation",
        input: {
          purpose: "Freshly verify the important website file.",
          capabilities: ["task:validation"],
          validationChecks: [{
            kind: "path.exists",
            subject: "/tmp/site/index.html",
            expectedKind: "file",
          }],
        },
      }],
    }]);

    const decision = await callAgentDecision({
      provider,
      stateView: createStateView(),
      toolDefinitions: [],
    });

    const transitionTool = generateTurn.mock.calls[0]?.[0]?.tools
      ?.find((tool) => tool.name === "decision_enter_validation");
    expect(transitionTool?.inputSchema).toMatchObject({
      type: "object",
      required: ["purpose", "capabilities", "validationChecks"],
      additionalProperties: false,
    });
    expect(JSON.stringify(transitionTool?.inputSchema)).toContain("Typed deterministic outcome");
    expect(JSON.stringify(transitionTool?.inputSchema)).toContain("process.exit_success");
    expect(JSON.stringify(transitionTool?.inputSchema)).toContain("file.search_no_match");
    expect(JSON.stringify(transitionTool?.inputSchema)).toContain("searchScope");
    expect(JSON.stringify(transitionTool?.inputSchema)).toContain("file.read_scope_satisfied");
    expect(JSON.stringify(transitionTool?.inputSchema)).toContain("readScope");
    expect(decision).toEqual({
      kind: "transition_mode",
      request: {
        to: "validation",
        purpose: "Freshly verify the important website file.",
        capabilities: ["task:validation"],
        validationChecks: [{
          kind: "path.exists",
          subject: "/tmp/site/index.html",
          expectedKind: "file",
        }],
      },
      workingNotes: undefined,
    });
  });

  it("never exposes a separate workstream resolver to the main decision model", async () => {
    const { provider, generateTurn } = createNativeToolProvider([{
      type: "assistant",
      content: "I can answer directly.",
    }]);

    const decision = await callAgentDecision({
      provider,
      stateView: createStateView(),
      toolDefinitions: [],
    });

    const resolverTool = generateTurn.mock.calls[0]?.[0]?.tools
      ?.find((tool) => tool.name === "workstream_resolve");
    expect(resolverTool).toBeUndefined();
    expect(decision).toEqual({
      kind: "reply",
      status: "completed",
      message: "I can answer directly.",
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
    return nativeDecisionFixture(content);
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

function checkpointRecommendedState(timeline: ReturnType<typeof pressureTimeline>): AgentStateView {
  return createStateView({
    context: {
      timeline,
      run: {
        contextPressure: {
          mode: "tool_compact",
          recommendedMode: "stream_checkpoint",
          escalationReason: "repeated_unresolved_pressure",
          unresolvedPressureStreak: 2,
          compactedCalls: 0,
          recoverable: true,
        },
      },
    },
  });
}

function createStateView(overrides: Partial<AgentStateView> = {}): AgentStateView {
  const currentEvent = {
    kind: "user" as const,
    seq: 1,
    timestamp: new Date(0).toISOString(),
    content: "Hii",
    current: true as const,
  };
  const legacyContext = overrides.context as unknown as Record<string, unknown> | undefined;
  const legacyTimeline = Array.isArray(legacyContext?.["timeline"])
    ? legacyContext["timeline"] as AgentTemporalEvent[]
    : undefined;
  const legacyTemporal = legacyContext?.["temporal"] as { recent?: AgentTemporalEvent[] } | undefined;
  const timeline = legacyTimeline ?? legacyTemporal?.recent ?? [currentEvent];
  const legacyCurrent = legacyContext?.["current"] as {
    runId?: string;
    routing?: AgentStateView["context"]["core"]["current"]["routing"];
  } | undefined;
  const {
    timeline: _timeline,
    temporal: _temporal,
    current: _current,
    stream: _stream,
    work: _work,
    resources: _resources,
    observations: _observations,
    git: _git,
    gitContext: _gitContext,
    ...contextOverrides
  } = legacyContext ?? {};
  return {
    ...overrides,
    context: {
      core: legacyContext?.["core"] as AgentStateView["context"]["core"]
        ?? buildCoreCapsule({
          revision: "context:test",
          runId: legacyCurrent?.runId ?? "RUN-1",
          timeline,
          ...(legacyCurrent?.routing ? { routing: legacyCurrent.routing } : {}),
        }),
      hot: legacyContext?.["hot"] as AgentStateView["context"]["hot"]
        ?? {
          available: [],
          loaded: [],
          budget: {
            maxMountedTokens: 8_000,
            mountedTokens: 0,
          },
        },
      ...contextOverrides,
    },
  };
}
