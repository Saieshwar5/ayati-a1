import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ContextDatabase } from "../src/database/database.js";
import { readMutationProvenance } from "../src/git/mutation-provenance.js";
import { resolveMutationTargets } from "../src/mutations/path-authority.js";
import { SqliteGitContextService } from "../src/services/sqlite-git-context-service.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const services: SqliteGitContextService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map(async (service) => {
    await service.close();
  }));
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => {
    await rm(path, { recursive: true, force: true });
  }));
});

describe("task checkout mutation boundary", () => {
  it("acquires one run-scoped authority and promotes the run to task ownership", async () => {
    const fixture = await createReadyRun();
    const input = authorityInput(fixture, [
      { path: "src/app.ts", kind: "file" as const },
      { path: "tests", kind: "directory" as const },
    ]);

    const acquired = await fixture.service.acquireMutationAuthority(input);
    const retried = await fixture.service.acquireMutationAuthority(input);

    expect(retried).toEqual(acquired);
    expect(acquired.authority).toMatchObject({
      sessionId: fixture.sessionId,
      runId: fixture.runId,
      taskId: fixture.taskId,
      checkoutPath: fixture.checkoutPath,
      beforeHead: fixture.taskHead,
      branch: "main",
      status: "active",
      targets: [
        { path: "src/app.ts", kind: "file" },
        { path: "tests", kind: "directory" },
      ],
    });
    expect(acquired.authority.lockToken.length).toBeGreaterThan(30);
    const context = await fixture.service.getActiveContext({
      sessionId: fixture.sessionId,
    });
    expect(context.run?.run).toMatchObject({
      runId: fixture.runId,
      runClass: "task",
      taskId: fixture.taskId,
    });
    const row = fixture.database.prepare([
      "SELECT lock_token_hash, status FROM task_mutation_authorities",
      "WHERE authority_id = ?",
    ].join(" ")).get(acquired.authority.authorityId) as {
      lock_token_hash: string;
      status: string;
    };
    expect(row.lock_token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(row.lock_token_hash).not.toContain(acquired.authority.lockToken);
    expect(row.status).toBe("active");
  });

  it("rejects traversal and engine-owned mutation targets before run promotion", async () => {
    const fixture = await createReadyRun();

    await expect(fixture.service.acquireMutationAuthority(authorityInput(fixture, [
      { path: "../other-task/file.ts", kind: "file" },
    ]))).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(fixture.service.acquireMutationAuthority({
      ...authorityInput(fixture, [{ path: ".ayati/task.md", kind: "file" }]),
      requestId: "REQ-authority-engine-path",
    })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    const context = await fixture.service.getActiveContext({ sessionId: fixture.sessionId });
    expect(context.run?.run.runClass).toBe("session");
    expect(fixture.database.prepare(
      "SELECT COUNT(*) AS count FROM task_mutation_authorities",
    ).get()).toMatchObject({ count: 0 });
  });

  it("prevents a second mutation owner for the same task", async () => {
    const fixture = await createReadyRun();
    await fixture.service.acquireMutationAuthority(authorityInput(fixture, [
      { path: "index.html", kind: "file" },
    ]));

    await expect(fixture.service.acquireMutationAuthority({
      ...authorityInput(fixture, [{ path: "styles.css", kind: "file" }]),
      requestId: "REQ-second-authority",
    })).rejects.toMatchObject({
      code: "TASK_LOCKED",
      retryable: true,
    });
  });

  it("verifies authorized changes from Git and keeps the lock for checkpointing", async () => {
    const fixture = await createReadyRun();
    const acquireInput = authorityInput(fixture, [
      { path: "src", kind: "directory" },
    ]);
    const authority = await fixture.service.acquireMutationAuthority(acquireInput);
    await mkdir(join(fixture.checkoutPath, "src"), { recursive: true });
    await writeFile(join(fixture.checkoutPath, "src", "app.ts"), "export const ready = true;\n");
    await expect(fixture.service.acquireMutationAuthority(acquireInput)).resolves.toEqual(authority);
    const input = verificationInput(authority.authority, "completed");

    const verified = await fixture.service.verifyMutation(input);
    const retried = await fixture.service.verifyMutation(input);

    expect(retried).toEqual(verified);
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
    await expect(fixture.service.acquireMutationAuthority({
      ...acquireInput,
      requestId: "REQ-authority-after-verify",
    })).rejects.toMatchObject({ code: "TASK_LOCKED" });
  });

  it("commits verified paths, persists canonical HEAD and stages the session gitlink", async () => {
    const fixture = await createReadyRun();
    const sessionHeadBefore = await git(fixture.sessionRepository, ["rev-parse", "HEAD"]);
    const authority = await fixture.service.acquireMutationAuthority(authorityInput(fixture, [
      { path: "src", kind: "directory" },
    ]));
    await mkdir(join(fixture.checkoutPath, "src"), { recursive: true });
    await writeFile(join(fixture.checkoutPath, "src", "app.ts"), "export const ready = true;\n");
    await fixture.service.verifyMutation(verificationInput(authority.authority, "completed"));
    const input = {
      requestId: "REQ-checkpoint",
      authorityId: authority.authority.authorityId,
      lockToken: authority.authority.lockToken,
      purpose: "Create the application entry point.",
      conversationId: fixture.conversationId,
      conversationHash: "sha256:" + "a".repeat(64),
      at: "2026-07-12T10:00:07+05:30",
    };

    const checkpoint = await fixture.service.checkpointMutation(input);
    await expect(fixture.service.checkpointMutation(input)).resolves.toEqual(checkpoint);

    expect(checkpoint).toMatchObject({
      taskId: fixture.taskId,
      runId: fixture.runId,
      beforeHead: fixture.taskHead,
      stagedPaths: ["src/app.ts"],
      sessionGitlinkUpdated: true,
    });
    expect(await git(fixture.checkoutPath, ["status", "--porcelain"])).toBe("");
    expect(await git(fixture.canonicalRepository, ["rev-parse", "refs/heads/main"]))
      .toBe(checkpoint.checkpointHead);
    expect(await git(fixture.sessionRepository, ["rev-parse", "HEAD"]))
      .toBe(sessionHeadBefore);
    expect(await git(fixture.sessionRepository, [
      "ls-files", "--stage", "--", "tasks/" + fixture.taskId,
    ])).toContain(checkpoint.checkpointHead);
    expect(await git(fixture.checkoutPath, ["show", "-s", "--format=%B", "HEAD"]))
      .toContain("Ayati-Event: task_checkpoint");
    expect(fixture.database.prepare([
      "SELECT status FROM task_mutation_authorities WHERE authority_id = ?",
    ].join(" ")).get(authority.authority.authorityId)).toMatchObject({ status: "released" });
    expect((await fixture.service.getTask({ taskId: fixture.taskId })).task.head)
      .toBe(checkpoint.checkpointHead);
  });

  it("refuses verified secrets before creating a checkpoint commit", async () => {
    const fixture = await createReadyRun();
    const authority = await fixture.service.acquireMutationAuthority(authorityInput(fixture, [
      { path: ".env", kind: "file" },
    ]));
    await writeFile(join(fixture.checkoutPath, ".env"), "TOKEN=secret\n");
    await fixture.service.verifyMutation(verificationInput(authority.authority, "completed"));

    await expect(fixture.service.checkpointMutation({
      requestId: "REQ-checkpoint-secret",
      authorityId: authority.authority.authorityId,
      lockToken: authority.authority.lockToken,
      purpose: "Store local configuration.",
      conversationId: fixture.conversationId,
      conversationHash: "sha256:" + "b".repeat(64),
      at: "2026-07-12T10:00:07+05:30",
    })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(await git(fixture.checkoutPath, ["rev-parse", "HEAD"])).toBe(fixture.taskHead);
  });

  it("stages bounded task-run evidence without duplicating task file contents", async () => {
    const fixture = await createReadyRun();
    await fixture.service.recordRunStep({
      requestId: "REQ-step-write",
      sessionId: fixture.sessionId,
      runId: fixture.runId,
      step: 1,
      tool: "write_files",
      purpose: "Create the main application file.",
      status: "completed",
      boundedInput: {
        files: [{ path: "src/app.ts", content: "export const privateValue = 'do-not-copy';\n" }],
      },
      boundedOutput: { path: "src/app.ts", content: "export const privateValue = 'do-not-copy';\n" },
      outputHash: "sha256:" + "c".repeat(64),
      verification: {
        passed: true,
        provenance: { created: ["src/app.ts"], modified: [], deleted: [], renamed: [] },
      },
      workState: { summary: "Application entry point created." },
      at: "2026-07-12T10:00:04+05:30",
    });
    const authority = await fixture.service.acquireMutationAuthority(authorityInput(fixture, [
      { path: "src", kind: "directory" },
    ]));
    await mkdir(join(fixture.checkoutPath, "src"), { recursive: true });
    await writeFile(
      join(fixture.checkoutPath, "src", "app.ts"),
      "export const privateValue = 'do-not-copy';\n",
    );
    await fixture.service.verifyMutation(verificationInput(authority.authority, "completed"));
    const checkpoint = await fixture.service.checkpointMutation({
      requestId: "REQ-checkpoint-evidence",
      authorityId: authority.authority.authorityId,
      lockToken: authority.authority.lockToken,
      purpose: "Create the main application file.",
      conversationId: fixture.conversationId,
      conversationHash: "sha256:" + "d".repeat(64),
      at: "2026-07-12T10:00:07+05:30",
    });
    const sessionHead = await git(fixture.sessionRepository, ["rev-parse", "HEAD"]);
    const input = {
      requestId: "REQ-run-evidence",
      sessionId: fixture.sessionId,
      runId: fixture.runId,
      taskId: fixture.taskId,
      expectedHead: sessionHead,
      at: "2026-07-12T10:00:08+05:30",
    };

    const snapshot = await fixture.service.snapshotTaskRunEvidence(input);
    await expect(fixture.service.snapshotTaskRunEvidence(input)).resolves.toEqual(snapshot);

    expect(snapshot).toMatchObject({
      stepCount: 1,
      taskHeadBefore: fixture.taskHead,
      taskHeadAfter: checkpoint.checkpointHead,
      sessionHeadUnchanged: true,
      staged: true,
    });
    const runJson = JSON.parse(await readFile(
      join(fixture.sessionRepository, snapshot.runFile),
      "utf8",
    )) as Record<string, unknown>;
    expect(runJson).toMatchObject({
      runId: fixture.runId,
      taskId: fixture.taskId,
      conversationId: fixture.conversationId,
      status: "running",
      taskHeadBefore: fixture.taskHead,
      taskHeadAfter: checkpoint.checkpointHead,
      stepCount: 1,
    });
    const stepsText = await readFile(join(fixture.sessionRepository, snapshot.stepsFile), "utf8");
    const step = JSON.parse(stepsText.trim()) as Record<string, unknown>;
    expect(step).toMatchObject({
      step: 1,
      tool: "write_files",
      purpose: "Create the main application file.",
      status: "completed",
      outputHash: "sha256:" + "c".repeat(64),
      verification: { passed: true },
      workState: { summary: "Application entry point created." },
    });
    expect(stepsText).not.toContain("do-not-copy");
    expect(stepsText).toContain("content_stored_in_task_git");
    expect(await git(fixture.sessionRepository, ["rev-parse", "HEAD"])).toBe(sessionHead);
    expect(await git(fixture.sessionRepository, [
      "diff", "--cached", "--name-only", "--", snapshot.runFile, snapshot.stepsFile,
    ])).toBe(snapshot.runFile + "\n" + snapshot.stepsFile);

    const finalizationInput = {
      requestId: "REQ-finalize-run",
      sessionId: fixture.sessionId,
      runId: fixture.runId,
      taskId: fixture.taskId,
      expectedHead: sessionHead,
      outcome: "done" as const,
      summary: "Created and verified the main application file.",
      validation: "passed" as const,
      completion: {
        accepted: true,
        assets: [{
          path: "src/app.ts",
          kind: "file" as const,
          description: "Main application entry point.",
          verified: true,
        }],
        missing: [],
        failures: [],
        criteria: [{ criterion: "Application file exists.", passed: true }],
      },
      assistantResponse: "The application entry point is ready and verified.",
      at: "2026-07-12T10:00:09+05:30",
    };
    const finalized = await fixture.service.finalizeTaskRun(finalizationInput);
    await expect(fixture.service.finalizeTaskRun(finalizationInput)).resolves.toEqual(finalized);

    expect(finalized).toMatchObject({
      runId: fixture.runId,
      taskId: fixture.taskId,
      outcome: "done",
      taskHeadBefore: fixture.taskHead,
      conversationHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    expect(finalized.taskHeadAfter).toBe(finalized.taskFinalizationCommit);
    expect(await git(fixture.canonicalRepository, ["rev-parse", "refs/heads/main"]))
      .toBe(finalized.taskFinalizationCommit);
    expect(await git(fixture.sessionRepository, ["rev-parse", "HEAD"]))
      .toBe(finalized.sessionCommit);
    expect(await git(fixture.checkoutPath, ["show", "-s", "--format=%B", "HEAD"]))
      .toContain("Ayati-Event: task_run_finalized");
    expect(await git(fixture.sessionRepository, ["show", "-s", "--format=%B", "HEAD"]))
      .toContain("Ayati-Event: task_run_committed");
    const finalRun = JSON.parse(await readFile(
      join(fixture.sessionRepository, finalized.runFile), "utf8",
    )) as Record<string, unknown>;
    expect(finalRun).toMatchObject({
      status: "completed",
      outcome: "done",
      validation: "passed",
      summary: "Created and verified the main application file.",
      completion: {
        accepted: true,
        assets: [{
          path: "src/app.ts",
          kind: "file",
          description: "Main application entry point.",
          verified: true,
        }],
        missing: [],
        failures: [],
        criteria: [{ criterion: "Application file exists.", passed: true }],
      },
      taskHeadAfter: finalized.taskFinalizationCommit,
    });
    const conversationPath = "conversations/000001-task-" + fixture.taskId + ".md";
    expect(await readFile(join(fixture.sessionRepository, conversationPath), "utf8"))
      .toContain("The application entry point is ready and verified.");
    expect(fixture.database.prepare(
      "SELECT status FROM runs WHERE run_id = ?",
    ).get(fixture.runId)).toMatchObject({ status: "completed" });
    expect(fixture.database.prepare(
      "SELECT status, committed_sha FROM conversation_segments WHERE conversation_id = ?",
    ).get(fixture.conversationId)).toMatchObject({
      status: "committed",
      committed_sha: finalized.sessionCommit,
    });
    expect(fixture.database.prepare(
      "SELECT phase FROM task_run_finalizations WHERE run_id = ?",
    ).get(fixture.runId)).toMatchObject({ phase: "completed" });
  });

  it("marks unexpected changes for recovery without removing them", async () => {
    const fixture = await createReadyRun();
    const authority = await fixture.service.acquireMutationAuthority(authorityInput(fixture, [
      { path: "index.html", kind: "file" },
    ]));
    await writeFile(join(fixture.checkoutPath, "index.html"), "<main>Expected</main>\n");
    await writeFile(join(fixture.checkoutPath, "other.txt"), "unexpected\n");

    const result = await fixture.service.verifyMutation(
      verificationInput(authority.authority, "completed"),
    );

    expect(result).toMatchObject({
      status: "recovery_required",
      verified: false,
      outcome: "unexpected_changes",
      provenance: {
        created: ["index.html", "other.txt"],
        unexpectedPaths: ["other.txt"],
      },
    });
    expect(await git(fixture.checkoutPath, ["status", "--porcelain"])).toContain("other.txt");
  });

  it("releases a clean failed operation and allows another authority", async () => {
    const fixture = await createReadyRun();
    const first = await fixture.service.acquireMutationAuthority(authorityInput(fixture, [
      { path: "index.html", kind: "file" },
    ]));
    const released = await fixture.service.verifyMutation(
      verificationInput(first.authority, "failed"),
    );

    expect(released).toMatchObject({
      status: "released",
      verified: false,
      outcome: "no_changes",
    });
    await expect(fixture.service.acquireMutationAuthority({
      ...authorityInput(fixture, [{ path: "styles.css", kind: "file" }]),
      requestId: "REQ-next-authority",
    })).resolves.toMatchObject({
      authority: { status: "active", taskId: fixture.taskId },
    });
  });

  it("requires recovery when a failed tool leaves partial changes", async () => {
    const fixture = await createReadyRun();
    const authority = await fixture.service.acquireMutationAuthority(authorityInput(fixture, [
      { path: "index.html", kind: "file" },
    ]));
    await writeFile(join(fixture.checkoutPath, "index.html"), "partial\n");

    const result = await fixture.service.verifyMutation(
      verificationInput(authority.authority, "failed"),
    );

    expect(result).toMatchObject({
      status: "recovery_required",
      verified: false,
      outcome: "failed_with_changes",
      provenance: { created: ["index.html"] },
    });
  });

  it("rejects an invalid lock token without changing authority state", async () => {
    const fixture = await createReadyRun();
    const authority = await fixture.service.acquireMutationAuthority(authorityInput(fixture, [
      { path: "index.html", kind: "file" },
    ]));

    await expect(fixture.service.verifyMutation({
      ...verificationInput(authority.authority, "failed"),
      lockToken: "wrong-token",
    })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(fixture.database.prepare([
      "SELECT status FROM task_mutation_authorities WHERE authority_id = ?",
    ].join(" ")).get(authority.authority.authorityId)).toMatchObject({ status: "active" });
  });

  it("detects checkout HEAD changes while authority is active", async () => {
    const fixture = await createReadyRun();
    const authority = await fixture.service.acquireMutationAuthority(authorityInput(fixture, [
      { path: "index.html", kind: "file" },
    ]));
    await git(fixture.checkoutPath, ["config", "user.name", "Ayati Test"]);
    await git(fixture.checkoutPath, ["config", "user.email", "test@ayati.local"]);
    await writeFile(join(fixture.checkoutPath, "index.html"), "committed outside boundary\n");
    await git(fixture.checkoutPath, ["add", "--", "index.html"]);
    await git(fixture.checkoutPath, ["commit", "-m", "test: bypass checkpoint"]);

    await expect(fixture.service.verifyMutation(
      verificationInput(authority.authority, "completed"),
    )).rejects.toMatchObject({ code: "TASK_HEAD_MISMATCH" });
    expect(fixture.database.prepare([
      "SELECT status FROM task_mutation_authorities WHERE authority_id = ?",
    ].join(" ")).get(authority.authority.authorityId)).toMatchObject({
      status: "recovery_required",
    });
  });
});

describe("mutation path and provenance adapters", () => {
  it("rejects escaping, broken and looping symlinks", async () => {
    const checkout = await createTemporaryDirectory("ayati-mutation-path-");
    const outside = await createTemporaryDirectory("ayati-mutation-outside-");
    await symlink(outside, join(checkout, "escape"));
    await symlink(join(checkout, "missing"), join(checkout, "broken"));
    await symlink("loop", join(checkout, "loop"));

    await expect(resolveMutationTargets(checkout, [
      { path: "escape/file.txt", kind: "file" },
    ])).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(resolveMutationTargets(checkout, [
      { path: "broken/file.txt", kind: "file" },
    ])).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(resolveMutationTargets(checkout, [
      { path: "loop/file.txt", kind: "file" },
    ])).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("reports tracked renames and ignored created files", async () => {
    const checkout = await createTemporaryDirectory("ayati-provenance-");
    await git(checkout, ["init", "--initial-branch=main"]);
    await git(checkout, ["config", "user.name", "Ayati Test"]);
    await git(checkout, ["config", "user.email", "test@ayati.local"]);
    await writeFile(join(checkout, "old.txt"), "same content\n");
    await writeFile(join(checkout, "modify.txt"), "before\n");
    await writeFile(join(checkout, "delete.txt"), "remove me\n");
    await writeFile(join(checkout, ".gitignore"), "*.log\n");
    await git(checkout, [
      "add",
      "--",
      "old.txt",
      "modify.txt",
      "delete.txt",
      ".gitignore",
    ]);
    await git(checkout, ["commit", "-m", "test: initialize provenance"]);
    await rename(join(checkout, "old.txt"), join(checkout, "new.txt"));
    await writeFile(join(checkout, "modify.txt"), "after\n");
    await rm(join(checkout, "delete.txt"));
    await writeFile(join(checkout, "debug.log"), "ignored but changed\n");

    const provenance = await readMutationProvenance(checkout, [{
      path: ".",
      kind: "directory",
      resolvedPath: checkout,
    }]);

    expect(provenance.renamed).toEqual([{ from: "old.txt", to: "new.txt" }]);
    expect(provenance.created).toContain("debug.log");
    expect(provenance.modified).toEqual(["modify.txt"]);
    expect(provenance.deleted).toEqual(["delete.txt"]);
    expect(provenance.unexpectedPaths).toEqual([]);
  });
});

interface ReadyRunFixture {
  service: SqliteGitContextService;
  database: ContextDatabase;
  sessionId: string;
  runId: string;
  conversationId: string;
  taskId: string;
  taskHead: string;
  checkoutPath: string;
  sessionRepository: string;
  canonicalRepository: string;
}

async function createReadyRun(): Promise<ReadyRunFixture> {
  const directory = await createTemporaryDirectory("ayati-mutation-service-");
  const database = await ContextDatabase.open({ path: join(directory, "context.db") });
  const service = new SqliteGitContextService({
    database,
    dataRoot: directory,
    now: () => "2026-07-12T10:00:00+05:30",
  });
  services.push(service);
  const session = await service.ensureActiveSession({
    requestId: "REQ-session",
    date: "2026-07-12",
    timezone: "Asia/Kolkata",
    agentId: "local",
    at: "2026-07-12T10:00:00+05:30",
  });
  const conversation = await service.appendConversation({
    requestId: "REQ-message",
    sessionId: session.session.sessionId,
    role: "user",
    content: "Create the requested task file.",
    at: "2026-07-12T10:00:01+05:30",
  });
  const run = await service.startRun({
    requestId: "REQ-run",
    sessionId: session.session.sessionId,
    conversationId: conversation.conversation.conversationId,
    trigger: "user",
    at: "2026-07-12T10:00:02+05:30",
  });
  const task = await service.createTask({
    requestId: "REQ-task",
    sessionId: session.session.sessionId,
    title: "Mutation Boundary Task",
    objective: "Verify task-scoped mutation authority and provenance.",
    at: "2026-07-12T10:00:03+05:30",
  });
  const mount = await service.mountTask({
    requestId: "REQ-mount",
    sessionId: session.session.sessionId,
    taskId: task.task.taskId,
    at: "2026-07-12T10:00:04+05:30",
  });
  return {
    service,
    database,
    sessionId: session.session.sessionId,
    runId: run.run.runId,
    conversationId: conversation.conversation.conversationId,
    taskId: task.task.taskId,
    taskHead: task.task.head,
    checkoutPath: mount.mount.checkoutPath,
    sessionRepository: session.session.repositoryPath,
    canonicalRepository: task.task.repositoryPath,
  };
}

function authorityInput(
  fixture: ReadyRunFixture,
  targets: Array<{ path: string; kind: "file" | "directory" }>,
) {
  return {
    requestId: "REQ-authority",
    sessionId: fixture.sessionId,
    runId: fixture.runId,
    taskId: fixture.taskId,
    expectedTaskHead: fixture.taskHead,
    targets,
    at: "2026-07-12T10:00:05+05:30",
  } as const;
}

function verificationInput(
  authority: { authorityId: string; lockToken: string },
  toolStatus: "completed" | "failed",
) {
  return {
    requestId: "REQ-verify",
    authorityId: authority.authorityId,
    lockToken: authority.lockToken,
    toolStatus,
    at: "2026-07-12T10:00:06+05:30",
  } as const;
}

async function createTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function git(repositoryPath: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd: repositoryPath,
    encoding: "utf8",
  });
  return result.stdout.trim();
}
