import {
  parseSessionSnapshot,
} from "./session-snapshot.js";
import type {
  SessionSnapshot,
  SessionSnapshotValidationContext,
} from "./session-snapshot.js";
import type {
  TaskRunCheckpointSessionInterval,
  TaskRunCheckpointStatement,
} from "./task-run-checkpoint.js";

export interface ParsedTaskRunSessionUpdate {
  sessionInterval: TaskRunCheckpointSessionInterval;
  sessionSnapshot: SessionSnapshot;
}

export function parseTaskRunSessionUpdate(
  content: string,
  snapshotContext: SessionSnapshotValidationContext,
): { update?: ParsedTaskRunSessionUpdate; errors: string[] } {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return { errors: ["task-run session update response is not valid JSON"] };
  }
  if (!isPlainObject(value)) {
    return { errors: ["task-run session update response must be an object"] };
  }

  const errors = exactKeys(value, ["sessionInterval", "sessionSnapshot"], "task-run session update");
  const interval = parseSessionInterval(value["sessionInterval"]);
  errors.push(...interval.errors);
  const snapshot = parseSessionSnapshot(value["sessionSnapshot"], snapshotContext);
  if (snapshot.status === "failed") errors.push(...snapshot.errors);
  if (errors.length > 0 || !interval.value || snapshot.status !== "success") {
    return { errors: unique(errors) };
  }
  return {
    update: {
      sessionInterval: interval.value,
      sessionSnapshot: snapshot.snapshot,
    },
    errors: [],
  };
}

function parseSessionInterval(value: unknown): {
  value?: TaskRunCheckpointSessionInterval;
  errors: string[];
} {
  if (!isPlainObject(value)) {
    return { errors: ["sessionInterval must be an object"] };
  }
  const fields = [
    "summary",
    "userRequests",
    "assistantCommitments",
    "decisions",
    "corrections",
    "constraints",
    "importantFacts",
    "unresolvedQuestions",
    "references",
  ] as const;
  const errors = exactKeys(value, [...fields], "sessionInterval");
  const summary = typeof value["summary"] === "string" ? value["summary"].trim() : "";
  if (!summary) errors.push("sessionInterval.summary must be a non-empty string");
  const statements = new Map<string, TaskRunCheckpointStatement[]>();
  for (const field of fields.slice(1)) {
    const parsed = parseStatements(value[field], `sessionInterval.${field}`);
    errors.push(...parsed.errors);
    if (parsed.value) statements.set(field, parsed.value);
  }
  if (errors.length > 0) return { errors: unique(errors) };
  return {
    value: {
      summary,
      userRequests: statements.get("userRequests")!,
      assistantCommitments: statements.get("assistantCommitments")!,
      decisions: statements.get("decisions")!,
      corrections: statements.get("corrections")!,
      constraints: statements.get("constraints")!,
      importantFacts: statements.get("importantFacts")!,
      unresolvedQuestions: statements.get("unresolvedQuestions")!,
      references: statements.get("references")!,
    },
    errors: [],
  };
}

function parseStatements(value: unknown, path: string): {
  value?: TaskRunCheckpointStatement[];
  errors: string[];
} {
  if (!Array.isArray(value)) return { errors: [`${path} must be an array`] };
  const errors: string[] = value.length > 64 ? [`${path} must contain at most 64 items`] : [];
  const statements: TaskRunCheckpointStatement[] = [];
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    const entryPath = `${path}[${index}]`;
    if (!isPlainObject(entry)) {
      errors.push(`${entryPath} must be an object`);
      return;
    }
    errors.push(...exactKeys(entry, ["seq", "text"], entryPath));
    if (!Number.isInteger(entry["seq"]) || Number(entry["seq"]) < 1) {
      errors.push(`${entryPath}.seq must be a positive integer`);
    }
    if (typeof entry["text"] !== "string" || !entry["text"].trim()) {
      errors.push(`${entryPath}.text must be a non-empty string`);
    }
    if (typeof entry["text"] === "string" && entry["text"].trim()) {
      const key = entry["text"].replace(/\s+/g, " ").trim().toLowerCase();
      if (seen.has(key)) errors.push(`${path} contains duplicate statement ${entry["text"]}`);
      seen.add(key);
    }
    if (
      Number.isInteger(entry["seq"])
      && Number(entry["seq"]) > 0
      && typeof entry["text"] === "string"
      && entry["text"].trim()
    ) {
      statements.push({ seq: Number(entry["seq"]), text: entry["text"] });
    }
  });
  return errors.length > 0 ? { errors: unique(errors) } : { value: statements, errors: [] };
}

function exactKeys(value: Record<string, unknown>, expectedKeys: string[], path: string): string[] {
  const expected = new Set(expectedKeys);
  const errors: string[] = [];
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) errors.push(`${path} contains unknown field ${key}`);
  }
  for (const key of expectedKeys) {
    if (!(key in value)) errors.push(`${path} is missing required field ${key}`);
  }
  return errors;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
