import { describe, expect, it } from "vitest";
import { createRecallSkill } from "../../src/skills/builtins/recall/index.js";
import type { RecallMemoryMatch } from "../../src/memory/retrieval/types.js";

describe("recall skill", () => {
  it("returns compact JSON matches from the retriever", async () => {
    const matches: RecallMemoryMatch[] = [
      {
        nodeId: "run:abc-123:r1",
        nodeType: "run",
        sessionId: "abc-123",
        sessionPath: "sessions/abc-123.md",
        sessionFilePath: "/tmp/sessions/abc-123.md",
        runId: "r1",
        runPath: "/tmp/runs/r1",
        runStatePath: "/tmp/runs/r1/state.json",
        createdAt: "2026-02-08T14:20:00.000Z",
        sourceType: "run",
        summaryText: "Completed auth migration and updated login flow",
        userMessage: "fix auth login",
        assistantResponse: "Completed auth migration and updated login flow",
        score: 0.91,
        related: [],
      },
    ];

    const retriever = {
      recall: async () => matches,
    };

    const skill = createRecallSkill({
      retriever: retriever as never,
    });

    const result = await skill.tools[0]!.execute({
      query: "auth migration",
    }, {
      clientId: "local",
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("\"matches\"");
    expect(result.output).toContain("\"abc-123\"");
    expect(result.output).toContain("\"summaryText\"");
  });

  it("validates that at least one filter is provided", async () => {
    const skill = createRecallSkill({
      retriever: {
        recall: async () => [],
      } as never,
    });

    const result = await skill.tools[0]!.execute({});

    expect(result.ok).toBe(false);
    expect(result.error).toContain("provide query and/or a date range");
  });

  it("exposes a prompt block that explains the one-tool recall flow", () => {
    const skill = createRecallSkill({
      retriever: {
        recall: async () => [],
      } as never,
    });

    expect(skill.promptBlock).toContain("recall_memory");
    expect(skill.promptBlock).toContain("read_file");
  });
});
