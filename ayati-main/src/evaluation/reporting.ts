import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type {
  EvaluationAnnotation,
  EvaluationArtifactReference,
  EvaluationComparison,
  EvaluationEvent,
  LiveEvaluationSession,
  ModelOperation,
  ProviderRequest,
  RunEvidence,
  RunEvidenceTotals,
} from "./contracts.js";
import { readEvaluationAnnotation, readScenarioLabels, readSessionAnnotations, renderEvaluationAnnotation, type RunEvaluationAnnotation } from "./annotation-reporting.js";
import { readEvaluationComparisons, renderEvaluationComparisons } from "./comparison-reporting.js";
import { buildDeterministicFindings, type HydratedEvaluationEvent } from "./diagnostics.js";
import { atomicWriteOutsideEvaluation, EvaluationStorage, safeSegment } from "./storage.js";

export async function generateEvaluationReports(input: {
  storage: EvaluationStorage;
  session: LiveEvaluationSession;
  runId?: string;
}): Promise<void> {
  const events = await readEvents(input.storage.path("events.jsonl"));
  const operations = (await readRecords<ModelOperation>(input.storage.path("operations")))
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  const requests = (await readRecords<ProviderRequest>(input.storage.path("requests")))
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  const runIds = input.runId
    ? [input.runId]
    : unique(events.map((event) => event.runId).filter((value): value is string => Boolean(value)));

  for (const runId of runIds) {
    const evidence = await buildRunEvidence({
      storage: input.storage,
      session: input.session,
      runId,
      events,
      operations,
      requests,
    });
    await input.storage.ensureRun(runId);
    const runSegment = safeSegment(runId);
    await input.storage.writeAtomic(join("runs", runSegment, "evidence.json"), evidence);
    await input.storage.writeAtomic(join("runs", runSegment, "findings.json"), evidence.findings);
    await input.storage.writeAtomic(join("runs", runSegment, "report.json"), buildRunReportJson(evidence));
    const annotation = await readEvaluationAnnotation(input.storage, runId);
    await input.storage.writeTextAtomic(
      join("runs", runSegment, "report.md"),
      renderRunReport(evidence, annotation),
    );
  }

  const runEvidence = await readRunEvidence(input.storage);
  const annotations = await readSessionAnnotations(input.storage, runEvidence);
  const comparisons = await readEvaluationComparisons(input.storage);
  const latestRunId = input.runId ?? runEvidence.at(-1)?.runId;
  await input.storage.writeAtomic("session-report.json", buildSessionReportJson(input.session, runEvidence, operations, events, annotations, comparisons));
  await input.storage.writeTextAtomic("session-report.md", renderSessionReport(input.session, runEvidence, operations, events, annotations, comparisons));
  await input.storage.writeAtomic("session.json", input.session);
  await input.storage.writeAtomic("latest.json", {
    schemaVersion: 1,
    evaluationId: input.session.evaluationId,
    updatedAt: new Date().toISOString(),
    ...(latestRunId ? { runId: latestRunId } : {}),
    sessionReport: "session-report.md",
  });
  await atomicWriteOutsideEvaluation(input.storage.evaluationRoot, "latest.json", {
    schemaVersion: 1,
    evaluationId: input.session.evaluationId,
    updatedAt: new Date().toISOString(),
    directory: basename(input.storage.evaluationDirectory),
    ...(latestRunId ? { runId: latestRunId } : {}),
  });
}

export async function compareEvaluations(input: {
  baseline: EvaluationStorage;
  candidate: EvaluationStorage;
}): Promise<EvaluationComparison> {
  const baselineRuns = await readRunEvidence(input.baseline);
  const candidateRuns = await readRunEvidence(input.candidate);
  const baseline = aggregateRuns(baselineRuns);
  const candidate = aggregateRuns(candidateRuns);
  return {
    schemaVersion: 1,
    baselineEvaluationId: input.baseline.evaluationId,
    candidateEvaluationId: input.candidate.evaluationId,
    generatedAt: new Date().toISOString(),
    dimensions: {
      correctness: compareCounts(baseline.errors, candidate.errors, "errorFindings"),
      reliability: compareCounts(baseline.failedRequests, candidate.failedRequests, "failedProviderRequests"),
      context: compareCounts(baseline.contextFindings, candidate.contextFindings, "contextFindings"),
      tokenEfficiency: compareNumbers(baseline.totalTokens, candidate.totalTokens, "totalTokens"),
      latency: compareNumbers(baseline.wallDurationMs, candidate.wallDurationMs, "wallDurationMs"),
      toolBehavior: {
        ...compareCounts(baseline.toolCalls, candidate.toolCalls, "toolCalls"),
        baselineFailureFindings: baseline.toolFindings,
        candidateFailureFindings: candidate.toolFindings,
      },
      practicalUsefulness: {
        baselineScenarioLabels: await readScenarioLabels(input.baseline),
        candidateScenarioLabels: await readScenarioLabels(input.candidate),
        note: "Practical usefulness remains a coding-agent/user annotation, not an automatic score.",
      },
    },
  };
}

async function buildRunEvidence(input: {
  storage: EvaluationStorage;
  session: LiveEvaluationSession;
  runId: string;
  events: EvaluationEvent[];
  operations: ModelOperation[];
  requests: ProviderRequest[];
}): Promise<RunEvidence> {
  const runEvents = input.events.filter((event) => event.runId === input.runId);
  const hydrated = await Promise.all(runEvents.map(async (record): Promise<HydratedEvaluationEvent> => ({
    record,
    data: await readArtifactRecord(input.storage, record.data),
  })));
  const operationIds = new Set(input.operations.filter((item) => item.runId === input.runId).map((item) => item.operationId));
  const operations = input.operations.filter((item) => item.runId === input.runId);
  const requests = input.requests.filter((item) => item.runId === input.runId || operationIds.has(item.operationId));
  const inputEvent = hydrated.find(({ record }) => record.component === "message" && record.event === "received");
  const canonicalRequests = await Promise.all(requests.map(async (request) => ({
    request,
    value: await readArtifactRecord(input.storage, request.canonicalRequest),
  })));
  const findings = buildDeterministicFindings({
    runId: input.runId,
    events: hydrated,
    operations,
    requests,
    canonicalRequests,
    ...(typeof inputEvent?.data?.["content"] === "string"
      ? { currentInput: inputEvent.data["content"] }
      : typeof inputEvent?.data?.["summary"] === "string" ? { currentInput: inputEvent.data["summary"] } : {}),
    captureDegraded: input.session.captureHealth.status === "degraded",
  });
  const first = runEvents[0];
  const last = runEvents.at(-1);
  const terminal = [...hydrated].reverse().find(({ record }) =>
    record.component === "final" && ["dispatched", "reply", "error"].includes(record.event));
  const finalization = hydrated.filter(({ record }) => record.component === "context_engine"
    && record.event.includes("finalization"));
  const totals = calculateTotals(runEvents, hydrated, operations, requests);
  totals.wallDurationMs = first && last ? Math.max(0, last.timestampMs - first.timestampMs) : 0;
  const criticalPath = buildCriticalPath(runEvents, requests);
  totals.foregroundCriticalPathMs = intervalUnionMs(criticalPath);
  const acknowledgement = [...hydrated].reverse().find(({ record }) =>
    record.component === "client" && record.event === "reply_rendered")
    ?? [...hydrated].reverse().find(({ record, data }) =>
      record.component === "transport" && record.event === "outbound" && data?.["terminal"] === true);
  const generatedAt = new Date().toISOString();

  return {
    schemaVersion: 1,
    evaluationId: input.session.evaluationId,
    runId: input.runId,
    ...(first?.sessionId ? { sessionId: first.sessionId } : {}),
    ...(first ? { startedAt: first.timestamp } : {}),
    ...(last ? { endedAt: last.timestamp } : {}),
    generatedAt,
    ...(inputEvent?.record.data ? { input: inputEvent.record.data } : {}),
    routing: selectArtifacts(hydrated, ({ record }) =>
      record.component.includes("routing")
      || record.component === "virtual_mode"
      || record.component === "workstream_binding"),
    modelOperations: operations,
    providerRequests: requests,
    toolActivity: selectEvents(hydrated, ({ record }) => ["tool", "tools", "action", "artifact"].includes(record.component)),
    verification: selectEvents(hydrated, ({ record }) => record.component === "verification"),
    workStateTransitions: selectEvents(hydrated, ({ record }) => record.component === "reducer"),
    resources: selectEvents(hydrated, ({ record }) =>
      record.component.includes("resource") || record.event.includes("resource")),
    contextEvolution: selectEvents(hydrated, ({ record }) =>
      record.component === "context_engine"
      || record.event.includes("context_")
      || record.event.includes("checkpoint")),
    finalization: finalization.map(({ record }) => record),
    ...(terminal?.record.data ? { terminalResponse: terminal.record.data } : {}),
    ...(typeof terminal?.data?.["type"] === "string" ? { terminalResponseType: terminal.data["type"] } : {}),
    ...(typeof terminal?.data?.["stopReason"] === "string" ? { stopReason: terminal.data["stopReason"] } : {}),
    ...(acknowledgement ? { acknowledgementAt: acknowledgement.record.timestamp } : {}),
    totals,
    criticalPath: criticalPath.map((span) => ({
      component: span.component,
      event: span.event,
      startedAt: span.startedAt,
      durationMs: span.durationMs,
      evidence: span.evidence,
    })),
    findings,
  };
}

function calculateTotals(
  events: EvaluationEvent[],
  hydrated: HydratedEvaluationEvent[],
  operations: ModelOperation[],
  requests: ProviderRequest[],
): RunEvidenceTotals {
  const iterationValues = [
    ...events.map((event) => Number(event.iteration ?? 0)),
    ...hydrated.map(({ data }) => Number(data?.["iteration"] ?? 0)),
  ].filter(Number.isFinite);
  return {
    agentLoopIterations: Math.max(0, ...iterationValues),
    logicalModelOperations: operations.length,
    foregroundModelOperations: operations.filter((operation) => operation.attribution === "foreground").length,
    backgroundModelOperations: operations.filter((operation) => operation.attribution !== "foreground").length,
    providerInvocations: requests.length,
    foregroundProviderInvocations: requests.filter((request) => request.attribution === "foreground").length,
    backgroundProviderInvocations: requests.filter((request) => request.attribution !== "foreground").length,
    observableProviderTransportAttempts: requests.reduce((sum, request) => sum + request.observableTransportAttempts, 0)
      + events.filter((event) => event.component === "provider_transport"
        && !event.requestId
        && ["countInputTokens", "generateTurn", "streamTurn"].includes(event.event)).length,
    embeddingOperations: events.filter((event) => event.component === "embedding" && event.event === "completed").length,
    imageGenerationOperations: events.filter((event) => event.component === "image_generation" && event.event === "completed").length,
    toolCalls: events.filter((event) => event.component === "tool" && event.event === "completed").length
      || events.filter((event) => event.component === "action" && event.event === "tool_result").length,
    inputTokens: requests.reduce((sum, request) => sum + (request.usage?.inputTokens ?? 0), 0),
    outputTokens: requests.reduce((sum, request) => sum + (request.usage?.outputTokens ?? 0), 0),
    cachedInputTokens: requests.reduce((sum, request) => sum + (request.usage?.cachedInputTokens ?? 0), 0),
    totalTokens: requests.reduce((sum, request) => sum + (request.usage?.totalTokens ?? 0), 0),
    costUsd: requests.reduce((sum, request) => sum + (request.cost?.totalCostUsd ?? 0), 0),
    wallDurationMs: 0,
    foregroundCriticalPathMs: 0,
  };
}

interface CriticalSpan {
  component: string;
  event: string;
  startedAt: string;
  startedMs: number;
  durationMs: number;
  evidence: string;
}

function buildCriticalPath(events: EvaluationEvent[], requests: ProviderRequest[]): CriticalSpan[] {
  const eventSpans = events.filter((event) =>
    event.component !== "provider"
    && event.attribution === "foreground"
    && typeof event.durationMs === "number"
    && event.durationMs > 0)
    .map((event) => ({
      component: event.component,
      event: event.event,
      startedAt: new Date(event.timestampMs - (event.durationMs ?? 0)).toISOString(),
      startedMs: event.timestampMs - (event.durationMs ?? 0),
      durationMs: event.durationMs ?? 0,
      evidence: `events.jsonl#${event.eventId}`,
    }));
  const requestSpans = requests.filter((request) => request.attribution === "foreground" && request.durationMs)
    .map((request) => ({
      component: "provider",
      event: request.purpose,
      startedAt: request.startedAt,
      startedMs: Date.parse(request.startedAt),
      durationMs: request.durationMs ?? 0,
      evidence: `requests/${request.requestId}.json`,
    }));
  return [...eventSpans, ...requestSpans]
    .sort((left, right) => left.startedMs - right.startedMs || right.durationMs - left.durationMs);
}

function intervalUnionMs(spans: CriticalSpan[]): number {
  const intervals = spans.map((span) => [span.startedMs, span.startedMs + span.durationMs] as const)
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end))
    .sort((left, right) => left[0] - right[0]);
  let total = 0;
  let start: number | undefined;
  let end: number | undefined;
  for (const interval of intervals) {
    if (start === undefined || end === undefined) {
      [start, end] = interval;
    } else if (interval[0] <= end) {
      end = Math.max(end, interval[1]);
    } else {
      total += end - start;
      [start, end] = interval;
    }
  }
  return start === undefined || end === undefined ? total : total + end - start;
}

function renderRunReport(evidence: RunEvidence, annotation?: EvaluationAnnotation): string {
  const requestRows = evidence.providerRequests.map((request) => [
    request.requestId,
    request.purpose,
    request.invocation,
    request.usage?.inputTokens ?? "-",
    request.usage?.outputTokens ?? "-",
    request.usage?.cachedInputTokens ?? "-",
    request.cost?.totalCostUsd?.toFixed(6) ?? "-",
    request.durationMs?.toFixed(1) ?? "-",
    markdownLink("request", `../../requests/${request.requestId}.json`),
    markdownLink("operation", `../../operations/${request.operationId}.json`),
    markdownLink("canonical", `../../${request.canonicalRequest.path}`),
    request.providerNativePayloads.flatMap((attempt) => attempt.outboundPayload
      ? [markdownLink("native request", `../../${attempt.outboundPayload.path}`)]
      : []).join(", ") || "-",
    (request.providerNativeResponses ?? []).map((response) => markdownLink("native response", `../../${response.path}`)).join(", ") || "-",
    request.normalizedResponse ? markdownLink("normalized", `../../${request.normalizedResponse.path}`) : "-",
  ].map(cell).join(" | "));
  const findings = evidence.findings.map((finding) =>
    `- **${finding.severity.toUpperCase()} · ${finding.code} · ${finding.confidence} confidence** — ${finding.observedFact} ${finding.diagnosticGuidance} Evidence: ${finding.affectedEvidence.map((item) => markdownLink(item, evidenceLink(item))).join(", ")}`);
  const previousByLane = new Map<string, ProviderRequest>();
  const contextRows = evidence.providerRequests.map((request) => {
    const lane = request.laneId ?? "main";
    const previous = previousByLane.get(lane);
    const currentTokens = request.usage?.inputTokens;
    const previousTokens = previous?.usage?.inputTokens;
    const delta = currentTokens !== undefined && previousTokens !== undefined ? currentTokens - previousTokens : "-";
    previousByLane.set(lane, request);
    return [request.requestId, lane, request.purpose, currentTokens ?? "-", delta, markdownLink("request", `../../requests/${request.requestId}.json`)].map(cell).join(" | ");
  });
  const waterfall = evidence.criticalPath.map((span) =>
    [span.startedAt, span.component, span.event, span.durationMs.toFixed(1), markdownLink("evidence", evidenceLink(span.evidence))].map(cell).join(" | "));
  const tools = evidence.toolActivity.map((event) =>
    [
      event.timestamp,
      event.component,
      event.event,
      event.outcome ?? "-",
      [markdownLink("event", "../../events.jsonl"), ...event.artifacts.map((artifact) => markdownLink(artifact.kind, `../../${artifact.path}`))].join(", "),
    ].map(cell).join(" | "));
  return [
    `# Live evaluation run ${evidence.runId}`,
    "",
    "## Outcome",
    "",
    `- Terminal type: ${evidence.terminalResponseType ?? "unknown"}`,
    `- Stop reason: ${evidence.stopReason ?? "not recorded"}`,
    `- Acknowledgement: ${evidence.acknowledgementAt ?? "not recorded"}`,
    `- Input evidence: ${evidence.input ? markdownLink("artifact", `../../${evidence.input.path}`) : "not captured"}`,
    `- Terminal response evidence: ${evidence.terminalResponse ? markdownLink("artifact", `../../${evidence.terminalResponse.path}`) : "not captured"}`,
    "",
    "## Model-request index",
    "",
    "Request | Purpose | Invocation | Input | Output | Cached | Cost USD | ms | Record | Operation | Exact canonical request | Provider-native request | Provider-native response | Normalized response",
    "--- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | ---",
    ...(requestRows.length > 0 ? requestRows : ["- | - | - | - | - | - | - | - | - | - | - | - | - | -"]),
    "",
    "## Context evolution",
    "",
    "Request | Lane | Purpose | Input tokens | Delta | Evidence",
    "--- | --- | --- | ---: | ---: | ---",
    ...(contextRows.length > 0 ? contextRows : ["- | - | - | - | - | -"]),
    "",
    "Exact messages, tool schemas, tool choice, response format, image references, compilation receipt, and prompt manifest are linked from each request and operation record.",
    "",
    "## Token, cost, and cache totals",
    "",
    `Input ${evidence.totals.inputTokens}; output ${evidence.totals.outputTokens}; cached ${evidence.totals.cachedInputTokens}; total ${evidence.totals.totalTokens}; cost USD ${evidence.totals.costUsd.toFixed(6)}.`,
    `Model operations: ${evidence.totals.foregroundModelOperations} foreground and ${evidence.totals.backgroundModelOperations} background; provider requests: ${evidence.totals.foregroundProviderInvocations} foreground and ${evidence.totals.backgroundProviderInvocations} background.`,
    "",
    "## Foreground latency waterfall",
    "",
    "Start | Component | Span | ms | Evidence",
    "--- | --- | --- | ---: | ---",
    ...(waterfall.length > 0 ? waterfall : ["- | - | - | - | -"]),
    "",
    `Foreground interval union: ${evidence.totals.foregroundCriticalPathMs.toFixed(1)} ms; run wall time: ${evidence.totals.wallDurationMs.toFixed(1)} ms. Background spans are excluded from the union.`,
    "",
    "## Tools, verification, and resources",
    "",
    "Time | Component | Event | Outcome | Evidence",
    "--- | --- | --- | --- | ---",
    ...(tools.length > 0 ? tools : ["- | - | - | - | -"]),
    "",
    `Verification events: ${evidence.verification.length}; WorkState transitions: ${evidence.workStateTransitions.length}; resource events: ${evidence.resources.length}; finalization events: ${evidence.finalization.length}.`,
    "",
    "## Deterministic findings",
    "",
    ...(findings.length > 0 ? findings : ["No deterministic invariant, failure, efficiency, or capture-gap finding was produced."]),
    "",
    "## Coding-agent conclusions and suggested experiments",
    "",
    ...(annotation
      ? renderEvaluationAnnotation(annotation)
      : ["Intentionally empty. Populate this section with `pnpm eval:agent -- annotate` after reviewing the linked evidence."]),
    "",
    "No overall score is generated. Correctness, reliability, context, token efficiency, latency, tool behavior, and practical usefulness remain separate dimensions.",
    "",
  ].join("\n");
}

function renderSessionReport(
  session: LiveEvaluationSession,
  runs: RunEvidence[],
  operations: ModelOperation[],
  events: EvaluationEvent[],
  annotations: RunEvaluationAnnotation[],
  comparisons: EvaluationComparison[],
): string {
  const rows = runs.map((run) => [
    run.runId,
    run.terminalResponseType ?? "-",
    run.stopReason ?? "-",
    run.totals.logicalModelOperations,
    run.totals.providerInvocations,
    run.totals.totalTokens,
    run.totals.costUsd.toFixed(6),
    run.totals.wallDurationMs.toFixed(1),
    run.findings.filter((finding) => ["error", "critical"].includes(finding.severity)).length,
    markdownLink("report", `runs/${safeSegment(run.runId)}/report.md`),
  ].map(cell).join(" | "));
  const timeline = runs.flatMap((run) => run.criticalPath.map((span) =>
    [span.startedAt, run.runId, span.component, span.event, span.durationMs.toFixed(1), markdownLink("evidence", join("runs", safeSegment(run.runId), evidenceLink(span.evidence)))].map(cell).join(" | ")));
  const conclusions = annotations.flatMap(({ runId, annotation }) => [
    `### ${markdownLink(runId, `runs/${safeSegment(runId)}/report.md`)}`,
    "",
    ...renderEvaluationAnnotation(annotation),
    "",
  ]);
  return [
    `# Live Ayati evaluation: ${session.name}`,
    "",
    `Evaluation ID: ${session.evaluationId}`,
    `Status: ${session.status}; capture health: ${session.captureHealth.status}`,
    `Provider/model: ${session.runtime.provider}/${session.runtime.model ?? "unknown"}`,
    `Runtime root: ${session.configuredRuntimeRoot}`,
    `Unattributed background model operations: ${operations.filter((item) => item.attribution === "background_unattributed").length}; descendant background model operations: ${operations.filter((item) => item.attribution === "descendant_background").length}.`,
    "",
    "## Turn outcomes",
    "",
    "Run | Result | Stop | Operations | Requests | Tokens | Cost USD | Wall ms | Errors | Evidence",
    "--- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---",
    ...(rows.length > 0 ? rows : ["- | - | - | - | - | - | - | - | - | -"]),
    "",
    "## Chronological causal timeline",
    "",
    "Start | Run | Component | Event | ms | Evidence",
    "--- | --- | --- | --- | ---: | ---",
    ...(timeline.length > 0 ? timeline.sort() : ["- | - | - | - | - | -"]),
    "",
    "## Context Engine and durable finalization",
    "",
    "Each run report includes Context Engine revisions, routing/binding, resource mutation, workstream HEAD, finalization, and acknowledgement events captured from the unified event source.",
    `The append-only source also contains ${events.filter((event) => !event.runId).length} daemon event(s) without run attribution; these remain visible as background_unattributed rather than being discarded.`,
    "",
    ...renderEvaluationComparisons(comparisons),
    "## Coding-agent conclusions and suggested experiments",
    "",
    ...(conclusions.length > 0
      ? conclusions
      : ["Intentionally empty until populated through evidence-linked annotations."]),
    "",
    "No aggregate score is produced.",
    "",
  ].join("\n");
}

function buildRunReportJson(evidence: RunEvidence): Record<string, unknown> {
  return {
    schemaVersion: 1,
    runId: evidence.runId,
    generatedAt: evidence.generatedAt,
    outcome: {
      type: evidence.terminalResponseType,
      stopReason: evidence.stopReason,
      acknowledgementAt: evidence.acknowledgementAt,
    },
    totals: evidence.totals,
    dimensions: {
      correctness: evidence.findings.filter((item) => item.code.includes("COMPLETION") || item.code.includes("VERIFICATION")),
      reliability: evidence.findings.filter((item) => item.code.includes("FAILED") || item.code.includes("RETRY")),
      context: evidence.findings.filter((item) => item.likelySubsystem.includes("context")),
      tokenEfficiency: { inputTokens: evidence.totals.inputTokens, cachedInputTokens: evidence.totals.cachedInputTokens },
      latency: { wallDurationMs: evidence.totals.wallDurationMs, foregroundCriticalPathMs: evidence.totals.foregroundCriticalPathMs },
      toolBehavior: { toolCalls: evidence.totals.toolCalls, findings: evidence.findings.filter((item) => item.likelySubsystem.includes("tool")) },
      practicalUsefulness: { source: "annotation", value: null },
    },
    findings: evidence.findings,
  };
}

function buildSessionReportJson(
  session: LiveEvaluationSession,
  runs: RunEvidence[],
  operations: ModelOperation[],
  events: EvaluationEvent[],
  annotations: RunEvaluationAnnotation[],
  comparisons: EvaluationComparison[],
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    evaluationId: session.evaluationId,
    generatedAt: new Date().toISOString(),
    session,
    turns: runs.map((run) => ({ runId: run.runId, startedAt: run.startedAt, endedAt: run.endedAt, outcome: run.terminalResponseType, stopReason: run.stopReason, totals: run.totals, findings: run.findings })),
    annotations,
    comparisons,
    backgroundActivity: {
      descendantModelOperations: operations.filter((item) => item.attribution === "descendant_background").length,
      unattributedModelOperations: operations.filter((item) => item.attribution === "background_unattributed").length,
      unattributedEvents: events.filter((event) => !event.runId).length,
    },
  };
}

async function readEvents(path: string): Promise<EvaluationEvent[]> {
  const content = await readFile(path, "utf8").catch(() => "");
  return content.split("\n").filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line) as EvaluationEvent];
    } catch {
      return [];
    }
  }).sort((left, right) => left.timestampMs - right.timestampMs);
}

async function readRecords<T>(directory: string): Promise<T[]> {
  const names = await readdir(directory).catch(() => []);
  return await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) =>
    JSON.parse(await readFile(join(directory, name), "utf8")) as T));
}

async function readRunEvidence(storage: EvaluationStorage): Promise<RunEvidence[]> {
  const directories = await readdir(storage.path("runs"), { withFileTypes: true }).catch(() => []);
  const values = await Promise.all(directories.filter((entry) => entry.isDirectory()).map(async (entry) => {
    try {
      return JSON.parse(await readFile(storage.path("runs", entry.name, "evidence.json"), "utf8")) as RunEvidence;
    } catch {
      return undefined;
    }
  }));
  return values.filter((value): value is RunEvidence => Boolean(value)).sort((left, right) =>
    evidenceStart(left).localeCompare(evidenceStart(right)) || left.runId.localeCompare(right.runId));
}

function evidenceStart(run: RunEvidence): string { return run.startedAt ?? run.criticalPath[0]?.startedAt ?? run.providerRequests[0]?.startedAt ?? run.generatedAt; }

async function readArtifactRecord(storage: EvaluationStorage, ref?: EvaluationArtifactReference): Promise<Record<string, unknown> | undefined> {
  if (!ref) return undefined;
  try {
    const envelope = JSON.parse(await readFile(storage.path(ref.path), "utf8")) as Record<string, unknown>;
    const value = envelope["value"];
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : { value };
  } catch {
    return undefined;
  }
}

function selectEvents(events: HydratedEvaluationEvent[], predicate: (event: HydratedEvaluationEvent) => boolean): EvaluationEvent[] {
  return events.filter(predicate).map(({ record }) => record);
}

function selectArtifacts(events: HydratedEvaluationEvent[], predicate: (event: HydratedEvaluationEvent) => boolean): EvaluationArtifactReference[] {
  return events.filter(predicate).flatMap(({ record }) => record.data ? [record.data] : record.artifacts);
}

interface AggregatedRuns {
  errors: number;
  failedRequests: number;
  contextFindings: number;
  totalTokens: number;
  wallDurationMs: number;
  toolCalls: number;
  toolFindings: number;
}

function aggregateRuns(runs: RunEvidence[]): AggregatedRuns {
  return {
    errors: runs.flatMap((run) => run.findings).filter((item) => ["error", "critical"].includes(item.severity)).length,
    failedRequests: runs.flatMap((run) => run.providerRequests).filter((item) => item.outcome === "failed").length,
    contextFindings: runs.flatMap((run) => run.findings).filter((item) => item.likelySubsystem.includes("context")).length,
    totalTokens: runs.reduce((sum, run) => sum + run.totals.totalTokens, 0),
    wallDurationMs: runs.reduce((sum, run) => sum + run.totals.wallDurationMs, 0),
    toolCalls: runs.reduce((sum, run) => sum + run.totals.toolCalls, 0),
    toolFindings: runs.flatMap((run) => run.findings).filter((item) => item.likelySubsystem.includes("tool")).length,
  };
}

function compareCounts(baseline: number, candidate: number, label: string): Record<string, unknown> {
  return { label, baseline, candidate, delta: candidate - baseline };
}

function compareNumbers(baseline: number, candidate: number, label: string): Record<string, unknown> {
  return { label, baseline, candidate, delta: candidate - baseline, deltaPercent: baseline === 0 ? null : ((candidate - baseline) / baseline) * 100 };
}

function evidenceLink(value: string): string {
  if (value.startsWith("events.jsonl")) return "../../events.jsonl";
  return `../../${value}`;
}

function markdownLink(label: string, path: string): string {
  return `[${label}](${path.split("\\").join("/")})`;
}

function cell(value: unknown): string {
  return String(value ?? "-").replaceAll("|", "\\|").replaceAll("\n", " ");
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
