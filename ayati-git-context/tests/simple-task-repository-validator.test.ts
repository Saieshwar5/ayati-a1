import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseTaskCard, renderTaskCard } from "../src/tasks/task-card.js";
import { renderTaskReferences } from "../src/tasks/task-references.js";
import {
  requestFileName,
  TASK_CARD_PATH,
  TASK_REFERENCES_PATH,
  TASK_REQUESTS_DIRECTORY,
} from "../src/tasks/task-repository-layout.js";
import { validateTaskRepository } from "../src/tasks/task-repository-validator.js";
import { renderTaskRequest } from "../src/tasks/task-request.js";
import {
  createSimpleTaskFixture,
  git,
  type TaskFixtureDomain,
} from "./simple-task-repository-fixtures.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => {
    await rm(path, { recursive: true, force: true });
  }));
});

describe("simple task repository validator", () => {
  it.each([
    ["learning", "T-20260717-0001", "Learn machine learning"],
    ["coding", "T-20260717-0002", "Build coffee website"],
    ["computer_use", "T-20260717-0003", "Manage job search"],
    ["analysis", "T-20260717-0004", "Analyze sales"],
    ["automation", "T-20260717-0005", "Automate invoices"],
  ] as const)("validates the %s task fixture from committed Git state", async (
    domain,
    taskId,
    title,
  ) => {
    const taskRoot = await createTaskRoot();
    const fixture = await createSimpleTaskFixture({ taskRoot, taskId, title, domain });

    const result = await validateTaskRepository({
      taskRoot,
      repositoryPath: fixture.repositoryPath,
      expectedTaskId: taskId,
    });

    expect(result).toMatchObject({
      taskId,
      branch: "main",
      health: "ready",
      taskCard: { title, currentRequest: "R-0001" },
      currentRequest: { id: "R-0001", status: "active" },
      missingImportantPaths: [],
      workingTreeChanges: [],
    });
    expect(result.requests).toHaveLength(1);
    expect(result.references).toHaveLength(1);
    expect(await readFile(fixture.inboxPath, "utf8")).toBe("ignored input\n");
    expect(await git(fixture.repositoryPath, ["status", "--porcelain", "--untracked-files=all"]))
      .toBe("");
  });

  it("reports unjournaled working changes separately from committed context", async () => {
    const taskRoot = await createTaskRoot();
    const fixture = await createSimpleTaskFixture({
      taskRoot,
      taskId: "T-20260717-0001",
      title: "Dirty task",
      domain: "coding",
    });
    await writeFile(join(fixture.repositoryPath, fixture.importantPath), "changed externally\n", "utf8");

    const result = await validateTaskRepository({
      taskRoot,
      repositoryPath: fixture.repositoryPath,
    });

    expect(result.health).toBe("dirty_external");
    expect(result.workingTreeChanges).toEqual([" M " + fixture.importantPath]);
    expect(result.taskCard.currentSnapshot).toBe("The task repository contract is initialized.");
  });

  it("rejects an expected task identity mismatch", async () => {
    const taskRoot = await createTaskRoot();
    const fixture = await createFixture(taskRoot);

    await expect(validateTaskRepository({
      taskRoot,
      repositoryPath: fixture.repositoryPath,
      expectedTaskId: "T-20260717-9999",
    })).rejects.toMatchObject({ code: "TASK_ID_MISMATCH" });
  });

  it("rejects multiple active requests and a missing current request", async () => {
    const taskRoot = await createTaskRoot();
    const duplicate = await createFixture(taskRoot, "T-20260717-0001", "Duplicate request task");
    const secondRequest = renderTaskRequest({
      schema: "ayati.request/v1",
      id: "R-0002",
      title: "Second request",
      status: "active",
      createdAt: "2026-07-17T11:00:00+05:30",
      source: "user",
      request: "Attempt a second active request.",
      acceptance: ["The invariant is tested."],
      constraints: [],
      outcome: "Not completed yet.",
    });
    await writeFile(
      join(
        duplicate.repositoryPath,
        TASK_REQUESTS_DIRECTORY,
        requestFileName("R-0002", "Second request"),
      ),
      secondRequest,
      "utf8",
    );
    await commitAll(duplicate.repositoryPath, "add invalid second active request");

    await expect(validateTaskRepository({
      taskRoot,
      repositoryPath: duplicate.repositoryPath,
    })).rejects.toMatchObject({ code: "TASK_CURRENT_REQUEST_INVALID" });

    const missingRoot = await createTaskRoot();
    const missing = await createFixture(missingRoot, "T-20260717-0002", "Missing request task");
    const cardPath = join(missing.repositoryPath, TASK_CARD_PATH);
    const card = parseTaskCard(await readFile(cardPath, "utf8"));
    await writeFile(cardPath, renderTaskCard({ ...card, currentRequest: "R-9999" }), "utf8");
    await commitAll(missing.repositoryPath, "point at missing request");

    await expect(validateTaskRepository({
      taskRoot: missingRoot,
      repositoryPath: missing.repositoryPath,
    })).rejects.toMatchObject({ code: "TASK_CURRENT_REQUEST_INVALID" });
  });

  it("rejects an active request inside a paused task", async () => {
    const taskRoot = await createTaskRoot();
    const fixture = await createFixture(taskRoot, "T-20260717-0001", "Paused active task");
    const cardPath = join(fixture.repositoryPath, TASK_CARD_PATH);
    const card = parseTaskCard(await readFile(cardPath, "utf8"));
    await writeFile(cardPath, renderTaskCard({ ...card, status: "paused" }), "utf8");
    await commitAll(fixture.repositoryPath, "pause task without closing request");

    await expect(validateTaskRepository({
      taskRoot,
      repositoryPath: fixture.repositoryPath,
    })).rejects.toMatchObject({ code: "TASK_CURRENT_REQUEST_INVALID" });
  });

  it("rejects tracked inbox bytes and references to missing requests", async () => {
    const taskRoot = await createTaskRoot();
    const tracked = await createFixture(taskRoot, "T-20260717-0001", "Tracked inbox task");
    await git(tracked.repositoryPath, ["add", "-f", "--", ".ayati/inbox/REF-0001-input.txt"]);
    await git(tracked.repositoryPath, ["commit", "-m", "track private inbox input"]);

    await expect(validateTaskRepository({
      taskRoot,
      repositoryPath: tracked.repositoryPath,
    })).rejects.toMatchObject({ code: "TASK_REPOSITORY_INVALID" });

    const referenceRoot = await createTaskRoot();
    const invalidReference = await createFixture(
      referenceRoot,
      "T-20260717-0002",
      "Invalid reference task",
    );
    await writeFile(
      join(invalidReference.repositoryPath, TASK_REFERENCES_PATH),
      renderTaskReferences([{
        id: "REF-0001",
        kind: "attachment",
        label: "input.txt",
        location: ".ayati/inbox/REF-0001-input.txt",
        sha256: "sha256:" + "a".repeat(64),
        availability: "available",
        addedAt: "2026-07-17T10:35:00+05:30",
        requestIds: ["R-9999"],
        adoptedPath: null,
        notes: "Invalid request relationship.",
      }]),
      "utf8",
    );
    await commitAll(invalidReference.repositoryPath, "add invalid reference request");

    await expect(validateTaskRepository({
      taskRoot: referenceRoot,
      repositoryPath: invalidReference.repositoryPath,
    })).rejects.toMatchObject({ code: "TASK_REFERENCES_INVALID" });
  });

  it("rejects symlink aliases and repositories that are not direct task-root children", async () => {
    const taskRoot = await createTaskRoot();
    const fixture = await createFixture(taskRoot);
    const alias = join(taskRoot, "T-20260717-9999-alias");
    await symlink(fixture.repositoryPath, alias, "dir");

    await expect(validateTaskRepository({
      taskRoot,
      repositoryPath: alias,
    })).rejects.toMatchObject({ code: "TASK_REPOSITORY_INVALID" });

    const outerRoot = await createTaskRoot();
    const nestedRoot = join(outerRoot, "group");
    await mkdir(nestedRoot);
    const nested = await createFixture(nestedRoot, "T-20260717-0002", "Nested task");

    await expect(validateTaskRepository({
      taskRoot: outerRoot,
      repositoryPath: nested.repositoryPath,
    })).rejects.toMatchObject({ code: "TASK_REPOSITORY_INVALID" });
  });
});

async function createTaskRoot(): Promise<string> {
  const temporary = await mkdtemp(join(tmpdir(), "ayati-simple-task-"));
  temporaryDirectories.push(temporary);
  const taskRoot = join(temporary, "tasks");
  await mkdir(taskRoot);
  return taskRoot;
}

async function createFixture(
  taskRoot: string,
  taskId = "T-20260717-0001",
  title = "Fixture task",
  domain: TaskFixtureDomain = "coding",
) {
  return await createSimpleTaskFixture({ taskRoot, taskId, title, domain });
}

async function commitAll(repositoryPath: string, subject: string): Promise<void> {
  await git(repositoryPath, ["add", "--", "."]);
  await git(repositoryPath, ["commit", "-m", subject]);
}
