import type { GitContextErrorCode } from "../errors.js";
import { GitContextServiceError } from "../errors.js";

export interface ParsedContractMarkdown {
  frontmatter: Record<string, string>;
  title: string;
  sections: Record<string, string>;
}

export function parseContractMarkdown(input: {
  content: string;
  errorCode: GitContextErrorCode;
  document: string;
  maxBytes: number;
  frontmatterFields: readonly string[];
  sections: readonly string[];
}): ParsedContractMarkdown {
  if (Buffer.byteLength(input.content, "utf8") > input.maxBytes) {
    invalid(input, input.document + " exceeds its V1 size limit.");
  }
  const content = input.content.replaceAll("\r\n", "\n");
  if (!content.startsWith("---\n")) {
    invalid(input, input.document + " must begin with frontmatter.");
  }
  const boundary = content.indexOf("\n---\n", 4);
  if (boundary < 0) {
    invalid(input, input.document + " has unterminated frontmatter.");
  }
  const frontmatter = parseFrontmatter(
    content.slice(4, boundary),
    new Set(input.frontmatterFields),
    input,
  );
  for (const field of input.frontmatterFields) {
    if (!frontmatter[field]) {
      invalid(input, input.document + " is missing required field " + field + ".", { field });
    }
  }

  const body = content.slice(boundary + 5).trim();
  const lines = body.split("\n");
  const first = lines[0];
  if (!first?.startsWith("# ") || first.slice(2).trim().length === 0) {
    invalid(input, input.document + " must contain one level-one title.");
  }
  const title = first.slice(2).trim();
  const sections = parseSections(lines.slice(1), new Set(input.sections), input);
  for (const section of input.sections) {
    if (sections[section] === undefined) {
      invalid(input, input.document + " is missing required section " + section + ".", {
        section,
      });
    }
  }
  return { frontmatter, title, sections };
}

export function parseBulletList(input: {
  content: string;
  errorCode: GitContextErrorCode;
  document: string;
  section: string;
  allowEmpty?: boolean;
}): string[] {
  const trimmed = input.content.trim();
  if (trimmed === "None." || trimmed === "None" || trimmed === "Not completed yet.") {
    return [];
  }
  const items = trimmed.split("\n").map((line) => {
    if (!line.startsWith("- ") || line.slice(2).trim().length === 0) {
      throw new GitContextServiceError({
        code: input.errorCode,
        message: input.document + " section " + input.section + " must be a Markdown list.",
        details: { section: input.section },
      });
    }
    return line.slice(2).trim();
  });
  if (items.length === 0 && !input.allowEmpty) {
    throw new GitContextServiceError({
      code: input.errorCode,
      message: input.document + " section " + input.section + " cannot be empty.",
      details: { section: input.section },
    });
  }
  return items;
}

export function renderFrontmatter(fields: ReadonlyArray<readonly [string, string]>): string[] {
  return [
    "---",
    ...fields.map(([key, value]) => key + ": " + requireSingleLine(value, key)),
    "---",
  ];
}

export function renderSection(name: string, content: string): string[] {
  return ["## " + name, "", content.trim() || "None."];
}

export function renderBulletList(values: readonly string[], empty = "None."): string {
  return values.length > 0
    ? values.map((value) => "- " + requireSingleLine(value, "list item")).join("\n")
    : empty;
}

export function requireSingleLine(value: string, field: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) {
    throw new Error(field + " cannot be empty.");
  }
  return normalized;
}

export function requireBoundedText(input: {
  value: string;
  field: string;
  maximum: number;
  errorCode: GitContextErrorCode;
  document: string;
}): string {
  const value = input.value.trim();
  if (!value || value.length > input.maximum) {
    throw new GitContextServiceError({
      code: input.errorCode,
      message: input.document + " field " + input.field + " must contain 1-"
        + String(input.maximum) + " characters.",
      details: { field: input.field, maximum: input.maximum },
    });
  }
  return value;
}

export function requireIsoTimestamp(input: {
  value: string | undefined;
  field: string;
  errorCode: GitContextErrorCode;
  document: string;
}): string {
  const value = input.value ?? "";
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || Number.isNaN(Date.parse(value))) {
    throw new GitContextServiceError({
      code: input.errorCode,
      message: input.document + " field " + input.field + " must be an ISO-8601 timestamp.",
      details: { field: input.field, value: input.value ?? null },
    });
  }
  return value;
}

function parseFrontmatter(
  value: string,
  allowed: ReadonlySet<string>,
  input: { errorCode: GitContextErrorCode; document: string },
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of value.split("\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      invalid(input, input.document + " contains invalid frontmatter.");
    }
    const key = line.slice(0, separator).trim();
    const fieldValue = line.slice(separator + 1).trim();
    if (!allowed.has(key)) {
      invalid(input, input.document + " contains unsupported field " + key + ".", { field: key });
    }
    if (result[key] !== undefined) {
      invalid(input, input.document + " contains duplicate field " + key + ".", { field: key });
    }
    if (!fieldValue) {
      invalid(input, input.document + " field " + key + " cannot be empty.", { field: key });
    }
    result[key] = fieldValue;
  }
  return result;
}

function parseSections(
  lines: string[],
  allowed: ReadonlySet<string>,
  input: { errorCode: GitContextErrorCode; document: string },
): Record<string, string> {
  const result: Record<string, string> = {};
  let current: string | undefined;
  let content: string[] = [];
  const save = (): void => {
    if (!current) return;
    const value = content.join("\n").trim();
    if (!value) {
      invalid(input, input.document + " section " + current + " cannot be empty.", {
        section: current,
      });
    }
    result[current] = value;
  };

  for (const line of lines) {
    if (line.startsWith("## ")) {
      save();
      const name = line.slice(3).trim();
      if (!allowed.has(name)) {
        invalid(input, input.document + " contains unsupported section " + name + ".", {
          section: name,
        });
      }
      if (result[name] !== undefined || current === name) {
        invalid(input, input.document + " contains duplicate section " + name + ".", {
          section: name,
        });
      }
      current = name;
      content = [];
      continue;
    }
    if (!current && line.trim()) {
      invalid(input, input.document + " contains text before its first section.");
    }
    if (current) content.push(line);
  }
  save();
  return result;
}

function invalid(
  input: { errorCode: GitContextErrorCode },
  message: string,
  details?: Record<string, unknown>,
): never {
  throw new GitContextServiceError({
    code: input.errorCode,
    message,
    ...(details ? { details } : {}),
  });
}
