import type { LlmProvider } from "../../core/contracts/provider.js";
import { estimateTextTokens } from "../../prompt/token-estimator.js";
import type { ResolutionDecisionContext } from "../workstream-resolution/decision.js";
import { canonicalHash } from "./canonical.js";
import { generateFocusSummary, type FocusSummarySource } from "./focus-summary.js";
import {
  ContextPreparationJobError,
  type ContextPreparationJob,
  type ContextPreparationJobContext,
} from "./manager.js";
import {
  resolverStepProjection,
  type ResolverFocusOverlay,
} from "./resolver-context.js";
import {
  CONTEXT_PREPARATION_POLICY_VERSION,
  RUN_FOCUS_SUMMARY_MAX_TOKENS,
  type ContextPreparationCandidate,
  type ContextPreparationLaneId,
} from "./types.js";

export function createResolverPreparationJob(input: {
  provider: LlmProvider;
  laneId: ContextPreparationLaneId;
  context: ResolutionDecisionContext;
  currentInputTokens: number;
  recoveryTargetTokens: number;
  maxInputTokens?: number;
  modelProfileVersion: string;
  activeOverlay?: ResolverFocusOverlay;
  synchronous: boolean;
}): ContextPreparationJob | undefined {
  const source = buildResolverSource(input.context, input.activeOverlay);
  if (!source.focusSource) return undefined;
  const jobKey = [
    input.laneId,
    source.sourcePrefixHash,
    CONTEXT_PREPARATION_POLICY_VERSION,
    input.modelProfileVersion,
    "resolver_focus",
  ].join(":");
  return {
    jobKey,
    kind: "resolver_focus",
    seed: {
      ...(source.runStepPrefixThrough !== undefined
        ? { runStepPrefixThrough: source.runStepPrefixThrough }
        : {}),
      canonicalSourceHashes: source.canonicalSourceHashes,
      sourceRefs: source.sourceRefs,
      requiredExactEvidenceRefs: source.requiredExactEvidenceRefs,
      policyVersion: CONTEXT_PREPARATION_POLICY_VERSION,
      modelProfileVersion: input.modelProfileVersion,
      deterministicTransformations: [
        "resolver_success_output_projection",
        "resolver_candidate_bounds",
        "resolver_hot_step_and_failure_preservation",
      ],
      coveredSourceRefs: [],
      estimatedSavingsTokens: 0,
      estimatedFinalInputTokens: input.currentInputTokens,
      targetReached: input.currentInputTokens <= input.recoveryTargetTokens,
    },
    prepare: async (context) => await prepareResolverCandidate({
      ...input,
      source,
      context,
    }),
  };
}

export function validateResolverCandidate(input: {
  candidate: ContextPreparationCandidate;
  laneId: ContextPreparationLaneId;
  context: ResolutionDecisionContext;
  modelProfileVersion: string;
  activeOverlay?: ResolverFocusOverlay;
}): { valid: boolean; reason: string } {
  const candidate = input.candidate;
  if (candidate.status !== "ready") return invalid(`candidate_status_${candidate.status}`);
  if (candidate.laneId !== input.laneId) return invalid("wrong_lane");
  if (candidate.kind !== "resolver_focus" || !candidate.focusSummary) return invalid("wrong_candidate_kind");
  if (candidate.policyVersion !== CONTEXT_PREPARATION_POLICY_VERSION) return invalid("policy_version_changed");
  if (candidate.modelProfileVersion !== input.modelProfileVersion) return invalid("model_profile_changed");
  const refs = allResolverRefs(input.context);
  for (const ref of candidate.requiredExactEvidenceRefs) {
    if (!refs.has(ref)) return invalid(`missing_required_ref:${ref}`);
  }
  const hashes = resolverRefHashes(input.context, input.activeOverlay);
  for (const [ref, expected] of Object.entries(candidate.canonicalSourceHashes)) {
    if (hashes.get(ref) !== expected) return invalid(`source_hash_changed:${ref}`);
  }
  return { valid: true, reason: "source_hash_and_tail_valid" };
}

export function resolverOverlayFromCandidate(
  candidate: ContextPreparationCandidate,
): ResolverFocusOverlay | undefined {
  if (candidate.kind !== "resolver_focus" || !candidate.focusSummary) return undefined;
  return {
    candidateId: candidate.candidateId,
    summary: candidate.focusSummary,
    coveredSourceRefs: candidate.coveredSourceRefs,
    canonicalSourceHashes: candidate.canonicalSourceHashes,
  };
}

async function prepareResolverCandidate(input: {
  provider: LlmProvider;
  currentInputTokens: number;
  recoveryTargetTokens: number;
  maxInputTokens?: number;
  source: ResolverSourceSnapshot;
  synchronous: boolean;
  context: ContextPreparationJobContext;
}): Promise<Partial<ContextPreparationCandidate>> {
  const semantic = input.synchronous
    ? await input.context.runSemanticSynchronously(
        `resolver-focus:${input.source.sourcePrefixHash}`,
        async () => await generate(input.provider, input.source.focusSource!, input.maxInputTokens),
      )
    : await input.context.runSemanticBackground(
        `resolver-focus:${input.source.sourcePrefixHash}`,
        async () => await generate(input.provider, input.source.focusSource!, input.maxInputTokens),
      );
  if (semantic.status !== "success" || !semantic.value) {
    throw new Error(semantic.error ?? "resolver focus-summary generation failed");
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
      generation.errors.join("; ") || "resolver focus-summary generation failed",
      background,
    );
  }
  const estimatedSavingsTokens = Math.max(0, input.source.sourceTokens - generation.tokenCount);
  const estimatedFinalInputTokens = Math.max(0, input.currentInputTokens - estimatedSavingsTokens);
  return {
    focusSummary: generation.summary,
    coveredSourceRefs: input.source.coveredSourceRefs,
    estimatedSavingsTokens,
    estimatedFinalInputTokens,
    targetReached: estimatedFinalInputTokens <= input.recoveryTargetTokens,
    background,
  };
}

async function generate(
  provider: LlmProvider,
  source: FocusSummarySource,
  maxInputTokens?: number,
) {
  return await generateFocusSummary({
    provider,
    source,
    maxTokens: RUN_FOCUS_SUMMARY_MAX_TOKENS,
    ...(maxInputTokens !== undefined ? { maxInputTokens } : {}),
  });
}

interface ResolverSourceSnapshot {
  sourcePrefixHash: string;
  canonicalSourceHashes: Record<string, string>;
  sourceRefs: string[];
  coveredSourceRefs: string[];
  requiredExactEvidenceRefs: string[];
  runStepPrefixThrough?: number;
  focusSource?: FocusSummarySource;
  sourceTokens: number;
}

function buildResolverSource(
  context: ResolutionDecisionContext,
  activeOverlay?: ResolverFocusOverlay,
): ResolverSourceSnapshot {
  const latestStep = Math.max(0, ...context.history.map((step) => step.step));
  const hotFrom = Math.max(1, latestStep - 1);
  const eligible = context.history.filter((step) => {
    return step.step < hotFrom && step.toolCalls.every((call) => call.status === "completed");
  });
  const steps = eligible.map((step) => ({
    refs: [
      `resolver-step:${step.step}`,
      ...step.toolCalls.map((call) => `call:${call.id}`),
      ...step.toolCalls.flatMap((call) => collectEvidenceRefs(call.output)),
    ],
    step: step.step,
    content: resolverStepProjection(step),
  }));
  const priorRefs = activeOverlay ? focusRefs(activeOverlay.summary) : [];
  const validRefs = [...new Set([...steps.flatMap((step) => step.refs), ...priorRefs])].sort();
  const focusSource: FocusSummarySource | undefined = steps.length > 0 || activeOverlay ? {
    goal: context.state.purpose || "Resolve the current workstream safely.",
    validRefs,
    messages: [],
    steps,
    ...(activeOverlay ? { priorFocus: activeOverlay.summary } : {}),
    sourceKind: "resolver",
  } : undefined;
  const canonicalSourceHashes: Record<string, string> = {};
  for (const step of steps) {
    const hash = canonicalHash(step);
    canonicalSourceHashes[`resolver-step:${step.step}`] = hash;
    for (const ref of step.refs) canonicalSourceHashes[ref] = hash;
  }
  if (activeOverlay) canonicalSourceHashes["focus:previous"] = canonicalHash(activeOverlay.summary);
  const coveredSourceRefs = [
    ...steps.flatMap((step) => step.refs),
    ...(activeOverlay?.coveredSourceRefs ?? []),
  ];
  return {
    sourcePrefixHash: canonicalHash({ canonicalSourceHashes, prior: activeOverlay?.summary ?? null }),
    canonicalSourceHashes,
    sourceRefs: validRefs,
    coveredSourceRefs: [...new Set(coveredSourceRefs)].sort(),
    requiredExactEvidenceRefs: requiredResolverRefs(context),
    ...(steps.at(-1) ? { runStepPrefixThrough: steps.at(-1)!.step } : {}),
    focusSource,
    sourceTokens: focusSource ? estimateTextTokens(JSON.stringify(focusSource)) : 0,
  };
}

function requiredResolverRefs(context: ResolutionDecisionContext): string[] {
  const latestStep = Math.max(0, ...context.history.map((step) => step.step));
  const hotFrom = Math.max(1, latestStep - 1);
  return [...new Set([
    `activity:${context.activityId}`,
    ...context.history
      .filter((step) => step.step >= hotFrom || step.toolCalls.some((call) => call.status === "failed"))
      .flatMap((step) => [
        `resolver-step:${step.step}`,
        ...step.toolCalls.map((call) => `call:${call.id}`),
      ]),
  ])].sort();
}

function allResolverRefs(context: ResolutionDecisionContext): Set<string> {
  return new Set([
    `activity:${context.activityId}`,
    ...context.history.flatMap((step) => [
      `resolver-step:${step.step}`,
      ...step.toolCalls.map((call) => `call:${call.id}`),
      ...step.toolCalls.flatMap((call) => collectEvidenceRefs(call.output)),
    ]),
  ]);
}

function resolverRefHashes(
  context: ResolutionDecisionContext,
  activeOverlay?: ResolverFocusOverlay,
): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const step of context.history) {
    const value = {
      refs: [
        `resolver-step:${step.step}`,
        ...step.toolCalls.map((call) => `call:${call.id}`),
        ...step.toolCalls.flatMap((call) => collectEvidenceRefs(call.output)),
      ],
      step: step.step,
      content: resolverStepProjection(step),
    };
    const hash = canonicalHash(value);
    for (const ref of value.refs) hashes.set(ref, hash);
  }
  if (activeOverlay) hashes.set("focus:previous", canonicalHash(activeOverlay.summary));
  return hashes;
}

function collectEvidenceRefs(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectEvidenceRefs);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => {
    if (typeof item === "string" && (/Ref$/.test(key) || key === "evidence")) return [item];
    return collectEvidenceRefs(item);
  });
}

function focusRefs(summary: NonNullable<ResolverFocusOverlay>["summary"]): string[] {
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

function invalid(reason: string): { valid: false; reason: string } {
  return { valid: false, reason };
}
