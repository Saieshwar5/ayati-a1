export type FeedbackTaskSelectionMode = "created" | "activated";
export type FeedbackTaskRequestDecision = "initial" | "continue" | "create";
export type FeedbackTaskFinalizationStatus = "not_started" | "started" | "committed" | "skipped" | "failed";

export interface FeedbackTaskRepository {
  taskId?: string;
  workingDirectory?: string;
  branch?: string;
  selectionMode?: FeedbackTaskSelectionMode;
  taskCreated?: boolean;
  health?: "ready" | "dirty_external" | "unavailable";
  headBefore?: string;
  headAfter?: string;
}

export interface FeedbackTaskRequest {
  decision?: FeedbackTaskRequestDecision;
  requestId?: string;
  status?: "queued" | "active" | "blocked" | "done" | "dropped";
  created?: boolean;
}

export interface FeedbackTaskRun {
  runId?: string;
  startedAs?: "none" | "session" | "task";
  selectedAs?: "session" | "task";
  sessionRunBound?: boolean;
}

export interface FeedbackTaskFinalization {
  status?: FeedbackTaskFinalizationStatus;
  outcome?: "done" | "incomplete" | "failed" | "blocked" | "needs_user_input";
  validation?: "passed" | "failed" | "not_run";
  commit?: string;
  commitCreated?: boolean;
  headBefore?: string;
  headAfter?: string;
}

export interface FeedbackTaskLifecycle {
  repository?: FeedbackTaskRepository;
  request?: FeedbackTaskRequest;
  run?: FeedbackTaskRun;
  finalization?: FeedbackTaskFinalization;
}

export function mergeFeedbackTaskLifecycle(
  current: FeedbackTaskLifecycle | undefined,
  update: FeedbackTaskLifecycle | undefined,
): FeedbackTaskLifecycle | undefined {
  if (!current) return compactFeedbackTaskLifecycle(update);
  if (!update) return compactFeedbackTaskLifecycle(current);
  return compactFeedbackTaskLifecycle({
    repository: mergeDefined(current.repository, update.repository),
    request: mergeDefined(current.request, update.request),
    run: mergeDefined(current.run, update.run),
    finalization: mergeDefined(current.finalization, update.finalization),
  });
}

export function readFeedbackTaskLifecycle(value: unknown): FeedbackTaskLifecycle | undefined {
  if (!isRecord(value)) return undefined;
  return compactFeedbackTaskLifecycle({
    repository: readRepository(value["repository"]),
    request: readRequest(value["request"]),
    run: readRun(value["run"]),
    finalization: readFinalization(value["finalization"]),
  });
}

export function compactFeedbackTaskLifecycle(
  value: FeedbackTaskLifecycle | undefined,
): FeedbackTaskLifecycle | undefined {
  if (!value) return undefined;
  const compacted: FeedbackTaskLifecycle = {
    ...(hasValues(value.repository) ? { repository: value.repository } : {}),
    ...(hasValues(value.request) ? { request: value.request } : {}),
    ...(hasValues(value.run) ? { run: value.run } : {}),
    ...(hasValues(value.finalization) ? { finalization: value.finalization } : {}),
  };
  return Object.keys(compacted).length > 0 ? compacted : undefined;
}

function readRepository(value: unknown): FeedbackTaskRepository | undefined {
  if (!isRecord(value)) return undefined;
  const selectionMode = oneOf(value["selectionMode"], ["created", "activated"] as const);
  const health = oneOf(value["health"], ["ready", "dirty_external", "unavailable"] as const);
  return compactRecord({
    taskId: stringValue(value["taskId"]),
    workingDirectory: stringValue(value["workingDirectory"]),
    branch: stringValue(value["branch"]),
    selectionMode,
    taskCreated: booleanValue(value["taskCreated"]),
    health,
    headBefore: stringValue(value["headBefore"]),
    headAfter: stringValue(value["headAfter"]),
  });
}

function readRequest(value: unknown): FeedbackTaskRequest | undefined {
  if (!isRecord(value)) return undefined;
  const decision = oneOf(value["decision"], ["initial", "continue", "create"] as const);
  const status = oneOf(value["status"], ["queued", "active", "blocked", "done", "dropped"] as const);
  return compactRecord({
    decision,
    requestId: stringValue(value["requestId"]),
    status,
    created: booleanValue(value["created"]),
  });
}

function readRun(value: unknown): FeedbackTaskRun | undefined {
  if (!isRecord(value)) return undefined;
  return compactRecord({
    runId: stringValue(value["runId"]),
    startedAs: oneOf(value["startedAs"], ["none", "session", "task"] as const),
    selectedAs: oneOf(value["selectedAs"], ["session", "task"] as const),
    sessionRunBound: booleanValue(value["sessionRunBound"]),
  });
}

function readFinalization(value: unknown): FeedbackTaskFinalization | undefined {
  if (!isRecord(value)) return undefined;
  return compactRecord({
    status: oneOf(value["status"], ["not_started", "started", "committed", "skipped", "failed"] as const),
    outcome: oneOf(value["outcome"], ["done", "incomplete", "failed", "blocked", "needs_user_input"] as const),
    validation: oneOf(value["validation"], ["passed", "failed", "not_run"] as const),
    commit: stringValue(value["commit"]),
    commitCreated: booleanValue(value["commitCreated"]),
    headBefore: stringValue(value["headBefore"]),
    headAfter: stringValue(value["headAfter"]),
  });
}

function mergeDefined<T extends object>(current: T | undefined, update: T | undefined): T | undefined {
  if (!current) return update;
  if (!update) return current;
  return { ...current, ...withoutUndefined(update) };
}

function withoutUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

function compactRecord<T extends object>(value: T): T | undefined {
  const compacted = withoutUndefined(value) as T;
  return Object.keys(compacted).length > 0 ? compacted : undefined;
}

function hasValues(value: object | undefined): boolean {
  return Boolean(value && Object.values(value).some((entry) => entry !== undefined));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function oneOf<const T extends readonly string[]>(value: unknown, choices: T): T[number] | undefined {
  return typeof value === "string" && choices.includes(value) ? value as T[number] : undefined;
}
