import { resolve } from "node:path";
import {
  canonicalizeAbsoluteFilesystemPath,
  filesystemPathIsWithin,
  requireResourceRelativePath,
} from "../../shared/filesystem-paths.js";
import type {
  ResolvedWorkstreamWorkspaceTarget,
  WorkstreamWorkspaceTarget,
} from "./contracts.js";

export type WorkspaceTargetResolution =
  | {
      ok: true;
      targets: ResolvedWorkstreamWorkspaceTarget[];
    }
  | {
      ok: false;
      invalidTargets: string[];
      message: string;
    };

export function normalizeWorkstreamWorkspaceTargets(
  value: unknown,
): WorkstreamWorkspaceTarget[] {
  if (!Array.isArray(value)) return [];
  const targets: WorkstreamWorkspaceTarget[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) continue;
    const kind = item["kind"];
    const relativePath = item["relativePath"];
    if (
      (kind !== "file" && kind !== "directory")
      || typeof relativePath !== "string"
    ) {
      continue;
    }
    const required = requireResourceRelativePath(relativePath, {
      field: "workspaceTargets[].relativePath",
    });
    if (!required.ok) continue;
    const key = `${kind}:${required.relativePath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ kind, relativePath: required.relativePath });
  }
  return targets.slice(0, 8);
}

export async function resolveWorkstreamWorkspaceTargets(
  targets: WorkstreamWorkspaceTarget[],
  workspaceRoot: string,
): Promise<WorkspaceTargetResolution> {
  const canonicalRoot = await canonicalizeAbsoluteFilesystemPath(workspaceRoot);
  const resolvedTargets: ResolvedWorkstreamWorkspaceTarget[] = [];
  const invalidTargets: string[] = [];
  const kindsByPath = new Map<string, WorkstreamWorkspaceTarget["kind"]>();

  for (const target of targets) {
    const required = requireResourceRelativePath(target.relativePath, {
      field: "workspaceTargets[].relativePath",
    });
    if (!required.ok) {
      invalidTargets.push(target.relativePath);
      continue;
    }
    const existingKind = kindsByPath.get(required.relativePath);
    if (existingKind && existingKind !== target.kind) {
      invalidTargets.push(target.relativePath);
      continue;
    }
    kindsByPath.set(required.relativePath, target.kind);
    const absolutePath = await canonicalizeAbsoluteFilesystemPath(
      resolve(canonicalRoot, required.relativePath),
    );
    if (!filesystemPathIsWithin(canonicalRoot, absolutePath)) {
      invalidTargets.push(target.relativePath);
      continue;
    }
    resolvedTargets.push({
      kind: target.kind,
      relativePath: required.relativePath,
      absolutePath,
    });
  }

  if (invalidTargets.length > 0 || resolvedTargets.length !== targets.length) {
    return {
      ok: false,
      invalidTargets,
      message:
        "Workspace targets must be portable paths inside the configured workspace and may not escape through '..' or symbolic links.",
    };
  }
  return { ok: true, targets: resolvedTargets };
}

export function workstreamWorkspaceTargetArraySchema(): Record<string, unknown> {
  return {
    type: "array",
    minItems: 1,
    maxItems: 8,
    uniqueItems: true,
    description:
      "Exact planned workspace outputs. Declare whether each target is a file or directory; paths are relative to context.run.workspaceRoot.",
    items: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["file", "directory"],
          description: "The resource kind the operation intends to create or change.",
        },
        relativePath: {
          type: "string",
          minLength: 1,
          maxLength: 2000,
          pattern:
            "^(?!/)(?![A-Za-z]:[\\\\/])(?!.*(?:^|/)\\.{1,2}(?:/|$))(?!.*//)(?!.*\\\\).+$",
          description:
            "Portable path relative to context.run.workspaceRoot. Do not provide the workspace root, an absolute path, '.', or '..' segments.",
        },
      },
      required: ["kind", "relativePath"],
      additionalProperties: false,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
