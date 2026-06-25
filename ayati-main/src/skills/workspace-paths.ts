import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DEFAULT_WORKSPACE_DIR, resolveWorkspaceDir } from "../config/runtime-config.js";

export const workspaceRoot = DEFAULT_WORKSPACE_DIR;

function normalizeSpecialPath(pathValue: string): string {
  const trimmed = pathValue.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  return trimmed;
}

function getWorkspaceRoot(): string {
  return resolveWorkspaceDir(process.env["AYATI_WORKSPACE_DIR"]);
}

function isWithinWorkspace(pathValue: string, root: string): boolean {
  const rel = relative(root, pathValue);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function stripWorkspaceAliasPrefix(pathValue: string, root: string): string {
  const normalized = pathValue.replace(/\\/g, "/");
  const aliases = new Set(["workspace", "work_space", basename(root)]);
  const parts = normalized.split("/").filter((part) => part.length > 0 && part !== ".");

  while (parts.length > 0) {
    const firstPart = parts[0];
    if (!firstPart || !aliases.has(firstPart)) {
      break;
    }
    parts.shift();
  }

  return parts.join(sep);
}

export function resolveWorkspacePath(pathValue: string): string {
  const normalized = normalizeSpecialPath(pathValue);
  const root = getWorkspaceRoot();

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

export function resolveWorkspaceCwd(cwd?: string): string {
  if (!cwd || cwd.trim().length === 0) {
    return getWorkspaceRoot();
  }
  return resolveWorkspacePath(cwd);
}

export function resolveWorkspaceRoots(roots?: string[]): string[] {
  if (!roots || roots.length === 0) {
    return [getWorkspaceRoot()];
  }
  return roots.map((root) => resolveWorkspacePath(root));
}
