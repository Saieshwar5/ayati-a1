import {
  basename,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import type { RunToolCallContext } from "../types.js";

const MAX_PROMPT_CANDIDATES = 8;

export interface FileSearchCandidateSet {
  query?: string;
  matchCount: number;
  candidates: Array<{
    name: string;
    label: string;
    path: string;
    kind?: string;
  }>;
  omittedCandidateCount?: number;
}

export function buildFileSearchCandidateSet(
  call: RunToolCallContext,
): FileSearchCandidateSet | undefined {
  if (
    call.tool !== "find_files"
    || call.status !== "success"
    || (
      call.verification?.status !== "passed"
      && call.verificationPassed !== true
    )
    || !isRecord(call.projectionMetadata)
  ) {
    return undefined;
  }

  const metadata = call.projectionMetadata;
  const roots = readStrings(metadata.roots);
  const matches = Array.isArray(metadata.matches) ? metadata.matches : [];
  const candidates = matches
    .map((match) => candidate(match, roots))
    .filter((item): item is FileSearchCandidateSet["candidates"][number] => item !== undefined)
    .slice(0, MAX_PROMPT_CANDIDATES);
  const matchCount = readCount(metadata.matchCount) ?? candidates.length;
  if (matchCount === 0 || candidates.length === 0) return undefined;

  const omittedCandidateCount = Math.max(0, matchCount - candidates.length);
  const query = readString(metadata.query);
  return {
    ...(query ? { query } : {}),
    matchCount,
    candidates,
    ...(omittedCandidateCount > 0 ? { omittedCandidateCount } : {}),
  };
}

function candidate(
  value: unknown,
  roots: string[],
): FileSearchCandidateSet["candidates"][number] | undefined {
  if (!isRecord(value)) return undefined;
  const path = readString(value.absolutePath) ?? readString(value.path);
  if (!path) return undefined;
  const kind = readString(value.kind);
  const name = readString(value.name) ?? (basename(path) || path);
  return {
    name,
    label: relativeLabel(path, roots),
    path,
    ...(kind ? { kind } : {}),
  };
}

function relativeLabel(path: string, roots: string[]): string {
  if (isAbsolute(path)) {
    for (const root of roots.filter(isAbsolute)) {
      const child = relative(resolve(root), resolve(path));
      if (
        child.length > 0
        && child !== ".."
        && !child.startsWith(`..${sep}`)
        && !isAbsolute(child)
      ) {
        return child.split(sep).join("/");
      }
    }
  }
  return basename(path) || path;
}

function readStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => (
      typeof item === "string" && item.trim().length > 0
    ))
    : [];
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function readCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
