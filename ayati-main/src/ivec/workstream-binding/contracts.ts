import type { ContextEngineMachineContext } from "../../context-engine/index.js";

export type WorkstreamResourceRole =
  | "input"
  | "reference"
  | "primary"
  | "supporting"
  | "output"
  | "deliverable"
  | "evidence"
  | "asset";

export interface WorkstreamResourceBindingProposal {
  resourceId: string;
  role: WorkstreamResourceRole;
  access: "read" | "mutate";
  primary?: boolean;
}

export type WorkstreamRequestDecision =
  | {
      kind: "continue";
      requestId: string;
      reason: string;
    }
  | {
      kind: "create";
      title: string;
      request: string;
      acceptance: string[];
      constraints: string[];
      reason: string;
    };

export interface WorkstreamRequestDefinition {
  title: string;
  request: string;
  acceptance: string[];
  constraints: string[];
}

export type WorkstreamBindingProposal =
  | {
      kind: "activate";
      workstreamId: string;
      expectedWorkstreamHead: string;
      requestDecision: WorkstreamRequestDecision;
      evidence: string[];
    }
  | {
      kind: "create";
      title: string;
      objective: string;
      initialRequest: WorkstreamRequestDefinition;
      resources: WorkstreamResourceBindingProposal[];
      evidence: string[];
    };

export interface DeterministicWorkstreamBindingRequest {
  purpose: string;
  targets: string[];
  proposal: WorkstreamBindingProposal;
  expectedContextRevision?: string;
}

export type DeterministicWorkstreamBindingOutcome =
  | {
      status: "resolved";
      kind: "activated_workstream" | "created_workstream";
      workstreamId: string;
      requestId: string;
      context: ContextEngineMachineContext;
    }
  | {
      status: "needs_user_input";
      question: string;
      candidateIds: string[];
    }
  | {
      status: "failed";
      code: string;
      message: string;
      retryable: boolean;
    };

export interface WorkstreamBindingCoordinator {
  bind(
    request: DeterministicWorkstreamBindingRequest,
  ): Promise<DeterministicWorkstreamBindingOutcome>;
}
