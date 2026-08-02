import type {
  ContextEngineService,
  WorkstreamCandidate,
  WorkstreamRequestRoute,
} from "ayati-context-engine";
import { ContextEngineServiceError } from "ayati-context-engine";
import { buildContextEngineProjection } from "../../context-engine/index.js";
import type {
  DeterministicWorkstreamBindingRequest,
  DeterministicWorkstreamBindingOutcome,
  WorkstreamBindingCoordinator,
} from "./contracts.js";

export interface WorkstreamBindingCoordinatorOptions {
  service: ContextEngineService;
  runId: string;
  streamId: string;
  currentInput: string;
  now?: () => Date;
}

export function createWorkstreamBindingCoordinator(
  options: WorkstreamBindingCoordinatorOptions,
): WorkstreamBindingCoordinator {
  return {
    bind: async (request) => await bindWorkstream(options, request),
  };
}

async function bindWorkstream(
  options: WorkstreamBindingCoordinatorOptions,
  request: DeterministicWorkstreamBindingRequest,
): Promise<DeterministicWorkstreamBindingOutcome> {
  try {
    const current = await options.service.getAgentContext({
      streamId: options.streamId,
      currentText: options.currentInput,
    });
    if (
      request.expectedContextRevision
      && current.contextRevision !== request.expectedContextRevision
    ) {
      return failed(
        "WORKSTREAM_BINDING_CONTEXT_STALE",
        `Authoritative context changed before binding: expected ${request.expectedContextRevision}, received ${current.contextRevision}.`,
        true,
      );
    }
    if (current.run?.run.runId !== options.runId) {
      return failed(
        "WORKSTREAM_BINDING_RUN_STALE",
        "The deterministic binding gate no longer owns the active run.",
        false,
      );
    }
    if (current.run.run.workstreamBinding) {
      return resolvedFromCurrent(current, "activated_workstream");
    }

    return request.proposal.kind === "activate"
      ? await activateExistingWorkstream(options, request)
      : await createWorkstream(options, request);
  } catch (error) {
    return bindingFailure(error);
  }
}

async function activateExistingWorkstream(
  options: WorkstreamBindingCoordinatorOptions,
  request: DeterministicWorkstreamBindingRequest,
): Promise<DeterministicWorkstreamBindingOutcome> {
  if (request.proposal.kind !== "activate") {
    return failed("WORKSTREAM_BINDING_PROPOSAL_INVALID", "Expected an activation proposal.", false);
  }
  const proposal = request.proposal;
  const expectedWorkstreamHead = request.expectedWorkstreamHead?.trim();
  if (!expectedWorkstreamHead) {
    return failed(
      "WORKSTREAM_BINDING_HEAD_REQUIRED",
      "Existing-workstream activation requires a runtime-derived observed HEAD.",
      false,
    );
  }
  const discovered = await options.service.findWorkstreams({
    query: proposal.workstreamId,
    streamId: options.streamId,
    currentText: options.currentInput,
    includeArchived: false,
    limit: 5,
  });
  const candidate = discovered.workstreams.find(
    (item) => item.workstreamId === proposal.workstreamId,
  );
  if (!candidate) {
    return failed(
      "WORKSTREAM_BINDING_CANDIDATE_MISSING",
      `The proposed workstream is not an authoritative current candidate: ${proposal.workstreamId}.`,
      false,
    );
  }
  if (candidate.head !== expectedWorkstreamHead) {
    return failed(
      "WORKSTREAM_BINDING_HEAD_MISMATCH",
      "The proposed workstream changed after it was observed. Inspect it again before binding.",
      true,
    );
  }
  const resourceFailure = await validateActivationResources(
    options.service,
    proposal.workstreamId,
    proposal.resourceIds,
  );
  if (resourceFailure) return resourceFailure;

  const selected = await options.service.activateWorkstreamForRun({
    requestId: `${options.runId}:deterministic-bind`,
    runId: options.runId,
    workstreamId: proposal.workstreamId,
    expectedWorkstreamHead,
    route: requestRoute(proposal.requestDecision),
    at: (options.now ?? (() => new Date()))().toISOString(),
  });
  const context = await options.service.getAgentContext({
    streamId: options.streamId,
    currentText: options.currentInput,
  });
  const binding = selected.run.workstreamBinding;
  if (!binding) {
    return failed(
      "WORKSTREAM_BINDING_ACKNOWLEDGEMENT_MISSING",
      "Context Engine selected a workstream without returning an authoritative run binding.",
      false,
    );
  }
  return {
    status: "resolved",
    kind: "activated_workstream",
    workstreamId: binding.workstreamId,
    requestId: binding.requestId,
    context: buildContextEngineProjection(context),
  };
}

async function validateActivationResources(
  service: ContextEngineService,
  workstreamId: string,
  resourceIds: string[],
): Promise<
  Extract<DeterministicWorkstreamBindingOutcome, { status: "failed" }> | undefined
> {
  if (resourceIds.length === 0) {
    return failed(
      "WORKSTREAM_BINDING_TARGET_REQUIRED",
      "Existing-workstream activation requires at least one exact routed resource.",
      false,
    );
  }
  const invalid = resourceIds.filter(
    (resourceId) => !/^RES-[0-9A-F]{24}$/.test(resourceId),
  );
  if (invalid.length > 0) {
    return failed(
      "WORKSTREAM_BINDING_RESOURCE_INVALID",
      `Activation resources must use exact resource IDs: ${invalid.join(", ")}.`,
      false,
    );
  }
  const current = await service.getWorkstream({ workstreamId });
  const bindings = current.context?.resources ?? [];
  for (const resourceId of resourceIds) {
    const binding = bindings.find(
      (candidate) => candidate.resource.resourceId === resourceId,
    );
    if (!binding) {
      return failed(
        "WORKSTREAM_BINDING_RESOURCE_OWNER_MISMATCH",
        `The selected resource is not bound to ${workstreamId}: ${resourceId}.`,
        false,
      );
    }
    if (binding.access !== "mutate") {
      return failed(
        "WORKSTREAM_BINDING_RESOURCE_NOT_MUTABLE",
        `The selected resource is bound read-only: ${resourceId}.`,
        false,
      );
    }
    if (
      binding.resource.availability === "missing"
      || binding.resource.availability === "deleted"
    ) {
      return failed(
        "WORKSTREAM_BINDING_RESOURCE_MISSING",
        `The selected mutation resource is unavailable: ${resourceId}.`,
        false,
      );
    }
  }
  return undefined;
}

async function createWorkstream(
  options: WorkstreamBindingCoordinatorOptions,
  request: DeterministicWorkstreamBindingRequest,
): Promise<DeterministicWorkstreamBindingOutcome> {
  if (request.proposal.kind !== "create") {
    return failed("WORKSTREAM_BINDING_PROPOSAL_INVALID", "Expected a creation proposal.", false);
  }
  if (request.routingEvidence.length === 0) {
    return failed(
      "WORKSTREAM_BINDING_ROUTING_EVIDENCE_REQUIRED",
      "New workstream creation requires a successful current-run routing observation.",
      false,
    );
  }
  const ownershipConflicts = (await options.service.findWorkstreams({
    query: "",
    paths: request.workspaceTargets.map((target) => target.absolutePath),
    streamId: options.streamId,
    currentText: "",
    includeArchived: false,
    limit: 50,
  })).workstreams.filter(hasOwnedResourceReason).slice(0, 3);
  if (ownershipConflicts.length > 0) {
    return {
      status: "needs_user_input",
      question: targetOwnershipQuestion(ownershipConflicts),
      candidateIds: ownershipConflicts.map((candidate) => candidate.workstreamId),
    };
  }

  const now = (options.now ?? (() => new Date()))().toISOString();
  const selected = await options.service.createWorkstreamForRun({
    requestId: `${options.runId}:deterministic-bind`,
    runId: options.runId,
    title: request.proposal.title,
    objective: request.proposal.objective,
    initialRequest: request.proposal.initialRequest,
    at: now,
  });
  const context = await options.service.getAgentContext({
    streamId: options.streamId,
    currentText: options.currentInput,
  });
  const binding = selected.run.workstreamBinding;
  if (!binding) {
    return failed(
      "WORKSTREAM_BINDING_ACKNOWLEDGEMENT_MISSING",
      "Context Engine created a workstream without returning an authoritative run binding.",
      false,
    );
  }
  return {
    status: "resolved",
    kind: "created_workstream",
    workstreamId: binding.workstreamId,
    requestId: binding.requestId,
    context: buildContextEngineProjection(context),
  };
}

function resolvedFromCurrent(
  context: Awaited<ReturnType<ContextEngineService["getAgentContext"]>>,
  kind: "activated_workstream" | "created_workstream",
): DeterministicWorkstreamBindingOutcome {
  const binding = context.run?.run.workstreamBinding;
  if (!binding) {
    return failed(
      "WORKSTREAM_BINDING_ACKNOWLEDGEMENT_MISSING",
      "The active context did not contain an authoritative binding.",
      false,
    );
  }
  return {
    status: "resolved",
    kind,
    workstreamId: binding.workstreamId,
    requestId: binding.requestId,
    context: buildContextEngineProjection(context),
  };
}

function requestRoute(
  decision: Extract<DeterministicWorkstreamBindingRequest["proposal"], { kind: "activate" }>["requestDecision"],
): WorkstreamRequestRoute {
  return structuredClone(decision);
}

function hasOwnedResourceReason(candidate: WorkstreamCandidate): boolean {
  return candidate.discovery.reasons.includes("owned_resource");
}

function targetOwnershipQuestion(candidates: WorkstreamCandidate[]): string {
  const choices = candidates
    .map((candidate) => `“${candidate.title}” (${candidate.workstreamId})`)
    .join(", ");
  return `The selected workspace target is already owned by ${choices}. Should I use that workstream, or should I use a different target for the new workstream?`;
}

function bindingFailure(error: unknown): DeterministicWorkstreamBindingOutcome {
  if (error instanceof ContextEngineServiceError) {
    return failed(
      error.code,
      error.message,
      error.retryable,
      error.retryable
        && error.details?.["attemptDisposition"] === "retryable_no_change"
        ? "retryable_no_change"
        : "consumed",
    );
  }
  return failed(
    "WORKSTREAM_BINDING_FAILED",
    error instanceof Error ? error.message : String(error),
    false,
  );
}

function failed(
  code: string,
  message: string,
  retryable: boolean,
  attemptDisposition: "consumed" | "retryable_no_change" = "consumed",
): Extract<DeterministicWorkstreamBindingOutcome, { status: "failed" }> {
  return {
    status: "failed",
    code,
    message,
    retryable,
    attemptDisposition,
  };
}
