import type { MutationProvenance } from "../contracts.js";
import { GitContextServiceError } from "../errors.js";

export function verifiedMutationPaths(provenance: MutationProvenance): string[] {
  return [...new Set([
    ...provenance.created,
    ...provenance.modified,
    ...provenance.deleted,
    ...provenance.renamed.flatMap((entry) => [entry.from, entry.to]),
  ])].sort();
}

export function assertCommittableMutationPaths(paths: string[]): void {
  const prohibited = paths.filter(isProhibitedPath);
  if (prohibited.length === 0) return;
  throw new GitContextServiceError({
    code: "INVALID_REQUEST",
    message: "Verified mutation includes files that must not be committed.",
    details: { prohibitedPaths: prohibited },
  });
}

function isProhibitedPath(path: string): boolean {
  const segments = path.toLowerCase().split("/");
  const name = segments.at(-1) ?? "";
  return segments.some((segment) => ["node_modules", "dist", "build", ".cache"].includes(segment))
    || name === ".env"
    || name.startsWith(".env.")
    || /(^|[-_.])(credential|credentials|secret|secrets)([-_.]|$)/.test(name)
    || name.endsWith(".log");
}
