import { describe, expect, it } from "vitest";
import { GitContextServiceError } from "../src/errors.js";
import { parseTaskCard, renderTaskCard, type TaskCard } from "../src/tasks/task-card.js";
import {
  parseSimpleTaskCommit,
  renderTaskIdentityCommit,
  renderTaskRunCommit,
} from "../src/tasks/task-commit-metadata.js";
import {
  nextReferenceId,
  parseTaskReferences,
  renderTaskReferences,
  type TaskReference,
} from "../src/tasks/task-references.js";
import {
  nextRequestId,
  normalizePortableTaskPath,
  requestFileName,
  taskDirectoryName,
} from "../src/tasks/task-repository-layout.js";
import {
  parseTaskRequest,
  renderTaskRequest,
  validateTaskRequestTransition,
  type TaskRequest,
} from "../src/tasks/task-request.js";

describe("simple task repository contracts", () => {
  it("round-trips the bounded living task card deterministically", () => {
    const card = taskCard();
    const rendered = renderTaskCard(card);

    expect(parseTaskCard(rendered, card.id)).toEqual(card);
    expect(renderTaskCard(parseTaskCard(rendered))).toBe(rendered);
    expect(rendered).toContain("current_request: R-0002");
    expect(rendered).toContain("- `notes/linear-regression.md` - Current concept notes");
  });

  it("rejects unsupported schemas, identity mismatches, and escaping important paths", () => {
    const rendered = renderTaskCard(taskCard());

    expectServiceError(
      () => parseTaskCard(rendered.replace("ayati.task/v1", "ayati.task/v2")),
      "TASK_SCHEMA_UNSUPPORTED",
    );
    expectServiceError(
      () => parseTaskCard(rendered, "T-20260717-9999"),
      "TASK_ID_MISMATCH",
    );
    expectServiceError(
      () => renderTaskCard({
        ...taskCard(),
        importantPaths: [{ path: "../outside.txt" }],
      }),
      "TASK_CARD_INVALID",
    );
  });

  it("round-trips requests and enforces explicit status transitions", () => {
    const request = taskRequest();
    const rendered = renderTaskRequest(request);

    expect(parseTaskRequest(rendered, request.id)).toEqual(request);
    expect(renderTaskRequest(parseTaskRequest(rendered))).toBe(rendered);
    expect(() => validateTaskRequestTransition({ from: "active", to: "blocked" }))
      .not.toThrow();
    expectServiceError(
      () => validateTaskRequestTransition({ from: "done", to: "active" }),
      "TASK_REQUEST_STATE_INVALID",
    );
    expect(() => validateTaskRequestTransition({
      from: "done",
      to: "active",
      explicitReopen: true,
    })).not.toThrow();
  });

  it("requires acceptance criteria and a valid request schema", () => {
    expectServiceError(
      () => renderTaskRequest({ ...taskRequest(), acceptance: [] }),
      "TASK_REQUEST_INVALID",
    );
    const rendered = renderTaskRequest(taskRequest());
    expectServiceError(
      () => parseTaskRequest(rendered.replace("ayati.request/v1", "ayati.request/v2")),
      "TASK_SCHEMA_UNSUPPORTED",
    );
    expectServiceError(
      () => renderTaskRequest({ ...taskRequest(), createdAt: "July 17, 2026" }),
      "TASK_REQUEST_INVALID",
    );
  });

  it("round-trips reference provenance without claiming ignored bytes are durable", () => {
    const references = [taskReference()];
    const rendered = renderTaskReferences(references);

    expect(parseTaskReferences(rendered)).toEqual(references);
    expect(renderTaskReferences(parseTaskReferences(rendered))).toBe(rendered);
    expect(rendered).toContain("Location: `.ayati/inbox/REF-0001-housing-data.csv`");
    expect(rendered).toContain("Availability: available");
  });

  it("rejects secret-bearing URLs and invalid adopted paths", () => {
    expectServiceError(
      () => renderTaskReferences([{
        ...taskReference(),
        kind: "url",
        location: "https://example.com/file?api_key=secret",
      }]),
      "TASK_REFERENCES_INVALID",
    );
    expectServiceError(
      () => renderTaskReferences([{ ...taskReference(), adoptedPath: "../secret.txt" }]),
      "TASK_REFERENCES_INVALID",
    );
  });

  it("renders and parses identity and final run commit metadata", () => {
    const identity = renderTaskIdentityCommit({
      subject: "Create Machine Learning Task",
      taskId: "T-20260717-0001",
      requestId: "R-0001",
    });
    const final = renderTaskRunCommit({
      subject: "Implement Logistic Regression Exercise",
      taskId: "T-20260717-0001",
      requestId: "R-0002",
      runId: "RUN-20260717-0042",
      sessionId: "S-20260717-local",
      outcome: "completed",
      validation: "passed",
      next: "Evaluate regularization.",
      conversationId: "C-20260717-0042",
      conversationHash: "sha256:" + "a".repeat(64),
    });

    expect(parseSimpleTaskCommit(identity)).toMatchObject({
      event: "task_created",
      outcome: "created",
      taskId: "T-20260717-0001",
    });
    expect(parseSimpleTaskCommit(final)).toMatchObject({
      event: "task_run_finalized",
      outcome: "completed",
      validation: "passed",
      next: "Evaluate regularization.",
    });
    expect(parseSimpleTaskCommit("ordinary user commit")).toBeUndefined();
    expectServiceError(
      () => parseSimpleTaskCommit(final + "\nUnexpected: metadata"),
      "TASK_REPOSITORY_INVALID",
    );
  });

  it("provides deterministic directory, filename, path, and scoped ID helpers", () => {
    expect(taskDirectoryName("T-20260717-0001", "Learn Machine Learning"))
      .toBe("T-20260717-0001-learn-machine-learning");
    expect(taskDirectoryName("W-20260712-0001", "Legacy task"))
      .toBe("W-20260712-0001-legacy-task");
    expect(requestFileName("R-0002", "Practice Logistic Regression"))
      .toBe("R-0002-practice-logistic-regression.md");
    expect(nextRequestId(["R-0001", "R-0003"])).toBe("R-0004");
    expect(nextReferenceId(["REF-0001", "REF-0002"])).toBe("REF-0003");
    expect(normalizePortableTaskPath("notes\\linear-regression.md"))
      .toBe("notes/linear-regression.md");
    expectServiceError(
      () => normalizePortableTaskPath("C:\\private\\secret.txt"),
      "TASK_CARD_INVALID",
    );
    expectServiceError(
      () => normalizePortableTaskPath("notes/../secret.txt"),
      "TASK_CARD_INVALID",
    );
  });
});

function taskCard(): TaskCard {
  return {
    schema: "ayati.task/v1",
    id: "T-20260717-0001",
    title: "Learn machine learning",
    status: "active",
    currentRequest: "R-0002",
    purpose: "Build practical machine-learning understanding.",
    currentSnapshot: "Linear regression fundamentals are complete.",
    currentFocus: "Practice logistic regression.",
    blockers: [],
    importantPaths: [{
      path: "notes/linear-regression.md",
      description: "Current concept notes",
    }],
    workingAgreements: ["Prefer practical intuition before mathematical detail."],
  };
}

function taskRequest(): TaskRequest {
  return {
    schema: "ayati.request/v1",
    id: "R-0002",
    title: "Practice logistic regression",
    status: "active",
    createdAt: "2026-07-17T10:30:00+05:30",
    source: "user",
    request: "Explain and implement logistic regression.",
    acceptance: ["Explanation is recorded.", "The implementation runs successfully."],
    constraints: ["Use NumPy first."],
    outcome: "Not completed yet.",
  };
}

function taskReference(): TaskReference {
  return {
    id: "REF-0001",
    kind: "attachment",
    label: "housing-data.csv",
    location: ".ayati/inbox/REF-0001-housing-data.csv",
    sha256: "sha256:" + "a".repeat(64),
    availability: "available",
    addedAt: "2026-07-17T10:35:00+05:30",
    requestIds: ["R-0002"],
    adoptedPath: null,
    notes: "User-provided source dataset.",
  };
}

function expectServiceError(run: () => unknown, code: GitContextServiceError["code"]): void {
  try {
    run();
    throw new Error("Expected GitContextServiceError.");
  } catch (error) {
    expect(error).toBeInstanceOf(GitContextServiceError);
    expect((error as GitContextServiceError).code).toBe(code);
  }
}
