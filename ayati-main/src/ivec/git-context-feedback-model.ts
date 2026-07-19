export type FeedbackWorkstreamSelectionMode = "created" | "activated";
export type FeedbackWorkstreamRequestDecision = "initial" | "continue" | "create";
export type FeedbackWorkstreamFinalizationStatus = "not_started" | "started" | "not_required" | "no_change" | "committed" | "failed";

export interface FeedbackWorkstreamRepository {
  workstreamId?: string;
  contextRepositoryPath?: string;
  branch?: string;
  selectionMode?: FeedbackWorkstreamSelectionMode;
  workstreamCreated?: boolean;
  health?: "ready" | "dirty_external" | "unavailable";
  headBefore?: string;
  headAfter?: string;
}

export interface FeedbackWorkstreamRequest {
  decision?: FeedbackWorkstreamRequestDecision;
  requestId?: string;
  status?: "queued" | "active" | "blocked" | "done" | "dropped";
  created?: boolean;
}

export interface FeedbackRun {
  runId?: string;
  workstreamBound?: boolean;
}

export interface FeedbackWorkstreamFinalization {
  status?: FeedbackWorkstreamFinalizationStatus;
  outcome?: "done" | "incomplete" | "failed" | "blocked" | "needs_user_input";
  validation?: "passed" | "failed" | "not_applicable";
  commit?: string;
  commitCreated?: boolean;
  headBefore?: string;
  headAfter?: string;
}

export interface FeedbackWorkstreamLifecycle {
  repository?: FeedbackWorkstreamRepository;
  request?: FeedbackWorkstreamRequest;
  run?: FeedbackRun;
  finalization?: FeedbackWorkstreamFinalization;
}

export function mergeFeedbackWorkstreamLifecycle(
  current: FeedbackWorkstreamLifecycle | undefined,
  update: FeedbackWorkstreamLifecycle | undefined,
): FeedbackWorkstreamLifecycle | undefined {
  if (!current) return compactFeedbackWorkstreamLifecycle(update);
  if (!update) return compactFeedbackWorkstreamLifecycle(current);
  return compactFeedbackWorkstreamLifecycle({
    repository: mergeDefined(current.repository, update.repository),
    request: mergeDefined(current.request, update.request),
    run: mergeDefined(current.run, update.run),
    finalization: mergeDefined(current.finalization, update.finalization),
  });
}

export function readFeedbackWorkstreamLifecycle(value: unknown): FeedbackWorkstreamLifecycle | undefined {
  if (!isRecord(value)) return undefined;
  return compactFeedbackWorkstreamLifecycle({
    repository: readRepository(value["repository"]),
    request: readRequest(value["request"]),
    run: readRun(value["run"]),
    finalization: readFinalization(value["finalization"]),
  });
}

export function compactFeedbackWorkstreamLifecycle(
  value: FeedbackWorkstreamLifecycle | undefined,
): FeedbackWorkstreamLifecycle | undefined {
  if (!value) return undefined;
  const compacted: FeedbackWorkstreamLifecycle = {
    ...(hasValues(value.repository) ? { repository: value.repository } : {}),
    ...(hasValues(value.request) ? { request: value.request } : {}),
    ...(hasValues(value.run) ? { run: value.run } : {}),
    ...(hasValues(value.finalization) ? { finalization: value.finalization } : {}),
  };
  return Object.keys(compacted).length > 0 ? compacted : undefined;
}

function readRepository(value: unknown): FeedbackWorkstreamRepository | undefined {
  if (!isRecord(value)) return undefined;
  const selectionMode = oneOf(value["selectionMode"], ["created", "activated"] as const);
  const health = oneOf(value["health"], ["ready", "dirty_external", "unavailable"] as const);
  return compactRecord({
    workstreamId: stringValue(value["workstreamId"]),
    contextRepositoryPath: stringValue(value["contextRepositoryPath"]),
    branch: stringValue(value["branch"]),
    selectionMode,
    workstreamCreated: booleanValue(value["workstreamCreated"]),
    health,
    headBefore: stringValue(value["headBefore"]),
    headAfter: stringValue(value["headAfter"]),
  });
}

function readRequest(value: unknown): FeedbackWorkstreamRequest | undefined {
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

function readRun(value: unknown): FeedbackRun | undefined {
  if (!isRecord(value)) return undefined;
  return compactRecord({
    runId: stringValue(value["runId"]),
    workstreamBound: booleanValue(value["workstreamBound"]),
  });
}

function readFinalization(value: unknown): FeedbackWorkstreamFinalization | undefined {
  if (!isRecord(value)) return undefined;
  return compactRecord({
    status: oneOf(value["status"], ["not_started", "started", "not_required", "no_change", "committed", "failed"] as const),
    outcome: oneOf(value["outcome"], ["done", "incomplete", "failed", "blocked", "needs_user_input"] as const),
    validation: oneOf(value["validation"], ["passed", "failed", "not_applicable"] as const),
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
