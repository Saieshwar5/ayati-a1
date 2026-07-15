export const GIT_CONTEXT_PROTOCOL_VERSION = 17;

export type SessionId = string;
export type TaskId = string;
export type RunId = string;
export type ConversationId = string;

export type RunClass = "session" | "task";
export type ConversationRole = "user" | "assistant" | "system_event";

export type GitContextCapability =
  | "health"
  | "active_context"
  | "sessions"
  | "conversations"
  | "runs"
  | "tasks"
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

export type TaskMountStatus = "initializing" | "ready" | "recovery_required" | "removed";

export interface TaskMountRef {
  sessionId: SessionId;
  taskId: TaskId;
  /** Session-owned submodule checkout used only to persist the native gitlink. */
  checkoutPath: string;
  /** Stable user-facing checkout where task tools actually work. */
  workingPath: string;
  canonicalRepository: string;
  branch: string;
  mountedHead: string;
  status: TaskMountStatus;
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
  checkoutPath: string;
  canonicalRepository: string;
  branch: string;
  beforeHead: string;
  targets: ResolvedMutationTarget[];
  status: MutationAuthorityStatus;
  expiresAt: string;
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
  runClass: RunClass;
  taskId?: TaskId;
}

export interface ConversationRef {
  conversationId: ConversationId;
  sessionId: SessionId;
  sequence: number;
  filePath: string;
  status: "active" | "closed" | "committed";
}

export interface ConversationMessage {
  messageId: string;
  conversationId: ConversationId;
  sessionSequence: number;
  segmentSequence: number;
  /** @deprecated Use segmentSequence. */
  sequence: number;
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

export interface ToolCallContext {
  step: number;
  tool: string;
  toolSchemaVersion: number;
  toolEffect: "read_only" | "mutating";
  purpose: string;
  status: "completed" | "failed" | "blocked";
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

export interface RunStepContext extends ToolCallContext {
  input?: unknown;
  output?: unknown;
  outputHash?: string;
  verification?: unknown;
  createdAt: string;
}

export interface RunContextRecord extends RunRef {
  status: "running" | "completed" | "failed" | "blocked" | "needs_user_input";
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
}

export interface PreviousSessionCarryover {
  sessionId: SessionId;
  head: string;
  summary: string;
}

export interface TaskContextProjection {
  task: TaskRef;
  /** Runtime filesystem authority. Kept out of the model prompt. */
  checkoutPath?: string;
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
}

export interface TaskCandidate {
  taskId: TaskId;
  title: string;
  objective: string;
  status: TaskStatus;
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
  runClass: RunClass;
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
  afterTaskRunId?: RunId;
  entries: ReadContextEntry[];
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

export type TaskPlacement =
  | {
      mode: "managed";
    }
  | {
      mode: "requested";
      /** Exact user-requested task directory. Relative paths resolve from the configured workspace. */
      workingDirectory: string;
    };

export interface CreateTaskRequest extends GitContextRequestEnvelope {
  sessionId: SessionId;
  title: string;
  objective: string;
  placement: TaskPlacement;
  at: string;
}

export interface CreateTaskResponse {
  task: TaskCatalogEntry;
  created: boolean;
}

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
}

export interface MountTaskRequest extends GitContextRequestEnvelope {
  sessionId: SessionId;
  taskId: TaskId;
  expectedTaskHead?: string;
  at: string;
}

export interface MountTaskResponse {
  mount: TaskMountRef;
  created: boolean;
}

export interface SelectTaskRunInput {
  sessionId: SessionId;
  conversationId: ConversationId;
  runId?: RunId;
  trigger: "user" | "system_event" | "internal";
  workState: RunWorkStateInput;
  at: string;
}

export interface CreateTaskRunRequest extends GitContextRequestEnvelope, SelectTaskRunInput {
  title: string;
  objective: string;
  placement: TaskPlacement;
}

export interface ActivateTaskRunRequest extends GitContextRequestEnvelope, SelectTaskRunInput {
  taskId: TaskId;
  expectedTaskHead?: string;
}

export interface SelectedTaskRunResponse {
  task: TaskCatalogEntry;
  mount: TaskMountRef;
  run: RunRef;
  context: TaskContextProjection;
  taskCreated: boolean;
  mountCreated: boolean;
  runPromoted: boolean;
}

export interface AcquireMutationAuthorityRequest extends GitContextRequestEnvelope {
  sessionId: SessionId;
  runId: RunId;
  taskId: TaskId;
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

export interface CheckpointMutationRequest extends GitContextRequestEnvelope {
  authorityId: string;
  lockToken: string;
  purpose: string;
  conversationId: ConversationId;
  conversationHash: string;
  at: string;
}

export interface CheckpointMutationResponse {
  authorityId: string;
  taskId: TaskId;
  runId: RunId;
  beforeHead: string;
  checkpointHead: string;
  stagedPaths: string[];
  sessionGitlinkUpdated: boolean;
}

export interface SnapshotTaskRunEvidenceRequest extends GitContextRequestEnvelope {
  sessionId: SessionId;
  runId: RunId;
  taskId: TaskId;
  at: string;
}

export interface SnapshotTaskRunEvidenceResponse {
  runId: RunId;
  taskId: TaskId;
  runFile: string;
  stepsFile: string;
  stepCount: number;
  taskHeadBefore: string;
  taskHeadAfter: string;
  sessionHeadUnchanged: boolean;
  staged: boolean;
}

export type TaskRunOutcome =
  | "done"
  | "incomplete"
  | "failed"
  | "blocked"
  | "needs_user_input";

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

export interface FinalizeTaskRunRequest extends GitContextRequestEnvelope {
  sessionId: SessionId;
  runId: RunId;
  taskId: TaskId;
  outcome: TaskRunOutcome;
  conversationSummary: string;
  /** Compact cumulative task state after this run, suitable for the next activation. */
  summary: string;
  validation: "passed" | "failed" | "not_run";
  next?: string;
  completion: TaskCompletionRecord;
  assistantResponse: string;
  at: string;
}

export interface FinalizeTaskRunResponse {
  runId: RunId;
  taskId: TaskId;
  outcome: TaskRunOutcome;
  taskHeadBefore: string;
  taskHeadAfter: string;
  taskFinalizationCommit: string;
  sessionCommit: string;
  conversationHash: string;
  runFile: string;
  stepsFile: string;
}

export interface FinalizeSessionRunRequest extends GitContextRequestEnvelope {
  sessionId: SessionId;
  runId: RunId;
  assistantResponse: string;
  workState: RunWorkStateInput;
  at: string;
}

export interface FinalizeSessionRunResponse {
  runId: RunId;
  status: "completed";
  runFile: string;
  stepsFile: string;
  stepCount: number;
}

export interface AppendConversationRequest extends GitContextRequestEnvelope {
  sessionId: SessionId;
  role: ConversationRole;
  content: string;
  at: string;
  runId?: RunId;
  taskId?: TaskId;
}

export interface AppendConversationResponse {
  conversation: ConversationRef;
  message: ConversationMessage;
  contextRevision: string;
  pendingDigest: string;
}

export interface StartRunRequest extends GitContextRequestEnvelope {
  sessionId: SessionId;
  conversationId: ConversationId;
  trigger: "user" | "system_event" | "internal";
  workState: RunWorkStateInput;
  at?: string;
}

export interface StartRunResponse {
  run: RunRef;
}

export interface RecordRunStepRequest extends GitContextRequestEnvelope {
  sessionId: SessionId;
  runId: RunId;
  step: number;
  tool: string;
  toolSchemaVersion?: number;
  toolEffect: "read_only" | "mutating";
  purpose: string;
  status: ToolCallContext["status"];
  input?: unknown;
  output?: unknown;
  outputHash?: string;
  verification?: unknown;
  workState: RunWorkStateInput;
  at: string;
}

export interface RecordRunStepResponse {
  toolCall: ToolCallContext;
  workState: RunWorkState;
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

export function isAppendConversationRequest(value: unknown): value is AppendConversationRequest {
  if (!isRequestEnvelope(value)) {
    return false;
  }
  return isNonEmptyString(value["sessionId"])
    && isConversationRole(value["role"])
    && isNonEmptyString(value["content"])
    && isNonEmptyString(value["at"])
    && optionalNonEmptyString(value["runId"])
    && optionalNonEmptyString(value["taskId"]);
}

export function isCreateTaskRequest(value: unknown): value is CreateTaskRequest {
  if (!isRequestEnvelope(value)) {
    return false;
  }
  return isNonEmptyString(value["sessionId"])
    && isBoundedString(value["title"], 120)
    && isBoundedString(value["objective"], 2_000)
    && isTaskPlacement(value["placement"])
    && isNonEmptyString(value["at"]);
}

export function isCreateTaskRunRequest(value: unknown): value is CreateTaskRunRequest {
  return isCreateTaskRequest(value)
    && isTaskRunSelection(value as unknown as Record<string, unknown>);
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

export function isActivateTaskRunRequest(value: unknown): value is ActivateTaskRunRequest {
  if (!isRequestEnvelope(value)) {
    return false;
  }
  return /^W-\d{8}-\d{4}$/.test(String(value["taskId"] ?? ""))
    && (value["expectedTaskHead"] === undefined
      || /^[a-f0-9]{40}$/.test(String(value["expectedTaskHead"])))
    && isTaskRunSelection(value);
}

export function isMountTaskRequest(value: unknown): value is MountTaskRequest {
  if (!isRequestEnvelope(value)) {
    return false;
  }
  return isNonEmptyString(value["sessionId"])
    && /^W-\d{8}-\d{4}$/.test(String(value["taskId"] ?? ""))
    && (value["expectedTaskHead"] === undefined
      || /^[a-f0-9]{40}$/.test(String(value["expectedTaskHead"])))
    && isNonEmptyString(value["at"]);
}

export function isAcquireMutationAuthorityRequest(
  value: unknown,
): value is AcquireMutationAuthorityRequest {
  if (!isRequestEnvelope(value)) {
    return false;
  }
  return isNonEmptyString(value["sessionId"])
    && isNonEmptyString(value["runId"])
    && /^W-\d{8}-\d{4}$/.test(String(value["taskId"] ?? ""))
    && (value["expectedTaskHead"] === undefined
      || /^[a-f0-9]{40}$/.test(String(value["expectedTaskHead"])))
    && Array.isArray(value["targets"])
    && value["targets"].length > 0
    && value["targets"].length <= 64
    && value["targets"].every(isMutationTarget)
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

export function isCheckpointMutationRequest(
  value: unknown,
): value is CheckpointMutationRequest {
  if (!isRequestEnvelope(value)) {
    return false;
  }
  return isNonEmptyString(value["authorityId"])
    && isNonEmptyString(value["lockToken"])
    && isBoundedString(value["purpose"], 500)
    && isNonEmptyString(value["conversationId"])
    && /^sha256:[a-f0-9]{64}$/.test(String(value["conversationHash"] ?? ""))
    && isNonEmptyString(value["at"]);
}

export function isSnapshotTaskRunEvidenceRequest(
  value: unknown,
): value is SnapshotTaskRunEvidenceRequest {
  if (!isRequestEnvelope(value)) {
    return false;
  }
  return isNonEmptyString(value["sessionId"])
    && isNonEmptyString(value["runId"])
    && /^W-\d{8}-\d{4}$/.test(String(value["taskId"] ?? ""))
    && isNonEmptyString(value["at"]);
}

export function isFinalizeTaskRunRequest(value: unknown): value is FinalizeTaskRunRequest {
  if (!isRequestEnvelope(value)) {
    return false;
  }
  return isNonEmptyString(value["sessionId"])
    && isNonEmptyString(value["runId"])
    && /^W-\d{8}-\d{4}$/.test(String(value["taskId"] ?? ""))
    && isTaskRunOutcome(value["outcome"])
    && isBoundedString(value["conversationSummary"], 2_000)
    && isBoundedString(value["summary"], 2_000)
    && (value["validation"] === "passed"
      || value["validation"] === "failed"
      || value["validation"] === "not_run")
    && optionalBoundedString(value["next"], 2_000)
    && isTaskCompletionRecord(value["completion"])
    && (value["outcome"] === "done") === value["completion"].accepted
    && (value["outcome"] !== "done" || value["validation"] === "passed")
    && isBoundedString(value["assistantResponse"], 20_000)
    && isNonEmptyString(value["at"]);
}

export function isFinalizeSessionRunRequest(
  value: unknown,
): value is FinalizeSessionRunRequest {
  if (!isRequestEnvelope(value)) {
    return false;
  }
  return isNonEmptyString(value["sessionId"])
    && isNonEmptyString(value["runId"])
    && isBoundedString(value["assistantResponse"], 20_000)
    && isRunWorkStateInput(value["workState"])
    && value["workState"].status === "done"
    && isNonEmptyString(value["at"]);
}

export function isStartRunRequest(value: unknown): value is StartRunRequest {
  if (!isRequestEnvelope(value)) {
    return false;
  }
  return isNonEmptyString(value["sessionId"])
    && isNonEmptyString(value["conversationId"])
    && (value["trigger"] === "user"
      || value["trigger"] === "system_event"
      || value["trigger"] === "internal")
    && isRunWorkStateInput(value["workState"])
    && optionalNonEmptyString(value["at"]);
}

export function isRecordRunStepRequest(value: unknown): value is RecordRunStepRequest {
  if (!isRequestEnvelope(value)) {
    return false;
  }
  return isNonEmptyString(value["sessionId"])
    && isNonEmptyString(value["runId"])
    && typeof value["step"] === "number"
    && Number.isInteger(value["step"])
    && value["step"] > 0
    && isNonEmptyString(value["tool"])
    && (value["toolSchemaVersion"] === undefined
      || (typeof value["toolSchemaVersion"] === "number"
        && Number.isInteger(value["toolSchemaVersion"])
        && value["toolSchemaVersion"] > 0))
    && (value["toolEffect"] === "read_only" || value["toolEffect"] === "mutating")
    && isBoundedString(value["purpose"], 500)
    && (value["status"] === "completed"
      || value["status"] === "failed"
      || value["status"] === "blocked")
    && isRunWorkStateInput(value["workState"])
    && optionalNonEmptyString(value["outputHash"])
    && isNonEmptyString(value["at"]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTaskRunSelection(value: Record<string, unknown>): boolean {
  return isNonEmptyString(value["sessionId"])
    && isNonEmptyString(value["conversationId"])
    && optionalNonEmptyString(value["runId"])
    && (value["trigger"] === "user"
      || value["trigger"] === "system_event"
      || value["trigger"] === "internal")
    && isRunWorkStateInput(value["workState"])
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

function isConversationRole(value: unknown): value is ConversationRole {
  return value === "user" || value === "assistant" || value === "system_event";
}

function isTaskRunOutcome(value: unknown): value is TaskRunOutcome {
  return value === "done"
    || value === "incomplete"
    || value === "failed"
    || value === "blocked"
    || value === "needs_user_input";
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
