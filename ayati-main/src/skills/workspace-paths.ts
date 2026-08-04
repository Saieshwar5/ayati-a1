import { mkdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DEFAULT_WORKSPACE_DIR, resolveAyatiRootDir } from "../config/runtime-config.js";
import {
  canonicalizeAbsoluteFilesystemPath,
  requireAbsoluteFilesystemPath,
  type AbsoluteFilesystemPathResult,
} from "../shared/filesystem-paths.js";

export const workspaceRoot = DEFAULT_WORKSPACE_DIR;

export interface WorkspaceMutationPathAllowed {
  ok: true;
  path: string;
  workspaceRoot: string;
}

export interface WorkspaceMutationPathRejected {
  ok: false;
  code: "EXTERNAL_WORKSPACE_PATH_REQUIRES_ALLOW";
  operation: string;
  requestedPath: string;
  resolvedPath: string;
  workspaceRoot: string;
  message: string;
}

export type WorkspaceMutationPathResult = WorkspaceMutationPathAllowed | WorkspaceMutationPathRejected;

export type AbsolutePathResult = AbsoluteFilesystemPathResult;

export function requireAbsolutePath(pathValue: string, field = "path"): AbsolutePathResult {
  return requireAbsoluteFilesystemPath(pathValue, field);
}

/**
 * Resolve symlinks in the existing portion of an absolute path. This also
 * handles new targets by resolving their nearest existing parent first.
 */
export async function canonicalizeAbsolutePath(pathValue: string): Promise<string> {
  return await canonicalizeAbsoluteFilesystemPath(pathValue);
}

export function getWorkspaceRoot(): string {
  return join(resolveAyatiRootDir(process.env["AYATI_ROOT_DIR"]), "workspace");
}

export async function ensureWorkspaceRoot(root?: string): Promise<string> {
  const resolvedRoot = root ? resolve(root) : getWorkspaceRoot();
  await mkdir(resolvedRoot, { recursive: true });
  return resolvedRoot;
}

export function ensureWorkspaceRootSync(root?: string): string {
  const resolvedRoot = root ? resolve(root) : getWorkspaceRoot();
  mkdirSync(resolvedRoot, { recursive: true });
  return resolvedRoot;
}

export function isWithinWorkspace(pathValue: string, root: string): boolean {
  const rel = relative(root, pathValue);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function stripWorkspaceAliasPrefix(pathValue: string, root: string): string {
  const normalized = pathValue.replace(/\\/g, "/");
  const aliases = new Set(["workspace", basename(root)]);
  const parts = normalized.split("/").filter((part) => part.length > 0 && part !== ".");
  const projectAlias = basename(dirname(root));

  if (parts.length >= 2 && parts[0] === projectAlias && aliases.has(parts[1]!)) {
    parts.splice(0, 2);
  }

  while (parts.length > 0) {
    const firstPart = parts[0];
    if (!firstPart || !aliases.has(firstPart)) {
      break;
    }
    parts.shift();
  }

  return parts.join(sep);
}

export function resolveWorkspacePath(pathValue: string, rootOverride?: string): string {
  const normalized = pathValue.trim();
  const root = ensureWorkspaceRootSync(rootOverride);

  if (isAbsolute(normalized)) {
    return resolve(normalized);
  }

  const withoutWorkspaceAlias = stripWorkspaceAliasPrefix(normalized, root);
  const resolved = resolve(root, withoutWorkspaceAlias);
  if (!isWithinWorkspace(resolved, root)) {
    return root;
  }
  return resolved;
}

export function resolveWorkspaceMutationPath(
  pathValue: string,
  options: {
    allowExternalPath?: boolean;
    operation?: string;
    root?: string;
  } = {},
): WorkspaceMutationPathResult {
  const normalized = pathValue.trim();
  const root = resolve(options.root ?? getWorkspaceRoot());
  const candidatePath = isAbsolute(normalized)
    ? resolve(normalized)
    : resolve(root, stripWorkspaceAliasPrefix(normalized, root));
  const resolvedPath = !isAbsolute(normalized) && !isWithinWorkspace(candidatePath, root)
    ? root
    : candidatePath;

  if (isAbsolute(normalized) && !isWithinWorkspace(resolvedPath, root) && options.allowExternalPath !== true) {
    const operation = options.operation ?? "filesystem mutation";
    return {
      ok: false,
      code: "EXTERNAL_WORKSPACE_PATH_REQUIRES_ALLOW",
      operation,
      requestedPath: pathValue,
      resolvedPath,
      workspaceRoot: root,
      message: `Path rejected for ${operation}: ${resolvedPath} is outside the default Ayati workspace ${root}. Bind the exact resource before retrying an external mutation.`,
    };
  }

  return { ok: true, path: resolvedPath, workspaceRoot: root };
}

export function resolveWorkspaceCwd(cwd?: string, rootOverride?: string): string {
  if (!cwd || cwd.trim().length === 0) {
    return ensureWorkspaceRootSync(rootOverride);
  }
  return resolveWorkspacePath(cwd, rootOverride);
}

export function resolveWorkspaceRoots(roots?: string[], rootOverride?: string): string[] {
  if (!roots || roots.length === 0) {
    return [ensureWorkspaceRootSync(rootOverride)];
  }
  return roots.map((root) => resolveWorkspacePath(root, rootOverride));
}
