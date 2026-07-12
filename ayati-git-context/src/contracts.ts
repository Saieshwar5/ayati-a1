export const GIT_CONTEXT_PROTOCOL_VERSION = 2;

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
    && isNonEmptyString(value["purpose"])
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

function isConversationRole(value: unknown): value is ConversationRole {
  return value === "user" || value === "assistant" || value === "system_event";
}
