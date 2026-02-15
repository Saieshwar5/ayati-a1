import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import type { LlmProvider } from "../../src/core/contracts/provider.js";
import type { LlmTurnInput, LlmTurnOutput } from "../../src/core/contracts/llm-protocol.js";
import type { SessionMemory } from "../../src/memory/types.js";
import { MaxModeSubsessionOrchestrator } from "../../src/ivec/max-mode/subsession-orchestrator.js";

interface MockProviderOptions {
  verificationPass?: boolean;
  resumeSelector?: (request: string, candidateIds: string[]) => {
    action: "resume" | "new";
    subsessionId?: string;
    reason?: string;
  };
}

function createMockSessionMemory(): SessionMemory {
  return {
    initialize: vi.fn(),
    shutdown: vi.fn(),
    beginRun: vi.fn().mockReturnValue({ sessionId: "main-s1", runId: "main-r1" }),
    recordToolCall: vi.fn(),
    recordToolResult: vi.fn(),
    recordAssistantFinal: vi.fn(),
    recordRunFailure: vi.fn(),
    recordAgentStep: vi.fn(),
    recordAssistantFeedback: vi.fn(),
    getPromptMemoryContext: vi.fn().mockReturnValue({
      conversationTurns: [],
      previousSessionSummary: "",
      toolEvents: [],
    }),
    setStaticTokenBudget: vi.fn(),
    searchSessionSummaries: vi.fn().mockReturnValue([]),
    loadSessionTurns: vi.fn().mockReturnValue([]),
  };
}

function createMockProvider(options?: MockProviderOptions): LlmProvider {
  return {
    name: "mock",
    version: "1.0.0",
    capabilities: { nativeToolCalling: true },
    start: vi.fn(),
    stop: vi.fn(),
    countInputTokens: vi.fn(),
    generateTurn: vi.fn<(input: LlmTurnInput) => Promise<LlmTurnOutput>>().mockImplementation(async (input) => {
      const first = input.messages[0] as { role?: string; content?: string } | undefined;
      const system = first?.role === "system" ? first.content ?? "" : "";

      if (system.includes("should resume an existing max-mode sub-session")) {
        const user = input.messages.find((message) => message.role === "user");
        const prompt = typeof user?.content === "string" ? user.content : "";
        const requestMatch = prompt.match(/Request:\n([\s\S]*?)\nCandidates:\n/);
        const request = requestMatch?.[1]?.trim() ?? "";
        const candidateIds = [...prompt.matchAll(/id=([0-9a-f-]{36})/g)]
          .map((match) => match[1])
          .filter((value): value is string => !!value);

        const selection = options?.resumeSelector
          ? options.resumeSelector(request, candidateIds)
          : { action: "new", reason: "default_new" as const };

        return {
          type: "assistant",
          content: JSON.stringify({
            action: selection.action,
            subsession_id: selection.subsessionId ?? null,
            reason: selection.reason ?? "selector_decision",
            confidence: 0.86,
          }),
        };
      }

      if (system.includes("execution plans for a maximum-mode autonomous sub-session")) {
        return {
          type: "assistant",
          content: JSON.stringify({
            goal: "Deliver migration",
            done_criteria: "All tasks completed with verified output",
            constraints: ["no destructive command"],
            tasks: [
              {
                title: "Prepare output",
                objective: "Produce a migration summary",
                expected_output: "A concise migration summary",
              },
            ],
          }),
        };
      }

      if (system.includes("validate a task result against expected output")) {
        const pass = options?.verificationPass ?? true;
        return {
          type: "assistant",
          content: JSON.stringify({
            pass,
            score: pass ? 0.91 : 0.26,
            gap: pass ? "" : "Output did not satisfy requested criteria.",
            rationale: pass
              ? "Output satisfies the expected summary."
              : "Output is incomplete for the task objective.",
          }),
        };
      }

      return {
        type: "tool_calls",
        calls: [
          {
            id: "end-1",
            name: "agent_step",
            input: {
              phase: "end",
              thinking: "Task complete",
              summary: "Finalizing task",
              end_status: "solved",
              end_message: "Migration summary generated successfully.",
            },
          },
        ],
      };
    }),
  };
}

describe("MaxModeSubsessionOrchestrator", () => {
  let rootDir = "";

  beforeEach(async () => {
    rootDir = await mkdtemp(resolve(tmpdir(), "ayati-subsession-orchestrator-"));
  });

  afterEach(async () => {
    if (rootDir) {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("creates a subsession, executes plan tasks, and writes completion files", async () => {
    const provider = createMockProvider();
    const sessionMemory = createMockSessionMemory();
    const replies: unknown[] = [];

    const orchestrator = new MaxModeSubsessionOrchestrator({
      provider,
      sessionMemory,
      onReply: (_clientId, data) => replies.push(data),
      maxModeConfig: {
        rootDir,
        maxTasks: 4,
        maxAttemptsPerTask: 2,
        maxTotalSteps: 40,
        maxNoProgressCycles: 2,
      },
    });

    const result = await orchestrator.run({
      clientId: "c1",
      userContent: "please do a complex migration plan and implement it",
      systemContext: "Base system prompt",
      mainSessionId: "main-s1",
      mainRunId: "main-r1",
      staticSystemTokens: 0,
      resolveModelName: () => "mock-model",
    });

    expect(result.endStatus).toBe("solved");
    expect(result.content).toContain("completed");

    const subsessionDir = resolve(rootDir, result.subsessionId);
    const entries = await readdir(subsessionDir);
    expect(entries).toContain("plan.json");
    expect(entries).toContain("state.json");
    expect(entries).toContain("end.json");
    expect(entries).toContain("subsession.log.ndjson");
    expect(entries).toContain("progress.ndjson");

    const eventTypes = replies
      .map((payload) => (payload && typeof payload === "object" ? (payload as { type?: string }).type : undefined))
      .filter((type): type is string => !!type);

    expect(eventTypes).toContain("subsession_plan");
    expect(eventTypes).toContain("subsession_progress");
  });

  it("resumes the same failed subsession when selector marks request as related", async () => {
    const provider = createMockProvider({
      verificationPass: false,
      resumeSelector: (request, candidateIds) => {
        if (request.toLowerCase().includes("same migration") && candidateIds[0]) {
          return {
            action: "resume",
            subsessionId: candidateIds[0],
            reason: "related_to_previous_goal",
          };
        }
        return { action: "new", reason: "not_related" };
      },
    });
    const sessionMemory = createMockSessionMemory();
    const replies: unknown[] = [];

    const orchestrator = new MaxModeSubsessionOrchestrator({
      provider,
      sessionMemory,
      onReply: (_clientId, data) => replies.push(data),
      maxModeConfig: {
        rootDir,
        maxTasks: 4,
        maxAttemptsPerTask: 1,
        maxTotalSteps: 30,
        maxNoProgressCycles: 1,
      },
    });

    const first = await orchestrator.run({
      clientId: "c1",
      userContent: "build a complex migration workflow",
      systemContext: "Base system prompt",
      mainSessionId: "main-s1",
      mainRunId: "main-r1",
      staticSystemTokens: 0,
      resolveModelName: () => "mock-model",
    });
    expect(first.endStatus).toBe("partial");

    const second = await orchestrator.run({
      clientId: "c1",
      userContent: "for the same migration goal, fix what failed with a better strategy",
      systemContext: "Base system prompt",
      mainSessionId: "main-s1",
      mainRunId: "main-r2",
      staticSystemTokens: 0,
      resolveModelName: () => "mock-model",
    });

    expect(second.subsessionId).toBe(first.subsessionId);

    expect(replies).toContainEqual(
      expect.objectContaining({
        type: "subsession_progress",
        event: "subsession_resumed",
        subsessionId: first.subsessionId,
      }),
    );
  });

  it("creates a new subsession when selector marks request as unrelated", async () => {
    const provider = createMockProvider({
      verificationPass: false,
      resumeSelector: (request, candidateIds) => {
        if (request.toLowerCase().includes("same migration") && candidateIds[0]) {
          return {
            action: "resume",
            subsessionId: candidateIds[0],
            reason: "related_to_previous_goal",
          };
        }
        return { action: "new", reason: "unrelated_request" };
      },
    });
    const sessionMemory = createMockSessionMemory();

    const orchestrator = new MaxModeSubsessionOrchestrator({
      provider,
      sessionMemory,
      maxModeConfig: {
        rootDir,
        maxTasks: 4,
        maxAttemptsPerTask: 1,
        maxTotalSteps: 30,
        maxNoProgressCycles: 1,
      },
    });

    const first = await orchestrator.run({
      clientId: "c1",
      userContent: "build a complex migration workflow",
      systemContext: "Base system prompt",
      mainSessionId: "main-s1",
      mainRunId: "main-r1",
      staticSystemTokens: 0,
      resolveModelName: () => "mock-model",
    });
    expect(first.endStatus).toBe("partial");

    const second = await orchestrator.run({
      clientId: "c1",
      userContent: "draft a product launch narrative for next quarter",
      systemContext: "Base system prompt",
      mainSessionId: "main-s1",
      mainRunId: "main-r2",
      staticSystemTokens: 0,
      resolveModelName: () => "mock-model",
    });

    expect(second.subsessionId).not.toBe(first.subsessionId);
  });
});
