import { estimateTextTokens } from "../../prompt/token-estimator.js";

export const DEFAULT_SESSION_SNAPSHOT_MAX_TOKENS = 5_000;

export type SessionSnapshotSource =
  | { kind: "conversation"; seq: number }
  | { kind: "task_run"; runId: string }
  | { kind: "previous_summary" };

export interface SessionSnapshotItem {
  text: string;
  sources: SessionSnapshotSource[];
}

export interface SessionSnapshotThread {
  subject: string;
  goal: string;
  status: "active" | "waiting" | "completed" | "blocked" | "superseded";
  latestOutcome: string | null;
  next: string | null;
  taskIds: string[];
  runIds: string[];
  sources: SessionSnapshotSource[];
}

export interface SessionSnapshotRequest extends SessionSnapshotItem {
  status: "open" | "completed" | "blocked" | "superseded";
}

export interface SessionSnapshotProgress {
  summary: string;
  taskId: string | null;
  runId: string;
  status: "completed" | "failed" | "blocked" | "needs_user_input";
  sources: SessionSnapshotSource[];
}

export interface SessionSnapshot {
  schemaVersion: 1;
  overview: {
    summary: string;
    currentFocus: SessionSnapshotItem[];
    status: "active" | "waiting_for_user" | "idle";
  };
  threads: SessionSnapshotThread[];
  userRequests: SessionSnapshotRequest[];
  decisions: SessionSnapshotItem[];
  constraints: SessionSnapshotItem[];
  assistantCommitments: SessionSnapshotItem[];
  unresolvedQuestions: SessionSnapshotItem[];
  importantFacts: SessionSnapshotItem[];
  references: SessionSnapshotItem[];
  recentProgress: SessionSnapshotProgress[];
  continuation: {
    waitingFor: string | null;
    recommendedNext: string | null;
    blockers: string[];
  };
}

export interface SessionSnapshotValidationContext {
  conversationSeqs: number[];
  taskIds: string[];
  runIds: string[];
  previousSummarySupplied: boolean;
  pendingUserInput?: {
    question: string;
    sourceSeq: number;
  };
  maxTokens?: number;
}

export type ParseSessionSnapshotResult =
  | { status: "success"; snapshot: SessionSnapshot; estimatedTokens: number; errors: [] }
  | { status: "failed"; errors: string[]; estimatedTokens?: number };

export function parseSessionSnapshot(
  value: unknown,
  context: SessionSnapshotValidationContext,
): ParseSessionSnapshotResult {
  const errors = validateSessionSnapshot(value, context);
  const estimatedTokens = estimateSnapshotTokens(value);
  if (errors.length > 0) {
    return {
      status: "failed",
      errors,
      ...(estimatedTokens !== undefined ? { estimatedTokens } : {}),
    };
  }
  return {
    status: "success",
    snapshot: structuredClone(value as SessionSnapshot),
    estimatedTokens: estimatedTokens!,
    errors: [],
  };
}

export function validateSessionSnapshot(
  value: unknown,
  context: SessionSnapshotValidationContext,
): string[] {
  const errors = validateSnapshotShape(value);
  if (errors.length > 0 || !isPlainObject(value)) {
    return unique(errors);
  }
  const snapshot = value as unknown as SessionSnapshot;
  errors.push(...validateSnapshotSemantics(snapshot, context));
  const maxTokens = positiveInteger(context.maxTokens, DEFAULT_SESSION_SNAPSHOT_MAX_TOKENS);
  const estimatedTokens = estimateTextTokens(JSON.stringify(snapshot));
  if (estimatedTokens > maxTokens) {
    errors.push(`session snapshot uses ${estimatedTokens} tokens, exceeding the ${maxTokens}-token limit`);
  }
  return unique(errors);
}

export function renderSessionSnapshotMarkdown(snapshot: SessionSnapshot): string {
  const sections = [
    "# Session Summary",
    "",
    "## Overview",
    "",
    `Summary: ${singleLine(snapshot.overview.summary)}`,
    `Status: ${snapshot.overview.status}`,
    "Current focus:",
    ...renderItems(snapshot.overview.currentFocus),
    "",
    "## Current Threads",
    "",
    ...renderThreads(snapshot.threads),
    "",
    "## User Requests",
    "",
    ...renderRequests(snapshot.userRequests),
    "",
    "## Decisions",
    "",
    ...renderItems(snapshot.decisions),
    "",
    "## Constraints",
    "",
    ...renderItems(snapshot.constraints),
    "",
    "## Assistant Commitments",
    "",
    ...renderItems(snapshot.assistantCommitments),
    "",
    "## Unresolved Questions",
    "",
    ...renderItems(snapshot.unresolvedQuestions),
    "",
    "## Important Facts",
    "",
    ...renderItems(snapshot.importantFacts),
    "",
    "## References",
    "",
    ...renderItems(snapshot.references),
    "",
    "## Recent Progress",
    "",
    ...renderProgress(snapshot.recentProgress),
    "",
    "## Continuation",
    "",
    `Waiting for: ${nullableText(snapshot.continuation.waitingFor)}`,
    `Recommended next: ${nullableText(snapshot.continuation.recommendedNext)}`,
    "Blockers:",
    ...renderStrings(snapshot.continuation.blockers),
  ];
  return `${sections.join("\n").trimEnd()}\n`;
}

function validateSnapshotShape(value: unknown): string[] {
  const errors: string[] = [];
  const root = strictObject(value, "snapshot", [
    "schemaVersion", "overview", "threads", "userRequests", "decisions", "constraints",
    "assistantCommitments", "unresolvedQuestions", "importantFacts", "references",
    "recentProgress", "continuation",
  ], errors);
  if (!root) return errors;
  if (root["schemaVersion"] !== 1) errors.push("snapshot.schemaVersion must be 1");
  validateOverview(root["overview"], errors);
  validateObjectArray(root["threads"], "snapshot.threads", 32, errors, validateThread);
  validateObjectArray(root["userRequests"], "snapshot.userRequests", 64, errors, validateRequest);
  for (const field of [
    "decisions", "constraints", "assistantCommitments", "unresolvedQuestions",
    "importantFacts", "references",
  ]) {
    validateObjectArray(root[field], `snapshot.${field}`, 64, errors, validateItem);
  }
  validateObjectArray(root["recentProgress"], "snapshot.recentProgress", 32, errors, validateProgress);
  validateContinuation(root["continuation"], errors);
  return errors;
}

function validateOverview(value: unknown, errors: string[]): void {
  const record = strictObject(value, "snapshot.overview", ["summary", "currentFocus", "status"], errors);
  if (!record) return;
  nonEmptyString(record["summary"], "snapshot.overview.summary", errors);
  enumValue(record["status"], "snapshot.overview.status", ["active", "waiting_for_user", "idle"], errors);
  validateObjectArray(record["currentFocus"], "snapshot.overview.currentFocus", 16, errors, validateItem);
}

function validateThread(value: unknown, path: string, errors: string[]): void {
  const record = strictObject(value, path, [
    "subject", "goal", "status", "latestOutcome", "next", "taskIds", "runIds", "sources",
  ], errors);
  if (!record) return;
  nonEmptyString(record["subject"], `${path}.subject`, errors);
  nonEmptyString(record["goal"], `${path}.goal`, errors);
  enumValue(record["status"], `${path}.status`, ["active", "waiting", "completed", "blocked", "superseded"], errors);
  nullableNonEmptyString(record["latestOutcome"], `${path}.latestOutcome`, errors);
  nullableNonEmptyString(record["next"], `${path}.next`, errors);
  validateStringArray(record["taskIds"], `${path}.taskIds`, 16, errors);
  validateStringArray(record["runIds"], `${path}.runIds`, 16, errors);
  validateSources(record["sources"], `${path}.sources`, errors);
}

function validateRequest(value: unknown, path: string, errors: string[]): void {
  const record = strictObject(value, path, ["text", "status", "sources"], errors);
  if (!record) return;
  nonEmptyString(record["text"], `${path}.text`, errors);
  enumValue(record["status"], `${path}.status`, ["open", "completed", "blocked", "superseded"], errors);
  validateSources(record["sources"], `${path}.sources`, errors);
}

function validateItem(value: unknown, path: string, errors: string[]): void {
  const record = strictObject(value, path, ["text", "sources"], errors);
  if (!record) return;
  nonEmptyString(record["text"], `${path}.text`, errors);
  validateSources(record["sources"], `${path}.sources`, errors);
}

function validateProgress(value: unknown, path: string, errors: string[]): void {
  const record = strictObject(value, path, ["summary", "taskId", "runId", "status", "sources"], errors);
  if (!record) return;
  nonEmptyString(record["summary"], `${path}.summary`, errors);
  nullableNonEmptyString(record["taskId"], `${path}.taskId`, errors);
  nonEmptyString(record["runId"], `${path}.runId`, errors);
  enumValue(record["status"], `${path}.status`, ["completed", "failed", "blocked", "needs_user_input"], errors);
  validateSources(record["sources"], `${path}.sources`, errors);
}

function validateContinuation(value: unknown, errors: string[]): void {
  const path = "snapshot.continuation";
  const record = strictObject(value, path, ["waitingFor", "recommendedNext", "blockers"], errors);
  if (!record) return;
  nullableNonEmptyString(record["waitingFor"], `${path}.waitingFor`, errors);
  nullableNonEmptyString(record["recommendedNext"], `${path}.recommendedNext`, errors);
  validateStringArray(record["blockers"], `${path}.blockers`, 32, errors);
}

function validateSources(value: unknown, path: string, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return;
  }
  if (value.length < 1) errors.push(`${path} must contain at least one source`);
  if (value.length > 16) errors.push(`${path} must contain at most 16 sources`);
  value.forEach((source, index) => {
    const sourcePath = `${path}[${index}]`;
    if (!isPlainObject(source) || typeof source["kind"] !== "string") {
      errors.push(`${sourcePath} must be a source object`);
      return;
    }
    if (source["kind"] === "conversation") {
      const record = strictObject(source, sourcePath, ["kind", "seq"], errors);
      if (record && (!Number.isInteger(record["seq"]) || Number(record["seq"]) < 1)) {
        errors.push(`${sourcePath}.seq must be a positive integer`);
      }
      return;
    }
    if (source["kind"] === "task_run") {
      const record = strictObject(source, sourcePath, ["kind", "runId"], errors);
      if (record) nonEmptyString(record["runId"], `${sourcePath}.runId`, errors);
      return;
    }
    if (source["kind"] === "previous_summary") {
      strictObject(source, sourcePath, ["kind"], errors);
      return;
    }
    errors.push(`${sourcePath}.kind is unsupported`);
  });
}

function validateSnapshotSemantics(snapshot: SessionSnapshot, context: SessionSnapshotValidationContext): string[] {
  const errors: string[] = [];
  const conversationSeqs = new Set(context.conversationSeqs);
  const taskIds = new Set(context.taskIds);
  const runIds = new Set(context.runIds);
  const sourced = allSourcedValues(snapshot);
  for (const { path, sources } of sourced) {
    const seen = new Set<string>();
    for (const source of sources) {
      const key = sourceKey(source);
      if (seen.has(key)) errors.push(`${path} contains duplicate source ${key}`);
      seen.add(key);
      if (source.kind === "conversation" && !conversationSeqs.has(source.seq)) {
        errors.push(`${path} references unknown conversation sequence ${source.seq}`);
      }
      if (source.kind === "task_run" && !runIds.has(source.runId)) {
        errors.push(`${path} references unknown task run ${source.runId}`);
      }
      if (source.kind === "previous_summary" && !context.previousSummarySupplied) {
        errors.push(`${path} references a previous summary that was not supplied`);
      }
    }
  }

  errors.push(...duplicateTextErrors(snapshot));
  snapshot.threads.forEach((thread, index) => {
    validateKnownIds(thread.taskIds, taskIds, `snapshot.threads[${index}].taskIds`, errors);
    validateKnownIds(thread.runIds, runIds, `snapshot.threads[${index}].runIds`, errors);
  });
  snapshot.recentProgress.forEach((progress, index) => {
    if (progress.taskId && !taskIds.has(progress.taskId)) {
      errors.push(`snapshot.recentProgress[${index}].taskId references unknown task ${progress.taskId}`);
    }
    if (!runIds.has(progress.runId)) {
      errors.push(`snapshot.recentProgress[${index}].runId references unknown task run ${progress.runId}`);
    }
  });
  validatePendingUserInput(snapshot, context.pendingUserInput, errors);
  return errors;
}

function validatePendingUserInput(
  snapshot: SessionSnapshot,
  pending: SessionSnapshotValidationContext["pendingUserInput"],
  errors: string[],
): void {
  if (snapshot.overview.status === "waiting_for_user" && snapshot.unresolvedQuestions.length === 0) {
    errors.push("waiting_for_user snapshot must contain an unresolved question");
  }
  if (!pending) return;
  if (snapshot.overview.status !== "waiting_for_user") {
    errors.push("snapshot with pending user input must have waiting_for_user status");
  }
  if (!snapshot.continuation.waitingFor?.trim()) {
    errors.push("snapshot with pending user input must describe continuation.waitingFor");
  }
  const preserved = snapshot.unresolvedQuestions.some((question) => (
    question.text === pending.question
    && question.sources.some((source) => source.kind === "conversation" && source.seq === pending.sourceSeq)
  ));
  if (!preserved) errors.push("snapshot must preserve the exact pending user-input question and source sequence");
}

function allSourcedValues(snapshot: SessionSnapshot): Array<{ path: string; sources: SessionSnapshotSource[] }> {
  const values: Array<{ path: string; sources: SessionSnapshotSource[] }> = [];
  const add = (items: Array<{ sources: SessionSnapshotSource[] }>, path: string) => {
    items.forEach((item, index) => values.push({ path: `${path}[${index}].sources`, sources: item.sources }));
  };
  add(snapshot.overview.currentFocus, "snapshot.overview.currentFocus");
  add(snapshot.threads, "snapshot.threads");
  add(snapshot.userRequests, "snapshot.userRequests");
  add(snapshot.decisions, "snapshot.decisions");
  add(snapshot.constraints, "snapshot.constraints");
  add(snapshot.assistantCommitments, "snapshot.assistantCommitments");
  add(snapshot.unresolvedQuestions, "snapshot.unresolvedQuestions");
  add(snapshot.importantFacts, "snapshot.importantFacts");
  add(snapshot.references, "snapshot.references");
  add(snapshot.recentProgress, "snapshot.recentProgress");
  return values;
}

function duplicateTextErrors(snapshot: SessionSnapshot): string[] {
  const errors: string[] = [];
  duplicateBy(snapshot.threads, (thread) => thread.subject, "snapshot.threads", errors);
  duplicateBy(snapshot.userRequests, (request) => request.text, "snapshot.userRequests", errors);
  for (const [path, items] of [
    ["snapshot.overview.currentFocus", snapshot.overview.currentFocus],
    ["snapshot.decisions", snapshot.decisions],
    ["snapshot.constraints", snapshot.constraints],
    ["snapshot.assistantCommitments", snapshot.assistantCommitments],
    ["snapshot.unresolvedQuestions", snapshot.unresolvedQuestions],
    ["snapshot.importantFacts", snapshot.importantFacts],
    ["snapshot.references", snapshot.references],
  ] as const) {
    duplicateBy(items, (item) => item.text, path, errors);
  }
  return errors;
}

function duplicateBy<T>(items: T[], read: (item: T) => string, path: string, errors: string[]): void {
  const seen = new Set<string>();
  for (const item of items) {
    const key = read(item).replace(/\s+/g, " ").trim().toLowerCase();
    if (seen.has(key)) errors.push(`${path} contains duplicate item ${read(item)}`);
    seen.add(key);
  }
}

function validateKnownIds(values: string[], known: Set<string>, path: string, errors: string[]): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) errors.push(`${path} contains duplicate id ${value}`);
    seen.add(value);
    if (!known.has(value)) errors.push(`${path} references unknown id ${value}`);
  }
}

function validateObjectArray(
  value: unknown,
  path: string,
  maxItems: number,
  errors: string[],
  validate: (entry: unknown, path: string, errors: string[]) => void,
): void {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return;
  }
  if (value.length > maxItems) errors.push(`${path} must contain at most ${maxItems} items`);
  value.forEach((entry, index) => validate(entry, `${path}[${index}]`, errors));
}

function validateStringArray(value: unknown, path: string, maxItems: number, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return;
  }
  if (value.length > maxItems) errors.push(`${path} must contain at most ${maxItems} items`);
  value.forEach((entry, index) => nonEmptyString(entry, `${path}[${index}]`, errors));
}

function strictObject(
  value: unknown,
  path: string,
  expectedKeys: string[],
  errors: string[],
): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) {
    errors.push(`${path} must be an object`);
    return undefined;
  }
  const expected = new Set(expectedKeys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) errors.push(`${path} contains unknown field ${key}`);
  }
  for (const key of expectedKeys) {
    if (!(key in value)) errors.push(`${path} is missing required field ${key}`);
  }
  return value;
}

function nonEmptyString(value: unknown, path: string, errors: string[]): void {
  if (typeof value !== "string" || !value.trim()) errors.push(`${path} must be a non-empty string`);
}

function nullableNonEmptyString(value: unknown, path: string, errors: string[]): void {
  if (value !== null) nonEmptyString(value, path, errors);
}

function enumValue(value: unknown, path: string, allowed: string[], errors: string[]): void {
  if (typeof value !== "string" || !allowed.includes(value)) {
    errors.push(`${path} must be one of ${allowed.join(", ")}`);
  }
}

function renderItems(items: SessionSnapshotItem[]): string[] {
  return items.length > 0
    ? items.map((item) => `- ${singleLine(item.text)} ${renderSources(item.sources)}`)
    : ["- None."];
}

function renderThreads(threads: SessionSnapshotThread[]): string[] {
  return threads.length > 0 ? threads.map((thread) => {
    const details = [
      `goal=${singleLine(thread.goal)}`,
      ...(thread.latestOutcome ? [`outcome=${singleLine(thread.latestOutcome)}`] : []),
      ...(thread.next ? [`next=${singleLine(thread.next)}`] : []),
      ...(thread.taskIds.length > 0 ? [`tasks=${thread.taskIds.join(",")}`] : []),
      ...(thread.runIds.length > 0 ? [`runs=${thread.runIds.join(",")}`] : []),
    ];
    return `- [${thread.status}] ${singleLine(thread.subject)}: ${details.join("; ")} ${renderSources(thread.sources)}`;
  }) : ["- None."];
}

function renderRequests(requests: SessionSnapshotRequest[]): string[] {
  return requests.length > 0
    ? requests.map((request) => `- [${request.status}] ${singleLine(request.text)} ${renderSources(request.sources)}`)
    : ["- None."];
}

function renderProgress(progress: SessionSnapshotProgress[]): string[] {
  return progress.length > 0 ? progress.map((item) => {
    const identity = [item.taskId ? `task=${item.taskId}` : null, `run=${item.runId}`].filter(Boolean).join("; ");
    return `- [${item.status}] ${singleLine(item.summary)} (${identity}) ${renderSources(item.sources)}`;
  }) : ["- None."];
}

function renderStrings(values: string[]): string[] {
  return values.length > 0 ? values.map((value) => `- ${singleLine(value)}`) : ["- None."];
}

function renderSources(sources: SessionSnapshotSource[]): string {
  return `[sources: ${sources.map((source) => {
    if (source.kind === "conversation") return `conversation:${source.seq}`;
    if (source.kind === "task_run") return `run:${source.runId}`;
    return "previous-summary";
  }).join(", ")}]`;
}

function nullableText(value: string | null): string {
  return value ? singleLine(value) : "None.";
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function sourceKey(source: SessionSnapshotSource): string {
  if (source.kind === "conversation") return `conversation:${source.seq}`;
  if (source.kind === "task_run") return `task_run:${source.runId}`;
  return "previous_summary";
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value !== undefined && value > 0 ? value : fallback;
}

function estimateSnapshotTokens(value: unknown): number | undefined {
  if (!isPlainObject(value)) return undefined;
  try {
    return estimateTextTokens(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
