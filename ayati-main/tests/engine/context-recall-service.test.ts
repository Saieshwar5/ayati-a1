import { describe, expect, it, vi } from "vitest";
import { ContextRecallService } from "../../src/ivec/context-recall-service.js";
import type { LlmProvider } from "../../src/core/contracts/provider.js";
import type { LlmTurnInput, LlmTurnOutput } from "../../src/core/contracts/llm-protocol.js";
import type { PromptMemoryContext, SessionMemory } from "../../src/memory/types.js";

function parsePayloadFromUserPrompt(text: string | undefined): unknown {
  if (!text) return null;
  const marker = "Payload:\n";
  const idx = text.lastIndexOf(marker);
  if (idx === -1) return null;
  const raw = text.slice(idx + marker.length).trim();
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function createMockProvider(
  handler: (input: LlmTurnInput) => Promise<LlmTurnOutput>,
): LlmProvider {
  return {
    name: "mock",
    version: "1.0.0",
    capabilities: { nativeToolCalling: true },
    start: vi.fn(),
    stop: vi.fn(),
    generateTurn: vi.fn(handler),
  };
}

function createSessionMemory(overrides?: Partial<SessionMemory>): SessionMemory {
  return {
    initialize: vi.fn(),
    shutdown: vi.fn(),
    beginRun: vi.fn().mockReturnValue({ sessionId: "active", runId: "r1" }),
    recordToolCall: vi.fn(),
    recordToolResult: vi.fn(),
    recordAssistantFinal: vi.fn(),
    recordRunFailure: vi.fn(),
    getPromptMemoryContext: vi.fn().mockReturnValue({
      conversationTurns: [],
      previousSessionSummary: "",
      toolEvents: [],
    }),
    setStaticTokenBudget: vi.fn(),
    searchSessionSummaries: vi.fn().mockReturnValue([]),
    loadSessionTurns: vi.fn().mockReturnValue([]),
    ...overrides,
  };
}

describe("ContextRecallService", () => {
  const memoryContext: PromptMemoryContext = {
    conversationTurns: [],
    previousSessionSummary: "",
    toolEvents: [],
  };

  it("uses trigger rules for history-dependent queries", () => {
    const service = new ContextRecallService(createSessionMemory());
    expect(
      service.shouldTrigger("what did we discuss in the previous session?", memoryContext),
    ).toBe(true);
    expect(service.shouldTrigger("hello", memoryContext)).toBe(false);
  });

  it("performs recursive AI retrieval and returns evidence", async () => {
    const turns = Array.from({ length: 72 }, (_, idx) => ({
      role: (idx % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content:
        idx >= 60
          ? `deployment detail ${idx}: we selected canary rollout and health checks`
          : `general conversation ${idx}`,
      timestamp: `2026-02-01T10:${String(idx).padStart(2, "0")}:00.000Z`,
    }));
    const sessionMemory = createSessionMemory({
      searchSessionSummaries: vi.fn().mockReturnValue([
        {
          sessionId: "s-1",
          summaryText: "Deployment rollout decisions",
          keywords: ["deployment", "rollout"],
          closedAt: "2026-02-01T10:00:00.000Z",
          closeReason: "token_limit",
          score: 4,
        },
      ]),
      loadSessionTurns: vi.fn().mockReturnValue(turns),
    });

    const provider = createMockProvider(async (input) => {
      const first = input.messages[0] as { content?: string } | undefined;
      const system = first?.content ?? "";
      const user = input.messages[1] as { content?: string } | undefined;
      const payload = parsePayloadFromUserPrompt(user?.content);

      if (system.includes("MODE=DECIDE")) {
        return {
          type: "assistant",
          content: JSON.stringify({
            needs_recall: true,
            reason: "query depends on prior session details",
            search_query: "deployment rollout",
          }),
        };
      }

      if (system.includes("MODE=SELECT_CHUNKS")) {
        const chunks =
          payload && typeof payload === "object" && Array.isArray((payload as { chunks?: unknown[] }).chunks)
            ? ((payload as { chunks: Array<{ id: string }> }).chunks ?? [])
            : [];
        const selectedId = chunks[chunks.length - 1]?.id ?? chunks[0]?.id;
        return {
          type: "assistant",
          content: JSON.stringify({
            selected: selectedId
              ? [{ id: selectedId, reason: "contains deployment details", confidence: 0.91 }]
              : [],
          }),
        };
      }

      if (system.includes("MODE=EXTRACT_EVIDENCE")) {
        const leafTurns =
          payload && typeof payload === "object" && Array.isArray((payload as { turns?: unknown[] }).turns)
            ? ((payload as { turns: Array<{ turn_ref: string; content: string }> }).turns ?? [])
            : [];
        const last = leafTurns[leafTurns.length - 1];
        return {
          type: "assistant",
          content: JSON.stringify({
            evidence: last
              ? [
                  {
                    turn_ref: last.turn_ref,
                    snippet: last.content,
                    why_relevant: "mentions rollout choice",
                    confidence: 0.9,
                  },
                ]
              : [],
          }),
        };
      }

      if (system.includes("MODE=RERANK_EVIDENCE")) {
        const evidence =
          payload && typeof payload === "object" && Array.isArray((payload as { evidence?: unknown[] }).evidence)
            ? ((payload as { evidence: Array<{ key: string }> }).evidence ?? [])
            : [];
        return {
          type: "assistant",
          content: JSON.stringify({
            selected_keys: evidence.map((item) => item.key),
          }),
        };
      }

      return { type: "assistant", content: "{}" };
    });

    const service = new ContextRecallService(sessionMemory, provider, {
      limits: {
        recursionDepth: 4,
        maxLeafTurns: 10,
      },
    });

    const result = await service.recall(
      "what was our previous deployment rollout decision?",
      memoryContext,
      "active",
    );

    expect(result.status === "found" || result.status === "partial").toBe(true);
    expect(result.evidence.length).toBeGreaterThan(0);
    expect(result.searchedSessionIds).toContain("s-1");
    expect(result.modelCalls).toBeGreaterThan(2);
  });

  it("returns not_found when no candidate sessions match", async () => {
    const sessionMemory = createSessionMemory({
      searchSessionSummaries: vi.fn().mockReturnValue([]),
    });
    const provider = createMockProvider(async (input) => {
      const first = input.messages[0] as { content?: string } | undefined;
      const system = first?.content ?? "";
      if (system.includes("MODE=DECIDE")) {
        return {
          type: "assistant",
          content: JSON.stringify({
            needs_recall: true,
            reason: "history dependency",
            search_query: "release decision",
          }),
        };
      }
      return { type: "assistant", content: "{}" };
    });

    const service = new ContextRecallService(sessionMemory, provider);
    const result = await service.recall(
      "what did we decide in the previous session?",
      memoryContext,
      "active",
    );

    expect(result.status).toBe("not_found");
    expect(result.reason).toContain("No relevant historical sessions matched");
  });

  it("runs in explicit mode even when trigger phrases are absent", async () => {
    const sessionMemory = createSessionMemory({
      searchSessionSummaries: vi.fn().mockReturnValue([]),
    });
    const provider = createMockProvider(async () => ({ type: "assistant", content: "{}" }));
    const service = new ContextRecallService(sessionMemory, provider);

    const result = await service.recall(
      "hello",
      memoryContext,
      "active",
      { invocationMode: "explicit", searchQuery: "release notes" },
    );

    expect(result.status).toBe("not_found");
    expect(sessionMemory.searchSessionSummaries).toHaveBeenCalledWith(
      "release notes",
      expect.any(Number),
    );
  });

  it("respects total recall timeout and exits gracefully", async () => {
    let now = 0;
    const advanceNow = (): number => {
      now += 20;
      return now;
    };

    const sessionMemory = createSessionMemory({
      searchSessionSummaries: vi.fn().mockReturnValue([
        {
          sessionId: "s-timeout",
          summaryText: "Prior infra changes",
          keywords: ["infra"],
          closedAt: "2026-02-01T10:00:00.000Z",
          closeReason: "token_limit",
          score: 2,
        },
      ]),
      loadSessionTurns: vi.fn().mockReturnValue(
        Array.from({ length: 30 }, (_, idx) => ({
          role: (idx % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
          content: `turn ${idx} about infra`,
          timestamp: `2026-02-01T11:${String(idx).padStart(2, "0")}:00.000Z`,
        })),
      ),
    });

    const provider = createMockProvider(async (input) => {
      const first = input.messages[0] as { content?: string } | undefined;
      const system = first?.content ?? "";
      if (system.includes("MODE=DECIDE")) {
        return {
          type: "assistant",
          content: JSON.stringify({
            needs_recall: true,
            reason: "history dependency",
            search_query: "infra",
          }),
        };
      }
      return { type: "assistant", content: "{}" };
    });

    const service = new ContextRecallService(sessionMemory, provider, {
      now: advanceNow,
      limits: {
        totalRecallMs: 25,
      },
    });

    const result = await service.recall(
      "what happened in our previous infra session?",
      memoryContext,
      "active",
    );

    expect(result.status).toBe("not_found");
    expect(result.reason.toLowerCase()).toContain("limits");
  });
});
