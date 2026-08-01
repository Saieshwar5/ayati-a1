import { correctLocalInputTokenEstimate } from "../../prompt/context-token-counter.js";
import { estimateTextTokens } from "../../prompt/token-estimator.js";
import { canonicalHash } from "../context-preparation/canonical.js";
import type { WorkState } from "../types.js";
import type {
  PromptRunToolCallContext,
  PromptRunToolCallMode,
  PromptToolCalls,
} from "./run-tool-call-context.js";
import type {
  RunContextMaintenancePlan,
  RunContextMaintenancePlanEntry,
  RunContextMaintenanceSelection,
  RunContextProjectionOverlay,
} from "./run-context-maintenance-contracts.js";
import { RUN_CONTEXT_MAINTENANCE_LIMITS } from "./run-context-maintenance-contracts.js";
import {
  projectToolCallForPressure,
  toolContextCompactionPolicy,
} from "./tool-context-projectors/registry.js";

const HOT_CALL_COUNT = 6;
const PROTECTED_REF_LIMIT = 20;
const ACTIVE_PROCESS_TOOLS = new Set([
  "process_start",
  "process_poll",
  "process_send_input",
]);

export interface AppliedRunContextMaintenance {
  projectedCalls: PromptToolCalls;
  overlay: RunContextProjectionOverlay;
  transformations: Array<{
    ref: string;
    tool: string;
    from: PromptRunToolCallMode;
    to: PromptRunToolCallMode;
  }>;
}

export function buildRunContextMaintenancePlan(input: {
  calls: PromptToolCalls;
  currentOverlay?: RunContextProjectionOverlay;
  workState: WorkState;
  workStateRevision: number;
  candidateInputTokens: number;
  recoveryTargetTokens: number;
}): RunContextMaintenancePlan {
  const sourceHash = sourceHashForCalls(input.calls);
  const sourceThroughStep = input.calls.reduce((maximum, call) => Math.max(maximum, call.step), 0);
  const requiredSavingsTokens = Math.max(
    0,
    input.candidateInputTokens - input.recoveryTargetTokens,
  );
  const hotStart = Math.max(0, input.calls.length - HOT_CALL_COUNT);
  const workStateRefs = new Set(
    input.workState.importantContext.flatMap((item) => item.ref ? [item.ref] : []),
  );
  const currentCalls = applyRunContextProjectionOverlay(input.calls, input.currentOverlay);
  const entries = input.calls.map((call, index) => buildEntry({
    call,
    currentCall: currentCalls[index] ?? call,
    index,
    hotStart,
    workStateRefs,
  }));
  const candidates = entries.filter((entry) => (
    !entry.mandatoryExact
    && entry.policy !== "exact_only"
    && (
      entry.estimatedRecommendedTokens < entry.estimatedCurrentTokens
      || (
        entry.policy === "referenceable"
        && estimateCall(projectCall(input.calls[entry.index]!, "reference"))
          < entry.estimatedCurrentTokens
      )
    )
  ));
  const inventory = candidates
    .slice(0, RUN_CONTEXT_MAINTENANCE_LIMITS.inventoryItems)
    .map(toCandidate);
  const maintenanceId = `RUNCTX-${canonicalHash({
    sourceHash,
    sourceThroughStep,
    workStateRevision: input.workStateRevision,
    requiredSavingsTokens,
  }).slice(7, 31).toUpperCase()}`;

  return {
    schemaVersion: 1,
    maintenanceId,
    sourceHash,
    sourceThroughStep,
    expectedWorkStateRevision: input.workStateRevision,
    candidateInputTokens: input.candidateInputTokens,
    recoveryTargetTokens: input.recoveryTargetTokens,
    requiredSavingsTokens,
    inventory,
    omittedCandidateCount: Math.max(0, candidates.length - inventory.length),
    protectedRefs: entries
      .filter((entry) => entry.mandatoryExact)
      .map((entry) => entry.ref)
      .slice(-PROTECTED_REF_LIMIT),
    entries,
  };
}

export function hasRunContextMaintenanceOpportunity(
  plan: RunContextMaintenancePlan,
  currentOverlay?: RunContextProjectionOverlay,
): boolean {
  if (plan.requiredSavingsTokens <= 0 || plan.inventory.length === 0) return false;
  return currentOverlay?.sourceHash !== plan.sourceHash
    || currentOverlay.sourceThroughStep < plan.sourceThroughStep;
}

export function applyRunContextMaintenanceSelection(input: {
  plan: RunContextMaintenancePlan;
  calls: PromptToolCalls;
  currentOverlay?: RunContextProjectionOverlay;
  selection: RunContextMaintenanceSelection;
  persistedWorkStateRevision: number;
  iteration: number;
}): AppliedRunContextMaintenance {
  validateSelection(input.plan, input.calls, input.selection);
  const currentCalls = applyRunContextProjectionOverlay(input.calls, input.currentOverlay);
  const modes = new Map<string, PromptRunToolCallMode>();
  for (const entry of input.plan.entries) modes.set(entry.ref, entry.currentMode);

  const keepExact = new Set(input.selection.keepExactRefs);
  const keepCompact = new Set(input.selection.keepCompactRefs);
  const release = new Set(input.selection.releaseRefs);
  for (const entry of input.plan.entries) {
    if (entry.mandatoryExact || keepExact.has(entry.ref)) {
      modes.set(entry.ref, "full");
    } else if (keepCompact.has(entry.ref)) {
      modes.set(entry.ref, "preview");
    } else if (release.has(entry.ref)) {
      modes.set(entry.ref, "reference");
    }
  }

  let projectedCalls = projectCalls(input.calls, input.plan.entries, modes);
  let estimatedSavingsTokens = estimateCalls(currentCalls) - estimateCalls(projectedCalls);
  const explicit = new Set([
    ...input.selection.keepExactRefs,
    ...input.selection.keepCompactRefs,
    ...input.selection.releaseRefs,
  ]);
  const defaultCandidates = input.plan.entries
    .filter((entry) => !entry.mandatoryExact && !explicit.has(entry.ref))
    .map((entry) => ({
      entry,
      savings: savingsForMode(input.calls[entry.index]!, modes.get(entry.ref) ?? "full", entry.recommendedMode),
    }))
    .filter((candidate) => candidate.savings > 0)
    .sort(compareCandidates);

  for (const candidate of defaultCandidates) {
    if (estimatedSavingsTokens >= input.plan.requiredSavingsTokens) break;
    modes.set(candidate.entry.ref, candidate.entry.recommendedMode);
    estimatedSavingsTokens += candidate.savings;
  }

  projectedCalls = projectCalls(input.calls, input.plan.entries, modes);
  estimatedSavingsTokens = estimateCalls(currentCalls) - estimateCalls(projectedCalls);

  if (estimatedSavingsTokens < input.plan.requiredSavingsTokens) {
    const referenceCandidates = input.plan.entries
      .filter((entry) => (
        entry.policy === "projectable"
        && !entry.mandatoryExact
        && !explicit.has(entry.ref)
        && modes.get(entry.ref) !== "reference"
      ))
      .map((entry) => ({
        entry,
        savings: savingsForMode(
          input.calls[entry.index]!,
          modes.get(entry.ref) ?? "full",
          "reference",
        ),
      }))
      .filter((candidate) => candidate.savings > 0)
      .sort(compareCandidates);
    for (const candidate of referenceCandidates) {
      if (estimatedSavingsTokens >= input.plan.requiredSavingsTokens) break;
      modes.set(candidate.entry.ref, "reference");
      estimatedSavingsTokens += candidate.savings;
    }
    projectedCalls = projectCalls(input.calls, input.plan.entries, modes);
    estimatedSavingsTokens = estimateCalls(currentCalls) - estimateCalls(projectedCalls);
  }

  const modesByRef = Object.fromEntries(
    input.plan.entries
      .map((entry) => [entry.ref, modes.get(entry.ref) ?? "full"] as const)
      .filter(([, mode]) => mode !== "full"),
  );
  const transformations = input.plan.entries.flatMap((entry) => {
    const from = entry.currentMode;
    const to = modes.get(entry.ref) ?? "full";
    return from === to ? [] : [{ ref: entry.ref, tool: entry.tool, from, to }];
  });
  return {
    projectedCalls,
    overlay: {
      schemaVersion: 1,
      revision: (input.currentOverlay?.revision ?? 0) + 1,
      sourceHash: input.plan.sourceHash,
      sourceThroughStep: input.plan.sourceThroughStep,
      workStateRevision: input.persistedWorkStateRevision,
      modesByRef,
      requiredSavingsTokens: input.plan.requiredSavingsTokens,
      estimatedSavingsTokens: Math.max(0, estimatedSavingsTokens),
      targetReached: estimatedSavingsTokens >= input.plan.requiredSavingsTokens,
      maintainedAtIteration: input.iteration,
    },
    transformations,
  };
}

export function applyRunContextProjectionOverlay(
  calls: PromptToolCalls,
  overlay: RunContextProjectionOverlay | undefined,
): PromptToolCalls {
  if (!overlay) return calls.map((call) => ({ ...call }));
  return calls.map((call, index) => {
    const ref = toolCallContextRef(call, index);
    const mode = ref ? overlay.modesByRef[ref] : undefined;
    return projectCall(call, mode ?? "full");
  });
}

export function sourceHashForCalls(calls: PromptToolCalls): string {
  return canonicalHash(calls.map((call, index) => ({
    ref: toolCallContextRef(call, index),
    step: call.step,
    callId: call.callId,
    tool: call.tool,
    purpose: call.purpose,
    input: call.input,
    status: call.status,
    output: call.output,
    error: call.error,
    code: call.code,
    operationStatus: call.operationStatus,
    artifacts: call.artifacts,
    evidenceRef: call.evidenceRef,
    verificationStatus: call.verificationStatus,
  })));
}

export function toolCallContextRef(
  call: PromptRunToolCallContext,
  index: number,
): string | undefined {
  if (call.callId) return `call:${call.callId}`;
  if (!call.stepRef && !call.evidenceRef) return undefined;
  return `step:${call.step}:tool:${call.tool}:index:${index}`;
}

function buildEntry(input: {
  call: PromptRunToolCallContext;
  currentCall: PromptRunToolCallContext;
  index: number;
  hotStart: number;
  workStateRefs: Set<string>;
}): RunContextMaintenancePlanEntry {
  const ref = toolCallContextRef(input.call, input.index)
    ?? `unrecoverable:${input.index}`;
  const aliases = callAliases(input.call, ref);
  const policy = toolContextCompactionPolicy(input.call);
  const mandatoryReason = input.index >= input.hotStart
    ? "latest_six" as const
    : input.call.status === "failed"
      ? "failed_call" as const
      : !input.call.stepRef
        ? "not_recoverable" as const
        : aliases.some((alias) => input.workStateRefs.has(alias))
          ? "workstate_reference" as const
          : ACTIVE_PROCESS_TOOLS.has(input.call.tool)
            ? "active_process" as const
            : policy === "exact_only"
              ? "unknown_tool" as const
              : undefined;
  const recommendedMode = mandatoryReason
    ? "full"
    : policy === "projectable"
      ? input.call.retention === "while_relevant" ? "preview" : "summary"
      : "full";
  const recommended = projectCall(input.call, recommendedMode);
  return {
    ref,
    step: input.call.step,
    ...(input.call.callId ? { callId: input.call.callId } : {}),
    tool: input.call.tool,
    status: input.call.status,
    verificationStatus: input.call.verificationStatus,
    currentMode: input.currentCall.mode,
    policy,
    recommendedMode,
    mandatoryExact: Boolean(mandatoryReason),
    ...(mandatoryReason ? { mandatoryReason } : {}),
    estimatedCurrentTokens: estimateCall(input.currentCall),
    estimatedRecommendedTokens: estimateCall(recommended),
    index: input.index,
    aliases,
  };
}

function toCandidate(entry: RunContextMaintenancePlanEntry) {
  const { index: _index, aliases: _aliases, ...candidate } = entry;
  return candidate;
}

function validateSelection(
  plan: RunContextMaintenancePlan,
  calls: PromptToolCalls,
  selection: RunContextMaintenanceSelection,
): void {
  if (selection.maintenanceId !== plan.maintenanceId) {
    throw new Error("The run-context maintenance plan is stale.");
  }
  if (selection.expectedWorkStateRevision !== plan.expectedWorkStateRevision) {
    throw new Error("The WorkState revision changed before run-context maintenance was applied.");
  }
  if (sourceHashForCalls(calls) !== plan.sourceHash) {
    throw new Error("The run tool journal changed before run-context maintenance was applied.");
  }
  const visible = new Map(plan.inventory.map((entry) => [entry.ref, entry]));
  for (const ref of selection.keepExactRefs) {
    if (!visible.has(ref)) throw new Error(`Unknown run-context reference '${ref}'.`);
  }
  for (const ref of selection.keepCompactRefs) {
    const entry = visible.get(ref);
    if (!entry) throw new Error(`Unknown run-context reference '${ref}'.`);
    if (entry.policy !== "projectable" || entry.mandatoryExact) {
      throw new Error(`Run-context reference '${ref}' cannot use compact projection.`);
    }
  }
  for (const ref of selection.releaseRefs) {
    const entry = visible.get(ref);
    if (!entry) throw new Error(`Unknown run-context reference '${ref}'.`);
    if (entry.policy === "exact_only" || entry.mandatoryExact) {
      throw new Error(`Run-context reference '${ref}' cannot be released to a journal reference.`);
    }
  }
}

function projectCalls(
  calls: PromptToolCalls,
  entries: RunContextMaintenancePlanEntry[],
  modes: Map<string, PromptRunToolCallMode>,
): PromptToolCalls {
  return calls.map((call, index) => {
    const entry = entries[index];
    return projectCall(call, entry ? modes.get(entry.ref) ?? "full" : "full");
  });
}

function projectCall(
  call: PromptRunToolCallContext,
  mode: PromptRunToolCallMode,
): PromptRunToolCallContext {
  if (mode === "full") return { ...call, mode: "full" };
  return projectToolCallForPressure(call, mode)?.call ?? { ...call, mode: "full" };
}

function savingsForMode(
  call: PromptRunToolCallContext,
  from: PromptRunToolCallMode,
  to: PromptRunToolCallMode,
): number {
  return Math.max(0, estimateCall(projectCall(call, from)) - estimateCall(projectCall(call, to)));
}

function compareCandidates(
  left: { entry: RunContextMaintenancePlanEntry; savings: number },
  right: { entry: RunContextMaintenancePlanEntry; savings: number },
): number {
  if (left.entry.policy !== right.entry.policy) {
    return left.entry.policy === "projectable" ? -1 : 1;
  }
  if (left.savings !== right.savings) return right.savings - left.savings;
  return left.entry.index - right.entry.index;
}

function callAliases(call: PromptRunToolCallContext, ref: string): string[] {
  return [...new Set([
    ref,
    `step:${call.step}`,
    ...(call.callId ? [call.callId, `call:${call.callId}`] : []),
    ...(call.evidenceRef ? [call.evidenceRef] : []),
  ])];
}

function estimateCalls(calls: PromptToolCalls): number {
  return calls.reduce((sum, call) => sum + estimateCall(call), 0);
}

function estimateCall(call: PromptRunToolCallContext): number {
  const { projectionMetadata: _projectionMetadata, ...promptCall } = call;
  return correctLocalInputTokenEstimate(estimateTextTokens(JSON.stringify(promptCall)));
}
