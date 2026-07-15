import { mkdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DEFAULT_WORKSPACE_DIR, resolveWorkspaceDir } from "../config/runtime-config.js";

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

function normalizeSpecialPath(pathValue: string): string {
  const trimmed = pathValue.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  return trimmed;
}

export function getWorkspaceRoot(): string {
  return resolveWorkspaceDir(process.env["AYATI_WORKSPACE_DIR"]);
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
  const aliases = new Set(["workspace", "work_space", basename(root)]);
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
  const normalized = normalizeSpecialPath(pathValue);
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
  const normalized = normalizeSpecialPath(pathValue);
  const root = ensureWorkspaceRootSync(options.root);
  const resolvedPath = isAbsolute(normalized)
    ? resolve(normalized)
    : resolveWorkspacePath(normalized, root);

  if (isAbsolute(normalized) && !isWithinWorkspace(resolvedPath, root) && options.allowExternalPath !== true) {
    const operation = options.operation ?? "filesystem mutation";
    return {
      ok: false,
      code: "EXTERNAL_WORKSPACE_PATH_REQUIRES_ALLOW",
      operation,
      requestedPath: pathValue,
      resolvedPath,
      workspaceRoot: root,
      message: `External workspace path rejected for ${operation}: ${resolvedPath} is outside ${root}. Use a workspace-relative path for generated files, or set allowExternalPath=true only when the user explicitly requested this external path.`,
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
