import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(thisDir, "..", "..");

export const workspaceRoot = resolve(projectRoot, "work_space");

function normalizeSpecialPath(pathValue: string): string {
  const trimmed = pathValue.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  return trimmed;
}

export function resolveWorkspacePath(pathValue: string): string {
  const normalized = normalizeSpecialPath(pathValue);
  if (isAbsolute(normalized)) {
    return resolve(normalized);
  }
  return resolve(workspaceRoot, normalized);
}

export function resolveWorkspaceCwd(cwd?: string): string {
  if (!cwd || cwd.trim().length === 0) {
    return workspaceRoot;
  }
  return resolveWorkspacePath(cwd);
}

export function resolveWorkspaceRoots(roots?: string[]): string[] {
  if (!roots || roots.length === 0) {
    return [workspaceRoot];
  }
  return roots.map((root) => resolveWorkspacePath(root));
}
