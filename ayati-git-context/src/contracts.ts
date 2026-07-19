export const GIT_CONTEXT_PROTOCOL_VERSION = 34;

export type SessionId = string;
export type TaskId = string;
export type RunId = string;
export type ConversationId = string;

export type ConversationRole = "user" | "assistant" | "system_event";

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

export type GitContextCapability =
  | "health"
  | "active_context"
  | "sessions"
  | "conversations"
  | "runs"
  | "tasks"
  | "attachments"
  | "mutations"
  | "recovery";

export interface GitContextRequestEnvelope {
  requestId: string;
  expectedHead?: string;
}

export interface SessionRef {
  sessionId: SessionId;
  repositoryPath: string;
  head: string | null;
  date: string;
  timezone: string;
  status: "open" | "rollover_pending" | "finalizing" | "sealed";
}

export interface TaskRef {
  taskId: TaskId;
  repositoryPath: string;
  workingPath: string;
  branch: string;
  head: string;
}

export type TaskStatus = "initializing" | "active" | "archived";

export interface TaskCatalogEntry extends TaskRef {
  title: string;
  objective: string;
  status: TaskStatus;
  createdSessionId: SessionId;
  createdAt: string;
  updatedAt: string;
}

export interface MutationTarget {
  path: string;
  kind: "file" | "directory";
}

export interface ResolvedMutationTarget extends MutationTarget {
  resolvedPath: string;
}

export type MutationAuthorityStatus =
  | "active"
  | "verified"
  | "recovery_required"
  | "released";

export interface MutationAuthority {
  authorityId: string;
  lockToken: string;
  sessionId: SessionId;
  runId: RunId;
  taskId: TaskId;
  repositoryPath: string;
  taskRequestId?: string;
  branch: string;
  beforeHead: string;
  targets: ResolvedMutationTarget[];
  status: MutationAuthorityStatus;
  expiresAt: string;
}

export interface TaskBinding {
  taskId: TaskId;
  taskRequestId: string;
  boundAt: string;
}

export interface MutationProvenance {
  created: string[];
  modified: string[];
  deleted: string[];
  renamed: Array<{ from: string; to: string }>;
  unexpectedPaths: string[];
}

export interface RunRef {
  runId: RunId;
  sessionId: SessionId;
  conversationId: ConversationId;
  taskBinding?: TaskBinding;
}

export interface AgentRunHandle {
  runId: RunId;
  sessionId: SessionId;
  conversationId: ConversationId;
  triggerSeq: number;
}

export interface ConversationRef {
  conversationId: ConversationId;
  sessionId: SessionId;
  sequence: number;
  filePath: string;
  status: "active" | "closed" | "committed";
}

export interface ConversationPersistenceState {
  database: "saved";
  materialization: "not_requested" | "pending" | "materialized" | "failed";
  git: "not_committed" | "committed";
  plannedPath?: string;
  materializedPath?: string;
  contentHash?: string;
  committedSha?: string;
}

export interface ConversationMessage {
  messageId: string;
  conversationId: ConversationId;
  sessionSequence: number;
  segmentSequence: number;
  role: ConversationRole;
  content: string;
  at: string;
}

export interface ConversationContext {
  conversation: ConversationRef;
  messages: ConversationMessage[];
  contentHash: string;
}

export interface CommitSummary {
  commit: string;
  subject: string;
  committedAt?: string;
  message?: string;
  conversationSummary?: string;
  workSummary?: string;
  outcome?: string;
  validation?: string;
  taskId?: string;
  requestId?: string;
  event?: "task_created" | "task_repository_migrated" | "task_bound_run_finalized";
  runId?: string;
  sessionId?: string;
  taskTitle?: string;
  taskState?: string;
  taskStatus?: "in_progress" | "done" | "blocked";
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
  trigger: "user" | "system_event" | "internal";
  startedAt: string;
  completedAt?: string;
  stepCount: number;
}

export interface SessionContextProjection {
  session: SessionRef;
  summary: string;
  pendingConversation: ConversationRef[];
  pendingConversationContext: ConversationContext[];
  pendingDigest: string;
  recentCommits: CommitSummary[];
  attachments?: SessionAttachmentsProjection;
}

export interface SessionAttachmentRecord {
  sessionAssetId: string;
  kind: string;
  name: string;
  source: string;
  status: string;
  documentId?: string;
  fileId?: string;
  directoryId?: string;
  originalPath?: string;
  storedPath?: string;
  sizeBytes?: number;
  mimeType?: string;
  checksum?: string;
  createdAt: string;
  lastUsedAt?: string;
}

export interface SessionAttachmentsProjection {
  count: number;
  recent: SessionAttachmentRecord[];
  updatedAt?: string;
}

export interface PreviousSessionCarryover {
  sessionId: SessionId;
  head: string;
  summary: string;
}

export interface TaskContextProjection {
  task: TaskRef;
  /** User-facing task directory. May be shown to the model and user. */
  workingDirectory: string;
  title: string;
  objective: string;
  summary: string;
  importantPaths: string[];
  recentCommits: CommitSummary[];
  latestOutcome?: string;
  validation?: string;
  taskStatus?: "in_progress" | "done" | "blocked";
  next?: string;
  schemaVersion?: "ayati.task/v1";
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
  importantPathDetails?: Array<{
    path: string;
    description?: string;
    exists: boolean;
  }>;
  referencesSummary?: {
    total: number;
    available: number;
    missing: number;
    changed: number;
    unchecked: number;
  };
}

export interface TaskCandidate {
  taskId: TaskId;
  title: string;
  objective: string;
  status: TaskStatus;
  lifecycleStatus?: "active" | "paused" | "archived";
  repositoryHealth?: "ready" | "dirty_external" | "unavailable";
  currentRequest?: {
    id: string;
    title: string;
    status: "queued" | "active" | "blocked" | "done" | "dropped";
  };
  head: string;
  workingDirectory: string;
  updatedAt: string;
}

export interface RunContextProjection {
  run: RunContextRecord;
  workState: RunWorkState;
  steps: RunStepContext[];
}

export interface ReadContextEntry {
  key: string;
  runId: RunId;
  step: number;
  callId?: string;
  tool: string;
  purpose: string;
  resources: string[];
  input?: unknown;
  output?: unknown;
  outputHash?: string;
  verification: unknown;
  createdAt: string;
}

export interface ReadContextProjection {
  revision: string;
  afterCommitRunId?: RunId;
  inventory: ReadContextEntry[];
  discovery: ReadContextEntry[];
  evidence: ReadContextEntry[];
  actions: ReadContextEntry[];
}

export interface ActiveContext {
  contextRevision: string;
  session: SessionContextProjection | null;
  carryover?: PreviousSessionCarryover;
  activeTask?: TaskContextProjection;
  taskCandidates?: TaskCandidate[];
  run?: RunContextProjection;
  readContext?: ReadContextProjection;
  warnings: string[];
}

export interface HealthResponse {
  service: "ayati-git-context";
  protocolVersion: typeof GIT_CONTEXT_PROTOCOL_VERSION;
  status: "ok" | "degraded";
  ready: boolean;
  capabilities: GitContextCapability[];
}

export interface GetActiveContextRequest {
  sessionId?: SessionId;
}

export interface EnsureActiveSessionRequest extends GitContextRequestEnvelope {
  date: string;
  timezone: string;
  agentId: string;
  at?: string;
}

export interface EnsureActiveSessionResponse {
  session: SessionRef;
  created: boolean;
}

export interface PrepareContextTurnRequest extends GitContextRequestEnvelope {
  date: string;
  timezone: string;
  agentId: string;
  role: "user" | "system_event";
  content: string;
  at: string;
}

export interface PrepareContextTurnResponse {
  session: SessionRef;
  sessionCreated: boolean;
  conversation: ConversationRef;
  message: ConversationMessage;
  run: RunRef;
  persistence: ConversationPersistenceState;
  context: ActiveContext;
}

export type TaskPlacement =
  | {
      mode: "managed";
    }
  | {
      mode: "requested";
      /** Exact user-requested task directory. Relative paths resolve from the configured workspace. */
      workingDirectory: string;
    };

export interface ListTasksRequest {
  query?: string;
  limit?: number;
}

export interface ListTasksResponse {
  tasks: TaskCandidate[];
}

export interface GetTaskRequest {
  taskId: TaskId;
}

export interface GetTaskResponse {
  task: TaskCatalogEntry;
  /** Durable task context. */
  context?: TaskContextProjection;
}

export interface SelectTaskForRunInput {
  sessionId: SessionId;
  conversationId: ConversationId;
  runId: RunId;
  at: string;
}

export interface CreateTaskForRunRequest extends GitContextRequestEnvelope, SelectTaskForRunInput {
  title: string;
  objective: string;
  placement: TaskPlacement;
}

export interface ActivateTaskForRunRequest extends GitContextRequestEnvelope, SelectTaskForRunInput {
  taskId: TaskId;
  expectedTaskHead?: string;
  /** Explicitly continue the active request or create a new request in this V1 task. */
  route: TaskRequestRoute;
}

export type TaskRequestRoute =
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

export type TaskRequestRoutePlanPhase =
  | "planned"
  | "authority_acquired"
  | "committed"
  | "discarded"
  | "recovery_required";

export interface PlanTaskRequestRouteRequest extends GitContextRequestEnvelope {
  sessionId: SessionId;
  conversationId: ConversationId;
  runId: RunId;
  taskId: TaskId;
  expectedTaskHead: string;
  route: TaskRequestRoute;
  at: string;
}

export interface PlanTaskRequestRouteResponse {
  run: RunRef;
  taskId: TaskId;
  taskRequestId: string;
  baseHead: string;
  phase: TaskRequestRoutePlanPhase;
  requestCreated: boolean;
}

export interface SelectedTaskForRunResponse {
  task: TaskCatalogEntry;
  run: RunRef;
  context: TaskContextProjection;
  taskCreated: boolean;
  taskRequestDecision: "initial" | "continue" | "create";
  taskRequestStatus: "queued" | "active" | "blocked" | "done" | "dropped";
  taskRequestCreated: boolean;
  headBeforeSelection: string;
}

export interface RecordSessionAttachmentsRequest extends GitContextRequestEnvelope {
  sessionId: SessionId;
  conversationId: ConversationId;
  attachments: SessionAttachmentRecord[];
  at: string;
}

export interface RecordSessionAttachmentsResponse {
  recorded: number;
  sessionAssetIds: string[];
}

export interface BoundTaskReference {
  taskId: TaskId;
  runId: RunId;
  taskRequestId: string;
  sessionAssetId: string;
  referenceId: string;
  kind: "attachment" | "external_directory";
  location: string;
  sha256?: string;
  availability: "available" | "missing" | "changed" | "unchecked";
  adoptedPath?: string;
}

export interface BindTaskAttachmentsRequest extends GitContextRequestEnvelope {
  sessionId: SessionId;
  conversationId: ConversationId;
  runId: RunId;
  taskId: TaskId;
  at: string;
}

export interface BindTaskAttachmentsResponse {
  taskId: TaskId;
  runId: RunId;
  references: BoundTaskReference[];
}

export interface AdoptTaskReferenceRequest extends GitContextRequestEnvelope {
  authorityId: string;
  lockToken: string;
  referenceId: string;
  destinationPath: string;
  at: string;
}

export interface AdoptTaskReferenceResponse {
  taskId: TaskId;
  runId: RunId;
  referenceId: string;
  sourcePath: string;
  destinationPath: string;
  sha256: string;
}

export interface AcquireMutationAuthorityRequest extends GitContextRequestEnvelope {
  sessionId: SessionId;
  runId: RunId;
  taskId: TaskId;
  /** Required for task-bound runs and must name the active request. */
  taskRequestId?: string;
  expectedTaskHead?: string;
  targets: MutationTarget[];
  at: string;
}

export interface AcquireMutationAuthorityResponse {
  authority: MutationAuthority;
}

export interface VerifyMutationRequest extends GitContextRequestEnvelope {
  authorityId: string;
  lockToken: string;
  toolStatus: "completed" | "failed";
  at: string;
}

export interface VerifyMutationResponse {
  authorityId: string;
  status: MutationAuthorityStatus;
  verified: boolean;
  outcome: "verified_changes" | "no_changes" | "unexpected_changes" | "failed_with_changes";
  provenance: MutationProvenance;
}

export interface TaskCompletionRecord {
  accepted: boolean;
  assets: Array<{
    path: string;
    kind: "file" | "directory";
    description: string;
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

export interface FinalizeRunRequest extends GitContextRequestEnvelope {
  sessionId: SessionId;
  runId: RunId;
  outcome: RunOutcome;
  stopReason: RunStopReason;
  assistantResponse: string;
  conversationSummary: string;
  summary: string;
  validation: "passed" | "failed" | "not_applicable";
  next?: string;
  workState: RunWorkStateInput;
  task?: {
    completion: TaskCompletionRecord;
  };
  at: string;
}

export interface FinalizeRunResponse {
  run: RunContextRecord;
  conversation: ConversationRef;
  persistence: ConversationPersistenceState;
  materialization: {
    status: "not_requested" | "materialized";
    runFile?: string;
    stepsFile?: string;
  };
  commit:
    | { status: "not_required" }
    | {
        status: "no_change" | "committed";
        taskId: TaskId;
        taskRequestId: string;
        headBefore: string;
        headAfter: string;
        commit?: string;
      };
}

export interface RecordRunStepRequest extends GitContextRequestEnvelope {
  sessionId: SessionId;
  runId: RunId;
  record: RunStepRecord;
}

export interface RecordRunStepResponse {
  run: RunContextProjection;
  readContext: ReadContextProjection;
}

export function isRequestEnvelope(
  value: unknown,
): value is GitContextRequestEnvelope & Record<string, unknown> {
  if (!isRecord(value) || !isNonEmptyString(value["requestId"])) {
    return false;
  }
  return value["expectedHead"] === undefined || isNonEmptyString(value["expectedHead"]);
}

export function isEnsureActiveSessionRequest(value: unknown): value is EnsureActiveSessionRequest {
  if (!isRequestEnvelope(value)) {
    return false;
  }
  return isNonEmptyString(value["date"])
    && isNonEmptyString(value["timezone"])
    && isNonEmptyString(value["agentId"])
    && optionalNonEmptyString(value["at"]);
}

export function isPrepareContextTurnRequest(value: unknown): value is PrepareContextTurnRequest {
  if (!isRequestEnvelope(value)) {
    return false;
  }
  return isNonEmptyString(value["date"])
    && isNonEmptyString(value["timezone"])
    && isNonEmptyString(value["agentId"])
    && (value["role"] === "user" || value["role"] === "system_event")
    && isNonEmptyString(value["content"])
    && isNonEmptyString(value["at"]);
}

function isCreateTaskInput(value: unknown): value is GitContextRequestEnvelope & Record<string, unknown> {
  if (!isRequestEnvelope(value)) {
    return false;
  }
  return isNonEmptyString(value["sessionId"])
    && isBoundedString(value["title"], 120)
    && isBoundedString(value["objective"], 2_000)
    && isTaskPlacement(value["placement"])
    && isNonEmptyString(value["at"]);
}

export function isCreateTaskForRunRequest(value: unknown): value is CreateTaskForRunRequest {
  return isCreateTaskInput(value)
    && isTaskForRunSelection(value as unknown as Record<string, unknown>);
}

function isTaskPlacement(value: unknown): value is TaskPlacement {
  if (!isRecord(value)) {
    return false;
  }
  if (value["mode"] === "managed") {
    return Object.keys(value).every((key) => key === "mode");
  }
  return value["mode"] === "requested"
    && isBoundedString(value["workingDirectory"], 4_096)
    && Object.keys(value).every((key) => key === "mode" || key === "workingDirectory");
}

export function isActivateTaskForRunRequest(value: unknown): value is ActivateTaskForRunRequest {
  if (!isRequestEnvelope(value)) {
    return false;
  }
  const taskId = String(value["taskId"] ?? "");
  return /^T-\d{8}-\d{4}$/.test(taskId)
    && (value["expectedTaskHead"] === undefined
      || /^[a-f0-9]{40}$/.test(String(value["expectedTaskHead"])))
    && isTaskRequestRoute(value["route"])
    && isTaskForRunSelection(value);
}

export function isPlanTaskRequestRouteRequest(
  value: unknown,
): value is PlanTaskRequestRouteRequest {
  if (!isRequestEnvelope(value) || !isTaskRequestRoute(value["route"])) {
    return false;
  }
  const common = isNonEmptyString(value["sessionId"])
    && isNonEmptyString(value["conversationId"])
    && isNonEmptyString(value["runId"])
    && /^T-\d{8}-\d{4}$/.test(String(value["taskId"] ?? ""))
    && /^[a-f0-9]{40}$/.test(String(value["expectedTaskHead"] ?? ""))
    && isNonEmptyString(value["at"]);
  if (!common) return false;
  return true;
}

function isTaskRequestRoute(value: unknown): value is TaskRequestRoute {
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

export function isAcquireMutationAuthorityRequest(
  value: unknown,
): value is AcquireMutationAuthorityRequest {
  if (!isRequestEnvelope(value)) {
    return false;
  }
  const taskId = String(value["taskId"] ?? "");
  return isNonEmptyString(value["sessionId"])
    && isNonEmptyString(value["runId"])
    && /^T-\d{8}-\d{4}$/.test(taskId)
    && /^R-\d{4}$/.test(String(value["taskRequestId"] ?? ""))
    && /^[a-f0-9]{40}$/.test(String(value["expectedTaskHead"] ?? ""))
    && Array.isArray(value["targets"])
    && value["targets"].length <= 64
    && value["targets"].every(isMutationTarget)
    && isNonEmptyString(value["at"]);
}

export function isRecordSessionAttachmentsRequest(
  value: unknown,
): value is RecordSessionAttachmentsRequest {
  if (!isRequestEnvelope(value)) return false;
  return isNonEmptyString(value["sessionId"])
    && isNonEmptyString(value["conversationId"])
    && Array.isArray(value["attachments"])
    && value["attachments"].length > 0
    && value["attachments"].length <= 64
    && value["attachments"].every(isSessionAttachmentRecord)
    && isNonEmptyString(value["at"]);
}

export function isBindTaskAttachmentsRequest(
  value: unknown,
): value is BindTaskAttachmentsRequest {
  if (!isRequestEnvelope(value)) return false;
  return isNonEmptyString(value["sessionId"])
    && isNonEmptyString(value["conversationId"])
    && isNonEmptyString(value["runId"])
    && /^T-\d{8}-\d{4}$/.test(String(value["taskId"] ?? ""))
    && isNonEmptyString(value["at"]);
}

export function isAdoptTaskReferenceRequest(
  value: unknown,
): value is AdoptTaskReferenceRequest {
  if (!isRequestEnvelope(value)) return false;
  return isNonEmptyString(value["authorityId"])
    && isNonEmptyString(value["lockToken"])
    && /^REF-\d{4}$/.test(String(value["referenceId"] ?? ""))
    && isBoundedString(value["destinationPath"], 1_024)
    && isNonEmptyString(value["at"]);
}

export function isVerifyMutationRequest(value: unknown): value is VerifyMutationRequest {
  if (!isRequestEnvelope(value)) {
    return false;
  }
  return isNonEmptyString(value["authorityId"])
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
  const task = value["task"];
  const taskValid = task === undefined
    || (isRecord(task)
      && isTaskCompletionRecord(task["completion"])
      && (value["outcome"] !== "done" || task["completion"].accepted));
  return isNonEmptyString(value["sessionId"])
    && isNonEmptyString(value["runId"])
    && isRunOutcome(value["outcome"])
    && isRunStopReason(value["stopReason"])
    && isTruthfulTerminalPair(value["outcome"], value["stopReason"])
    && assistantResponseValid
    && isBoundedString(value["conversationSummary"], 2_000)
    && isBoundedString(value["summary"], 2_000)
    && (value["validation"] === "passed"
      || value["validation"] === "failed"
      || value["validation"] === "not_applicable")
    && optionalBoundedString(value["next"], 2_000)
    && isRunWorkStateInput(value["workState"])
    && taskValid
    && isNonEmptyString(value["at"]);
}

export function isRecordRunStepRequest(value: unknown): value is RecordRunStepRequest {
  if (!isRequestEnvelope(value)) {
    return false;
  }
  return isNonEmptyString(value["sessionId"])
    && isNonEmptyString(value["runId"])
    && isRunStepRecord(value["record"]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTaskForRunSelection(value: Record<string, unknown>): boolean {
  return isNonEmptyString(value["sessionId"])
    && isNonEmptyString(value["conversationId"])
    && isNonEmptyString(value["runId"])
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

function isMutationTarget(value: unknown): value is MutationTarget {
  return isRecord(value)
    && isBoundedString(value["path"], 1_024)
    && (value["kind"] === "file" || value["kind"] === "directory");
}

function isSessionAttachmentRecord(value: unknown): value is SessionAttachmentRecord {
  return isRecord(value)
    && isBoundedString(value["sessionAssetId"], 200)
    && isBoundedString(value["kind"], 100)
    && isBoundedString(value["name"], 512)
    && isBoundedString(value["source"], 100)
    && isBoundedString(value["status"], 100)
    && optionalBoundedString(value["documentId"], 200)
    && optionalBoundedString(value["fileId"], 200)
    && optionalBoundedString(value["directoryId"], 200)
    && optionalBoundedString(value["originalPath"], 4_096)
    && optionalBoundedString(value["storedPath"], 4_096)
    && (value["sizeBytes"] === undefined
      || (typeof value["sizeBytes"] === "number" && Number.isSafeInteger(value["sizeBytes"])
        && value["sizeBytes"] >= 0))
    && optionalBoundedString(value["mimeType"], 200)
    && (value["checksum"] === undefined
      || /^[a-f0-9]{64}$/.test(String(value["checksum"])))
    && isNonEmptyString(value["createdAt"])
    && optionalNonEmptyString(value["lastUsedAt"]);
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
    || typeof value["summary"] !== "string"
    || !isStringArray(value["openWork"])
    || !isStringArray(value["blockers"])
    || !isStringArray(value["facts"])
    || !isStringArray(value["evidence"])
    || !isStringArray(value["artifacts"])
    || (value["nextStep"] !== null && typeof value["nextStep"] !== "string")
    || !isStringArray(value["userInputNeeded"])) {
    return false;
  }
  return true;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isTaskCompletionRecord(value: unknown): value is TaskCompletionRecord {
  if (!isRecord(value)
    || typeof value["accepted"] !== "boolean"
    || !Array.isArray(value["assets"])
    || value["assets"].length > 256
    || !value["assets"].every(isCompletionAsset)
    || !isBoundedStringArray(value["missing"], 256, 1_024)
    || !isBoundedStringArray(value["failures"], 256, 2_000)
    || !Array.isArray(value["criteria"])
    || value["criteria"].length > 256) {
    return false;
  }
  return value["criteria"].every((item) => isRecord(item)
    && isBoundedString(item["criterion"], 1_000)
    && typeof item["passed"] === "boolean"
    && optionalBoundedString(item["evidence"], 2_000));
}

function isCompletionAsset(value: unknown): boolean {
  return isRecord(value)
    && isBoundedString(value["path"], 1_024)
    && !/[\u0000-\u001f\u007f]/.test(String(value["path"]))
    && (value["kind"] === "file" || value["kind"] === "directory")
    && isBoundedString(value["description"], 1_000)
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
