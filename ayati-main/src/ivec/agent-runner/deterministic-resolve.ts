import { isAbsolute } from "node:path";
import {
  canonicalizeAbsoluteFilesystemPath,
  filesystemPathIsWithin,
} from "../../shared/filesystem-paths.js";
import { requiresWorkstreamBinding } from "../../skills/tool-taxonomy.js";
import type { LoopState } from "../types.js";
import type {
  DeterministicWorkstreamBindingOutcome,
  ResolvedWorkstreamWorkspaceTarget,
  WorkstreamBindingCoordinator,
  WorkstreamBindingProposal,
} from "../workstream-binding/contracts.js";
import { resolveWorkstreamWorkspaceTargets } from "../workstream-binding/workspace-targets.js";
import { deriveTurnMutationConstraints } from "./turn-intent-policy.js";
import {
  createVirtualModeRepair,
  modeTransitionReferenceValues,
  modeTransitionTargetValues,
  type ModeTransitionRequest,
  type VirtualModeRepair,
} from "./virtual-mode.js";
import { collectWorkstreamRoutingEvidence } from "./workstream-routing-evidence.js";
import {
  resolveWorkstreamActivationAuthority,
  type WorkstreamActivationAuthority,
} from "./workstream-activation-authority.js";
import { deriveActivatedWorkstreamMutationRoots } from "./activated-workstream-mutation-roots.js";

export type DeterministicResolveGateResult =
  | { kind: "not_required"; attempted: false }
  | {
      kind: "resolved";
      attempted: true;
      attemptConsumed: true;
      toolNames: string[];
      mutationRoots: string[];
      outcome: Extract<DeterministicWorkstreamBindingOutcome, { status: "resolved" }>;
    }
  | {
      kind: "needs_user_input";
      attempted: false;
      toolNames: string[];
      outcome: Extract<DeterministicWorkstreamBindingOutcome, { status: "needs_user_input" }>;
    }
  | {
      kind: "failed";
      attempted: true;
      attemptConsumed: boolean;
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
  workspaceRoot: string;
  toolNames: string[];
  coordinator?: WorkstreamBindingCoordinator;
  alreadyAttempted: boolean;
  onEvent?(event: string, data: Record<string, unknown>): void;
}): Promise<DeterministicResolveGateResult> {
  const toolNames = bindingRequiredToolNames(input.toolNames);
  const targets = modeTransitionTargetValues(input.request);
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
      targets,
      ["Stay in an observation mode, or validate a read-only outcome."],
    );
  }
  if (input.alreadyAttempted) {
    return rejected(
      toolNames,
      "MODE_RESOLUTION_UNAVAILABLE",
      "This run has already used its single deterministic binding attempt.",
      targets,
      ["Validate a truthful failure or needs-input outcome; do not replay a mutation."],
    );
  }
  if (!input.coordinator) {
    return rejected(
      toolNames,
      "MODE_RESOLUTION_UNAVAILABLE",
      "The deterministic workstream binding coordinator is unavailable.",
      targets,
      ["Validate a truthful failure without attempting mutation."],
    );
  }
  if (!input.request.binding) {
    return rejected(
      toolNames,
      "MODE_BINDING_PROPOSAL_REQUIRED",
      "An unbound resolve transition requires one typed workstream/request binding proposal.",
      targets,
      ["Observe ownership, enter workstream.route, then retry resolve with an exact binding proposal."],
    );
  }

  const workspaceTargetResolution = input.request.binding.kind === "create"
    ? await resolveWorkstreamWorkspaceTargets(
        input.request.workspaceTargets ?? [],
        input.workspaceRoot,
      )
    : { ok: true as const, targets: [] };
  if (!workspaceTargetResolution.ok) {
    return rejected(
      toolNames,
      "MODE_INPUT_INVALID",
      workspaceTargetResolution.message,
      workspaceTargetResolution.invalidTargets,
      ["Use typed file or directory paths relative to context.run.workspaceRoot without '.', '..', or absolute prefixes."],
    );
  }
  const routing = collectWorkstreamRoutingEvidence(input.state);
  if (!routing.observed) {
    return rejected(
      toolNames,
      "MODE_BINDING_PROPOSAL_UNVERIFIED",
      "An unbound resolve transition requires a successful current-run workstream or resource routing observation.",
      [],
      ["Return to observe.locate for workstream:search or resource:ownership, or observe.investigate for workstream:read, then re-enter workstream.route."],
    );
  }
  let activationAuthority: WorkstreamActivationAuthority | undefined;
  if (input.request.binding.kind === "activate") {
    const resolved = resolveWorkstreamActivationAuthority({
      state: input.state,
      proposal: input.request.binding,
      routing,
    });
    if (!resolved.ok) {
      return {
        kind: "rejected",
        attempted: false,
        toolNames,
        repair: resolved.repair,
      };
    }
    activationAuthority = resolved.authority;
  }

  const boundaryTargets = input.request.binding.kind === "create"
    ? workspaceTargetResolution.targets.map((target) => target.absolutePath)
    : activationAuthority?.boundaryTargets ?? [];
  const outOfScope = await mutationTargetsOutsideUserBoundary(
    boundaryTargets,
    intent.scopePolicy,
  );
  if (outOfScope.length > 0) {
    return rejected(
      toolNames,
      "MODE_MUTATION_INTENT_REQUIRED",
      `Mutation targets exceed the user's explicit boundary: ${outOfScope.join(", ")}.`,
      outOfScope,
      ["Use only exact routed resources or workspace targets inside the path explicitly authorized by the user."],
    );
  }

  const mutationScopes = activationAuthority?.resourceIds ?? [];
  const routingEvidence = activationAuthority?.routingEvidence ?? routing.references;
  input.onEvent?.("deterministic_binding_started", {
    tools: toolNames,
    purpose: input.request.purpose,
    referenceTargets: modeTransitionReferenceValues(input.request),
    mutationScopes: input.request.binding.kind === "create"
      ? workspaceTargetResolution.targets.map((target) => target.absolutePath)
      : mutationScopes,
    workspaceTargets: workspaceTargetResolution.targets,
    proposal: summarizeProposal(input.request.binding, workspaceTargetResolution.targets),
  });
  const outcome = await input.coordinator.bind({
    purpose: input.request.purpose,
    workspaceTargets: workspaceTargetResolution.targets,
    routingEvidence,
    proposal: input.request.binding,
    ...(activationAuthority
      ? { expectedWorkstreamHead: activationAuthority.expectedWorkstreamHead }
      : {}),
    ...(input.state.harnessContext.contextEngine?.contextRevision
      ? { expectedContextRevision: input.state.harnessContext.contextEngine.contextRevision }
      : {}),
  });
  input.onEvent?.(`deterministic_binding_${outcome.status}`, {
    tools: toolNames,
    outcome: summarizeBindingOutcome(outcome),
  });
  if (outcome.status === "resolved") {
    const activatedMutationRoots = input.request.binding.kind === "activate"
      ? deriveActivatedWorkstreamMutationRoots({
          context: outcome.context,
          workstreamId: outcome.workstreamId,
        })
      : [];
    const candidateMutationRoots = input.request.binding.kind === "create"
      ? workspaceTargetResolution.targets.map((target) => target.absolutePath)
      : activatedMutationRoots.length > 0
        ? activatedMutationRoots
        : activationAuthority?.filesystemPaths ?? [];
    const allowedMutationRoots = await mutationTargetsInsideUserBoundary(
      candidateMutationRoots,
      intent.scopePolicy,
    );
    return {
      kind: "resolved",
      attempted: true,
      attemptConsumed: true,
      toolNames,
      mutationRoots: allowedMutationRoots,
      outcome,
    };
  }
  if (outcome.status === "needs_user_input") {
    return { kind: "needs_user_input", attempted: false, toolNames, outcome };
  }
  return {
    kind: "failed",
    attempted: true,
    attemptConsumed:
      !outcome.retryable || outcome.attemptDisposition !== "retryable_no_change",
    toolNames,
    outcome,
  };
}

export function bindingRequiredToolNames(toolNames: string[]): string[] {
  return [...new Set(toolNames.map((name) => name.trim()).filter((name) => (
    name.length > 0 && requiresWorkstreamBinding(name)
  )))];
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

function summarizeProposal(
  proposal: WorkstreamBindingProposal,
  workspaceTargets: ResolvedWorkstreamWorkspaceTarget[],
): Record<string, unknown> {
  return proposal.kind === "activate"
    ? {
        kind: proposal.kind,
        workstreamId: proposal.workstreamId,
        requestDecision: proposal.requestDecision.kind,
        resourceIds: proposal.resourceIds,
      }
    : {
        kind: proposal.kind,
        title: proposal.title,
        workspaceTargets: workspaceTargets.map((target) => ({
          kind: target.kind,
          relativePath: target.relativePath,
        })),
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
    attemptDisposition: outcome.attemptDisposition,
  };
}

function isWorkstreamBound(state: LoopState): boolean {
  return state.harnessContext.contextEngine?.current.routing?.status === "bound";
}

async function mutationTargetsOutsideUserBoundary(
  targets: string[],
  policy: ReturnType<typeof deriveTurnMutationConstraints>["scopePolicy"],
): Promise<string[]> {
  if (!policy.denyOutsideAllowedScopes || policy.allowedScopes.length === 0) return [];
  const allowedScopes = (await Promise.all(policy.allowedScopes
    .filter(isAbsolute)
    .map(async (allowed) => {
      try {
        return await canonicalizeAbsoluteFilesystemPath(allowed);
      } catch {
        return undefined;
      }
    }))).filter((allowed): allowed is Awaited<
      ReturnType<typeof canonicalizeAbsoluteFilesystemPath>
    > => allowed !== undefined);
  const decisions = await Promise.all(targets.map(async (scope) => {
    if (!isAbsolute(scope)) return { scope, outside: true };
    try {
      const canonical = await canonicalizeAbsoluteFilesystemPath(scope);
      return {
        scope,
        outside: !allowedScopes.some((allowed) => filesystemPathIsWithin(allowed, canonical)),
      };
    } catch {
      return { scope, outside: true };
    }
  }));
  return decisions.filter((decision) => decision.outside).map((decision) => decision.scope);
}

async function mutationTargetsInsideUserBoundary(
  targets: string[],
  policy: ReturnType<typeof deriveTurnMutationConstraints>["scopePolicy"],
): Promise<string[]> {
  const outside = new Set(await mutationTargetsOutsideUserBoundary(targets, policy));
  return targets.filter((target) => !outside.has(target));
}
