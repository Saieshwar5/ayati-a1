import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitContextService } from "ayati-git-context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTaskScopedToolExecutor } from "../../src/app/task-scoped-tool-executor.js";
import { createToolExecutor, type ToolExecutor } from "../../src/skills/tool-executor.js";
import { writeFilesTool } from "../../src/skills/builtins/filesystem/write-files.js";
import { shellExecTool } from "../../src/skills/builtins/shell/index.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("task-scoped tool executor", () => {
  it("accepts absolute V1 mutation paths and leaves verified changes for finalization", async () => {
    const repositoryPath = mkdtempSync(join(tmpdir(), "ayati-task-repository-"));
    temporaryDirectories.push(repositoryPath);
    const execute = vi.fn(async () => ({ ok: true, output: "wrote README" }));
    const base = baseExecutor(execute);
    const acquireMutationAuthority = vi.fn(async () => ({
      authority: {
        authorityId: "A-1",
        lockToken: "lock-1",
      },
    }));
    const verifyMutation = vi.fn(async () => ({
      authorityId: "A-1",
      status: "verified",
      verified: true,
      outcome: "verified_changes",
      provenance: {},
    }));
    const service = {
      getActiveContext: vi.fn(async () => v1ActiveContext(repositoryPath)),
      acquireMutationAuthority,
      verifyMutation,
    } as unknown as GitContextService;
    const executor = createTaskScopedToolExecutor({ base, gitContext: service });

    const result = await executor.execute("write_files", {
      files: [{ path: join(repositoryPath, "README"), content: "Task context" }],
      createDirs: true,
    }, {
      clientId: "client-1",
      sessionId: "S-1",
      runId: "R-1",
      stepNumber: 3,
    });

    expect(result.ok).toBe(true);
    expect(execute).toHaveBeenCalledWith(
      "write_files",
      expect.objectContaining({
        files: [expect.objectContaining({ path: join(repositoryPath, "README") })],
      }),
      expect.objectContaining({ runId: "R-1" }),
    );
    expect(acquireMutationAuthority).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "S-1",
      runId: "R-1",
      taskId: "T-20260713-0001",
      taskRequestId: "R-0002",
      targets: [{ path: "README", kind: "file" }],
    }));
    expect(verifyMutation).toHaveBeenCalledWith(expect.objectContaining({
      authorityId: "A-1",
      lockToken: "lock-1",
      toolStatus: "completed",
    }));
  });

  it("uses the V1 working directory and leaves verified changes for finalization", async () => {
    const workingDirectory = mkdtempSync(join(tmpdir(), "ayati-v1-task-"));
    temporaryDirectories.push(workingDirectory);
    const execute = vi.fn(async () => ({ ok: true, output: "wrote lesson" }));
    const acquireMutationAuthority = vi.fn(async () => ({
      authority: { authorityId: "A-v1", lockToken: "lock-v1" },
    }));
    const service = {
      getActiveContext: vi.fn(async () => v1ActiveContext(workingDirectory)),
      acquireMutationAuthority,
      verifyMutation: vi.fn(async () => ({
        authorityId: "A-v1",
        status: "verified",
        verified: true,
        outcome: "verified_changes",
        provenance: {},
      })),
    } as unknown as GitContextService;
    const executor = createTaskScopedToolExecutor({ base: baseExecutor(execute), gitContext: service });

    const result = await executor.execute("write_files", {
      files: [{ path: join(workingDirectory, "lesson.md"), content: "Lesson" }],
    }, {
      clientId: "client-1",
      sessionId: "S-1",
      runId: "R-1",
      stepNumber: 1,
    });

    expect(result.ok).toBe(true);
    expect(acquireMutationAuthority).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "T-20260713-0001",
      taskRequestId: "R-0002",
      targets: [{ path: "lesson.md", kind: "file" }],
    }));
    expect(execute).toHaveBeenCalledWith(
      "write_files",
      expect.anything(),
      expect.objectContaining({
        resourceScope: {
          kind: "task",
          rootPath: workingDirectory,
          taskId: "T-20260713-0001",
        },
      }),
    );
  });

  it("binds a verified external outcome to the V1 task and request with no file target", async () => {
    const workingDirectory = mkdtempSync(join(tmpdir(), "ayati-v1-external-"));
    temporaryDirectories.push(workingDirectory);
    const execute = vi.fn(async () => ({
      ok: true,
      output: "Application submitted as APP-1042.",
      v2: {
        transportOk: true,
        operationStatus: "succeeded" as const,
        code: "EXTERNAL_ACTION_COMPLETED",
        message: "Application submitted.",
        verification: {
          status: "passed" as const,
          summary: "External system confirmed APP-1042.",
          assertions: [],
          facts: [{ kind: "external_identifier", message: "Application APP-1042 confirmed." }],
          artifacts: [],
        },
      },
    }));
    const acquireMutationAuthority = vi.fn(async () => ({
      authority: { authorityId: "A-external", lockToken: "lock-external" },
    }));
    const verifyMutation = vi.fn(async () => ({
      authorityId: "A-external",
      status: "verified",
      verified: true,
      outcome: "no_changes",
      provenance: { created: [], modified: [], deleted: [], renamed: [], unexpectedPaths: [] },
    }));
    const service = {
      getActiveContext: vi.fn(async () => v1ActiveContext(workingDirectory)),
      acquireMutationAuthority,
      verifyMutation,
    } as unknown as GitContextService;
    const executor = createTaskScopedToolExecutor({
      base: {
        ...baseExecutor(execute),
        list: () => ["file_fetch_url"],
      },
      gitContext: service,
    });

    const result = await executor.execute("file_fetch_url", {
      url: "https://example.test/application",
    }, {
      sessionId: "S-1",
      runId: "R-1",
      stepNumber: 2,
    });

    expect(result.ok).toBe(true);
    expect(acquireMutationAuthority).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "T-20260713-0001",
      taskRequestId: "R-0002",
      targets: [],
    }));
    expect(verifyMutation).toHaveBeenCalledWith(expect.objectContaining({
      authorityId: "A-external",
      toolStatus: "completed",
    }));
  });

  it("uses the task checkout as the trusted filesystem root without a model escape flag", async () => {
    const repositoryPath = mkdtempSync(join(tmpdir(), "ayati-task-repository-"));
    temporaryDirectories.push(repositoryPath);
    const acquireMutationAuthority = vi.fn(async () => ({
      authority: { authorityId: "A-2", lockToken: "lock-2" },
    }));
    const service = {
      getActiveContext: vi.fn(async () => v1ActiveContext(repositoryPath)),
      acquireMutationAuthority,
      verifyMutation: vi.fn(async () => ({
        authorityId: "A-2",
        status: "verified",
        verified: true,
        outcome: "verified_changes",
        provenance: {
          created: ["site/index.html"],
          modified: [],
          deleted: [],
          renamed: [],
          unexpectedPaths: [],
        },
      })),
    } as unknown as GitContextService;
    const executor = createTaskScopedToolExecutor({
      base: createToolExecutor([writeFilesTool]),
      gitContext: service,
    });

    const result = await executor.execute("write_files", {
      files: [{ path: join(repositoryPath, "site/index.html"), content: "<h1>Aurora Coffee</h1>" }],
      createDirs: true,
      allowExternalPath: true,
    }, {
      clientId: "client-1",
      sessionId: "S-1",
      runId: "R-1",
      stepNumber: 1,
    });

    expect(result.ok).toBe(true);
    expect(existsSync(join(repositoryPath, "site/index.html"))).toBe(true);
    expect(readFileSync(join(repositoryPath, "site/index.html"), "utf-8")).toContain("Aurora Coffee");
    expect(acquireMutationAuthority).toHaveBeenCalledWith(expect.objectContaining({
      targets: [{ path: "site/index.html", kind: "file" }],
    }));
  });

  it("runs node syntax validation in the task checkout without mutation authority", async () => {
    const repositoryPath = mkdtempSync(join(tmpdir(), "ayati-task-repository-"));
    temporaryDirectories.push(repositoryPath);
    writeFileSync(join(repositoryPath, "app.js"), "const ready = true;\n", "utf-8");
    const acquireMutationAuthority = vi.fn();
    const service = {
      getActiveContext: vi.fn(async () => v1ActiveContext(repositoryPath)),
      acquireMutationAuthority,
    } as unknown as GitContextService;
    const executor = createTaskScopedToolExecutor({
      base: createToolExecutor([shellExecTool]),
      gitContext: service,
    });

    const result = await executor.execute("shell", {
      cmd: [
        "set -e",
        `ls -la ${repositoryPath}`,
        `node --check ${join(repositoryPath, "app.js")}`,
      ].join("\n"),
      targets: [{ path: repositoryPath, kind: "directory" }],
    }, {
      clientId: "client-1",
      sessionId: "S-1",
      runId: "R-1",
      stepNumber: 2,
    });

    expect(result.ok).toBe(true);
    expect(result.meta).toMatchObject({ exitCode: 0 });
    expect(acquireMutationAuthority).not.toHaveBeenCalled();
  });

  it("authorizes shell work only through declared absolute mutation targets", async () => {
    const repositoryPath = mkdtempSync(join(tmpdir(), "ayati-task-repository-"));
    temporaryDirectories.push(repositoryPath);
    const execute = vi.fn(async () => ({ ok: true, output: "build complete" }));
    const acquireMutationAuthority = vi.fn(async () => ({
      authority: { authorityId: "A-shell", lockToken: "lock-shell" },
    }));
    const service = {
      getActiveContext: vi.fn(async () => v1ActiveContext(repositoryPath)),
      acquireMutationAuthority,
      verifyMutation: vi.fn(async () => ({
        authorityId: "A-shell",
        status: "verified",
        verified: true,
        outcome: "verified_changes",
        provenance: {},
      })),
    } as unknown as GitContextService;
    const executor = createTaskScopedToolExecutor({ base: baseExecutor(execute), gitContext: service });

    const result = await executor.execute("shell", {
      cmd: "pnpm build",
      targets: [{ path: join(repositoryPath, "dist"), kind: "directory" }],
    }, {
      clientId: "client-1",
      sessionId: "S-1",
      runId: "R-1",
      stepNumber: 3,
    });

    expect(result.ok).toBe(true);
    expect(acquireMutationAuthority).toHaveBeenCalledWith(expect.objectContaining({
      targets: [{ path: "dist", kind: "directory" }],
    }));
    expect(execute).toHaveBeenCalledWith("shell", expect.objectContaining({
      cwd: repositoryPath,
      targets: [{ path: join(repositoryPath, "dist"), kind: "directory" }],
    }), expect.objectContaining({ resourceScope: expect.objectContaining({ rootPath: repositoryPath }) }));
  });

  it("rejects mutation-capable shell work without declared targets", async () => {
    const repositoryPath = mkdtempSync(join(tmpdir(), "ayati-task-repository-"));
    temporaryDirectories.push(repositoryPath);
    const execute = vi.fn(async () => ({ ok: true, output: "should not run" }));
    const acquireMutationAuthority = vi.fn();
    const service = {
      getActiveContext: vi.fn(async () => v1ActiveContext(repositoryPath)),
      acquireMutationAuthority,
    } as unknown as GitContextService;
    const executor = createTaskScopedToolExecutor({ base: baseExecutor(execute), gitContext: service });

    const result = await executor.execute("shell", { cmd: "pnpm build" }, {
      clientId: "client-1",
      sessionId: "S-1",
      runId: "R-1",
      stepNumber: 3,
    });

    expect(result.ok).toBe(false);
    expect(result.v2?.code).toBe("TASK_RESOURCE_SCOPE_VIOLATION");
    expect(execute).not.toHaveBeenCalled();
    expect(acquireMutationAuthority).not.toHaveBeenCalled();
  });

  it("rejects an external task mutation before requesting authority", async () => {
    const repositoryPath = mkdtempSync(join(tmpdir(), "ayati-task-repository-"));
    temporaryDirectories.push(repositoryPath);
    const outsidePath = join(tmpdir(), `ayati-outside-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    const acquireMutationAuthority = vi.fn();
    const service = {
      getActiveContext: vi.fn(async () => v1ActiveContext(repositoryPath)),
      acquireMutationAuthority,
    } as unknown as GitContextService;
    const executor = createTaskScopedToolExecutor({
      base: createToolExecutor([writeFilesTool]),
      gitContext: service,
    });

    const result = await executor.execute("write_files", {
      files: [{ path: outsidePath, content: "not allowed" }],
      allowExternalPath: true,
    }, {
      clientId: "client-1",
      sessionId: "S-1",
      runId: "R-1",
      stepNumber: 3,
    });

    expect(result.ok).toBe(false);
    expect(result.v2?.code).toBe("PATH_OUTSIDE_TASK_ROOT");
    expect(acquireMutationAuthority).not.toHaveBeenCalled();
    expect(existsSync(outsidePath)).toBe(false);
  });

  it("rejects relative paths before the tool can create nested output", async () => {
    const repositoryPath = mkdtempSync(join(tmpdir(), "ayati-task-repository-"));
    temporaryDirectories.push(repositoryPath);
    const execute = vi.fn(async () => ({ ok: true, output: "should not run" }));
    const acquireMutationAuthority = vi.fn();
    const service = {
      getActiveContext: vi.fn(async () => v1ActiveContext(repositoryPath)),
      acquireMutationAuthority,
    } as unknown as GitContextService;
    const executor = createTaskScopedToolExecutor({
      base: baseExecutor(execute),
      gitContext: service,
    });
    const repeatedPath = "nested/index.html";

    const result = await executor.execute("write_files", {
      files: [{ path: repeatedPath, content: "<h1>Nested by mistake</h1>" }],
      createDirs: true,
    }, {
      clientId: "client-1",
      sessionId: "S-1",
      runId: "R-1",
      stepNumber: 4,
    });

    expect(result.ok).toBe(false);
    expect(result.v2?.code).toBe("ABSOLUTE_PATH_REQUIRED");
    expect(result.error).toContain("must be an absolute filesystem path");
    expect(execute).not.toHaveBeenCalled();
    expect(acquireMutationAuthority).not.toHaveBeenCalled();
    expect(existsSync(join(repositoryPath, repeatedPath))).toBe(false);
  });

  it("rejects a canonical path that escapes through a symlink", async () => {
    const repositoryPath = mkdtempSync(join(tmpdir(), "ayati-task-repository-"));
    const outsidePath = mkdtempSync(join(tmpdir(), "ayati-task-outside-"));
    temporaryDirectories.push(repositoryPath, outsidePath);
    symlinkSync(outsidePath, join(repositoryPath, "linked-outside"), "dir");
    const execute = vi.fn(async () => ({ ok: true, output: "should not run" }));
    const acquireMutationAuthority = vi.fn();
    const service = {
      getActiveContext: vi.fn(async () => v1ActiveContext(repositoryPath)),
      acquireMutationAuthority,
    } as unknown as GitContextService;
    const executor = createTaskScopedToolExecutor({
      base: baseExecutor(execute),
      gitContext: service,
    });

    const result = await executor.execute("write_files", {
      files: [{ path: join(repositoryPath, "linked-outside/escaped.txt"), content: "not allowed" }],
      createDirs: true,
    }, {
      clientId: "client-1",
      sessionId: "S-1",
      runId: "R-1",
      stepNumber: 5,
    });

    expect(result.ok).toBe(false);
    expect(result.v2?.code).toBe("PATH_OUTSIDE_TASK_ROOT");
    expect(execute).not.toHaveBeenCalled();
    expect(acquireMutationAuthority).not.toHaveBeenCalled();
    expect(existsSync(join(outsidePath, "escaped.txt"))).toBe(false);
  });
});

function baseExecutor(execute: ReturnType<typeof vi.fn>): ToolExecutor {
  return {
    list: () => ["write_files"],
    definitions: () => [],
    validate: () => ({ valid: true }),
    execute,
  };
}

function v1ActiveContext(workingDirectory: string) {
  return {
    contextRevision: "sha256:test-context",
    session: {
      session: {
        sessionId: "S-1",
        date: "2026-07-13",
        timezone: "Asia/Kolkata",
        agentId: "local",
        status: "open",
        repositoryPath: "/session",
        head: "c".repeat(40),
        createdAt: "2026-07-13T09:00:00+05:30",
        updatedAt: "2026-07-13T09:00:00+05:30",
      },
      summary: "",
      pendingConversation: [],
      pendingConversationContext: [{
        conversation: {
          conversationId: "C-1",
          sessionId: "S-1",
          sequence: 1,
          filePath: "",
          status: "active",
        },
        messages: [],
        contentHash: "conversation-hash",
      }],
      pendingDigest: "digest",
      recentCommits: [],
    },
    activeTask: {
      task: {
        taskId: "T-20260713-0001",
        repositoryPath: workingDirectory,
        workingPath: workingDirectory,
        branch: "main",
        head: "d".repeat(40),
      },
      workingDirectory,
      title: "Task",
      objective: "Build the task deliverable.",
      summary: "Task in progress.",
      importantPaths: [],
      recentCommits: [],
    },
    run: {
      run: {
        runId: "R-1",
        sessionId: "S-1",
        conversationId: "C-1",
        runClass: "task",
        taskId: "T-20260713-0001",
        taskRequestId: "R-0002",
        trigger: "user",
        status: "running",
        startedAt: "2026-07-13T09:00:00+05:30",
        updatedAt: "2026-07-13T09:00:00+05:30",
      },
      workState: {
        runId: "R-1",
        revision: 0,
        afterStep: 0,
        status: "not_done",
        summary: "",
        openWork: [],
        blockers: [],
        facts: [],
        evidence: [],
        artifacts: [],
        nextStep: null,
        userInputNeeded: [],
        updatedAt: "2026-07-13T09:00:00+05:30",
      },
      steps: [],
    },
    warnings: [],
  };
}
