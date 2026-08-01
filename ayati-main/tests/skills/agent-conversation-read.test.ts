import type { ContextEngineService } from "ayati-context-engine";
import { describe, expect, it, vi } from "vitest";
import { createGitContextSkill } from "../../src/skills/builtins/git-context/index.js";

describe("agent_conversation_read", () => {
  it("reads the current stream and follows an older cursor", async () => {
    const readAgentConversation = vi.fn()
      .mockResolvedValueOnce({
        messages: [{
          messageId: "MSG-2",
          streamId: "S-1",
          runId: "RUN-1",
          sequence: 2,
          role: "assistant",
          content: "Latest answer",
          contentHash: "hash",
          at: "2026-08-01T10:00:00+05:30",
        }],
        page: {
          snapshotToSeq: 2,
          fromSeq: 2,
          toSeq: 2,
          count: 1,
          hasOlder: true,
          olderCursor: "conversation:v1:abc123def456:2:2",
        },
        contentTruncated: false,
      })
      .mockResolvedValueOnce({
        messages: [{
          messageId: "MSG-1",
          streamId: "S-1",
          runId: "RUN-1",
          sequence: 1,
          role: "user",
          content: "Earlier request",
          contentHash: "hash",
          at: "2026-08-01T09:59:00+05:30",
        }],
        page: { snapshotToSeq: 2, fromSeq: 1, toSeq: 1, count: 1, hasOlder: false },
        contentTruncated: false,
      });
    const service = { readAgentConversation } as unknown as ContextEngineService;
    const tool = createGitContextSkill({ service }).tools
      .find((candidate) => candidate.name === "agent_conversation_read")!;

    const latest = await tool.execute({ limit: 50 }, executionContext("latest"));
    const older = await tool.execute({
      cursor: "conversation:v1:abc123def456:2:2",
    }, executionContext("older"));

    expect(latest.ok).toBe(true);
    expect(latest.v2?.structuredContent).toMatchObject({
      page: { hasOlder: true, olderCursor: "conversation:v1:abc123def456:2:2" },
      hasMore: true,
      messages: [expect.objectContaining({ sequence: 2, role: "assistant" })],
    });
    expect(older.v2?.structuredContent).toMatchObject({
      page: { hasOlder: false },
      hasMore: false,
      messages: [expect.objectContaining({ sequence: 1, role: "user" })],
    });
    expect(readAgentConversation).toHaveBeenNthCalledWith(1, {
      streamId: "S-1",
      limit: 50,
    });
    expect(readAgentConversation).toHaveBeenNthCalledWith(2, {
      streamId: "S-1",
      cursor: "conversation:v1:abc123def456:2:2",
    });
  });

  it("rejects conflicting cursor inputs before calling the service", async () => {
    const readAgentConversation = vi.fn();
    const service = { readAgentConversation } as unknown as ContextEngineService;
    const tool = createGitContextSkill({ service }).tools
      .find((candidate) => candidate.name === "agent_conversation_read")!;

    const result = await tool.execute({
      cursor: "conversation:v1:abc123def456:2:2",
      beforeSeq: 2,
    }, executionContext("invalid"));

    expect(result.ok).toBe(false);
    expect(readAgentConversation).not.toHaveBeenCalled();
  });
});

function executionContext(callId: string) {
  return { sessionId: "S-1", runId: "RUN-1", callId };
}
