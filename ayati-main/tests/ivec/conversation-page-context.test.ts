import { describe, expect, it } from "vitest";
import { compactSupersededConversationPages } from "../../src/ivec/agent-runner/conversation-page-context.js";
import type { RunToolCallContext } from "../../src/ivec/types.js";

describe("conversation page prompt context", () => {
  it("keeps only the newest successful page payload in full", () => {
    const first = conversationCall(1, "first exact page", { fromSeq: 51, toSeq: 100 });
    const unrelated = call(2, "agent_history_search", "search results");
    const second = conversationCall(3, "second exact page", { fromSeq: 1, toSeq: 50 });

    const compacted = compactSupersededConversationPages([first, unrelated, second]);

    expect(compacted[0]).toMatchObject({
      tool: "agent_conversation_read",
      retention: "evidence_only",
      outputTruncated: true,
      rawOutputChars: first.output.length,
    });
    expect(compacted[0]?.output).not.toContain("first exact page");
    expect(compacted[0]?.output).toContain('"fromSeq":51');
    expect(compacted[1]).toEqual(unrelated);
    expect(compacted[2]).toEqual(second);
  });
});

function conversationCall(
  step: number,
  output: string,
  page: Record<string, unknown>,
): RunToolCallContext {
  return {
    ...call(step, "agent_conversation_read", output),
    projectionMetadata: { page },
  };
}

function call(step: number, tool: string, output: string): RunToolCallContext {
  return {
    step,
    callId: `call-${step}`,
    tool,
    input: {},
    status: "success",
    output,
    stepRef: { runId: "RUN-1", step, callId: `call-${step}` },
    verificationPassed: true,
  };
}
