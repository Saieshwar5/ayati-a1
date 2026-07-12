export const GIT_CONTEXT_PROTOCOL_VERSION = 7;

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
  checkoutPath: string;
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
}

export interface ToolCallContext {
  step: number;
  tool: string;
  purpose: string;
  status: "completed" | "failed" | "blocked";
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
  title: string;
  summary: string;
  importantPaths: string[];
  recentCommits: CommitSummary[];
  latestOutcome?: string;
  validation?: string;
}

export interface RunContextProjection {
  run: RunRef;
  recentToolCalls: ToolCallContext[];
}

export interface ActiveContext {
  session: SessionContextProjection | null;
  carryover?: PreviousSessionCarryover;
  activeTask?: TaskContextProjection;
  run?: RunContextProjection;
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

export interface CreateTaskRequest extends GitContextRequestEnvelope {
  sessionId: SessionId;
  title: string;
  objective: string;
  at: string;
}

export interface CreateTaskResponse {
  task: TaskCatalogEntry;
  created: boolean;
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
}

export interface StartRunRequest extends GitContextRequestEnvelope {
  sessionId: SessionId;
  conversationId: ConversationId;
  trigger: "user" | "system_event" | "internal";
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
  purpose: string;
  status: ToolCallContext["status"];
  boundedInput?: unknown;
  boundedOutput?: unknown;
  outputHash?: string;
  verification?: unknown;
  workState?: unknown;
  at: string;
}

export interface RecordRunStepResponse {
  toolCall: ToolCallContext;
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
    && isNonEmptyString(value["at"]);
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

export function isStartRunRequest(value: unknown): value is StartRunRequest {
  if (!isRequestEnvelope(value)) {
    return false;
  }
  return isNonEmptyString(value["sessionId"])
    && isNonEmptyString(value["conversationId"])
    && (value["trigger"] === "user"
      || value["trigger"] === "system_event"
      || value["trigger"] === "internal")
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
    && isBoundedString(value["purpose"], 500)
    && (value["status"] === "completed"
      || value["status"] === "failed"
      || value["status"] === "blocked")
    && optionalNonEmptyString(value["outputHash"])
    && isNonEmptyString(value["at"]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function optionalNonEmptyString(value: unknown): boolean {
  return value === undefined || isNonEmptyString(value);
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
