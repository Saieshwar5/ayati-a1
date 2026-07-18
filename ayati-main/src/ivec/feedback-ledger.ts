import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ContextEngineMachineContext } from "../context-engine/index.js";
import { devWarn } from "../shared/index.js";
import {
  compactFeedbackTaskLifecycle,
  mergeFeedbackTaskLifecycle,
  readFeedbackTaskLifecycle,
  type FeedbackTaskLifecycle,
} from "./git-context-feedback-model.js";
import { buildGitContextLifecycleFindings } from "./git-context-feedback-triage.js";
import {
  readFeedbackConversationPersistenceState,
  type FeedbackConversationPersistenceState,
} from "./conversation-persistence-feedback.js";
import {
  deriveFeedbackExecutionOutcome,
  type FeedbackExecutionEvidence,
  type FeedbackExecutionOutcome,
} from "./execution-outcome-feedback.js";
import {
  buildExecutionOutcomeFindings,
  isHealthyConversationOutcome,
  type FeedbackExecutionTriageInput,
} from "./execution-outcome-triage.js";

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
  conversationPersistence?: FeedbackConversationPersistenceState;
  execution?: FeedbackExecutionOutcome;
  contextEngine?: AgentFeedbackContextEngineSummary;
  warnings: string[];
  rawPath: string;
}

export type AgentFeedbackContextRouteSource = "auto" | "agent_tool" | "deterministic_router" | "runtime" | "unknown";
export type AgentFeedbackContextFinalizationStatus = "not_started" | "started" | "committed" | "skipped" | "failed";

export interface AgentFeedbackContextEngineSummary {
  pendingTurnStatus?: string;
  pendingTurnRange?: {
    fromSeq: number;
    toSeq: number;
  };
  routeStatus?: string;
  routeMode?: string;
  routeSource?: AgentFeedbackContextRouteSource;
  finalizationStatus?: AgentFeedbackContextFinalizationStatus;
  activeTaskId?: string;
  taskId?: string;
  branch?: string;
  ref?: string;
  runId?: string;
  committed?: boolean;
  commit?: string;
  conversationRefs?: Array<{
    fromSeq: number;
    toSeq: number;
  }>;
  pendingWriteCount?: number;
  taskAssetCount?: number;
  recentRunCount?: number;
  recentEvidenceCount?: number;
  contextRevision?: string;
  previousContextRevision?: string;
  cacheStatus?: "hit" | "miss" | "fresh";
  cacheHits?: number;
  cacheMisses?: number;
  cacheRefreshes?: number;
  runClass?: "session" | "task";
  workStateRevision?: number;
  lastPersistedStep?: number;
  taskLifecycle?: FeedbackTaskLifecycle;
  warningCodes?: string[];
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
  private readonly contextEngineSignals = new Map<string, AgentFeedbackContextEngineSummary>();
  private readonly conversationPersistenceSignals = new Map<
    string,
    FeedbackConversationPersistenceState
  >();
  private readonly latestSummaries = new Map<string, AgentFeedbackLatestSummary>();

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
    this.recordContextEngineSignals(event);
    this.recordConversationPersistenceSignal(event);

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

    const latestSession = [...batch].reverse().find((event) => Boolean(event.sessionId));
    if (latestSession) {
      await writeFeedbackPointer(this.dataDir, "latest-session.json", latestSession);
    }
    const latestRun = [...batch].reverse().find((event) => Boolean(event.sessionId && event.runId));
    if (latestRun) {
      await writeFeedbackPointer(this.dataDir, "latest-run.json", latestRun);
    }
    const latestProcess = [...batch].reverse().find((event) => !event.sessionId);
    if (latestProcess) {
      await writeFeedbackPointer(this.dataDir, "latest-process.json", latestProcess);
    }

    const summaryEvent = [...batch].reverse().find((event) => readFeedbackSummary(event) !== undefined);
    if (summaryEvent) {
      const summary = this.buildLatestSummary(summaryEvent);
      const scopeKey = feedbackScopeKey(summaryEvent);
      if (scopeKey) {
        this.latestSummaries.set(scopeKey, summary);
      }
      const summaryPath = join(this.dataDir, "feedback", "latest-summary.json");
      await mkdir(dirname(summaryPath), { recursive: true });
      await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf-8");

      const triage = buildFeedbackTriageSummary(summary);
      const triagePath = join(this.dataDir, "feedback", "triage-summary.json");
      await writeFile(triagePath, `${JSON.stringify(triage, null, 2)}\n`, "utf-8");
    } else {
      const signalEvent = [...batch].reverse().find((event) =>
        feedbackScopeKey(event) && hasCompactSummarySignal(event)
      );
      const scopeKey = signalEvent ? feedbackScopeKey(signalEvent) : undefined;
      const previousSummary = scopeKey ? this.latestSummaries.get(scopeKey) : undefined;
      if (signalEvent && scopeKey && previousSummary) {
        const summary = this.withLatestSignals(previousSummary, signalEvent);
        this.latestSummaries.set(scopeKey, summary);
        const summaryPath = join(this.dataDir, "feedback", "latest-summary.json");
        await mkdir(dirname(summaryPath), { recursive: true });
        await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf-8");

        const triage = buildFeedbackTriageSummary(summary);
        const triagePath = join(this.dataDir, "feedback", "triage-summary.json");
        await writeFile(triagePath, `${JSON.stringify(triage, null, 2)}\n`, "utf-8");
      }
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
    if (event.stage === "decision" && event.event === "provider_empty_response") {
      signals.add("provider_empty_response");
    }
    if (event.stage === "decision" && event.event === "provider_malformed_response") {
      signals.add("provider_malformed_response");
    }
    if (event.stage === "guard" && event.event === "fresh_session_tool_repair_requested") {
      signals.add("fresh_session_tool_repair_requested");
    }
    if (event.stage === "action" && event.event === "failed") {
      signals.add("action_failed");
    }
    if (event.stage === "context_engine" && event.event === "harness_context_refresh_failed") {
      signals.add("context_refresh_failed");
    }
    if (event.stage === "context_engine" && event.event === "run_step_persistence_failed") {
      signals.add("run_step_persistence_failed");
    }
    if (event.stage === "final" && event.event === "error") {
      signals.add("runtime_error");
      const message = typeof event.data?.["message"] === "string" ? event.data["message"] : "";
      if (message.includes("Git-memory routed run is required") || message.includes("Git-memory run handle is required")) {
        signals.add("missing_work_run_for_action");
      }
    }
    const repairCode = readRepairCode(event.data?.["repair"]);
    if (repairCode) {
      signals.add(repairCode);
    }
    for (const warning of readStringArray(event.data?.["warningCodes"])) {
      signals.add(warning);
    }
    const nestedContext = readContextEngineFeedbackSummary(event.data?.["contextEngine"]);
    for (const warning of nestedContext?.warningCodes ?? []) {
      signals.add(warning);
    }
    if (signals.size > 0) {
      this.feedbackSignals.set(key, signals);
    }
  }

  private recordContextEngineSignals(event: AgentFeedbackEvent): void {
    const key = feedbackScopeKey(event);
    if (!key) {
      return;
    }
    const summary = contextEngineFeedbackFromEvent(event);
    if (!summary) {
      return;
    }
    const merged = mergeContextEngineFeedbackSummary(this.contextEngineSignals.get(key), summary);
    if (merged) {
      this.contextEngineSignals.set(key, merged);
    }
  }

  private recordConversationPersistenceSignal(event: AgentFeedbackEvent): void {
    const key = feedbackScopeKey(event);
    const persistence = conversationPersistenceFromEvent(event);
    if (key && persistence) {
      this.conversationPersistenceSignals.set(key, persistence);
    }
  }

  private buildLatestSummary(event: AgentFeedbackEvent): AgentFeedbackLatestSummary {
    const feedbackSummary = readFeedbackSummary(event) ?? {};
    const rawWarnings = Array.isArray(feedbackSummary["warnings"]) ? feedbackSummary["warnings"] : [];
    const verificationPassed = typeof feedbackSummary["verificationPassed"] === "boolean"
      ? feedbackSummary["verificationPassed"]
      : undefined;
    const signalWarnings = this.feedbackSignals.get(feedbackScopeKey(event) ?? "") ?? new Set<string>();
    const warnings = uniqueStrings([
      ...rawWarnings.filter((warning): warning is string => typeof warning === "string" && warning.length > 0),
      ...signalWarnings,
    ]);

    const contextEngine = mergeContextEngineFeedbackSummary(
      readContextEngineFeedbackSummary(feedbackSummary["contextEngine"]),
      this.contextEngineSignals.get(feedbackScopeKey(event) ?? ""),
    );
    const conversationPersistence = readFeedbackConversationPersistenceState(
      feedbackSummary["conversationPersistence"],
    ) ?? this.conversationPersistenceSignals.get(feedbackScopeKey(event) ?? "");

    const summary: AgentFeedbackLatestSummary = {
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
      ...(typeof feedbackSummary["basedOnVerifiedFacts"] === "boolean" ? { basedOnVerifiedFacts: feedbackSummary["basedOnVerifiedFacts"] } : {}),
      ...(conversationPersistence ? { conversationPersistence } : {}),
      ...(contextEngine ? { contextEngine } : {}),
      warnings,
      rawPath: feedbackRelativePath(event).replace(/\\/g, "/"),
    };
    return {
      ...summary,
      execution: deriveFeedbackExecutionOutcome(executionEvidence(summary, verificationPassed)),
    };
  }

  private withLatestSignals(
    summary: AgentFeedbackLatestSummary,
    event: AgentFeedbackEvent,
  ): AgentFeedbackLatestSummary {
    const contextEngine = mergeContextEngineFeedbackSummary(
      summary.contextEngine,
      this.contextEngineSignals.get(feedbackScopeKey(event) ?? ""),
    );
    const signalWarnings = this.feedbackSignals.get(feedbackScopeKey(event) ?? "") ?? new Set<string>();
    const conversationPersistence = this.conversationPersistenceSignals.get(
      feedbackScopeKey(event) ?? "",
    );
    const next: AgentFeedbackLatestSummary = {
      ...summary,
      updatedAt: event.ts,
      tsMs: event.tsMs,
      ...(event.runId ? { runId: event.runId } : {}),
      ...(conversationPersistence ? { conversationPersistence } : {}),
      ...(contextEngine ? { contextEngine } : {}),
      warnings: uniqueStrings([
        ...summary.warnings,
        ...signalWarnings,
      ]),
    };
    return {
      ...next,
      execution: deriveFeedbackExecutionOutcome(executionEvidence(next)),
    };
  }
}

function executionEvidence(
  summary: AgentFeedbackLatestSummary,
  verificationPassed?: boolean,
): FeedbackExecutionEvidence {
  const context = summary.contextEngine;
  const lifecycle = context?.taskLifecycle;
  const finalization = lifecycle?.finalization;
  const warningSet = new Set(summary.warnings);
  return {
    actionSteps: summary.actionSteps,
    verificationPassed: verificationPassed
      ?? (summary.execution?.verification === "passed"
        ? true
        : summary.execution?.verification === "failed" ? false : undefined),
    verificationFailed: warningSet.has("verification_failed")
      || warningSet.has("R_VERIFICATION_FAILED"),
    runClass: context?.runClass,
    taskSelected: lifecycle?.run?.selectedAs === "task"
      || Boolean(context?.taskId && context.runId),
    finalizationStatus: finalization?.status ?? context?.finalizationStatus,
    committed: context?.committed ?? (finalization?.status === "committed"),
    commitIdentity: finalization?.commit ?? context?.commit,
    commitCreated: finalization?.commitCreated,
  };
}

function executionTriageInput(
  summary: AgentFeedbackLatestSummary,
): FeedbackExecutionTriageInput {
  const context = summary.contextEngine;
  const lifecycle = context?.taskLifecycle;
  return {
    execution: summary.execution,
    actionSteps: summary.actionSteps,
    taskRun: context?.runClass === "task"
      || lifecycle?.run?.selectedAs === "task"
      || Boolean(context?.taskId && context.runId),
    commitIdentity: lifecycle?.finalization?.commit ?? context?.commit,
  };
}

export function buildContextEngineFeedbackSummary(input: {
  context?: ContextEngineMachineContext;
  pendingTurnStatus?: string;
  routeStatus?: string;
  routeMode?: string;
  routeSource?: AgentFeedbackContextRouteSource;
  finalizationStatus?: AgentFeedbackContextFinalizationStatus;
  taskId?: string;
  branch?: string;
  ref?: string;
  runId?: string;
  committed?: boolean;
  commit?: string;
  conversationRefs?: AgentFeedbackContextEngineSummary["conversationRefs"];
  warningCodes?: string[];
  taskLifecycle?: FeedbackTaskLifecycle;
}): AgentFeedbackContextEngineSummary | undefined {
  const context = input.context;
  const pendingTurn = context?.pendingTurn;
  const task = context?.task;
  const focus = context?.focus;
  const activeTaskId = focus?.status === "active" ? focus.workId : undefined;
  const activeRef = focus?.status === "active" ? focus.ref : undefined;
  const taskRef = task?.ref;
  const ref = input.ref ?? taskRef ?? activeRef;
  const branch = input.branch ?? pendingTurn?.branch ?? branchFromRef(ref);
  const taskId = input.taskId ?? pendingTurn?.workId ?? task?.workId ?? activeTaskId;
  const runId = input.runId ?? pendingTurn?.runId;
  const candidate = context?.taskCandidates?.find((item) => item.taskId === taskId);
  const contextTaskLifecycle = taskId ? compactFeedbackTaskLifecycle({
    repository: {
      taskId,
      workingDirectory: candidate?.workingDirectory ?? task?.workingDirectory,
      branch,
      health: candidate?.repositoryHealth,
      headBefore: candidate?.head,
    },
    request: candidate?.currentRequest ? {
      requestId: candidate.currentRequest.id,
      status: candidate.currentRequest.status,
    } : undefined,
    run: runId ? {
      runId,
      selectedAs: taskId ? "task" : "session",
    } : undefined,
  }) : undefined;
  const taskLifecycle = mergeFeedbackTaskLifecycle(contextTaskLifecycle, input.taskLifecycle);

  return compactContextEngineFeedbackSummary({
    ...(input.pendingTurnStatus ?? pendingTurn?.routingStatus ? { pendingTurnStatus: input.pendingTurnStatus ?? pendingTurn?.routingStatus } : {}),
    ...(pendingTurn ? {
      pendingTurnRange: {
        fromSeq: pendingTurn.fromSeq,
        toSeq: pendingTurn.toSeq,
      },
    } : {}),
    ...(input.routeStatus ? { routeStatus: input.routeStatus } : {}),
    ...(input.routeMode ? { routeMode: input.routeMode } : {}),
    ...(input.routeSource ? { routeSource: input.routeSource } : {}),
    ...(input.finalizationStatus ? { finalizationStatus: input.finalizationStatus } : {}),
    ...(activeTaskId ? { activeTaskId } : {}),
    ...(taskId ? { taskId } : {}),
    ...(branch ? { branch } : {}),
    ...(ref ? { ref } : {}),
    ...(runId ? { runId } : {}),
    ...(input.committed !== undefined ? { committed: input.committed } : {}),
    ...(input.commit ? { commit: input.commit } : {}),
    ...(input.conversationRefs && input.conversationRefs.length > 0 ? { conversationRefs: input.conversationRefs } : {}),
    ...((context?.pendingWrites?.length ?? 0) > 0 ? { pendingWriteCount: context!.pendingWrites!.length } : {}),
    ...(task ? {
      taskAssetCount: task.assets.length,
      recentRunCount: task.recentRuns.length,
      recentEvidenceCount: task.recentEvidence.length,
    } : {}),
    ...(input.warningCodes && input.warningCodes.length > 0 ? { warningCodes: uniqueStrings(input.warningCodes) } : {}),
    ...(taskLifecycle ? { taskLifecycle } : {}),
  });
}

export function buildFeedbackTriageSummary(summary: AgentFeedbackLatestSummary): AgentFeedbackTriageSummary {
  const findings: AgentFeedbackTriageFinding[] = [];
  const warningSet = new Set(summary.warnings);
  const contextEngine = summary.contextEngine;
  const executionTriage = executionTriageInput(summary);

  findings.push(...buildGitContextLifecycleFindings({
    lifecycle: contextEngine?.taskLifecycle,
    pendingTurnStatus: contextEngine?.pendingTurnStatus,
    runClass: contextEngine?.runClass,
  }));
  findings.push(...buildExecutionOutcomeFindings(executionTriage));

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

  if (warningSet.has("context_refresh_failed")) {
    findings.push({
      code: "context_refresh_failed",
      severity: "error",
      title: "Fresh context could not be loaded",
      details: "The harness invalidated its local context but could not refresh it from the Git Context Engine.",
      recommendation: "Inspect the matching trace id and service request before trusting later agent decisions.",
    });
  }

  if (warningSet.has("run_step_persistence_failed")) {
    findings.push({
      code: "run_step_persistence_failed",
      severity: "error",
      title: "Run step was not durably acknowledged",
      details: "The harness queued a run step but the Git Context Engine did not acknowledge persistence.",
      recommendation: "Inspect the run id and step number; do not treat the run audit trail as complete.",
    });
  }

  if (warningSet.has("verification_failed")
    || summary.execution?.verification === "failed"
    || summary.verificationPassed === false && (summary.actionSteps ?? 0) > 0) {
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

  for (const finding of repairCodeTriageFindings(warningSet)) {
    findings.push(finding);
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

  if (warningSet.has("provider_empty_response")) {
    findings.push({
      code: "provider_empty_response",
      severity: "error",
      title: "Provider returned an empty response",
      details: "The model provider returned no usable assistant message or tool call before the runtime could parse a decision.",
      recommendation: "Inspect decision.provider_empty_response for model, latency, response shape, native tool count, and retry details.",
    });
  }

  if (warningSet.has("fresh_session_tool_repair_requested")) {
    findings.push({
      code: "fresh_session_tool_repair_requested",
      severity: "warning",
      title: "Fresh session needed task routing",
      details: "The model tried to load or call work tools before any active task existed.",
      recommendation: "Inspect task candidates, then activate the matching task or create a distinct task before mutation.",
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

  if (warningSet.has("normal_tools_selected_without_work_run")) {
    findings.push({
      code: "normal_tools_selected_without_work_run",
      severity: "error",
      title: "Task tools were selected without a work run",
      details: "The model saw normal executable tools even though the runtime had no routed task run.",
      recommendation: "Inspect tools.working_set_prepared, decision.selected, and guard.missing_work_run. Ensure routing state is represented before normal task tools are exposed.",
    });
  }

  if (warningSet.has("missing_work_run_for_action")) {
    findings.push({
      code: "missing_work_run_for_action",
      severity: "error",
      title: "Action needed a task run",
      details: "A normal executable action reached the run guard before task ownership was bound.",
      recommendation: "Route the pending turn first, or block normal executable tools until the turn is bound or intentionally session-only.",
    });
  }

  if (warningSet.has("normal_tool_before_routing")) {
    findings.push({
      code: "normal_tool_before_routing",
      severity: "error",
      title: "Normal tool was chosen before routing",
      details: "The decision selected a non git-context tool before task ownership was resolved.",
      recommendation: "Check the projected state view and selected tool list; the model should only see/use routing tools until a task run exists.",
    });
  }

  if (warningSet.has("normal_tool_visible_during_pending_routing") || warningSet.has("routing_state_mismatch")) {
    findings.push({
      code: "routing_state_mismatch",
      severity: "error",
      title: "Routing state and tool surface disagreed",
      details: "Feedback saw pending routing while the selected executable tool surface included normal task tools.",
      recommendation: "Inspect context.git.current.pendingTurn and tool selector filtering for the same decision iteration.",
    });
  }

  if (contextEngine?.finalizationStatus === "failed") {
    findings.push({
      code: "context_engine_commit_failed",
      severity: "error",
      title: "Context-engine finalization failed",
      details: "The run could not be committed to the git context engine.",
      recommendation: "Inspect the context-engine finalization event and service error before changing model behavior.",
    });
  }

  if (
    contextEngine?.taskId
    && contextEngine.runId
    && contextEngine.committed === false
    && summary.status
    && summary.status !== "stuck"
    && contextEngine.finalizationStatus !== "skipped"
  ) {
    findings.push({
      code: "task_run_not_committed",
      severity: "warning",
      title: "Task run was not committed",
      details: "The run had a git-context task/run binding but no committed context-engine result.",
      recommendation: "Check whether app-level finalization ran after the agent loop returned.",
    });
  }

  if (contextEngine?.routeStatus === "ambiguous") {
    findings.push({
      code: "route_ambiguous",
      severity: "warning",
      title: "Task route was ambiguous",
      details: "The context engine could not safely choose one owning task for the turn.",
      recommendation: "Inspect candidate tasks and the clarification response path.",
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
    findings.push(isHealthyConversationOutcome(executionTriage)
      ? {
          code: "healthy_conversation",
          severity: "info",
          title: "Healthy direct conversation",
          details: "Messages were saved and no executable verification, task finalization, or task commit was required.",
          recommendation: "No action is required for this turn.",
        }
      : {
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

function repairCodeTriageFindings(warningSet: Set<string>): AgentFeedbackTriageFinding[] {
  const findings: AgentFeedbackTriageFinding[] = [];
  for (const [code, finding] of REPAIR_TRIAGE_FINDINGS) {
    if (warningSet.has(code)) {
      findings.push(finding);
    }
  }
  return findings;
}

const REPAIR_TRIAGE_FINDINGS: ReadonlyArray<[string, AgentFeedbackTriageFinding]> = [
  ["R_ASSISTANT_TEXT_TOOL_CALL", {
    code: "R_ASSISTANT_TEXT_TOOL_CALL",
    severity: "warning",
    title: "Tool call was written as assistant text",
    details: "The model printed tool-call-shaped JSON instead of using native tool calling.",
    recommendation: "Use provider-native tool calls for tool work; reserve direct assistant text for user-facing replies.",
  }],
  ["R_TOOL_NOT_SELECTED", {
    code: "R_TOOL_NOT_SELECTED",
    severity: "warning",
    title: "Decision used an unselected tool",
    details: "The model tried to call a tool that was not in the selected native tool surface.",
    recommendation: "Use decision_load_tools before missing capabilities, or call only selected tools.",
  }],
  ["R_LOAD_TOOLS_USED_AS_ACTION", {
    code: "R_LOAD_TOOLS_USED_AS_ACTION",
    severity: "warning",
    title: "Tool loading was used as executable work",
    details: "The model attempted to use tool loading inside an executable action.",
    recommendation: "Use the native decision_load_tools control tool instead of wrapping tool loading as action work.",
  }],
  ["R_EMPTY_TOOL_LOAD_SELECTOR", {
    code: "R_EMPTY_TOOL_LOAD_SELECTOR",
    severity: "warning",
    title: "Tool-load request had no selector",
    details: "The model requested tool loading without an exact tool name, group, or query.",
    recommendation: "Retry decision_load_tools with toolNames, groups, or a query.",
  }],
  ["R_TOOL_INPUT_INVALID", {
    code: "R_TOOL_INPUT_INVALID",
    severity: "warning",
    title: "Tool input was invalid",
    details: "The model called a selected tool with input that did not match the tool schema.",
    recommendation: "Inspect the input_schema_violation feedback and retry with schema-valid input.",
  }],
  ["R_TOOL_INPUT_MISSING_REQUIRED_FIELD", {
    code: "R_TOOL_INPUT_MISSING_REQUIRED_FIELD",
    severity: "warning",
    title: "Tool input missed required fields",
    details: "The model called a selected tool without required input fields.",
    recommendation: "Inspect missingFields in the repair feedback and retry with all required fields.",
  }],
  ["R_TASK_FEEDBACK_UNAVAILABLE", {
    code: "R_TASK_FEEDBACK_UNAVAILABLE",
    severity: "warning",
    title: "Task feedback tool was unavailable",
    details: "The model attempted to ask task-run feedback when the feedback tool was not exposed.",
    recommendation: "Use direct assistant text before a task run; use ask_user_feedback only during active task runs.",
  }],
  ["R_MULTIPLE_NATIVE_TOOL_CALLS", {
    code: "R_MULTIPLE_NATIVE_TOOL_CALLS",
    severity: "warning",
    title: "Multiple native tool calls were returned",
    details: "The provider response contained more than one native tool call for a single decision.",
    recommendation: "Retry with exactly one native tool call.",
  }],
  ["R_PARSE_FAILED", {
    code: "R_PARSE_FAILED",
    severity: "warning",
    title: "Decision response could not be parsed",
    details: "The model response was not valid direct text or a valid native decision.",
    recommendation: "Use direct assistant text for user replies, otherwise call exactly one available native tool.",
  }],
  ["R_PROVIDER_EMPTY_RESPONSE", {
    code: "R_PROVIDER_EMPTY_RESPONSE",
    severity: "error",
    title: "Provider returned an empty response",
    details: "The model provider returned no usable assistant message or tool call.",
    recommendation: "Inspect provider_empty_response details for model, latency, response shape, native tool count, and retry outcome.",
  }],
  ["R_PROVIDER_MALFORMED_RESPONSE", {
    code: "R_PROVIDER_MALFORMED_RESPONSE",
    severity: "error",
    title: "Provider returned a malformed response",
    details: "The model provider returned a response that could not be parsed before Ayati received a usable assistant message or tool call.",
    recommendation: "Inspect provider_malformed_response details for model, latency, parse error, native tool count, and retry outcome.",
  }],
  ["R_VERIFICATION_FAILED", {
    code: "R_VERIFICATION_FAILED",
    severity: "warning",
    title: "Deterministic verification failed",
    details: "A tool action ran, but the deterministic verification result did not pass.",
    recommendation: "Inspect verification repair details, evidence items, and failed assertions before retrying.",
  }],
  ["R_NO_PROGRESS", {
    code: "R_NO_PROGRESS",
    severity: "warning",
    title: "Step made no useful progress",
    details: "The run attempted a step that produced no useful tool output or task progress.",
    recommendation: "Change strategy, choose a concrete tool action, or stop with a clear failure if no useful next action exists.",
  }],
  ["R_FRESH_SESSION_NEEDS_TASK", {
    code: "R_FRESH_SESSION_NEEDS_TASK",
    severity: "warning",
    title: "Fresh session needs task routing",
    details: "The model tried to use normal work tools before any active task existed.",
    recommendation: "Search and activate an existing task, create a new task, or ask a short clarification directly.",
  }],
  ["R_NORMAL_TOOL_WITHOUT_TASK_RUN", {
    code: "R_NORMAL_TOOL_WITHOUT_TASK_RUN",
    severity: "error",
    title: "Normal tool reached runner without a task run",
    details: "A normal executable tool reached the runner before a task run existed.",
    recommendation: "Route, create, or activate the correct task before normal tool execution.",
  }],
  ["R_PENDING_TURN_UNBOUND", {
    code: "R_PENDING_TURN_UNBOUND",
    severity: "error",
    title: "Pending turn was unbound before tool work",
    details: "The model attempted normal task work while the current turn was not bound to a task.",
    recommendation: "Use git-context read/search/create/activate/clarify tools before normal task work.",
  }],
  ["R_PENDING_TURN_CLARIFYING", {
    code: "R_PENDING_TURN_CLARIFYING",
    severity: "warning",
    title: "Pending turn was still clarifying",
    details: "The model attempted tool work while task ownership was waiting for user clarification.",
    recommendation: "Ask the user directly which task or target they mean.",
  }],
  ["R_REPEATED_REPAIR_FAILURE", {
    code: "R_REPEATED_REPAIR_FAILURE",
    severity: "error",
    title: "Same repair failed repeatedly",
    details: "The harness stopped after the same repair class repeated too many times.",
    recommendation: "Inspect the previous repair code, blocked targets, and missing or invalid fields before retrying.",
  }],
];

function readFeedbackSummary(event: AgentFeedbackEvent): Record<string, unknown> | undefined {
  const summary = event.data?.["feedbackSummary"];
  if (summary && typeof summary === "object" && !Array.isArray(summary)) {
    return summary as Record<string, unknown>;
  }
  if (event.stage === "final" && event.event === "error") {
    return {
      status: "failed",
      responseKind: "error",
      iterations: 0,
      toolCalls: 0,
      toolLoadDecisions: 0,
      actionSteps: 0,
      verificationPassed: false,
      basedOnVerifiedFacts: false,
      warnings: ["runtime_error"],
    };
  }
  return undefined;
}

function contextEngineFeedbackFromEvent(event: AgentFeedbackEvent): AgentFeedbackContextEngineSummary | undefined {
  const fromSummary = readFeedbackSummary(event);
  const fromNested = readContextEngineFeedbackSummary(fromSummary?.["contextEngine"]);
  const fromData = readContextEngineFeedbackSummary(event.data?.["contextEngine"]);
  const direct = event.stage === "context_engine"
    ? readContextEngineFeedbackSummary(event.data)
    : undefined;
  const inferred = event.stage === "context_engine" || event.stage === "git_context_service"
    ? inferContextEngineFeedbackFromEvent(event)
    : undefined;
  return mergeContextEngineFeedbackSummary(
    mergeContextEngineFeedbackSummary(fromNested, fromData),
    mergeContextEngineFeedbackSummary(direct, inferred),
  );
}

function conversationPersistenceFromEvent(
  event: AgentFeedbackEvent,
): FeedbackConversationPersistenceState | undefined {
  const fromSummary = readFeedbackConversationPersistenceState(
    readFeedbackSummary(event)?.["conversationPersistence"],
  );
  const fromEvent = event.event === "conversation_persisted"
    ? readFeedbackConversationPersistenceState(event.data?.["conversationPersistence"])
    : undefined;
  return fromEvent ?? fromSummary;
}

function hasCompactSummarySignal(event: AgentFeedbackEvent): boolean {
  return contextEngineFeedbackFromEvent(event) !== undefined
    || conversationPersistenceFromEvent(event) !== undefined;
}

function inferContextEngineFeedbackFromEvent(event: AgentFeedbackEvent): AgentFeedbackContextEngineSummary | undefined {
  const data = event.data ?? {};
  if (event.event === "harness_context_cache_hit" || event.event === "harness_context_cache_miss") {
    return compactContextEngineFeedbackSummary({
      cacheStatus: event.event.endsWith("_hit") ? "hit" : "miss",
      ...(readStringValue(data["revision"]) ? { contextRevision: readStringValue(data["revision"]) } : {}),
      ...(readNumberValue(data["hits"]) !== undefined ? { cacheHits: readNumberValue(data["hits"]) } : {}),
      ...(readNumberValue(data["misses"]) !== undefined ? { cacheMisses: readNumberValue(data["misses"]) } : {}),
      ...(readNumberValue(data["refreshes"]) !== undefined ? { cacheRefreshes: readNumberValue(data["refreshes"]) } : {}),
    });
  }
  if (event.event === "harness_context_refresh_completed") {
    return compactContextEngineFeedbackSummary({
      cacheStatus: "fresh",
      ...(readStringValue(data["contextRevision"]) ? { contextRevision: readStringValue(data["contextRevision"]) } : {}),
      ...(readStringValue(data["previousRevision"]) ? { previousContextRevision: readStringValue(data["previousRevision"]) } : {}),
      ...(readNumberValue(data["hits"]) !== undefined ? { cacheHits: readNumberValue(data["hits"]) } : {}),
      ...(readNumberValue(data["misses"]) !== undefined ? { cacheMisses: readNumberValue(data["misses"]) } : {}),
      ...(readNumberValue(data["refreshes"]) !== undefined ? { cacheRefreshes: readNumberValue(data["refreshes"]) } : {}),
    });
  }
  if (event.event === "session_run_started") {
    return compactContextEngineFeedbackSummary({
      runClass: "session",
      ...(event.runId ? {
        runId: event.runId,
        taskLifecycle: {
          run: {
            runId: event.runId,
            startedAs: "session",
            selectedAs: "session",
            sessionRunBound: false,
          },
        },
      } : {}),
    });
  }
  if (event.event === "task_run_selected") {
    const taskId = readStringValue(data["taskId"]);
    const runId = event.runId ?? readStringValue(data["runId"]);
    const selectionMode = readSelectionMode(data["selectionMode"]);
    const requestDecision = readTaskRequestDecision(data["taskRequestDecision"]);
    const requestStatus = readTaskRequestStatus(data["taskRequestStatus"]);
    return compactContextEngineFeedbackSummary({
      runClass: "task",
      ...(selectionMode ? { routeMode: selectionMode } : {}),
      ...(taskId ? { taskId } : {}),
      ...(runId ? { runId } : {}),
      taskLifecycle: {
        repository: {
          taskId,
          workingDirectory: readStringValue(data["workingDirectory"]),
          branch: readStringValue(data["branch"]),
          selectionMode,
          taskCreated: readBooleanValue(data["taskCreated"]),
          headBefore: readStringValue(data["taskHead"]),
        },
        request: {
          decision: requestDecision,
          requestId: readStringValue(data["taskRequestId"]),
          status: requestStatus,
          created: readBooleanValue(data["taskRequestCreated"]),
        },
        run: {
          runId,
          startedAs: data["sessionRunBound"] === true ? "session" : "none",
          selectedAs: "task",
          sessionRunBound: data["sessionRunBound"] === true,
        },
        finalization: { status: "not_started" },
      },
    });
  }
  if (event.event === "run_step_persistence_acknowledged") {
    return compactContextEngineFeedbackSummary({
      ...(readNumberValue(data["workStateRevision"]) !== undefined
        ? { workStateRevision: readNumberValue(data["workStateRevision"]) }
        : {}),
      ...(readNumberValue(data["step"]) !== undefined ? { lastPersistedStep: readNumberValue(data["step"]) } : {}),
      ...(event.runId ? { runId: event.runId } : {}),
    });
  }
  if (event.event === "prepared") {
    return compactContextEngineFeedbackSummary({
      routeSource: "runtime",
    });
  }
  if (event.event === "pending_turn_snapshot") {
    const status = readStringValue(data["status"]);
    return compactContextEngineFeedbackSummary({
      ...(status && status !== "none" ? { pendingTurnStatus: status } : {}),
      routeSource: "runtime",
    });
  }
  if (event.event === "auto_route_started") {
    return compactContextEngineFeedbackSummary({
      routeSource: "auto",
    });
  }
  if (event.event === "route_started") {
    return compactContextEngineFeedbackSummary({
      routeSource: readRouteSource(data["routeSource"]) ?? "deterministic_router",
    });
  }
  if (event.event === "auto_route_result") {
    const routeStatus = readStringValue(data["status"]);
    return compactContextEngineFeedbackSummary({
      ...(routeStatus && routeStatus !== "skipped" ? { routeStatus } : {}),
      ...(readStringValue(data["mode"]) ? { routeMode: readStringValue(data["mode"]) } : {}),
      routeSource: routeStatus === "ambiguous" ? "deterministic_router" : "auto",
      ...(readStringValue(data["taskId"]) ? { taskId: readStringValue(data["taskId"]) } : {}),
      ...(readStringValue(data["branch"]) ? { branch: readStringValue(data["branch"]) } : {}),
      ...(readStringValue(data["ref"]) ? { ref: readStringValue(data["ref"]) } : {}),
      ...(readStringValue(data["runId"]) ? { runId: readStringValue(data["runId"]) } : {}),
      ...(readConversationRefs(data["conversationRefs"]) ? { conversationRefs: readConversationRefs(data["conversationRefs"]) } : {}),
    });
  }
  if (event.event === "route_result") {
    const routeStatus = readStringValue(data["status"]);
    return compactContextEngineFeedbackSummary({
      ...(routeStatus && routeStatus !== "skipped" ? { routeStatus } : {}),
      ...(readStringValue(data["mode"]) ? { routeMode: readStringValue(data["mode"]) } : {}),
      routeSource: readRouteSource(data["routeSource"]) ?? "deterministic_router",
      ...(readStringValue(data["taskId"]) ? { taskId: readStringValue(data["taskId"]) } : {}),
      ...(readStringValue(data["branch"]) ? { branch: readStringValue(data["branch"]) } : {}),
      ...(readStringValue(data["ref"]) ? { ref: readStringValue(data["ref"]) } : {}),
      ...(readStringValue(data["runId"]) ? { runId: readStringValue(data["runId"]) } : {}),
      ...(readConversationRefs(data["conversationRefs"]) ? { conversationRefs: readConversationRefs(data["conversationRefs"]) } : {}),
    });
  }
  if (event.event === "routed") {
    const routeStatus = readStringValue(data["status"]);
    return compactContextEngineFeedbackSummary({
      ...(routeStatus ? { routeStatus } : {}),
      ...(readStringValue(data["mode"]) ? { routeMode: readStringValue(data["mode"]) } : {}),
      routeSource: routeStatus === "ready" ? "auto" : "deterministic_router",
      ...(readStringValue(data["taskId"]) ? { taskId: readStringValue(data["taskId"]) } : {}),
      ...(readStringValue(data["branch"]) ? { branch: readStringValue(data["branch"]) } : {}),
      ...(readStringValue(data["ref"]) ? { ref: readStringValue(data["ref"]) } : {}),
      ...(readStringValue(data["runId"]) ? { runId: readStringValue(data["runId"]) } : {}),
      ...(readConversationRefs(data["conversationRefs"]) ? { conversationRefs: readConversationRefs(data["conversationRefs"]) } : {}),
    });
  }
  if (event.event === "agent_routed") {
    return compactContextEngineFeedbackSummary({
      routeStatus: "ready",
      routeSource: "agent_tool",
      pendingTurnStatus: "bound",
      ...(readStringValue(data["taskId"]) ? { taskId: readStringValue(data["taskId"]) } : {}),
      ...(readStringValue(data["branch"]) ? { branch: readStringValue(data["branch"]) } : {}),
      ...(readStringValue(data["runId"]) ? { runId: readStringValue(data["runId"]) } : {}),
    });
  }
  if (event.event === "clarification_requested") {
    return compactContextEngineFeedbackSummary({
      routeStatus: "ambiguous",
      routeSource: "agent_tool",
      pendingTurnStatus: "clarifying",
    });
  }
  if (event.event === "committed") {
    return compactContextEngineFeedbackSummary({
      finalizationStatus: "committed",
      committed: true,
      ...(readStringValue(data["taskId"]) ? { taskId: readStringValue(data["taskId"]) } : {}),
      ...(readStringValue(data["taskCommit"]) ? { commit: readStringValue(data["taskCommit"]) } : {}),
      ...(readStringValue(data["ref"]) ? { ref: readStringValue(data["ref"]) } : {}),
      ...(event.runId ? { runId: event.runId } : {}),
    });
  }
  if (event.event === "task_finalization_started") {
    const taskId = readStringValue(data["taskId"]);
    const runId = event.runId ?? readStringValue(data["runId"]);
    return compactContextEngineFeedbackSummary({
      finalizationStatus: "started",
      committed: false,
      ...(taskId ? { taskId } : {}),
      ...(runId ? { runId } : {}),
      taskLifecycle: {
        repository: {
          taskId,
          workingDirectory: readStringValue(data["workingDirectory"]),
        },
        request: { requestId: readStringValue(data["taskRequestId"]) },
        run: { runId, selectedAs: "task" },
        finalization: {
          status: "started",
          outcome: readFinalizationOutcome(data["requestedOutcome"]),
          validation: readFinalizationValidation(data["validation"]),
        },
      },
    });
  }
  if (event.event === "task_finalization_completed") {
    const taskId = readStringValue(data["taskId"]);
    const runId = event.runId ?? readStringValue(data["runId"]);
    const commit = readStringValue(data["taskCommit"]);
    const headBefore = readStringValue(data["taskHeadBefore"]);
    const headAfter = readStringValue(data["taskHeadAfter"]);
    return compactContextEngineFeedbackSummary({
      finalizationStatus: "committed",
      committed: true,
      ...(taskId ? { taskId } : {}),
      ...(runId ? { runId } : {}),
      ...(commit ? { commit } : {}),
      taskLifecycle: {
        repository: {
          taskId,
          workingDirectory: readStringValue(data["workingDirectory"]),
          headBefore,
          headAfter,
        },
        request: { requestId: readStringValue(data["taskRequestId"]) },
        run: { runId, selectedAs: "task" },
        finalization: {
          status: "committed",
          outcome: readFinalizationOutcome(data["outcome"]),
          commit,
          commitCreated: readBooleanValue(data["taskCommitCreated"]),
          headBefore,
          headAfter,
        },
      },
    });
  }
  if (event.event === "finalization_started") {
    return compactContextEngineFeedbackSummary({
      finalizationStatus: "started",
      committed: false,
      ...(readStringValue(data["taskId"]) ? { taskId: readStringValue(data["taskId"]) } : {}),
      ...(readStringValue(data["runId"]) ? { runId: readStringValue(data["runId"]) } : {}),
      ...(readConversationRefs(data["conversationRefs"]) ? { conversationRefs: readConversationRefs(data["conversationRefs"]) } : {}),
    });
  }
  if (event.event === "finalization_skipped") {
    return compactContextEngineFeedbackSummary({
      finalizationStatus: "skipped",
      committed: false,
    });
  }
  if (event.event === "conversation_enquiry_recorded") {
    return compactContextEngineFeedbackSummary({
      finalizationStatus: "skipped",
      committed: false,
    });
  }
  if (event.event === "finalization_failed") {
    return compactContextEngineFeedbackSummary({
      finalizationStatus: "failed",
      committed: false,
    });
  }
  return undefined;
}

function readContextEngineFeedbackSummary(value: unknown): AgentFeedbackContextEngineSummary | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return compactContextEngineFeedbackSummary({
    ...(readStringValue(record["pendingTurnStatus"]) ? { pendingTurnStatus: readStringValue(record["pendingTurnStatus"]) } : {}),
    ...(readPendingTurnRange(record["pendingTurnRange"]) ? { pendingTurnRange: readPendingTurnRange(record["pendingTurnRange"]) } : {}),
    ...(readStringValue(record["routeStatus"]) ? { routeStatus: readStringValue(record["routeStatus"]) } : {}),
    ...(readStringValue(record["routeMode"]) ? { routeMode: readStringValue(record["routeMode"]) } : {}),
    ...(readRouteSource(record["routeSource"]) ? { routeSource: readRouteSource(record["routeSource"]) } : {}),
    ...(readFinalizationStatus(record["finalizationStatus"]) ? { finalizationStatus: readFinalizationStatus(record["finalizationStatus"]) } : {}),
    ...(readStringValue(record["activeTaskId"]) ? { activeTaskId: readStringValue(record["activeTaskId"]) } : {}),
    ...(readStringValue(record["taskId"]) ? { taskId: readStringValue(record["taskId"]) } : {}),
    ...(readStringValue(record["branch"]) ? { branch: readStringValue(record["branch"]) } : {}),
    ...(readStringValue(record["ref"]) ? { ref: readStringValue(record["ref"]) } : {}),
    ...(readStringValue(record["runId"]) ? { runId: readStringValue(record["runId"]) } : {}),
    ...(typeof record["committed"] === "boolean" ? { committed: record["committed"] } : {}),
    ...(readStringValue(record["commit"]) ? { commit: readStringValue(record["commit"]) } : {}),
    ...(readConversationRefs(record["conversationRefs"]) ? { conversationRefs: readConversationRefs(record["conversationRefs"]) } : {}),
    ...(readNumberValue(record["pendingWriteCount"]) !== undefined ? { pendingWriteCount: readNumberValue(record["pendingWriteCount"]) } : {}),
    ...(readNumberValue(record["taskAssetCount"]) !== undefined ? { taskAssetCount: readNumberValue(record["taskAssetCount"]) } : {}),
    ...(readNumberValue(record["recentRunCount"]) !== undefined ? { recentRunCount: readNumberValue(record["recentRunCount"]) } : {}),
    ...(readNumberValue(record["recentEvidenceCount"]) !== undefined ? { recentEvidenceCount: readNumberValue(record["recentEvidenceCount"]) } : {}),
    ...(readStringValue(record["contextRevision"]) ? { contextRevision: readStringValue(record["contextRevision"]) } : {}),
    ...(readStringValue(record["previousContextRevision"]) ? { previousContextRevision: readStringValue(record["previousContextRevision"]) } : {}),
    ...(readCacheStatus(record["cacheStatus"]) ? { cacheStatus: readCacheStatus(record["cacheStatus"]) } : {}),
    ...(readNumberValue(record["cacheHits"]) !== undefined ? { cacheHits: readNumberValue(record["cacheHits"]) } : {}),
    ...(readNumberValue(record["cacheMisses"]) !== undefined ? { cacheMisses: readNumberValue(record["cacheMisses"]) } : {}),
    ...(readNumberValue(record["cacheRefreshes"]) !== undefined ? { cacheRefreshes: readNumberValue(record["cacheRefreshes"]) } : {}),
    ...(readRunClass(record["runClass"]) ? { runClass: readRunClass(record["runClass"]) } : {}),
    ...(readNumberValue(record["workStateRevision"]) !== undefined ? { workStateRevision: readNumberValue(record["workStateRevision"]) } : {}),
    ...(readNumberValue(record["lastPersistedStep"]) !== undefined ? { lastPersistedStep: readNumberValue(record["lastPersistedStep"]) } : {}),
    ...(readFeedbackTaskLifecycle(record["taskLifecycle"])
      ? { taskLifecycle: readFeedbackTaskLifecycle(record["taskLifecycle"]) }
      : {}),
    ...(readStringArray(record["warningCodes"]).length > 0 ? { warningCodes: readStringArray(record["warningCodes"]) } : {}),
  });
}

function mergeContextEngineFeedbackSummary(
  left: AgentFeedbackContextEngineSummary | undefined,
  right: AgentFeedbackContextEngineSummary | undefined,
): AgentFeedbackContextEngineSummary | undefined {
  if (!left) {
    return right ? compactContextEngineFeedbackSummary(right) : undefined;
  }
  if (!right) {
    return compactContextEngineFeedbackSummary(left);
  }
  return compactContextEngineFeedbackSummary({
    ...left,
    ...right,
    pendingTurnRange: right.pendingTurnRange ?? left.pendingTurnRange,
    conversationRefs: right.conversationRefs ?? left.conversationRefs,
    taskLifecycle: mergeFeedbackTaskLifecycle(left.taskLifecycle, right.taskLifecycle),
    warningCodes: uniqueStrings([
      ...(left.warningCodes ?? []),
      ...(right.warningCodes ?? []),
    ]),
  });
}

function compactContextEngineFeedbackSummary(
  value: AgentFeedbackContextEngineSummary,
): AgentFeedbackContextEngineSummary | undefined {
  const output: AgentFeedbackContextEngineSummary = {};
  if (value.pendingTurnStatus) output.pendingTurnStatus = value.pendingTurnStatus;
  if (value.pendingTurnRange) output.pendingTurnRange = value.pendingTurnRange;
  if (value.routeStatus) output.routeStatus = value.routeStatus;
  if (value.routeMode) output.routeMode = value.routeMode;
  if (value.routeSource) output.routeSource = value.routeSource;
  if (value.finalizationStatus) output.finalizationStatus = value.finalizationStatus;
  if (value.activeTaskId) output.activeTaskId = value.activeTaskId;
  if (value.taskId) output.taskId = value.taskId;
  if (value.branch) output.branch = value.branch;
  if (value.ref) output.ref = value.ref;
  if (value.runId) output.runId = value.runId;
  if (value.committed !== undefined) output.committed = value.committed;
  if (value.commit) output.commit = value.commit;
  if (value.conversationRefs && value.conversationRefs.length > 0) output.conversationRefs = value.conversationRefs;
  if (value.pendingWriteCount !== undefined) output.pendingWriteCount = value.pendingWriteCount;
  if (value.taskAssetCount !== undefined) output.taskAssetCount = value.taskAssetCount;
  if (value.recentRunCount !== undefined) output.recentRunCount = value.recentRunCount;
  if (value.recentEvidenceCount !== undefined) output.recentEvidenceCount = value.recentEvidenceCount;
  if (value.contextRevision) output.contextRevision = value.contextRevision;
  if (value.previousContextRevision) output.previousContextRevision = value.previousContextRevision;
  if (value.cacheStatus) output.cacheStatus = value.cacheStatus;
  if (value.cacheHits !== undefined) output.cacheHits = value.cacheHits;
  if (value.cacheMisses !== undefined) output.cacheMisses = value.cacheMisses;
  if (value.cacheRefreshes !== undefined) output.cacheRefreshes = value.cacheRefreshes;
  if (value.runClass) output.runClass = value.runClass;
  if (value.workStateRevision !== undefined) output.workStateRevision = value.workStateRevision;
  if (value.lastPersistedStep !== undefined) output.lastPersistedStep = value.lastPersistedStep;
  const taskLifecycle = compactFeedbackTaskLifecycle(value.taskLifecycle);
  if (taskLifecycle) output.taskLifecycle = taskLifecycle;
  if (value.warningCodes && value.warningCodes.length > 0) output.warningCodes = uniqueStrings(value.warningCodes);
  return Object.keys(output).length > 0 ? output : undefined;
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

async function writeFeedbackPointer(
  dataDir: string,
  name: string,
  event: AgentFeedbackEvent,
): Promise<void> {
  const pointerPath = join(dataDir, "feedback", name);
  await mkdir(dirname(pointerPath), { recursive: true });
  await writeFile(pointerPath, `${JSON.stringify({
    updatedAt: event.ts,
    tsMs: event.tsMs,
    ...(event.sessionId ? { sessionId: event.sessionId } : {}),
    ...(event.seq !== undefined ? { seq: event.seq } : {}),
    ...(event.runId ? { runId: event.runId } : {}),
    path: feedbackRelativePath(event).replace(/\\/g, "/"),
  }, null, 2)}\n`, "utf-8");
}

function branchFromRef(ref: string | undefined): string | undefined {
  if (!ref) {
    return undefined;
  }
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

function readStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readBooleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readSelectionMode(value: unknown): "created" | "activated" | undefined {
  return value === "created" || value === "activated" ? value : undefined;
}

function readTaskRequestDecision(
  value: unknown,
): "initial" | "continue" | "create" | undefined {
  return value === "initial" || value === "continue" || value === "create"
    ? value
    : undefined;
}

function readTaskRequestStatus(
  value: unknown,
): "queued" | "active" | "blocked" | "done" | "dropped" | undefined {
  return value === "queued" || value === "active" || value === "blocked" || value === "done" || value === "dropped"
    ? value
    : undefined;
}

function readCacheStatus(value: unknown): AgentFeedbackContextEngineSummary["cacheStatus"] {
  return value === "hit" || value === "miss" || value === "fresh" ? value : undefined;
}

function readRunClass(value: unknown): AgentFeedbackContextEngineSummary["runClass"] {
  return value === "session" || value === "task" ? value : undefined;
}

function readNumberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function readRepairCode(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const code = (value as Record<string, unknown>)["code"];
  return typeof code === "string" && code.startsWith("R_") ? code : undefined;
}

function readRouteSource(value: unknown): AgentFeedbackContextRouteSource | undefined {
  if (
    value === "auto"
    || value === "agent_tool"
    || value === "deterministic_router"
    || value === "runtime"
    || value === "unknown"
  ) {
    return value;
  }
  return undefined;
}

function readFinalizationStatus(value: unknown): AgentFeedbackContextFinalizationStatus | undefined {
  if (
    value === "not_started"
    || value === "started"
    || value === "committed"
    || value === "skipped"
    || value === "failed"
  ) {
    return value;
  }
  return undefined;
}

function readFinalizationOutcome(
  value: unknown,
): "done" | "incomplete" | "failed" | "blocked" | "needs_user_input" | undefined {
  return value === "done"
    || value === "incomplete"
    || value === "failed"
    || value === "blocked"
    || value === "needs_user_input"
    ? value
    : undefined;
}

function readFinalizationValidation(
  value: unknown,
): "passed" | "failed" | "not_run" | undefined {
  return value === "passed" || value === "failed" || value === "not_run"
    ? value
    : undefined;
}

function readPendingTurnRange(value: unknown): AgentFeedbackContextEngineSummary["pendingTurnRange"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const fromSeq = readNumberValue(record["fromSeq"]);
  const toSeq = readNumberValue(record["toSeq"]);
  return fromSeq !== undefined && toSeq !== undefined ? { fromSeq, toSeq } : undefined;
}

function readConversationRefs(value: unknown): AgentFeedbackContextEngineSummary["conversationRefs"] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const refs = value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }
    const record = item as Record<string, unknown>;
    const fromSeq = readNumberValue(record["fromSeq"]);
    const toSeq = readNumberValue(record["toSeq"]);
    return fromSeq !== undefined && toSeq !== undefined ? [{ fromSeq, toSeq }] : [];
  });
  return refs.length > 0 ? refs : undefined;
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
