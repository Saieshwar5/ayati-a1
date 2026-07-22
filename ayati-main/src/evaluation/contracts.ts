import type {
  LlmCostEstimate,
  LlmTokenUsage,
  LlmTurnInput,
  LlmTurnOutput,
} from "../core/contracts/llm-protocol.js";

export const LIVE_EVALUATION_SCHEMA_VERSION = 1 as const;

export type EvaluationCaptureMode = "full" | "safe";
export type EvaluationSessionStatus =
  | "starting"
  | "running"
  | "completed"
  | "interrupted"
  | "failed"
  | "degraded";
export type EvaluationAttribution =
  | "foreground"
  | "descendant_background"
  | "background_unattributed";
export type ModelOperationPurpose =
  | "main_decision"
  | "decision_repair"
  | "provider_retry"
  | "final_response"
  | "durable_checkpoint_summary"
  | "run_focus_summary"
  | "memory_consolidation"
  | "proposal_reflection"
  | "context_extraction"
  | "unclassified";

export interface EvaluationArtifactReference {
  artifactId: string;
  sha256: string;
  path: string;
  kind: string;
  mediaType: string;
  sizeBytes: number;
  capture: EvaluationCaptureMode;
}

export interface EvaluationCaptureGap {
  at: string;
  component: string;
  operation: string;
  message: string;
}

export interface EvaluationCaptureHealth {
  status: "healthy" | "degraded";
  queuedWrites: number;
  completedWrites: number;
  failedWrites: number;
  droppedEvents: number;
  recorderOverheadMs: number;
  gaps: EvaluationCaptureGap[];
}

export interface LiveEvaluationSession {
  schemaVersion: typeof LIVE_EVALUATION_SCHEMA_VERSION;
  evaluationId: string;
  name: string;
  command: string;
  capture: EvaluationCaptureMode;
  evidenceDirectory: string;
  configuredRuntimeRoot: string;
  repository: {
    root: string;
    branch?: string;
    head?: string;
    dirty: boolean;
    dirtyFingerprint?: string;
  };
  runtime: {
    provider: string;
    providerVersion: string;
    model?: string;
    configVersion: string;
    configFingerprint: string;
  };
  machine: {
    hostname: string;
    platform: NodeJS.Platform;
    architecture: string;
    nodeVersion: string;
    cpuCount: number;
    totalMemoryBytes: number;
    pid: number;
  };
  startedAt: string;
  endedAt?: string;
  status: EvaluationSessionStatus;
  captureHealth: EvaluationCaptureHealth;
}

export interface EvaluationEvent {
  schemaVersion: typeof LIVE_EVALUATION_SCHEMA_VERSION;
  eventId: string;
  evaluationId: string;
  timestamp: string;
  timestampMs: number;
  monotonicNs: string;
  component: string;
  event: string;
  sessionId?: string;
  runId?: string;
  laneId?: string;
  iteration?: number;
  operationId?: string;
  requestId?: string;
  spanId?: string;
  parentSpanId?: string;
  attribution: EvaluationAttribution;
  outcome?: "started" | "completed" | "failed" | "skipped" | "unknown";
  durationMs?: number;
  data?: EvaluationArtifactReference;
  artifacts: EvaluationArtifactReference[];
}

export interface ModelOperation {
  schemaVersion: typeof LIVE_EVALUATION_SCHEMA_VERSION;
  evaluationId: string;
  operationId: string;
  purpose: ModelOperationPurpose;
  parentOperationId?: string;
  sessionId?: string;
  runId?: string;
  laneId?: string;
  iteration?: number;
  attribution: EvaluationAttribution;
  foreground: boolean;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  compilation?: {
    receipt?: EvaluationArtifactReference;
    promptManifest?: EvaluationArtifactReference;
  };
  providerRequestIds: string[];
  terminalOutcome: "running" | "completed" | "failed";
  error?: EvaluationArtifactReference;
}

export interface ProviderTransportAttempt {
  attemptId: string;
  observedAt: string;
  provider: string;
  operation: "countInputTokens" | "generateTurn" | "streamTurn";
  outboundPayload?: EvaluationArtifactReference;
  observable: true;
}

export interface ProviderRequest {
  schemaVersion: typeof LIVE_EVALUATION_SCHEMA_VERSION;
  evaluationId: string;
  requestId: string;
  operationId: string;
  purpose: ModelOperationPurpose;
  sessionId?: string;
  runId?: string;
  laneId?: string;
  iteration?: number;
  attribution: EvaluationAttribution;
  provider: string;
  providerVersion: string;
  invocation: "generateTurn" | "streamTurn";
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  timeToFirstTokenMs?: number;
  streamingDurationMs?: number;
  canonicalRequest: EvaluationArtifactReference;
  providerNativePayloads: ProviderTransportAttempt[];
  providerNativeResponses: EvaluationArtifactReference[];
  observableTransportAttempts: number;
  sdkInternalRetryCount: "not_exposed";
  normalizedResponse?: EvaluationArtifactReference;
  usage?: LlmTokenUsage;
  cost?: LlmCostEstimate;
  parsing?: {
    status: "not_observed" | "accepted" | "repaired" | "failed";
    repairCount?: number;
  };
  outcome: "running" | "completed" | "failed";
  error?: EvaluationArtifactReference;
}

export interface RunEvidenceTotals {
  agentLoopIterations: number;
  logicalModelOperations: number;
  foregroundModelOperations: number;
  backgroundModelOperations: number;
  providerInvocations: number;
  foregroundProviderInvocations: number;
  backgroundProviderInvocations: number;
  observableProviderTransportAttempts: number;
  embeddingOperations: number;
  imageGenerationOperations: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
  costUsd: number;
  wallDurationMs: number;
  foregroundCriticalPathMs: number;
}

export interface RunEvidence {
  schemaVersion: typeof LIVE_EVALUATION_SCHEMA_VERSION;
  evaluationId: string;
  runId: string;
  sessionId?: string;
  startedAt?: string;
  endedAt?: string;
  generatedAt: string;
  input?: EvaluationArtifactReference;
  routing: EvaluationArtifactReference[];
  modelOperations: ModelOperation[];
  providerRequests: ProviderRequest[];
  toolActivity: EvaluationEvent[];
  verification: EvaluationEvent[];
  workStateTransitions: EvaluationEvent[];
  resources: EvaluationEvent[];
  contextEvolution: EvaluationEvent[];
  finalization: EvaluationEvent[];
  terminalResponse?: EvaluationArtifactReference;
  terminalResponseType?: string;
  stopReason?: string;
  acknowledgementAt?: string;
  totals: RunEvidenceTotals;
  criticalPath: Array<{
    component: string;
    event: string;
    startedAt: string;
    durationMs: number;
    evidence: string;
  }>;
  findings: EvaluationFinding[];
}

export type EvaluationFindingSeverity = "info" | "warning" | "error" | "critical";
export type EvaluationFindingConfidence = "low" | "medium" | "high";

export interface EvaluationFinding {
  schemaVersion: typeof LIVE_EVALUATION_SCHEMA_VERSION;
  code: string;
  severity: EvaluationFindingSeverity;
  confidence: EvaluationFindingConfidence;
  runId?: string;
  affectedEvidence: string[];
  likelySubsystem: string;
  observedFact: string;
  diagnosticGuidance: string;
}

export interface EvaluationAnnotation {
  schemaVersion: typeof LIVE_EVALUATION_SCHEMA_VERSION;
  evaluationId: string;
  runId?: string;
  updatedAt: string;
  intendedOutcome?: string;
  observedUsefulness?: string;
  suspectedIssue?: string;
  userFeedback?: string;
  scenarioLabel?: string;
  codingAgentConclusions?: string;
  suggestedExperiments?: string[];
}

export interface EvaluationComparison {
  schemaVersion: typeof LIVE_EVALUATION_SCHEMA_VERSION;
  baselineEvaluationId: string;
  candidateEvaluationId: string;
  generatedAt: string;
  dimensions: {
    correctness: Record<string, unknown>;
    reliability: Record<string, unknown>;
    context: Record<string, unknown>;
    tokenEfficiency: Record<string, unknown>;
    latency: Record<string, unknown>;
    toolBehavior: Record<string, unknown>;
    practicalUsefulness: Record<string, unknown>;
  };
}

export interface EvaluationOperationStart {
  purpose: ModelOperationPurpose;
  parentOperationId?: string;
  runId?: string;
  sessionId?: string;
  laneId?: string;
  iteration?: number;
  attribution?: EvaluationAttribution;
  compilationReceipt?: unknown;
  promptManifest?: unknown;
}

export interface EvaluationProviderRequestStart {
  provider: string;
  providerVersion: string;
  invocation: "generateTurn" | "streamTurn";
  input: LlmTurnInput;
}

export interface EvaluationProviderRequestEnd {
  output?: LlmTurnOutput;
  error?: unknown;
  durationMs: number;
  timeToFirstTokenMs?: number;
  streamingDurationMs?: number;
}

export function isLiveEvaluationSession(value: unknown): value is LiveEvaluationSession {
  const record = asRecord(value);
  return record?.["schemaVersion"] === LIVE_EVALUATION_SCHEMA_VERSION
    && typeof record["evaluationId"] === "string"
    && typeof record["name"] === "string"
    && typeof record["command"] === "string"
    && (record["capture"] === "full" || record["capture"] === "safe")
    && typeof record["evidenceDirectory"] === "string"
    && typeof record["configuredRuntimeRoot"] === "string"
    && isRecordWithString(record["repository"], "root")
    && isRecordWithString(record["runtime"], "provider")
    && isRecordWithString(record["machine"], "nodeVersion")
    && typeof record["startedAt"] === "string"
    && typeof record["status"] === "string"
    && isRecordWithString(record["captureHealth"], "status");
}

export function isEvaluationEvent(value: unknown): value is EvaluationEvent {
  const record = asRecord(value);
  return record?.["schemaVersion"] === LIVE_EVALUATION_SCHEMA_VERSION
    && typeof record["eventId"] === "string"
    && typeof record["evaluationId"] === "string"
    && typeof record["component"] === "string"
    && typeof record["event"] === "string"
    && typeof record["timestamp"] === "string"
    && typeof record["timestampMs"] === "number"
    && typeof record["monotonicNs"] === "string"
    && isEvaluationAttribution(record["attribution"])
    && Array.isArray(record["artifacts"])
    && record["artifacts"].every(isEvaluationArtifactReference);
}

export function isProviderRequest(value: unknown): value is ProviderRequest {
  const record = asRecord(value);
  return record?.["schemaVersion"] === LIVE_EVALUATION_SCHEMA_VERSION
    && typeof record["requestId"] === "string"
    && typeof record["operationId"] === "string"
    && typeof record["purpose"] === "string"
    && isEvaluationAttribution(record["attribution"])
    && typeof record["provider"] === "string"
    && typeof record["providerVersion"] === "string"
    && (record["invocation"] === "generateTurn" || record["invocation"] === "streamTurn")
    && typeof record["startedAt"] === "string"
    && isEvaluationArtifactReference(record["canonicalRequest"])
    && Array.isArray(record["providerNativePayloads"])
    && Array.isArray(record["providerNativeResponses"])
    && typeof record["observableTransportAttempts"] === "number"
    && record["sdkInternalRetryCount"] === "not_exposed"
    && typeof record["outcome"] === "string";
}

export function isModelOperation(value: unknown): value is ModelOperation {
  const record = asRecord(value);
  return record?.["schemaVersion"] === LIVE_EVALUATION_SCHEMA_VERSION
    && typeof record["evaluationId"] === "string"
    && typeof record["operationId"] === "string"
    && typeof record["purpose"] === "string"
    && isEvaluationAttribution(record["attribution"])
    && typeof record["foreground"] === "boolean"
    && typeof record["startedAt"] === "string"
    && Array.isArray(record["providerRequestIds"])
    && typeof record["terminalOutcome"] === "string";
}

export function isEvaluationFinding(value: unknown): value is EvaluationFinding {
  const record = asRecord(value);
  return record?.["schemaVersion"] === LIVE_EVALUATION_SCHEMA_VERSION
    && typeof record["code"] === "string"
    && typeof record["severity"] === "string"
    && typeof record["confidence"] === "string"
    && Array.isArray(record["affectedEvidence"])
    && typeof record["likelySubsystem"] === "string"
    && typeof record["observedFact"] === "string"
    && typeof record["diagnosticGuidance"] === "string";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isEvaluationArtifactReference(value: unknown): value is EvaluationArtifactReference {
  const record = asRecord(value);
  return typeof record?.["artifactId"] === "string"
    && typeof record["sha256"] === "string"
    && typeof record["path"] === "string"
    && typeof record["kind"] === "string"
    && typeof record["mediaType"] === "string"
    && typeof record["sizeBytes"] === "number"
    && (record["capture"] === "full" || record["capture"] === "safe");
}

function isEvaluationAttribution(value: unknown): value is EvaluationAttribution {
  return value === "foreground" || value === "descendant_background" || value === "background_unattributed";
}

function isRecordWithString(value: unknown, key: string): boolean {
  return typeof asRecord(value)?.[key] === "string";
}
