import { isAbsolute, resolve } from "node:path";
import {
  canonicalizeAbsoluteFilesystemPath,
  filesystemPathIsWithin,
} from "../../shared/filesystem-paths.js";
import { getToolTaxonomy } from "../../skills/tool-taxonomy.js";
import { getWorkspaceRoot } from "../../skills/workspace-paths.js";
import {
  FILES_RECENT_HOT_CONTEXT_KEY,
  readRecentFilesHotContextContent,
} from "../hot-context/index.js";
import { activeDocumentPointers } from "../recent-document-registry.js";
import type { LoopState } from "../types.js";
import type { ModeTransitionRequest } from "./virtual-mode.js";

type TargetEvidence =
  | {
      kind: "exact";
      value: string;
    }
  | {
      kind: "filesystem";
      value: string;
      authorityKind: "file" | "directory";
    };

export function collectVirtualModeTargetEvidence(state: LoopState): string[] {
  return collectStructuredTargetEvidence(state, {}).map((entry) => entry.value);
}

/**
 * Exact filesystem reads validate their own path, access, file type, content,
 * and result at the read tool boundary. The mode transition therefore needs
 * the target for navigation, but does not require earlier grounding evidence.
 */
export function isDirectFilesystemReadTransition(
  request: ModeTransitionRequest,
): boolean {
  if (
    request.to !== "observe.investigate"
    || request.capabilities.length !== 1
    || request.capabilities[0] !== "file:read"
  ) {
    return false;
  }
  const references = request.references ?? [];
  if (references.length > 0) {
    return references.every(
      (reference) => reference.kind === "filesystem",
    );
  }
  const targets = request.targets ?? [];
  return targets.length > 0
    && targets.every((target) => isAbsolute(target));
}

export async function findUnverifiedVirtualModeTargets(
  state: LoopState,
  targets: string[],
  options: {
    includeRecentFileNavigation?: boolean;
  } = {},
): Promise<string[]> {
  const evidence = collectStructuredTargetEvidence(state, options);
  const verification = await Promise.all(targets.map(async (target) => ({
    target,
    backed: await targetIsBacked(target, evidence),
  })));
  return verification.filter((item) => !item.backed).map((item) => item.target);
}

function collectStructuredTargetEvidence(
  state: LoopState,
  options: {
    includeRecentFileNavigation?: boolean;
  },
): TargetEvidence[] {
  const evidence: TargetEvidence[] = [];
  addExtractedTargets(evidence, state.userMessage);
  addFilesystemEvidence(evidence, resolve(getWorkspaceRoot()), "directory");
  for (const target of state.virtualMode.targets) addExactEvidence(evidence, target);
  for (const resource of state.harnessContext.contextEngine?.ingressResources ?? []) {
    addResourceTargets(evidence, resource, true);
  }
  for (const binding of state.harnessContext.contextEngine?.workstream?.resources ?? []) {
    addResourceTargets(evidence, binding.resource, true);
  }
  for (const resource of state.harnessContext.contextEngine?.agentStream.resources ?? []) {
    addResourceTargets(evidence, resource, false);
  }
  if (options.includeRecentFileNavigation) {
    addRecentFileNavigationTargets(evidence, state);
  }
  for (const item of state.workState.importantContext) {
    const value = item.ref ?? item.value;
    addExtractedTargets(evidence, value);
    if (looksLikeTarget(value)) addExactEvidence(evidence, value.trim());
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
      if (artifact.path?.trim()) {
        if (artifact.kind === "directory") {
          addFilesystemEvidence(evidence, artifact.path, "directory");
        } else if (artifact.kind === "file") {
          addFilesystemEvidence(evidence, artifact.path, "file");
        } else {
          addExactEvidence(evidence, artifact.path);
        }
      }
      for (const value of [artifact.id, artifact.uri]) {
        if (value?.trim()) addExactEvidence(evidence, value);
      }
    }
  }
  return uniqueEvidence(evidence).slice(0, 80);
}

function addRecentFileNavigationTargets(
  evidence: TargetEvidence[],
  state: LoopState,
): void {
  for (const file of activeDocumentPointers(
    state.harnessContext.contextEngine?.agentStream.recentFiles ?? [],
  )) {
    addFilesystemEvidence(evidence, file.path, "file");
  }
  const loaded = state.hotContext.loaded.find(
    (entry) => entry.key === FILES_RECENT_HOT_CONTEXT_KEY,
  );
  if (!loaded) return;
  for (const file of readRecentFilesHotContextContent(loaded.content)) {
    addFilesystemEvidence(evidence, file.path, "file");
  }
}

function addResourceTargets(
  evidence: TargetEvidence[],
  resource: {
    resourceId: string;
    kind: string;
    displayName: string;
    aliases: string[];
    locator: {
      kind: string;
      path?: string;
      url?: string;
      resourceId?: string;
      externalId?: string;
      uri?: string;
    };
  },
  filesystemAuthority: boolean,
): void {
  addExactEvidence(evidence, resource.resourceId);
  addExactEvidence(evidence, resource.displayName);
  for (const alias of resource.aliases) addExactEvidence(evidence, alias);
  if (
    filesystemAuthority
    && resource.locator.kind === "filesystem"
    && resource.locator.path?.trim()
  ) {
    addFilesystemEvidence(
      evidence,
      resource.locator.path,
      resource.kind === "directory" || resource.kind === "git_repository"
        ? "directory"
        : "file",
    );
  }
  for (const value of [
    resource.locator.url,
    resource.locator.resourceId,
    resource.locator.externalId,
    resource.locator.uri,
  ]) {
    if (value?.trim()) addExactEvidence(evidence, value);
  }
}

function addExtractedTargets(targets: TargetEvidence[], value: string): void {
  for (const match of value.matchAll(/https?:\/\/[^\s<>{}\[\]"']+/g)) {
    addExactEvidence(targets, match[0].replace(/[),.;!?]+$/, ""));
  }
  for (const match of value.matchAll(/\b(?:RES-[0-9A-F]{24}|W-\d{8}-\d{4})\b/g)) {
    addExactEvidence(targets, match[0]);
  }
  for (const match of value.matchAll(/(?:^|[\s"'`])(\/[A-Za-z0-9_@+.,:=~-][^\s"'`,;]*)/g)) {
    const path = match[1]?.replace(/[).!?]+$/, "");
    if (path && isAbsolute(path)) addFilesystemEvidence(targets, resolve(path), "file");
  }
  for (const match of value.matchAll(/(?:^|[\s"'`])((?:\.?\.?\/)?[A-Za-z0-9_@+~-][A-Za-z0-9_@+.,/~-]*\.[A-Za-z0-9]{1,12})\b/g)) {
    const path = match[1]?.replace(/[).!?]+$/, "");
    if (path) addExactEvidence(targets, path);
  }
}

function looksLikeTarget(value: string): boolean {
  const trimmed = value.trim();
  return isAbsolute(trimmed)
    || /^https?:\/\//.test(trimmed)
    || /^(?:RES-[0-9A-F]{24}|W-\d{8}-\d{4})$/.test(trimmed)
    || /[A-Za-z0-9_-]\.[A-Za-z0-9]{1,12}$/.test(trimmed);
}

async function targetIsBacked(target: string, evidence: TargetEvidence[]): Promise<boolean> {
  const normalized = normalizeTarget(target);
  for (const candidate of evidence) {
    if (normalizeTarget(candidate.value) === normalized) return true;
    if (
      !isAbsolute(target)
      || candidate.kind !== "filesystem"
      || candidate.authorityKind !== "directory"
      || !isAbsolute(candidate.value)
    ) {
      continue;
    }
    const [canonicalRoot, canonicalTarget] = await Promise.all([
      canonicalizeAbsoluteFilesystemPath(candidate.value),
      canonicalizeAbsoluteFilesystemPath(target),
    ]);
    if (filesystemPathIsWithin(canonicalRoot, canonicalTarget)) return true;
  }
  return false;
}

function addExactEvidence(evidence: TargetEvidence[], value: string): void {
  const trimmed = value.trim();
  if (trimmed) evidence.push({ kind: "exact", value: trimmed });
}

function addFilesystemEvidence(
  evidence: TargetEvidence[],
  value: string,
  authorityKind: "file" | "directory",
): void {
  const trimmed = value.trim();
  if (!trimmed) return;
  evidence.push({
    kind: "filesystem",
    value: isAbsolute(trimmed) ? resolve(trimmed) : trimmed,
    authorityKind,
  });
}

function uniqueEvidence(evidence: TargetEvidence[]): TargetEvidence[] {
  const seen = new Set<string>();
  return evidence.filter((entry) => {
    const key = entry.kind === "filesystem"
      ? `${entry.kind}:${entry.authorityKind}:${entry.value}`
      : `${entry.kind}:${entry.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeTarget(value: string): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (isAbsolute(trimmed)) return resolve(trimmed);
  return trimmed;
}
