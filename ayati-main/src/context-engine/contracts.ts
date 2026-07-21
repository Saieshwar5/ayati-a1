import type {
  ContextCheckpointRecord,
  RecentWorkReference,
  ResourceRef,
  ReusableObservationProjection,
  RunContextProjection,
  StreamMessage,
  WorkstreamCandidate,
  WorkstreamResolutionProjection,
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
  recentMessages: StreamMessage[];
  recentWork: RecentWorkReference[];
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
  resources: WorkstreamResourceBinding[];
}

/**
 * Bounded daemon projection of authoritative V7 Context Engine state.
 * The projection deliberately separates slow agent-stream continuity from
 * fast current-run state and never exposes storage paths to the model layer.
 */
export interface ContextEngineMachineContext {
  contextRevision: string;
  streamRevision: string;
  runRevision?: string;
  observationRevision: string;
  agentStream: ContextAgentStreamProjection;
  current: ContextCurrentProjection;
  focus: ContextFocus;
  observations: ReusableObservationProjection;
  run?: RunContextProjection;
  workstreamCandidates?: WorkstreamCandidate[];
  workstreamResolution?: WorkstreamResolutionProjection;
  ingressResources?: ResourceRef[];
  workstream?: ContextWorkstreamProjection;
  warnings: string[];
}
