import { normalizeWorkstreamBindingProposal } from "../workstream-binding/proposal.js";
import { normalizeWorkstreamWorkspaceTargets } from "../workstream-binding/workspace-targets.js";
import { requireAbsoluteFilesystemPath } from "../../shared/filesystem-paths.js";
import type {
  ResourceMetadataProposal,
  ValidationCriterionProofSelection,
} from "./task-validation-contracts.js";
import type {
  ModeTransitionMutationScope,
  ModeTransitionReference,
  ModeTransitionRequest,
} from "./virtual-mode.js";

export function normalizeModeTransitionRequest(value: unknown): ModeTransitionRequest {
  const record = isRecord(value) ? value : {};
  const binding = normalizeWorkstreamBindingProposal(record["binding"]);
  const references = normalizeReferences(record["references"]);
  const mutationScopes = normalizeMutationScopes(record["mutationScopes"]);
  const workspaceTargets = normalizeWorkstreamWorkspaceTargets(record["workspaceTargets"]);
  const outcomeRefs = normalizeOutcomeRefs(record["outcomeRefs"]);
  const criterionProofs = normalizeCriterionProofs(record["criterionProofs"]);
  const resourceMetadata = normalizeResourceMetadata(record["resourceMetadata"]);
  return {
    to: normalizeModeTransitionTarget(record["to"]),
    purpose: typeof record["purpose"] === "string" ? normalizeText(record["purpose"]) : "",
    capabilities: normalizeStringArray(record["capabilities"]),
    ...(Array.isArray(record["subjects"])
      ? { subjects: normalizeStringArray(record["subjects"]) }
      : {}),
    ...(references.length > 0 ? { references } : {}),
    ...(mutationScopes.length > 0 ? { mutationScopes } : {}),
    ...(workspaceTargets.length > 0 ? { workspaceTargets } : {}),
    ...(outcomeRefs.length > 0 ? { outcomeRefs } : {}),
    ...(criterionProofs.length > 0 ? { criterionProofs } : {}),
    ...(resourceMetadata.length > 0 ? { resourceMetadata } : {}),
    ...(Array.isArray(record["targets"])
      ? { targets: normalizeStringArray(record["targets"]) }
      : {}),
    ...(binding ? { binding } : {}),
  };
}

function normalizeModeTransitionTarget(value: unknown): ModeTransitionRequest["to"] {
  if (
    value === "context.retrieve"
    || value === "observe.locate"
    || value === "observe.investigate"
    || value === "workstream.route"
    || value === "resolve"
    || value === "execute"
    || value === "validation"
  ) {
    return value;
  }
  return "observe.locate";
}

function normalizeOutcomeRefs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim());
}

function normalizeCriterionProofs(value: unknown): ValidationCriterionProofSelection[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): ValidationCriterionProofSelection[] => {
    if (
      !isRecord(item)
      || !Number.isSafeInteger(item["criterionIndex"])
      || !Array.isArray(item["outcomeRefs"])
    ) {
      return [];
    }
    return [{
      criterionIndex: Number(item["criterionIndex"]),
      outcomeRefs: normalizeOutcomeRefs(item["outcomeRefs"]),
    }];
  });
}

function normalizeResourceMetadata(value: unknown): ResourceMetadataProposal[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): ResourceMetadataProposal[] => {
    if (
      !isRecord(item)
      || typeof item["path"] !== "string"
      || typeof item["displayName"] !== "string"
      || typeof item["description"] !== "string"
      || !Array.isArray(item["aliases"])
    ) {
      return [];
    }
    return [{
      path: normalizeFilesystemPath(item["path"]),
      displayName: normalizeText(item["displayName"]),
      description: normalizeText(item["description"]),
      aliases: [...new Set(item["aliases"]
        .filter((alias): alias is string => typeof alias === "string")
        .map(normalizeText)
        .filter(Boolean))],
    }];
  }).slice(0, 32);
}

function normalizeReferences(value: unknown): ModeTransitionReference[] {
  if (!Array.isArray(value)) return [];
  const references = value.flatMap((item): ModeTransitionReference[] => {
    if (!isRecord(item)) return [];
    if (item["kind"] === "filesystem" && typeof item["path"] === "string") {
      const path = normalizeFilesystemPath(item["path"]);
      return path ? [{ kind: "filesystem", path }] : [];
    }
    if (item["kind"] === "resource" && typeof item["resourceId"] === "string") {
      const resourceId = item["resourceId"].trim();
      return resourceId ? [{ kind: "resource", resourceId }] : [];
    }
    if (item["kind"] === "workstream" && typeof item["workstreamId"] === "string") {
      const workstreamId = item["workstreamId"].trim();
      return workstreamId ? [{ kind: "workstream", workstreamId }] : [];
    }
    if (item["kind"] === "url" && typeof item["url"] === "string") {
      const url = normalizeHttpUrl(item["url"]);
      return url ? [{ kind: "url", url }] : [];
    }
    return [];
  });
  return uniqueObjects(references).slice(0, 12);
}

function normalizeMutationScopes(value: unknown): ModeTransitionMutationScope[] {
  if (!Array.isArray(value)) return [];
  const scopes = value.flatMap((item): ModeTransitionMutationScope[] => {
    if (!isRecord(item)) return [];
    if (item["kind"] === "filesystem" && typeof item["path"] === "string") {
      const path = normalizeFilesystemPath(item["path"]);
      return path ? [{ kind: "filesystem", path }] : [];
    }
    if (item["kind"] === "resource" && typeof item["resourceId"] === "string") {
      const resourceId = item["resourceId"].trim();
      return resourceId ? [{ kind: "resource", resourceId }] : [];
    }
    return [];
  });
  return uniqueObjects(scopes).slice(0, 8);
}

function uniqueObjects<T>(values: T[]): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = JSON.stringify(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === "string")
    .map(normalizeText)
    .filter(Boolean))];
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeFilesystemPath(value: string): string {
  const required = requireAbsoluteFilesystemPath(value);
  return required.ok ? required.absolutePath : value.trim();
}

function normalizeHttpUrl(value: string): string {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : trimmed;
  } catch {
    return trimmed;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
