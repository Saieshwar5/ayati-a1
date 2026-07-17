import { GitContextServiceError } from "../errors.js";
import {
  isRequestId,
  nextReferenceId,
  normalizePortableTaskPath,
  requireReferenceId,
} from "./task-repository-layout.js";
import {
  requireBoundedText,
  requireIsoTimestamp,
  requireSingleLine,
} from "./task-markdown.js";

export type TaskReferenceKind =
  | "attachment"
  | "external_file"
  | "external_directory"
  | "url"
  | "task_path";

export type TaskReferenceAvailability = "available" | "missing" | "changed" | "unchecked";

export interface TaskReference {
  id: string;
  kind: TaskReferenceKind;
  label: string;
  location: string;
  sha256: string | null;
  availability: TaskReferenceAvailability;
  addedAt: string;
  requestIds: string[];
  adoptedPath: string | null;
  notes: string;
}

const FIELDS = [
  "Kind",
  "Label",
  "Location",
  "SHA-256",
  "Availability",
  "Added",
  "Requests",
  "Adopted path",
  "Notes",
] as const;

export function parseTaskReferences(content: string): TaskReference[] {
  if (Buffer.byteLength(content, "utf8") > 64_000) {
    invalid("Task references manifest exceeds its V1 size limit.");
  }
  const normalized = content.replaceAll("\r\n", "\n").trim();
  if (normalized === "# References") return [];
  if (!normalized.startsWith("# References\n")) {
    invalid("Task references manifest must begin with # References.");
  }
  const blocks = normalized.slice("# References\n".length).trim().split(/\n(?=## REF-\d{4}\n)/);
  const seen = new Set<string>();
  return blocks.map((block) => {
    const lines = block.split("\n");
    const heading = lines.shift();
    if (!heading?.startsWith("## ")) {
      invalid("Task reference entry is missing its identity heading.");
    }
    const id = requireReferenceId(heading.slice(3).trim());
    if (seen.has(id)) {
      invalid("Task references manifest contains a duplicate reference ID.", { referenceId: id });
    }
    seen.add(id);
    const fields = parseFields(lines, id);
    const requestIds = fields["Requests"] === "none"
      ? []
      : fields["Requests"].split(",").map((value) => value.trim());
    if (requestIds.some((value) => !isRequestId(value))) {
      invalid("Task reference contains an invalid request ID.", { referenceId: id });
    }
    const adoptedValue = unwrapCode(fields["Adopted path"]);
    const adoptedPath = adoptedValue === "none"
      ? null
      : normalizePortableTaskPath(adoptedValue, { errorCode: "TASK_REFERENCES_INVALID" });
    const reference: TaskReference = {
      id,
      kind: referenceKind(fields["Kind"]),
      label: bounded(fields["Label"], "Label", 240),
      location: bounded(unwrapCode(fields["Location"]), "Location", 2_000),
      sha256: checksum(unwrapCode(fields["SHA-256"])),
      availability: availability(fields["Availability"]),
      addedAt: timestamp(fields["Added"]),
      requestIds: [...new Set(requestIds)],
      adoptedPath,
      notes: bounded(fields["Notes"], "Notes", 1_000),
    };
    validateReferenceLocation(reference);
    return reference;
  });
}

export function renderTaskReferences(references: readonly TaskReference[]): string {
  const seen = new Set<string>();
  const blocks = references.map((reference) => {
    const id = requireReferenceId(reference.id);
    if (seen.has(id)) {
      invalid("Task references manifest contains a duplicate reference ID.", { referenceId: id });
    }
    seen.add(id);
    const normalized: TaskReference = {
      ...reference,
      id,
      kind: referenceKind(reference.kind),
      label: bounded(reference.label, "Label", 240),
      location: bounded(reference.location, "Location", 2_000),
      sha256: reference.sha256 ? checksum(reference.sha256) : null,
      availability: availability(reference.availability),
      addedAt: timestamp(reference.addedAt),
      requestIds: [...new Set(reference.requestIds)],
      adoptedPath: reference.adoptedPath
        ? normalizePortableTaskPath(reference.adoptedPath, {
            errorCode: "TASK_REFERENCES_INVALID",
          })
        : null,
      notes: bounded(reference.notes, "Notes", 1_000),
    };
    if (normalized.requestIds.some((value) => !isRequestId(value))) {
      invalid("Task reference contains an invalid request ID.", { referenceId: id });
    }
    validateReferenceLocation(normalized);
    return [
      "## " + id,
      "",
      "- Kind: " + normalized.kind,
      "- Label: " + requireSingleLine(normalized.label, "reference label"),
      "- Location: `" + normalized.location + "`",
      "- SHA-256: " + (normalized.sha256 ? "`" + normalized.sha256 + "`" : "unavailable"),
      "- Availability: " + normalized.availability,
      "- Added: " + normalized.addedAt,
      "- Requests: " + (normalized.requestIds.length > 0
        ? normalized.requestIds.join(", ")
        : "none"),
      "- Adopted path: " + (normalized.adoptedPath
        ? "`" + normalized.adoptedPath + "`"
        : "none"),
      "- Notes: " + requireSingleLine(normalized.notes, "reference notes"),
    ].join("\n");
  });
  const content = "# References\n" + (blocks.length > 0 ? "\n" + blocks.join("\n\n") + "\n" : "");
  parseTaskReferences(content);
  return content;
}

export { nextReferenceId };

function parseFields(lines: string[], referenceId: string): Record<(typeof FIELDS)[number], string> {
  const result = {} as Record<(typeof FIELDS)[number], string>;
  for (const line of lines) {
    if (!line.trim()) continue;
    const match = line.match(/^- ([^:]+):\s*(.+)$/);
    const key = match?.[1];
    const value = match?.[2]?.trim();
    if (!key || !value || !FIELDS.includes(key as (typeof FIELDS)[number])) {
      invalid("Task reference contains an unsupported field.", { referenceId });
    }
    const typedKey = key as (typeof FIELDS)[number];
    if (result[typedKey] !== undefined) {
      invalid("Task reference contains a duplicate field.", { referenceId, field: typedKey });
    }
    result[typedKey] = value;
  }
  for (const field of FIELDS) {
    if (!result[field]) {
      invalid("Task reference is missing a required field.", { referenceId, field });
    }
  }
  return result;
}

function referenceKind(value: string): TaskReferenceKind {
  if (value === "attachment" || value === "external_file" || value === "external_directory"
    || value === "url" || value === "task_path") {
    return value;
  }
  invalid("Task reference kind is invalid.", { value });
}

function availability(value: string): TaskReferenceAvailability {
  if (value === "available" || value === "missing" || value === "changed"
    || value === "unchecked") {
    return value;
  }
  invalid("Task reference availability is invalid.", { value });
}

function checksum(value: string): string | null {
  if (value === "unavailable") return null;
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) {
    invalid("Task reference checksum must be a lowercase SHA-256 identity.", { value });
  }
  return value;
}

function timestamp(value: string): string {
  return requireIsoTimestamp({
    value,
    field: "Added",
    errorCode: "TASK_REFERENCES_INVALID",
    document: "Task references manifest",
  });
}

function bounded(value: string, field: string, maximum: number): string {
  return requireBoundedText({
    value,
    field,
    maximum,
    errorCode: "TASK_REFERENCES_INVALID",
    document: "Task references manifest",
  });
}

function unwrapCode(value: string): string {
  return value.startsWith("`") && value.endsWith("`")
    ? value.slice(1, -1)
    : value;
}

function validateReferenceLocation(reference: TaskReference): void {
  if (reference.location.includes("\n") || reference.location.includes("\r")
    || reference.location.includes("`")) {
    invalid("Task reference location must be one line.", { referenceId: reference.id });
  }
  if (reference.kind === "url") {
    let url: URL;
    try {
      url = new URL(reference.location);
    } catch {
      invalid("Task URL reference must contain a valid URL.", { referenceId: reference.id });
    }
    if (url.username || url.password) {
      invalid("Task URL reference must not contain credentials.", { referenceId: reference.id });
    }
    for (const key of url.searchParams.keys()) {
      if (/token|secret|password|api[_-]?key|auth/i.test(key)) {
        invalid("Task URL reference must not contain secret-bearing query parameters.", {
          referenceId: reference.id,
          queryKey: key,
        });
      }
    }
  }
  if (reference.kind === "task_path") {
    normalizePortableTaskPath(reference.location, { errorCode: "TASK_REFERENCES_INVALID" });
  }
}

function invalid(message: string, details?: Record<string, unknown>): never {
  throw new GitContextServiceError({
    code: "TASK_REFERENCES_INVALID",
    message,
    ...(details ? { details } : {}),
  });
}
