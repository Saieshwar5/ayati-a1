import type { RunOutcome } from "../contracts.js";
import { ContextEngineServiceError } from "../errors.js";
import { requireIsoTimestamp } from "./workstream-markdown.js";

export interface WorkstreamProgressEntry {
  runId: string;
  requestId: string;
  at: string;
  outcome: RunOutcome;
  summary: string;
  workCompleted: string[];
  verifiedMutations: string[];
  validation: string[];
  findingsAndDecisions: string[];
  problems: string[];
  next?: string;
}

export const WORKSTREAM_PROGRESS_LIMITS = {
  summaryChars: 2_000,
  nextChars: 1_000,
  itemChars: 500,
  maximumListItems: 20,
} as const;

const PROGRESS_TITLE = "# Progress";
const RUN_ID_PATTERN = /^RUN-[0-9A-F]{8}-[0-9]{10}$/;
const REQUEST_ID_PATTERN = /^R-[0-9]{4}$/;
const OUTCOMES = new Set<RunOutcome>([
  "done",
  "incomplete",
  "failed",
  "blocked",
  "needs_user_input",
]);

interface ProgressCursor {
  lines: string[];
  index: number;
}

export function renderWorkstreamProgress(
  entries: readonly WorkstreamProgressEntry[],
): string {
  const normalized = entries.map(normalizeProgressEntry);
  requireUniqueRunIds(normalized);
  if (normalized.length === 0) return PROGRESS_TITLE + "\n";
  return PROGRESS_TITLE + "\n\n"
    + normalized.map(renderNormalizedProgressEntry).join("\n");
}

export function renderWorkstreamProgressEntry(
  entry: WorkstreamProgressEntry,
): string {
  return renderNormalizedProgressEntry(normalizeProgressEntry(entry));
}

export function parseWorkstreamProgress(
  content: string,
): WorkstreamProgressEntry[] {
  if (content.includes("\r")) {
    throw invalid("Workstream progress must use LF line endings.");
  }
  if (!content.endsWith("\n")) {
    throw invalid("Workstream progress must end with one newline.");
  }
  const lines = content.slice(0, -1).split("\n");
  if (lines[0] !== PROGRESS_TITLE) {
    throw invalid("Workstream progress must begin with # Progress.");
  }
  const cursor: ProgressCursor = { lines, index: 1 };
  const entries: WorkstreamProgressEntry[] = [];
  if (cursor.index < lines.length) {
    expectLine(cursor, "");
  }
  while (cursor.index < lines.length) {
    entries.push(parseProgressEntry(cursor));
  }
  requireUniqueRunIds(entries);
  if (renderWorkstreamProgress(entries) !== content) {
    throw invalid("Workstream progress does not use its canonical format.");
  }
  return entries;
}

export function appendWorkstreamProgressEntry(
  content: string,
  entry: WorkstreamProgressEntry,
): string {
  const entries = parseWorkstreamProgress(content);
  const normalized = normalizeProgressEntry(entry);
  if (entries.some((existing) => existing.runId === normalized.runId)) {
    throw invalid("Workstream progress already contains this run.", {
      runId: normalized.runId,
    });
  }
  return content + "\n" + renderNormalizedProgressEntry(normalized);
}

function renderNormalizedProgressEntry(entry: WorkstreamProgressEntry): string {
  return [
    "## " + entry.runId + " — " + entry.at,
    "",
    "Request: " + entry.requestId,
    "Outcome: " + entry.outcome,
    "",
    "### Summary",
    "",
    escapeScalar(entry.summary),
    "",
    "### Work completed",
    "",
    renderList(entry.workCompleted),
    "",
    "### Verified mutations",
    "",
    renderList(entry.verifiedMutations),
    "",
    "### Validation",
    "",
    renderList(entry.validation),
    "",
    "### Findings and decisions",
    "",
    renderList(entry.findingsAndDecisions),
    "",
    "### Problems",
    "",
    renderList(entry.problems),
    "",
    "### Next",
    "",
    entry.next ? escapeScalar(entry.next) : "None.",
    "",
  ].join("\n");
}

function parseProgressEntry(cursor: ProgressCursor): WorkstreamProgressEntry {
  const heading = nextLine(cursor);
  const headingMatch = /^## (RUN-[0-9A-F]{8}-[0-9]{10}) — (.+)$/.exec(heading);
  if (!headingMatch) {
    throw invalid("Workstream progress contains an invalid run heading.", {
      line: cursor.index,
    });
  }
  expectLine(cursor, "");
  const requestMatch = /^Request: (R-[0-9]{4})$/.exec(nextLine(cursor));
  if (!requestMatch) {
    throw invalid("Workstream progress contains an invalid request identity.", {
      line: cursor.index,
    });
  }
  const outcomeMatch = /^Outcome: ([a-z_]+)$/.exec(nextLine(cursor));
  if (!outcomeMatch) {
    throw invalid("Workstream progress contains an invalid run outcome.", {
      line: cursor.index,
    });
  }
  expectLine(cursor, "");
  const summary = scalarSection(cursor, "Summary");
  const workCompleted = listSection(cursor, "Work completed");
  const verifiedMutations = listSection(cursor, "Verified mutations");
  const validation = listSection(cursor, "Validation");
  const findingsAndDecisions = listSection(cursor, "Findings and decisions");
  const problems = listSection(cursor, "Problems");
  const nextValue = scalarSection(cursor, "Next");
  return normalizeProgressEntry({
    runId: headingMatch[1] ?? "",
    requestId: requestMatch[1] ?? "",
    at: headingMatch[2] ?? "",
    outcome: (outcomeMatch[1] ?? "") as RunOutcome,
    summary,
    workCompleted,
    verifiedMutations,
    validation,
    findingsAndDecisions,
    problems,
    ...(nextValue === "None." ? {} : { next: nextValue }),
  });
}

function scalarSection(cursor: ProgressCursor, name: string): string {
  const lines = sectionLines(cursor, name);
  if (lines.length !== 1) {
    throw invalid("Workstream progress section " + name + " must contain one line.", {
      section: name,
    });
  }
  return unescapeScalar(lines[0] ?? "");
}

function listSection(cursor: ProgressCursor, name: string): string[] {
  const lines = sectionLines(cursor, name);
  if (lines.length === 1 && lines[0] === "None.") return [];
  return lines.map((line) => {
    if (!line.startsWith("- ") || line.slice(2).trim().length === 0) {
      throw invalid("Workstream progress section " + name + " must be a Markdown list.", {
        section: name,
      });
    }
    return line.slice(2);
  });
}

function sectionLines(cursor: ProgressCursor, name: string): string[] {
  expectLine(cursor, "### " + name);
  expectLine(cursor, "");
  const lines: string[] = [];
  while (cursor.index < cursor.lines.length && cursor.lines[cursor.index] !== "") {
    lines.push(nextLine(cursor));
  }
  if (lines.length === 0) {
    throw invalid("Workstream progress section " + name + " cannot be empty.", {
      section: name,
    });
  }
  if (cursor.index < cursor.lines.length) expectLine(cursor, "");
  return lines;
}

function normalizeProgressEntry(
  entry: WorkstreamProgressEntry,
): WorkstreamProgressEntry {
  const runId = boundedLine(entry.runId, "runId", 23);
  if (!RUN_ID_PATTERN.test(runId)) {
    throw invalid("Workstream progress run ID must use RUN-XXXXXXXX-NNNNNNNNNN.", {
      runId,
    });
  }
  const requestId = boundedLine(entry.requestId, "requestId", 6);
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    throw invalid("Workstream progress request ID must use R-NNNN.", {
      requestId,
    });
  }
  const outcome = runOutcome(entry.outcome);
  const at = requireIsoTimestamp({
    value: entry.at,
    field: "at",
    errorCode: "WORKSTREAM_PROGRESS_INVALID",
    document: "Workstream progress",
  });
  const next = entry.next === undefined
    ? undefined
    : boundedLine(entry.next, "next", WORKSTREAM_PROGRESS_LIMITS.nextChars);
  return {
    runId,
    requestId,
    at,
    outcome,
    summary: boundedLine(
      entry.summary,
      "summary",
      WORKSTREAM_PROGRESS_LIMITS.summaryChars,
    ),
    workCompleted: boundedList(entry.workCompleted, "workCompleted"),
    verifiedMutations: boundedList(entry.verifiedMutations, "verifiedMutations"),
    validation: boundedList(entry.validation, "validation"),
    findingsAndDecisions: boundedList(
      entry.findingsAndDecisions,
      "findingsAndDecisions",
    ),
    problems: boundedList(entry.problems, "problems"),
    ...(next && next !== "None." ? { next } : {}),
  };
}

function boundedList(values: readonly string[], field: string): string[] {
  const unique = [...new Set(values.map((value) =>
    boundedLine(value, field + " item", WORKSTREAM_PROGRESS_LIMITS.itemChars)))];
  if (unique.length <= WORKSTREAM_PROGRESS_LIMITS.maximumListItems) return unique;
  const kept = unique.slice(0, WORKSTREAM_PROGRESS_LIMITS.maximumListItems - 1);
  const omitted = unique.length - kept.length;
  let marker = "... " + String(omitted) + " additional items omitted.";
  while (kept.includes(marker)) marker = "." + marker;
  return [...kept, marker];
}

function boundedLine(value: string, field: string, maximum: number): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > maximum) {
    throw invalid(
      "Workstream progress field " + field + " must contain 1-"
        + String(maximum) + " characters.",
      { field, maximum, actualLength: normalized.length },
    );
  }
  return normalized;
}

function runOutcome(value: RunOutcome): RunOutcome {
  if (OUTCOMES.has(value)) return value;
  throw invalid("Workstream progress contains an unsupported run outcome.", {
    outcome: value,
  });
}

function renderList(values: readonly string[]): string {
  return values.length > 0
    ? values.map((value) => "- " + value).join("\n")
    : "None.";
}

function escapeScalar(value: string): string {
  return value.startsWith("#") || value.startsWith("\\")
    ? "\\" + value
    : value;
}

function unescapeScalar(value: string): string {
  return value.startsWith("\\#") || value.startsWith("\\\\")
    ? value.slice(1)
    : value;
}

function requireUniqueRunIds(entries: readonly WorkstreamProgressEntry[]): void {
  const runIds = new Set<string>();
  for (const entry of entries) {
    if (runIds.has(entry.runId)) {
      throw invalid("Workstream progress contains a duplicate run ID.", {
        runId: entry.runId,
      });
    }
    runIds.add(entry.runId);
  }
}

function expectLine(cursor: ProgressCursor, expected: string): void {
  const actual = nextLine(cursor);
  if (actual !== expected) {
    throw invalid("Workstream progress does not use its required section order.", {
      line: cursor.index,
      expected,
      actual,
    });
  }
}

function nextLine(cursor: ProgressCursor): string {
  const line = cursor.lines[cursor.index];
  if (line === undefined) {
    throw invalid("Workstream progress ended before its entry was complete.", {
      line: cursor.index + 1,
    });
  }
  cursor.index += 1;
  return line;
}

function invalid(
  message: string,
  details?: Record<string, unknown>,
): ContextEngineServiceError {
  return new ContextEngineServiceError({
    code: "WORKSTREAM_PROGRESS_INVALID",
    message,
    ...(details ? { details } : {}),
  });
}
