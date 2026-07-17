import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { RunWorkStateInput } from "../src/contracts.js";
import { ContextDatabase } from "../src/database/database.js";
import { SqliteGitContextService } from "../src/services/sqlite-git-context-service.js";
import { validateTaskRepository } from "../src/tasks/task-repository-validator.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const services: SqliteGitContextService[] = [];
const at = "2026-07-17T19:00:00+05:30";

afterEach(async () => {
  await Promise.all(services.splice(0).map(async (service) => service.close()));
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

describe("V1 task end-to-end continuations", () => {
  it.each([
    {
      name: "learning",
      title: "Machine Learning Journey",
      objective: "Learn machine learning across multiple days.",
      firstPath: "lessons/foundations.md",
      secondPath: "lessons/regression.md",
      secondTitle: "Study regression",
    },
    {
      name: "website",
      title: "Coffee Shop Website",
      objective: "Build and improve one website over time.",
      firstPath: "site/index.html",
      secondPath: "site/menu.html",
      secondTitle: "Add the menu feature",
    },
    {
      name: "analysis",
      title: "Sales Analysis",
      objective: "Analyze attached sales data reproducibly.",
      firstPath: "analysis/profile.md",
      secondPath: "analysis/trends.md",
      secondTitle: "Analyze monthly trends",
    },
    {
      name: "automation",
      title: "Application Automation",
      objective: "Run approved external automation and retain safe outcomes.",
      firstPath: undefined,
      secondPath: undefined,
      secondTitle: "Submit the next approved application",
    },
  ])("keeps $name work in one mount-free repository across requests", async (scenario) => {
    const fixture = await createFixture();
    const conversation = await fixture.service.appendConversation({
      requestId: "REQ-conversation-first-" + scenario.name,
      sessionId: fixture.sessionId,
      role: "user",
      content: scenario.objective,
      at,
    });
    if (scenario.name === "analysis") {
      await registerDataset(fixture, conversation.conversation.conversationId);
    }
    const selected = await fixture.service.createTaskRun({
      requestId: "REQ-create-" + scenario.name,
      sessionId: fixture.sessionId,
      conversationId: conversation.conversation.conversationId,
      trigger: "user",
      workState: initialWorkState(),
      title: scenario.title,
      objective: scenario.objective,
      placement: { mode: "managed" },
      at,
    });
    if (scenario.name === "analysis") {
      const bound = await fixture.service.bindTaskAttachments({
        requestId: "REQ-bind-analysis",
        sessionId: fixture.sessionId,
        conversationId: conversation.conversation.conversationId,
        runId: selected.run.runId,
        taskId: selected.task.taskId,
        at: "2026-07-17T19:00:01+05:30",
      });
      expect(bound.references).toHaveLength(1);
    }

    expect(selected).toMatchObject({
      repositoryLayout: "simple_repository_v1",
      mountCreated: false,
      run: { taskRequestId: "R-0001" },
    });
    expect(selected.mount).toBeUndefined();
    expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM session_task_mounts").get())
      .toEqual({ count: 0 });
    const first = await finishRun(fixture, {
      runId: selected.run.runId,
      taskId: selected.task.taskId,
      taskRequestId: "R-0001",
      taskHead: selected.task.head,
      path: scenario.firstPath,
      summary: scenario.name === "automation"
        ? "Approved external action confirmed as APP-1042."
        : "Completed the first " + scenario.name + " outcome.",
      requestPrefix: scenario.name + "-first",
    });

    const laterConversation = await fixture.service.appendConversation({
      requestId: "REQ-conversation-second-" + scenario.name,
      sessionId: fixture.sessionId,
      role: "user",
      content: scenario.secondTitle,
      at: "2026-07-18T09:00:00+05:30",
    });
    const later = await fixture.service.activateTaskRun({
      requestId: "REQ-activate-" + scenario.name,
      sessionId: fixture.sessionId,
      conversationId: laterConversation.conversation.conversationId,
      trigger: "user",
      workState: initialWorkState(),
      taskId: selected.task.taskId,
      expectedTaskHead: first.taskHeadAfter,
      route: {
        kind: "create_active_request",
        reason: "This is a new outcome in the same durable workstream.",
        title: scenario.secondTitle,
        request: scenario.secondTitle,
        acceptance: ["The requested outcome is completed and verified."],
        constraints: [],
      },
      at: "2026-07-18T09:00:01+05:30",
    });

    expect(later).toMatchObject({
      task: { taskId: selected.task.taskId },
      repositoryLayout: "simple_repository_v1",
      mountCreated: false,
      taskCreated: false,
      run: { taskRequestId: "R-0002" },
      context: { currentRequest: { id: "R-0002", title: scenario.secondTitle } },
    });
    await finishRun(fixture, {
      runId: later.run.runId,
      taskId: later.task.taskId,
      taskRequestId: "R-0002",
      taskHead: first.taskHeadAfter,
      path: scenario.secondPath,
      summary: scenario.name === "automation"
        ? "Approved external action confirmed as APP-1088."
        : "Completed the follow-up " + scenario.name + " outcome.",
      requestPrefix: scenario.name + "-second",
    });

    const repository = await validateTaskRepository({
      taskRoot: fixture.taskRoot,
      repositoryPath: selected.task.repositoryPath,
      expectedTaskId: selected.task.taskId,
      requestReadMode: "all",
    });
    expect(repository.requests.map((request) => request.id)).toEqual(["R-0001", "R-0002"]);
    expect(repository.requests.every((request) => request.status === "done")).toBe(true);
    expect(await git(selected.task.repositoryPath, ["rev-list", "--count", "HEAD"])).toBe("3");
    expect(await git(selected.task.repositoryPath, ["log", "--format=%s"])).not.toContain("checkpoint");
    if (scenario.name === "automation") {
      const tracked = await git(selected.task.repositoryPath, ["show", "HEAD:.ayati/task.md"]);
      expect(tracked).toContain("APP-1088");
      expect(tracked).not.toContain("secret-token");
      expect(await git(selected.task.repositoryPath, ["ls-files"])).not.toMatch(/screenshot|page-dump/i);
    }
    if (scenario.name === "analysis") {
      expect(await readFile(join(selected.task.repositoryPath, ".ayati/references.md"), "utf8"))
        .toContain("sales.csv");
    }
  });
});

async function finishRun(fixture: Fixture, input: {
  runId: string;
  taskId: string;
  taskRequestId: string;
  taskHead: string;
  path?: string;
  summary: string;
  requestPrefix: string;
}) {
  const authority = await fixture.service.acquireMutationAuthority({
    requestId: "REQ-authority-" + input.requestPrefix,
    sessionId: fixture.sessionId,
    runId: input.runId,
    taskId: input.taskId,
    taskRequestId: input.taskRequestId,
    expectedTaskHead: input.taskHead,
    targets: input.path ? [{ path: input.path, kind: "file" }] : [],
    at: "2026-07-18T09:01:00+05:30",
  });
  if (input.path) {
    await mkdir(join(authority.authority.repositoryPath, input.path, ".."), { recursive: true });
    await writeFile(join(authority.authority.repositoryPath, input.path), input.summary + "\n", "utf8");
  }
  await fixture.service.verifyMutation({
    requestId: "REQ-verify-" + input.requestPrefix,
    authorityId: authority.authority.authorityId,
    lockToken: authority.authority.lockToken,
    toolStatus: "completed",
    at: "2026-07-18T09:01:01+05:30",
  });
  await fixture.service.recordRunStep({
    requestId: "REQ-step-" + input.requestPrefix,
    sessionId: fixture.sessionId,
    runId: input.runId,
    step: 1,
    tool: input.path ? "write_files" : "external_application",
    toolEffect: "mutating",
    purpose: "Complete and verify the bounded request.",
    status: "completed",
    output: input.path
      ? { path: input.path }
      : { confirmationId: input.summary.match(/APP-\d+/)?.[0], rawPageToken: "secret-token" },
    verification: { passed: true, summary: input.summary },
    workState: {
      ...initialWorkState(),
      status: "done",
      summary: input.summary,
      facts: [input.summary],
      evidence: [input.path ?? "external confirmation"],
      artifacts: input.path ? [input.path] : [],
    },
    at: "2026-07-18T09:01:02+05:30",
  });
  return await fixture.service.finalizeTaskRun({
    requestId: "REQ-finalize-" + input.requestPrefix,
    sessionId: fixture.sessionId,
    runId: input.runId,
    taskId: input.taskId,
    outcome: "done",
    conversationSummary: input.summary,
    summary: input.summary,
    validation: "passed",
    completion: {
      accepted: true,
      assets: input.path ? [{ path: input.path, description: input.summary, verified: true }] : [],
      missing: [],
      failures: [],
      criteria: [{ criterion: "The requested outcome is confirmed.", passed: true }],
    },
    assistantResponse: input.summary,
    at: "2026-07-18T09:01:03+05:30",
  });
}

interface Fixture {
  root: string;
  taskRoot: string;
  database: ContextDatabase;
  service: SqliteGitContextService;
  sessionId: string;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "ayati-v1-flow-"));
  roots.push(root);
  const workspaceRoot = join(root, "workspace");
  const database = await ContextDatabase.open({ path: join(root, "context.db") });
  const service = new SqliteGitContextService({ database, dataRoot: root, workspaceRoot, now: () => at });
  services.push(service);
  const session = await service.ensureActiveSession({
    requestId: "REQ-session",
    date: "2026-07-17",
    timezone: "Asia/Kolkata",
    agentId: "local",
    at,
  });
  return { root, taskRoot: join(workspaceRoot, "tasks"), database, service, sessionId: session.session.sessionId };
}

async function registerDataset(fixture: Fixture, conversationId: string): Promise<void> {
  const storedPath = join(fixture.root, "uploads", "sales.csv");
  await mkdir(join(fixture.root, "uploads"), { recursive: true });
  const content = "month,total\nJan,10\n";
  await writeFile(storedPath, content, "utf8");
  await fixture.service.recordSessionAttachments({
    requestId: "REQ-record-analysis",
    sessionId: fixture.sessionId,
    conversationId,
    attachments: [{
      sessionAssetId: "asset-sales",
      kind: "file",
      name: "sales.csv",
      source: "user_attachment",
      status: "ready",
      storedPath,
      sizeBytes: Buffer.byteLength(content),
      checksum: createHash("sha256").update(content).digest("hex"),
      createdAt: at,
    }],
    at,
  });
}

function initialWorkState(): RunWorkStateInput {
  return {
    status: "not_done",
    summary: "Task run started.",
    openWork: [],
    blockers: [],
    facts: [],
    evidence: [],
    artifacts: [],
    nextStep: null,
    userInputNeeded: [],
  };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}
