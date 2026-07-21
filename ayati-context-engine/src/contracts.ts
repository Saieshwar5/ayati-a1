import { RUN_FINALIZATION_LIMITS } from "./run-finalization-limits.js";

export type AgentStreamId = string;
export type WorkstreamId = string;
export type RunId = string;

export type MessageRole = "user" | "assistant" | "system_event";

export type RunOutcome =
  | "done"
  | "incomplete"
  | "failed"
  | "blocked"
  | "needs_user_input";

export type RunStatus = "running" | RunOutcome | "recovery_required";

export type RunStopReason =
  | "completed"
  | "run_limit"
  | "context_limit"
  | "failed"
  | "blocked"
  | "needs_user_input"
  | "interrupted";

export type ContextEngineCapability =
  | "health"
  | "agent_context"
  | "agent_streams"
  | "checkpoints"
  | "history"
  | "observations"
  | "runs"
  | "workstreams"
  | "workstream_resolution"
  | "resources"
  | "mutations"
  | "recovery";

export interface ContextEngineRequestEnvelope {
  requestId: string;
}

export interface AgentStreamRef {
  streamId: AgentStreamId;
  agentId: string;
  scopeKey: string;
  lastMessageSequence: number;
  lastRunSequence: number;
  activeCheckpointId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkstreamRef {
  workstreamId: WorkstreamId;
  contextRepositoryPath: string;
  branch: string;
  head: string;
}

export type WorkstreamStatus = "initializing" | "active" | "archived";

export interface WorkstreamCatalogEntry extends WorkstreamRef {
  title: string;
  objective: string;
  status: WorkstreamStatus;
  createdByRunId?: RunId;
  createdAt: string;
  updatedAt: string;
}

export type ResourceId = string;

export type ResourceKind =
  | "file"
  | "directory"
  | "document"
  | "image"
  | "audio"
  | "video"
  | "dataset"
  | "database"
  | "git_repository"
  | "url"
  | "external_object";

export type ResourceOrigin =
  | "user_attachment"
  | "user_reference"
  | "agent_created"
  | "agent_discovered"
  | "agent_download";

export type ResourceRole =
  | "input"
  | "reference"
  | "primary"
  | "supporting"
  | "output"
  | "deliverable"
  | "evidence"
  | "asset";

export type ResourceAvailability =
  | "available"
  | "missing"
  | "changed"
  | "deleted"
  | "unverified";

export type ResourceMetadataStatus = "fallback" | "enriched" | "stale";

export type ResourcePublicLocator =
  | { kind: "filesystem"; path: string }
  | { kind: "managed_blob"; resourceId: ResourceId }
  | { kind: "url"; url: string }
  | { kind: "external"; provider: string; externalId: string; uri?: string };

export interface ResourceVersion {
  key: string;
  observedAt: string;
  exists: boolean;
  kind: "file" | "directory" | "git" | "url" | "external" | "unversioned";
  sha256?: string;
  sizeBytes?: number;
  modifiedAt?: string;
  fingerprint?: string;
  entryCount?: number;
  head?: string;
  dirty?: boolean;
  etag?: string;
  lastModified?: string;
  externalVersion?: string;
}

export interface ResourceRef {
  resourceId: ResourceId;
  kind: ResourceKind;
  origin: ResourceOrigin;
  displayName: string;
  description: string;
  aliases: string[];
  locator: ResourcePublicLocator;
  version: ResourceVersion;
  availability: ResourceAvailability;
  metadataStatus: ResourceMetadataStatus;
  describedVersionKey?: string;
  mediaType?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ResourceAdmission {
  admissionId: string;
  kind: ResourceKind;
  origin: ResourceOrigin;
  locator: ResourcePublicLocator;
  displayName: string;
  description?: string;
  aliases?: string[];
  role: "attachment" | "reference";
  /** Optional caller observation. The service always records its own authoritative observation. */
  version?: ResourceVersion;
  mediaType?: string;
}

export interface WorkstreamResourceBinding {
  resource: ResourceRef;
  role: ResourceRole;
  access: "read" | "mutate";
  primary: boolean;
  requestIds: string[];
  boundAt: string;
  lastUsedAt?: string;
}

export interface WorkstreamBinding {
  workstreamId: WorkstreamId;
  requestId: string;
  boundAt: string;
}

export interface RunRef {
  runId: RunId;
  streamId: AgentStreamId;
  workstreamBinding?: WorkstreamBinding;
}

export interface AgentRunHandle {
  runId: RunId;
  streamId: AgentStreamId;
  triggerSeq: number;
}

export interface StreamMessage {
  messageId: string;
  streamId: AgentStreamId;
  runId: RunId;
  sequence: number;
  role: MessageRole;
  content: string;
  contentHash: string;
  at: string;
}

export interface CommitSummary {
  commit: string;
  subject: string;
  committedAt?: string;
  message?: string;
  streamSummary?: string;
  workSummary?: string;
  outcome?: string;
  validation?: string;
  workstreamId?: string;
  requestId?: string;
  event?: "workstream_created" | "workstream_repository_migrated" | "workstream_bound_run_finalized";
  runId?: string;
  streamId?: string;
  workstreamTitle?: string;
  workstreamState?: string;
  workstreamStatus?: "in_progress" | "done" | "blocked";
  next?: string;
  stateVersion?: number;
  assets?: Array<{
    path: string;
    description: string;
  }>;
}

export type ToolPurpose = "list" | "read" | "search" | "control" | "mutation";

export type ToolEffect =
  | "read_only"
  | "workspace_mutation"
  | "context_mutation"
  | "external_mutation"
  | "destructive";

export interface RunStepToolCall {
  callId?: string;
  tool: string;
  purpose: string;
  toolPurpose: ToolPurpose;
  toolEffect: ToolEffect;
  status: "success" | "failed";
  input: unknown;
  output?: unknown;
  outputHash?: string;
  error?: unknown;
}

export type RunWorkStatus = "not_done" | "done" | "blocked" | "needs_user_input";

export interface RunWorkStateInput {
  status: RunWorkStatus;
  summary: string;
  openWork: string[];
  blockers: string[];
  facts: string[];
  evidence: string[];
  artifacts: string[];
  nextStep: string | null;
  userInputNeeded: string[];
}

export interface RunWorkState extends RunWorkStateInput {
  runId: RunId;
  revision: number;
  afterStep: number;
  updatedAt: string;
}

export interface RunStepRecord {
  version: 1;
  step: number;
  status: "completed" | "failed" | "blocked";
  summary: string;
  decision?: unknown;
  action?: unknown;
  toolCalls: RunStepToolCall[];
  verification: unknown;
  workStateAfter: RunWorkStateInput;
  createdAt: string;
}

export type RunStepContext = Omit<RunStepRecord, "workStateAfter">;

export interface RunContextRecord extends RunRef {
  status: RunStatus;
  stopReason?: RunStopReason;
  trigger: "user" | "system_event";
  startedAt: string;
  completedAt?: string;
  stepCount: number;
}

export interface ContextCheckpointStatement {
  seq: number;
  text: string;
}

export interface ContextCheckpointSummary {
  userRequests: ContextCheckpointStatement[];
  constraints: ContextCheckpointStatement[];
  decisions: ContextCheckpointStatement[];
  corrections: ContextCheckpointStatement[];
  importantFacts: ContextCheckpointStatement[];
  unresolvedQuestions: ContextCheckpointStatement[];
  references: ContextCheckpointStatement[];
  narrative: string;
}

export interface ContextCheckpointRecord {
  checkpointId: string;
  streamId: AgentStreamId;
  previousCheckpointId?: string;
  coveredFromSeq: number;
  coveredToSeq: number;
  sourceHash: string;
  schemaVersion: 1;
  summary: ContextCheckpointSummary;
  exactAnchors: number[];
  tokenCount: number;
  reason: "context_pressure";
  provider: string;
  model: string;
  createdAt: string;
}

export interface RecentWorkReference {
  workstreamId: WorkstreamId;
  requestId: string;
  outcome: RunOutcome;
  resourceIds: ResourceId[];
  completedAt: string;
}

export interface AgentStreamContextProjection {
  stream: AgentStreamRef;
  checkpoint?: ContextCheckpointRecord;
  recentMessages: StreamMessage[];
  recentWork: RecentWorkReference[];
  resources?: AgentStreamResourcesProjection;
}

export interface AgentStreamResourcesProjection {
  count: number;
  recent: ResourceRef[];
  updatedAt?: string;
}

export interface WorkstreamContextProjection {
  workstream: WorkstreamRef;
  title: string;
  objective: string;
  summary: string;
  recentCommits: CommitSummary[];
  latestOutcome?: string;
  validation?: string;
  workstreamStatus?: "in_progress" | "done" | "blocked";
  next?: string;
  schemaVersion?: "ayati.workstream/v2";
  lifecycleStatus?: "active" | "paused" | "archived";
  repositoryHealth?: "ready" | "dirty_external";
  currentFocus?: string;
  blockers?: string[];
  currentRequest?: {
    id: string;
    title: string;
    status: "queued" | "active" | "blocked" | "done" | "dropped";
    request: string;
    acceptance: string[];
    constraints: string[];
  };
  resources?: WorkstreamResourceBinding[];
}

export type WorkstreamDiscoveryReason =
  | "exact_workstream_id"
  | "exact_resource_id"
  | "exact_title"
  | "owned_resource"
  | "direct_continuation"
  | "matching_request"
  | "resource_match"
  | "text_match"
  | "unfinished_request"
  | "starred"
  | "recent"
  | "frequent";

export type WorkstreamDiscoveryTier = "definite" | "probable" | "candidate";

export type WorkstreamDiscoveryView =
  | "relevant"
  | "unfinished"
  | "starred"
  | "recent"
  | "frequent";

export interface WorkstreamCandidate {
  workstreamId: WorkstreamId;
  title: string;
  objective: string;
  status: WorkstreamStatus;
  lifecycleStatus?: "active" | "paused" | "archived";
  repositoryHealth?: "ready" | "dirty_external" | "unavailable";
  currentRequest?: {
    id: string;
    title: string;
    status: "queued" | "active" | "blocked" | "done" | "dropped";
  };
  head: string;
  primaryResources: ResourceRef[];
  updatedAt: string;
  discovery: {
    tier: WorkstreamDiscoveryTier;
    reasons: WorkstreamDiscoveryReason[];
  };
  starred: boolean;
  lastOpenedAt?: string;
  boundRunsLast30Days: number;
}

export type WorkstreamResolutionHint =
  | { kind: "workstream_id"; workstreamId: WorkstreamId }
  | { kind: "resource_id"; resourceId: ResourceId }
  | { kind: "filesystem"; path: string }
  | { kind: "url"; url: string };

export type WorkstreamResolutionStatus =
  | "running"
  | "resolved"
  | "needs_user_input"
  | "failed"
  | "interrupted";

export type WorkstreamResolutionKind =
  | "continued_request"
  | "created_request"
  | "created_workstream";

export interface WorkstreamResolutionLimits {
  maxTurns: number;
  maxToolCalls: number;
  maxParallelCalls: number;
}

export interface WorkstreamResolutionInput {
  purpose: string;
  currentInput: string;
  hints: WorkstreamResolutionHint[];
  limits: WorkstreamResolutionLimits;
}

export interface WorkstreamResolutionUsage {
  provider?: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
  costUsd?: number;
}

export interface WorkstreamResolutionStepRecord {
  version: 1;
  step: number;
  status: "completed" | "failed";
  context: unknown;
  decision: unknown;
  toolCalls: unknown[];
  verification: unknown;
  stateAfter: unknown;
  usage?: WorkstreamResolutionUsage;
  createdAt: string;
}

export interface WorkstreamResolutionActivity {
  activityId: string;
  runId: RunId;
  streamId: AgentStreamId;
  priorActivityId?: string;
  status: WorkstreamResolutionStatus;
  input: WorkstreamResolutionInput;
  inputContextRevision: string;
  outputContextRevision?: string;
  stepCount: number;
  toolCallCount: number;
  usage: WorkstreamResolutionUsage;
  finalState?: unknown;
  result?: WorkstreamResolutionResult;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
}

export type WorkstreamResolutionResult =
  | {
      status: "resolved";
      kind: WorkstreamResolutionKind;
      workstreamId: WorkstreamId;
      requestId: string;
    }
  | {
      status: "needs_user_input";
      reasonCodes: string[];
      question: string;
      candidates: WorkstreamCandidate[];
    }
  | {
      status: "failed" | "interrupted";
      code: string;
      message: string;
      retryable: boolean;
    };

/** Compact activity lane mounted into the authoritative agent context. */
export interface WorkstreamResolutionProjection {
  activityId: string;
  runId: RunId;
  status: Exclude<WorkstreamResolutionStatus, "running"> | "running";
  purpose: string;
  stepCount: number;
  result?: WorkstreamResolutionResult;
  updatedAt: string;
}

export interface RunContextProjection {
  run: RunContextRecord;
  workState: RunWorkState;
  steps: RunStepContext[];
}

export type ReusableObservationKind = "inventory" | "discovery" | "evidence";

export interface ReusableObservation {
  observationId: string;
  streamId: AgentStreamId;
  sourceRunId: RunId;
  sourceStep: number;
  sourceCallId?: string;
  kind: ReusableObservationKind;
  queryKey: string;
  purpose: string;
  preview: string;
  outputHash?: string;
  evidenceRef?: string;
  retention: "while_relevant" | "evidence_only";
  workstreamId?: WorkstreamId;
  requestId?: string;
  resources: Array<{ resourceId: ResourceId; versionKey: string }>;
  createdAt: string;
}

export interface ReusableObservationProjection {
  revision: string;
  inventory: ReusableObservation[];
  discovery: ReusableObservation[];
  evidence: ReusableObservation[];
}

export interface AgentContextProjection {
  contextRevision: string;
  streamRevision: string;
  runRevision?: string;
  observationRevision: string;
  stream: AgentStreamContextProjection | null;
  activeWorkstream?: WorkstreamContextProjection;
  workstreamCandidates?: WorkstreamCandidate[];
  workstreamResolution?: WorkstreamResolutionProjection;
  ingressResources?: ResourceRef[];
  run?: RunContextProjection;
  observations: ReusableObservationProjection;
  warnings: string[];
}

export interface ContextEngineHealth {
  service: "ayati-context-engine";
  status: "ok" | "degraded";
  ready: boolean;
  capabilities: ContextEngineCapability[];
}

export interface GetAgentContextRequest {
  streamId?: AgentStreamId;
  agentId?: string;
  scopeKey?: string;
  /** Optional current ingress text used only to rank the bounded workstream candidate projection. */
  currentText?: string;
}

export interface PrepareAgentRunRequest extends ContextEngineRequestEnvelope {
  timezone: string;
  agentId: string;
  scopeKey?: string;
  role: "user" | "system_event";
  content: string;
  resources?: ResourceAdmission[];
  at: string;
}

export interface PrepareAgentRunResponse {
  stream: AgentStreamRef;
  streamCreated: boolean;
  message: StreamMessage;
  run: RunRef;
  context: AgentContextProjection;
}

export interface ListWorkstreamsRequest {
  query?: string;
  limit?: number;
}

export interface ListWorkstreamsResponse {
  workstreams: WorkstreamCandidate[];
}

export interface FindWorkstreamsRequest {
  query?: string;
  paths?: string[];
  view?: WorkstreamDiscoveryView;
  includeArchived?: boolean;
  limit?: number;
  /** Enables direct-continuation discovery for the current agent stream. */
  streamId?: AgentStreamId;
  /** Current ingress text. It is used only for deterministic candidate discovery. */
  currentText?: string;
}

export interface FindWorkstreamsResponse {
  workstreams: WorkstreamCandidate[];
}

export interface GetWorkstreamRequest {
  workstreamId: WorkstreamId;
}

export interface GetWorkstreamResponse {
  workstream: WorkstreamCatalogEntry;
  /** Durable workstream context. */
  context?: WorkstreamContextProjection;
}

export interface ReadWorkstreamRequest extends ContextEngineRequestEnvelope {
  runId: RunId;
  workstreamId: WorkstreamId;
  at: string;
}

export interface ReadWorkstreamResponse extends GetWorkstreamResponse {
  opened: true;
}

export interface SetWorkstreamStarRequest extends ContextEngineRequestEnvelope {
  runId: RunId;
  workstreamId: WorkstreamId;
  starred: boolean;
  at: string;
}

export interface SetWorkstreamStarResponse {
  workstreamId: WorkstreamId;
  starred: boolean;
  starredAt?: string;
}

export interface SelectWorkstreamForRunInput {
  runId: RunId;
  at: string;
}

export interface CreateWorkstreamForRunRequest extends ContextEngineRequestEnvelope, SelectWorkstreamForRunInput {
  title: string;
  objective: string;
  initialRequest?: {
    title: string;
    request: string;
    acceptance: string[];
    constraints: string[];
  };
  resources?: Array<{
    resourceId: ResourceId;
    role: ResourceRole;
    access: "read" | "mutate";
    primary?: boolean;
  }>;
}

export interface ActivateWorkstreamForRunRequest extends ContextEngineRequestEnvelope, SelectWorkstreamForRunInput {
  workstreamId: WorkstreamId;
  expectedWorkstreamHead?: string;
  /** Explicitly continue the active request or create a new request in this workstream. */
  route: WorkstreamRequestRoute;
}

export type WorkstreamRequestRoute =
  | {
      kind: "continue_active_request";
      requestId: string;
      reason: string;
    }
  | {
      kind: "create_active_request";
      reason: string;
      title: string;
      request: string;
      acceptance: string[];
      constraints: string[];
    };

export type WorkstreamRequestRoutePlanPhase =
  | "planned"
  | "committed"
  | "discarded"
  | "recovery_required";

export interface PlanWorkstreamRequestRouteRequest extends ContextEngineRequestEnvelope {
  runId: RunId;
  workstreamId: WorkstreamId;
  expectedWorkstreamHead: string;
  route: WorkstreamRequestRoute;
  at: string;
}

export interface PlanWorkstreamRequestRouteResponse {
  run: RunRef;
  workstreamId: WorkstreamId;
  boundRequestId: string;
  baseHead: string;
  phase: WorkstreamRequestRoutePlanPhase;
  requestCreated: boolean;
}

export interface SelectedWorkstreamForRunResponse {
  workstream: WorkstreamCatalogEntry;
  run: RunRef;
  context: WorkstreamContextProjection;
  workstreamCreated: boolean;
  workstreamRequestDecision: "initial" | "continue" | "create";
  workstreamRequestStatus: "queued" | "active" | "blocked" | "done" | "dropped";
  workstreamRequestCreated: boolean;
  headBeforeSelection: string;
  resourceBindings: WorkstreamResourceBinding[];
}

export interface StartWorkstreamResolutionRequest extends ContextEngineRequestEnvelope {
  runId: RunId;
  streamId: AgentStreamId;
  input: WorkstreamResolutionInput;
  inputContextRevision: string;
  priorActivityId?: string;
  at: string;
}

export interface StartWorkstreamResolutionResponse {
  activity: WorkstreamResolutionActivity;
  context: AgentContextProjection;
}

export interface RecordWorkstreamResolutionStepRequest extends ContextEngineRequestEnvelope {
  activityId: string;
  record: WorkstreamResolutionStepRecord;
}

export interface RecordWorkstreamResolutionStepResponse {
  activity: WorkstreamResolutionActivity;
}

export type WorkstreamResolutionCommit =
  | {
      kind: "activate";
      workstreamId: WorkstreamId;
      expectedWorkstreamHead: string;
      route: WorkstreamRequestRoute;
      evidence: string[];
    }
  | {
      kind: "create";
      title: string;
      objective: string;
      initialRequest: {
        title: string;
        request: string;
        acceptance: string[];
        constraints: string[];
      };
      resources?: CreateWorkstreamForRunRequest["resources"];
      evidence: string[];
    };

export interface CommitWorkstreamResolutionRequest extends ContextEngineRequestEnvelope {
  activityId: string;
  runId: RunId;
  commit: WorkstreamResolutionCommit;
  finalState: unknown;
  at: string;
}

export interface CommitWorkstreamResolutionResponse {
  activity: WorkstreamResolutionActivity;
  receipt: Extract<WorkstreamResolutionResult, { status: "resolved" }>;
  selected: SelectedWorkstreamForRunResponse;
  context: AgentContextProjection;
}

export interface FinishWorkstreamResolutionRequest extends ContextEngineRequestEnvelope {
  activityId: string;
  runId: RunId;
  result:
    | Extract<WorkstreamResolutionResult, { status: "needs_user_input" }>
    | Extract<WorkstreamResolutionResult, { status: "failed" | "interrupted" }>;
  finalState: unknown;
  at: string;
}

export interface FinishWorkstreamResolutionResponse {
  activity: WorkstreamResolutionActivity;
  context: AgentContextProjection;
}

export interface GetWorkstreamResolutionRequest {
  activityId: string;
}

export interface GetWorkstreamResolutionResponse {
  activity: WorkstreamResolutionActivity;
  steps: WorkstreamResolutionStepRecord[];
}

export interface FindResourcesRequest {
  query?: string;
  resourceIds?: ResourceId[];
  locators?: string[];
  workstreamId?: WorkstreamId;
  includeMissing?: boolean;
  limit?: number;
}

export interface FindResourcesResponse {
  resources: Array<{
    resource: ResourceRef;
    workstreamIds: WorkstreamId[];
    roles: ResourceRole[];
    lastUsedAt?: string;
  }>;
}

export interface InspectResourceForRunRequest extends ContextEngineRequestEnvelope {
  runId: RunId;
  locator: ResourcePublicLocator;
  kind?: ResourceKind;
  origin: Extract<ResourceOrigin, "user_reference" | "agent_discovered">;
  displayName?: string;
  description?: string;
  aliases?: string[];
  at: string;
}

export interface InspectResourceForRunResponse {
  resource: ResourceRef;
  existing: boolean;
  mutationEligible: boolean;
  warnings: string[];
}

export interface BindResourcesForRunRequest extends ContextEngineRequestEnvelope {
  runId: RunId;
  workstreamId: WorkstreamId;
  bindings: Array<{
    resourceId: ResourceId;
    role: ResourceRole;
    access: "read" | "mutate";
    primary?: boolean;
  }>;
  at: string;
}

export interface BindResourcesForRunResponse {
  workstreamId: WorkstreamId;
  runId: RunId;
  bindings: WorkstreamResourceBinding[];
}

export type ResourceMutationEffect =
  | "workspace_mutation"
  | "external_mutation"
  | "destructive";

export interface ResourceMutationTarget {
  resourceId: ResourceId;
  relativePath?: string;
  kind: "file" | "directory";
  expectedVersionKey?: string;
}

export interface PrepareResourceMutationRequest extends ContextEngineRequestEnvelope {
  runId: RunId;
  workstreamId: WorkstreamId;
  activeRequestId: string;
  callId: string;
  tool: string;
  effect: ResourceMutationEffect;
  targets: ResourceMutationTarget[];
  at: string;
}

export interface PrepareResourceMutationResponse {
  leaseId: string;
  operationId: string;
  lockToken: string;
  targets: Array<ResourceMutationTarget & { resolvedPath?: string }>;
  expiresAt: string;
}

export interface VerifyResourceMutationRequest extends ContextEngineRequestEnvelope {
  operationId: string;
  leaseId: string;
  lockToken: string;
  toolStatus: "completed" | "failed";
  at: string;
}

export interface VerifyResourceMutationResponse {
  leaseId: string;
  operationId: string;
  status: "verified" | "no_change" | "recovery_required";
  verified: boolean;
  events: ResourceEvent[];
}

export interface WorkstreamCompletionRecord {
  accepted: boolean;
  resources: Array<{
    resourceId?: ResourceId;
    locator?: ResourcePublicLocator;
    kind: ResourceKind;
    role: Extract<ResourceRole, "output" | "deliverable" | "evidence" | "asset">;
    description: string;
    aliases: string[];
    verified: boolean;
  }>;
  missing: string[];
  failures: string[];
  criteria: Array<{
    criterion: string;
    passed: boolean;
    evidence?: string;
  }>;
}

export type ResourceEventType =
  | "registered"
  | "linked"
  | "observed"
  | "created"
  | "modified"
  | "moved"
  | "deleted"
  | "missing"
  | "restored"
  | "downloaded"
  | "uploaded"
  | "delivered"
  | "external_state_changed";

export interface ResourceEvent {
  eventId: string;
  resourceId: ResourceId;
  workstreamId?: WorkstreamId;
  requestId?: string;
  runId: RunId;
  step?: number;
  callId?: string;
  type: ResourceEventType;
  beforeVersion?: ResourceVersion;
  afterVersion?: ResourceVersion;
  verification: unknown;
  summary: string;
  at: string;
}

export interface FinalizeRunRequest extends ContextEngineRequestEnvelope {
  runId: RunId;
  outcome: RunOutcome;
  stopReason: RunStopReason;
  assistantResponse: string;
  streamSummary: string;
  summary: string;
  validation: "passed" | "failed" | "not_applicable";
  next?: string;
  workState: RunWorkStateInput;
  workstream?: {
    completion: WorkstreamCompletionRecord;
  };
  at: string;
}

export interface FinalizeRunResponse {
  run: RunContextRecord;
  assistantMessage?: StreamMessage;
  observationRevision: string;
  resourceEffects: {
    status: "none" | "verified";
    events: Array<Pick<ResourceEvent, "eventId" | "resourceId" | "type"> & {
      afterVersionKey?: string;
    }>;
  };
  workstreamContextCommit:
    | { status: "not_required" }
    | {
        status: "no_change" | "committed";
        workstreamId: WorkstreamId;
        requestId: string;
        headBefore: string;
        headAfter: string;
        commit?: string;
      };
}

export interface RecordRunStepRequest extends ContextEngineRequestEnvelope {
  runId: RunId;
  record: RunStepRecord;
}

export interface RecordRunStepResponse {
  run: RunContextProjection;
  context: AgentContextProjection;
}

export interface PlanContextCheckpointRequest extends ContextEngineRequestEnvelope {
  streamId: AgentStreamId;
  protectFromSeq: number;
  requiredSavingsTokens: number;
  estimatedCheckpointTokens?: number;
  at: string;
}

export interface ContextCheckpointPlan {
  planId: string;
  streamId: AgentStreamId;
  previousCheckpoint?: ContextCheckpointRecord;
  selectedMessages: StreamMessage[];
  exactTail: StreamMessage[];
  coveredFromSeq?: number;
  coveredToSeq?: number;
  sourceHash?: string;
  estimatedCheckpointTokens: number;
  triggered: boolean;
}

export interface CommitContextCheckpointRequest extends ContextEngineRequestEnvelope {
  plan: ContextCheckpointPlan;
  summary: ContextCheckpointSummary;
  tokenCount: number;
  provider: string;
  model: string;
  at: string;
}

export interface CommitContextCheckpointResponse {
  checkpoint: ContextCheckpointRecord;
  context: AgentContextProjection;
}

export type AgentHistoryKind = "message" | "run" | "evidence";

export interface SearchAgentHistoryRequest {
  streamId: AgentStreamId;
  query: string;
  kinds?: AgentHistoryKind[];
  limit?: number;
}

export interface AgentHistoryHit {
  ref: string;
  kind: AgentHistoryKind;
  at: string;
  preview: string;
  sequence?: number;
  role?: MessageRole;
  workstreamId?: WorkstreamId;
  resourceIds: ResourceId[];
}

export interface SearchAgentHistoryResponse {
  hits: AgentHistoryHit[];
}

export type ReadAgentHistoryRequest =
  | { streamId: AgentStreamId; ref: string; maxChars?: number; offsetChars?: number }
  | { streamId: AgentStreamId; fromSeq: number; toSeq: number; maxChars?: number };

export interface ReadAgentHistoryResponse {
  messages: StreamMessage[];
  evidence?: {
    ref: string;
    content: string;
    offsetChars: number;
    totalChars: number;
    sha256: string;
  };
  truncated: boolean;
  continuationFromSeq?: number;
  continuationRef?: string;
  continuationOffsetChars?: number;
}

export function isRequestEnvelope(
  value: unknown,
): value is ContextEngineRequestEnvelope & Record<string, unknown> {
  if (!isRecord(value) || !isNonEmptyString(value["requestId"])) {
    return false;
  }
  return value["expectedHead"] === undefined
    && value["date"] === undefined
    && value["sessionId"] === undefined
    && value["conversationId"] === undefined;
}

export function isPrepareAgentRunRequest(value: unknown): value is PrepareAgentRunRequest {
  if (!isRequestEnvelope(value)) {
    return false;
  }
  return isNonEmptyString(value["timezone"])
    && isNonEmptyString(value["agentId"])
    && optionalBoundedString(value["scopeKey"], 200)
    && (value["role"] === "user" || value["role"] === "system_event")
    && isNonEmptyString(value["content"])
    && (value["resources"] === undefined
      || (Array.isArray(value["resources"])
        && value["resources"].length <= 64
        && value["resources"].every(isResourceAdmission)))
    && isNonEmptyString(value["at"]);
}

function isCreateWorkstreamInput(value: unknown): value is ContextEngineRequestEnvelope & Record<string, unknown> {
  if (!isRequestEnvelope(value)) {
    return false;
  }
  return isBoundedString(value["title"], 120)
    && isBoundedString(value["objective"], 2_000)
    && (value["resources"] === undefined
      || (Array.isArray(value["resources"])
        && value["resources"].length <= 64
        && value["resources"].every(isResourceBindingInput)))
    && value["placement"] === undefined
    && value["workingDirectory"] === undefined
    && value["repositoryPath"] === undefined
    && isNonEmptyString(value["at"]);
}

export function isCreateWorkstreamForRunRequest(value: unknown): value is CreateWorkstreamForRunRequest {
  return isCreateWorkstreamInput(value)
    && isWorkstreamForRunSelection(value as unknown as Record<string, unknown>);
}

export function isReadWorkstreamRequest(value: unknown): value is ReadWorkstreamRequest {
  return isRequestEnvelope(value)
    && isNonEmptyString(value["runId"])
    && /^W-\d{8}-\d{4}$/.test(String(value["workstreamId"] ?? ""))
    && isNonEmptyString(value["at"]);
}

export function isSetWorkstreamStarRequest(value: unknown): value is SetWorkstreamStarRequest {
  return isRequestEnvelope(value)
    && isNonEmptyString(value["runId"])
    && /^W-\d{8}-\d{4}$/.test(String(value["workstreamId"] ?? ""))
    && typeof value["starred"] === "boolean"
    && isNonEmptyString(value["at"]);
}

export function isActivateWorkstreamForRunRequest(value: unknown): value is ActivateWorkstreamForRunRequest {
  if (!isRequestEnvelope(value)) {
    return false;
  }
  const workstreamId = String(value["workstreamId"] ?? "");
  return /^W-\d{8}-\d{4}$/.test(workstreamId)
    && (value["expectedWorkstreamHead"] === undefined
      || /^[a-f0-9]{40}$/.test(String(value["expectedWorkstreamHead"])))
    && isWorkstreamRequestRoute(value["route"])
    && isWorkstreamForRunSelection(value);
}

export function isPlanWorkstreamRequestRouteRequest(
  value: unknown,
): value is PlanWorkstreamRequestRouteRequest {
  if (!isRequestEnvelope(value) || !isWorkstreamRequestRoute(value["route"])) {
    return false;
  }
  const common = isNonEmptyString(value["runId"])
    && /^W-\d{8}-\d{4}$/.test(String(value["workstreamId"] ?? ""))
    && /^[a-f0-9]{40}$/.test(String(value["expectedWorkstreamHead"] ?? ""))
    && isNonEmptyString(value["at"]);
  if (!common) return false;
  return true;
}

function isWorkstreamRequestRoute(value: unknown): value is WorkstreamRequestRoute {
  if (!isRecord(value) || !isBoundedString(value["reason"], 500)) return false;
  const route = value;
  if (route["kind"] === "continue_active_request") {
    return /^R-\d{4}$/.test(String(route["requestId"] ?? ""));
  }
  return route["kind"] === "create_active_request"
    && isBoundedString(route["title"], 120)
    && isBoundedString(route["request"], 2_000)
    && isBoundedStringArray(route["acceptance"], 50, 500)
    && isBoundedStringArray(route["constraints"], 50, 500);
}

export function isInspectResourceForRunRequest(
  value: unknown,
): value is InspectResourceForRunRequest {
  return isRequestEnvelope(value)
    && isNonEmptyString(value["runId"])
    && isResourceLocator(value["locator"])
    && (value["kind"] === undefined || isResourceKind(value["kind"]))
    && (value["origin"] === "user_reference" || value["origin"] === "agent_discovered")
    && optionalBoundedString(value["displayName"], 500)
    && optionalBoundedString(value["description"], 2_000)
    && (value["aliases"] === undefined
      || isBoundedStringArray(value["aliases"], 32, 500))
    && isNonEmptyString(value["at"]);
}

export function isBindResourcesForRunRequest(
  value: unknown,
): value is BindResourcesForRunRequest {
  return isRequestEnvelope(value)
    && isNonEmptyString(value["runId"])
    && /^W-\d{8}-\d{4}$/.test(String(value["workstreamId"] ?? ""))
    && Array.isArray(value["bindings"])
    && value["bindings"].length > 0
    && value["bindings"].length <= 64
    && value["bindings"].every(isResourceBindingInput)
    && isNonEmptyString(value["at"]);
}

export function isPrepareResourceMutationRequest(
  value: unknown,
): value is PrepareResourceMutationRequest {
  return isRequestEnvelope(value)
    && isNonEmptyString(value["runId"])
    && /^W-\d{8}-\d{4}$/.test(String(value["workstreamId"] ?? ""))
    && /^R-\d{4}$/.test(String(value["activeRequestId"] ?? ""))
    && isBoundedString(value["callId"], 200)
    && isBoundedString(value["tool"], 200)
    && (value["effect"] === "workspace_mutation"
      || value["effect"] === "external_mutation"
      || value["effect"] === "destructive")
    && Array.isArray(value["targets"])
    && value["targets"].length > 0
    && value["targets"].length <= 64
    && value["targets"].every(isResourceMutationTarget)
    && isNonEmptyString(value["at"]);
}

export function isVerifyResourceMutationRequest(
  value: unknown,
): value is VerifyResourceMutationRequest {
  return isRequestEnvelope(value)
    && isNonEmptyString(value["operationId"])
    && isNonEmptyString(value["leaseId"])
    && isNonEmptyString(value["lockToken"])
    && (value["toolStatus"] === "completed" || value["toolStatus"] === "failed")
    && isNonEmptyString(value["at"]);
}

export function isFinalizeRunRequest(value: unknown): value is FinalizeRunRequest {
  if (!isRequestEnvelope(value)) {
    return false;
  }
  const assistantResponseValid = isNonEmptyString(value["assistantResponse"])
    || (value["outcome"] === "incomplete"
      && value["stopReason"] === "interrupted"
      && value["assistantResponse"] === "");
  const workstream = value["workstream"];
  const workstreamValid = workstream === undefined
    || (isRecord(workstream)
      && isWorkstreamCompletionRecord(workstream["completion"])
      && (value["outcome"] !== "done" || workstream["completion"].accepted));
  return isNonEmptyString(value["runId"])
    && isRunOutcome(value["outcome"])
    && isRunStopReason(value["stopReason"])
    && isTruthfulTerminalPair(value["outcome"], value["stopReason"])
    && assistantResponseValid
    && isBoundedString(
      value["streamSummary"],
      RUN_FINALIZATION_LIMITS.streamSummaryChars,
    )
    && isBoundedString(value["summary"], RUN_FINALIZATION_LIMITS.summaryChars)
    && (value["validation"] === "passed"
      || value["validation"] === "failed"
      || value["validation"] === "not_applicable")
    && optionalBoundedString(value["next"], RUN_FINALIZATION_LIMITS.nextChars)
    && isRunWorkStateInput(value["workState"])
    && workstreamValid
    && isNonEmptyString(value["at"]);
}

export function isRecordRunStepRequest(value: unknown): value is RecordRunStepRequest {
  if (!isRequestEnvelope(value)) {
    return false;
  }
  return isNonEmptyString(value["runId"])
    && isRunStepRecord(value["record"]);
}

export function isPlanContextCheckpointRequest(
  value: unknown,
): value is PlanContextCheckpointRequest {
  return isRequestEnvelope(value)
    && isNonEmptyString(value["streamId"])
    && isPositiveSafeInteger(value["protectFromSeq"])
    && isPositiveSafeInteger(value["requiredSavingsTokens"])
    && (value["estimatedCheckpointTokens"] === undefined
      || isPositiveSafeInteger(value["estimatedCheckpointTokens"]))
    && isNonEmptyString(value["at"]);
}

export function isCommitContextCheckpointRequest(
  value: unknown,
): value is CommitContextCheckpointRequest {
  return isRequestEnvelope(value)
    && isContextCheckpointPlan(value["plan"])
    && isContextCheckpointSummary(value["summary"])
    && isPositiveSafeInteger(value["tokenCount"])
    && Number(value["tokenCount"]) <= 4_000
    && isBoundedString(value["provider"], 200)
    && isBoundedString(value["model"], 200)
    && isNonEmptyString(value["at"]);
}

export function isSearchAgentHistoryRequest(
  value: unknown,
): value is SearchAgentHistoryRequest {
  return isRecord(value)
    && isNonEmptyString(value["streamId"])
    && isBoundedString(value["query"], 1_000)
    && (value["kinds"] === undefined
      || (Array.isArray(value["kinds"])
        && value["kinds"].length > 0
        && value["kinds"].length <= 3
        && value["kinds"].every(isAgentHistoryKind)))
    && (value["limit"] === undefined
      || (isPositiveSafeInteger(value["limit"]) && Number(value["limit"]) <= 25));
}

export function isReadAgentHistoryRequest(
  value: unknown,
): value is ReadAgentHistoryRequest {
  if (!isRecord(value) || !isNonEmptyString(value["streamId"])) return false;
  const maxCharsValid = value["maxChars"] === undefined
    || (isPositiveSafeInteger(value["maxChars"]) && Number(value["maxChars"]) <= 32_000);
  if (!maxCharsValid) return false;
  if (isNonEmptyString(value["ref"])) {
    return value["fromSeq"] === undefined
      && value["toSeq"] === undefined
      && (value["offsetChars"] === undefined
        || (typeof value["offsetChars"] === "number"
          && Number.isSafeInteger(value["offsetChars"])
          && value["offsetChars"] >= 0));
  }
  return isPositiveSafeInteger(value["fromSeq"])
    && isPositiveSafeInteger(value["toSeq"])
    && Number(value["toSeq"]) >= Number(value["fromSeq"])
    && value["offsetChars"] === undefined;
}

function isContextCheckpointPlan(value: unknown): value is ContextCheckpointPlan {
  if (!isRecord(value)
    || !isNonEmptyString(value["planId"])
    || !isNonEmptyString(value["streamId"])
    || typeof value["triggered"] !== "boolean"
    || !isPositiveSafeInteger(value["estimatedCheckpointTokens"])
    || !Array.isArray(value["selectedMessages"])
    || value["selectedMessages"].length > 2_000
    || !value["selectedMessages"].every(isStreamMessage)
    || !Array.isArray(value["exactTail"])
    || value["exactTail"].length > 2_000
    || !value["exactTail"].every(isStreamMessage)) {
    return false;
  }
  if (!value["triggered"]) {
    return value["coveredFromSeq"] === undefined
      && value["coveredToSeq"] === undefined
      && value["sourceHash"] === undefined;
  }
  return isPositiveSafeInteger(value["coveredFromSeq"])
    && isPositiveSafeInteger(value["coveredToSeq"])
    && Number(value["coveredToSeq"]) >= Number(value["coveredFromSeq"])
    && isBoundedString(value["sourceHash"], 128)
    && (value["previousCheckpoint"] === undefined
      || isContextCheckpointRecord(value["previousCheckpoint"]));
}

function isContextCheckpointRecord(value: unknown): value is ContextCheckpointRecord {
  return isRecord(value)
    && isNonEmptyString(value["checkpointId"])
    && isNonEmptyString(value["streamId"])
    && optionalNonEmptyString(value["previousCheckpointId"])
    && isPositiveSafeInteger(value["coveredFromSeq"])
    && isPositiveSafeInteger(value["coveredToSeq"])
    && Number(value["coveredToSeq"]) >= Number(value["coveredFromSeq"])
    && isNonEmptyString(value["sourceHash"])
    && value["schemaVersion"] === 1
    && isContextCheckpointSummary(value["summary"])
    && Array.isArray(value["exactAnchors"])
    && value["exactAnchors"].length <= 448
    && value["exactAnchors"].every(isPositiveSafeInteger)
    && isPositiveSafeInteger(value["tokenCount"])
    && value["reason"] === "context_pressure"
    && isBoundedString(value["provider"], 200)
    && isBoundedString(value["model"], 200)
    && isNonEmptyString(value["createdAt"]);
}

function isContextCheckpointSummary(value: unknown): value is ContextCheckpointSummary {
  if (!isRecord(value) || !isBoundedString(value["narrative"], 8_000)) return false;
  return [
    "userRequests",
    "constraints",
    "decisions",
    "corrections",
    "importantFacts",
    "unresolvedQuestions",
    "references",
  ].every((key) => Array.isArray(value[key])
    && value[key].length <= 64
    && value[key].every(isContextCheckpointStatement));
}

function isContextCheckpointStatement(value: unknown): value is ContextCheckpointStatement {
  return isRecord(value)
    && isPositiveSafeInteger(value["seq"])
    && isBoundedString(value["text"], 2_000);
}

function isStreamMessage(value: unknown): value is StreamMessage {
  return isRecord(value)
    && isNonEmptyString(value["messageId"])
    && isNonEmptyString(value["streamId"])
    && isNonEmptyString(value["runId"])
    && isPositiveSafeInteger(value["sequence"])
    && (value["role"] === "user" || value["role"] === "assistant" || value["role"] === "system_event")
    && typeof value["content"] === "string"
    && isNonEmptyString(value["contentHash"])
    && isNonEmptyString(value["at"]);
}

function isAgentHistoryKind(value: unknown): value is AgentHistoryKind {
  return value === "message" || value === "run" || value === "evidence";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWorkstreamForRunSelection(value: Record<string, unknown>): boolean {
  return isNonEmptyString(value["runId"])
    && isNonEmptyString(value["at"]);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function optionalNonEmptyString(value: unknown): boolean {
  return value === undefined || isNonEmptyString(value);
}

function optionalBoundedString(value: unknown, maximumLength: number): boolean {
  return value === undefined || isBoundedString(value, maximumLength);
}

function isBoundedString(value: unknown, maximumLength: number): value is string {
  return isNonEmptyString(value) && value.length <= maximumLength;
}

function isResourceAdmission(value: unknown): value is ResourceAdmission {
  return isRecord(value)
    && isBoundedString(value["admissionId"], 200)
    && isResourceKind(value["kind"])
    && isResourceOrigin(value["origin"])
    && isResourceLocator(value["locator"])
    && isBoundedString(value["displayName"], 500)
    && optionalBoundedString(value["description"], 2_000)
    && (value["aliases"] === undefined || isBoundedStringArray(value["aliases"], 32, 500))
    && (value["role"] === "attachment" || value["role"] === "reference")
    && (value["version"] === undefined || isResourceVersion(value["version"]))
    && optionalBoundedString(value["mediaType"], 200);
}

function isResourceBindingInput(value: unknown): boolean {
  return isRecord(value)
    && /^RES-[0-9A-F]{24}$/.test(String(value["resourceId"] ?? ""))
    && isResourceRole(value["role"])
    && (value["access"] === "read" || value["access"] === "mutate")
    && (value["primary"] === undefined || typeof value["primary"] === "boolean");
}

function isResourceMutationTarget(value: unknown): value is ResourceMutationTarget {
  return isRecord(value)
    && /^RES-[0-9A-F]{24}$/.test(String(value["resourceId"] ?? ""))
    && optionalBoundedString(value["relativePath"], 2_000)
    && (value["kind"] === "file" || value["kind"] === "directory")
    && optionalBoundedString(value["expectedVersionKey"], 1_000);
}

function isResourceKind(value: unknown): value is ResourceKind {
  return value === "file" || value === "directory" || value === "document"
    || value === "image" || value === "audio" || value === "video"
    || value === "dataset" || value === "database" || value === "git_repository"
    || value === "url" || value === "external_object";
}

function isResourceOrigin(value: unknown): value is ResourceOrigin {
  return value === "user_attachment" || value === "user_reference"
    || value === "agent_created" || value === "agent_discovered"
    || value === "agent_download";
}

function isResourceRole(value: unknown): value is ResourceRole {
  return value === "input" || value === "reference" || value === "primary"
    || value === "supporting" || value === "output" || value === "deliverable"
    || value === "evidence" || value === "asset";
}

function isResourceLocator(value: unknown): value is ResourcePublicLocator {
  if (!isRecord(value)) return false;
  if (value["kind"] === "filesystem") return isBoundedString(value["path"], 8_192);
  if (value["kind"] === "managed_blob") {
    return /^RES-[0-9A-F]{24}$/.test(String(value["resourceId"] ?? ""));
  }
  if (value["kind"] === "url") return isBoundedString(value["url"], 8_192);
  return value["kind"] === "external"
    && isBoundedString(value["provider"], 200)
    && isBoundedString(value["externalId"], 1_000)
    && optionalBoundedString(value["uri"], 8_192);
}

function isResourceVersion(value: unknown): value is ResourceVersion {
  if (!isRecord(value)
    || !isBoundedString(value["key"], 1_000)
    || !isNonEmptyString(value["observedAt"])
    || typeof value["exists"] !== "boolean"
    || !(value["kind"] === "file" || value["kind"] === "directory"
      || value["kind"] === "git" || value["kind"] === "url"
      || value["kind"] === "external" || value["kind"] === "unversioned")) {
    return false;
  }
  return optionalBoundedString(value["sha256"], 100)
    && optionalNonNegativeInteger(value["sizeBytes"])
    && optionalNonEmptyString(value["modifiedAt"])
    && optionalBoundedString(value["fingerprint"], 1_000)
    && optionalNonNegativeInteger(value["entryCount"])
    && optionalBoundedString(value["head"], 100)
    && (value["dirty"] === undefined || typeof value["dirty"] === "boolean")
    && optionalBoundedString(value["etag"], 1_000)
    && optionalBoundedString(value["lastModified"], 1_000)
    && optionalBoundedString(value["externalVersion"], 1_000);
}

function optionalNonNegativeInteger(value: unknown): boolean {
  return value === undefined
    || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isRunOutcome(value: unknown): value is RunOutcome {
  return value === "done"
    || value === "incomplete"
    || value === "failed"
    || value === "blocked"
    || value === "needs_user_input";
}

function isRunStopReason(value: unknown): value is RunStopReason {
  return value === "completed"
    || value === "run_limit"
    || value === "context_limit"
    || value === "failed"
    || value === "blocked"
    || value === "needs_user_input"
    || value === "interrupted";
}

function isTruthfulTerminalPair(outcome: unknown, stopReason: unknown): boolean {
  if (outcome === "done") return stopReason === "completed";
  if (outcome === "failed") return stopReason === "failed";
  if (outcome === "blocked") return stopReason === "blocked";
  if (outcome === "needs_user_input") return stopReason === "needs_user_input";
  return outcome === "incomplete"
    && (stopReason === "run_limit"
      || stopReason === "context_limit"
      || stopReason === "interrupted");
}

function isRunStepRecord(value: unknown): value is RunStepRecord {
  if (!isRecord(value)
    || value["version"] !== 1
    || typeof value["step"] !== "number"
    || !Number.isInteger(value["step"])
    || value["step"] <= 0
    || (value["status"] !== "completed"
      && value["status"] !== "failed"
      && value["status"] !== "blocked")
    || !isBoundedString(value["summary"], 2_000)
    || !Array.isArray(value["toolCalls"])
    || value["toolCalls"].length > 64
    || !value["toolCalls"].every(isRunStepToolCall)
    || !("verification" in value)
    || !isRunWorkStateInput(value["workStateAfter"])
    || !isNonEmptyString(value["createdAt"])) {
    return false;
  }
  return true;
}

function isRunStepToolCall(value: unknown): value is RunStepToolCall {
  if (!isRecord(value)
    || !isNonEmptyString(value["tool"])
    || !isBoundedString(value["purpose"], 500)
    || !isToolPurpose(value["toolPurpose"])
    || !isToolEffect(value["toolEffect"])
    || (value["status"] !== "success" && value["status"] !== "failed")
    || !("input" in value)
    || !optionalNonEmptyString(value["callId"])
    || !optionalNonEmptyString(value["outputHash"])) {
    return false;
  }
  const observational = value["toolPurpose"] === "list"
    || value["toolPurpose"] === "read"
    || value["toolPurpose"] === "search";
  if (observational) return value["toolEffect"] === "read_only";
  if (value["toolPurpose"] === "control") return value["toolEffect"] === "context_mutation";
  return value["toolEffect"] !== "read_only";
}

function isToolPurpose(value: unknown): value is ToolPurpose {
  return value === "list"
    || value === "read"
    || value === "search"
    || value === "control"
    || value === "mutation";
}

function isToolEffect(value: unknown): value is ToolEffect {
  return value === "read_only"
    || value === "workspace_mutation"
    || value === "context_mutation"
    || value === "external_mutation"
    || value === "destructive";
}

function isRunWorkStateInput(value: unknown): value is RunWorkStateInput {
  if (!isRecord(value)
    || (value["status"] !== "not_done"
      && value["status"] !== "done"
      && value["status"] !== "blocked"
      && value["status"] !== "needs_user_input")
    || !isBoundedString(value["summary"], RUN_FINALIZATION_LIMITS.workState.summaryChars)
    || !isBoundedStringArray(
      value["openWork"],
      RUN_FINALIZATION_LIMITS.workState.maximumItems,
      RUN_FINALIZATION_LIMITS.workState.contextItemChars,
    )
    || !isBoundedStringArray(
      value["blockers"],
      RUN_FINALIZATION_LIMITS.workState.maximumItems,
      RUN_FINALIZATION_LIMITS.workState.contextItemChars,
    )
    || !isBoundedStringArray(
      value["facts"],
      RUN_FINALIZATION_LIMITS.workState.maximumItems,
      RUN_FINALIZATION_LIMITS.workState.factChars,
    )
    || !isBoundedStringArray(
      value["evidence"],
      RUN_FINALIZATION_LIMITS.workState.maximumItems,
      RUN_FINALIZATION_LIMITS.workState.evidenceChars,
    )
    || !isBoundedStringArray(
      value["artifacts"],
      RUN_FINALIZATION_LIMITS.workState.maximumItems,
      RUN_FINALIZATION_LIMITS.workState.artifactChars,
    )
    || (value["nextStep"] !== null
      && !isBoundedString(value["nextStep"], RUN_FINALIZATION_LIMITS.workState.nextStepChars))
    || !isBoundedStringArray(
      value["userInputNeeded"],
      RUN_FINALIZATION_LIMITS.workState.maximumItems,
      RUN_FINALIZATION_LIMITS.workState.contextItemChars,
    )) {
    return false;
  }
  return true;
}

function isWorkstreamCompletionRecord(value: unknown): value is WorkstreamCompletionRecord {
  if (!isRecord(value)
    || typeof value["accepted"] !== "boolean"
    || !Array.isArray(value["resources"])
    || value["resources"].length > RUN_FINALIZATION_LIMITS.completion.maximumResources
    || !value["resources"].every(isCompletionResource)
    || !isBoundedStringArray(
      value["missing"],
      RUN_FINALIZATION_LIMITS.completion.maximumItems,
      RUN_FINALIZATION_LIMITS.completion.missingChars,
    )
    || !isBoundedStringArray(
      value["failures"],
      RUN_FINALIZATION_LIMITS.completion.maximumItems,
      RUN_FINALIZATION_LIMITS.completion.failureChars,
    )
    || !Array.isArray(value["criteria"])
    || value["criteria"].length > RUN_FINALIZATION_LIMITS.completion.maximumItems) {
    return false;
  }
  return value["criteria"].every((item) => isRecord(item)
    && isBoundedString(item["criterion"], RUN_FINALIZATION_LIMITS.completion.criterionChars)
    && typeof item["passed"] === "boolean"
    && optionalBoundedString(item["evidence"], RUN_FINALIZATION_LIMITS.completion.evidenceChars));
}

function isCompletionResource(value: unknown): boolean {
  return isRecord(value)
    && (value["resourceId"] === undefined
      || /^RES-[0-9A-F]{24}$/.test(String(value["resourceId"])))
    && (value["locator"] === undefined || isResourceLocator(value["locator"]))
    && (value["resourceId"] !== undefined || value["locator"] !== undefined)
    && isResourceKind(value["kind"])
    && (value["role"] === "output" || value["role"] === "deliverable"
      || value["role"] === "evidence" || value["role"] === "asset")
    && isBoundedString(value["description"], RUN_FINALIZATION_LIMITS.completion.descriptionChars)
    && isBoundedStringArray(
      value["aliases"],
      RUN_FINALIZATION_LIMITS.completion.maximumAliases,
      RUN_FINALIZATION_LIMITS.completion.aliasChars,
    )
    && typeof value["verified"] === "boolean";
}

function isBoundedStringArray(
  value: unknown,
  maximumItems: number,
  maximumLength: number,
): boolean {
  return Array.isArray(value)
    && value.length <= maximumItems
    && value.every((item) => isBoundedString(item, maximumLength));
}
