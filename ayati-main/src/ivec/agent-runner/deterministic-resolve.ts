import { requiresWorkstreamBinding } from "../../skills/tool-taxonomy.js";
import type { LoopState } from "../types.js";
import type {
  DeterministicWorkstreamBindingOutcome,
  WorkstreamBindingCoordinator,
  WorkstreamBindingProposal,
} from "../workstream-binding/contracts.js";
import { deriveTurnMutationConstraints } from "./turn-intent-policy.js";
import {
  createVirtualModeRepair,
  type ModeTransitionRequest,
  type VirtualModeRepair,
} from "./virtual-mode.js";
import { collectWorkstreamRoutingEvidence } from "./workstream-routing-evidence.js";

export type DeterministicResolveGateResult =
  | { kind: "not_required"; attempted: false }
  | {
      kind: "resolved";
      attempted: true;
      toolNames: string[];
      outcome: Extract<DeterministicWorkstreamBindingOutcome, { status: "resolved" }>;
    }
  | {
      kind: "needs_user_input";
      attempted: true;
      toolNames: string[];
      outcome: Extract<DeterministicWorkstreamBindingOutcome, { status: "needs_user_input" }>;
    }
  | {
      kind: "failed";
      attempted: true;
      toolNames: string[];
      outcome: Extract<DeterministicWorkstreamBindingOutcome, { status: "failed" }>;
    }
  | {
      kind: "rejected";
      attempted: false;
      toolNames: string[];
      repair: VirtualModeRepair;
    };

export async function dispatchDeterministicResolveGate(input: {
  state: LoopState;
  request: ModeTransitionRequest;
  toolNames: string[];
  coordinator?: WorkstreamBindingCoordinator;
  alreadyAttempted: boolean;
  onEvent?(event: string, data: Record<string, unknown>): void;
}): Promise<DeterministicResolveGateResult> {
  const toolNames = bindingRequiredToolNames(input.toolNames);
  if (toolNames.length === 0) {
    return rejected(
      toolNames,
      "MODE_BINDING_REQUIRED",
      "The resolve gate requires at least one capability whose concrete tools need workstream binding.",
      input.request.capabilities,
      ["Request the exact mutation or external-action capability needed for this task."],
    );
  }
  if (isWorkstreamBound(input.state)) return { kind: "not_required", attempted: false };

  const intent = deriveTurnMutationConstraints(input.state.userMessage);
  if (intent.mutationForbidden || !intent.mutationRequested) {
    return rejected(
      toolNames,
      "MODE_MUTATION_INTENT_REQUIRED",
      intent.mutationForbidden
        ? "The current request explicitly forbids mutation, so it cannot enter the resolve gate."
        : "The resolve gate requires explicit mutation-permitting user intent.",
      input.request.targets ?? [],
      ["Stay in an observation mode, or validate a read-only outcome."],
    );
  }
  if (input.alreadyAttempted) {
    return rejected(
      toolNames,
      "MODE_RESOLUTION_UNAVAILABLE",
      "This run has already used its single deterministic binding attempt.",
      input.request.targets ?? [],
      ["Validate a truthful failure or needs-input outcome; do not replay a mutation."],
    );
  }
  if (!input.coordinator) {
    return rejected(
      toolNames,
      "MODE_RESOLUTION_UNAVAILABLE",
      "The deterministic workstream binding coordinator is unavailable.",
      input.request.targets ?? [],
      ["Validate a truthful failure without attempting mutation."],
    );
  }
  if (!input.request.binding) {
    return rejected(
      toolNames,
      "MODE_BINDING_PROPOSAL_REQUIRED",
      "An unbound resolve transition requires one typed activate-or-create binding proposal.",
      input.request.targets ?? [],
      ["Observe workstream ownership, then retry resolve with an exact binding proposal."],
    );
  }

  const proposalRepair = validateBindingProposal(input.state, input.request.binding);
  if (proposalRepair) {
    return { kind: "rejected", attempted: false, toolNames, repair: proposalRepair };
  }

  input.onEvent?.("deterministic_binding_started", {
    tools: toolNames,
    purpose: input.request.purpose,
    targets: input.request.targets ?? [],
    proposal: summarizeProposal(input.request.binding),
  });
  const outcome = await input.coordinator.bind({
    purpose: input.request.purpose,
    targets: input.request.targets ?? [],
    proposal: input.request.binding,
    ...(input.state.harnessContext.contextEngine?.contextRevision
      ? { expectedContextRevision: input.state.harnessContext.contextEngine.contextRevision }
      : {}),
  });
  input.onEvent?.(`deterministic_binding_${outcome.status}`, {
    tools: toolNames,
    outcome: summarizeBindingOutcome(outcome),
  });
  if (outcome.status === "resolved") {
    return { kind: "resolved", attempted: true, toolNames, outcome };
  }
  if (outcome.status === "needs_user_input") {
    return { kind: "needs_user_input", attempted: true, toolNames, outcome };
  }
  return { kind: "failed", attempted: true, toolNames, outcome };
}

export function bindingRequiredToolNames(toolNames: string[]): string[] {
  return [...new Set(toolNames.map((name) => name.trim()).filter((name) => (
    name.length > 0 && requiresWorkstreamBinding(name)
  )))];
}

function validateBindingProposal(
  state: LoopState,
  proposal: WorkstreamBindingProposal,
): VirtualModeRepair | undefined {
  const routing = collectWorkstreamRoutingEvidence(state);
  if (!routing.observed) {
    return createVirtualModeRepair(
      "MODE_BINDING_PROPOSAL_UNVERIFIED",
      "An unbound resolve transition requires a successful current-run workstream or resource routing observation.",
      [],
      ["Use workstream:search, workstream:read, or resource:ownership in an observation mode before resolve."],
    );
  }
  const unknownEvidence = proposal.evidence.filter(
    (reference) => !routing.references.includes(reference),
  );
  if (unknownEvidence.length > 0) {
    return createVirtualModeRepair(
      "MODE_BINDING_PROPOSAL_UNVERIFIED",
      `Binding evidence references were not produced by current-run routing observations: ${unknownEvidence.join(", ")}.`,
      unknownEvidence,
      ["Use exact evidenceRef values returned by the routing tool calls."],
    );
  }
  if (proposal.kind === "create") {
    const knownResourceIds = new Set([
      ...routing.resources.map((resource) => resource.resourceId),
      ...(state.harnessContext.contextEngine?.ingressResources ?? []).map((resource) => resource.resourceId),
    ]);
    const unknownResources = proposal.resources
      .map((resource) => resource.resourceId)
      .filter((resourceId) => !knownResourceIds.has(resourceId));
    if (unknownResources.length > 0) {
      return createVirtualModeRepair(
        "MODE_BINDING_PROPOSAL_UNVERIFIED",
        `Creation resources were not returned by authoritative routing observation: ${unknownResources.join(", ")}.`,
        unknownResources,
        ["Find the resources first, or omit them and let the gate inspect exact path/URL targets."],
      );
    }
    return undefined;
  }

  const observed = routing.workstreams.find(
    (candidate) => candidate.workstreamId === proposal.workstreamId,
  );
  if (!observed) {
    return createVirtualModeRepair(
      "MODE_BINDING_PROPOSAL_UNVERIFIED",
      `The proposed workstream was not returned by current-run workstream search/read evidence: ${proposal.workstreamId}.`,
      [proposal.workstreamId],
      ["Find or read the exact workstream before retrying resolve."],
    );
  }
  if (!observed.head) {
    return createVirtualModeRepair(
      "MODE_BINDING_PROPOSAL_UNVERIFIED",
      "The proposed workstream has no observed authoritative HEAD.",
      [proposal.workstreamId],
      ["Read the exact workstream and use its current HEAD."],
    );
  }
  if (!observed.references.some((reference) => proposal.evidence.includes(reference))) {
    return createVirtualModeRepair(
      "MODE_BINDING_PROPOSAL_UNVERIFIED",
      "The proposal does not cite the routing observation that produced the selected workstream.",
      [proposal.workstreamId],
      ["Include the exact evidenceRef from the selected candidate search/read call."],
    );
  }
  if (observed?.head && observed.head !== proposal.expectedWorkstreamHead) {
    return createVirtualModeRepair(
      "MODE_BINDING_PROPOSAL_UNVERIFIED",
      "The proposed workstream HEAD does not match the latest observed candidate.",
      [proposal.workstreamId],
      ["Read the exact workstream again and use its current HEAD."],
    );
  }
  const exactReasons = new Set([
    "exact_workstream_id",
    "exact_resource_id",
    "owned_resource",
    "direct_continuation",
  ]);
  if (
    observed
    && !observed.inspected
    && !observed.reasons.some((reason) => exactReasons.has(reason))
  ) {
    return createVirtualModeRepair(
      "MODE_BINDING_PROPOSAL_UNVERIFIED",
      "A semantic or recency workstream candidate must be inspected before binding.",
      [proposal.workstreamId],
      ["Use workstream:read for the exact candidate, then retry resolve."],
    );
  }
  if (proposal.requestDecision.kind === "continue") {
    const explicitRequest = state.userMessage.includes(proposal.requestDecision.requestId);
    if (!explicitRequest && !observed?.requestIds.includes(proposal.requestDecision.requestId)) {
      return createVirtualModeRepair(
        "MODE_BINDING_PROPOSAL_UNVERIFIED",
        `The continued request was not explicitly named or returned by workstream inspection: ${proposal.requestDecision.requestId}.`,
        [proposal.requestDecision.requestId],
        ["Inspect the workstream and continue its exact active request, or propose a new request."],
      );
    }
  }
  return undefined;
}

function rejected(
  toolNames: string[],
  code: Parameters<typeof createVirtualModeRepair>[0],
  message: string,
  blockedTargets: string[],
  allowedNextActions: string[],
): DeterministicResolveGateResult {
  return {
    kind: "rejected",
    attempted: false,
    toolNames,
    repair: createVirtualModeRepair(code, message, blockedTargets, allowedNextActions),
  };
}

function summarizeProposal(proposal: WorkstreamBindingProposal): Record<string, unknown> {
  return proposal.kind === "activate"
    ? {
        kind: proposal.kind,
        workstreamId: proposal.workstreamId,
        requestDecision: proposal.requestDecision.kind,
      }
    : {
        kind: proposal.kind,
        title: proposal.title,
        resourceCount: proposal.resources.length,
      };
}

function summarizeBindingOutcome(
  outcome: DeterministicWorkstreamBindingOutcome,
): Record<string, unknown> {
  if (outcome.status === "resolved") {
    return {
      status: outcome.status,
      kind: outcome.kind,
      workstreamId: outcome.workstreamId,
      requestId: outcome.requestId,
      contextRevision: outcome.context.contextRevision,
    };
  }
  if (outcome.status === "needs_user_input") {
    return {
      status: outcome.status,
      question: outcome.question,
      candidateIds: outcome.candidateIds,
    };
  }
  return {
    status: outcome.status,
    code: outcome.code,
    message: outcome.message,
    retryable: outcome.retryable,
  };
}

function isWorkstreamBound(state: LoopState): boolean {
  return state.harnessContext.contextEngine?.current.routing?.status === "bound";
}
