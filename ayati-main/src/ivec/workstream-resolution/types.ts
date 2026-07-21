import type {
  WorkstreamCandidate,
  WorkstreamResolutionHint,
  WorkstreamResolutionKind,
} from "ayati-context-engine";
import type { ContextEngineMachineContext } from "../../context-engine/index.js";

export interface WorkstreamResolveRequest {
  purpose: string;
  hints: WorkstreamResolutionHint[];
}

export type WorkstreamResolveReceipt =
  | {
      status: "resolved";
      activityId: string;
      resolutionKind: WorkstreamResolutionKind;
      workstreamId: string;
      requestId: string;
      stepCount: number;
      contextRevision: string;
    }
  | {
      status: "needs_user_input";
      activityId: string;
      candidateCount: number;
      stepCount: number;
      contextRevision: string;
    }
  | {
      status: "failed";
      activityId: string;
      code: string;
      retryable: boolean;
      stepCount: number;
      contextRevision?: string;
    };

export interface WorkstreamResolutionOutcome {
  receipt: WorkstreamResolveReceipt;
  context: ContextEngineMachineContext;
}

export interface WorkstreamResolutionCoordinator {
  resolve(request: WorkstreamResolveRequest): Promise<WorkstreamResolutionOutcome>;
}

export type ResolutionStateStatus =
  | "searching"
  | "candidates_found"
  | "inspecting"
  | "ready_to_activate"
  | "ready_to_create"
  | "needs_user_input"
  | "resolved"
  | "failed";

export interface ResolutionCandidateState {
  candidate: WorkstreamCandidate;
  inspected: boolean;
  possibleRequestIds: string[];
}

export interface ResolutionWorkState {
  status: ResolutionStateStatus;
  purpose: string;
  searches: Array<{
    query: string;
    completed: boolean;
  }>;
  candidates: ResolutionCandidateState[];
  resourceOwnership: Array<{
    locator: string;
    workstreamIds: string[];
    verified: boolean;
  }>;
  proposedSelection?: {
    workstreamId: string;
    requestKind: "continue" | "create";
    evidence: string[];
  };
  proposedCreation?: {
    title: string;
    objective: string;
  };
  ambiguity?: {
    reasonCodes: string[];
    candidateIds: string[];
    question: string;
  };
  failures: Array<{
    code: string;
    message: string;
    retryable: boolean;
  }>;
  nextOperation?: string;
}

export interface ResolutionToolCallRecord {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  status: "completed" | "failed";
  output?: unknown;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

export interface ResolutionDecisionRecord {
  calls: Array<{
    id: string;
    tool: string;
    input: Record<string, unknown>;
  }>;
}

export interface ResolutionStepHistory {
  step: number;
  decision: ResolutionDecisionRecord;
  toolCalls: ResolutionToolCallRecord[];
  verification: {
    passed: boolean;
    summary: string;
  };
  stateAfter: ResolutionWorkState;
}
