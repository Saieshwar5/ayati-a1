import type { LlmProvider } from "../../core/contracts/provider.js";
import { estimateTextTokens } from "../../prompt/token-estimator.js";
import type { ResolvedModelContextLimits } from "../../providers/shared/model-context-limits.js";
import type { AgentContextCheckpointCoordinator } from "../types.js";
import { replaceCoreCapsuleRecentExact } from "../agent-runner/core-capsule.js";
import type { AgentPromptStateView } from "../agent-runner/prompt-context.js";
import { compactPromptToolCall } from "../agent-runner/run-tool-call-context.js";
import { canonicalHash } from "./canonical.js";
import { generateFocusSummary, type FocusSummarySource } from "./focus-summary.js";
import type {
  ContextPreparationCandidate,
  ContextPreparationLaneId,
  RunFocusSummary,
} from "./types.js";
import {
  CONTEXT_PREPARATION_POLICY_VERSION,
  RUN_FOCUS_SUMMARY_MAX_TOKENS,
} from "./types.js";
import type {
  ContextPreparationJob,
  ContextPreparationJobContext,
} from "./manager.js";
import { ContextPreparationJobError } from "./manager.js";

const HOT_MAIN_CALL_COUNT = 6;
const MAX_FOCUS_SOURCE_TOKENS = 48_000;
const DETERMINISTIC_TRANSFORMATIONS = [
  "recoverable_large_output_projection",
  "hot_window_and_failure_preservation",
] as const;

export interface MainFocusOverlay {
  candidateId: string;
  summary: RunFocusSummary;
  coveredSourceRefs: string[];
  canonicalSourceHashes: Record<string, string>;
}

export interface MainCandidateValidationResult {
  valid: boolean;
  reason: string;
}

export function createMainPreparationJob(input: {
  provider: LlmProvider;
  laneId: ContextPreparationLaneId;
  stateView: AgentPromptStateView;
  currentInputTokens: number;
  predictedInputTokens: number;
  recoveryTargetTokens: number;
  contextLimits: ResolvedModelContextLimits;
  modelProfileVersion: string;
  activeOverlay?: MainFocusOverlay;
  synchronous: boolean;
}): ContextPreparationJob | undefined {
  const source = buildMainSourceSnapshot(
    input.stateView,
    input.activeOverlay,
    Math.max(1, Math.min(MAX_FOCUS_SOURCE_TOKENS, input.contextLimits.hardInputTokens - 8_000)),
  );
  if (!source.focusSource) return undefined;
  const sourcePrefixHash = canonicalHash({
    source: source.sourcePrefixHash,
  });
  const jobKey = [
    input.laneId,
    sourcePrefixHash,
    CONTEXT_PREPARATION_POLICY_VERSION,
    input.modelProfileVersion,
    "pressure_recovery",
  ].join(":");

  return {
    jobKey,
    kind: "run_focus",
    seed: {
      ...(source.runStepPrefixThrough !== undefined
        ? { runStepPrefixThrough: source.runStepPrefixThrough }
        : {}),
      canonicalSourceHashes: source.canonicalSourceHashes,
      sourceRefs: source.sourceRefs,
      requiredExactEvidenceRefs: source.requiredExactEvidenceRefs,
      policyVersion: CONTEXT_PREPARATION_POLICY_VERSION,
      modelProfileVersion: input.modelProfileVersion,
      deterministicTransformations: [...DETERMINISTIC_TRANSFORMATIONS],
      coveredSourceRefs: [],
      estimatedSavingsTokens: 0,
      estimatedFinalInputTokens: input.currentInputTokens,
      targetReached: input.currentInputTokens <= input.recoveryTargetTokens,
    },
    prepare: async (context) => await prepareMainCandidate({
      ...input,
      source,
      context,
    }),
  };
}

export function validateMainCandidate(input: {
  candidate: ContextPreparationCandidate;
  laneId: ContextPreparationLaneId;
  stateView: AgentPromptStateView;
  modelProfileVersion: string;
  contextCheckpoint?: AgentContextCheckpointCoordinator;
  activeOverlay?: MainFocusOverlay;
}): MainCandidateValidationResult {
  const candidate = input.candidate;
  if (candidate.status !== "ready") return invalid(`candidate_status_${candidate.status}`);
  if (candidate.laneId !== input.laneId) return invalid("wrong_lane");
  if (candidate.policyVersion !== CONTEXT_PREPARATION_POLICY_VERSION) return invalid("policy_version_changed");
  if (candidate.modelProfileVersion !== input.modelProfileVersion) return invalid("model_profile_changed");
  if (candidate.kind === "durable_checkpoint") {
    if (input.activeOverlay) {
      const activeCoverage = new Set(input.activeOverlay.coveredSourceRefs);
      if (candidate.coveredSourceRefs.some((ref) => activeCoverage.has(ref))) {
        return invalid("overlapping_prefix_ownership");
      }
    }
    const activeId = input.contextCheckpoint?.currentContext?.().agentStream.checkpoint?.checkpointId;
    if ((candidate.checkpointBaseId ?? undefined) !== (activeId ?? undefined)) {
      return invalid("checkpoint_base_changed");
    }
    if (!candidate.checkpointPlan || !candidate.checkpointGeneration?.summary) {
      return invalid("checkpoint_candidate_incomplete");
    }
  }
  const currentRefs = allMainRefs(input.stateView);
  for (const ref of candidate.requiredExactEvidenceRefs) {
    if (!currentRefs.has(ref)) return invalid(`missing_required_ref:${ref}`);
  }
  if (candidate.kind === "run_focus") {
    const ownsConversationSource = candidate.messagePrefixThroughSeq !== undefined
      || candidate.sourceRefs.some((ref) => ref.startsWith("seq:"))
      || candidate.coveredSourceRefs.some((ref) => ref.startsWith("seq:"))
      || Object.keys(candidate.canonicalSourceHashes).some((ref) => ref.startsWith("seq:"));
    if (ownsConversationSource) {
      return invalid("conversation_source_requires_context_maintenance");
    }
    if (!candidate.focusSummary) return invalid("focus_summary_missing");
    const currentHashes = mainRefHashes(input.stateView, input.activeOverlay);
    for (const [ref, expected] of Object.entries(candidate.canonicalSourceHashes)) {
      if (!isValidatedSourceRef(ref)) continue;
      if (currentHashes.get(ref) !== expected) return invalid(`source_hash_changed:${ref}`);
    }
  }
  return { valid: true, reason: "source_hash_and_tail_valid" };
}

export function applyMainFocusOverlay(
  stateView: AgentPromptStateView,
  overlay: MainFocusOverlay | undefined,
): AgentPromptStateView {
  if (!overlay) return stateView;
  const covered = new Set(overlay.coveredSourceRefs);
  const recentExact = stateView.context.core.continuity.recentExact.filter((event) => {
    return !covered.has(`seq:${event.seq}`);
  });
  const calls = stateView.context.run?.toolCalls ?? [];
  const hotStart = Math.max(0, calls.length - HOT_MAIN_CALL_COUNT);
  const projectedCalls = calls.filter((call, index) => {
    if (
      index >= hotStart
      || call.status === "failed"
      || Boolean(call.evidenceRef)
      || (call.artifacts?.length ?? 0) > 0
    ) return true;
    return !covered.has(`step:${call.step}`)
      && (!call.callId || !covered.has(`call:${call.callId}`));
  });
  const run = stateView.context.run;
  return {
    ...stateView,
    context: {
      ...stateView.context,
      core: replaceCoreCapsuleRecentExact(stateView.context.core, recentExact),
      run: {
        ...(run ?? {}),
        ...(run?.workState ? { workState: run.workState } : {}),
        ...(projectedCalls.length > 0 ? { toolCalls: projectedCalls } : {}),
        ...(run?.contextPressure ? { contextPressure: run.contextPressure } : {}),
        focus: overlay.summary,
      },
    },
  };
}

export function overlayFromCandidate(candidate: ContextPreparationCandidate): MainFocusOverlay | undefined {
  if (candidate.kind !== "run_focus" || !candidate.focusSummary) return undefined;
  return {
    candidateId: candidate.candidateId,
    summary: candidate.focusSummary,
    coveredSourceRefs: candidate.coveredSourceRefs,
    canonicalSourceHashes: candidate.canonicalSourceHashes,
  };
}

async function prepareMainCandidate(input: {
  provider: LlmProvider;
  stateView: AgentPromptStateView;
  currentInputTokens: number;
  recoveryTargetTokens: number;
  contextLimits: ResolvedModelContextLimits;
  source: MainSourceSnapshot;
  synchronous: boolean;
  context: ContextPreparationJobContext;
}): Promise<Partial<ContextPreparationCandidate>> {
  if (!input.source.focusSource) {
    throw new Error("no eligible focus-summary source");
  }
  const semantic = await runSemantic(input, `focus:${input.source.sourcePrefixHash}`, async () => {
    return await generateFocusSummary({
      provider: input.provider,
      source: input.source.focusSource!,
      maxTokens: RUN_FOCUS_SUMMARY_MAX_TOKENS,
      maxInputTokens: input.contextLimits.hardInputTokens,
    });
  });
  if (semantic.status !== "success" || !semantic.value) {
    throw new Error(semantic.error ?? "focus-summary generation failed");
  }
  const generation = semantic.value;
  const background = {
    durationMs: semantic.durationMs,
    attempts: generation.attempts.length,
    usage: generation.usage,
    cost: generation.cost,
  };
  if (generation.status !== "success" || !generation.summary || generation.tokenCount === undefined) {
    throw new ContextPreparationJobError(
      generation.errors.join("; ") || "focus-summary generation failed",
      background,
    );
  }
  const estimatedSavingsTokens = Math.max(0, input.source.focusSourceTokens - generation.tokenCount);
  const estimatedFinalInputTokens = Math.max(0, input.currentInputTokens - estimatedSavingsTokens);
  return {
    kind: "run_focus",
    focusSummary: generation.summary,
    coveredSourceRefs: input.source.coveredSourceRefs,
    estimatedSavingsTokens,
    estimatedFinalInputTokens,
    targetReached: estimatedFinalInputTokens <= input.recoveryTargetTokens,
    background,
  };
}

async function runSemantic<Value>(
  input: { synchronous: boolean; context: ContextPreparationJobContext },
  key: string,
  task: () => Promise<Value>,
) {
  return input.synchronous
    ? await input.context.runSemanticSynchronously(key, task)
    : await input.context.runSemanticBackground(key, task);
}

interface MainSourceSnapshot {
  sourcePrefixHash: string;
  canonicalSourceHashes: Record<string, string>;
  sourceRefs: string[];
  coveredSourceRefs: string[];
  requiredExactEvidenceRefs: string[];
  runStepPrefixThrough?: number;
  focusSource?: FocusSummarySource;
  focusSourceTokens: number;
}

function buildMainSourceSnapshot(
  stateView: AgentPromptStateView,
  activeOverlay?: MainFocusOverlay,
  maxSourceTokens = MAX_FOCUS_SOURCE_TOKENS,
): MainSourceSnapshot {
  let selectedSourceTokens = activeOverlay
    ? estimateTextTokens(JSON.stringify(activeOverlay.summary))
    : 0;
  const calls = stateView.context.run?.toolCalls ?? [];
  const hotStart = Math.max(0, calls.length - HOT_MAIN_CALL_COUNT);
  const eligibleCalls: FocusSummarySource["steps"] = [];
  for (const call of calls.slice(0, hotStart)) {
    if (call.status !== "success" || call.evidenceRef || (call.artifacts?.length ?? 0) > 0) continue;
    const candidate = {
      refs: [
        `step:${call.step}`,
        ...(call.callId ? [`call:${call.callId}`] : []),
        ...(call.evidenceRef ? [call.evidenceRef] : []),
        ...(call.artifacts ?? []).map((artifact) => `artifact:${JSON.stringify(artifact)}`),
      ],
      step: call.step,
      content: compactPromptToolCall(call, "preview", "context_budget"),
    };
    const tokens = estimateTextTokens(JSON.stringify(candidate));
    if (selectedSourceTokens + tokens > maxSourceTokens) break;
    eligibleCalls.push(candidate);
    selectedSourceTokens += tokens;
  }
  const priorRefs = activeOverlay ? focusRefs(activeOverlay.summary) : [];
  const validRefs = [...new Set([
    ...eligibleCalls.flatMap((call) => call.refs),
    ...priorRefs,
  ])].sort();
  const hasSource = eligibleCalls.length > 0 || Boolean(activeOverlay);
  const focusSource: FocusSummarySource | undefined = hasSource ? {
    goal: "Preserve relevant prior context for the current run.",
    validRefs,
    messages: [],
    steps: eligibleCalls,
    ...(activeOverlay ? { priorFocus: activeOverlay.summary } : {}),
  } : undefined;
  const canonicalSourceHashes: Record<string, string> = {};
  for (const call of eligibleCalls) {
    const hash = canonicalHash(call);
    for (const ref of call.refs) canonicalSourceHashes[ref] = hash;
  }
  if (activeOverlay) canonicalSourceHashes["focus:previous"] = canonicalHash(activeOverlay.summary);
  const coveredSourceRefs = [
    ...eligibleCalls.flatMap((call) => call.refs),
    ...(activeOverlay?.coveredSourceRefs ?? []),
  ];
  const sourcePrefixHash = canonicalHash({ canonicalSourceHashes, priorFocus: activeOverlay?.summary ?? null });
  return {
    sourcePrefixHash,
    canonicalSourceHashes,
    sourceRefs: validRefs,
    coveredSourceRefs: [...new Set(coveredSourceRefs)].sort(),
    requiredExactEvidenceRefs: requiredMainRefs(stateView),
    ...(eligibleCalls.at(-1) ? { runStepPrefixThrough: eligibleCalls.at(-1)!.step } : {}),
    focusSource,
    focusSourceTokens: focusSource ? estimateTextTokens(JSON.stringify(focusSource)) : 0,
  };
}

function requiredMainRefs(stateView: AgentPromptStateView): string[] {
  const context = stateView.context;
  const calls = context.run?.toolCalls ?? [];
  const hot = calls.slice(-HOT_MAIN_CALL_COUNT);
  const failures = calls.filter((call) => call.status === "failed");
  return [...new Set([
    `run:${context.core.current.runId}`,
    `seq:${context.core.current.input.seq}`,
    ...(context.core.current.routing?.workstreamId ? [`workstream:${context.core.current.routing.workstreamId}`] : []),
    ...(context.core.current.routing?.requestId ? [`request:${context.core.current.routing.requestId}`] : []),
    ...workStateRefs(context.run?.workState),
    ...calls.flatMap((call) => [
      ...(call.evidenceRef ? [call.evidenceRef] : []),
      ...(call.artifacts ?? []).map((artifact) => `artifact:${JSON.stringify(artifact)}`),
    ]),
    ...(context.run?.verifiedOutcomes ?? []).flatMap((outcome) => [
      `step:${outcome.source.step}`,
      ...(outcome.source.callId ? [`call:${outcome.source.callId}`] : []),
    ]),
    ...[...failures, ...hot].flatMap((call) => [
      `step:${call.step}`,
      ...(call.callId ? [`call:${call.callId}`] : []),
      ...(call.evidenceRef ? [call.evidenceRef] : []),
    ]),
  ])].sort();
}

function allMainRefs(stateView: AgentPromptStateView): Set<string> {
  const context = stateView.context;
  const refs = new Set<string>([
    `run:${context.core.current.runId}`,
    `seq:${context.core.current.input.seq}`,
    ...(context.core.current.routing?.workstreamId ? [`workstream:${context.core.current.routing.workstreamId}`] : []),
    ...(context.core.current.routing?.requestId ? [`request:${context.core.current.routing.requestId}`] : []),
    ...workStateRefs(context.run?.workState),
  ]);
  refs.add(`seq:${context.core.current.input.seq}`);
  for (const event of context.core.continuity.recentExact) refs.add(`seq:${event.seq}`);
  for (const call of context.run?.toolCalls ?? []) {
    refs.add(`step:${call.step}`);
    if (call.callId) refs.add(`call:${call.callId}`);
    if (call.evidenceRef) refs.add(call.evidenceRef);
    for (const artifact of call.artifacts ?? []) refs.add(`artifact:${JSON.stringify(artifact)}`);
  }
  for (const outcome of context.run?.verifiedOutcomes ?? []) {
    refs.add(`step:${outcome.source.step}`);
    if (outcome.source.callId) refs.add(`call:${outcome.source.callId}`);
  }
  return refs;
}

function workStateRefs(
  workState: NonNullable<AgentPromptStateView["context"]["run"]>["workState"],
): string[] {
  return (workState?.importantContext ?? []).flatMap((item) => [
    ...(item.ref ? [item.ref] : []),
    ...(item.kind === "artifact" && !item.ref
      ? [`artifact:${item.value}`]
      : []),
  ]);
}

function mainRefHashes(
  stateView: AgentPromptStateView,
  activeOverlay?: MainFocusOverlay,
): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const call of stateView.context.run?.toolCalls ?? []) {
    const value = {
      refs: [
        `step:${call.step}`,
        ...(call.callId ? [`call:${call.callId}`] : []),
        ...(call.evidenceRef ? [call.evidenceRef] : []),
        ...(call.artifacts ?? []).map((artifact) => `artifact:${JSON.stringify(artifact)}`),
      ],
      step: call.step,
      content: compactPromptToolCall(call, "preview", "context_budget"),
    };
    const hash = canonicalHash(value);
    for (const ref of value.refs) hashes.set(ref, hash);
  }
  if (activeOverlay) hashes.set("focus:previous", canonicalHash(activeOverlay.summary));
  return hashes;
}

function focusRefs(summary: RunFocusSummary): string[] {
  return [...new Set([
    ...summary.references,
    ...summary.constraints.flatMap((statement) => statement.refs),
    ...summary.decisions.flatMap((statement) => statement.refs),
    ...summary.completedWork.flatMap((statement) => statement.refs),
    ...summary.importantFindings.flatMap((statement) => statement.refs),
    ...summary.artifacts.flatMap((statement) => statement.refs),
    ...summary.unresolvedQuestions.flatMap((statement) => statement.refs),
  ])];
}

function isValidatedSourceRef(ref: string): boolean {
  return ref.startsWith("step:")
    || ref.startsWith("call:")
    || ref === "focus:previous";
}

function invalid(reason: string): MainCandidateValidationResult {
  return { valid: false, reason };
}
