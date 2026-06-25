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

export interface AgentFeedbackLatestSummary {
  updatedAt: string;
  tsMs: number;
  sessionId?: string;
  seq?: number;
  runId?: string;
  status?: string;
  responseKind?: string;
  iterations?: number;
  toolCalls?: number;
  toolLoadDecisions?: number;
  actionSteps?: number;
  verificationPassed?: boolean;
  basedOnVerifiedFacts?: boolean;
  warnings: string[];
  rawPath: string;
}

export type AgentFeedbackTriageOutcome = "healthy" | "needs_review" | "failed";
export type AgentFeedbackTriageSeverity = "info" | "warning" | "error";

export interface AgentFeedbackTriageFinding {
  code: string;
  severity: AgentFeedbackTriageSeverity;
  title: string;
  details: string;
  recommendation: string;
}

export interface AgentFeedbackTriageSummary {
  updatedAt: string;
  tsMs: number;
  sessionId?: string;
  seq?: number;
  runId?: string;
  outcome: AgentFeedbackTriageOutcome;
  findings: AgentFeedbackTriageFinding[];
  topRecommendation?: string;
  rawPath: string;
  rawSummaryPath: string;
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
  private readonly feedbackSignals = new Map<string, Set<string>>();

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
    this.recordFeedbackSignals(event);

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

    const summaryEvent = [...batch].reverse().find((event) => readFeedbackSummary(event) !== undefined);
    if (summaryEvent) {
      const summary = this.buildLatestSummary(summaryEvent);
      const summaryPath = join(this.dataDir, "feedback", "latest-summary.json");
      await mkdir(dirname(summaryPath), { recursive: true });
      await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf-8");

      const triage = buildFeedbackTriageSummary(summary);
      const triagePath = join(this.dataDir, "feedback", "triage-summary.json");
      await writeFile(triagePath, `${JSON.stringify(triage, null, 2)}\n`, "utf-8");
    }
  }

  private recordFeedbackSignals(event: AgentFeedbackEvent): void {
    const key = feedbackScopeKey(event);
    if (!key) {
      return;
    }
    const signals = this.feedbackSignals.get(key) ?? new Set<string>();
    if (event.stage === "decision" && (event.event === "parse_failed" || event.event === "repair_requested")) {
      signals.add("parse_repair_needed");
    }
    if (event.stage === "decision" && event.event === "protocol_violation") {
      signals.add("tool_protocol_violation");
    }
    if (event.stage === "action" && event.event === "failed") {
      signals.add("action_failed");
    }
    if (event.stage === "final" && event.event === "error") {
      signals.add("runtime_error");
    }
    if (signals.size > 0) {
      this.feedbackSignals.set(key, signals);
    }
  }

  private buildLatestSummary(event: AgentFeedbackEvent): AgentFeedbackLatestSummary {
    const feedbackSummary = readFeedbackSummary(event) ?? {};
    const rawWarnings = Array.isArray(feedbackSummary["warnings"]) ? feedbackSummary["warnings"] : [];
    const signalWarnings = this.feedbackSignals.get(feedbackScopeKey(event) ?? "") ?? new Set<string>();
    const warnings = uniqueStrings([
      ...rawWarnings.filter((warning): warning is string => typeof warning === "string" && warning.length > 0),
      ...signalWarnings,
    ]);

    return {
      updatedAt: event.ts,
      tsMs: event.tsMs,
      ...(event.sessionId ? { sessionId: event.sessionId } : {}),
      ...(event.seq !== undefined ? { seq: event.seq } : {}),
      ...(event.runId ? { runId: event.runId } : {}),
      ...(typeof feedbackSummary["status"] === "string" ? { status: feedbackSummary["status"] } : {}),
      ...(typeof feedbackSummary["responseKind"] === "string" ? { responseKind: feedbackSummary["responseKind"] } : {}),
      ...(typeof feedbackSummary["iterations"] === "number" ? { iterations: feedbackSummary["iterations"] } : {}),
      ...(typeof feedbackSummary["toolCalls"] === "number" ? { toolCalls: feedbackSummary["toolCalls"] } : {}),
      ...(typeof feedbackSummary["toolLoadDecisions"] === "number" ? { toolLoadDecisions: feedbackSummary["toolLoadDecisions"] } : {}),
      ...(typeof feedbackSummary["actionSteps"] === "number" ? { actionSteps: feedbackSummary["actionSteps"] } : {}),
      ...(typeof feedbackSummary["verificationPassed"] === "boolean" ? { verificationPassed: feedbackSummary["verificationPassed"] } : {}),
      ...(typeof feedbackSummary["basedOnVerifiedFacts"] === "boolean" ? { basedOnVerifiedFacts: feedbackSummary["basedOnVerifiedFacts"] } : {}),
      warnings,
      rawPath: feedbackRelativePath(event).replace(/\\/g, "/"),
    };
  }
}

export function buildFeedbackTriageSummary(summary: AgentFeedbackLatestSummary): AgentFeedbackTriageSummary {
  const findings: AgentFeedbackTriageFinding[] = [];
  const warningSet = new Set(summary.warnings);

  if (summary.status && summary.status !== "completed") {
    findings.push({
      code: "run_not_completed",
      severity: "error",
      title: "Run did not complete",
      details: `Final status was '${summary.status}'.`,
      recommendation: "Inspect the raw feedback log and final error path before changing prompts or tools.",
    });
  }

  if (warningSet.has("runtime_error")) {
    findings.push({
      code: "runtime_error",
      severity: "error",
      title: "Runtime error observed",
      details: "The harness recorded a final runtime error during this request.",
      recommendation: "Fix the runtime failure first; model behavior is not meaningful until the run is stable.",
    });
  }

  if (warningSet.has("action_failed")) {
    findings.push({
      code: "action_failed",
      severity: "error",
      title: "Action execution failed",
      details: "At least one tool action failed before the final response.",
      recommendation: "Review the failed tool call, input schema, and retry hint in the raw feedback log.",
    });
  }

  if (warningSet.has("verification_failed") || summary.verificationPassed === false && (summary.actionSteps ?? 0) > 0) {
    findings.push({
      code: "verification_failed",
      severity: "warning",
      title: "Verification did not pass",
      details: "The run attempted executable work without a successful verification signal.",
      recommendation: "Check whether the tool contract is too weak, the reducer missed valid evidence, or the model stopped too early.",
    });
  }

  if (summary.basedOnVerifiedFacts === false && (summary.actionSteps ?? 0) > 0) {
    findings.push({
      code: "ungrounded_final_reply",
      severity: "warning",
      title: "Final reply was not grounded in verified facts",
      details: "The final response followed executable work but no verified facts were recorded.",
      recommendation: "Improve tool contracts or progress reduction so useful evidence becomes visible before the final reply.",
    });
  }

  if (warningSet.has("tool_protocol_violation")) {
    findings.push({
      code: "tool_protocol_violation",
      severity: "warning",
      title: "Decision violated the native tool protocol",
      details: "The model selected an unavailable tool, used tool loading as executable work, or produced an invalid action shape.",
      recommendation: "Tighten the decision prompt or add a benchmark case for the failed tool-loading pattern.",
    });
  }

  if (warningSet.has("parse_repair_needed")) {
    findings.push({
      code: "decision_repair_needed",
      severity: "warning",
      title: "Decision required repair",
      details: "The first decision response could not be parsed or needed repair.",
      recommendation: "Inspect the provider response and keep contract tests around the native decision tool surface.",
    });
  }

  if (warningSet.has("tool_load_no_action")) {
    findings.push({
      code: "tool_load_no_action",
      severity: "warning",
      title: "Tools were loaded but no action ran",
      details: "The model requested tools, but the run ended before executable work used them.",
      recommendation: "Check whether selected tools were missing, the load result confused the model, or the final reply stopped early.",
    });
  }

  if (warningSet.has("repeated_tool_load")) {
    findings.push({
      code: "repeated_tool_load",
      severity: "warning",
      title: "Repeated tool loading",
      details: `The run made ${summary.toolLoadDecisions ?? 0} tool-load decisions.`,
      recommendation: "Improve tool routing groups or deterministic preload hints for this request class.",
    });
  }

  if (warningSet.has("completed_without_tool_calls")) {
    findings.push({
      code: "completed_without_tool_calls",
      severity: "warning",
      title: "Completed without tool calls",
      details: "The run completed without executable tool calls even though the harness classified it as work.",
      recommendation: "Check whether the run should have been conversational, or whether the decision prompt allowed a premature reply.",
    });
  }

  if ((summary.iterations ?? 0) >= 10) {
    findings.push({
      code: "many_iterations",
      severity: "warning",
      title: "High iteration count",
      details: `The run took ${summary.iterations ?? 0} decision iterations.`,
      recommendation: "Review whether tool routing, context state, or verification feedback caused avoidable loops.",
    });
  }

  if (findings.length === 0) {
    findings.push({
      code: "healthy_run",
      severity: "info",
      title: "No triage findings",
      details: "The latest run completed without recorded warning signals.",
      recommendation: "Use benchmark and live feedback aggregates to find broader recurring issues.",
    });
  }

  const outcome = findings.some((finding) => finding.severity === "error")
    ? "failed"
    : findings.some((finding) => finding.severity === "warning")
      ? "needs_review"
      : "healthy";

  return {
    updatedAt: summary.updatedAt,
    tsMs: summary.tsMs,
    ...(summary.sessionId ? { sessionId: summary.sessionId } : {}),
    ...(summary.seq !== undefined ? { seq: summary.seq } : {}),
    ...(summary.runId ? { runId: summary.runId } : {}),
    outcome,
    findings,
    topRecommendation: findings[0]?.recommendation,
    rawPath: summary.rawPath,
    rawSummaryPath: "feedback/latest-summary.json",
  };
}

function readFeedbackSummary(event: AgentFeedbackEvent): Record<string, unknown> | undefined {
  const summary = event.data?.["feedbackSummary"];
  return summary && typeof summary === "object" && !Array.isArray(summary)
    ? summary as Record<string, unknown>
    : undefined;
}

function feedbackScopeKey(event: AgentFeedbackEvent): string | undefined {
  if (!event.sessionId || event.seq === undefined) {
    return undefined;
  }
  return `${event.sessionId}:${event.seq}`;
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

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
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
