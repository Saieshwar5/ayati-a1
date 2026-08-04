import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContextEngineService } from "ayati-context-engine";
import { createGitContextSkill } from "../../src/skills/builtins/git-context/index.js";
import { createGitReadSkill } from "../../src/skills/builtins/git-read/index.js";
import { createToolExecutor } from "../../src/skills/tool-executor.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, {
    recursive: true,
    force: true,
  })));
});

describe("git_read", () => {
  it("covers common repository reads through one bounded tool", async () => {
    const fixture = await createRepository();
    const tool = createGitReadSkill({
      service: {} as ContextEngineService,
      workstreamRoot: join(fixture.root, "protected-workstreams"),
    }).tools[0];
    if (!tool) throw new Error("Missing git_read.");
    const executor = createToolExecutor([tool]);

    const calls = [
      { operation: "info" },
      { operation: "status" },
      { operation: "log", limit: 5 },
      { operation: "show", revision: fixture.second, includePatch: false },
      { operation: "diff", baseRevision: fixture.first, targetRevision: fixture.second },
      { operation: "branches" },
      { operation: "tags" },
      { operation: "remotes" },
      { operation: "files", revision: fixture.second },
      { operation: "read_file", revision: fixture.second, path: "notes.txt" },
      { operation: "grep", revision: fixture.second, query: "second" },
      { operation: "blame", revision: fixture.second, path: "notes.txt" },
      { operation: "reflog", limit: 5 },
      { operation: "merge_base", baseRevision: fixture.first, targetRevision: fixture.second },
    ] as const;

    for (const [index, call] of calls.entries()) {
      const result = await executor.execute("git_read", { repositoryPath: fixture.root, ...call }, {
        runId: "RUN-12345678-0000000001",
        callId: `git-read-${index}`,
      });
      expect(result.ok, `${call.operation}: ${result.error ?? "unknown error"}`).toBe(true);
      expect(result.v2?.structuredContent).toMatchObject({
        operation: call.operation,
        repository: {
          path: fixture.root,
          kind: "git_repository",
          head: fixture.second,
          branch: "main",
          access: "read_only",
        },
      });
      expect(result.v2?.verification?.status).toBe("passed");
    }

    expect((await git(fixture.root, ["rev-parse", "HEAD"])).trim()).toBe(fixture.second);
    expect(await readFile(join(fixture.root, "notes.txt"), "utf8")).toBe("first\nsecond\n");
  });

  it("rejects relative roots, irrelevant fields, and unsafe revisions", async () => {
    const tool = createGitReadSkill({
      service: {} as ContextEngineService,
      workstreamRoot: "/tmp/ayati-workstreams",
    }).tools[0];
    if (!tool) throw new Error("Missing git_read.");

    expect((await tool.execute({ repositoryPath: "repo", operation: "status" })).v2?.code)
      .toBe("GIT_READ_INPUT_INVALID");
    expect((await tool.execute({
      repositoryPath: "/tmp/repo",
      operation: "status",
      query: "unexpected",
    })).v2?.code).toBe("GIT_READ_INPUT_INVALID");
    expect((await tool.execute({
      repositoryPath: "/tmp/repo",
      operation: "show",
      revision: "--help",
    })).v2?.code).toBe("GIT_READ_INPUT_INVALID");
  });

  it("keeps the managed workstream repository behind Context Engine validation", async () => {
    const fixture = await createRepository();
    const repository = {
      path: fixture.root,
      branch: "main" as const,
      head: fixture.second,
      health: "ready" as const,
      kind: "context_only_git" as const,
      access: "read_only" as const,
    };
    const readLog = vi.fn(async () => ({
      repository,
      commits: [{
        commit: fixture.second,
        parents: [fixture.first],
        subject: "second",
        committedAt: "2026-08-03T00:00:00.000Z",
        mutationCount: 0,
        mutations: [],
        problemCodes: [],
      }],
      count: 1,
      hasMore: false,
    }));
    const readCommit = vi.fn(async () => ({
      repository,
      commit: {
        commit: fixture.second,
        parents: [fixture.first],
        subject: "second",
        committedAt: "2026-08-03T00:00:00.000Z",
        mutationCount: 0,
        mutations: [],
        problemCodes: [],
      },
      changedPaths: [{ status: "M", path: "notes.txt" }],
    }));
    const readDiff = vi.fn(async () => ({
      repository,
      from: fixture.first,
      to: fixture.second,
      changedPaths: [{ status: "M", path: "notes.txt" }],
      patch: "bounded patch",
      totalPatchChars: 13,
      truncated: false,
    }));
    const service = {
      readWorkstreamRepositoryLog: readLog,
      readWorkstreamRepositoryCommit: readCommit,
      readWorkstreamRepositoryDiff: readDiff,
    } as unknown as ContextEngineService;
    const tool = createGitReadSkill({ service, workstreamRoot: fixture.root }).tools[0];
    if (!tool) throw new Error("Missing git_read.");

    const result = await tool.execute({
      repositoryPath: fixture.root,
      operation: "log",
      limit: 5,
    }, {
      runId: "RUN-12345678-0000000001",
      callId: "workstream-log",
    });

    expect(result.ok).toBe(true);
    expect(readLog).toHaveBeenCalledWith(expect.objectContaining({
      runId: "RUN-12345678-0000000001",
      repositoryPath: fixture.root,
      limit: 5,
    }));
    expect(result.v2?.structuredContent).toMatchObject({
      operation: "log",
      repository,
      result: { count: 1, hasMore: false },
    });

    const shown = await tool.execute({
      repositoryPath: fixture.root,
      operation: "show",
      revision: fixture.second,
      includePatch: false,
    }, {
      runId: "RUN-12345678-0000000001",
      callId: "workstream-show",
    });
    const diffed = await tool.execute({
      repositoryPath: fixture.root,
      operation: "diff",
      baseRevision: fixture.first,
      targetRevision: fixture.second,
    }, {
      runId: "RUN-12345678-0000000001",
      callId: "workstream-diff",
    });

    expect(shown.ok).toBe(true);
    expect(diffed.ok).toBe(true);
    expect(readCommit).toHaveBeenCalledWith(expect.objectContaining({
      commit: fixture.second,
      repositoryPath: fixture.root,
    }));
    expect(readDiff).toHaveBeenCalledWith(expect.objectContaining({
      from: fixture.first,
      to: fixture.second,
      repositoryPath: fixture.root,
    }));
  });

  it("removes the three former model-facing tools", () => {
    const gitContextTools = createGitContextSkill({
      service: {} as ContextEngineService,
    }).tools.map((tool) => tool.name);

    expect(gitContextTools).not.toContain("git_context_log");
    expect(gitContextTools).not.toContain("git_context_show");
    expect(gitContextTools).not.toContain("git_context_diff");
  });
});

async function createRepository(): Promise<{
  root: string;
  first: string;
  second: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "ayati-git-read-"));
  roots.push(root);
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.name", "Ayati Test"]);
  await git(root, ["config", "user.email", "ayati-test@example.invalid"]);
  await writeFile(join(root, "notes.txt"), "first\n", "utf8");
  await git(root, ["add", "notes.txt"]);
  await git(root, ["commit", "-m", "first"]);
  const first = (await git(root, ["rev-parse", "HEAD"])).trim();
  await writeFile(join(root, "notes.txt"), "first\nsecond\n", "utf8");
  await git(root, ["add", "notes.txt"]);
  await git(root, ["commit", "-m", "second"]);
  const second = (await git(root, ["rev-parse", "HEAD"])).trim();
  await git(root, ["tag", "v1"]);
  await git(root, ["remote", "add", "origin", "https://example.invalid/repository.git"]);
  return { root, first, second };
}

async function git(root: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd: root, encoding: "utf8" });
  return result.stdout;
}
