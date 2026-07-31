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

export interface WorkstreamWorkspaceTarget {
  kind: "file" | "directory";
  relativePath: string;
}

export interface ResolvedWorkstreamWorkspaceTarget extends WorkstreamWorkspaceTarget {
  absolutePath: string;
}

export type WorkstreamRequestDecision =
  | {
      kind: "continue_current" | "activate_existing" | "resume_blocked";
      requestId: string;
      reason: string;
    }
  | {
      kind: "amend_current";
      currentRequestId: string;
      patch: Partial<WorkstreamRequestDefinition>;
      authority: "user" | "trusted_policy";
      reason: string;
    }
  | ({
      kind: "create_and_activate" | "create_queued";
      title: string;
      request: string;
      acceptance: string[];
      constraints: string[];
      reason: string;
    })
  | ({
      kind: "defer_current_and_create";
      currentRequestId: string;
      title: string;
      request: string;
      acceptance: string[];
      constraints: string[];
      reason: string;
    })
  | {
      kind: "defer_current_and_activate_existing";
      currentRequestId: string;
      nextRequestId: string;
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
      requestDecision: WorkstreamRequestDecision;
      resourceIds: string[];
    }
  | {
      kind: "create";
      title: string;
      objective: string;
      initialRequest: WorkstreamRequestDefinition;
    };

export interface DeterministicWorkstreamBindingRequest {
  purpose: string;
  workspaceTargets: ResolvedWorkstreamWorkspaceTarget[];
  routingEvidence: string[];
  proposal: WorkstreamBindingProposal;
  expectedWorkstreamHead?: string;
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
      attemptDisposition: "consumed" | "retryable_no_change";
    };

export interface WorkstreamBindingCoordinator {
  bind(
    request: DeterministicWorkstreamBindingRequest,
  ): Promise<DeterministicWorkstreamBindingOutcome>;
}
