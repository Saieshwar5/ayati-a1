import type {
  ContextCheckpointRecord,
  RecentFileMetadata,
  RecentWorkStateHandoff,
  RecentWorkstreamMetadata,
  ResourceRef,
  RunContextProjection,
  StreamMessage,
  WorkstreamCandidate,
  WorkstreamRepositoryProjection,
  WorkstreamResourceBinding,
} from "ayati-context-engine";

export interface ContextAgentStreamMeta {
  streamId: string;
  agentId: string;
  scopeKey: string;
  createdAt: string;
  updatedAt: string;
  lastMessageSequence: number;
  lastRunSequence: number;
  resourceCount: number;
}

export interface ContextAgentStreamProjection {
  meta: ContextAgentStreamMeta;
  checkpoint?: ContextCheckpointRecord;
  focusedWorkstream?: ContextWorkstreamProjection;
  recentMessages: StreamMessage[];
  recentWorkstreams: RecentWorkstreamMetadata[];
  recentFiles: RecentFileMetadata[];
  recentWorkStates: RecentWorkStateHandoff[];
  resources: ResourceRef[];
}

export interface ContextCurrentRouting {
  status: "unbound" | "bound" | "clarifying";
  workstreamId?: string;
  requestId?: string;
  branch?: string;
}

export interface ContextCurrentProjection {
  inputSeq?: number;
  runId?: string;
  routing?: ContextCurrentRouting;
}

export type ContextFocus =
  | { status: "none" }
  | { status: "active"; ref: string; workstreamId: string }
  | { status: "missing"; ref: string; workstreamId?: string; reason: string }
  | { status: "unresolved"; ref: string; reason: string };

export interface ContextWorkstreamProjection {
  ref: string;
  workstreamId: string;
  title: string;
  objective: string;
  summary: string;
  workstreamStatus: "in_progress" | "done" | "blocked";
  lifecycleStatus: "active" | "paused" | "archived";
  repositoryHealth: "ready" | "dirty_external";
  currentFocus?: string;
  blockers: string[];
  next?: string;
  currentRequest?: {
    id: string;
    title: string;
    status: "queued" | "active" | "blocked" | "done" | "dropped";
    request: string;
    acceptance: string[];
    constraints: string[];
  };
  selectedRequest?: {
    id: string;
    title: string;
    status: "queued" | "active" | "blocked" | "done" | "dropped";
    request: string;
    acceptance: string[];
    constraints: string[];
    lifecycleNote?: string;
    finalOutcome?: string;
  };
  recentProgress: Array<{
    runId: string;
    outcome: "done" | "incomplete" | "failed" | "blocked" | "needs_user_input";
    summary: string;
    validationSummary: string;
    nextAction?: string;
    commit: string;
    finalizedAt: string;
  }>;
  resources: WorkstreamResourceBinding[];
}

/**
 * Bounded daemon projection of authoritative current-schema Context Engine state.
 * The projection deliberately separates slow agent-stream continuity from
 * fast current-run state. The only model-facing storage path is the exact,
 * read-only managed workstream repository used for durable history navigation.
 */
export interface ContextEngineMachineContext {
  contextRevision: string;
  streamRevision: string;
  runRevision?: string;
  workstreamRepository?: WorkstreamRepositoryProjection;
  agentStream: ContextAgentStreamProjection;
  current: ContextCurrentProjection;
  focus: ContextFocus;
  run?: RunContextProjection;
  workstreamCandidates?: WorkstreamCandidate[];
  ingressResources?: ResourceRef[];
  workstream?: ContextWorkstreamProjection;
  warnings: string[];
}
