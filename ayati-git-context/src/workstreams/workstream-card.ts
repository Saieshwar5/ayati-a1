import { GitContextServiceError } from "../errors.js";
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
  purpose: string;
  currentSnapshot: string;
  currentFocus: string;
  blockers: string[];
  workingAgreements: string[];
}

const FRONTMATTER = ["schema", "id", "title", "status", "current_request"] as const;
const SECTIONS = [
  "Purpose",
  "Current snapshot",
  "Current focus",
  "Blockers",
  "Working agreements",
] as const;

export function parseWorkstreamCard(content: string, expectedWorkstreamId?: string): WorkstreamCard {
  const document = parseContractMarkdown({
    content,
    errorCode: "WORKSTREAM_CARD_INVALID",
    document: "Workstream card",
    maxBytes: 8_000,
    frontmatterFields: FRONTMATTER,
    sections: SECTIONS,
  });
  if (document.frontmatter["schema"] !== WORKSTREAM_SCHEMA) {
    throw new GitContextServiceError({
      code: "WORKSTREAM_SCHEMA_UNSUPPORTED",
      message: "Workstream card schema is not supported.",
      details: { schema: document.frontmatter["schema"] },
    });
  }
  const id = requireWorkstreamId(document.frontmatter["id"] ?? "");
  if (expectedWorkstreamId && id !== expectedWorkstreamId) {
    throw new GitContextServiceError({
      code: "WORKSTREAM_ID_MISMATCH",
      message: "Workstream card identity does not match the expected workstream.",
      details: { expectedWorkstreamId, actualWorkstreamId: id },
    });
  }
  const title = requireBoundedText({
    value: document.frontmatter["title"] ?? "",
    field: "title",
    maximum: 120,
    errorCode: "WORKSTREAM_CARD_INVALID",
    document: "Workstream card",
  });
  if (document.title !== title) {
    throw new GitContextServiceError({
      code: "WORKSTREAM_CARD_INVALID",
      message: "Workstream card title heading does not match its title field.",
      details: { field: "title" },
    });
  }
  const status = workstreamStatus(document.frontmatter["status"]);
  const currentRequestValue = document.frontmatter["current_request"] ?? "";
  const currentRequest = currentRequestValue === "none"
    ? null
    : requireRequestId(currentRequestValue);
  return {
    schema: WORKSTREAM_SCHEMA,
    id,
    title,
    status,
    currentRequest,
    purpose: sectionText(document.sections, "Purpose", 2_000),
    currentSnapshot: sectionText(document.sections, "Current snapshot", 2_000),
    currentFocus: sectionText(document.sections, "Current focus", 1_000),
    blockers: parseList(document.sections, "Blockers", true),
    workingAgreements: parseList(document.sections, "Working agreements", true),
  };
}

export function renderWorkstreamCard(card: WorkstreamCard): string {
  const id = requireWorkstreamId(card.id);
  const title = requireBoundedText({
    value: card.title,
    field: "title",
    maximum: 120,
    errorCode: "WORKSTREAM_CARD_INVALID",
    document: "Workstream card",
  });
  const lines = [
    ...renderFrontmatter([
      ["schema", WORKSTREAM_SCHEMA],
      ["id", id],
      ["title", title],
      ["status", workstreamStatus(card.status)],
      ["current_request", card.currentRequest ? requireRequestId(card.currentRequest) : "none"],
    ]),
    "",
    "# " + title,
    "",
    ...renderSection("Purpose", card.purpose),
    "",
    ...renderSection("Current snapshot", card.currentSnapshot),
    "",
    ...renderSection("Current focus", card.currentFocus),
    "",
    ...renderSection("Blockers", renderBulletList(card.blockers)),
    "",
    ...renderSection("Working agreements", renderBulletList(card.workingAgreements)),
    "",
  ];
  const content = lines.join("\n");
  parseWorkstreamCard(content, id);
  return content;
}

function workstreamStatus(value: string | undefined): WorkstreamLifecycleStatus {
  if (value === "active" || value === "paused" || value === "archived") {
    return value;
  }
  throw new GitContextServiceError({
    code: "WORKSTREAM_CARD_INVALID",
    message: "Workstream status must be active, paused, or archived.",
    details: { field: "status", value: value ?? null },
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
    errorCode: "WORKSTREAM_CARD_INVALID",
    document: "Workstream card",
  });
}

function parseList(
  sections: Record<string, string>,
  section: string,
  allowEmpty: boolean,
): string[] {
  return parseBulletList({
    content: sections[section] ?? "",
    errorCode: "WORKSTREAM_CARD_INVALID",
    document: "Workstream card",
    section,
    allowEmpty,
  }).map((item) => requireBoundedText({
    value: item,
    field: section,
    maximum: 500,
    errorCode: "WORKSTREAM_CARD_INVALID",
    document: "Workstream card",
  }));
}
