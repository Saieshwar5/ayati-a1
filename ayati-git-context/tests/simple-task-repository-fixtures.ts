import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { renderTaskCard, type TaskLifecycleStatus } from "../src/tasks/task-card.js";
import { renderTaskIdentityCommit } from "../src/tasks/task-commit-metadata.js";
import { renderTaskReferences, type TaskReference } from "../src/tasks/task-references.js";
import {
  requestFileName,
  taskDirectoryName,
  TASK_INBOX_DIRECTORY,
  TASK_REQUESTS_DIRECTORY,
} from "../src/tasks/task-repository-layout.js";
import {
  renderTaskRequest,
  type TaskRequestSource,
  type TaskRequestStatus,
} from "../src/tasks/task-request.js";

const execFileAsync = promisify(execFile);

export type TaskFixtureDomain =
  | "learning"
  | "coding"
  | "computer_use"
  | "analysis"
  | "automation";

export interface SimpleTaskFixture {
  taskId: string;
  requestId: string;
  repositoryPath: string;
  importantPath: string;
  inboxPath: string;
}

export async function createSimpleTaskFixture(input: {
  taskRoot: string;
  taskId: string;
  title: string;
  domain: TaskFixtureDomain;
  taskStatus?: TaskLifecycleStatus;
  requestStatus?: TaskRequestStatus;
  requestSource?: TaskRequestSource;
}): Promise<SimpleTaskFixture> {
  const requestId = "R-0001";
  const repositoryPath = join(input.taskRoot, taskDirectoryName(input.taskId, input.title));
  const domain = domainFixture(input.domain);
  const requestStatus = input.requestStatus ?? "active";
  const taskStatus = input.taskStatus ?? "active";
  await mkdir(join(repositoryPath, TASK_REQUESTS_DIRECTORY), { recursive: true });
  await mkdir(join(repositoryPath, TASK_INBOX_DIRECTORY), { recursive: true });
  await git(repositoryPath, ["init", "--initial-branch=main"]);
  await git(repositoryPath, ["config", "user.name", "Ayati Test"]);
  await git(repositoryPath, ["config", "user.email", "ayati-test@example.invalid"]);
  await writeFile(join(repositoryPath, ".gitignore"), [
    "# Ayati local input bytes. Durable provenance lives in .ayati/references.md.",
    ".ayati/inbox/*",
    "!.ayati/inbox/.gitkeep",
    "",
  ].join("\n"), "utf8");
  await writeFile(join(repositoryPath, ".ayati", "task.md"), renderTaskCard({
    schema: "ayati.task/v1",
    id: input.taskId,
    title: input.title,
    status: taskStatus,
    currentRequest: requestStatus === "active" ? requestId : null,
    purpose: domain.purpose,
    currentSnapshot: "The task repository contract is initialized.",
    currentFocus: requestStatus === "active" ? domain.request : "No request is currently active.",
    blockers: [],
    importantPaths: [{ path: domain.path, description: domain.description }],
    workingAgreements: [domain.agreement],
  }), "utf8");
  await writeFile(
    join(repositoryPath, TASK_REQUESTS_DIRECTORY, requestFileName(requestId, domain.requestTitle)),
    renderTaskRequest({
      schema: "ayati.request/v1",
      id: requestId,
      title: domain.requestTitle,
      status: requestStatus,
      createdAt: "2026-07-17T10:30:00+05:30",
      source: input.requestSource ?? "user",
      request: domain.request,
      acceptance: domain.acceptance,
      constraints: domain.constraints,
      outcome: requestStatus === "done" ? "The initial request is complete." : "Not completed yet.",
    }),
    "utf8",
  );
  const inboxRelative = ".ayati/inbox/REF-0001-input.txt";
  const reference: TaskReference = {
    id: "REF-0001",
    kind: "attachment",
    label: "input.txt",
    location: inboxRelative,
    sha256: "sha256:" + createHash("sha256").update("ignored input\n").digest("hex"),
    availability: "available",
    addedAt: "2026-07-17T10:35:00+05:30",
    requestIds: [requestId],
    adoptedPath: null,
    notes: "User-provided fixture input.",
  };
  await writeFile(
    join(repositoryPath, ".ayati", "references.md"),
    renderTaskReferences([reference]),
    "utf8",
  );
  await writeFile(join(repositoryPath, ".ayati", "inbox", ".gitkeep"), "", "utf8");
  await writeFile(join(repositoryPath, ".ayati", "inbox", "REF-0001-input.txt"), "ignored input\n", "utf8");
  await mkdir(join(repositoryPath, ...domain.path.split("/").slice(0, -1)), { recursive: true });
  await writeFile(join(repositoryPath, domain.path), domain.content, "utf8");
  await git(repositoryPath, ["add", "--", "."]);
  await git(repositoryPath, [
    "commit",
    "-m",
    renderTaskIdentityCommit({
      subject: "Create " + input.title + " task",
      taskId: input.taskId,
      requestId,
    }),
  ]);
  return {
    taskId: input.taskId,
    requestId,
    repositoryPath,
    importantPath: domain.path,
    inboxPath: join(repositoryPath, ".ayati", "inbox", "REF-0001-input.txt"),
  };
}

export async function git(repositoryPath: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd: repositoryPath,
    encoding: "utf8",
  });
  return result.stdout.trim();
}

function domainFixture(domain: TaskFixtureDomain): {
  purpose: string;
  requestTitle: string;
  request: string;
  acceptance: string[];
  constraints: string[];
  path: string;
  description: string;
  agreement: string;
  content: string;
} {
  switch (domain) {
    case "learning":
      return {
        purpose: "Learn machine learning through explanations, exercises, and projects.",
        requestTitle: "Learn linear regression",
        request: "Explain and implement linear regression from first principles.",
        acceptance: ["Concept notes exist.", "The implementation runs successfully."],
        constraints: ["Use NumPy before a high-level framework."],
        path: "notes/linear-regression.md",
        description: "Current learning notes",
        agreement: "Prefer practical intuition before mathematical detail.",
        content: "# Linear regression\n",
      };
    case "coding":
      return {
        purpose: "Build and maintain a reliable coffee website.",
        requestTitle: "Build initial website",
        request: "Create the initial accessible coffee website.",
        acceptance: ["The main page renders.", "The focused tests pass."],
        constraints: ["Preserve accessible semantic HTML."],
        path: "src/index.ts",
        description: "Application entry point",
        agreement: "Keep implementation modules focused and readable.",
        content: "export const ready = true;\n",
      };
    case "computer_use":
      return {
        purpose: "Manage a job search across documents and external applications.",
        requestTitle: "Prepare first application",
        request: "Prepare the first application and record verified external outcomes.",
        acceptance: ["The tailored application record exists.", "External actions are verified."],
        constraints: ["Do not store credentials or private page dumps in Git."],
        path: "applications/example-company.md",
        description: "Application record",
        agreement: "Git records external outcomes but does not claim to own external state.",
        content: "# Example Company\n",
      };
    case "analysis":
      return {
        purpose: "Investigate sales changes using reproducible analysis.",
        requestTitle: "Find revenue decline",
        request: "Identify and explain the recent revenue decline.",
        acceptance: ["The analysis is reproducible.", "The report cites verified metrics."],
        constraints: ["Keep raw exports in the ignored inbox."],
        path: "reports/revenue-decline.md",
        description: "Current analysis report",
        agreement: "Separate raw inputs, reproducible code, and conclusions.",
        content: "# Revenue decline\n",
      };
    case "automation":
      return {
        purpose: "Build and maintain invoice-processing automation.",
        requestTitle: "Extract invoice fields",
        request: "Extract required fields from sample invoices.",
        acceptance: ["Required fields are extracted.", "Fixture tests pass."],
        constraints: ["Never commit secrets or production invoices."],
        path: "src/extract.ts",
        description: "Invoice extraction implementation",
        agreement: "Prefer deterministic validation for every automation step.",
        content: "export function extract(): object { return {}; }\n",
      };
  }
}
