import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  RUN_FINALIZATION_LIMITS,
  type WorkstreamCompletionRecord,
} from "ayati-git-context";
import {
  compactOptionalText,
  compactText,
  compactWorkState,
} from "../ivec/state-compaction.js";
import type { AgentLoopResult, AgentResourceRecord, WorkState } from "../ivec/types.js";

export interface AgentRunFinalizationProjection {
  assistantResponse: string;
  conversationSummary: string;
  summary: string;
  next?: string;
  workState?: WorkState;
  workstreamCompletion?: WorkstreamCompletionRecord;
}

export function buildAgentRunFinalizationProjection(input: {
  result: AgentLoopResult;
  workstreamBound: boolean;
  fallbackSummary?: string;
}): AgentRunFinalizationProjection {
  const workState = input.result.workState
    ? compactWorkState(input.result.workState)
    : undefined;
  const fallback = input.fallbackSummary?.trim()
    || "Run finalized with outcome " + input.result.outcome + ".";
  const conversationSummary = requiredText(
    input.result.workstreamSummary?.summary || input.result.content,
    fallback,
    RUN_FINALIZATION_LIMITS.conversationSummaryChars,
  );
  const summary = requiredText(
    workState?.summary || input.result.content,
    fallback,
    RUN_FINALIZATION_LIMITS.summaryChars,
  );
  const next = compactOptionalText(
    workState?.nextStep,
    RUN_FINALIZATION_LIMITS.nextChars,
  );
  return {
    // This is the user-visible truth and is never replaced by its compact projection.
    assistantResponse: input.result.content,
    conversationSummary,
    summary,
    ...(next ? { next } : {}),
    ...(workState ? { workState } : {}),
    ...(input.workstreamBound
      ? { workstreamCompletion: buildWorkstreamCompletion(input.result, workState) }
      : {}),
  };
}

function buildWorkstreamCompletion(
  result: AgentLoopResult,
  workState: WorkState | undefined,
): WorkstreamCompletionRecord {
  const limits = RUN_FINALIZATION_LIMITS.completion;
  const accepted = result.outcome === "done" && workState?.status === "done";
  const evidence = compactOptionalText(
    result.workstreamSummary?.summary || workState?.summary || result.content,
    limits.evidenceChars,
  );
  const resources: WorkstreamCompletionRecord["resources"] = durableCompletionResources(result)
    .flatMap((resource) => {
      if (resource.locator.kind !== "filesystem"
        || (resource.kind !== "file" && resource.kind !== "directory")) return [];
      return [{
        locator: resource.locator,
        kind: resource.kind,
        role: "deliverable" as const,
        description: requiredText(
          resource.description,
          "Verified " + resource.kind + " deliverable.",
          limits.descriptionChars,
        ),
        aliases: uniqueText(
          resource.aliases,
          limits.aliasChars,
          limits.maximumAliases,
        ),
        verified: true,
      }];
    })
    .slice(0, limits.maximumResources);
  return {
    accepted,
    resources,
    missing: result.outcome === "done" && !accepted
      ? ["Accepted deterministic workstream-completion evidence"]
      : [],
    failures: uniqueText([
      ...(workState?.blockers ?? []),
      result.workstreamSummary?.failureSummary?.error,
    ], limits.failureChars, limits.maximumItems),
    criteria: [{
      criterion: "Complete the active workstream request with deterministic verification.",
      passed: accepted,
      ...(evidence ? { evidence } : {}),
    }],
  };
}

function durableCompletionResources(result: AgentLoopResult): AgentResourceRecord[] {
  const candidates = result.verifiedCompletionResources ?? [];
  const primaryDirectories = new Set(
    (result.harnessContext?.contextEngine?.workstream?.resources ?? [])
      .filter((binding) => binding.primary
        && binding.resource.kind === "directory"
        && binding.resource.locator.kind === "filesystem")
      .map((binding) => binding.resource.locator.kind === "filesystem"
        ? resolve(binding.resource.locator.path)
        : ""),
  );
  return candidates.filter((resource) => {
    if (resource.kind !== "directory" || resource.locator.kind !== "filesystem") return true;
    const directory = resolve(resource.locator.path);
    if (!primaryDirectories.has(directory)) return true;
    return !candidates.some((candidate) => candidate !== resource
      && candidate.locator.kind === "filesystem"
      && isDescendantPath(directory, resolve(candidate.locator.path)));
  });
}

function isDescendantPath(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path.length > 0
    && path !== ".."
    && !path.startsWith(".." + sep)
    && !isAbsolute(path);
}

function requiredText(value: unknown, fallback: string, maximum: number): string {
  return compactText(value, maximum) || compactText(fallback, maximum);
}

function uniqueText(
  values: Array<string | undefined>,
  maximumChars: number,
  maximumItems: number,
): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const compact = compactText(value, maximumChars);
    if (!compact || seen.has(compact)) continue;
    seen.add(compact);
    output.push(compact);
    if (output.length >= maximumItems) break;
  }
  return output;
}
