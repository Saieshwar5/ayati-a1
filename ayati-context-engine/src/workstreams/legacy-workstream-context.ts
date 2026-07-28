import { ContextEngineServiceError } from "../errors.js";
import {
  parseBulletList,
  parseContractMarkdown,
  requireBoundedText,
  requireIsoTimestamp,
} from "./workstream-markdown.js";
import {
  requireRequestId,
  requireRequestPath,
  requireWorkstreamId,
} from "./workstream-repository-layout.js";
import {
  parseWorkstreamCard,
  renderWorkstreamCard,
  type WorkstreamCard,
  type WorkstreamLifecycleStatus,
} from "./workstream-card.js";
import {
  parseWorkstreamRequest,
  renderWorkstreamRequest,
  type WorkstreamRequest,
  type WorkstreamRequestSource,
  type WorkstreamRequestStatus,
} from "./workstream-request.js";

const LEGACY_CARD_SCHEMA = "ayati.workstream/v2";
const LEGACY_REQUEST_SCHEMA = "ayati.request/v2";

export function migrateWorkstreamCard(
  content: string,
  expectedWorkstreamId: string,
): { card: WorkstreamCard; content: string; migrated: boolean } {
  if (schemaLine(content) === "ayati.workstream/v3") {
    const card = parseWorkstreamCard(content, expectedWorkstreamId);
    return { card, content: renderWorkstreamCard(card), migrated: false };
  }
  const document = parseContractMarkdown({
    content,
    errorCode: "WORKSTREAM_CARD_INVALID",
    document: "Legacy workstream card",
    maxBytes: 8_000,
    frontmatterFields: ["schema", "id", "title", "status", "current_request"],
    sections: [
      "Purpose",
      "Current snapshot",
      "Current focus",
      "Blockers",
      "Working agreements",
    ],
  });
  if (document.frontmatter["schema"] !== LEGACY_CARD_SCHEMA) {
    throw unsupported("workstream card", document.frontmatter["schema"]);
  }
  const id = requireWorkstreamId(document.frontmatter["id"] ?? "");
  if (id !== expectedWorkstreamId) {
    throw new ContextEngineServiceError({
      code: "WORKSTREAM_ID_MISMATCH",
      message: "Legacy workstream identity does not match its directory.",
      details: { expectedWorkstreamId, actualWorkstreamId: id },
    });
  }
  const title = bounded(document.frontmatter["title"], "title", 120);
  if (document.title !== title) {
    throw invalid("Legacy workstream title heading does not match its title field.");
  }
  const current = document.frontmatter["current_request"];
  const focus = bounded(document.sections["Current focus"], "Current focus", 1_000);
  const card: WorkstreamCard = {
    schema: "ayati.workstream/v3",
    id,
    title,
    status: lifecycleStatus(document.frontmatter["status"]),
    currentRequest: current === "none" ? null : requireRequestId(current ?? ""),
    aliases: [],
    purpose: bounded(document.sections["Purpose"], "Purpose", 2_000),
    currentSnapshot: bounded(
      document.sections["Current snapshot"],
      "Current snapshot",
      2_000,
    ),
    importantFindings: [],
    decisions: legacyList(document.sections, "Working agreements"),
    currentFocus: focus,
    openQuestions: [],
    blockers: legacyList(document.sections, "Blockers"),
    nextAction: focus,
  };
  return { card, content: renderWorkstreamCard(card), migrated: true };
}

export function migrateWorkstreamRequest(input: {
  content: string;
  workstreamId: string;
  requestId: string;
  relativePath: string;
  updatedAt: string;
}): { request: WorkstreamRequest; content: string; migrated: boolean } {
  if (schemaLine(input.content) === "ayati.request/v3") {
    const request = parseWorkstreamRequest(
      input.content,
      input.requestId,
      input.relativePath,
    );
    if (request.workstreamId !== input.workstreamId) {
      throw invalid("Request belongs to a different workstream.");
    }
    return { request, content: renderWorkstreamRequest(request), migrated: false };
  }
  const document = parseContractMarkdown({
    content: input.content,
    errorCode: "WORKSTREAM_REQUEST_INVALID",
    document: "Legacy workstream request",
    maxBytes: 12_000,
    frontmatterFields: ["schema", "id", "status", "created_at", "source"],
    sections: ["Request", "Acceptance", "Constraints", "Outcome"],
  });
  if (document.frontmatter["schema"] !== LEGACY_REQUEST_SCHEMA) {
    throw unsupported("workstream request", document.frontmatter["schema"]);
  }
  const id = requireRequestId(document.frontmatter["id"] ?? "");
  if (id !== input.requestId) {
    throw invalid("Legacy request identity does not match its filename.");
  }
  const createdAt = timestamp(document.frontmatter["created_at"], "created_at");
  const status = requestStatus(document.frontmatter["status"]);
  const terminal = status === "done" || status === "dropped";
  const updatedAt = Date.parse(input.updatedAt) >= Date.parse(createdAt)
    ? input.updatedAt
    : createdAt;
  const oldOutcome = bounded(document.sections["Outcome"], "Outcome", 2_000);
  const request: WorkstreamRequest = {
    schema: "ayati.request/v3",
    id,
    workstreamId: requireWorkstreamId(input.workstreamId),
    relativePath: requireRequestPath(input.relativePath, id),
    title: bounded(document.title, "title", 120),
    status,
    source: requestSource(document.frontmatter["source"]),
    createdAt,
    updatedAt,
    startedAt: status === "queued" ? null : createdAt,
    closedAt: terminal ? updatedAt : null,
    request: bounded(document.sections["Request"], "Request", 4_000),
    acceptance: requestList(document.sections, "Acceptance", false),
    constraints: requestList(document.sections, "Constraints", true),
    lifecycleNote: "Migrated from request v2 with status " + status + ".",
    finalOutcome: terminal
      ? terminalOutcome(status, oldOutcome)
      : "Pending.",
  };
  return { request, content: renderWorkstreamRequest(request), migrated: true };
}

function schemaLine(content: string): string | undefined {
  return /^schema:\s*(\S+)\s*$/m.exec(content)?.[1];
}

function lifecycleStatus(value: string | undefined): WorkstreamLifecycleStatus {
  if (value === "active" || value === "paused" || value === "archived") return value;
  throw invalid("Legacy workstream status is invalid.");
}

function requestStatus(value: string | undefined): WorkstreamRequestStatus {
  if (value === "queued" || value === "active" || value === "blocked"
    || value === "done" || value === "dropped") {
    return value;
  }
  throw invalid("Legacy request status is invalid.");
}

function requestSource(value: string | undefined): WorkstreamRequestSource {
  if (value === "user" || value === "agent_proposal" || value === "imported") return value;
  throw invalid("Legacy request source is invalid.");
}

function requestList(
  sections: Record<string, string>,
  section: string,
  allowEmpty: boolean,
): string[] {
  const values = parseBulletList({
    content: sections[section] ?? "",
    errorCode: "WORKSTREAM_REQUEST_INVALID",
    document: "Legacy workstream request",
    section,
    allowEmpty,
  });
  if (values.length > 20) throw invalid("Legacy request list exceeds 20 entries.");
  return values.map((value) => bounded(value, section, 500));
}

function legacyList(sections: Record<string, string>, section: string): string[] {
  const values = parseBulletList({
    content: sections[section] ?? "",
    errorCode: "WORKSTREAM_CARD_INVALID",
    document: "Legacy workstream card",
    section,
    allowEmpty: true,
  });
  if (values.length > 20) throw invalid("Legacy workstream list exceeds 20 entries.");
  return values.map((value) => bounded(value, section, 500));
}

function terminalOutcome(status: "done" | "dropped", outcome: string): string {
  if (outcome !== "Not completed yet." && outcome !== "Pending.") return outcome;
  return status === "done"
    ? "Completed before the shared-repository migration."
    : "Dropped before the shared-repository migration.";
}

function timestamp(value: string | undefined, field: string): string {
  return requireIsoTimestamp({
    value,
    field,
    errorCode: "WORKSTREAM_REQUEST_INVALID",
    document: "Legacy workstream request",
  });
}

function bounded(value: string | undefined, field: string, maximum: number): string {
  return requireBoundedText({
    value: value ?? "",
    field,
    maximum,
    errorCode: field === "title" || field.startsWith("Current")
      || field === "Purpose" || field === "Outcome"
      ? "WORKSTREAM_CARD_INVALID"
      : "WORKSTREAM_REQUEST_INVALID",
    document: "Legacy workstream context",
  });
}

function unsupported(document: string, schema: string | undefined): ContextEngineServiceError {
  return new ContextEngineServiceError({
    code: "WORKSTREAM_SCHEMA_UNSUPPORTED",
    message: "Legacy " + document + " schema is unsupported.",
    details: { schema: schema ?? null },
  });
}

function invalid(message: string): ContextEngineServiceError {
  return new ContextEngineServiceError({
    code: "WORKSTREAM_REPOSITORY_INVALID",
    message,
  });
}
