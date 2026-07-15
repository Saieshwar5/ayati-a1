import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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
  it("scopes relative mutation paths and checkpoints verified task changes", async () => {
    const checkoutPath = mkdtempSync(join(tmpdir(), "ayati-task-checkout-"));
    temporaryDirectories.push(checkoutPath);
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
    const checkpointMutation = vi.fn(async () => ({
      authorityId: "A-1",
      taskId: "W-20260713-0001",
      runId: "R-1",
      beforeHead: "a".repeat(40),
      checkpointHead: "b".repeat(40),
      stagedPaths: ["README"],
      sessionGitlinkUpdated: true,
    }));
    const service = {
      getActiveContext: vi.fn(async () => activeContext(checkoutPath)),
      acquireMutationAuthority,
      verifyMutation,
      checkpointMutation,
    } as unknown as GitContextService;
    const executor = createTaskScopedToolExecutor({ base, gitContext: service });

    const result = await executor.execute("write_files", {
      files: [{ path: "README", content: "Task context" }],
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
        files: [expect.objectContaining({ path: join(checkoutPath, "README") })],
      }),
      expect.objectContaining({ runId: "R-1" }),
    );
    expect(acquireMutationAuthority).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "S-1",
      runId: "R-1",
      taskId: "W-20260713-0001",
      targets: [{ path: "README", kind: "file" }],
    }));
    expect(verifyMutation).toHaveBeenCalledWith(expect.objectContaining({
      authorityId: "A-1",
      lockToken: "lock-1",
      toolStatus: "completed",
    }));
    expect(checkpointMutation).toHaveBeenCalledWith(expect.objectContaining({
      authorityId: "A-1",
      purpose: "write_files step 3",
      conversationId: "C-1",
      conversationHash: "conversation-hash",
    }));
  });

  it("uses the task checkout as the trusted filesystem root without a model escape flag", async () => {
    const checkoutPath = mkdtempSync(join(tmpdir(), "ayati-task-checkout-"));
    temporaryDirectories.push(checkoutPath);
    const acquireMutationAuthority = vi.fn(async () => ({
      authority: { authorityId: "A-2", lockToken: "lock-2" },
    }));
    const service = {
      getActiveContext: vi.fn(async () => activeContext(checkoutPath)),
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
      checkpointMutation: vi.fn(async () => ({
        authorityId: "A-2",
        taskId: "W-20260713-0001",
        runId: "R-1",
        beforeHead: "a".repeat(40),
        checkpointHead: "b".repeat(40),
        stagedPaths: ["site/index.html"],
        sessionGitlinkUpdated: true,
      })),
    } as unknown as GitContextService;
    const executor = createTaskScopedToolExecutor({
      base: createToolExecutor([writeFilesTool]),
      gitContext: service,
    });

    const result = await executor.execute("write_files", {
      files: [{ path: "site/index.html", content: "<h1>Aurora Coffee</h1>" }],
      createDirs: true,
      allowExternalPath: true,
    }, {
      clientId: "client-1",
      sessionId: "S-1",
      runId: "R-1",
      stepNumber: 1,
    });

    expect(result.ok).toBe(true);
    expect(existsSync(join(checkoutPath, "site/index.html"))).toBe(true);
    expect(readFileSync(join(checkoutPath, "site/index.html"), "utf-8")).toContain("Aurora Coffee");
    expect(acquireMutationAuthority).toHaveBeenCalledWith(expect.objectContaining({
      targets: [{ path: "site/index.html", kind: "file" }],
    }));
  });

  it("runs node syntax validation in the task checkout without mutation authority", async () => {
    const checkoutPath = mkdtempSync(join(tmpdir(), "ayati-task-checkout-"));
    temporaryDirectories.push(checkoutPath);
    writeFileSync(join(checkoutPath, "app.js"), "const ready = true;\n", "utf-8");
    const acquireMutationAuthority = vi.fn();
    const service = {
      getActiveContext: vi.fn(async () => activeContext(checkoutPath)),
      acquireMutationAuthority,
    } as unknown as GitContextService;
    const executor = createTaskScopedToolExecutor({
      base: createToolExecutor([shellExecTool]),
      gitContext: service,
    });

    const result = await executor.execute("shell", {
      cmd: "node --check app.js",
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

  it("rejects an external task mutation before requesting authority", async () => {
    const checkoutPath = mkdtempSync(join(tmpdir(), "ayati-task-checkout-"));
    temporaryDirectories.push(checkoutPath);
    const outsidePath = join(tmpdir(), `ayati-outside-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    const acquireMutationAuthority = vi.fn();
    const service = {
      getActiveContext: vi.fn(async () => activeContext(checkoutPath)),
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
    expect(result.v2?.code).toBe("TASK_RESOURCE_SCOPE_VIOLATION");
    expect(acquireMutationAuthority).not.toHaveBeenCalled();
    expect(existsSync(outsidePath)).toBe(false);
  });

  it("rejects a repeated task-root prefix before the tool can create nested output", async () => {
    const checkoutPath = mkdtempSync(join(tmpdir(), "ayati-task-checkout-"));
    temporaryDirectories.push(checkoutPath);
    const execute = vi.fn(async () => ({ ok: true, output: "should not run" }));
    const acquireMutationAuthority = vi.fn();
    const service = {
      getActiveContext: vi.fn(async () => activeContext(checkoutPath)),
      acquireMutationAuthority,
    } as unknown as GitContextService;
    const executor = createTaskScopedToolExecutor({
      base: baseExecutor(execute),
      gitContext: service,
    });
    const repeatedPath = `${basename(checkoutPath)}/index.html`;

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
    expect(result.v2?.code).toBe("TASK_ROOT_REPEATED");
    expect(result.error).toContain("Use 'index.html'");
    expect(execute).not.toHaveBeenCalled();
    expect(acquireMutationAuthority).not.toHaveBeenCalled();
    expect(existsSync(join(checkoutPath, repeatedPath))).toBe(false);
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

function activeContext(checkoutPath: string) {
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
        taskId: "W-20260713-0001",
        repositoryPath: "/task.git",
        workingPath: checkoutPath,
        branch: "main",
        head: "d".repeat(40),
      },
      checkoutPath,
      workingDirectory: checkoutPath,
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
        taskId: "W-20260713-0001",
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
