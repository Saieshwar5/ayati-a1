import { GitContextServiceError } from "../errors.js";
import { requireRequestId, TASK_REQUEST_SCHEMA } from "./task-repository-layout.js";
import {
  parseBulletList,
  parseContractMarkdown,
  renderBulletList,
  renderFrontmatter,
  renderSection,
  requireBoundedText,
  requireIsoTimestamp,
} from "./task-markdown.js";

export type TaskRequestStatus = "queued" | "active" | "blocked" | "done" | "dropped";
export type TaskRequestSource = "user" | "agent_proposal" | "imported";

export interface TaskRequest {
  schema: typeof TASK_REQUEST_SCHEMA;
  id: string;
  title: string;
  status: TaskRequestStatus;
  createdAt: string;
  source: TaskRequestSource;
  request: string;
  acceptance: string[];
  constraints: string[];
  outcome: string;
}

const FRONTMATTER = ["schema", "id", "status", "created_at", "source"] as const;
const SECTIONS = ["Request", "Acceptance", "Constraints", "Outcome"] as const;

export function parseTaskRequest(content: string, expectedRequestId?: string): TaskRequest {
  const document = parseContractMarkdown({
    content,
    errorCode: "TASK_REQUEST_INVALID",
    document: "Task request",
    maxBytes: 12_000,
    frontmatterFields: FRONTMATTER,
    sections: SECTIONS,
  });
  if (document.frontmatter["schema"] !== TASK_REQUEST_SCHEMA) {
    throw new GitContextServiceError({
      code: "TASK_SCHEMA_UNSUPPORTED",
      message: "Task request schema is not supported.",
      details: { schema: document.frontmatter["schema"] },
    });
  }
  const id = requireRequestId(document.frontmatter["id"] ?? "");
  if (expectedRequestId && id !== expectedRequestId) {
    throw new GitContextServiceError({
      code: "TASK_REQUEST_INVALID",
      message: "Task request identity does not match its expected identity.",
      details: { expectedRequestId, actualRequestId: id },
    });
  }
  const title = requireBoundedText({
    value: document.title,
    field: "title",
    maximum: 120,
    errorCode: "TASK_REQUEST_INVALID",
    document: "Task request",
  });
  const acceptance = parseRequestList(document.sections, "Acceptance", false);
  if (acceptance.length === 0) {
    throw new GitContextServiceError({
      code: "TASK_REQUEST_INVALID",
      message: "Task request must contain at least one acceptance criterion.",
      details: { section: "Acceptance" },
    });
  }
  return {
    schema: TASK_REQUEST_SCHEMA,
    id,
    title,
    status: requestStatus(document.frontmatter["status"]),
    createdAt: timestamp(document.frontmatter["created_at"]),
    source: requestSource(document.frontmatter["source"]),
    request: sectionText(document.sections, "Request", 4_000),
    acceptance,
    constraints: parseRequestList(document.sections, "Constraints", true),
    outcome: sectionText(document.sections, "Outcome", 2_000),
  };
}

export function renderTaskRequest(request: TaskRequest): string {
  const id = requireRequestId(request.id);
  const title = requireBoundedText({
    value: request.title,
    field: "title",
    maximum: 120,
    errorCode: "TASK_REQUEST_INVALID",
    document: "Task request",
  });
  if (request.acceptance.length === 0) {
    throw new GitContextServiceError({
      code: "TASK_REQUEST_INVALID",
      message: "Task request must contain at least one acceptance criterion.",
      details: { section: "Acceptance" },
    });
  }
  const content = [
    ...renderFrontmatter([
      ["schema", TASK_REQUEST_SCHEMA],
      ["id", id],
      ["status", requestStatus(request.status)],
      ["created_at", timestamp(request.createdAt)],
      ["source", requestSource(request.source)],
    ]),
    "",
    "# " + title,
    "",
    ...renderSection("Request", request.request),
    "",
    ...renderSection("Acceptance", renderBulletList(request.acceptance)),
    "",
    ...renderSection("Constraints", renderBulletList(request.constraints)),
    "",
    ...renderSection("Outcome", request.outcome),
    "",
  ].join("\n");
  parseTaskRequest(content, id);
  return content;
}

export function validateTaskRequestTransition(input: {
  from: TaskRequestStatus;
  to: TaskRequestStatus;
  explicitReopen?: boolean;
}): void {
  if (input.from === input.to) return;
  const allowed = (input.from === "queued" && (input.to === "active" || input.to === "dropped"))
    || (input.from === "active"
      && (input.to === "blocked" || input.to === "done" || input.to === "dropped"))
    || (input.from === "blocked" && (input.to === "active" || input.to === "dropped"))
    || (input.from === "done" && input.to === "active" && input.explicitReopen === true);
  if (!allowed) {
    throw new GitContextServiceError({
      code: "TASK_REQUEST_STATE_INVALID",
      message: "Task request status transition is not allowed.",
      details: {
        from: input.from,
        to: input.to,
        explicitReopen: input.explicitReopen ?? false,
      },
    });
  }
}

function requestStatus(value: string | undefined): TaskRequestStatus {
  if (value === "queued" || value === "active" || value === "blocked"
    || value === "done" || value === "dropped") {
    return value;
  }
  throw new GitContextServiceError({
    code: "TASK_REQUEST_INVALID",
    message: "Task request status is invalid.",
    details: { field: "status", value: value ?? null },
  });
}

function requestSource(value: string | undefined): TaskRequestSource {
  if (value === "user" || value === "agent_proposal" || value === "imported") {
    return value;
  }
  throw new GitContextServiceError({
    code: "TASK_REQUEST_INVALID",
    message: "Task request source is invalid.",
    details: { field: "source", value: value ?? null },
  });
}

function timestamp(value: string | undefined): string {
  return requireIsoTimestamp({
    value,
    field: "created_at",
    errorCode: "TASK_REQUEST_INVALID",
    document: "Task request",
  });
}

function sectionText(
  sections: Record<string, string>,
  field: string,
  maximum: number,
): string {
  return requireBoundedText({
    value: sections[field] ?? "",
    field,
    maximum,
    errorCode: "TASK_REQUEST_INVALID",
    document: "Task request",
  });
}

function parseRequestList(
  sections: Record<string, string>,
  section: string,
  allowEmpty: boolean,
): string[] {
  return parseBulletList({
    content: sections[section] ?? "",
    errorCode: "TASK_REQUEST_INVALID",
    document: "Task request",
    section,
    allowEmpty,
  }).map((item) => requireBoundedText({
    value: item,
    field: section,
    maximum: 1_000,
    errorCode: "TASK_REQUEST_INVALID",
    document: "Task request",
  }));
}
