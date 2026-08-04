import type { WorkstreamBindingProposal } from "../workstream-binding/contracts.js";
import {
  createVirtualModeRepair,
  type VirtualModeRepair,
} from "./virtual-mode.js";
import type { WorkstreamRoutingEvidence } from "./workstream-routing-evidence.js";

type ActivationProposal = Extract<WorkstreamBindingProposal, { kind: "activate" }>;

export interface WorkstreamActivationAuthority {
  expectedWorkstreamHead: string;
  resourceIds: string[];
  routingEvidence: string[];
}

export type WorkstreamActivationAuthorityResult =
  | {
      ok: true;
      authority: WorkstreamActivationAuthority;
    }
  | {
      ok: false;
      repair: VirtualModeRepair;
    };

export function resolveWorkstreamActivationAuthority(input: {
  proposal: ActivationProposal;
  routing: WorkstreamRoutingEvidence;
}): WorkstreamActivationAuthorityResult {
  const observed = input.routing.workstreams.find(
    (candidate) => candidate.workstreamId === input.proposal.workstreamId,
  );
  if (!observed) {
    return rejected(
      `The proposed workstream was not returned by current-run workstream search/read evidence: ${input.proposal.workstreamId}.`,
      [input.proposal.workstreamId],
      ["Find or read the exact workstream before retrying resolve."],
    );
  }
  if (!observed.head) {
    return rejected(
      "The selected workstream has no observed authoritative HEAD.",
      [input.proposal.workstreamId],
      ["Read the exact workstream again; the runtime will derive its current HEAD."],
    );
  }
  const exactReasons = new Set([
    "exact_workstream_id",
    "exact_resource_id",
    "owned_resource",
  ]);
  if (
    !observed.inspected
    && !observed.reasons.some((reason) => exactReasons.has(reason))
  ) {
    return rejected(
      "A semantic or recency workstream candidate must be inspected before binding.",
      [input.proposal.workstreamId],
      [
        "Inspect the exact workstream and compare its request contracts before choosing a lifecycle operation.",
      ],
    );
  }

  const requestIds = requestDecisionEvidenceIds(input.proposal.requestDecision);
  if (!requestIds) {
    return rejected(
      "The binding proposal contains an unsupported request lifecycle operation.",
      [],
      ["Use one request lifecycle operation advertised by the current resolve schema."],
    );
  }
  for (const requestId of requestIds) {
    if (!observed.requestIds.includes(requestId)) {
      return rejected(
        `The selected request was not returned by current-run workstream evidence: ${requestId}.`,
        [requestId],
        [
          `Use git_context_read_workstream to read ${input.proposal.workstreamId} and request ${requestId} in this run, then choose only a lifecycle operation permitted by its observed status.`,
        ],
      );
    }
  }

  const selectedResources = input.proposal.resourceIds.map((resourceId) => ({
    resourceId,
    observed: input.routing.resources.find(
      (resource) => resource.resourceId === resourceId,
    ),
  }));
  const missing = selectedResources
    .filter((selection) => !selection.observed)
    .map((selection) => selection.resourceId);
  if (missing.length > 0) {
    return rejected(
      `Selected resources were not returned by current-run routing: ${missing.join(", ")}.`,
      missing,
      ["Find the exact resource owner, then retry with only returned resource IDs."],
    );
  }
  const wrongOwner = selectedResources
    .filter((selection) => (
      !selection.observed!.workstreamIds.includes(input.proposal.workstreamId)
    ))
    .map((selection) => selection.resourceId);
  if (wrongOwner.length > 0) {
    return rejected(
      `Selected resources are not owned by ${input.proposal.workstreamId}: ${wrongOwner.join(", ")}.`,
      wrongOwner,
      ["Use resources whose routing result names the selected workstream as owner."],
    );
  }

  return {
    ok: true,
    authority: {
      expectedWorkstreamHead: observed.head,
      resourceIds: [...input.proposal.resourceIds],
      routingEvidence: uniqueStrings([
        ...observed.references,
        ...selectedResources.flatMap(
          (selection) => selection.observed!.references,
        ),
      ]),
    },
  };
}

function requestDecisionEvidenceIds(
  decision: ActivationProposal["requestDecision"],
): string[] | undefined {
  switch (decision.kind) {
    case "continue_current":
    case "activate_existing":
    case "resume_blocked":
      return [decision.requestId];
    case "amend_current":
    case "defer_current_and_create":
      return [decision.currentRequestId];
    case "defer_current_and_activate_existing":
      return [decision.currentRequestId, decision.nextRequestId];
    case "create_and_activate":
    case "create_queued":
      return [];
  }
  return undefined;
}

function rejected(
  message: string,
  blockedTargets: string[],
  allowedNextActions: string[],
): WorkstreamActivationAuthorityResult {
  return {
    ok: false,
    repair: createVirtualModeRepair(
      "MODE_BINDING_PROPOSAL_UNVERIFIED",
      message,
      blockedTargets,
      allowedNextActions,
    ),
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
