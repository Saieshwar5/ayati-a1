import { describe, expect, it, vi } from "vitest";
import type { ContextEngineService } from "ayati-context-engine";
import { createGitContextSkill } from "../../src/skills/builtins/git-context/index.js";

const REPOSITORY = {
  path: "/tmp/ayati/workstreams",
  branch: "main" as const,
  head: "a".repeat(40),
  health: "ready" as const,
  kind: "context_only_git" as const,
  access: "read_only" as const,
};

describe("workstream repository tools", () => {
  it("passes only bounded read requests to the Context Engine", async () => {
    const readLog = vi.fn(async () => ({
      repository: REPOSITORY,
      commits: [],
      count: 0,
      hasMore: false,
    }));
    const service = { readWorkstreamRepositoryLog: readLog } as unknown as ContextEngineService;
    const tool = createGitContextSkill({ service }).tools.find(
      (candidate) => candidate.name === "git_context_log",
    );
    if (!tool) throw new Error("Missing git_context_log.");

    const result = await tool.execute({
      repositoryPath: REPOSITORY.path,
      limit: 5,
    }, {
      runId: "RUN-12345678-0000000001",
      callId: "history-log",
    });

    expect(result.ok).toBe(true);
    expect(readLog).toHaveBeenCalledWith(expect.objectContaining({
      runId: "RUN-12345678-0000000001",
      repositoryPath: REPOSITORY.path,
      limit: 5,
    }));
    expect(result.v2?.structuredContent).toMatchObject({
      repository: REPOSITORY,
      count: 0,
      hasMore: false,
    });
  });

  it("requires the exact projected repository path and strict commit references", async () => {
    const service = {} as ContextEngineService;
    const tools = createGitContextSkill({ service }).tools;
    const show = tools.find((candidate) => candidate.name === "git_context_show");
    const diff = tools.find((candidate) => candidate.name === "git_context_diff");
    if (!show || !diff) throw new Error("Missing workstream repository tools.");

    expect((await show.execute({ commit: "abcdef0" }, {
      runId: "RUN-12345678-0000000001",
      callId: "show",
    })).v2?.code).toBe("GIT_CONTEXT_REPOSITORY_READ_FAILED");
    expect((await diff.execute({
      repositoryPath: REPOSITORY.path,
      from: "HEAD",
      to: "abcdef0",
    }, {
      runId: "RUN-12345678-0000000001",
      callId: "diff",
    })).v2?.code).toBe("GIT_CONTEXT_REPOSITORY_READ_FAILED");
  });
});
