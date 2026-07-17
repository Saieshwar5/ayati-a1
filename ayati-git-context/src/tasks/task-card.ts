import { GitContextServiceError } from "../errors.js";
import {
  normalizePortableTaskPath,
  requireRequestId,
  requireTaskId,
  TASK_SCHEMA,
} from "./task-repository-layout.js";
import {
  parseBulletList,
  parseContractMarkdown,
  renderBulletList,
  renderFrontmatter,
  renderSection,
  requireBoundedText,
  requireSingleLine,
} from "./task-markdown.js";

export type TaskLifecycleStatus = "active" | "paused" | "archived";

export interface TaskImportantPath {
  path: string;
  description?: string;
}

export interface TaskCard {
  schema: typeof TASK_SCHEMA;
  id: string;
  title: string;
  status: TaskLifecycleStatus;
  currentRequest: string | null;
  purpose: string;
  currentSnapshot: string;
  currentFocus: string;
  blockers: string[];
  importantPaths: TaskImportantPath[];
  workingAgreements: string[];
}

const FRONTMATTER = ["schema", "id", "title", "status", "current_request"] as const;
const SECTIONS = [
  "Purpose",
  "Current snapshot",
  "Current focus",
  "Blockers",
  "Important paths",
  "Working agreements",
] as const;

export function parseTaskCard(content: string, expectedTaskId?: string): TaskCard {
  const document = parseContractMarkdown({
    content,
    errorCode: "TASK_CARD_INVALID",
    document: "Task card",
    maxBytes: 8_000,
    frontmatterFields: FRONTMATTER,
    sections: SECTIONS,
  });
  if (document.frontmatter["schema"] !== TASK_SCHEMA) {
    throw new GitContextServiceError({
      code: "TASK_SCHEMA_UNSUPPORTED",
      message: "Task card schema is not supported.",
      details: { schema: document.frontmatter["schema"] },
    });
  }
  const id = requireTaskId(document.frontmatter["id"] ?? "");
  if (expectedTaskId && id !== expectedTaskId) {
    throw new GitContextServiceError({
      code: "TASK_ID_MISMATCH",
      message: "Task card identity does not match the expected task.",
      details: { expectedTaskId, actualTaskId: id },
    });
  }
  const title = requireBoundedText({
    value: document.frontmatter["title"] ?? "",
    field: "title",
    maximum: 120,
    errorCode: "TASK_CARD_INVALID",
    document: "Task card",
  });
  if (document.title !== title) {
    throw new GitContextServiceError({
      code: "TASK_CARD_INVALID",
      message: "Task card title heading does not match its title field.",
      details: { field: "title" },
    });
  }
  const status = taskStatus(document.frontmatter["status"]);
  const currentRequestValue = document.frontmatter["current_request"] ?? "";
  const currentRequest = currentRequestValue === "none"
    ? null
    : requireRequestId(currentRequestValue);
  return {
    schema: TASK_SCHEMA,
    id,
    title,
    status,
    currentRequest,
    purpose: sectionText(document.sections, "Purpose", 2_000),
    currentSnapshot: sectionText(document.sections, "Current snapshot", 2_000),
    currentFocus: sectionText(document.sections, "Current focus", 1_000),
    blockers: parseList(document.sections, "Blockers", true),
    importantPaths: parseImportantPaths(document.sections["Important paths"] ?? ""),
    workingAgreements: parseList(document.sections, "Working agreements", true),
  };
}

export function renderTaskCard(card: TaskCard): string {
  const id = requireTaskId(card.id);
  const title = requireBoundedText({
    value: card.title,
    field: "title",
    maximum: 120,
    errorCode: "TASK_CARD_INVALID",
    document: "Task card",
  });
  const lines = [
    ...renderFrontmatter([
      ["schema", TASK_SCHEMA],
      ["id", id],
      ["title", title],
      ["status", taskStatus(card.status)],
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
    ...renderSection("Important paths", renderImportantPaths(card.importantPaths)),
    "",
    ...renderSection("Working agreements", renderBulletList(card.workingAgreements)),
    "",
  ];
  const content = lines.join("\n");
  parseTaskCard(content, id);
  return content;
}

function taskStatus(value: string | undefined): TaskLifecycleStatus {
  if (value === "active" || value === "paused" || value === "archived") {
    return value;
  }
  throw new GitContextServiceError({
    code: "TASK_CARD_INVALID",
    message: "Task status must be active, paused, or archived.",
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
    errorCode: "TASK_CARD_INVALID",
    document: "Task card",
  });
}

function parseList(
  sections: Record<string, string>,
  section: string,
  allowEmpty: boolean,
): string[] {
  return parseBulletList({
    content: sections[section] ?? "",
    errorCode: "TASK_CARD_INVALID",
    document: "Task card",
    section,
    allowEmpty,
  }).map((item) => requireBoundedText({
    value: item,
    field: section,
    maximum: 500,
    errorCode: "TASK_CARD_INVALID",
    document: "Task card",
  }));
}

function parseImportantPaths(value: string): TaskImportantPath[] {
  const items = parseBulletList({
    content: value,
    errorCode: "TASK_CARD_INVALID",
    document: "Task card",
    section: "Important paths",
    allowEmpty: true,
  });
  if (items.length > 20) {
    throw new GitContextServiceError({
      code: "TASK_CARD_INVALID",
      message: "Task card may contain at most 20 important paths.",
      details: { section: "Important paths", count: items.length },
    });
  }
  return items.map((item) => {
    const match = item.match(/^`([^`]+)`(?: - (.+))?$/);
    if (!match?.[1]) {
      throw new GitContextServiceError({
        code: "TASK_CARD_INVALID",
        message: "Important paths must use `path` - description list items.",
        details: { section: "Important paths" },
      });
    }
    const path = normalizePortableTaskPath(match[1]);
    const description = match[2]
      ? requireSingleLine(match[2], "important path description")
      : undefined;
    return { path, ...(description ? { description } : {}) };
  });
}

function renderImportantPaths(paths: readonly TaskImportantPath[]): string {
  return renderBulletList(paths.map((entry) => {
    const path = normalizePortableTaskPath(entry.path);
    return "`" + path + "`" + (entry.description
      ? " - " + requireSingleLine(entry.description, "important path description")
      : "");
  }));
}
