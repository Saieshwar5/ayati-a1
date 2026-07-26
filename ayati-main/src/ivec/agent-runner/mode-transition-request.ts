import { normalizeWorkstreamBindingProposal } from "../workstream-binding/proposal.js";
import { requireAbsoluteFilesystemPath } from "../../shared/filesystem-paths.js";
import {
  isTaskValidationOutcomeKind,
  type FileReadValidationScope,
  type FileSearchValidationScope,
  type ModeTransitionValidationCheck,
} from "./task-validation-contracts.js";
import { normalizeTaskValidationCheck } from "./task-validation-outcome-registry.js";
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
  const validationChecks = normalizeValidationChecks(record["validationChecks"]);
  return {
    to: normalizeModeTransitionTarget(record["to"]),
    purpose: typeof record["purpose"] === "string" ? normalizeText(record["purpose"]) : "",
    capabilities: normalizeStringArray(record["capabilities"]),
    ...(Array.isArray(record["subjects"])
      ? { subjects: normalizeStringArray(record["subjects"]) }
      : {}),
    ...(references.length > 0 ? { references } : {}),
    ...(mutationScopes.length > 0 ? { mutationScopes } : {}),
    ...(validationChecks.length > 0 ? { validationChecks } : {}),
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
    || value === "resolve"
    || value === "execute"
    || value === "validation"
  ) {
    return value;
  }
  return "observe.locate";
}

function normalizeValidationChecks(value: unknown): ModeTransitionValidationCheck[] {
  if (!Array.isArray(value)) return [];
  const checks = value.flatMap((item): ModeTransitionValidationCheck[] => {
    if (
      !isRecord(item)
      || !isTaskValidationOutcomeKind(item["kind"])
      || typeof item["subject"] !== "string"
    ) {
      return [];
    }
    const expectedKind = item["expectedKind"] === "directory"
      ? "directory"
      : item["expectedKind"] === "either"
        ? "either"
        : item["expectedKind"] === "file"
          ? "file"
          : undefined;
    const readScope = normalizeReadScope(item["readScope"]);
    const searchScope = normalizeSearchScope(item["searchScope"]);
    const denialCode = typeof item["denialCode"] === "string"
      ? normalizeText(item["denialCode"])
      : undefined;
    return [normalizeTaskValidationCheck({
      kind: item["kind"],
      subject: item["subject"],
      ...(expectedKind ? { expectedKind } : {}),
      ...(searchScope ? { searchScope } : {}),
      ...(readScope ? { readScope } : {}),
      ...(denialCode ? { denialCode } : {}),
    })];
  });
  return uniqueObjects(checks).slice(0, 12);
}

function normalizeSearchScope(value: unknown): FileSearchValidationScope | undefined {
  if (
    !isRecord(value)
    || !Array.isArray(value["roots"])
    || typeof value["maxDepth"] !== "number"
    || typeof value["includeHidden"] !== "boolean"
  ) {
    return undefined;
  }
  return {
    roots: value["roots"].filter(
      (root): root is string => typeof root === "string",
    ),
    maxDepth: value["maxDepth"],
    includeHidden: value["includeHidden"],
  };
}

function normalizeReadScope(value: unknown): FileReadValidationScope | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value["mode"] === "slice"
    && typeof value["startLine"] === "number"
    && typeof value["endLine"] === "number"
  ) {
    return {
      mode: "slice",
      startLine: value["startLine"],
      endLine: value["endLine"],
    };
  }
  if (
    value["mode"] === "search"
    && typeof value["query"] === "string"
  ) {
    return {
      mode: "search",
      query: normalizeText(value["query"]),
    };
  }
  return value["mode"] === "profile"
    ? { mode: "profile" }
    : undefined;
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
