import { isAbsolute, resolve } from "node:path";
import { getToolTaxonomy } from "../../skills/tool-taxonomy.js";
import { getWorkspaceRoot } from "../../skills/workspace-paths.js";
import type { LoopState } from "../types.js";

export function collectVirtualModeTargetEvidence(state: LoopState): string[] {
  const evidence = new Set<string>();
  addExtractedTargets(evidence, state.userMessage);
  if (/\bdefault workspace\b|\bayati(?:['’]s)? workspace\b/i.test(state.userMessage)) {
    evidence.add(resolve(getWorkspaceRoot()));
  }
  for (const target of state.virtualMode.targets) evidence.add(target);
  for (const resource of state.harnessContext.contextEngine?.ingressResources ?? []) {
    addResourceTargets(evidence, resource);
  }
  for (const binding of state.harnessContext.contextEngine?.workstream?.resources ?? []) {
    addResourceTargets(evidence, binding.resource);
  }
  for (const resource of state.harnessContext.contextEngine?.agentStream.resources ?? []) {
    addResourceTargets(evidence, resource);
  }
  for (const value of [
    ...state.workState.verifiedFacts,
    ...state.workState.evidence,
    ...(state.workState.artifacts ?? []),
  ]) {
    addExtractedTargets(evidence, value);
    if (looksLikeTarget(value)) evidence.add(value.trim());
  }
  for (const observation of [
    ...(state.harnessContext.contextEngine?.observations.inventory ?? []),
    ...(state.harnessContext.contextEngine?.observations.discovery ?? []),
    ...(state.harnessContext.contextEngine?.observations.evidence ?? []),
  ]) {
    addExtractedTargets(evidence, observation.preview);
  }
  for (const call of state.toolContext?.toolCalls ?? []) {
    if (call.status !== "success") continue;
    const taxonomy = getToolTaxonomy(call.tool);
    const canEstablishTarget = taxonomy?.purpose === "list"
      || taxonomy?.purpose === "search"
      || taxonomy?.purpose === "read";
    if (!canEstablishTarget) continue;
    addExtractedTargets(evidence, call.output);
    for (const artifact of call.artifacts ?? []) {
      for (const value of [artifact.id, artifact.path, artifact.uri]) {
        if (value?.trim()) evidence.add(value.trim());
      }
    }
  }
  return [...evidence].map((value) => value.trim()).filter(Boolean).slice(0, 80);
}

export function findUnverifiedVirtualModeTargets(
  state: LoopState,
  targets: string[],
): string[] {
  const evidence = collectVirtualModeTargetEvidence(state);
  return targets.filter((target) => !targetIsBacked(target, evidence));
}

function addResourceTargets(
  evidence: Set<string>,
  resource: {
    resourceId: string;
    displayName: string;
    aliases: string[];
    locator: { kind: string; path?: string; url?: string; resourceId?: string; externalId?: string; uri?: string };
  },
): void {
  evidence.add(resource.resourceId);
  evidence.add(resource.displayName);
  for (const alias of resource.aliases) evidence.add(alias);
  for (const value of [
    resource.locator.path,
    resource.locator.url,
    resource.locator.resourceId,
    resource.locator.externalId,
    resource.locator.uri,
  ]) {
    if (value?.trim()) evidence.add(value.trim());
  }
}

function addExtractedTargets(targets: Set<string>, value: string): void {
  for (const match of value.matchAll(/https?:\/\/[^\s<>{}\[\]"']+/g)) {
    targets.add(match[0].replace(/[),.;!?]+$/, ""));
  }
  for (const match of value.matchAll(/\b(?:RES-[0-9A-F]{24}|W-\d{8}-\d{4})\b/g)) {
    targets.add(match[0]);
  }
  for (const match of value.matchAll(/(?:^|[\s"'`])(\/[A-Za-z0-9_@+.,:=~-][^\s"'`,;]*)/g)) {
    const path = match[1]?.replace(/[).!?]+$/, "");
    if (path && isAbsolute(path)) targets.add(resolve(path));
  }
  for (const match of value.matchAll(/(?:^|[\s"'`])((?:\.?\.?\/)?[A-Za-z0-9_@+~-][A-Za-z0-9_@+.,/~-]*\.[A-Za-z0-9]{1,12})\b/g)) {
    const path = match[1]?.replace(/[).!?]+$/, "");
    if (path) targets.add(path);
  }
}

function looksLikeTarget(value: string): boolean {
  const trimmed = value.trim();
  return isAbsolute(trimmed)
    || /^https?:\/\//.test(trimmed)
    || /^(?:RES-[0-9A-F]{24}|W-\d{8}-\d{4})$/.test(trimmed)
    || /[A-Za-z0-9_-]\.[A-Za-z0-9]{1,12}$/.test(trimmed);
}

function targetIsBacked(target: string, evidence: string[]): boolean {
  const normalized = normalizeTarget(target);
  return evidence.some((candidate) => normalizeTarget(candidate) === normalized);
}

function normalizeTarget(value: string): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (isAbsolute(trimmed)) return resolve(trimmed);
  return trimmed;
}
