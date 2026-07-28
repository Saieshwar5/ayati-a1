import { ContextEngineServiceError } from "../errors.js";
import {
  requireRequestId,
  requireWorkstreamId,
  WORKSTREAM_SCHEMA,
} from "./workstream-repository-layout.js";
import {
  parseBulletList,
  parseContractMarkdown,
  renderBulletList,
  renderFrontmatter,
  renderSection,
  requireBoundedText,
} from "./workstream-markdown.js";

export type WorkstreamLifecycleStatus = "active" | "paused" | "archived";

export interface WorkstreamCard {
  schema: typeof WORKSTREAM_SCHEMA;
  id: string;
  title: string;
  status: WorkstreamLifecycleStatus;
  currentRequest: string | null;
  aliases: string[];
  purpose: string;
  currentSnapshot: string;
  importantFindings: string[];
  decisions: string[];
  currentFocus: string;
  openQuestions: string[];
  blockers: string[];
  nextAction: string;
}

const FRONTMATTER = [
  "schema",
  "id",
  "title",
  "status",
  "current_request",
  "aliases",
] as const;
const SECTIONS = [
  "Purpose",
  "Current state",
  "Important findings",
  "Decisions",
  "Current focus",
  "Open questions",
  "Blockers",
  "Next action",
] as const;
const MAX_LIST_ITEMS = 20;

export function parseWorkstreamCard(
  content: string,
  expectedWorkstreamId?: string,
): WorkstreamCard {
  const document = parseContractMarkdown({
    content,
    errorCode: "WORKSTREAM_CARD_INVALID",
    document: "Workstream card",
    maxBytes: 16_000,
    frontmatterFields: FRONTMATTER,
    sections: SECTIONS,
  });
  if (document.frontmatter["schema"] !== WORKSTREAM_SCHEMA) {
    throw new ContextEngineServiceError({
      code: "WORKSTREAM_SCHEMA_UNSUPPORTED",
      message: "Workstream card schema is not supported.",
      details: { schema: document.frontmatter["schema"] },
    });
  }
  const id = requireWorkstreamId(document.frontmatter["id"] ?? "");
  if (expectedWorkstreamId && id !== expectedWorkstreamId) {
    throw new ContextEngineServiceError({
      code: "WORKSTREAM_ID_MISMATCH",
      message: "Workstream card identity does not match the expected workstream.",
      details: { expectedWorkstreamId, actualWorkstreamId: id },
    });
  }
  const title = bounded(document.frontmatter["title"] ?? "", "title", 120);
  if (document.title !== title) {
    throw invalid("Workstream card title heading does not match its title field.", {
      field: "title",
    });
  }
  const current = document.frontmatter["current_request"] ?? "";
  return normalizeWorkstreamCard({
    schema: WORKSTREAM_SCHEMA,
    id,
    title,
    status: workstreamStatus(document.frontmatter["status"]),
    currentRequest: current === "none" ? null : requireRequestId(current),
    aliases: parseAliases(document.frontmatter["aliases"]),
    purpose: sectionText(document.sections, "Purpose", 2_000),
    currentSnapshot: sectionText(document.sections, "Current state", 2_000),
    importantFindings: list(document.sections, "Important findings"),
    decisions: list(document.sections, "Decisions"),
    currentFocus: sectionText(document.sections, "Current focus", 1_000),
    openQuestions: list(document.sections, "Open questions"),
    blockers: list(document.sections, "Blockers"),
    nextAction: sectionText(document.sections, "Next action", 1_000),
  });
}

export function renderWorkstreamCard(input: WorkstreamCard): string {
  const card = normalizeWorkstreamCard(input);
  const content = [
    ...renderFrontmatter([
      ["schema", WORKSTREAM_SCHEMA],
      ["id", card.id],
      ["title", card.title],
      ["status", card.status],
      ["current_request", card.currentRequest ?? "none"],
      ["aliases", JSON.stringify(card.aliases)],
    ]),
    "",
    "# " + card.title,
    "",
    ...renderSection("Purpose", card.purpose),
    "",
    ...renderSection("Current state", card.currentSnapshot),
    "",
    ...renderSection("Important findings", renderBulletList(card.importantFindings)),
    "",
    ...renderSection("Decisions", renderBulletList(card.decisions)),
    "",
    ...renderSection("Current focus", card.currentFocus),
    "",
    ...renderSection("Open questions", renderBulletList(card.openQuestions)),
    "",
    ...renderSection("Blockers", renderBulletList(card.blockers)),
    "",
    ...renderSection("Next action", card.nextAction),
    "",
  ].join("\n");
  parseWorkstreamCard(content, card.id);
  return content;
}

export function normalizeWorkstreamCard(input: WorkstreamCard): WorkstreamCard {
  return {
    schema: WORKSTREAM_SCHEMA,
    id: requireWorkstreamId(input.id),
    title: bounded(input.title, "title", 120),
    status: workstreamStatus(input.status),
    currentRequest: input.currentRequest ? requireRequestId(input.currentRequest) : null,
    aliases: normalizeList(input.aliases, "aliases", 120),
    purpose: bounded(input.purpose, "Purpose", 2_000),
    currentSnapshot: bounded(input.currentSnapshot, "Current state", 2_000),
    importantFindings: normalizeList(input.importantFindings, "Important findings", 500),
    decisions: normalizeList(input.decisions, "Decisions", 500),
    currentFocus: bounded(input.currentFocus, "Current focus", 1_000),
    openQuestions: normalizeList(input.openQuestions, "Open questions", 500),
    blockers: normalizeList(input.blockers, "Blockers", 500),
    nextAction: bounded(input.nextAction, "Next action", 1_000),
  };
}

function parseAliases(value: string | undefined): string[] {
  try {
    const parsed = JSON.parse(value ?? "");
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
      throw new Error("aliases is not a string array");
    }
    return normalizeList(parsed, "aliases", 120);
  } catch {
    throw invalid("Workstream card aliases must be one canonical JSON string array.");
  }
}

function workstreamStatus(value: string | undefined): WorkstreamLifecycleStatus {
  if (value === "active" || value === "paused" || value === "archived") return value;
  throw invalid("Workstream status must be active, paused, or archived.", {
    field: "status",
    value: value ?? null,
  });
}

function sectionText(
  sections: Record<string, string>,
  field: string,
  maximum: number,
): string {
  return bounded(sections[field] ?? "", field, maximum);
}

function list(sections: Record<string, string>, section: string): string[] {
  return normalizeList(parseBulletList({
    content: sections[section] ?? "",
    errorCode: "WORKSTREAM_CARD_INVALID",
    document: "Workstream card",
    section,
    allowEmpty: true,
  }), section, 500);
}

function normalizeList(
  values: readonly string[],
  field: string,
  maximumChars: number,
): string[] {
  const result = [...new Set(values.map((value) => bounded(value, field, maximumChars)))];
  if (result.length > MAX_LIST_ITEMS) {
    throw invalid("Workstream card list exceeds its item limit.", {
      field,
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
    errorCode: "WORKSTREAM_CARD_INVALID",
    document: "Workstream card",
  });
}

function invalid(
  message: string,
  details?: Record<string, unknown>,
): ContextEngineServiceError {
  return new ContextEngineServiceError({
    code: "WORKSTREAM_CARD_INVALID",
    message,
    ...(details ? { details } : {}),
  });
}
