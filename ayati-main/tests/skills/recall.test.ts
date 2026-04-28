import { describe, expect, it } from "vitest";
import { createRecallSkill } from "../../src/skills/builtins/recall/index.js";
import type { EpisodicRecallMatch } from "../../src/memory/episodic/index.js";

describe("recall skill", () => {
  it("returns compact JSON matches from the retriever", async () => {
    const matches: EpisodicRecallMatch[] = [
      {
        episodeId: "episode:abc-123",
        episodeType: "conversation_exchange",
        createdAt: "2026-02-08T14:20:00.000Z",
        summary: "Completed auth migration and updated login flow",
        matchedText: "User: fix auth login\nAssistant: Completed auth migration and updated login flow",
        score: 0.91,
        sessionId: "abc-123",
        sessionPath: "sessions/abc-123.md",
        sessionFilePath: "/tmp/sessions/abc-123.md",
        runId: "r1",
        eventStartIndex: 1,
        eventEndIndex: 2,
        contentHash: "hash",
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
    expect(result.output).toContain("\"matchedText\"");
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

  it("exposes episodic memory status and enable controls", async () => {
    let enabled = false;
    const skill = createRecallSkill({
      retriever: {
        recall: async () => [],
      },
      controls: {
        getStatus: (clientId) => ({
          clientId,
          episodicEnabled: enabled,
          embeddingProvider: "openai",
          embeddingModel: "fake",
          embeddingAvailable: true,
          pendingJobs: 0,
          runningJobs: 0,
          failedJobs: 0,
          doneJobs: 0,
        }),
        setEnabled: (clientId, nextEnabled) => {
          enabled = nextEnabled;
          return {
            clientId,
            episodicEnabled: enabled,
            embeddingProvider: "openai",
            embeddingModel: "fake",
            embeddingAvailable: true,
            pendingJobs: 0,
            runningJobs: 0,
            failedJobs: 0,
            doneJobs: 0,
          };
        },
      },
    });

    const statusTool = skill.tools.find((tool) => tool.name === "memory_status");
    const setTool = skill.tools.find((tool) => tool.name === "memory_set_episodic_enabled");

    expect(statusTool).toBeDefined();
    expect(setTool).toBeDefined();

    const setResult = await setTool!.execute({ enabled: true }, { clientId: "local" });
    expect(setResult.ok).toBe(true);
    expect(setResult.output).toContain("\"episodicEnabled\": true");

    const statusResult = await statusTool!.execute({}, { clientId: "local" });
    expect(statusResult.ok).toBe(true);
    expect(statusResult.output).toContain("\"embeddingAvailable\": true");
  });
});
