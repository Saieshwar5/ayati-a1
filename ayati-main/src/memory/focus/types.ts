import type { PreparedAttachmentDetailRecord } from "../../documents/prepared-attachment-registry.js";
import type { ManagedDocumentManifest, PreparedAttachmentSummary } from "../../documents/types.js";

export type FocusType =
  | "artifact_work"
  | "document"
  | "learning"
  | "automation"
  | "investigation"
  | "debug_issue"
  | "generic_task";

export type FocusStatus = "active" | "warm" | "dormant" | "archived";
export type FocusScope = "session" | "global";
export type FocusAssetKind = "file" | "directory" | "document" | "dataset" | "website" | "url" | "run" | "other";
export type FocusAssetOrigin =
  | "user_attached"
  | "user_selected"
  | "agent_generated"
  | "agent_modified"
  | "tool_result"
  | "unknown";
export type FocusAssetRole = "input" | "working_artifact" | "output" | "evidence" | "reference";

export interface FocusArtifactRef {
  kind: "file" | "directory" | "document" | "url" | "run" | "other";
  assetId?: string;
  path?: string;
  uri?: string;
  documentId?: string;
  displayName?: string;
  preparedInputId?: string;
  manifestPath?: string;
  origin?: FocusAssetOrigin;
  role?: string;
  sourceRunId?: string;
  sourceRunPath?: string;
  lastVerifiedAt?: string;
  lastUsedAt?: string;
}

export interface FocusAssetRestoreRef {
  preparedInputId?: string;
  documentId?: string;
  manifestPath?: string;
  filePath?: string;
  directoryPath?: string;
  uri?: string;
}

export interface FocusAssetRef {
  assetId: string;
  kind: FocusAssetKind;
  origin: FocusAssetOrigin;
  role: FocusAssetRole;
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
  restore?: FocusAssetRestoreRef;
  sourceRunId: string;
  sourceRunPath: string;
  lastUsedRunId: string;
  lastUsedAt: string;
  metadata?: Record<string, unknown>;
}

export interface FocusRunRef {
  runId: string;
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

export interface FocusCurrentState {
  goal?: string;
  openWork?: string[];
  blockers?: string[];
  keyFacts?: string[];
  evidence?: string[];
  nextStep?: string;
  changedFiles?: string[];
  workingDirectories?: string[];
  lastVerification?: string;
  [key: string]: unknown;
}

export interface FocusCard {
  focusId: string;
  clientId: string;
  scope: FocusScope;
  sessionId?: string;
  parentFocusId?: string;
  type: FocusType;
  status: FocusStatus;
  label: string;
  summary: string;
  shelfSummary: string;
  entities: string[];
  artifacts: FocusArtifactRef[];
  assets: FocusAssetRef[];
  runs: FocusRunRef[];
  currentState: FocusCurrentState;
  verifiedFacts: string[];
  openWork: string[];
  nextStep?: string;
  sourceRunIds: string[];
  memoryStrength: number;
  decayRate: number;
  importance: number;
  reuseCount: number;
  createdAt: string;
  lastTouchedAt: string;
  attentionUntil?: string;
  activeSessionId?: string;
  activatedAt?: string;
  activatedReason?: string;
  details: Record<string, unknown>;
}

export interface FocusShelfItem {
  focusId: string;
  scope: FocusScope;
  sessionId?: string;
  parentFocusId?: string;
  type: FocusType;
  status: FocusStatus;
  label: string;
  summary: string;
  hints: string[];
  topArtifacts: string[];
  openWork: string[];
  lastTouchedAt: string;
  lastTouchedLabel: string;
  attentionScore: number;
  nextStep?: string;
  activeSessionId?: string;
  activatedAt?: string;
  activatedReason?: string;
}

export interface FocusUpsertInput {
  clientId: string;
  focusId?: string;
  scope?: FocusScope;
  sessionId?: string;
  parentFocusId?: string;
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
  focusAssets?: FocusAssetRef[];
  activeAttachments?: Array<{
    attachmentKind?: FocusAssetKind;
    assetId?: string;
    documentId?: string;
    fileId?: string;
    directoryId?: string;
    displayName: string;
    kind: string;
    mode?: string;
    capabilities?: string[];
    runId: string;
    runPath: string;
    preparedInputId?: string;
    path?: string;
    lastUsedAt: string;
    manifest?: ManagedDocumentManifest & { path?: string; sourcePath?: string };
    summary?: PreparedAttachmentSummary;
    detail?: PreparedAttachmentDetailRecord | Record<string, unknown>;
  }>;
  createdAt: string;
}

export interface FocusAdmissionResult {
  admitted: boolean;
  score: number;
  reason: string;
}
