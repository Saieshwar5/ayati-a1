import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ContextEngineMachineContext } from "../context-engine/index.js";
import { devWarn } from "../shared/index.js";
import {
  compactFeedbackWorkstreamLifecycle,
  mergeFeedbackWorkstreamLifecycle,
  readFeedbackWorkstreamLifecycle,
  type FeedbackWorkstreamLifecycle,
} from "./context-engine-feedback-model.js";
import { buildContextEngineLifecycleFindings } from "./context-engine-feedback-triage.js";
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
  execution?: FeedbackExecutionOutcome;
  contextEngine?: AgentFeedbackContextEngineSummary;
  warnings: string[];
  rawPath: string;
}

export type AgentFeedbackContextRouteSource = "auto" | "agent_tool" | "deterministic_router" | "runtime" | "unknown";
export type AgentFeedbackContextFinalizationStatus = "not_started" | "started" | "not_required" | "no_change" | "committed" | "failed";

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
  activeWorkstreamId?: string;
  workstreamId?: string;
  branch?: string;
  ref?: string;
  runId?: string;
  committed?: boolean;
  commit?: string;
  pendingWriteCount?: number;
  resourceCount?: number;
  recentRunCount?: number;
  recentEvidenceCount?: number;
  contextRevision?: string;
  workstreamBound?: boolean;
  runOutcome?: "done" | "incomplete" | "failed" | "blocked" | "needs_user_input";
  stopReason?: "completed" | "run_limit" | "context_limit" | "failed" | "blocked" | "needs_user_input" | "interrupted";
  commitStatus?: "not_required" | "no_change" | "committed";
  headBefore?: string;
  headAfter?: string;
  workStateRevision?: number;
  lastPersistedStep?: number;
  observationRevision?: string;
  observationCounts?: {
    inventory: number;
    discovery: number;
    evidence: number;
    total: number;
  };
  workstreamLifecycle?: FeedbackWorkstreamLifecycle;
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
    if (event.stage === "guard" && event.event === "unbound_run_tool_repair_requested") {
      signals.add("unbound_run_tool_repair_requested");
    }
    if (event.stage === "action" && event.event === "failed") {
      signals.add("action_failed");
    }
    if (event.stage === "context_engine" && event.event === "run_step_persistence_failed") {
      signals.add("run_step_persistence_failed");
    }
    if (event.stage === "final" && event.event === "error") {
      signals.add("runtime_error");
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
    const next: AgentFeedbackLatestSummary = {
      ...summary,
      updatedAt: event.ts,
      tsMs: event.tsMs,
      ...(event.runId ? { runId: event.runId } : {}),
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
  const lifecycle = context?.workstreamLifecycle;
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
    workstreamBound: context?.workstreamBound
      ?? lifecycle?.run?.workstreamBound
      ?? Boolean(context?.workstreamId && context.runId),
    finalizationStatus: finalization?.status ?? context?.finalizationStatus,
    commitStatus: context?.commitStatus,
    committed: context?.committed ?? (finalization?.status === "committed"),
    commitIdentity: finalization?.commit ?? context?.commit,
    commitCreated: finalization?.commitCreated,
  };
}

function executionTriageInput(
  summary: AgentFeedbackLatestSummary,
): FeedbackExecutionTriageInput {
  const context = summary.contextEngine;
  const lifecycle = context?.workstreamLifecycle;
  return {
    execution: summary.execution,
    actionSteps: summary.actionSteps,
    workstreamBound: context?.workstreamBound === true
      || lifecycle?.run?.workstreamBound === true
      || Boolean(context?.workstreamId && context.runId),
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
  workstreamId?: string;
  branch?: string;
  ref?: string;
  runId?: string;
  workstreamBound?: boolean;
  runOutcome?: AgentFeedbackContextEngineSummary["runOutcome"];
  stopReason?: AgentFeedbackContextEngineSummary["stopReason"];
  commitStatus?: AgentFeedbackContextEngineSummary["commitStatus"];
  headBefore?: string;
  headAfter?: string;
  committed?: boolean;
  commit?: string;
  warningCodes?: string[];
  workstreamLifecycle?: FeedbackWorkstreamLifecycle;
}): AgentFeedbackContextEngineSummary | undefined {
  const context = input.context;
  const current = context?.current;
  const pendingTurn = current?.routing;
  const workstream = context?.workstream;
  const focus = context?.focus;
  const activeWorkstreamId = focus?.status === "active" ? focus.workstreamId : undefined;
  const activeRef = focus?.status === "active" ? focus.ref : undefined;
  const workstreamRef = workstream?.ref;
  const ref = input.ref ?? workstreamRef ?? activeRef;
  const branch = input.branch ?? pendingTurn?.branch ?? branchFromRef(ref);
  const workstreamId = input.workstreamId
    ?? pendingTurn?.workstreamId
    ?? workstream?.workstreamId
    ?? activeWorkstreamId;
  const runId = input.runId ?? current?.runId;
  const candidate = context?.workstreamCandidates?.find((item) => item.workstreamId === workstreamId);
  const contextWorkstreamLifecycle = workstreamId ? compactFeedbackWorkstreamLifecycle({
    repository: {
      workstreamId,
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
      workstreamBound: Boolean(workstreamId),
    } : undefined,
  }) : undefined;
  const workstreamLifecycle = mergeFeedbackWorkstreamLifecycle(contextWorkstreamLifecycle, input.workstreamLifecycle);
  const observations = context?.observations;
  const observationCounts = observations ? {
    inventory: observations.inventory.length,
    discovery: observations.discovery.length,
    evidence: observations.evidence.length,
    total: observations.inventory.length
      + observations.discovery.length
      + observations.evidence.length,
  } : undefined;

  return compactContextEngineFeedbackSummary({
    ...(input.pendingTurnStatus ?? pendingTurn?.status ? { pendingTurnStatus: input.pendingTurnStatus ?? pendingTurn?.status } : {}),
    ...(current?.inputSeq !== undefined ? {
      pendingTurnRange: {
        fromSeq: current.inputSeq,
        toSeq: current.inputSeq,
      },
    } : {}),
    ...(input.routeStatus ? { routeStatus: input.routeStatus } : {}),
    ...(input.routeMode ? { routeMode: input.routeMode } : {}),
    ...(input.routeSource ? { routeSource: input.routeSource } : {}),
    ...(input.finalizationStatus ? { finalizationStatus: input.finalizationStatus } : {}),
    ...(activeWorkstreamId ? { activeWorkstreamId } : {}),
    ...(workstreamId ? { workstreamId } : {}),
    ...(branch ? { branch } : {}),
    ...(ref ? { ref } : {}),
    ...(runId ? { runId } : {}),
    ...(input.workstreamBound !== undefined ? { workstreamBound: input.workstreamBound } : {}),
    ...(input.runOutcome ? { runOutcome: input.runOutcome } : {}),
    ...(input.stopReason ? { stopReason: input.stopReason } : {}),
    ...(input.commitStatus ? { commitStatus: input.commitStatus } : {}),
    ...(input.headBefore ? { headBefore: input.headBefore } : {}),
    ...(input.headAfter ? { headAfter: input.headAfter } : {}),
    ...(input.committed !== undefined ? { committed: input.committed } : {}),
    ...(input.commit ? { commit: input.commit } : {}),
    ...(workstream ? {
      resourceCount: workstream.resources.length,
    } : {}),
    ...(observations ? { observationRevision: observations.revision } : {}),
    ...(observationCounts ? { observationCounts } : {}),
    ...(input.warningCodes && input.warningCodes.length > 0 ? { warningCodes: uniqueStrings(input.warningCodes) } : {}),
    ...(workstreamLifecycle ? { workstreamLifecycle } : {}),
  });
}

export function buildFeedbackTriageSummary(summary: AgentFeedbackLatestSummary): AgentFeedbackTriageSummary {
  const findings: AgentFeedbackTriageFinding[] = [];
  const warningSet = new Set(summary.warnings);
  const contextEngine = summary.contextEngine;
  const executionTriage = executionTriageInput(summary);

  findings.push(...buildContextEngineLifecycleFindings({
    lifecycle: contextEngine?.workstreamLifecycle,
    pendingTurnStatus: contextEngine?.pendingTurnStatus,
    workstreamBound: contextEngine?.workstreamBound,
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
      details: "The harness invalidated its local context but could not refresh it from the Context Engine.",
      recommendation: "Inspect the matching trace id and service request before trusting later agent decisions.",
    });
  }

  if (warningSet.has("run_step_persistence_failed")) {
    findings.push({
      code: "run_step_persistence_failed",
      severity: "error",
      title: "Run step was not durably acknowledged",
      details: "The harness queued a run step but the Context Engine did not acknowledge persistence.",
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

  if (warningSet.has("unbound_run_tool_repair_requested")) {
    findings.push({
      code: "unbound_run_tool_repair_requested",
      severity: "warning",
      title: "Unbound run needed workstream routing",
      details: "The model tried to load or call workstream-scoped tools before the run had a workstream binding.",
      recommendation: "Inspect workstream candidates, then activate the matching workstream or create a distinct workstream before mutation.",
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

  if (warningSet.has("workstream_tools_selected_without_binding")) {
    findings.push({
      code: "workstream_tools_selected_without_binding",
      severity: "error",
      title: "Workstream tools were selected without a binding",
      details: "The model saw workstream-scoped executable tools even though the current run was unbound.",
      recommendation: "Inspect tools.working_set_prepared and decision.selected. Ensure binding state is represented before workstream-scoped tools are exposed.",
    });
  }

  if (warningSet.has("workstream_binding_required_for_action")) {
    findings.push({
      code: "workstream_binding_required_for_action",
      severity: "error",
      title: "Action needed a workstream binding",
      details: "A normal executable action reached the run guard before workstream ownership was bound.",
      recommendation: "Route the current run first, or block workstream-scoped executable tools until it is workstream-bound.",
    });
  }

  if (warningSet.has("normal_tool_before_routing")) {
    findings.push({
      code: "normal_tool_before_routing",
      severity: "error",
      title: "Normal tool was chosen before routing",
      details: "The decision selected a non-Context-Engine tool before workstream ownership was resolved.",
      recommendation: "Check the projected state view and selected tool list; the model should only see routing and observational tools until a workstream binding exists.",
    });
  }

  if (warningSet.has("normal_tool_visible_during_pending_routing") || warningSet.has("routing_state_mismatch")) {
    findings.push({
      code: "routing_state_mismatch",
      severity: "error",
      title: "Routing state and tool surface disagreed",
      details: "Feedback saw pending routing while the selected executable tool surface included normal workstream tools.",
      recommendation: "Inspect context.current.routing and tool selector filtering for the same decision iteration.",
    });
  }

  if (contextEngine?.finalizationStatus === "failed") {
    findings.push({
      code: "context_engine_commit_failed",
      severity: "error",
      title: "Context-engine finalization failed",
      details: "The run could not be committed to the Context Engine.",
      recommendation: "Inspect the context-engine finalization event and service error before changing model behavior.",
    });
  }

  if (
    contextEngine?.workstreamId
    && contextEngine.runId
    && contextEngine.committed === false
    && summary.status
    && summary.status !== "stuck"
  ) {
    findings.push({
      code: "workstream_bound_run_not_committed",
      severity: "warning",
      title: "Workstream-bound run was not committed",
      details: "The run had a Context Engine workstream/run binding but no committed Context Engine result.",
      recommendation: "Check whether app-level finalization ran after the agent loop returned.",
    });
  }

  if (contextEngine?.routeStatus === "ambiguous") {
    findings.push({
      code: "route_ambiguous",
      severity: "warning",
      title: "Workstream route was ambiguous",
      details: "The context engine could not safely choose one owning workstream for the turn.",
      recommendation: "Inspect candidate workstreams, resource ownership, and the clarification response path.",
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
          details: "Messages were saved and no executable verification, workstream finalization, or workstream commit was required.",
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
  ["R_WORKSTREAM_FEEDBACK_UNAVAILABLE", {
    code: "R_WORKSTREAM_FEEDBACK_UNAVAILABLE",
    severity: "warning",
    title: "Workstream feedback tool was unavailable",
    details: "The model attempted to ask workstream-bound feedback when the feedback tool was not exposed.",
    recommendation: "Use direct assistant text during an unbound run; use ask_user_feedback only during an active workstream-bound run.",
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
    details: "The run attempted a step that produced no useful tool output or workstream progress.",
    recommendation: "Change strategy, choose a concrete tool action, or stop with a clear failure if no useful next action exists.",
  }],
  ["R_UNBOUND_RUN_NEEDS_WORKSTREAM_BINDING", {
    code: "R_UNBOUND_RUN_NEEDS_WORKSTREAM_BINDING",
    severity: "warning",
    title: "Unbound run needs workstream routing",
    details: "The model tried to use workstream-scoped tools before the current run had a workstream binding.",
    recommendation: "Search and activate an existing workstream, create a new workstream, or ask a short clarification directly.",
  }],
  ["R_TOOL_REQUIRES_WORKSTREAM_BINDING", {
    code: "R_TOOL_REQUIRES_WORKSTREAM_BINDING",
    severity: "error",
    title: "Workstream-scoped tool reached runner without a binding",
    details: "A workstream-scoped executable tool reached the runner while the current run was unbound.",
    recommendation: "Route, create, or activate the correct workstream before normal tool execution.",
  }],
  ["R_PENDING_TURN_UNBOUND", {
    code: "R_PENDING_TURN_UNBOUND",
    severity: "error",
    title: "Pending turn was unbound before tool work",
    details: "The model attempted normal workstream work while the current turn was not bound to a workstream.",
    recommendation: "Use the git_context_* read/search/create/activate/clarify tools before normal workstream work.",
  }],
  ["R_PENDING_TURN_CLARIFYING", {
    code: "R_PENDING_TURN_CLARIFYING",
    severity: "warning",
    title: "Pending turn was still clarifying",
    details: "The model attempted tool work while workstream ownership was waiting for user clarification.",
    recommendation: "Ask the user directly which workstream or target they mean.",
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

function hasCompactSummarySignal(event: AgentFeedbackEvent): boolean {
  return contextEngineFeedbackFromEvent(event) !== undefined;
}

function inferContextEngineFeedbackFromEvent(event: AgentFeedbackEvent): AgentFeedbackContextEngineSummary | undefined {
  const data = event.data ?? {};
  if (event.event === "run_started") {
    return compactContextEngineFeedbackSummary({
      ...(event.runId ? { runId: event.runId } : {}),
      workstreamBound: false,
      finalizationStatus: "not_started",
    });
  }
  if (event.event === "run_workstream_bound") {
    const workstreamId = readStringValue(data["workstreamId"]);
    const runId = event.runId ?? readStringValue(data["runId"]);
    return compactContextEngineFeedbackSummary({
      ...(workstreamId ? { workstreamId } : {}),
      ...(runId ? { runId } : {}),
      workstreamBound: true,
      pendingTurnStatus: "bound",
      workstreamLifecycle: {
        repository: {
          workstreamId,
          contextRepositoryPath: readStringValue(data["contextRepositoryPath"]),
          branch: readStringValue(data["branch"]),
          selectionMode: readSelectionMode(data["mode"]),
          workstreamCreated: readBooleanValue(data["workstreamCreated"]),
          headBefore: readStringValue(data["workstreamHead"]),
        },
        request: {
          decision: readWorkstreamRequestDecision(data["requestDecision"]),
          requestId: readStringValue(data["requestId"]),
          status: readWorkstreamRequestStatus(data["requestStatus"]),
          created: readBooleanValue(data["requestCreated"]),
        },
        run: { runId, workstreamBound: true },
        finalization: { status: "not_started" },
      },
    });
  }
  if (event.event === "run_finalization_started") {
    return compactContextEngineFeedbackSummary({
      ...(event.runId ? { runId: event.runId } : {}),
      workstreamBound: readBooleanValue(data["workstreamBound"]),
      runOutcome: readFinalizationOutcome(data["outcome"]),
      stopReason: readRunStopReason(data["stopReason"]),
      finalizationStatus: "started",
      committed: false,
    });
  }
  if (event.event === "run_finalization_completed") {
    const binding = readRecordValue(data["workstreamBinding"]);
    const commit = readRecordValue(data["workstreamContextCommit"]);
    const commitStatus = readCommitStatus(commit?.["status"]);
    const workstreamId = readStringValue(binding?.["workstreamId"]);
    const runId = event.runId ?? readStringValue(data["runId"]);
    const headBefore = readStringValue(commit?.["headBefore"]);
    const headAfter = readStringValue(commit?.["headAfter"]);
    const commitIdentity = readStringValue(commit?.["commit"]);
    return compactContextEngineFeedbackSummary({
      ...(runId ? { runId } : {}),
      ...(workstreamId ? { workstreamId } : {}),
      workstreamBound: Boolean(binding),
      runOutcome: readFinalizationOutcome(data["outcome"]),
      stopReason: readRunStopReason(data["stopReason"]),
      commitStatus,
      finalizationStatus: commitStatus ?? "failed",
      committed: commitStatus === "committed",
      ...(commitIdentity ? { commit: commitIdentity } : {}),
      ...(headBefore ? { headBefore } : {}),
      ...(headAfter ? { headAfter } : {}),
      ...(binding ? {
        workstreamLifecycle: {
          repository: { workstreamId, headBefore, headAfter },
          request: { requestId: readStringValue(binding["requestId"]) },
          run: { runId, workstreamBound: true },
          finalization: {
            status: commitStatus,
            outcome: readFinalizationOutcome(data["outcome"]),
            commit: commitIdentity,
            commitCreated: commitStatus === "committed",
            headBefore,
            headAfter,
          },
        },
      } : {}),
    });
  }
  if (event.event === "run_finalization_failed") {
    return compactContextEngineFeedbackSummary({
      ...(event.runId ? { runId: event.runId } : {}),
      finalizationStatus: "failed",
      committed: false,
    });
  }
  if (event.event === "run_step_persisted" || event.event === "run_step_persistence_acknowledged") {
    return compactContextEngineFeedbackSummary({
      ...(readNumberValue(data["workStateRevision"]) !== undefined
        ? { workStateRevision: readNumberValue(data["workStateRevision"]) }
        : {}),
      ...(readNumberValue(data["step"]) !== undefined ? { lastPersistedStep: readNumberValue(data["step"]) } : {}),
      ...(readStringValue(data["contextRevision"])
        ? { contextRevision: readStringValue(data["contextRevision"]) }
        : {}),
      ...(readStringValue(data["observationRevision"])
        ? { observationRevision: readStringValue(data["observationRevision"]) }
        : {}),
      ...(readObservationCounts(data["observationCounts"])
        ? { observationCounts: readObservationCounts(data["observationCounts"]) }
        : {}),
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
      ...(readStringValue(data["workstreamId"]) ? { workstreamId: readStringValue(data["workstreamId"]) } : {}),
      ...(readStringValue(data["branch"]) ? { branch: readStringValue(data["branch"]) } : {}),
      ...(readStringValue(data["ref"]) ? { ref: readStringValue(data["ref"]) } : {}),
      ...(readStringValue(data["runId"]) ? { runId: readStringValue(data["runId"]) } : {}),
    });
  }
  if (event.event === "route_result") {
    const routeStatus = readStringValue(data["status"]);
    return compactContextEngineFeedbackSummary({
      ...(routeStatus && routeStatus !== "skipped" ? { routeStatus } : {}),
      ...(readStringValue(data["mode"]) ? { routeMode: readStringValue(data["mode"]) } : {}),
      routeSource: readRouteSource(data["routeSource"]) ?? "deterministic_router",
      ...(readStringValue(data["workstreamId"]) ? { workstreamId: readStringValue(data["workstreamId"]) } : {}),
      ...(readStringValue(data["branch"]) ? { branch: readStringValue(data["branch"]) } : {}),
      ...(readStringValue(data["ref"]) ? { ref: readStringValue(data["ref"]) } : {}),
      ...(readStringValue(data["runId"]) ? { runId: readStringValue(data["runId"]) } : {}),
    });
  }
  if (event.event === "routed") {
    const routeStatus = readStringValue(data["status"]);
    return compactContextEngineFeedbackSummary({
      ...(routeStatus ? { routeStatus } : {}),
      ...(readStringValue(data["mode"]) ? { routeMode: readStringValue(data["mode"]) } : {}),
      routeSource: routeStatus === "ready" ? "auto" : "deterministic_router",
      ...(readStringValue(data["workstreamId"]) ? { workstreamId: readStringValue(data["workstreamId"]) } : {}),
      ...(readStringValue(data["branch"]) ? { branch: readStringValue(data["branch"]) } : {}),
      ...(readStringValue(data["ref"]) ? { ref: readStringValue(data["ref"]) } : {}),
      ...(readStringValue(data["runId"]) ? { runId: readStringValue(data["runId"]) } : {}),
    });
  }
  if (event.event === "agent_routed") {
    return compactContextEngineFeedbackSummary({
      routeStatus: "ready",
      routeSource: "agent_tool",
      pendingTurnStatus: "bound",
      ...(readStringValue(data["workstreamId"]) ? { workstreamId: readStringValue(data["workstreamId"]) } : {}),
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
    ...(readStringValue(record["activeWorkstreamId"]) ? { activeWorkstreamId: readStringValue(record["activeWorkstreamId"]) } : {}),
    ...(readStringValue(record["workstreamId"]) ? { workstreamId: readStringValue(record["workstreamId"]) } : {}),
    ...(readStringValue(record["branch"]) ? { branch: readStringValue(record["branch"]) } : {}),
    ...(readStringValue(record["ref"]) ? { ref: readStringValue(record["ref"]) } : {}),
    ...(readStringValue(record["runId"]) ? { runId: readStringValue(record["runId"]) } : {}),
    ...(typeof record["committed"] === "boolean" ? { committed: record["committed"] } : {}),
    ...(readStringValue(record["commit"]) ? { commit: readStringValue(record["commit"]) } : {}),
    ...(readNumberValue(record["pendingWriteCount"]) !== undefined ? { pendingWriteCount: readNumberValue(record["pendingWriteCount"]) } : {}),
    ...(readNumberValue(record["resourceCount"]) !== undefined ? { resourceCount: readNumberValue(record["resourceCount"]) } : {}),
    ...(readNumberValue(record["recentRunCount"]) !== undefined ? { recentRunCount: readNumberValue(record["recentRunCount"]) } : {}),
    ...(readNumberValue(record["recentEvidenceCount"]) !== undefined ? { recentEvidenceCount: readNumberValue(record["recentEvidenceCount"]) } : {}),
    ...(readStringValue(record["contextRevision"]) ? { contextRevision: readStringValue(record["contextRevision"]) } : {}),
    ...(typeof record["workstreamBound"] === "boolean" ? { workstreamBound: record["workstreamBound"] } : {}),
    ...(readFinalizationOutcome(record["runOutcome"]) ? { runOutcome: readFinalizationOutcome(record["runOutcome"]) } : {}),
    ...(readRunStopReason(record["stopReason"]) ? { stopReason: readRunStopReason(record["stopReason"]) } : {}),
    ...(readCommitStatus(record["commitStatus"]) ? { commitStatus: readCommitStatus(record["commitStatus"]) } : {}),
    ...(readStringValue(record["headBefore"]) ? { headBefore: readStringValue(record["headBefore"]) } : {}),
    ...(readStringValue(record["headAfter"]) ? { headAfter: readStringValue(record["headAfter"]) } : {}),
    ...(readNumberValue(record["workStateRevision"]) !== undefined ? { workStateRevision: readNumberValue(record["workStateRevision"]) } : {}),
    ...(readNumberValue(record["lastPersistedStep"]) !== undefined ? { lastPersistedStep: readNumberValue(record["lastPersistedStep"]) } : {}),
    ...(readStringValue(record["observationRevision"]) ? { observationRevision: readStringValue(record["observationRevision"]) } : {}),
    ...(readObservationCounts(record["observationCounts"]) ? { observationCounts: readObservationCounts(record["observationCounts"]) } : {}),
    ...(readFeedbackWorkstreamLifecycle(record["workstreamLifecycle"])
      ? { workstreamLifecycle: readFeedbackWorkstreamLifecycle(record["workstreamLifecycle"]) }
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
    workstreamLifecycle: mergeFeedbackWorkstreamLifecycle(left.workstreamLifecycle, right.workstreamLifecycle),
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
  if (value.activeWorkstreamId) output.activeWorkstreamId = value.activeWorkstreamId;
  if (value.workstreamId) output.workstreamId = value.workstreamId;
  if (value.branch) output.branch = value.branch;
  if (value.ref) output.ref = value.ref;
  if (value.runId) output.runId = value.runId;
  if (value.committed !== undefined) output.committed = value.committed;
  if (value.commit) output.commit = value.commit;
  if (value.pendingWriteCount !== undefined) output.pendingWriteCount = value.pendingWriteCount;
  if (value.resourceCount !== undefined) output.resourceCount = value.resourceCount;
  if (value.recentRunCount !== undefined) output.recentRunCount = value.recentRunCount;
  if (value.recentEvidenceCount !== undefined) output.recentEvidenceCount = value.recentEvidenceCount;
  if (value.contextRevision) output.contextRevision = value.contextRevision;
  if (value.workstreamBound !== undefined) output.workstreamBound = value.workstreamBound;
  if (value.runOutcome) output.runOutcome = value.runOutcome;
  if (value.stopReason) output.stopReason = value.stopReason;
  if (value.commitStatus) output.commitStatus = value.commitStatus;
  if (value.headBefore) output.headBefore = value.headBefore;
  if (value.headAfter) output.headAfter = value.headAfter;
  if (value.workStateRevision !== undefined) output.workStateRevision = value.workStateRevision;
  if (value.lastPersistedStep !== undefined) output.lastPersistedStep = value.lastPersistedStep;
  if (value.observationRevision) output.observationRevision = value.observationRevision;
  if (value.observationCounts) output.observationCounts = value.observationCounts;
  const workstreamLifecycle = compactFeedbackWorkstreamLifecycle(value.workstreamLifecycle);
  if (workstreamLifecycle) output.workstreamLifecycle = workstreamLifecycle;
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

function readRecordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readSelectionMode(value: unknown): "created" | "activated" | undefined {
  return value === "created" || value === "activated" ? value : undefined;
}

function readWorkstreamRequestDecision(
  value: unknown,
): "initial" | "continue" | "create" | undefined {
  return value === "initial" || value === "continue" || value === "create"
    ? value
    : undefined;
}

function readWorkstreamRequestStatus(
  value: unknown,
): "queued" | "active" | "blocked" | "done" | "dropped" | undefined {
  return value === "queued" || value === "active" || value === "blocked" || value === "done" || value === "dropped"
    ? value
    : undefined;
}

function readNumberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readObservationCounts(
  value: unknown,
): AgentFeedbackContextEngineSummary["observationCounts"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const inventory = readNumberValue(record["inventory"]);
  const discovery = readNumberValue(record["discovery"]);
  const evidence = readNumberValue(record["evidence"]);
  const total = readNumberValue(record["total"]);
  if (
    inventory === undefined
    || discovery === undefined
    || evidence === undefined
    || total === undefined
  ) {
    return undefined;
  }
  return { inventory, discovery, evidence, total };
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
    || value === "not_required"
    || value === "no_change"
    || value === "committed"
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

function readRunStopReason(value: unknown): AgentFeedbackContextEngineSummary["stopReason"] {
  return value === "completed"
    || value === "run_limit"
    || value === "context_limit"
    || value === "failed"
    || value === "blocked"
    || value === "needs_user_input"
    || value === "interrupted"
    ? value
    : undefined;
}

function readCommitStatus(value: unknown): AgentFeedbackContextEngineSummary["commitStatus"] {
  return value === "not_required" || value === "no_change" || value === "committed"
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
