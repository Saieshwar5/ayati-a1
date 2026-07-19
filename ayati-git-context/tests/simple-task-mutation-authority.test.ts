import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ContextDatabase } from "../src/database/database.js";
import { readMutationAuthority } from "../src/repositories/mutation-authority-records.js";
import { SqliteGitContextService } from "../src/services/sqlite-git-context-service.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const services: SqliteGitContextService[] = [];
const at = "2026-07-17T10:00:00+05:30";

afterEach(async () => {
  await Promise.all(services.splice(0).map(async (service) => service.close()));
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => {
    await rm(path, { recursive: true, force: true });
  }));
});

describe("task-bound mutation authority", () => {
  it("binds one run and request directly to the task repository", async () => {
    const fixture = await createFixture();
    const input = authorityInput(fixture, [{ path: "src/app.ts", kind: "file" }]);

    const acquired = await fixture.service.acquireMutationAuthority(input);
    const retried = await fixture.service.acquireMutationAuthority(input);

    expect(retried).toEqual(acquired);
    expect(acquired.authority).toMatchObject({
      taskId: fixture.taskId,
      taskRequestId: "R-0001",
      runId: fixture.runId,
      repositoryPath: fixture.repositoryPath,
      beforeHead: fixture.taskHead,
      branch: "main",
      status: "active",
      targets: [{ path: "src/app.ts", kind: "file" }],
    });
    const persisted = readMutationAuthority(
      fixture.database,
      acquired.authority.authorityId,
    );
    expect(persisted).toMatchObject({ repositoryPath: fixture.repositoryPath });
    expect(fixture.database.prepare([
      "SELECT repository_path, task_request_id, branch",
      "FROM task_mutation_authorities WHERE authority_id = ?",
    ].join(" ")).get(acquired.authority.authorityId)).toEqual({
      repository_path: fixture.repositoryPath,
      task_request_id: "R-0001",
      branch: "main",
    });
    expect(fixture.database.prepare([
      "SELECT task_id, task_request_id FROM runs WHERE run_id = ?",
    ].join(" ")).get(fixture.runId)).toEqual({
      task_id: fixture.taskId,
      task_request_id: "R-0001",
    });
  });

  it("requires matching HEAD and the immutable bound request identity", async () => {
    const fixture = await createFixture();

    await expect(fixture.service.acquireMutationAuthority({
      ...authorityInput(fixture, [{ path: "src/app.ts", kind: "file" }]),
      expectedTaskHead: "a".repeat(40),
    })).rejects.toMatchObject({ code: "TASK_HEAD_MISMATCH" });
    await expect(fixture.service.acquireMutationAuthority({
      ...authorityInput(fixture, [{ path: "src/app.ts", kind: "file" }]),
      requestId: "REQ-wrong-task-request",
      taskRequestId: "R-9999",
    })).rejects.toMatchObject({ code: "MUTATION_REQUIRES_TASK_BINDING" });
    expect(fixture.database.prepare([
      "SELECT task_id, task_request_id FROM runs WHERE run_id = ?",
    ].join(" ")).get(fixture.runId)).toEqual({
      task_id: fixture.taskId,
      task_request_id: "R-0001",
    });
  });

  it("blocks unjournaled dirt without resetting or binding the run", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.repositoryPath, "keep-me.txt"), "external work\n", "utf8");

    await expect(fixture.service.acquireMutationAuthority(authorityInput(fixture, [
      { path: "src/app.ts", kind: "file" },
    ]))).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
      details: { workingTreeChanges: ["?? keep-me.txt"] },
    });

    expect(await git(fixture.repositoryPath, ["status", "--porcelain", "--untracked-files=all"]))
      .toBe("?? keep-me.txt");
    expect(fixture.database.prepare(
      "SELECT task_id, task_request_id FROM runs WHERE run_id = ?",
    ).get(fixture.runId)).toEqual({
      task_id: fixture.taskId,
      task_request_id: "R-0001",
    });
    expect(fixture.database.prepare(
      "SELECT COUNT(*) AS count FROM task_mutation_authorities",
    ).get()).toEqual({ count: 0 });
  });

  it("enforces one owner and converts an expired active lease into recovery", async () => {
    const fixture = await createFixture();
    const first = await fixture.service.acquireMutationAuthority(authorityInput(fixture, [
      { path: "src/app.ts", kind: "file" },
    ]));

    await expect(fixture.service.acquireMutationAuthority({
      ...authorityInput(fixture, [{ path: "src/other.ts", kind: "file" }]),
      requestId: "REQ-second-owner",
      at: "2026-07-17T10:05:00+05:30",
    })).rejects.toMatchObject({ code: "TASK_LOCKED", retryable: true });
    await expect(fixture.service.acquireMutationAuthority({
      ...authorityInput(fixture, [{ path: "src/other.ts", kind: "file" }]),
      requestId: "REQ-expired-owner",
      at: "2026-07-17T10:16:00+05:30",
    })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(fixture.database.prepare([
      "SELECT status, last_error FROM task_mutation_authorities WHERE authority_id = ?",
    ].join(" ")).get(first.authority.authorityId)).toEqual({
      status: "recovery_required",
      last_error: "Mutation authority lease expired before deterministic release.",
    });
  });

  it("derives direct Git provenance while excluding ignored inbox bytes", async () => {
    const fixture = await createFixture();
    const authority = await fixture.service.acquireMutationAuthority(authorityInput(fixture, [
      { path: "src", kind: "directory" },
    ]));
    await mkdir(join(fixture.repositoryPath, "src"), { recursive: true });
    await writeFile(join(fixture.repositoryPath, "src", "app.ts"), "export const ready = true;\n");
    await writeFile(
      join(fixture.repositoryPath, ".ayati", "inbox", "REF-0002-input.txt"),
      "local input bytes\n",
    );

    const verified = await fixture.service.verifyMutation(verificationInput(authority.authority));

    expect(verified).toEqual({
      authorityId: authority.authority.authorityId,
      status: "verified",
      verified: true,
      outcome: "verified_changes",
      provenance: {
        created: ["src/app.ts"],
        modified: [],
        deleted: [],
        renamed: [],
        unexpectedPaths: [],
      },
    });
  });

  it("keeps unexpected partial changes and moves the lease to recovery", async () => {
    const fixture = await createFixture();
    const authority = await fixture.service.acquireMutationAuthority(authorityInput(fixture, [
      { path: "src/app.ts", kind: "file" },
    ]));
    await mkdir(join(fixture.repositoryPath, "src"), { recursive: true });
    await writeFile(join(fixture.repositoryPath, "src", "app.ts"), "expected\n");
    await writeFile(join(fixture.repositoryPath, "other.txt"), "unexpected\n");

    const result = await fixture.service.verifyMutation(verificationInput(authority.authority));

    expect(result).toMatchObject({
      status: "recovery_required",
      verified: false,
      outcome: "unexpected_changes",
      provenance: {
        created: ["other.txt", "src/app.ts"],
        unexpectedPaths: ["other.txt"],
      },
    });
    expect(await git(fixture.repositoryPath, ["status", "--porcelain", "--untracked-files=all"]))
      .toContain("other.txt");
  });

  it("releases failed no-change work but recovers failed work with changes", async () => {
    const cleanFixture = await createFixture();
    const cleanAuthority = await cleanFixture.service.acquireMutationAuthority(
      authorityInput(cleanFixture, [{ path: "src/app.ts", kind: "file" }]),
    );
    const cleanResult = await cleanFixture.service.verifyMutation({
      ...verificationInput(cleanAuthority.authority),
      toolStatus: "failed",
    });
    expect(cleanResult).toMatchObject({
      status: "released",
      verified: false,
      outcome: "no_changes",
    });

    const dirtyFixture = await createFixture();
    const dirtyAuthority = await dirtyFixture.service.acquireMutationAuthority(
      authorityInput(dirtyFixture, [{ path: "src/app.ts", kind: "file" }]),
    );
    await mkdir(join(dirtyFixture.repositoryPath, "src"), { recursive: true });
    await writeFile(join(dirtyFixture.repositoryPath, "src", "app.ts"), "partial\n");
    const dirtyResult = await dirtyFixture.service.verifyMutation({
      ...verificationInput(dirtyAuthority.authority),
      toolStatus: "failed",
    });
    expect(dirtyResult).toMatchObject({
      status: "recovery_required",
      verified: false,
      outcome: "failed_with_changes",
      provenance: { created: ["src/app.ts"] },
    });
  });

  it("does not exclude the tracked inbox placeholder from provenance", async () => {
    const fixture = await createFixture();
    const authority = await fixture.service.acquireMutationAuthority(authorityInput(fixture, [
      { path: "src/app.ts", kind: "file" },
    ]));
    await writeFile(join(fixture.repositoryPath, ".ayati", "inbox", ".gitkeep"), "changed\n");

    const result = await fixture.service.verifyMutation(verificationInput(authority.authority));

    expect(result).toMatchObject({
      status: "recovery_required",
      outcome: "unexpected_changes",
      provenance: {
        modified: [".ayati/inbox/.gitkeep"],
        unexpectedPaths: [".ayati/inbox/.gitkeep"],
      },
    });
  });

  it("rejects broad or reserved targets before authorization", async () => {
    const fixture = await createFixture();
    for (const [index, path] of [".", ".git/config", ".ayati/task.md"].entries()) {
      await expect(fixture.service.acquireMutationAuthority({
        ...authorityInput(fixture, [{ path, kind: "file" }]),
        requestId: "REQ-reserved-" + index,
      })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    }
    expect(fixture.database.prepare(
      "SELECT task_id, task_request_id FROM runs WHERE run_id = ?",
    ).get(fixture.runId)).toEqual({
      task_id: fixture.taskId,
      task_request_id: "R-0001",
    });
  });

  it("detects external HEAD changes", async () => {
    const fixture = await createFixture();
    const authority = await fixture.service.acquireMutationAuthority(authorityInput(fixture, [
      { path: "src/app.ts", kind: "file" },
    ]));
    await writeFile(join(fixture.repositoryPath, "outside.txt"), "external commit\n");
    await git(fixture.repositoryPath, ["add", "--", "outside.txt"]);
    await git(fixture.repositoryPath, ["commit", "-m", "external change"]);

    await expect(fixture.service.verifyMutation(
      verificationInput(authority.authority),
    )).rejects.toMatchObject({ code: "TASK_HEAD_MISMATCH" });
  });
});

interface Fixture {
  service: SqliteGitContextService;
  database: ContextDatabase;
  sessionId: string;
  conversationId: string;
  runId: string;
  taskId: string;
  taskHead: string;
  repositoryPath: string;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "ayati-simple-mutation-"));
  temporaryDirectories.push(root);
  const database = await ContextDatabase.open({ path: join(root, "context.db") });
  const workspaceRoot = join(root, "workspace");
  const service = new SqliteGitContextService({
    database,
    dataRoot: root,
    workspaceRoot,
    now: () => at,
  });
  services.push(service);
  const prepared = await service.prepareContextTurn({
    requestId: "REQ-prepare",
    date: "2026-07-17",
    timezone: "Asia/Kolkata",
    agentId: "local",
    role: "user",
    content: "Modify the simple task repository.",
    at: "2026-07-17T10:00:01+05:30",
  });
  const selected = await service.createTaskForRun({
    requestId: "REQ-create-task",
    sessionId: prepared.session.sessionId,
    conversationId: prepared.conversation.conversationId,
    runId: prepared.run.runId,
    title: "Direct mutation task",
    objective: "Safely mutate one normal Git task repository.",
    placement: { mode: "managed" },
    at: "2026-07-17T10:00:02+05:30",
  });
  return {
    service,
    database,
    sessionId: prepared.session.sessionId,
    conversationId: prepared.conversation.conversationId,
    runId: prepared.run.runId,
    taskId: selected.task.taskId,
    taskHead: selected.task.head,
    repositoryPath: selected.task.repositoryPath,
  };
}

function authorityInput(
  fixture: Fixture,
  targets: Array<{ path: string; kind: "file" | "directory" }>,
) {
  return {
    requestId: "REQ-v1-authority",
    sessionId: fixture.sessionId,
    runId: fixture.runId,
    taskId: fixture.taskId,
    taskRequestId: "R-0001",
    expectedTaskHead: fixture.taskHead,
    targets,
    at: "2026-07-17T10:01:00+05:30",
  } as const;
}

function verificationInput(authority: { authorityId: string; lockToken: string }) {
  return {
    requestId: "REQ-v1-verify",
    authorityId: authority.authorityId,
    lockToken: authority.lockToken,
    toolStatus: "completed" as const,
    at: "2026-07-17T10:02:00+05:30",
  };
}

async function git(repositoryPath: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd: repositoryPath, encoding: "utf8" });
  return result.stdout.trim();
}
