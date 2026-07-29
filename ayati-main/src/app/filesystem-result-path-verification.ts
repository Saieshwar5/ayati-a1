import { basename, dirname, isAbsolute, resolve } from "node:path";
import { filesystemPathIsWithin } from "../shared/filesystem-paths.js";
import {
  observeFilesystemTarget,
} from "../shared/filesystem-target-state.js";

export async function reportedDirectoryProblems(input: {
  structured: Record<string, unknown> | undefined;
  field: string;
  target: string;
  allowTarget: boolean;
  label: string;
}): Promise<string[]> {
  const value = input.structured?.[input.field];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    return [`${input.label} reported ${input.field} in an invalid format.`];
  }
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || !isAbsolute(entry)) {
      problems.push(`${input.label} reported a non-absolute created directory.`);
      continue;
    }
    const path = resolve(entry);
    if (seen.has(path)) {
      problems.push(`${input.label} reported a duplicate created directory: ${path}.`);
      continue;
    }
    seen.add(path);
    const validRelation = input.allowTarget && path === input.target
      ? true
      : path !== input.target && filesystemPathIsWithin(path, input.target);
    if (!validRelation) {
      problems.push(`${input.label} reported a created directory that is not an ancestor of its target: ${path}.`);
      continue;
    }
    if ((await observeFilesystemTarget(path)).kind !== "directory") {
      problems.push(`${input.label} reported a created directory that is not present: ${path}.`);
    }
  }
  return problems;
}

export async function deleteCleanupPathProblems(
  structured: Record<string, unknown> | undefined,
  target: string,
): Promise<string[]> {
  const value = structured?.["cleanupPath"];
  if (typeof value !== "string" || !isAbsolute(value)) {
    return ["delete reported cleanup_pending without an absolute cleanupPath."];
  }
  const cleanupPath = resolve(value);
  if (
    dirname(cleanupPath) !== dirname(target)
    || !basename(cleanupPath).startsWith(".ayati-delete-")
  ) {
    return [`delete reported an invalid internal cleanup path: ${cleanupPath}.`];
  }
  return (await observeFilesystemTarget(cleanupPath)).kind === "directory"
    ? []
    : [`delete reported cleanup_pending, but its cleanup path is not present: ${cleanupPath}.`];
}
