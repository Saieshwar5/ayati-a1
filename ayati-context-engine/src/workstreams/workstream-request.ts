import { ContextEngineServiceError } from "../errors.js";
import {
  requestPath,
  requireRequestId,
  requireRequestPath,
  requireWorkstreamId,
  WORKSTREAM_REQUEST_SCHEMA,
} from "./workstream-repository-layout.js";
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
  workstreamId: string;
  relativePath: string;
  title: string;
  status: WorkstreamRequestStatus;
  source: WorkstreamRequestSource;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  closedAt: string | null;
  request: string;
  acceptance: string[];
  constraints: string[];
  lifecycleNote: string;
  finalOutcome: string;
}

const FRONTMATTER = [
  "schema",
  "id",
  "workstream_id",
  "status",
  "source",
  "created_at",
  "updated_at",
  "started_at",
  "closed_at",
] as const;
const SECTIONS = [
  "Request",
  "Acceptance criteria",
  "Constraints",
  "Lifecycle note",
  "Final outcome",
] as const;
const MAX_FILE_BYTES = 24_000;
const MAX_LIST_ITEMS = 20;

export function parseWorkstreamRequest(
  content: string,
  expectedRequestId?: string,
  committedPath?: string,
): WorkstreamRequest {
  const document = parseContractMarkdown({
    content,
    errorCode: "WORKSTREAM_REQUEST_INVALID",
    document: "Workstream request",
    maxBytes: MAX_FILE_BYTES,
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
    throw invalid("Workstream request identity does not match its expected identity.", {
      expectedRequestId,
      actualRequestId: id,
    });
  }
  const title = bounded(document.title, "title", 120);
  const status = requestStatus(document.frontmatter["status"]);
  const request: WorkstreamRequest = {
    schema: WORKSTREAM_REQUEST_SCHEMA,
    id,
    workstreamId: requireWorkstreamId(document.frontmatter["workstream_id"] ?? ""),
    relativePath: requireRequestPath(committedPath ?? requestPath(id, title), id),
    title,
    status,
    source: requestSource(document.frontmatter["source"]),
    createdAt: timestamp(document.frontmatter["created_at"], "created_at"),
    updatedAt: timestamp(document.frontmatter["updated_at"], "updated_at"),
    startedAt: optionalTimestamp(document.frontmatter["started_at"], "started_at"),
    closedAt: optionalTimestamp(document.frontmatter["closed_at"], "closed_at"),
    request: sectionText(document.sections, "Request", 4_000),
    acceptance: requestList(document.sections, "Acceptance criteria", false),
    constraints: requestList(document.sections, "Constraints", true),
    lifecycleNote: sectionText(document.sections, "Lifecycle note", 1_000),
    finalOutcome: sectionText(document.sections, "Final outcome", 2_000),
  };
  validateLifecycleFields(request);
  return request;
}

export function renderWorkstreamRequest(input: WorkstreamRequest): string {
  const request = normalizeWorkstreamRequest(input);
  const content = [
    ...renderFrontmatter([
      ["schema", WORKSTREAM_REQUEST_SCHEMA],
      ["id", request.id],
      ["workstream_id", request.workstreamId],
      ["status", request.status],
      ["source", request.source],
      ["created_at", request.createdAt],
      ["updated_at", request.updatedAt],
      ["started_at", request.startedAt ?? "none"],
      ["closed_at", request.closedAt ?? "none"],
    ]),
    "",
    "# " + request.title,
    "",
    ...renderSection("Request", request.request),
    "",
    ...renderSection("Acceptance criteria", renderBulletList(request.acceptance)),
    "",
    ...renderSection("Constraints", renderBulletList(request.constraints)),
    "",
    ...renderSection("Lifecycle note", request.lifecycleNote),
    "",
    ...renderSection("Final outcome", request.finalOutcome),
    "",
  ].join("\n");
  parseWorkstreamRequest(content, request.id, request.relativePath);
  return content;
}

export function normalizeWorkstreamRequest(input: WorkstreamRequest): WorkstreamRequest {
  const request: WorkstreamRequest = {
    schema: WORKSTREAM_REQUEST_SCHEMA,
    id: requireRequestId(input.id),
    workstreamId: requireWorkstreamId(input.workstreamId),
    relativePath: requireRequestPath(input.relativePath, input.id),
    title: bounded(input.title, "title", 120),
    status: requestStatus(input.status),
    source: requestSource(input.source),
    createdAt: timestamp(input.createdAt, "created_at"),
    updatedAt: timestamp(input.updatedAt, "updated_at"),
    startedAt: input.startedAt ? timestamp(input.startedAt, "started_at") : null,
    closedAt: input.closedAt ? timestamp(input.closedAt, "closed_at") : null,
    request: bounded(input.request, "Request", 4_000),
    acceptance: normalizeList(input.acceptance, "Acceptance criteria", false),
    constraints: normalizeList(input.constraints, "Constraints", true),
    lifecycleNote: bounded(input.lifecycleNote, "Lifecycle note", 1_000),
    finalOutcome: bounded(input.finalOutcome, "Final outcome", 2_000),
  };
  validateLifecycleFields(request);
  return request;
}

export function validateWorkstreamRequestTransition(input: {
  from: WorkstreamRequestStatus;
  to: WorkstreamRequestStatus;
}): void {
  if (input.from === input.to) return;
  const allowed = (input.from === "queued"
      && (input.to === "active" || input.to === "blocked" || input.to === "dropped"))
    || (input.from === "active"
      && (input.to === "queued" || input.to === "blocked"
        || input.to === "done" || input.to === "dropped"))
    || (input.from === "blocked"
      && (input.to === "active" || input.to === "queued" || input.to === "dropped"));
  if (!allowed) {
    throw new ContextEngineServiceError({
      code: "WORKSTREAM_REQUEST_STATE_INVALID",
      message: "Workstream request status transition is not allowed.",
      details: { from: input.from, to: input.to },
    });
  }
}

function validateLifecycleFields(request: WorkstreamRequest): void {
  if (Date.parse(request.updatedAt) < Date.parse(request.createdAt)) {
    throw invalid("Workstream request updated_at cannot precede created_at.");
  }
  if (request.startedAt && Date.parse(request.startedAt) < Date.parse(request.createdAt)) {
    throw invalid("Workstream request started_at cannot precede created_at.");
  }
  const terminal = request.status === "done" || request.status === "dropped";
  if (terminal !== Boolean(request.closedAt)) {
    throw invalid("Only done or dropped requests must contain closed_at.", {
      status: request.status,
      closedAt: request.closedAt,
    });
  }
  if (request.status === "active" && !request.startedAt) {
    throw invalid("An active request must contain started_at.");
  }
  if (request.closedAt && Date.parse(request.closedAt) < Date.parse(request.updatedAt)) {
    throw invalid("Workstream request closed_at cannot precede updated_at.");
  }
  if (terminal && request.finalOutcome === "Pending.") {
    throw invalid("A terminal request must contain a final outcome.");
  }
  if (!terminal && request.finalOutcome !== "Pending.") {
    throw invalid("An unfinished request final outcome must remain Pending.");
  }
}

function requestStatus(value: string | undefined): WorkstreamRequestStatus {
  if (value === "queued" || value === "active" || value === "blocked"
    || value === "done" || value === "dropped") {
    return value;
  }
  throw invalid("Workstream request status is invalid.", {
    field: "status",
    value: value ?? null,
  });
}

function requestSource(value: string | undefined): WorkstreamRequestSource {
  if (value === "user" || value === "agent_proposal" || value === "imported") {
    return value;
  }
  throw invalid("Workstream request source is invalid.", {
    field: "source",
    value: value ?? null,
  });
}

function timestamp(value: string | undefined, field: string): string {
  return requireIsoTimestamp({
    value,
    field,
    errorCode: "WORKSTREAM_REQUEST_INVALID",
    document: "Workstream request",
  });
}

function optionalTimestamp(value: string | undefined, field: string): string | null {
  return value === "none" ? null : timestamp(value, field);
}

function sectionText(
  sections: Record<string, string>,
  field: string,
  maximum: number,
): string {
  return bounded(sections[field] ?? "", field, maximum);
}

function requestList(
  sections: Record<string, string>,
  section: string,
  allowEmpty: boolean,
): string[] {
  return normalizeList(parseBulletList({
    content: sections[section] ?? "",
    errorCode: "WORKSTREAM_REQUEST_INVALID",
    document: "Workstream request",
    section,
    allowEmpty,
  }), section, allowEmpty);
}

function normalizeList(values: readonly string[], field: string, allowEmpty: boolean): string[] {
  const result = [...new Set(values.map((value) => bounded(value, field, 500)))];
  if ((!allowEmpty && result.length === 0) || result.length > MAX_LIST_ITEMS) {
    throw invalid("Workstream request list has an invalid number of entries.", {
      field,
      minimum: allowEmpty ? 0 : 1,
      maximum: MAX_LIST_ITEMS,
      actual: result.length,
    });
  }
  return result;
}

function bounded(value: string, field: string, maximum: number): string {
  return requireBoundedText({
    value,
    field,
    maximum,
    errorCode: "WORKSTREAM_REQUEST_INVALID",
    document: "Workstream request",
  });
}

function invalid(
  message: string,
  details?: Record<string, unknown>,
): ContextEngineServiceError {
  return new ContextEngineServiceError({
    code: "WORKSTREAM_REQUEST_INVALID",
    message,
    ...(details ? { details } : {}),
  });
}
