import type { PreparedAttachmentDetailRecord } from "../../documents/prepared-attachment-registry.js";
import type { ManagedDocumentManifest, PreparedAttachmentSummary } from "../../documents/types.js";

export type ActivityKind = "project" | "document" | "learning" | "automation" | "debug" | "research" | "generic";
export type ActivityLifecycle = "active" | "warm" | "cold" | "archived";
export type ActivityIdentityType =
  | "asset_id"
  | "file_path"
  | "file_id"
  | "directory_path"
  | "directory_id"
  | "document_id"
  | "prepared_input_id"
  | "dataset_id"
  | "workspace_root"
  | "course_id"
  | "automation_id"
  | "repo_root"
  | "error_signature"
  | "explicit_alias";
export type ActivityAssetKind = "file" | "directory" | "document" | "dataset" | "website" | "url" | "run" | "other";
export type ActivityAssetOrigin =
  | "user_attached"
  | "user_selected"
  | "agent_generated"
  | "agent_modified"
  | "tool_result"
  | "unknown";
export type ActivityAssetRole = "input" | "working_artifact" | "output" | "evidence" | "reference";
export type ContinuityMode = "new" | "continue" | "ambiguous";

export interface ActivityIdentity {
  type: ActivityIdentityType;
  value: string;
  confidence: number;
  source: "explicit" | "artifact" | "asset" | "alias" | "inferred";
  lastSeenAt: string;
}

export interface ActivityAlias {
  value: string;
  confidence: number;
  source: "user" | "system" | "inferred";
  lastSeenAt: string;
}

export interface ActivityAssetRestoreRef {
  preparedInputId?: string;
  documentId?: string;
  manifestPath?: string;
  filePath?: string;
  directoryPath?: string;
  uri?: string;
}

export interface ActivityAssetRef {
  assetId: string;
  kind: ActivityAssetKind;
  origin: ActivityAssetOrigin;
  role: ActivityAssetRole;
  displayName?: string;
  path?: string;
  uri?: string;
  documentId?: string;
  fileId?: string;
  directoryId?: string;
  preparedInputId?: string;
  manifest?: ManagedDocumentManifest;
  summary?: PreparedAttachmentSummary;
  detail?: PreparedAttachmentDetailRecord | Record<string, unknown>;
  restore?: ActivityAssetRestoreRef;
  sourceRunId: string;
  sourceRunPath: string;
  lastUsedRunId: string;
  lastUsedAt: string;
  metadata?: Record<string, unknown>;
}

export interface ActivityRunRef {
  runId: string;
  sessionId: string;
  runPath: string;
  status: "completed" | "failed" | "stuck";
  taskStatus?: string;
  userMessage?: string;
  assistantResponse?: string;
  summary: string;
  toolsUsed: string[];
  assetIds: string[];
  createdAt: string;
}

export interface ActivityState {
  goal?: string;
  openWork: string[];
  blockers: string[];
  nextStep?: string;
  verifiedFacts: string[];
  decisions: string[];
  changedFiles: string[];
  workingDirectories: string[];
  lastVerification?: string;
}

export interface ActivityThread {
  activityId: string;
  clientId: string;
  kind: ActivityKind;
  title: string;
  summary: string;
  lifecycle: ActivityLifecycle;
  identities: ActivityIdentity[];
  aliases: ActivityAlias[];
  assets: ActivityAssetRef[];
  runs: ActivityRunRef[];
  state: ActivityState;
  confidence: number;
  importance: number;
  reuseCount: number;
  createdAt: string;
  lastTouchedAt: string;
  autoLoadUntil?: string;
  details: Record<string, unknown>;
}

export interface ActivityCandidate {
  activityId: string;
  kind: ActivityKind;
  title: string;
  reason: string;
  score: number;
  topAssets: string[];
  lastTouchedAt: string;
}

export interface ActivityContext {
  activityId: string;
  kind: ActivityKind;
  title: string;
  goal?: string;
  openWork: string[];
  nextStep?: string;
  verifiedFacts: string[];
  topAssets: string[];
  lastTouchedAt: string;
}

export interface ContinuityContext {
  mode: ContinuityMode;
  confidence: number;
  reasons: string[];
  current?: ActivityContext;
  candidates?: ActivityCandidate[];
}

export interface ActivityUpsertInput {
  clientId: string;
  sessionId: string;
  activityId?: string;
  runId: string;
  runPath: string;
  status: "completed" | "failed" | "stuck";
  taskStatus?: string;
  objective?: string;
  summary: string;
  progressSummary?: string;
  currentFocus?: string;
  completedMilestones?: string[];
  openWork?: string[];
  blockers?: string[];
  keyFacts?: string[];
  evidence?: string[];
  userInputNeeded?: string;
  userMessage?: string;
  assistantResponse?: string;
  actionType?: string;
  entityHints?: string[];
  toolsUsed?: string[];
  nextAction?: string;
  attachmentNames?: string[];
  activityAssets?: ActivityAssetRef[];
  createdAt: string;
}

export interface ActivitySearchOptions {
  limit?: number;
  includeArchived?: boolean;
}

export interface ActivityResolutionInput {
  clientId: string;
  sessionId: string;
  userMessage: string;
  recentActivityId?: string;
  identities?: Array<Pick<ActivityIdentity, "type" | "value">>;
  currentAssetRefs?: ActivityAssetRef[];
}
