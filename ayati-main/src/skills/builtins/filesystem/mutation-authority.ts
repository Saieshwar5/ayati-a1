import { resolve } from "node:path";
import {
  canonicalizeAbsoluteFilesystemPath,
  filesystemPathIsWithin,
} from "../../../shared/filesystem-paths.js";
import type {
  FilesystemMutationAuthority,
  ToolExecutionContext,
} from "../../types.js";
import { getWorkspaceRoot } from "../../workspace-paths.js";

export async function resolveMutationAuthorities(
  context?: ToolExecutionContext,
): Promise<FilesystemMutationAuthority[]> {
  const scope = context?.resourceScope;
  const configured = scope?.mutationAuthorities?.length
    ? scope.mutationAuthorities
    : [{
        path: scope?.authorityPath ?? getWorkspaceRoot(),
        kind: scope?.authorityKind ?? ("directory" as const),
      }];
  const authorities: FilesystemMutationAuthority[] = [];
  const seen = new Set<string>();
  for (const authority of configured) {
    const path = await canonicalizeAbsoluteFilesystemPath(authority.path);
    const key = `${authority.kind}:${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    authorities.push({ path, kind: authority.kind });
  }
  return authorities;
}

export function mutationAuthoritiesOwnPath(
  authorities: FilesystemMutationAuthority[],
  path: string,
): boolean {
  return authorities.some((authority) => (
    authority.kind === "file"
      ? resolve(authority.path) === resolve(path)
      : filesystemPathIsWithin(authority.path, path)
  ));
}

export function describeMutationAuthorities(
  authorities: FilesystemMutationAuthority[],
): string {
  return authorities.map((authority) => authority.path).join(", ");
}
