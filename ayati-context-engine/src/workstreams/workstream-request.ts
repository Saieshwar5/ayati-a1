import { ContextEngineServiceError } from "../errors.js";
import { requireRequestId, WORKSTREAM_REQUEST_SCHEMA } from "./workstream-repository-layout.js";
import {
  parseBulletList,
  parseContractMarkdown,
  renderBulletList,
  renderFrontmatter,
  renderSection,
  requireBoundedText,
  requireIsoTimestamp,
} from "./workstream-markdown.js";

export type WorkstreamRequestStatus = "queued" | "active" | "blocked" | "done" | "dropped";
export type WorkstreamRequestSource = "user" | "agent_proposal" | "imported";

export interface WorkstreamRequest {
  schema: typeof WORKSTREAM_REQUEST_SCHEMA;
  id: string;
  title: string;
  status: WorkstreamRequestStatus;
  createdAt: string;
  source: WorkstreamRequestSource;
  request: string;
  acceptance: string[];
  constraints: string[];
  outcome: string;
}

const FRONTMATTER = ["schema", "id", "status", "created_at", "source"] as const;
const SECTIONS = ["Request", "Acceptance", "Constraints", "Outcome"] as const;

export function parseWorkstreamRequest(content: string, expectedRequestId?: string): WorkstreamRequest {
  const document = parseContractMarkdown({
    content,
    errorCode: "WORKSTREAM_REQUEST_INVALID",
    document: "Workstream request",
    maxBytes: 12_000,
    frontmatterFields: FRONTMATTER,
    sections: SECTIONS,
  });
  if (document.frontmatter["schema"] !== WORKSTREAM_REQUEST_SCHEMA) {
    throw new ContextEngineServiceError({
      code: "WORKSTREAM_SCHEMA_UNSUPPORTED",
      message: "Workstream request schema is not supported.",
      details: { schema: document.frontmatter["schema"] },
    });
  }
  const id = requireRequestId(document.frontmatter["id"] ?? "");
  if (expectedRequestId && id !== expectedRequestId) {
    throw new ContextEngineServiceError({
      code: "WORKSTREAM_REQUEST_INVALID",
      message: "Workstream request identity does not match its expected identity.",
      details: { expectedRequestId, actualRequestId: id },
    });
  }
  const title = requireBoundedText({
    value: document.title,
    field: "title",
    maximum: 120,
    errorCode: "WORKSTREAM_REQUEST_INVALID",
    document: "Workstream request",
  });
  const acceptance = parseRequestList(document.sections, "Acceptance", false);
  if (acceptance.length === 0) {
    throw new ContextEngineServiceError({
      code: "WORKSTREAM_REQUEST_INVALID",
      message: "Workstream request must contain at least one acceptance criterion.",
      details: { section: "Acceptance" },
    });
  }
  return {
    schema: WORKSTREAM_REQUEST_SCHEMA,
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

export function renderWorkstreamRequest(request: WorkstreamRequest): string {
  const id = requireRequestId(request.id);
  const title = requireBoundedText({
    value: request.title,
    field: "title",
    maximum: 120,
    errorCode: "WORKSTREAM_REQUEST_INVALID",
    document: "Workstream request",
  });
  if (request.acceptance.length === 0) {
    throw new ContextEngineServiceError({
      code: "WORKSTREAM_REQUEST_INVALID",
      message: "Workstream request must contain at least one acceptance criterion.",
      details: { section: "Acceptance" },
    });
  }
  const content = [
    ...renderFrontmatter([
      ["schema", WORKSTREAM_REQUEST_SCHEMA],
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
  parseWorkstreamRequest(content, id);
  return content;
}

export function validateWorkstreamRequestTransition(input: {
  from: WorkstreamRequestStatus;
  to: WorkstreamRequestStatus;
  explicitReopen?: boolean;
}): void {
  if (input.from === input.to) return;
  const allowed = (input.from === "queued" && (input.to === "active" || input.to === "dropped"))
    || (input.from === "active"
      && (input.to === "blocked" || input.to === "done" || input.to === "dropped"))
    || (input.from === "blocked" && (input.to === "active" || input.to === "dropped"))
    || (input.from === "done" && input.to === "active" && input.explicitReopen === true);
  if (!allowed) {
    throw new ContextEngineServiceError({
      code: "WORKSTREAM_REQUEST_STATE_INVALID",
      message: "Workstream request status transition is not allowed.",
      details: {
        from: input.from,
        to: input.to,
        explicitReopen: input.explicitReopen ?? false,
      },
    });
  }
}

function requestStatus(value: string | undefined): WorkstreamRequestStatus {
  if (value === "queued" || value === "active" || value === "blocked"
    || value === "done" || value === "dropped") {
    return value;
  }
  throw new ContextEngineServiceError({
    code: "WORKSTREAM_REQUEST_INVALID",
    message: "Workstream request status is invalid.",
    details: { field: "status", value: value ?? null },
  });
}

function requestSource(value: string | undefined): WorkstreamRequestSource {
  if (value === "user" || value === "agent_proposal" || value === "imported") {
    return value;
  }
  throw new ContextEngineServiceError({
    code: "WORKSTREAM_REQUEST_INVALID",
    message: "Workstream request source is invalid.",
    details: { field: "source", value: value ?? null },
  });
}

function timestamp(value: string | undefined): string {
  return requireIsoTimestamp({
    value,
    field: "created_at",
    errorCode: "WORKSTREAM_REQUEST_INVALID",
    document: "Workstream request",
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
    errorCode: "WORKSTREAM_REQUEST_INVALID",
    document: "Workstream request",
  });
}

function parseRequestList(
  sections: Record<string, string>,
  section: string,
  allowEmpty: boolean,
): string[] {
  return parseBulletList({
    content: sections[section] ?? "",
    errorCode: "WORKSTREAM_REQUEST_INVALID",
    document: "Workstream request",
    section,
    allowEmpty,
  }).map((item) => requireBoundedText({
    value: item,
    field: section,
    maximum: 1_000,
    errorCode: "WORKSTREAM_REQUEST_INVALID",
    document: "Workstream request",
  }));
}
