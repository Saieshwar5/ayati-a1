export type FocusType =
  | "artifact_work"
  | "document"
  | "learning"
  | "automation"
  | "investigation"
  | "debug_issue"
  | "generic_task";

export type FocusStatus = "active" | "warm" | "dormant" | "archived";

export interface FocusArtifactRef {
  kind: "file" | "directory" | "document" | "url" | "run" | "other";
  path?: string;
  uri?: string;
  documentId?: string;
  displayName?: string;
  preparedInputId?: string;
  manifestPath?: string;
  role?: string;
  sourceRunId?: string;
  sourceRunPath?: string;
  lastVerifiedAt?: string;
  lastUsedAt?: string;
}

export interface FocusCard {
  focusId: string;
  clientId: string;
  type: FocusType;
  status: FocusStatus;
  label: string;
  summary: string;
  shelfSummary: string;
  entities: string[];
  artifacts: FocusArtifactRef[];
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
  details: Record<string, unknown>;
}

export interface FocusShelfItem {
  focusId: string;
  type: FocusType;
  status: FocusStatus;
  label: string;
  summary: string;
  hints: string[];
  topArtifacts: string[];
  lastTouchedAt: string;
  lastTouchedLabel: string;
  attentionScore: number;
  nextStep?: string;
}

export interface FocusUpsertInput {
  clientId: string;
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
  nextAction?: string;
  attachmentNames?: string[];
  activeAttachments?: Array<{
    documentId: string;
    displayName: string;
    kind: string;
    mode: string;
    runId: string;
    runPath: string;
    preparedInputId: string;
    lastUsedAt: string;
    manifest?: { path?: string; sourcePath?: string; [key: string]: unknown };
  }>;
  createdAt: string;
}

export interface FocusAdmissionResult {
  admitted: boolean;
  score: number;
  reason: string;
}

