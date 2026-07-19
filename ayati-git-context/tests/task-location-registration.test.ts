import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PrepareContextTurnResponse, RunWorkStateInput } from "../src/contracts.js";
import { ContextDatabase } from "../src/database/database.js";
import { SqliteGitContextService } from "../src/services/sqlite-git-context-service.js";
import { git } from "./simple-task-repository-fixtures.js";

const roots: string[] = [];
const services: SqliteGitContextService[] = [];
const AT = "2026-07-19T10:00:00.000Z";

afterEach(async () => {
  await Promise.all(services.splice(0).map(async (service) => await service.close()));
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

describe("trusted task directory registration", () => {
  it("registers an empty requested directory without moving it", async () => {
    const fixture = await createFixture();
    const directory = join(fixture.workspaceRoot, "learning-journal");
    await mkdir(directory, { recursive: true });
    const prepared = await prepare(fixture.service, "empty", "Use this folder for my learning journal.");

    const inspection = await inspect(fixture.service, prepared, directory, "empty");
    const selected = await createRequested(fixture.service, prepared, directory);

    expect(inspection).toMatchObject({
      canonicalPath: directory,
      kind: "empty_directory",
      proposedPaths: [],
    });
    expect(selected.task).toMatchObject({
      repositoryPath: directory,
      workingPath: directory,
      placement: "requested",
    });
    expect(selected.task.registrationHeadBefore).toBeUndefined();
    expect(await git(directory, ["rev-list", "--count", "HEAD"])).toBe("1");
    expect(await git(directory, ["status", "--porcelain", "--untracked-files=all"])).toBe("");
    expect(await readFile(join(directory, ".ayati", ".gitignore"), "utf8"))
      .toContain("inbox/*");
  });

  it("registers a directory under an explicit trusted root outside the workspace", async () => {
    const fixture = await createFixture({ externalTrustedRoot: true });
    if (!fixture.externalTrustedRoot) throw new Error("Expected an external trusted root.");
    const directory = join(fixture.externalTrustedRoot, "long-running-study");
    await mkdir(directory, { recursive: true });
    const prepared = await prepare(fixture.service, "external", "Use my study directory.");

    const inspection = await inspect(fixture.service, prepared, directory, "external");
    const selected = await createRequested(fixture.service, prepared, directory);

    expect(inspection).toMatchObject({
      canonicalPath: directory,
      trustedRoot: fixture.externalTrustedRoot,
      kind: "empty_directory",
    });
    expect(selected.task).toMatchObject({
      repositoryPath: directory,
      placement: "requested",
    });
  });

  it("rejects reserved managed and Ayati namespaces before changing user files", async () => {
    const fixture = await createFixture();
    const managedDirectory = join(fixture.workspaceRoot, "tasks", "user-folder");
    const ayatiDirectory = join(fixture.workspaceRoot, "existing-ayati-folder");
    await mkdir(managedDirectory, { recursive: true });
    await mkdir(join(ayatiDirectory, ".ayati"), { recursive: true });
    await writeFile(join(ayatiDirectory, ".ayati", "notes.md"), "user data\n", "utf8");
    const managedRun = await prepare(fixture.service, "reserved-managed", "Use this folder.");

    await expect(inspect(
      fixture.service,
      managedRun,
      managedDirectory,
      "reserved-managed",
    )).rejects.toMatchObject({ code: "TASK_REPOSITORY_INVALID" });
    await fixture.service.finalizeRun({
      requestId: "REQ-reserved-managed-finalize",
      sessionId: managedRun.session.sessionId,
      runId: managedRun.run.runId,
      outcome: "failed",
      stopReason: "failed",
      assistantResponse: "The reserved directory cannot be registered.",
      conversationSummary: "Registration was rejected before mutation.",
      summary: "Reserved task root rejected.",
      validation: "failed",
      workState: workState(),
      at: "2026-07-19T10:01:00.000Z",
    });
    const ayatiRun = await prepare(
      fixture.service,
      "reserved-ayati",
      "Use this other folder.",
      "2026-07-19T10:02:00.000Z",
    );
    await expect(inspect(
      fixture.service,
      ayatiRun,
      ayatiDirectory,
      "reserved-ayati",
    )).rejects.toMatchObject({ code: "TASK_REPOSITORY_INVALID" });

    expect(await readFile(join(ayatiDirectory, ".ayati", "notes.md"), "utf8"))
      .toBe("user data\n");
    expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM tasks").get())
      .toEqual({ count: 0 });
  });

  it("adds one identity commit to a clean existing Git repository", async () => {
    const fixture = await createFixture();
    const directory = join(fixture.workspaceRoot, "existing-project");
    await mkdir(directory, { recursive: true });
    await git(directory, ["init", "--initial-branch=trunk"]);
    await git(directory, ["config", "user.name", "Existing User"]);
    await git(directory, ["config", "user.email", "existing@example.invalid"]);
    await writeFile(join(directory, "README.md"), "# Existing project\n", "utf8");
    await writeFile(join(directory, ".gitignore"), "local.tmp\n", "utf8");
    await git(directory, ["add", "--", "README.md", ".gitignore"]);
    await git(directory, ["commit", "-m", "initial project"]);
    const headBefore = await git(directory, ["rev-parse", "HEAD"]);
    const prepared = await prepare(fixture.service, "clean-git", "Continue this existing project.");

    const inspection = await inspect(fixture.service, prepared, directory, "clean-git");
    const selected = await createRequested(fixture.service, prepared, directory);

    expect(inspection).toMatchObject({
      kind: "clean_git_repository",
      branch: "trunk",
      head: headBefore,
    });
    expect(selected.task).toMatchObject({
      repositoryPath: directory,
      branch: "trunk",
      placement: "requested",
      registrationHeadBefore: headBefore,
    });
    expect(await git(directory, ["rev-parse", "HEAD^"])).toBe(headBefore);
    expect(await git(directory, ["rev-list", "--count", "HEAD"])).toBe("2");
    expect(await readFile(join(directory, "README.md"), "utf8")).toBe("# Existing project\n");
    expect(await readFile(join(directory, ".gitignore"), "utf8")).toBe("local.tmp\n");
    expect(await git(directory, ["config", "user.name"])).toBe("Existing User");
    expect(await git(directory, ["config", "user.email"])).toBe("existing@example.invalid");
    expect(await git(directory, ["status", "--porcelain", "--untracked-files=all"])).toBe("");

    const finalized = await fixture.service.finalizeRun({
      requestId: prepared.run.runId + ":finalize",
      sessionId: prepared.session.sessionId,
      runId: prepared.run.runId,
      outcome: "done",
      stopReason: "completed",
      assistantResponse: "The registered project is ready for continued work.",
      conversationSummary: "The clean existing project was registered in place.",
      summary: "Registered project continuity is ready.",
      validation: "passed",
      workState: {
        ...workState(),
        status: "done",
        summary: "Registered project continuity is ready.",
      },
      task: {
        completion: {
          accepted: true,
          assets: [],
          missing: [],
          failures: [],
          criteria: [{
            criterion: "The existing repository is registered and validates cleanly.",
            passed: true,
            evidence: "Git Context repository validation passed.",
          }],
        },
      },
      at: "2026-07-19T10:03:00.000Z",
    });
    expect(finalized.commit.status).toBe("committed");
    expect(await git(directory, ["rev-list", "--count", "HEAD"])).toBe("3");
    expect(await readFile(join(directory, ".gitignore"), "utf8")).toBe("local.tmp\n");
    expect(await git(directory, ["config", "user.name"])).toBe("Existing User");
    expect(await git(directory, ["status", "--porcelain", "--untracked-files=all"])).toBe("");
  });

  it("registers a clean Git repository with an unborn branch", async () => {
    const fixture = await createFixture();
    const directory = join(fixture.workspaceRoot, "new-git-project");
    await mkdir(directory, { recursive: true });
    await git(directory, ["init", "--initial-branch=develop"]);
    const prepared = await prepare(fixture.service, "unborn-git", "Use this new Git project.");

    const inspection = await inspect(fixture.service, prepared, directory, "unborn-git");
    const selected = await createRequested(fixture.service, prepared, directory);

    expect(inspection).toMatchObject({
      kind: "clean_git_repository",
      branch: "develop",
    });
    expect(inspection.head).toBeUndefined();
    expect(selected.task).toMatchObject({
      placement: "requested",
      branch: "develop",
      repositoryPath: directory,
    });
    expect(await git(directory, ["rev-list", "--count", "HEAD"])).toBe("1");
    expect(await git(directory, ["status", "--porcelain", "--untracked-files=all"])).toBe("");
  });

  it("rejects a dirty Git repository without allocating a task", async () => {
    const fixture = await createFixture();
    const directory = join(fixture.workspaceRoot, "dirty-project");
    await mkdir(directory, { recursive: true });
    await git(directory, ["init", "--initial-branch=main"]);
    await git(directory, ["config", "user.name", "Existing User"]);
    await git(directory, ["config", "user.email", "existing@example.invalid"]);
    await writeFile(join(directory, "tracked.txt"), "initial\n", "utf8");
    await git(directory, ["add", "--", "tracked.txt"]);
    await git(directory, ["commit", "-m", "initial"]);
    await writeFile(join(directory, "tracked.txt"), "changed\n", "utf8");
    const prepared = await prepare(fixture.service, "dirty", "Use this dirty project.");

    const inspection = await inspect(fixture.service, prepared, directory, "dirty");
    await expect(createRequested(fixture.service, prepared, directory)).rejects.toMatchObject({
      code: "TASK_REPOSITORY_DIRTY",
    });

    expect(inspection).toMatchObject({
      kind: "dirty_git_repository",
      changes: expect.arrayContaining([expect.stringContaining("tracked.txt")]),
    });
    expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM tasks").get())
      .toEqual({ count: 0 });
    expect(await readFile(join(directory, "tracked.txt"), "utf8")).toBe("changed\n");
  });

  it("imports only an explicitly approved non-Git baseline in the next run", async () => {
    const fixture = await createFixture();
    const directory = join(fixture.workspaceRoot, "research-notes");
    await mkdir(join(directory, "node_modules", "package"), { recursive: true });
    await writeFile(join(directory, "notes.md"), "# Solar notes\n", "utf8");
    await writeFile(join(directory, ".env"), "SECRET=preserved\n", "utf8");
    await writeFile(join(directory, "node_modules", "package", "index.js"), "module.exports = {}\n", "utf8");
    const approvalRun = await prepare(fixture.service, "approval", "Turn these notes into durable work.");
    const inspection = await inspect(fixture.service, approvalRun, directory, "approval");
    if (!inspection.registrationApprovalId) throw new Error("Expected registration approval receipt.");
    await fixture.service.finalizeRun({
      requestId: "REQ-registration-approval-finalize",
      sessionId: approvalRun.session.sessionId,
      runId: approvalRun.run.runId,
      outcome: "needs_user_input",
      stopReason: "needs_user_input",
      assistantResponse: "Please approve importing notes.md while excluding .env and node_modules.",
      conversationSummary: "The existing non-Git directory was inspected for registration.",
      summary: "Waiting for explicit baseline approval.",
      validation: "not_applicable",
      workState: {
        ...workState(),
        status: "needs_user_input",
        summary: "Waiting for explicit baseline approval.",
        userInputNeeded: ["Approve the proposed registration baseline."],
      },
      at: "2026-07-19T10:01:00.000Z",
    });
    const creationRun = await prepare(
      fixture.service,
      "approved",
      "I approve that exact baseline. Continue.",
      "2026-07-19T10:02:00.000Z",
    );

    const selected = await createRequested(
      fixture.service,
      creationRun,
      directory,
      inspection.registrationApprovalId,
      "2026-07-19T10:02:01.000Z",
    );

    expect(inspection).toMatchObject({
      kind: "non_git_directory",
      proposedPaths: ["notes.md"],
      excludedPaths: expect.arrayContaining([".env", "node_modules/"]),
    });
    expect(selected.task).toMatchObject({ placement: "requested", repositoryPath: directory });
    expect((await git(directory, ["ls-files"])).split("\n"))
      .toEqual(expect.arrayContaining(["notes.md", ".ayati/task.md"]));
    expect(await git(directory, ["ls-files", "--", ".env", "node_modules"])).toBe("");
    expect(await readFile(join(directory, ".env"), "utf8")).toBe("SECRET=preserved\n");
    expect(await git(directory, ["status", "--porcelain", "--untracked-files=all"])).toBe("");
  });

  it("invalidates a non-Git approval when the proposed baseline changes", async () => {
    const fixture = await createFixture();
    const directory = join(fixture.workspaceRoot, "changing-notes");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "notes.md"), "version one\n", "utf8");
    const approvalRun = await prepare(fixture.service, "changing", "Register these notes.");
    const inspection = await inspect(fixture.service, approvalRun, directory, "changing");
    if (!inspection.registrationApprovalId) throw new Error("Expected registration approval receipt.");
    await fixture.service.finalizeRun({
      requestId: "REQ-registration-changing-finalize",
      sessionId: approvalRun.session.sessionId,
      runId: approvalRun.run.runId,
      outcome: "needs_user_input",
      stopReason: "needs_user_input",
      assistantResponse: "Approve importing notes.md?",
      conversationSummary: "The baseline needs approval.",
      summary: "Waiting for approval.",
      validation: "not_applicable",
      workState: {
        ...workState(),
        status: "needs_user_input",
        userInputNeeded: ["Approve the proposed registration baseline."],
      },
      at: "2026-07-19T10:01:00.000Z",
    });
    await writeFile(join(directory, "notes.md"), "version two\n", "utf8");
    const creationRun = await prepare(
      fixture.service,
      "changing-approved",
      "Approved.",
      "2026-07-19T10:02:00.000Z",
    );

    await expect(createRequested(
      fixture.service,
      creationRun,
      directory,
      inspection.registrationApprovalId,
      "2026-07-19T10:02:01.000Z",
    )).rejects.toMatchObject({ code: "INVALID_REQUEST" });

    expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM tasks").get())
      .toEqual({ count: 0 });
    await expect(readFile(join(directory, ".git", "HEAD"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function createFixture(options: { externalTrustedRoot?: boolean } = {}): Promise<{
  root: string;
  workspaceRoot: string;
  externalTrustedRoot?: string;
  database: ContextDatabase;
  service: SqliteGitContextService;
}> {
  const root = await mkdtemp(join(tmpdir(), "ayati-task-registration-"));
  roots.push(root);
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  const externalTrustedRoot = options.externalTrustedRoot
    ? join(root, "external-work")
    : undefined;
  if (externalTrustedRoot) await mkdir(externalTrustedRoot, { recursive: true });
  const database = await ContextDatabase.open({ path: join(root, "context.sqlite") });
  const service = new SqliteGitContextService({
    database,
    dataRoot: join(root, "session-data"),
    workspaceRoot,
    trustedRoots: externalTrustedRoot ? [externalTrustedRoot] : [],
    now: () => AT,
  });
  services.push(service);
  return {
    root,
    workspaceRoot,
    ...(externalTrustedRoot ? { externalTrustedRoot } : {}),
    database,
    service,
  };
}

async function prepare(
  service: SqliteGitContextService,
  suffix: string,
  content: string,
  at = AT,
): Promise<PrepareContextTurnResponse> {
  return await service.prepareContextTurn({
    requestId: "REQ-registration-prepare-" + suffix,
    date: "2026-07-19",
    timezone: "UTC",
    agentId: "local",
    role: "user",
    content,
    at,
  });
}

async function inspect(
  service: SqliteGitContextService,
  prepared: PrepareContextTurnResponse,
  workingDirectory: string,
  suffix: string,
) {
  return await service.inspectTaskLocation({
    requestId: "REQ-registration-inspect-" + suffix,
    sessionId: prepared.session.sessionId,
    conversationId: prepared.conversation.conversationId,
    runId: prepared.run.runId,
    workingDirectory,
    at: AT,
  });
}

async function createRequested(
  service: SqliteGitContextService,
  prepared: PrepareContextTurnResponse,
  workingDirectory: string,
  registrationApprovalId?: string,
  at = AT,
) {
  return await service.createTaskForRun({
    requestId: prepared.run.runId + ":create-task",
    sessionId: prepared.session.sessionId,
    conversationId: prepared.conversation.conversationId,
    runId: prepared.run.runId,
    title: "Registered durable work",
    objective: "Continue this work reliably across sessions.",
    placement: {
      mode: "requested",
      workingDirectory,
      ...(registrationApprovalId ? { registrationApprovalId } : {}),
    },
    at,
  });
}

function workState(): RunWorkStateInput {
  return {
    status: "not_done",
    summary: "Run is active.",
    openWork: [],
    blockers: [],
    facts: [],
    evidence: [],
    artifacts: [],
    nextStep: null,
    userInputNeeded: [],
  };
}
