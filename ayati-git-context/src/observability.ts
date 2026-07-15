import { AsyncLocalStorage } from "node:async_hooks";
import type { Writable } from "node:stream";

export type GitContextObservabilityLevel = "debug" | "info" | "warn" | "error";
export type GitContextObservabilityComponent =
  | "git-context-engine"
  | "git-context-http"
  | "git-context-supervisor"
  | "git-context-harness";

export interface GitContextObservabilityEvent {
  v: 1;
  ts: string;
  tsMs: number;
  pid: number;
  level: GitContextObservabilityLevel;
  component: GitContextObservabilityComponent;
  event: string;
  traceId?: string;
  requestId?: string;
  clientId?: string;
  sessionId?: string;
  conversationId?: string;
  runId?: string;
  taskId?: string;
  seq?: number;
  step?: number;
  durationMs?: number;
  outcome?: "started" | "succeeded" | "failed" | "skipped";
  errorCode?: string;
  message?: string;
  data?: Record<string, unknown>;
}

export type GitContextObservabilityEventInput = Omit<
  GitContextObservabilityEvent,
  "v" | "ts" | "tsMs" | "pid" | "component" | "traceId"
> & {
  traceId?: string;
};

export type GitContextObservabilitySink = (event: GitContextObservabilityEvent) => void;

const traceContext = new AsyncLocalStorage<{ traceId: string }>();
const REDACTED_KEY = /(?:authorization|api[_-]?key|password|secret|token|cookie|rawcontent|filecontent)/i;
const MAX_STRING_LENGTH = 2_000;
const MAX_ARRAY_ITEMS = 30;
const MAX_DEPTH = 5;

export class GitContextObserver {
  constructor(
    private readonly component: GitContextObservabilityComponent,
    private readonly sink?: GitContextObservabilitySink,
    private readonly now: () => Date = () => new Date(),
  ) {}

  emit(input: GitContextObservabilityEventInput): GitContextObservabilityEvent {
    const at = this.now();
    const traceId = input.traceId ?? currentGitContextTraceId();
    const event: GitContextObservabilityEvent = {
      v: 1,
      ts: at.toISOString(),
      tsMs: at.getTime(),
      pid: process.pid,
      component: this.component,
      ...input,
      ...(traceId ? { traceId } : {}),
      ...(input.data ? { data: sanitizeObservabilityData(input.data) } : {}),
    };
    this.sink?.(event);
    return event;
  }
}

export function runWithGitContextTrace<T>(traceId: string, operation: () => T): T {
  return traceContext.run({ traceId }, operation);
}

export function currentGitContextTraceId(): string | undefined {
  return traceContext.getStore()?.traceId;
}

export function createJsonLineObservabilitySink(output: Writable): GitContextObservabilitySink {
  return (event) => {
    output.write(JSON.stringify(event) + "\n");
  };
}

export function isGitContextObservabilityEvent(value: unknown): value is GitContextObservabilityEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Partial<GitContextObservabilityEvent>;
  return event.v === 1
    && typeof event.ts === "string"
    && typeof event.tsMs === "number"
    && typeof event.pid === "number"
    && ["debug", "info", "warn", "error"].includes(String(event.level))
    && [
      "git-context-engine",
      "git-context-http",
      "git-context-supervisor",
      "git-context-harness",
    ].includes(String(event.component))
    && typeof event.event === "string";
}

export function sanitizeObservabilityData(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return sanitizeValue(value, 0) as Record<string, unknown>;
}

function sanitizeValue(value: unknown, depth: number, key?: string): unknown {
  if (key && REDACTED_KEY.test(key)) return "[redacted]";
  if (typeof value === "string") {
    return value.length <= MAX_STRING_LENGTH
      ? value
      : value.slice(0, MAX_STRING_LENGTH) + `...[truncated ${value.length - MAX_STRING_LENGTH} chars]`;
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return Array.isArray(value) ? `[array:${value.length}]` : "[object]";
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeValue(item, depth + 1));
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
    entryKey,
    sanitizeValue(entryValue, depth + 1, entryKey),
  ]));
}
