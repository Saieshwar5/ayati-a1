import type { LoopState } from "../types.js";
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
  filesystemPaths: string[];
  boundaryTargets: string[];
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
  state: LoopState;
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
  if (input.proposal.resourceIds.length === 0) {
    return rejected(
      "Existing-workstream activation requires at least one exact resource returned by current-run routing.",
      [],
      ["Find the resource owner, then provide its exact resource ID."],
    );
  }

  const exactReasons = new Set([
    "exact_workstream_id",
    "exact_resource_id",
    "owned_resource",
    "direct_continuation",
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
    const explicitlyNamed = input.state.userMessage.includes(requestId);
    if (!explicitlyNamed && !observed.requestIds.includes(requestId)) {
      return rejected(
        `The exact active request was not explicitly named or returned by workstream inspection: ${requestId}.`,
        [requestId],
        [
          "Inspect the exact request and choose only a lifecycle operation permitted by its observed status.",
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
      filesystemPaths: uniqueStrings(selectedResources.flatMap(
        (selection) => selection.observed!.filesystemPaths,
      )),
      boundaryTargets: uniqueStrings(selectedResources.flatMap(
        (selection) => selection.observed!.filesystemPaths.length > 0
          ? selection.observed!.filesystemPaths
          : [selection.resourceId],
      )),
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
