import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { devWarn } from "../shared/index.js";

export interface AgentFeedbackEventInput {
  clientId?: string;
  sessionId?: string;
  seq?: number;
  runId?: string;
  stage: string;
  event: string;
  data?: Record<string, unknown>;
}

export interface AgentFeedbackEvent extends AgentFeedbackEventInput {
  ts: string;
  tsMs: number;
}

export interface AgentFeedbackLedger {
  readonly enabled: boolean;
  record(event: AgentFeedbackEventInput): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface AgentFeedbackLedgerOptions {
  dataDir: string;
  enabled?: boolean;
  traceToConsole?: boolean;
  fullPayloads?: boolean;
  maxQueueSize?: number;
  now?: () => Date;
}

const DEFAULT_MAX_QUEUE_SIZE = 2_000;
const MAX_STRING_CHARS = 2_000;
const MAX_ARRAY_ITEMS = 20;
const MAX_OBJECT_KEYS = 60;
const MAX_DEPTH = 5;
const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

export function createAgentFeedbackLedgerFromEnv(input: {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
}): AgentFeedbackLedger {
  const env = input.env ?? process.env;
  const enabled = parseEnvFlag(env["AYATI_TEST_AGENT"]) && parseEnvFlag(env["AYATI_FEEDBACK_TRACE"]);
  return new AsyncAgentFeedbackLedger({
    dataDir: input.dataDir,
    enabled,
    traceToConsole: enabled,
    fullPayloads: parseEnvFlag(env["AYATI_FEEDBACK_FULL"]),
  });
}

export class AsyncAgentFeedbackLedger implements AgentFeedbackLedger {
  readonly enabled: boolean;
  private readonly dataDir: string;
  private readonly traceToConsole: boolean;
  private readonly fullPayloads: boolean;
  private readonly maxQueueSize: number;
  private readonly now: () => Date;
  private queue: AgentFeedbackEvent[] = [];
  private drainScheduled = false;
  private draining: Promise<void> | null = null;
  private droppedEvents = 0;

  constructor(options: AgentFeedbackLedgerOptions) {
    this.enabled = options.enabled === true;
    this.dataDir = options.dataDir;
    this.traceToConsole = options.traceToConsole === true;
    this.fullPayloads = options.fullPayloads === true;
    this.maxQueueSize = options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
    this.now = options.now ?? (() => new Date());
  }

  record(input: AgentFeedbackEventInput): void {
    if (!this.enabled) {
      return;
    }

    const now = this.now();
    const event: AgentFeedbackEvent = {
      ...input,
      ts: now.toISOString(),
      tsMs: now.getTime(),
      ...(input.data ? { data: compactFeedbackValue(input.data, this.fullPayloads) as Record<string, unknown> } : {}),
    };

    if (this.queue.length >= this.maxQueueSize) {
      this.queue.shift();
      this.droppedEvents++;
    }
    this.queue.push(event);
    if (this.traceToConsole) {
      logFeedbackEvent(event);
    }
    this.scheduleDrain();
  }

  async flush(): Promise<void> {
    while (this.draining || this.queue.length > 0) {
      if (this.draining) {
        await this.draining;
        continue;
      }
      await this.drainNow();
    }
  }

  async close(): Promise<void> {
    await this.flush();
  }

  private scheduleDrain(): void {
    if (this.drainScheduled || this.draining) {
      return;
    }
    this.drainScheduled = true;
    setImmediate(() => {
      this.drainScheduled = false;
      this.draining = this.drainNow().finally(() => {
        this.draining = null;
        if (this.queue.length > 0) {
          this.scheduleDrain();
        }
      });
    });
  }

  private async drainNow(): Promise<void> {
    const batch = this.takeBatch();
    if (batch.length === 0) {
      return;
    }
    try {
      await this.writeBatch(batch);
    } catch (error) {
      devWarn(`Agent feedback write failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private takeBatch(): AgentFeedbackEvent[] {
    const batch = this.queue.splice(0);
    if (this.droppedEvents > 0) {
      const now = this.now();
      const context = batch[0];
      batch.unshift({
        ...(context?.clientId ? { clientId: context.clientId } : {}),
        ...(context?.sessionId ? { sessionId: context.sessionId } : {}),
        ...(context?.seq !== undefined ? { seq: context.seq } : {}),
        ...(context?.runId ? { runId: context.runId } : {}),
        ts: now.toISOString(),
        tsMs: now.getTime(),
        stage: "feedback",
        event: "dropped",
        data: {
          count: this.droppedEvents,
          reason: "queue_overflow",
        },
      });
      this.droppedEvents = 0;
    }
    return batch;
  }

  private async writeBatch(batch: AgentFeedbackEvent[]): Promise<void> {
    const groups = new Map<string, AgentFeedbackEvent[]>();
    for (const event of batch) {
      const relativePath = feedbackRelativePath(event);
      const existing = groups.get(relativePath) ?? [];
      existing.push(event);
      groups.set(relativePath, existing);
    }

    for (const [relativePath, events] of groups) {
      const absolutePath = join(this.dataDir, relativePath);
      await mkdir(dirname(absolutePath), { recursive: true });
      await appendFile(absolutePath, events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf-8");
    }

    const latest = batch[batch.length - 1];
    if (latest) {
      const latestPath = join(this.dataDir, "feedback", "latest.json");
      await mkdir(dirname(latestPath), { recursive: true });
      await writeFile(latestPath, `${JSON.stringify({
        updatedAt: latest.ts,
        tsMs: latest.tsMs,
        sessionId: latest.sessionId,
        seq: latest.seq,
        runId: latest.runId,
        path: feedbackRelativePath(latest).replace(/\\/g, "/"),
      }, null, 2)}\n`, "utf-8");
    }
  }
}

function feedbackRelativePath(event: AgentFeedbackEvent): string {
  const date = event.ts.slice(0, 10) || "unknown-date";
  const sessionId = sanitizePathPart(event.sessionId ?? "unknown-session");
  return join("feedback", date, `session-${sessionId}.jsonl`);
}

function sanitizePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120) || "unknown";
}

function logFeedbackEvent(event: AgentFeedbackEvent): void {
  const parts = [
    `[FEEDBACK] ${event.ts}`,
    event.clientId ? `client=${event.clientId}` : "",
    event.seq !== undefined ? `seq=${event.seq}` : "",
    event.runId ? `run=${event.runId}` : "",
    `stage=${event.stage}`,
    `event=${event.event}`,
  ].filter((part) => part.length > 0);
  console.log(parts.join(" "));
}

function parseEnvFlag(value: string | undefined): boolean {
  return value !== undefined && TRUE_VALUES.has(value.trim().toLowerCase());
}

function compactFeedbackValue(value: unknown, fullPayloads: boolean, depth = 0): unknown {
  if (fullPayloads) {
    return value;
  }
  if (typeof value === "string") {
    return truncateString(value, MAX_STRING_CHARS);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (depth >= MAX_DEPTH) {
    return summarizeDeepValue(value);
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => compactFeedbackValue(item, fullPayloads, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) {
      items.push(`[truncated ${value.length - MAX_ARRAY_ITEMS} items]`);
    }
    return items;
  }
  const entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_OBJECT_KEYS);
  const compacted: Record<string, unknown> = {};
  for (const [key, child] of entries) {
    compacted[key] = compactFeedbackValue(child, fullPayloads, depth + 1);
  }
  const omitted = Object.keys(value as Record<string, unknown>).length - entries.length;
  if (omitted > 0) {
    compacted["__truncatedKeys"] = omitted;
  }
  return compacted;
}

function truncateString(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars).trimEnd()}...[truncated ${value.length - maxChars} chars]`;
}

function summarizeDeepValue(value: object): string {
  return Array.isArray(value)
    ? `[array ${value.length} items]`
    : `[object ${Object.keys(value).length} keys]`;
}
