import { randomUUID } from "node:crypto";
import type {
  AgentFeedbackEventInput,
  AgentFeedbackLedger,
} from "../ivec/feedback-ledger.js";
import { currentEvaluationContext } from "./async-context.js";
import type {
  EvaluationArtifactReference,
  EvaluationEvent,
  EvaluationOperationStart,
  EvaluationProviderRequestEnd,
  EvaluationProviderRequestStart,
  EvaluationSessionStatus,
  LiveEvaluationSession,
  ModelOperation,
  ProviderRequest,
} from "./contracts.js";
import { generateEvaluationReports } from "./reporting.js";
import { EvaluationStorage, safeSegment } from "./storage.js";

interface TimedRecord {
  startedNs: bigint;
}

export class LiveEvaluationRecorder implements AgentFeedbackLedger {
  readonly enabled = true;
  readonly operations = new Map<string, ModelOperation>();
  readonly requests = new Map<string, ProviderRequest>();
  private readonly operationTiming = new Map<string, TimedRecord>();
  private readonly requestTiming = new Map<string, TimedRecord>();
  private writeTail: Promise<void> = Promise.resolve();
  private closing = false;

  constructor(
    readonly storage: EvaluationStorage,
    readonly session: LiveEvaluationSession,
  ) {}

  record(input: AgentFeedbackEventInput): void {
    this.updateParsingOutcome(input);
    const context = currentEvaluationContext();
    const at = new Date();
    const monotonic = process.hrtime.bigint();
    const eventId = `EVT-${randomUUID()}`;
    this.enqueue(`${input.stage}.${input.event}`, async () => {
      const data = input.data
        ? await this.storage.writeArtifact(`${input.stage}.${input.event}.data`, input.data)
        : undefined;
      const artifacts = input.data
        ? await this.extractDirectArtifacts(input.stage, input.event, input.data)
        : [];
      const durationMs = numeric(input.data?.["durationMs"]);
      const event: EvaluationEvent = {
        schemaVersion: 1,
        eventId,
        evaluationId: this.session.evaluationId,
        timestamp: at.toISOString(),
        timestampMs: at.getTime(),
        monotonicNs: monotonic.toString(),
        component: input.stage,
        event: input.event,
        ...(input.sessionId ? { sessionId: input.sessionId } : context?.sessionId ? { sessionId: context.sessionId } : {}),
        ...(input.runId ? { runId: input.runId } : context?.runId ? { runId: context.runId } : {}),
        ...(context?.laneId ? { laneId: context.laneId } : {}),
        ...(numeric(input.data?.["iteration"]) !== undefined
          ? { iteration: numeric(input.data?.["iteration"]) }
          : context?.iteration !== undefined ? { iteration: context.iteration } : {}),
        ...(context?.operationId ? { operationId: context.operationId } : {}),
        ...(context?.requestId ? { requestId: context.requestId } : {}),
        ...(context?.spanId ? { spanId: context.spanId } : {}),
        ...(context?.parentSpanId ? { parentSpanId: context.parentSpanId } : {}),
        attribution: context?.attribution ?? "background_unattributed",
        outcome: inferOutcome(input.event, input.data),
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(data ? { data } : {}),
        artifacts,
      };
      await this.storage.appendEventLine(event);
    });
  }

  startOperation(input: EvaluationOperationStart): string {
    const context = currentEvaluationContext();
    const operationId = `OP-${randomUUID()}`;
    const attribution = input.attribution ?? context?.attribution ?? "background_unattributed";
    const operation: ModelOperation = {
      schemaVersion: 1,
      evaluationId: this.session.evaluationId,
      operationId,
      purpose: input.purpose,
      ...(input.parentOperationId ? { parentOperationId: input.parentOperationId } : context?.operationId ? { parentOperationId: context.operationId } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : context?.sessionId ? { sessionId: context.sessionId } : {}),
      ...(input.runId ? { runId: input.runId } : context?.runId ? { runId: context.runId } : {}),
      ...(input.laneId ? { laneId: input.laneId } : context?.laneId ? { laneId: context.laneId } : {}),
      ...(input.iteration !== undefined ? { iteration: input.iteration } : context?.iteration !== undefined ? { iteration: context.iteration } : {}),
      attribution,
      foreground: attribution === "foreground",
      startedAt: new Date().toISOString(),
      providerRequestIds: [],
      terminalOutcome: "running",
    };
    this.operations.set(operationId, operation);
    this.operationTiming.set(operationId, { startedNs: process.hrtime.bigint() });
    this.enqueue(`operation.start.${operationId}`, async () => {
      const receipt = input.compilationReceipt
        ? await this.storage.writeArtifact("context-compilation-receipt", input.compilationReceipt)
        : undefined;
      const manifest = input.promptManifest
        ? await this.storage.writeArtifact("prompt-context-manifest", input.promptManifest)
        : undefined;
      if (receipt || manifest) {
        operation.compilation = {
          ...(receipt ? { receipt } : {}),
          ...(manifest ? { promptManifest: manifest } : {}),
        };
      }
      await this.writeOperation(operation);
      await this.appendSpanEvent("model_operation", input.purpose, operation, "started");
    });
    return operationId;
  }

  finishOperation(operationId: string, error?: unknown): void {
    const operation = this.operations.get(operationId);
    if (!operation) return;
    const timing = this.operationTiming.get(operationId);
    operation.completedAt = new Date().toISOString();
    operation.durationMs = timing ? elapsedMs(timing.startedNs) : undefined;
    operation.terminalOutcome = error ? "failed" : "completed";
    this.enqueue(`operation.finish.${operationId}`, async () => {
      if (error) operation.error = await this.storage.writeArtifact("model-operation-error", error);
      await this.writeOperation(operation);
      await this.appendSpanEvent(
        "model_operation",
        operation.purpose,
        operation,
        error ? "failed" : "completed",
      );
    });
    this.operationTiming.delete(operationId);
  }

  startProviderRequest(input: EvaluationProviderRequestStart): string {
    const context = currentEvaluationContext();
    const operationId = context?.operationId;
    if (!operationId) throw new Error("Provider request capture requires a model operation context.");
    const requestId = `REQ-${randomUUID()}`;
    const request = {
      schemaVersion: 1 as const,
      evaluationId: this.session.evaluationId,
      requestId,
      operationId,
      purpose: context.purpose ?? this.operations.get(operationId)?.purpose ?? "unclassified",
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      ...(context.runId ? { runId: context.runId } : {}),
      ...(context.laneId ? { laneId: context.laneId } : {}),
      ...(context.iteration !== undefined ? { iteration: context.iteration } : {}),
      attribution: context.attribution,
      provider: input.provider,
      providerVersion: input.providerVersion,
      invocation: input.invocation,
      startedAt: new Date().toISOString(),
      providerNativePayloads: [],
      providerNativeResponses: [],
      observableTransportAttempts: 0,
      sdkInternalRetryCount: "not_exposed" as const,
      parsing: { status: "not_observed" as const },
      outcome: "running" as const,
    } as Omit<ProviderRequest, "canonicalRequest"> & { canonicalRequest?: EvaluationArtifactReference };
    this.requests.set(requestId, request as ProviderRequest);
    this.requestTiming.set(requestId, { startedNs: process.hrtime.bigint() });
    const operation = this.operations.get(operationId);
    if (operation) operation.providerRequestIds.push(requestId);
    this.enqueue(`request.start.${requestId}`, async () => {
      request.canonicalRequest = await this.storage.writeArtifact("canonical-llm-turn-input", input.input);
      await this.writeRequest(request as ProviderRequest);
      if (operation) await this.writeOperation(operation);
    });
    return requestId;
  }

  recordProviderTransport(input: {
    provider: string;
    operation: "countInputTokens" | "generateTurn" | "streamTurn";
    payload: unknown;
  }): void {
    const context = currentEvaluationContext();
    const requestId = context?.requestId;
    const request = requestId ? this.requests.get(requestId) : undefined;
    this.enqueue(`provider.transport.${requestId ?? "unattributed"}`, async () => {
      const outboundPayload = await this.storage.writeArtifact("provider-native-outbound-payload", input.payload);
      if (request) {
        request.providerNativePayloads.push({
          attemptId: `ATTEMPT-${randomUUID()}`,
          observedAt: new Date().toISOString(),
          provider: input.provider,
          operation: input.operation,
          outboundPayload,
          observable: true,
        });
        request.observableTransportAttempts = request.providerNativePayloads.length;
        await this.writeRequest(request);
        return;
      }
      await this.storage.appendEventLine({
        schemaVersion: 1,
        eventId: `EVT-${randomUUID()}`,
        evaluationId: this.session.evaluationId,
        timestamp: new Date().toISOString(),
        timestampMs: Date.now(),
        monotonicNs: process.hrtime.bigint().toString(),
        component: "provider_transport",
        event: input.operation,
        ...(context?.sessionId ? { sessionId: context.sessionId } : {}),
        ...(context?.runId ? { runId: context.runId } : {}),
        ...(context?.laneId ? { laneId: context.laneId } : {}),
        ...(context?.iteration !== undefined ? { iteration: context.iteration } : {}),
        ...(context?.operationId ? { operationId: context.operationId } : {}),
        ...(context?.requestId ? { requestId: context.requestId } : {}),
        ...(context?.spanId ? { spanId: context.spanId } : {}),
        ...(context?.parentSpanId ? { parentSpanId: context.parentSpanId } : {}),
        attribution: context?.attribution ?? "background_unattributed",
        outcome: "completed",
        artifacts: [outboundPayload],
      } satisfies EvaluationEvent);
    });
  }

  recordProviderResponse(input: {
    provider: string;
    operation: "countInputTokens" | "generateTurn" | "streamTurn";
    response: unknown;
  }): void {
    const context = currentEvaluationContext();
    const request = context?.requestId ? this.requests.get(context.requestId) : undefined;
    this.enqueue(`provider.response.${context?.requestId ?? "unattributed"}`, async () => {
      const response = await this.storage.writeArtifact("provider-native-response", input.response);
      if (request) {
        request.providerNativeResponses.push(response);
        await this.writeRequest(request);
        return;
      }
      await this.storage.appendEventLine({
        schemaVersion: 1,
        eventId: `EVT-${randomUUID()}`,
        evaluationId: this.session.evaluationId,
        timestamp: new Date().toISOString(),
        timestampMs: Date.now(),
        monotonicNs: process.hrtime.bigint().toString(),
        component: "provider_transport",
        event: `${input.operation}_response`,
        ...(context?.sessionId ? { sessionId: context.sessionId } : {}),
        ...(context?.runId ? { runId: context.runId } : {}),
        ...(context?.laneId ? { laneId: context.laneId } : {}),
        ...(context?.iteration !== undefined ? { iteration: context.iteration } : {}),
        ...(context?.operationId ? { operationId: context.operationId } : {}),
        attribution: context?.attribution ?? "background_unattributed",
        outcome: "completed",
        artifacts: [response],
      } satisfies EvaluationEvent);
    });
  }

  finishProviderRequest(requestId: string, input: EvaluationProviderRequestEnd): void {
    const request = this.requests.get(requestId);
    if (!request) return;
    request.completedAt = new Date().toISOString();
    request.durationMs = input.durationMs;
    request.timeToFirstTokenMs = input.timeToFirstTokenMs;
    request.streamingDurationMs = input.streamingDurationMs;
    request.outcome = input.error ? "failed" : "completed";
    if (input.output) {
      request.usage = input.output.usage;
      request.cost = input.output.cost;
    }
    this.enqueue(`request.finish.${requestId}`, async () => {
      if (input.output) request.normalizedResponse = await this.storage.writeArtifact("normalized-provider-response", input.output);
      if (input.error) request.error = await this.storage.writeArtifact("provider-error", input.error);
      await this.writeRequest(request);
      await this.appendRequestSpanEvent(request);
    });
    this.requestTiming.delete(requestId);
  }

  async checkpoint(runId?: string): Promise<void> {
    this.scheduleCheckpoint(runId);
    await this.flush();
  }

  scheduleCheckpoint(runId?: string): void {
    this.enqueue(`report.checkpoint.${runId ?? "session"}`, async () => {
      await this.generateReportsBestEffort(runId, "checkpoint");
    });
  }

  async flush(): Promise<void> {
    await this.writeTail;
    await this.persistSessionBestEffort();
  }

  async close(status: EvaluationSessionStatus = "completed"): Promise<void> {
    if (this.closing) return await this.writeTail;
    this.closing = true;
    await this.flush();
    this.session.endedAt = new Date().toISOString();
    this.session.status = this.session.captureHealth.status === "degraded" ? "degraded" : status;
    await this.persistSessionBestEffort();
    try {
      await generateEvaluationReports({ storage: this.storage, session: this.session });
    } catch (error) {
      this.markGap("reporting", "close", error);
      await this.persistSessionBestEffort();
    }
  }

  private enqueue(operation: string, task: () => Promise<void>): void {
    if (this.closing && !operation.startsWith("session")) return;
    this.session.captureHealth.queuedWrites++;
    this.writeTail = this.writeTail.then(async () => {
      const startedAt = process.hrtime.bigint();
      try {
        await task();
        this.session.captureHealth.completedWrites++;
      } catch (error) {
        this.session.captureHealth.failedWrites++;
        this.markGap("recorder", operation, error);
      } finally {
        this.session.captureHealth.recorderOverheadMs += elapsedMs(startedAt);
      }
    }).catch((error) => {
      this.markGap("recorder", operation, error);
    });
  }

  private async generateReportsBestEffort(runId: string | undefined, operation: string): Promise<void> {
    try {
      await generateEvaluationReports({
        storage: this.storage,
        session: this.session,
        ...(runId ? { runId } : {}),
      });
    } catch (error) {
      this.markGap("reporting", operation, error);
      await this.persistSessionBestEffort();
    }
  }

  private markGap(component: string, operation: string, error: unknown): void {
    this.session.captureHealth.status = "degraded";
    this.session.captureHealth.gaps.push({
      at: new Date().toISOString(),
      component,
      operation,
      message: error instanceof Error ? error.message : String(error),
    });
    this.session.captureHealth.gaps = this.session.captureHealth.gaps.slice(-100);
  }

  private async persistSessionBestEffort(): Promise<void> {
    try {
      await this.storage.writeAtomic("session.json", this.session);
    } catch (error) {
      this.markGap("storage", "session", error);
    }
  }

  private async writeOperation(operation: ModelOperation): Promise<void> {
    await this.storage.writeAtomic(`operations/${safeSegment(operation.operationId)}.json`, operation);
  }

  private async writeRequest(request: ProviderRequest): Promise<void> {
    await this.storage.writeAtomic(`requests/${safeSegment(request.requestId)}.json`, request);
  }

  private async extractDirectArtifacts(
    stage: string,
    event: string,
    data: Record<string, unknown>,
  ): Promise<EvaluationArtifactReference[]> {
    const values: Array<{ kind: string; value: unknown; mediaType?: string }> = [];
    for (const key of ["content", "output", "outputPreview", "rawOutput", "input", "context", "workState"]) {
      if (data[key] !== undefined) values.push({ kind: `${stage}.${event}.${key}`, value: data[key] });
    }
    return await Promise.all(values.map((value) => this.storage.writeArtifact(value.kind, value.value, value.mediaType)));
  }

  private updateParsingOutcome(input: AgentFeedbackEventInput): void {
    if (input.stage !== "decision" || !input.runId) return;
    const request = [...this.requests.values()].reverse().find((item) => item.runId === input.runId);
    if (!request?.parsing) return;
    if (["parsed", "direct_reply"].includes(input.event)) {
      request.parsing.status = request.parsing.repairCount ? "repaired" : "accepted";
    } else if (input.event === "repair_requested") {
      request.parsing.status = "repaired";
      request.parsing.repairCount = (request.parsing.repairCount ?? 0) + 1;
    } else if (["parse_failed", "protocol_violation", "input_schema_violation", "failed_fallback"].includes(input.event)) {
      request.parsing.status = "failed";
    } else {
      return;
    }
    this.enqueue(`request.parsing.${request.requestId}`, async () => await this.writeRequest(request));
  }

  private async appendSpanEvent(
    component: string,
    eventName: string,
    operation: ModelOperation,
    outcome: EvaluationEvent["outcome"],
  ): Promise<void> {
    const completed = outcome !== "started";
    const timestamp = completed && operation.completedAt ? operation.completedAt : operation.startedAt;
    await this.storage.appendEventLine({
      schemaVersion: 1,
      eventId: `EVT-${randomUUID()}`,
      evaluationId: this.session.evaluationId,
      timestamp,
      timestampMs: Date.parse(timestamp),
      monotonicNs: process.hrtime.bigint().toString(),
      component,
      event: eventName,
      ...(operation.sessionId ? { sessionId: operation.sessionId } : {}),
      ...(operation.runId ? { runId: operation.runId } : {}),
      ...(operation.laneId ? { laneId: operation.laneId } : {}),
      ...(operation.iteration !== undefined ? { iteration: operation.iteration } : {}),
      operationId: operation.operationId,
      attribution: operation.attribution,
      outcome,
      ...(completed && operation.durationMs !== undefined ? { durationMs: operation.durationMs } : {}),
      artifacts: [],
    } satisfies EvaluationEvent);
  }

  private async appendRequestSpanEvent(request: ProviderRequest): Promise<void> {
    const timestamp = request.completedAt ?? new Date().toISOString();
    await this.storage.appendEventLine({
      schemaVersion: 1,
      eventId: `EVT-${randomUUID()}`,
      evaluationId: this.session.evaluationId,
      timestamp,
      timestampMs: Date.parse(timestamp),
      monotonicNs: process.hrtime.bigint().toString(),
      component: "provider",
      event: request.invocation,
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      ...(request.runId ? { runId: request.runId } : {}),
      ...(request.laneId ? { laneId: request.laneId } : {}),
      ...(request.iteration !== undefined ? { iteration: request.iteration } : {}),
      operationId: request.operationId,
      requestId: request.requestId,
      attribution: request.attribution,
      outcome: request.outcome === "completed" ? "completed" : "failed",
      ...(request.durationMs !== undefined ? { durationMs: request.durationMs } : {}),
      artifacts: [request.canonicalRequest, ...(request.normalizedResponse ? [request.normalizedResponse] : [])].filter(Boolean),
    } satisfies EvaluationEvent);
  }
}

export function combineFeedbackLedgers(
  primary: AgentFeedbackLedger,
  evaluation?: LiveEvaluationRecorder,
): AgentFeedbackLedger {
  if (!evaluation) return primary;
  return {
    enabled: primary.enabled || evaluation.enabled,
    record(event): void {
      primary.record(event);
      evaluation.record(event);
    },
    scheduleCheckpoint(runId?: string): void {
      primary.scheduleCheckpoint?.(runId);
      evaluation.scheduleCheckpoint(runId);
    },
    async checkpoint(runId?: string): Promise<void> {
      await Promise.all([primary.checkpoint?.(runId), evaluation.checkpoint(runId)]);
    },
    async flush(): Promise<void> {
      await Promise.all([primary.flush(), evaluation.flush()]);
    },
    async close(): Promise<void> {
      await Promise.all([primary.close(), evaluation.flush()]);
    },
  };
}

function inferOutcome(event: string, data?: Record<string, unknown>): EvaluationEvent["outcome"] {
  if (event.includes("failed") || event === "error" || data?.["status"] === "failed") return "failed";
  if (event.includes("started") || event.includes("queued") || event === "received") return "started";
  if (event.includes("skipped") || event.includes("discarded")) return "skipped";
  if (event.includes("completed") || event.includes("reply") || event.includes("dispatched") || event.includes("rendered")) return "completed";
  return "unknown";
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function elapsedMs(startedNs: bigint): number {
  return Number(process.hrtime.bigint() - startedNs) / 1_000_000;
}
