import type {
  ContextEngineService,
  ResourcePublicLocator,
  WorkstreamCandidate,
  WorkstreamRequestRoute,
} from "ayati-context-engine";
import { ContextEngineServiceError } from "ayati-context-engine";
import { isAbsolute } from "node:path";
import { buildContextEngineProjection } from "../../context-engine/index.js";
import type {
  DeterministicWorkstreamBindingRequest,
  DeterministicWorkstreamBindingOutcome,
  WorkstreamBindingCoordinator,
  WorkstreamResourceBindingProposal,
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
  if (candidate.head !== proposal.expectedWorkstreamHead) {
    return failed(
      "WORKSTREAM_BINDING_HEAD_MISMATCH",
      "The proposed workstream changed after it was observed. Inspect it again before binding.",
      true,
    );
  }

  const selected = await options.service.activateWorkstreamForRun({
    requestId: `${options.runId}:deterministic-bind`,
    runId: options.runId,
    workstreamId: proposal.workstreamId,
    expectedWorkstreamHead: proposal.expectedWorkstreamHead,
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

async function createWorkstream(
  options: WorkstreamBindingCoordinatorOptions,
  request: DeterministicWorkstreamBindingRequest,
): Promise<DeterministicWorkstreamBindingOutcome> {
  if (request.proposal.kind !== "create") {
    return failed("WORKSTREAM_BINDING_PROPOSAL_INVALID", "Expected a creation proposal.", false);
  }
  const candidates = await options.service.findWorkstreams({
    query: options.currentInput,
    paths: request.targets.filter(isAbsolute),
    streamId: options.streamId,
    currentText: options.currentInput,
    includeArchived: false,
    limit: 12,
  });
  const strong = candidates.workstreams.filter(isStrongCandidate).slice(0, 3);
  if (strong.length > 0) {
    return {
      status: "needs_user_input",
      question: bindingAmbiguityQuestion(strong),
      candidateIds: strong.map((candidate) => candidate.workstreamId),
    };
  }

  const now = (options.now ?? (() => new Date()))().toISOString();
  const resources = await resolveCreationResources(options, request, now);
  if ("status" in resources) return resources;
  const selected = await options.service.createWorkstreamForRun({
    requestId: `${options.runId}:deterministic-bind`,
    runId: options.runId,
    title: request.proposal.title,
    objective: request.proposal.objective,
    initialRequest: request.proposal.initialRequest,
    ...(resources.bindings.length > 0 ? { resources: resources.bindings } : {}),
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

async function resolveCreationResources(
  options: WorkstreamBindingCoordinatorOptions,
  request: DeterministicWorkstreamBindingRequest,
  at: string,
): Promise<
  | { bindings: WorkstreamResourceBindingProposal[] }
  | Extract<DeterministicWorkstreamBindingOutcome, { status: "failed" }>
> {
  if (request.proposal.kind !== "create") {
    return failed("WORKSTREAM_BINDING_PROPOSAL_INVALID", "Expected creation resources.", false);
  }
  const bindings = new Map<string, WorkstreamResourceBindingProposal>();
  for (const resource of request.proposal.resources) bindings.set(resource.resourceId, resource);

  const locators = request.targets.flatMap(targetLocator).slice(0, 8);
  for (const [index, locator] of locators.entries()) {
    const inspected = await options.service.inspectResourceForRun({
      requestId: `${options.runId}:deterministic-bind:inspect:${index + 1}`,
      runId: options.runId,
      locator,
      origin: "user_reference",
      at,
    });
    if (!inspected.mutationEligible) {
      return failed(
        "WORKSTREAM_BINDING_RESOURCE_NOT_MUTABLE",
        `The requested resource cannot be bound for mutation: ${displayLocator(locator)}.`,
        false,
      );
    }
    if (!bindings.has(inspected.resource.resourceId)) {
      bindings.set(inspected.resource.resourceId, {
        resourceId: inspected.resource.resourceId,
        role: "primary",
        access: "mutate",
        primary: bindings.size === 0,
      });
    }
  }
  return { bindings: [...bindings.values()].slice(0, 8) };
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
  return decision.kind === "continue"
    ? {
        kind: "continue_active_request",
        requestId: decision.requestId,
        reason: decision.reason,
      }
    : {
        kind: "create_active_request",
        title: decision.title,
        request: decision.request,
        acceptance: decision.acceptance,
        constraints: decision.constraints,
        reason: decision.reason,
      };
}

function targetLocator(target: string): ResourcePublicLocator[] {
  const normalized = target.trim();
  if (isAbsolute(normalized)) return [{ kind: "filesystem", path: normalized }];
  if (/^https?:\/\//i.test(normalized)) {
    try {
      return [{ kind: "url", url: new URL(normalized).toString() }];
    } catch {
      return [];
    }
  }
  return [];
}

function displayLocator(locator: ResourcePublicLocator): string {
  if (locator.kind === "filesystem") return locator.path;
  if (locator.kind === "url") return locator.url;
  if (locator.kind === "managed_blob") return locator.resourceId;
  return locator.uri ?? `${locator.provider}:${locator.externalId}`;
}

function isStrongCandidate(candidate: WorkstreamCandidate): boolean {
  return candidate.discovery.tier === "probable" || candidate.discovery.tier === "definite";
}

function bindingAmbiguityQuestion(candidates: WorkstreamCandidate[]): string {
  const choices = candidates.map((candidate) => `${candidate.workstreamId} (${candidate.title})`).join(", ");
  return `Existing workstream ownership may match this request: ${choices}. Which workstream should own the change?`;
}

function bindingFailure(error: unknown): DeterministicWorkstreamBindingOutcome {
  if (error instanceof ContextEngineServiceError) {
    return failed(error.code, error.message, error.retryable);
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
): Extract<DeterministicWorkstreamBindingOutcome, { status: "failed" }> {
  return { status: "failed", code, message, retryable };
}
